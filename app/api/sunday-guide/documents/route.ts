import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { createDynamoDBClient } from '../../../utils/dynamodb';
import { PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// 獲取文件記錄列表的API端點
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const assistantId = searchParams.get('assistantId');
    let userId = searchParams.get('userId'); // 添加獲取 userId 查詢參數
    
    console.log('[DEBUG] 請求參數:', {
      assistantId,
      userId,
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
    
    // 如果提供了assistantId，加入過濾條件
    if (assistantId) {
      filterExpressions.push("assistantId = :assistantId");
      expressionAttributeValues[":assistantId"] = assistantId;
    }
    
    // 如果提供了userId，加入過濾條件 - 使用 OR 條件同時檢查字符串和數字類型
    if (userId) {
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
    
    // 查詢文件記錄
    const result = await docClient.send(new ScanCommand(params));
    
    console.log('[DEBUG] 查詢結果:', {
      itemCount: result.Items?.length || 0,
      firstItem: result.Items && result.Items.length > 0 ? JSON.stringify(result.Items[0]).substring(0, 200) : '無記錄'
    });
    
    // 返回結果
    return NextResponse.json({
      success: true,
      records: result.Items?.map(item => ({
        assistantId: item.assistantId,
        vectorStoreId: item.vectorStoreId,
        fileId: item.fileId,
        fileName: item.fileName || '未命名文件',
        updatedAt: item.updatedAt || item.Timestamp,
        userId: item.userId || item.UserId || '-', // 統一使用 userId 並兼容舊數據
        summary: item.summary ? '已生成' : '未生成',
        fullText: item.fullText ? '已生成' : '未生成',
        devotional: item.devotional ? '已生成' : '未生成', 
        bibleStudy: item.bibleStudy ? '已生成' : '未生成'
      })) || []
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

    // 转换文件格式
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

      // 4. 更新 DynamoDB 记录
      currentStep = '更新 DynamoDB 記錄';
      stepStartTime = Date.now();
      console.log(`[DEBUG] 步驟 4: 開始${currentStep}`);
      
      const docClient = await createDynamoDBClient();
      const tableName = process.env.NEXT_PUBLIC_SUNDAY_GUIDE_TABLE || 'SundayGuide';
      
      // 標準化用戶 ID 的處理
      let parsedUserId = userId;
      
      // 如果 userId 是數字字符串，保留原始字符串形式
      if (userId && !isNaN(Number(userId))) {
        console.log(`[DEBUG] 用戶 ID "${userId}" 是數字格式的字符串`);
        parsedUserId = userId; // 保持字符串形式
      } else if (!userId) {
        console.log(`[DEBUG] 未提供用戶 ID，使用默認值 "unknown"`);
        parsedUserId = 'unknown';
      } else {
        console.log(`[DEBUG] 使用字符串用戶 ID: "${userId}"`);
      }
      
      console.log(`[DEBUG] 使用數據表: ${tableName}，用戶 ID (${typeof parsedUserId}): ${parsedUserId}`);
      
      const item = {
        assistantId,
        vectorStoreId: vectorStore.id,
        fileId: openaiFile.id,
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type,
        userId: parsedUserId, // 使用處理後的 userId
        uploadTimestamp: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        Timestamp: new Date().toISOString() // 添加 Timestamp 作為主鍵
      };
      
      console.log(`[DEBUG] 即將寫入的 DynamoDB 記錄:`, JSON.stringify(item, null, 2));
      
      const command = new PutCommand({
        TableName: tableName,
        Item: item
      });

      const result = await docClient.send(command);
      console.log(`[DEBUG] 步驟 4: ${currentStep}成功，响應:`, JSON.stringify(result, null, 2));
      console.log(`[DEBUG] 整個處理流程完成，總耗時: ${Date.now() - startTime}ms`);

      return NextResponse.json({
        success: true,
        vectorStoreId: vectorStore.id,
        fileId: openaiFile.id,
        fileName: file.name,
        userId: parsedUserId, // 返回用戶 ID
        processingTime: Date.now() - startTime
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
          apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL,
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