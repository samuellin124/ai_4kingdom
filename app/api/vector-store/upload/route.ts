import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { createDynamoDBClient } from '@/app/utils/dynamodb';
import { PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { findUnitByAssistantId, getSundayGuideUnitConfig, VECTOR_STORE_IDS } from '@/app/config/constants';
import { getUnitAllowedUploaders } from '@/app/utils/getUnitAllowedUploaders';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// 添加文件狀態檢查函數
async function waitForFileProcessing(vectorStoreId: string, maxAttempts = 10) {
  try {
    for (let i = 0; i < maxAttempts; i++) {
      const files = await openai.vectorStores.files.list(vectorStoreId);
      console.log(`[DEBUG] 檢查文件狀態 (嘗試 ${i + 1}/${maxAttempts}):`, 
        files.data.map(f => ({ id: f.id, status: f.status }))
      );

      // 檢查所有文件是否都處理完成
      const allProcessed = files.data.every(f => f.status === 'completed');
      if (allProcessed) {
        console.log('[DEBUG] 所有文件處理完成');
        return true;
      }

      // 等待5秒後重試
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    // 如果達到最大嘗試次數，只記錄警告而不是拋出錯誤
    console.warn('[WARN] 文件處理超時，但仍然視為上傳成功');
    return true;
  } catch (error) {
    // 捕獲任何可能的錯誤，但不中斷流程
    console.error('[ERROR] 檢查文件狀態時出錯:', error);
    return true; // 仍然返回 true，讓上傳流程繼續
  }
}

// 檢查文件名稱是否已存在
async function checkFileNameExists(fileName: string, assistantId: string) {
  try {
    console.log(`[DEBUG] 檢查文件名稱 "${fileName}" 是否已存在`);
    const docClient = await createDynamoDBClient();
    const tableName = process.env.NEXT_PUBLIC_SUNDAY_GUIDE_TABLE || 'SundayGuide';
    
    const params = {
      TableName: tableName,
      FilterExpression: "fileName = :fileName AND assistantId = :assistantId",
      ExpressionAttributeValues: {
        ":fileName": fileName,
        ":assistantId": assistantId
      }
    };
    
    const result = await docClient.send(new ScanCommand(params));
    const exists = result.Items && result.Items.length > 0;
    
    console.log(`[DEBUG] 文件名稱 "${fileName}" ${exists ? '已存在' : '不存在'}`);
    return exists;
  } catch (error) {
    console.error('[ERROR] 檢查文件名稱失敗:', error);
    // 如果查詢出錯，為了安全起見，假設文件不存在
    return false;
  }
}

export async function POST(request: Request) {
  try {
    const url = new URL(request.url);
  const vectorStoreId = url.searchParams.get('vectorStoreId');
  const assistantId = url.searchParams.get('assistantId');
  const unitIdParam = url.searchParams.get('unitId');

    console.log('[DEBUG] 收到上傳請求:', {
      vectorStoreId,
      assistantId,
      url: request.url,
      method: request.method
    });

    if (!vectorStoreId || !assistantId) {
      console.error('[ERROR] 缺少必要參數:', { vectorStoreId, assistantId });
      return NextResponse.json(
        { error: '缺少必要參數', details: { vectorStoreId, assistantId } },
        { status: 400 }
      );
    }

    const formData = await request.formData();
    const file = formData.get('file') as File;
    const userId = formData.get('userId') as string | null;

    // 單位辨識：優先使用顯式傳入，其次 assistantId 反查
    let unitId: any;
    let unitIdOverride = false;
    if (unitIdParam) {
      unitId = unitIdParam as any;
      unitIdOverride = true;
    } else {
      unitId = findUnitByAssistantId(assistantId);
    }
    const unitCfg = getSundayGuideUnitConfig(unitId);
    const isAgape = unitId === 'agape';

    // 權限：若是非 default 單位，需檢查 allowedUploaders
    if (unitId !== 'default') {
      const uploaders = await getUnitAllowedUploaders(unitId);
      if (!userId || !uploaders.includes(String(userId))) {
        return NextResponse.json({ error: '無權在此單位上傳' }, { status: 403 });
      }
    }
    
    if (!file) {
      console.error('[ERROR] 沒有找到文件');
      return NextResponse.json(
        { error: '沒有找到文件' },
        { status: 400 }
      );
    }

    console.log('[DEBUG] 開始處理文件:', {
      名稱: file.name,
      類型: file.type,
      大小: file.size,
    });

    try {
      const fileExt = file.name.match(/\.[^.]+$/)?.[0]?.toLowerCase() ?? '';

      // .doc → 以 .docx MIME 型別送給 OpenAI
      // 現代 Word 存成 .doc 實際上是 OOXML，改 Content-Type 讓 OpenAI 正確索引
      // DynamoDB 仍保存原始檔名（.doc），前端 polling 不受影響
      let fileToUpload: File = file;
      if (fileExt === '.doc') {
        const docxName = file.name.replace(/\.doc$/i, '.docx');
        fileToUpload = new File(
          [await file.arrayBuffer()],
          docxName,
          { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
        );
        console.log(`[DEBUG] .doc 轉為 .docx 上傳至 OpenAI: ${docxName}`);
      }

      // 檢查文件名稱是否已存在
      const fileNameExists = await checkFileNameExists(file.name, assistantId);
      if (fileNameExists) {
        console.log(`[DEBUG] 文件 "${file.name}" 已存在，不進行上傳`);
        return NextResponse.json(
          { 
            error: '文件已存在',
            details: `檔案 "${file.name}" 已存在，請使用不同的檔案名稱或刪除現有檔案後再試。`,
            fileName: file.name,
            fileExists: true
          },
          { status: 409 } // 使用 409 Conflict 狀態碼
        );
      }

      // 1. 上傳文件到 OpenAI
      console.log(`[DEBUG] 上傳文件到 OpenAI: ${fileToUpload.name}`);
      const uploadedFile = await openai.files.create({
        file: fileToUpload,
        purpose: 'assistants'
      });
      console.log(`[DEBUG] 文件上傳成功: ${uploadedFile.id}`);      // 2. 添加到 Vector Store
      console.log(`[DEBUG] 添加文件到 Vector Store: ${vectorStoreId}`);
      await openai.vectorStores.files.create(
        vectorStoreId,
        {
          file_id: uploadedFile.id,
          // sgFileId = 該檔案自身 id（= DynamoDB 記錄的 fileId），供 Chat 依「選定講章」過濾檢索
          attributes: { sgFileId: uploadedFile.id, docType: 'source' },
        }
      );
      console.log(`[DEBUG] 文件成功添加到 Vector Store`);

      // Agape 單位：為了聊天檢索隔離，還需同步到專用向量庫（若不同）
      if (isAgape && vectorStoreId !== VECTOR_STORE_IDS.AGAPE_CHURCH) {
        try {
          console.log('[DEBUG] 同步文件到 Agape 專用向量庫 (聊天隔離)', {
            agapeVectorStore: VECTOR_STORE_IDS.AGAPE_CHURCH,
            fileId: uploadedFile.id
          });
          await openai.vectorStores.files.create(
            VECTOR_STORE_IDS.AGAPE_CHURCH,
            { file_id: uploadedFile.id, attributes: { sgFileId: uploadedFile.id, docType: 'source' } }
          );
          console.log('[DEBUG] 已同步到 Agape 專用向量庫');
        } catch (syncErr) {
          console.warn('[WARN] 同步到 Agape 專用向量庫失敗（不阻斷流程）', syncErr);
        }
      }
      // 3. 寫入 DynamoDB，包含詳細資訊
      try {
        const docClient = await createDynamoDBClient();
        const tableName = process.env.NEXT_PUBLIC_SUNDAY_GUIDE_TABLE || 'SundayGuide';
    await docClient.send(new PutCommand({
          TableName: tableName,
          Item: {
            assistantId,
            vectorStoreId,
            fileId: uploadedFile.id,
            fileName: file.name,
            fileSize: file.size,
            fileType: file.type,
            userId: userId || 'unknown',
            uploadTimestamp: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            Timestamp: new Date().toISOString(), // 添加必要的 Timestamp 主鍵
      completed: false, // 初始不標記完成，等待內容生成
      generationStatus: 'pending', // 新增：pending | processing | completed | failed
      attemptCount: 0,
            isSystemResource: unitId === 'default', // default 維持公共
            accessType: unitCfg.accessType || (unitId === 'default' ? 'public' : 'restricted'),
            unitId,
            unitIdOverride,
            uploadedBy: userId || 'unknown'
          }
        }));
        console.log('[DEBUG] 已寫入 DynamoDB，標記為系統資源');
      } catch (ddbErr) {
        console.error('[ERROR] 寫入 DynamoDB 失敗:', ddbErr);
        // 即使 DynamoDB 寫入失敗，仍然繼續流程，只記錄錯誤
      }

      // 等待文件索引由 process-document 端的 waitForFileReady() 負責，
      // upload 端不再輪詢，避免超過 CloudFront origin timeout (504)
      console.log(`[DEBUG] 文件已上傳，文件ID: ${uploadedFile.id}`);

      // 注意：OpenAI Vector Store API 不支持添加自定義元數據，改為使用 DynamoDB 保存檔案資訊
      console.log(`[DEBUG] 文件可被所有用戶訪問 (系統資源)`);

      return NextResponse.json({ 
        success: true,
        fileId: uploadedFile.id,
        message: '文件上传成功'
      });

    } catch (err) {
      console.error('[ERROR] 文件處理失敗:', {
        文件名: file.name,
        錯誤: err instanceof Error ? {
          message: err.message,
          stack: err.stack
        } : err
      });
      return NextResponse.json(
        { 
          error: '文件上傳失敗',
          details: err instanceof Error ? err.message : '未知錯誤'
        },
        { status: 500 }
      );
    }

  } catch (error) {
    console.error('[ERROR] 請求處理失敗:', {
      錯誤: error instanceof Error ? {
        message: error.message,
        stack: error.stack
      } : error
    });
    return NextResponse.json(
      { 
        error: '請求處理失敗', 
        details: error instanceof Error ? error.message : '未知錯誤'
      },
      { status: 500 }
    );
  }
}