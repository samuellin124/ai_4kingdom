import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { createDynamoDBClient } from '../../../utils/dynamodb';
import { PutCommand, ScanCommand, DeleteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ASSISTANT_IDS, findUnitByAssistantId, getSundayGuideUnitConfig } from '@/app/config/constants';
import { getUnitAllowedUploaders } from '@/app/utils/getUnitAllowedUploaders';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// 獲取文件記錄列表的API端點
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
  const assistantId = searchParams.get('assistantId');
  const unitIdParam = searchParams.get('unitId') || undefined;
    let userId = searchParams.get('userId');
    const allUsers = searchParams.get('allUsers') === 'true'; // 新增：是否獲取所有用戶的文檔
    const pageParam = searchParams.get('page');
    const limitParam = searchParams.get('limit');
    const page = pageParam ? parseInt(pageParam) : null;
    const limit = limitParam ? parseInt(limitParam) : null;
    
    console.log('[DEBUG] 請求參數:', {
      assistantId,
      userId,
      allUsers,
      page,
      limit,
      url: request.url
    });
    
    // 獲取數據庫連接
    const docClient = await createDynamoDBClient();
    
    // 構建查詢參數
    const params: any = {
      TableName: process.env.NEXT_PUBLIC_SUNDAY_GUIDE_TABLE || 'SundayGuide',
    };
    
    // 構建過濾表達式和表達式屬性值
    let filterExpressions = [];
    const expressionAttributeValues: Record<string, any> = {};
    
    // 無 unitId 時排除各獨立單位的專屬 assistant，避免混入一般主日學列表
    if (!unitIdParam) {
      if (assistantId) {
        filterExpressions.push("assistantId = :assistantId");
        expressionAttributeValues[":assistantId"] = assistantId;
      } else {
        filterExpressions.push("assistantId <> :agapeAid AND assistantId <> :eastAid");
        expressionAttributeValues[":agapeAid"] = ASSISTANT_IDS.AGAPE_CHURCH;
        expressionAttributeValues[":eastAid"] = ASSISTANT_IDS.EAST_CHRIST_HOME;
      }
    }
    
    // 如果不是獲取所有用戶的文檔且提供了userId，加入用戶過濾條件
    if (!allUsers && userId) {
      // 檢查 userId 是否可以轉換為數字
      const numericUserId = !isNaN(Number(userId)) ? Number(userId) : null;
      
      if (numericUserId !== null) {
        // 如果可以轉換為數字，同時檢查字符串和數字類型
        filterExpressions.push("(userId = :userIdStr OR userId = :userIdNum OR UserId = :userIdStr OR UserId = :userIdNum)");
        expressionAttributeValues[":userIdStr"] = userId;
        expressionAttributeValues[":userIdNum"] = numericUserId;
      } else {
        // 如果不是數字，只檢查字符串
        filterExpressions.push("(userId = :userId OR UserId = :userId)");
        expressionAttributeValues[":userId"] = userId;
      }
    }
    
    // 如果有過濾條件，設置過濾表達式
    if (filterExpressions.length > 0) {
      params.FilterExpression = filterExpressions.join(" AND ");
      params.ExpressionAttributeValues = expressionAttributeValues;
    }
    
    console.log('[DEBUG] DynamoDB 查詢參數:', {
      FilterExpression: params.FilterExpression,
      ExpressionAttributeValues: params.ExpressionAttributeValues
    });
    
    // 查詢文件記錄（分頁掃描，避免只拿到 DynamoDB 首頁 1MB 資料）
    let recordsRaw: any[] = [];
    let lastEvaluatedKey: any = undefined;
    let scanPages = 0;
    const MAX_SCAN_PAGES = 50;

    do {
      const scanParams = {
        ...params,
        ExclusiveStartKey: lastEvaluatedKey
      };
      const result = await docClient.send(new ScanCommand(scanParams));
      recordsRaw = recordsRaw.concat(result.Items || []);
      lastEvaluatedKey = result.LastEvaluatedKey;
      scanPages += 1;
    } while (lastEvaluatedKey && scanPages < MAX_SCAN_PAGES);

    console.log('[DEBUG] 查詢結果:', {
      pageCount: scanPages,
      itemCount: recordsRaw.length,
      firstItem: recordsRaw.length > 0 ? JSON.stringify(recordsRaw[0]).substring(0, 200) : '無記錄',
      truncated: !!lastEvaluatedKey
    });

    if (unitIdParam) {
      recordsRaw = recordsRaw.filter(item => {
        const itemUnit = item.unitId || findUnitByAssistantId(item.assistantId);
        return String(itemUnit) === unitIdParam;
      });
    }

    let records = recordsRaw.map(item => ({
      assistantId: item.assistantId,
      vectorStoreId: item.vectorStoreId,
      fileId: item.fileId,
      fileName: item.fileName || '未命名文件',
      sermonTitle: item.sermonTitle || null,
      createdAt: item.Timestamp,
      updatedAt: item.updatedAt || item.Timestamp,
      userId: item.userId || item.UserId || '-',
      unitId: item.unitId || findUnitByAssistantId(item.assistantId),
      summary: item.summary ? '已生成' : '未生成',
      fullText: item.fullText ? '已生成' : '未生成',
      devotional: item.devotional ? '已生成' : '未生成',
      bibleStudy: item.bibleStudy ? '已生成' : '未生成'
    })) || [];

    // 按上傳時間排序（最新的在前面）
    records = records.sort((a, b) => {
      const dateA = new Date(a.createdAt).getTime();
      const dateB = new Date(b.createdAt).getTime();
      return dateB - dateA;
    });

    // 去重：同一個 fileId 可能因重試產生多筆 DynamoDB 記錄，排序後只保留最新一筆
    const seenFileIds = new Set<string>();
    records = records.filter(r => {
      if (!r.fileId) return true; // 無 fileId 的紀錄保留
      if (seenFileIds.has(r.fileId)) return false;
      seenFileIds.add(r.fileId);
      return true;
    });

    // 如果是分頁請求，進行分頁處理
    const totalCount = records.length;
    let paginatedRecords = records;
    
    if (allUsers && page && limit) {
      const startIndex = (page - 1) * limit;
      const endIndex = startIndex + limit;
      paginatedRecords = records.slice(startIndex, endIndex);
    }
    
    // 返回結果
    return NextResponse.json({
      success: true,
      records: paginatedRecords,
      totalCount: totalCount,
      currentPage: page,
      totalPages: limit ? Math.ceil(totalCount / limit) : 1
    });
    
  } catch (error) {
    console.error('獲取文件記錄錯誤:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : '未知錯誤'
    }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    console.log('接收到文档上传请求');
    console.log('原始请求信息:', {
      方法: request.method,
      内容类型: request.headers.get('content-type'),
      请求体大小: request.headers.get('content-length'),
    });

    // 尝试获取原始请求体
    const clone = request.clone();
    const rawText = await clone.text();
    console.log('原始请求体预览:', rawText.substring(0, 500) + '...');

    const formData = await request.formData();
    
    // 详细检查 FormData 内容
    console.log('FormData 原始内容:');
    for (const [key, value] of formData.entries()) {
      console.log(`字段 ${key}:`, {
        类型: typeof value,
        是否为文件: value instanceof File,
        值: value instanceof File ? 
          `文件名: ${value.name}, 类型: ${value.type}, 大小: ${value.size}字节` : 
          value
      });
    }
    
    const file = formData.get('files') as File;
    const assistantId = formData.get('assistantId') as string;
    const userId = formData.get('userId') as string; // 獲取 userId
    const unitId = (formData.get('unitId') as string) || undefined; // 上傳時帶入的單位

    // 標準化用戶 ID 的處理
    let parsedUserId = userId;
    if (userId && !isNaN(Number(userId))) {
      parsedUserId = userId;
    } else if (!userId) {
      parsedUserId = 'unknown';
    }

    console.log('请求参数详情:', {
      文件信息: file ? {
        名称: file.name,
        类型: file.type,
        大小: file.size,
        最后修改时间: file.lastModified
      } : '无文件',
      助手ID: assistantId || '未提供',
      用户ID: userId || '未提供',
      表单字段列表: Array.from(formData.keys())
    });

    if (!file || !assistantId) {
      console.error('缺少必要参数:', {
        接收到的数据: {
          文件: file ? '存在' : '不存在',
          助手ID: assistantId || '不存在',
          所有字段: Array.from(formData.keys()),
          请求头: request.headers
        }
      });
      
      return NextResponse.json({
        success: false,
        error: '缺少必要参数',
        详细信息: {
          是否有文件: !!file,
          是否有助手ID: !!assistantId,
          表单字段: Array.from(formData.keys())
        }
      }, { status: 400 });
    }

    // 轉換文件格式
    console.log('[DEBUG] 開始轉換文件格式');
    const buffer = await file.arrayBuffer();
    const blob = new Blob([buffer]);
    console.log('[DEBUG] 文件格式轉換成功，大小:', buffer.byteLength, '字節');
    
    // 記錄操作開始時間，用於計算每步執行時間
    const startTime = Date.now();
    let stepStartTime = startTime;
    let currentStep = '';
    
    try {
      // 1. 创建 vector store
      currentStep = '創建向量存儲';
      stepStartTime = Date.now();
      console.log(`[DEBUG] 步驟 1: 開始${currentStep}`);
      
      const vectorStore = await openai.beta.vectorStores.create({
        name: `Vector Store ${new Date().toISOString()}`
      });
      
      console.log(`[DEBUG] 步驟 1: ${currentStep}成功，ID: ${vectorStore.id}，耗時: ${Date.now() - stepStartTime}ms`);
      
      // 2. 创建文件
      currentStep = '上傳文件到 OpenAI';
      stepStartTime = Date.now();
      console.log(`[DEBUG] 步驟 2: 開始${currentStep}，文件名: ${file.name}，大小: ${file.size} 字節`);
      
      const openaiFile = await openai.files.create({
        file: new File([blob], file.name, { type: file.type }),
        purpose: "assistants"
      });
      
      console.log(`[DEBUG] 步驟 2: ${currentStep}成功，文件ID: ${openaiFile.id}，耗時: ${Date.now() - stepStartTime}ms`);

      // 3. 添加文件到 vector store
      currentStep = '將文件添加到向量存儲';
      stepStartTime = Date.now();
      console.log(`[DEBUG] 步驟 3: 開始${currentStep}`);
      
      await openai.beta.vectorStores.files.create(
        vectorStore.id,
        { file_id: openaiFile.id }
      );
      
      console.log(`[DEBUG] 步驟 3: ${currentStep}成功，耗時: ${Date.now() - stepStartTime}ms`);

      // 步驟 4: 呼叫 process-document 產生 summary/devotional/bibleStudy
      currentStep = '產生 summary/devotional/bibleStudy';
      stepStartTime = Date.now();
      console.log(`[DEBUG] 步驟 4: 開始${currentStep}`);
      // 呼叫內部 API 處理內容（用 request.url 取得 origin，避免 serverless 相對路徑失效）
      // 步驟 4: fire-and-forget 呼叫 process-document，不 await，避免 CloudFront 30s 超時
      const apiOrigin = new URL(request.url).origin;
      fetch(`${apiOrigin}/api/sunday-guide/process-document`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assistantId,
          vectorStoreId: vectorStore.id,
          fileName: file.name,
          userId: parsedUserId,
          fileId: openaiFile.id,
          unitId: unitId || undefined
        })
      }).catch(e => console.log(`[documents] process-document kick failed: ${e.message}`));
      console.log(`[DEBUG] 步驟 4: process-document 已觸發（fire-and-forget）`);
      // 立即回傳，Lambda 繼續在背景執行 process-document
      return NextResponse.json({
        success: true,
        vectorStoreId: vectorStore.id,
        fileId: openaiFile.id,
        fileName: file.name,
        userId: parsedUserId,
        summary: null,
        devotional: null,
        bibleStudy: null,
        processingStarted: true
      });
    } catch (processError) {
      // 詳細記錄處理過程中的錯誤
      const errorTime = Date.now();
      const errorDetails = {
        step: currentStep,
        errorMessage: processError instanceof Error ? processError.message : String(processError),
        errorName: processError instanceof Error ? processError.name : typeof processError,
        errorCode: (processError as any)?.status || (processError as any)?.code || 'unknown',
        stackTrace: processError instanceof Error ? processError.stack : undefined,
        elapsedTime: errorTime - startTime,
        stepElapsedTime: errorTime - stepStartTime,
        timeStamp: new Date().toISOString(),
        requestHeaders: Object.fromEntries([...request.headers.entries()].map(([key, value]) => [key, value])),
        environment: {
          nodeEnv: process.env.NODE_ENV,
          region: process.env.NEXT_PUBLIC_REGION,
          apiBaseUrl: new URL(request.url).origin,
        }
      };
      
      console.error(`[ERROR] 在步驟 "${currentStep}" 過程中出錯:`, errorDetails);
      
      // 重新拋出帶更多上下文的錯誤
      const enhancedError = new Error(`處理失敗於步驟 "${currentStep}": ${(processError as Error).message || '未知錯誤'}`);
      (enhancedError as any).originalError = processError;
      (enhancedError as any).errorDetails = errorDetails;
      throw enhancedError;
    }
  } catch (error) {
    // 最終捕獲所有錯誤並返回詳細信息
    const errorResponse = {
      success: false,
      error: error instanceof Error ? error.message : '未知錯誤',
      errorType: error instanceof Error ? error.name : typeof error,
      errorCode: (error as any)?.status || (error as any)?.code || 'unknown',
      details: error instanceof Error ? error.stack : undefined,
      context: (error as any)?.errorDetails || {},
      timestamp: new Date().toISOString()
    };
    
    console.error('[FATAL] 文件上傳處理失敗:', errorResponse);
    
    return NextResponse.json(errorResponse, { status: 500 });
  }
}

// 單筆刪除：僅允許該筆上傳者且 unitId=agape (公開瀏覽) 刪除
export async function DELETE(request: Request) {
  try {
    const url = new URL(request.url);
    const fileId = url.searchParams.get('fileId');
    const unitId = url.searchParams.get('unitId');
    const userId = url.searchParams.get('userId');

    if (!fileId || !unitId || !userId) {
      return NextResponse.json({ success: false, error: '缺少必要參數 fileId / unitId / userId' }, { status: 400 });
    }
    if (!['agape', 'eastChristHome', 'jianZhu', 'default'].includes(unitId)) {
      return NextResponse.json({ success: false, error: '不支援的單位' }, { status: 400 });
    }    const docClient = await createDynamoDBClient();
    const tableName = process.env.NEXT_PUBLIC_SUNDAY_GUIDE_TABLE || 'SundayGuide';

    // 以 fileId 分頁掃描定位紀錄（避免 DynamoDB 1MB 單次 Scan 限制導致找不到）
    // 注意：必須掃描完整張表，因為同一 fileId 可能有多筆紀錄（重傳/重試產生）
    let items: any[] = [];
    let lastKey: any = undefined;
    let scanPages = 0;
    const MAX_DELETE_SCAN_PAGES = 50;
    do {
      const scanRes = await docClient.send(new ScanCommand({
        TableName: tableName,
        FilterExpression: 'fileId = :fid',
        ExpressionAttributeValues: { ':fid': fileId },
        ExclusiveStartKey: lastKey
      }));
      items = items.concat(scanRes.Items || []);
      lastKey = scanRes.LastEvaluatedKey;
      scanPages++;
    } while (lastKey && scanPages < MAX_DELETE_SCAN_PAGES);

    if (items.length === 0) {
      return NextResponse.json({ success: false, error: '找不到檔案紀錄' }, { status: 404 });
    }

    // 若有多筆同 fileId，取最新
    const target = items.sort((a: any, b: any) => new Date(b.Timestamp).getTime() - new Date(a.Timestamp).getTime())[0];
    const uploader = (target.uploadedBy || target.userId || target.UserId || '').toString();
    // 舊資料可能沒有 unitId 欄位，fallback 用 assistantId 推斷（同 GET 列表邏輯）
    const recordUnit = (target.unitId || findUnitByAssistantId(target.assistantId) || '').toString();

    // 允許刪除條件：本人上傳者，或該單位的管理員（allowedUploaders 成員）
    const allowedUploaders = await getUnitAllowedUploaders(unitId);
    const isAdmin = allowedUploaders.length > 0 && allowedUploaders.includes(userId.toString());
    if (uploader !== userId.toString() && !isAdmin) {
      return NextResponse.json({ success: false, error: '無刪除權限 (非上傳者)' }, { status: 403 });
    }
    
    // 對於 default 單位，接受沒有 unitId 或 unitId 為空的記錄
    // 若記錄無明確 unitId，且請求單位的 assistantId 與記錄的 assistantId 一致，管理員可刪除
    // （解決 agape/eastChristHome 共用同一 assistantId 導致 findUnitByAssistantId 只回傳第一個單位的問題）
    const recordHasExplicitUnit = target.unitId !== undefined && target.unitId !== null && `${target.unitId}`.trim() !== '';
    const requestedUnitConfig = getSundayGuideUnitConfig(unitId);
    const requestedAssistantId = (requestedUnitConfig as any)?.assistantId;
    const assistantIdMatches = !!requestedAssistantId && target.assistantId === requestedAssistantId;

    const recordUnitMatches = (unitId === 'default')
      ? (!recordUnit || recordUnit === '' || recordUnit === 'default')
      : (recordUnit === unitId || (!recordHasExplicitUnit && assistantIdMatches));
      
    if (!recordUnitMatches) {
      return NextResponse.json({ success: false, error: '紀錄單位與請求單位不一致' }, { status: 400 });
    }

    const assistantId = target.assistantId;
    const timestamp = target.Timestamp;
    if (!assistantId || !timestamp) {
      return NextResponse.json({ success: false, error: '紀錄缺少主鍵 (assistantId / Timestamp)' }, { status: 500 });
    }

    // 刪除所有同 fileId 的紀錄（可能因重傳/重試產生多筆，一次清乾淨）
    await Promise.all(
      items
        .filter((item: any) => item.assistantId && item.Timestamp)
        .map((item: any) =>
          docClient.send(new DeleteCommand({
            TableName: tableName,
            Key: { assistantId: item.assistantId, Timestamp: item.Timestamp }
          }))
        )
    );

    // TODO: 若需連動刪除 OpenAI vector store 或文件，於此擴充（需要保存 vectorStoreId / openai file id）

    return NextResponse.json({ success: true, message: '刪除成功', fileId });
  } catch (error) {
    console.error('[DELETE /api/sunday-guide/documents] 失敗', error);
    return NextResponse.json({ success: false, error: '刪除失敗' }, { status: 500 });
  }
}

// 更新文檔標題（sermonTitle）
export async function PATCH(request: Request) {
  try {
    const { fileId, unitId, userId, sermonTitle } = await request.json();
    if (!fileId || !unitId || !userId || typeof sermonTitle !== 'string') {
      return NextResponse.json({ success: false, error: '缺少必要參數' }, { status: 400 });
    }
    const trimmedTitle = sermonTitle.trim();
    if (!trimmedTitle) {
      return NextResponse.json({ success: false, error: '標題不能為空' }, { status: 400 });
    }

    const docClient = await createDynamoDBClient();
    const tableName = process.env.NEXT_PUBLIC_SUNDAY_GUIDE_TABLE || 'SundayGuide';

    // 找到所有同 fileId 的紀錄
    let items: any[] = [];
    let lastKey: any = undefined;
    let scanPages = 0;
    do {
      const scanRes = await docClient.send(new ScanCommand({
        TableName: tableName,
        FilterExpression: 'fileId = :fid',
        ExpressionAttributeValues: { ':fid': fileId },
        ExclusiveStartKey: lastKey,
      }));
      items = items.concat(scanRes.Items || []);
      lastKey = scanRes.LastEvaluatedKey;
      scanPages++;
    } while (lastKey && scanPages < 50);

    if (items.length === 0) {
      return NextResponse.json({ success: false, error: '找不到檔案紀錄' }, { status: 404 });
    }

    const target = items.sort((a: any, b: any) =>
      new Date(b.Timestamp).getTime() - new Date(a.Timestamp).getTime()
    )[0];

    // 權限：上傳者本人或該單位管理員
    const uploader = (target.uploadedBy || target.userId || target.UserId || '').toString();
    const allowedUploaders = await getUnitAllowedUploaders(unitId);
    const isAdmin = allowedUploaders.length > 0 && allowedUploaders.includes(userId.toString());
    if (uploader !== userId.toString() && !isAdmin) {
      return NextResponse.json({ success: false, error: '無修改權限' }, { status: 403 });
    }

    // 更新所有同 fileId 紀錄的 sermonTitle
    await Promise.all(
      items
        .filter((item: any) => item.assistantId && item.Timestamp)
        .map((item: any) =>
          docClient.send(new UpdateCommand({
            TableName: tableName,
            Key: { assistantId: item.assistantId, Timestamp: item.Timestamp },
            UpdateExpression: 'SET sermonTitle = :title',
            ExpressionAttributeValues: { ':title': trimmedTitle },
          }))
        )
    );

    return NextResponse.json({ success: true, sermonTitle: trimmedTitle });
  } catch (error) {
    console.error('[PATCH /api/sunday-guide/documents] 失敗', error);
    return NextResponse.json({ success: false, error: '更新失敗' }, { status: 500 });
  }
}