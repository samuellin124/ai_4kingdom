import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { createDynamoDBClient } from '@/app/utils/dynamodb';
import { PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { getPromptsInBatch, defaultPrompts } from '@/app/utils/aiPrompts';
import { ASSISTANT_IDS, VECTOR_STORE_IDS } from '@/app/config/constants';
import { optimizedQuery } from '@/app/utils/dynamodbHelpers';
import { splitDocumentIfNeeded, createMultiThreadProcessor } from '@/app/utils/documentProcessor';
// waitUntil is Vercel-specific; imported conditionally below

export const maxDuration = 300; // 5 minutes max for background processing

const SUNDAY_GUIDE_TABLE = process.env.NEXT_PUBLIC_SUNDAY_GUIDE_TABLE || 'SundayGuide';
const PROGRESS_TABLE = process.env.NEXT_PUBLIC_SUNDAY_GUIDE_PROGRESS || 'SundayGuideProgress';
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// 用 gpt-4o-mini 直接從 summary 抽取講道標題
async function extractSermonTitle(openaiClient: OpenAI, summary: string, fileName?: string): Promise<string | null> {
  if (!summary) return null;
  try {
    const fileNameHint = fileName ? `\n\n文件名稱（僅供參考）：${fileName}` : '';
    const res = await openaiClient.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: `從以下講章總結中提取講道標題，只回答標題本身，不要任何其他內容、標點或說明。注意：如果看到「讲章标题」、「一、讲章标题」等模板佔位符文字，請忽略它們，從總結內容中找出真實的講道主題作為標題。${fileNameHint}\n\n${summary.slice(0, 800)}` }],
      max_tokens: 60,
      temperature: 0,
    });
    const title = res.choices[0]?.message?.content?.trim() || null;
    return title ? title.slice(0, 80) : null;
  } catch {
    return null;
  }
}

// 新增：等待特定檔案在向量庫中就緒
async function waitForFileReady(openaiClient: OpenAI, vectorStoreId: string, fileId: string, timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      // 檢查特定檔案的狀態
      // 注意：vectorStores.files.retrieve 可能不支援，需用 list 過濾或直接 retrieve
      // OpenAI Node SDK 支援 retrieve: client.beta.vectorStores.files.retrieve(vsId, fileId)
      const file = await openaiClient.beta.vectorStores.files.retrieve(vectorStoreId, fileId);
      if (file.status === 'completed') {
        console.log(`[DEBUG] 檔案 ${fileId} 在向量庫 ${vectorStoreId} 中索引完成`);
        return true;
      } else if (file.status === 'failed') {
        console.error(`[ERROR] 檔案 ${fileId} 在向量庫 ${vectorStoreId} 中索引失敗: ${file.last_error?.message}`);
        return false;
      }
    } catch (e) {
      // 忽略暫時性錯誤
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.warn(`[WARN] 等待檔案 ${fileId} 索引超時`);
  return false;
}

// 修改：準備向量庫（統一處理，包含等待索引）
// 注意：檔案未就緒的錯誤會向上拋出（讓 processDocumentAsync 寫入 DynamoDB failed 記錄）；
//       OpenAI API 暫時性錯誤則靜默處理以免中斷整體流程。
async function prepareEffectiveVectorStore(openaiClient: OpenAI, vectorStoreId: string, fileId?: string) {
  const effectiveVectorStoreId = vectorStoreId;
  let cleanup: (() => Promise<void>) | undefined = undefined;

  // 決定要等待的目標 fileId
  let targetFileId: string | undefined = fileId;

  try {
    const list = await openaiClient.beta.vectorStores.files.list(vectorStoreId);
    const files = list.data || [];

    if (files.length === 0) {
      // 空向量庫，無需等待
      return { effectiveVectorStoreId, cleanup };
    }

    if (files.length === 1 && !fileId) {
      // 單檔且無指定 fileId → 等待該唯一檔案
      targetFileId = files[0].id;
    }
    // 多檔且有 fileId → targetFileId 已是 fileId，直接等待
    // 多檔且無 fileId → targetFileId = undefined，跳過等待（已有歷史索引）
  } catch (e) {
    console.warn('[WARN] 無法列出向量庫檔案，將略過索引等待', e);
    return { effectiveVectorStoreId, cleanup };
  }

  if (targetFileId) {
    console.log(`[DEBUG] 等待檔案 ${targetFileId} 在向量庫 ${vectorStoreId} 中索引完成...`);
    const ready = await waitForFileReady(openaiClient, vectorStoreId, targetFileId);
    if (!ready) {
      // 向上拋出，讓 processDocumentAsync catch 寫入 failed 記錄，前端即時看到錯誤
      throw new Error(`檔案 ${targetFileId} 在向量庫中索引失敗，請確認檔案格式（建議使用 PDF 或 .docx），或重新上傳。`);
    }
    console.log(`[INFO] 向量庫 ${vectorStoreId} 的檔案 ${targetFileId} 索引就緒，開始生成內容`);
  }

  return { effectiveVectorStoreId, cleanup };
}

// 進度更新：若表不存在則僅記一次警告並停用後續寫入
let progressTableUnavailable = false;
async function updateProgress(docClient: any, {
  vectorStoreId,
  fileName,
  stage,
  status = 'processing',
  progress = 0,
  error
}: { vectorStoreId: string; fileName: string; stage: string; status?: string; progress?: number; error?: string }) {
  if (progressTableUnavailable) return; // 已標記不可用，直接返回
  try {
    await docClient.send(new PutCommand({
      TableName: PROGRESS_TABLE,
      Item: {
        id: `${vectorStoreId}#${fileName}#${stage}`,
        vectorStoreId,
        fileName,
        stage,
        status,
        progress,
        error: error || null,
        updatedAt: new Date().toISOString()
      }
    }));
    // 僅在成功時輸出 debug
    console.log('[DEBUG] 已更新進度表', { stage, status, progress });
  } catch (e: any) {
    if (e?.name === 'ResourceNotFoundException' || e?.__type?.includes('ResourceNotFound')) {
      progressTableUnavailable = true;
      console.warn('[WARN] 進度表不存在，停用後續進度寫入 (僅顯示一次)。建議建立 DynamoDB 表:', PROGRESS_TABLE);
    } else {
      console.warn('[WARN] 寫入進度表失敗（將繼續重試下次階段）', e);
    }
  }
}

// 非同步處理文件內容
async function processDocumentAsync(params: {
  assistantId: string;
  vectorStoreId: string;
  fileName: string;
  fileId?: string;
  userId?: string;
  threadId?: string; // 新增參數，允許傳入自定義線程ID
  unitId?: string; // 所屬單位（agape / eastChristHome / jianZhu / default）
}) {
  const { assistantId, vectorStoreId, fileName, fileId, userId, threadId, unitId } = params;
  const effectiveUserId = userId ? String(userId) : 'unknown';
  const processingStartTime = Date.now();
  const docClient = await createDynamoDBClient();
  let attemptMetaUpdated = false;
  let effectiveVectorStoreId = vectorStoreId;
  let cleanup: (() => Promise<void>) | undefined = undefined;

  // 先標記為 processing，避免前端長時間停在 pending
  try {
    const filterExpr = unitId
      ? 'fileId = :fid AND unitId = :unitId'
      : 'fileId = :fid';
    const existing = await optimizedQuery({
      tableName: SUNDAY_GUIDE_TABLE,
      keyCondition: {},
      filterExpression: filterExpr,
      expressionAttributeValues: unitId
        ? { ':fid': fileId || vectorStoreId, ':unitId': unitId }
        : { ':fid': fileId || vectorStoreId }
    });
    if (existing.Items && existing.Items.length) {
      const latest = existing.Items.sort((a,b)=> new Date(b.Timestamp||'').getTime()-new Date(a.Timestamp||'').getTime())[0];
      await docClient.send(new UpdateCommand({
        TableName: SUNDAY_GUIDE_TABLE,
        Key: { assistantId: latest.assistantId, Timestamp: latest.Timestamp },
        UpdateExpression: 'SET generationStatus = :gs, attemptCount = if_not_exists(attemptCount, :zero) + :one, updatedAt = :now',
        ExpressionAttributeValues: { ':gs':'processing', ':one':1, ':zero':0, ':now': new Date().toISOString() }
      }));
      attemptMetaUpdated = true;
    }
  } catch (e) {
    console.warn('[WARN] 預標記 generationStatus=processing 失敗', e);
  }

  try {
    // 1. 統一準備向量庫資源
    console.log(`[DEBUG] 開始準備向量庫資源...`);
    const prepared = await prepareEffectiveVectorStore(openai, vectorStoreId, fileId);
    effectiveVectorStoreId = prepared.effectiveVectorStoreId;
    cleanup = prepared.cleanup;
    console.log(`[DEBUG] 向量庫資源準備完成，使用 ID: ${effectiveVectorStoreId}`);

    // 不再更新進度狀態，只記錄日誌
    console.log(`[DEBUG] 開始處理文件: ${fileName}`);

  // 初始化進度（開始產生）
  await updateProgress(docClient, { vectorStoreId, fileName, stage: 'summary', progress: 10 });
    // 從 AIPrompts 資料表中獲取 prompts
    console.log('[DEBUG] 從 AIPrompts 資料表獲取 prompts');
    const AI_PROMPTS_TABLE = process.env.NEXT_PUBLIC_AI_PROMPTS_TABLE || 'AIPrompts';
    const promptsToFetch = ['summary', 'devotional', 'bibleStudy'];
    
    console.log('[DEBUG] 正在批量獲取 prompts...', { table: AI_PROMPTS_TABLE, prompts: promptsToFetch });
    const promptsFromDB = await getPromptsInBatch(promptsToFetch, AI_PROMPTS_TABLE);
    
    // 詳細驗證獲取的 prompts
    console.log('[DEBUG] 獲取 prompts 結果驗證:', {
      summary: { 
        length: promptsFromDB.summary?.length || 0, 
        preview: promptsFromDB.summary?.substring(0, 50) + '...',
        hasContent: !!promptsFromDB.summary && promptsFromDB.summary.length > 20
      },
      devotional: { 
        length: promptsFromDB.devotional?.length || 0, 
        preview: promptsFromDB.devotional?.substring(0, 50) + '...',
        hasContent: !!promptsFromDB.devotional && promptsFromDB.devotional.length > 20
      },
      bibleStudy: { 
        length: promptsFromDB.bibleStudy?.length || 0, 
        preview: promptsFromDB.bibleStudy?.substring(0, 50) + '...',
        hasContent: !!promptsFromDB.bibleStudy && promptsFromDB.bibleStudy.length > 20
      }
    });    // 準備處理的內容類型，並確保每個類型都有對應的提示詞
    const contentTypes = [
      { type: 'summary', prompt: promptsFromDB.summary || defaultPrompts.summary },
      // { type: 'fullText', prompt: '請完整保留原文內容，並加入適當的段落分隔。不要省略任何內容。' }, // Disabled fullText processing
      { type: 'devotional', prompt: promptsFromDB.devotional || defaultPrompts.devotional },
      { type: 'bibleStudy', prompt: promptsFromDB.bibleStudy || defaultPrompts.bibleStudy }
    ];
    
    // 最終驗證使用的 prompts
    console.log('[DEBUG] 最終使用的 prompts 驗證:');
    contentTypes.forEach(({ type, prompt }) => {
      const isUsingDefault = prompt === defaultPrompts[type];
      const isValid = prompt && prompt.length > 20 && !prompt.includes('無法直接訪問文件');
      console.log(`[DEBUG] ${type}: 長度=${prompt.length}, 使用默認=${isUsingDefault}, 有效=${isValid}, 預覽=${prompt.substring(0, 40)}...`);
      
      if (!isValid) {
        console.warn(`[WARN] ${type} prompt 可能無效，將使用 defaultPrompts`);
      }
    });
    
  const results: Record<string, string> = {};

  // 單一內容類型處理函式（保留重試機制），支援注入 summary 文字以供後續內容優先引用經文
  async function processContentType({ type, prompt, summaryText }: { type: string, prompt: string, summaryText?: string }) {
      console.log(`[DEBUG] 並行處理 ${type} 內容開始...`);
      
      const failurePhrases = ['無法直接訪問', '无法直接访问', '我無法直接訪問', '請提供', '無法讀取', '[MISSING]', '無法從您上傳的文件中檢索到'];
      const maxRuns = 2; // 最多重試 2 次，搭配 MAX_POLLS=20 確保總時間 < 300s

      for (let attempt = 1; attempt <= maxRuns; attempt++) {
        // 建立新執行緒
        const typeThread = await openai.beta.threads.create();
        console.log(`[DEBUG] 為 ${type} 建立執行緒 ID: ${typeThread.id} (嘗試 ${attempt}/${maxRuns})`);

        // 若已有 summary，且本次為 devotional 或 bibleStudy，則將 summary 注入並強調經文優先規則與標籤
        if (type !== 'summary' && summaryText) {
          await openai.beta.threads.messages.create(typeThread.id, {
            role: 'user',
            content: `Here is the sermon summary already generated:\n---\n${summaryText}\n---\n\nWhen selecting and quoting Bible verses for this ${type}, you MUST:\n1) FIRST prioritize verses already identified in the summary and label them [From Summary];\n2) SECOND use verses directly present in the sermon file and label them [In Sermon];\n3) ONLY THEN, if fewer than required, add supplemental verses labeled [Supplemental: reason] with a short justification.\n\nAlways paste the exact verse text (CUV for Chinese; NIV for English). Avoid duplication unless the sermon itself repeats the verse.`
          });
        }

        // 主要 prompt - 確保格式要求清晰
        await openai.beta.threads.messages.create(typeThread.id, {
          role: 'user',
          content: `請基於文件 "${fileName}" 的內容執行以下任務：

${prompt}

特別注意：
${type === 'devotional' ? 
  `- 必須提供完整的7天靈修指南（週一到週日）
  - 每天必須包含：a) 該部分講道總結, b) 3節經文（含完整經文內容）, c) 禱告指導
  - 每天內容至少400-500字，總計3000+字
  - 內容要像資深牧者的親切指導，豐富詳細` :
  
  type === 'bibleStudy' ? 
  `- 必須包含以下完整結構：
    1. 背景（講道總結）
    2. 三個重要點
    3. 3-5節聖經經文（含完整經文內容）
    4. 討論問題（3個）
    5. 應用問題（1-2個）
    6. 禱告時間建議
    7. 破冰遊戲（推薦一個簡短遊戲）
    8. 敬拜詩歌（3首推薦，來自讚美之泉、小羊詩歌、迦南詩選或泥土音樂）
    9. 見證分享（100-200字）
  - 總內容至少2000-2500字，要像經驗豐富的小組長的完整預備` :
  
  `- 提供詳細完整的內容，至少1500-2000字
  - 包含所有重點、細節、例證和應用`
}

請確保內容結構清晰、格式完整，就像專業的教會資源一樣。`
        });

        // 針對不同內容類型的 token 分配設定 - 合理上限以避免 Lambda 超時
        const tokenConfig = {
          summary: 8000,       // 總結：約 1500-2000 字
          devotional: 16000,   // 靈修：7天內容，每天 400-500 字
          bibleStudy: 14000    // 查經：包含多個完整段落
        };

        const run = await (openai.beta.threads.runs.create as any)(
          typeThread.id,
          {
            assistant_id: assistantId,
            // 在 run 級別綁定 vector store，避免修改 assistant 本體
            tool_resources: { file_search: { vector_store_ids: [effectiveVectorStoreId] } },
            // 控制隨機性與一致性，並強制使用檢索工具
            max_completion_tokens: tokenConfig[type as keyof typeof tokenConfig] || 60000,
            temperature: 0.3, // 降低隨機性，增加結構一致性
            top_p: 0.9,
            tool_choice: 'required',
            instructions: `STRICT MODE:
- Only use the sermon file (and the provided summary for verse priority when present).
- For every Bible verse: paste full text and append one of [From Summary] / [In Sermon] / [Supplemental: reason].
- Follow the exact format structure requested in the prompt.
- For ${type}, ensure ALL required sections are included with proper formatting.
- If uncertain about content, write "[MISSING]" rather than guessing.`
          } as any
        );

        // 輪詢狀態（固定 4s 間隔，最多 20 次 = 80s 上限）
        let runStatus = await openai.beta.threads.runs.retrieve(typeThread.id, run.id);
        let poll = 0;
        const POLL_INTERVAL = 4000;
        const MAX_POLLS = 20;
        while ((runStatus.status === 'queued' || runStatus.status === 'in_progress') && poll < MAX_POLLS) {
          await new Promise(r => setTimeout(r, POLL_INTERVAL));
          runStatus = await openai.beta.threads.runs.retrieve(typeThread.id, run.id);
          poll++;
        }
        if (runStatus.status !== 'completed') {
          console.warn(`[WARN] ${type} 執行未完成狀態=${runStatus.status}；嘗試 ${attempt}`);
          if (attempt === maxRuns) throw new Error(`處理 ${type} 內容失敗: ${runStatus.status}`);
          // 輕量回退後重試
          await new Promise(r => setTimeout(r, 600));
          continue;
        }

        const messages = await openai.beta.threads.messages.list(typeThread.id, { limit: 1 });
        const lastMessage = messages.data[0];
        const content = lastMessage.content
          .filter(c => c.type === 'text')
          .map(c => (c.type === 'text' ? c.text.value : ''))
          .join('\n');

        const invalid = failurePhrases.some(p => content.includes(p)) || content.trim().length < 50;
        console.log(`[DEBUG] ${type} 嘗試 ${attempt} 完成，長度=${content.length}，invalid=${invalid}`);
        
        if (invalid) {
          if (attempt < maxRuns) {
            console.warn(`[WARN] ${type} 內容無效 (包含錯誤關鍵字或過短)，將重試...`);
            // 這裡不需要再 waitForVectorStoreReady，因為我們在最外層已經確保它 ready 了
            // 除非是偶發的檢索失敗，重試 run 即可
            continue; // retry
          } else {
            // 最後一次嘗試仍然無效，拋出錯誤以便外層捕獲並標記為 failed
            throw new Error(`處理 ${type} 內容失敗: 產生的內容無效或包含錯誤訊息`);
          }
        }
        
        return { type, content };
      }
      throw new Error(`處理 ${type} 內容最終失敗`);
    }
    
    // 先產出 summary，再並行產出 devotional / bibleStudy（注入 summary 內容以強化經文一致性）
    console.log('[DEBUG] 先產出 summary，再以其作為後續依據');
    const summaryRes = await processContentType({ type: 'summary', prompt: (contentTypes[0].prompt) });
    results['summary'] = summaryRes.content;

    console.log('[DEBUG] 產出 devotional / bibleStudy（帶入 summary 內容以優先經文）');
    const settled = await Promise.allSettled([
      processContentType({ type: 'devotional', prompt: (contentTypes[1].prompt), summaryText: results.summary }),
      processContentType({ type: 'bibleStudy', prompt: (contentTypes[2].prompt), summaryText: results.summary })
    ]);
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        results[s.value.type] = s.value.content;
      } else {
        console.warn('[WARN] 子任務失敗:', s.reason);
      }
    }
    console.log(`[DEBUG] devotional / bibleStudy 並行處理完成`);

    // 獲取處理結束時間並計算總處理時間（毫秒）
    const processingEndTime = Date.now();
    const serverProcessingTime = processingEndTime - processingStartTime;
    
    console.log(`[DEBUG] 文件處理完成，總耗時: ${serverProcessingTime / 1000} 秒`);    // 查詢是否已存在檔案記錄
    console.log('[DEBUG] 查詢是否已存在檔案記錄');
  // docClient 已於函數頂部建立
    
    // 使用完整掃描來可靠地查找記錄
    const scanParams: any = {
      TableName: SUNDAY_GUIDE_TABLE,
      FilterExpression: unitId 
        ? "fileId = :fileId AND unitId = :unitId"
        : "fileId = :fileId",
      ExpressionAttributeValues: {
        ":fileId": fileId || vectorStoreId,
        ...(unitId ? { ":unitId": unitId } : {})
      }
    };
    
    let existingRecords: any = { Items: [] };
    let lastEvaluatedKey = undefined;
    let pageCount = 0;
    const maxPages = 50; // 防止無限循環
    
    do {
      if (lastEvaluatedKey) {
        scanParams.ExclusiveStartKey = lastEvaluatedKey;
      }
      const res = await docClient.send(new ScanCommand(scanParams));
      existingRecords.Items = existingRecords.Items.concat(res.Items || []);
      lastEvaluatedKey = (res as any).LastEvaluatedKey;
      pageCount += 1;
    } while (lastEvaluatedKey && pageCount < maxPages);
    
    console.log(`[DEBUG] 完整掃描找到 ${existingRecords.Items.length} 條fileId${unitId ? '+unitId' : ''}匹配記錄（共${pageCount}頁）`);
    
    const sermonTitle = fileName ? fileName.replace(/\.[^.]+$/, '') : (await extractSermonTitle(openai, results.summary) || null);
    console.log(`[DEBUG] 提取講章標題: ${sermonTitle}`);

    if (existingRecords.Items && existingRecords.Items.length > 0) {
      // 找到現有記錄，進行更新
      console.log(`[DEBUG] 找到 ${existingRecords.Items.length} 條既有記錄，更新處理結果`);
      const existingItem = existingRecords.Items[0]; // 使用第一條記錄
      
  await docClient.send(new UpdateCommand({
        TableName: SUNDAY_GUIDE_TABLE,
        Key: {
          assistantId: existingItem.assistantId,
          Timestamp: existingItem.Timestamp
        },
        UpdateExpression: "SET summary = :summary, devotional = :devotional, bibleStudy = :bibleStudy, processingTime = :processingTime, completed = :completed, generationStatus = :gs, updatedAt = :now, sermonTitle = :sermonTitle",
        ExpressionAttributeValues: {
          ":summary": results.summary,
          ":devotional": results.devotional,
          ":bibleStudy": results.bibleStudy,
          ":processingTime": serverProcessingTime,
          ":completed": true,
          ":gs": 'completed',
          ":now": new Date().toISOString(),
          ":sermonTitle": sermonTitle
        }
      }));
      console.log(`[DEBUG] 成功更新現有記錄`);
    } else {
      // 沒找到現有記錄，創建新記錄
      console.log('[DEBUG] 未找到現有記錄，創建新記錄');
      await docClient.send(new PutCommand({
        TableName: SUNDAY_GUIDE_TABLE,
        Item: {
          assistantId,
          vectorStoreId,
          fileName,
          fileId: fileId || vectorStoreId,
          userId: effectiveUserId, // 強制寫入有效 userId
          ...(unitId ? { unitId } : {}),
          summary: results.summary,
          // fullText: results.fullText, // Disabled fullText saving
          devotional: results.devotional,
          bibleStudy: results.bibleStudy,
          sermonTitle,
          processingTime: serverProcessingTime,
          completed: true,
          generationStatus: 'completed',
          attemptCount: 1,
          Timestamp: new Date().toISOString()
        }
      }));
    }
  // 最終標記完成進度
  await updateProgress(docClient, { vectorStoreId, fileName, stage: 'bibleStudy', status: 'completed', progress: 100 });
    
    console.log('[DEBUG] 處理完成，結果已保存');
    return true;
  } catch (error) {
    console.error('[ERROR] 非同步處理失敗:', error);
    try {
      const errorMsg = error instanceof Error ? error.message : '未知錯誤';
      const existing = await optimizedQuery({
        tableName: SUNDAY_GUIDE_TABLE,
        keyCondition: {},
        filterExpression: 'fileId = :fid',
        expressionAttributeValues: { ':fid': fileId || vectorStoreId }
      });
      if (existing.Items && existing.Items.length) {
        // 找到現有記錄 → 更新為 failed
        const latest = existing.Items.sort((a,b)=> new Date(b.Timestamp||'').getTime()-new Date(a.Timestamp||'').getTime())[0];
        await docClient.send(new UpdateCommand({
          TableName: SUNDAY_GUIDE_TABLE,
          Key: { assistantId: latest.assistantId, Timestamp: latest.Timestamp },
          UpdateExpression: 'SET generationStatus = :gs, lastError = :err, updatedAt = :now, attemptCount = if_not_exists(attemptCount,:zero) + :one',
          ExpressionAttributeValues: { ':gs':'failed', ':err': errorMsg, ':now': new Date().toISOString(), ':one':1, ':zero':0 }
        }));
      } else {
        // 找不到現有記錄（upload 的 DynamoDB 寫入可能失敗）→ 建立新的 failed 記錄，避免前端永久輪詢逾時
        console.warn('[WARN] 找不到現有記錄，建立新的 failed 記錄以通知前端');
        await docClient.send(new PutCommand({
          TableName: SUNDAY_GUIDE_TABLE,
          Item: {
            assistantId,
            vectorStoreId,
            fileName,
            fileId: fileId || vectorStoreId,
            userId: effectiveUserId,
            ...(unitId ? { unitId } : {}),
            generationStatus: 'failed',
            lastError: errorMsg,
            completed: false,
            attemptCount: 1,
            Timestamp: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }
        }));
      }
      await updateProgress(docClient, { vectorStoreId, fileName, stage: 'error', status: 'failed', progress: 100, error: errorMsg });
    } catch (e) { console.warn('[WARN] 記錄失敗狀態時出錯', e); }
    return false;
  } finally {
    // 統一清理
    if (typeof cleanup === 'function') {
      console.log('[DEBUG] 執行最終資源清理');
      await (cleanup as () => Promise<void>)();
    }
  }
}

export async function POST(request: Request) {
  try {
    const { assistantId, vectorStoreId, fileName, userId, fileId: fileIdFromReq, unitId } = await request.json();
    
    console.log('[DEBUG] 處理文件請求:', { assistantId, vectorStoreId, fileName });
    
    if (!assistantId || !vectorStoreId || !fileName) {
      return NextResponse.json(
        { error: '缺少必要參數', details: { assistantId, vectorStoreId, fileName } },
        { status: 400 }
      );
    }
    
  // 移除對 Assistant 的檢索與綁定更新；改用 run 級 tool_resources 綁定（見上方 processContentType）
  console.log('[DEBUG] 將在 run 級別綁定向量庫，略過 Assistant 綁定往返');

    // 獲取文件ID：優先使用請求提供的 fileId，否則再從數據庫/向量庫推斷
    let fileId: string | null = fileIdFromReq || null;
    if (fileId) {
      console.log('[DEBUG] 從請求取得 fileId:', fileId);
    }
    console.log('[DEBUG] 查詢數據庫獲取fileId（若請求未提供）');
    try {
      // 用 vectorStoreId + fileName 精確查詢，避免取到其他檔案的舊記錄
      const filterExpr = unitId
        ? "vectorStoreId = :vectorStoreId AND fileName = :fileName AND unitId = :unitId"
        : "vectorStoreId = :vectorStoreId AND fileName = :fileName";
      const result = await optimizedQuery({
        tableName: SUNDAY_GUIDE_TABLE,
        keyCondition: {},
        filterExpression: filterExpr,
        expressionAttributeValues: unitId
          ? { ":vectorStoreId": vectorStoreId, ":fileName": fileName, ":unitId": unitId }
          : { ":vectorStoreId": vectorStoreId, ":fileName": fileName }
      });
      
      if (!fileId && result.Items && result.Items.length > 0) {
        // 優先取有 fileId 欄位且最新的記錄
        const withFileId = result.Items.filter((item: any) => item.fileId);
        const pool = withFileId.length > 0 ? withFileId : result.Items;
        const latestItem = pool.sort((a: any, b: any) => 
          new Date(b.Timestamp || "").getTime() - new Date(a.Timestamp || "").getTime()
        )[0];
        fileId = latestItem.fileId || null;
        console.log(`[DEBUG] 從數據庫找到文件 ID: ${fileId}`);
      }
    } catch (dbError) {
      console.error('[ERROR] 數據庫查詢失敗:', dbError);
    }

    // 檢查 Vector Store 中的文件（僅在 fileId 仍未解析時才呼叫，節省 API 往返）
    if (!fileId) {
      try {
        const filesInVectorStore = await openai.beta.vectorStores.files.list(vectorStoreId);
        console.log(`[DEBUG] Vector Store 中的文件:`, 
          filesInVectorStore.data.map(f => ({ id: f.id, status: f.status, created_at: f.created_at })));
        
        if (filesInVectorStore.data.length >= 1) {
          // 取最新加入向量庫的檔案（created_at 最大），即剛上傳的那個
          const sortedFiles = [...filesInVectorStore.data]
            .sort((a: any, b: any) => (b.created_at || 0) - (a.created_at || 0));
          fileId = sortedFiles[0].id;
          console.log(`[DEBUG] 從向量庫取最新加入的檔案 ID: ${fileId}（共 ${filesInVectorStore.data.length} 個檔案）`);
        }
      } catch (vectorStoreError) {
        console.error('[ERROR] 获取 Vector Store 文件失败:', vectorStoreError);
      }
    }
    
    // Await synchronously — Next.js dev mode kills background Promises after the response is sent.
    // On Vercel, maxDuration=300 gives 5 min; timeouts inside processDocumentAsync keep total < 285s.
    await processDocumentAsync({
      assistantId,
      vectorStoreId,
      fileName,
      fileId: fileId || undefined,
      userId,
      unitId: unitId || undefined,
    }).catch((err) => console.error('[ERROR] 處理出錯:', err));

    return NextResponse.json({
      success: true,
      message: '文件處理完成',
    });

  } catch (error) {
    console.error('[ERROR] 文件處理觸發失敗:', error);
    return NextResponse.json(
      { error: '文件處理失敗', details: error instanceof Error ? error.message : '未知錯誤' },
      { status: 500 }
    );
  }
}