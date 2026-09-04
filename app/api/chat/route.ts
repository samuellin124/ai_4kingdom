import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { NextResponse } from 'next/server';
import { updateMonthlyTokenUsage } from '../../utils/monthlyTokenUsage';
import { getConcernLabel } from '../../types/homeschool';
import { createDynamoDBClient } from '../../utils/dynamodb';
import { getOpenAI } from '../../lib/openai/client';
import { resolveAssistantProfile, AssistantNotFoundError } from '../../lib/openai/profiles';
import { ensureConversation, isConversationId } from '../../lib/openai/conversation';
import { toTokenUsage, extractResponseText } from '../../lib/openai/responses';
import { acquireConversationLock, releaseConversationLock } from '../../lib/openai/conversationLock';
import { getSundayGuideUnitConfig, findUnitByAssistantId } from '../../config/constants';

// Ensure dynamic behavior on Amplify/Next.js App Router
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

// 获取 DynamoDB 客户端函数
const getDocClient = async (): Promise<DynamoDBDocumentClient> => {
  return await createDynamoDBClient();
};

// CORS 配置
const ALLOWED_ORIGINS = [
  'https://main.d1b5nk0vz3t0hz.amplifyapp.com',
  process.env.NEXT_PUBLIC_PRIMARY_DOMAIN || 'https://ai4kingdom.org',
  process.env.NEXT_PUBLIC_FALLBACK_DOMAIN || 'https://ai4kingdom.com',
  'http://localhost:3000'
];

function setCORSHeaders(origin: string | null) {
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-WP-Nonce, X-Requested-With, Accept',
  });

  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    // 添加 Vary 头以支持多源
    headers.set('Vary', 'Origin');
  }

  return headers;
}

// 構建 Homeschool 專用的 instructions，強制助手在回覆中引用孩子資料
async function buildHomeschoolInstructions(userId?: string) {
  if (!userId) return undefined;
  try {
    const doc = await getDocClient();
    const get = new GetCommand({
      TableName: 'HomeschoolPrompts',
      Key: { UserId: String(userId) }
    });
    const res = await doc.send(get);
    const data: any = res.Item || {};
    if (!data || (!data.childName && !data.age && !data.gender && !data.concerns)) return undefined;

    const parts: string[] = [];
    if (typeof data.age === 'number') parts.push(`年齡：${data.age} 歲`);
    if (data.gender) parts.push(`性別：${data.gender === 'male' ? '男孩' : '女孩'}`);
    if (Array.isArray(data.concerns) && data.concerns.length > 0) {
      const labels = data.concerns.map((c: string) => getConcernLabel(c));
      const other = data.concerns.includes('other') && data.otherConcern ? `（${data.otherConcern}）` : '';
      parts.push(`主要關注：${labels.join('、')}${other}`);
    }

    const summary = parts.join('；');
    // 指令：要求每次回覆開頭列出資料摘要
    return `你是家庭教育輔導助手。以下是此孩子的資料摘要，請務必根據此資料提供個人化建議，且每次回覆開頭先輸出一行「學生資料：${summary}」。若資料不完整，先友善提醒使用者到 /homeschool-prompt 完善資料。`;
  } catch (e) {
    console.warn('[WARN] 構建 Homeschool 指令失敗，將略過:', e);
    return undefined;
  }
}

// 將 Responses API 串流事件轉譯為前端既有的 Assistants 事件格式（維持 SSE 合約不變）
function sseEncode(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export async function POST(request: Request) {
  const openai = getOpenAI();
  let lockedConversationId: string | null = null;
  try {
    console.log('[DEBUG] 接收到聊天請求:', {
      method: request.method,
      url: request.url,
      contentType: request.headers.get('content-type'),
      timestamp: new Date().toISOString()
    });

    // 驗證請求體
    let requestBody;
    try {
      requestBody = await request.json();
      console.log('[DEBUG] 解析請求體成功:', {
        hasMessage: !!requestBody.message,
        hasConfig: !!requestBody.config,
        hasUserId: !!requestBody.userId,
        configType: requestBody.config?.type
      });
    } catch (parseError) {
      console.error('[ERROR] 解析請求體失敗:', parseError);
      const origin = request.headers.get('origin');
      const headers = setCORSHeaders(origin);
      return NextResponse.json({
        error: '請求格式無效',
        details: '無法解析請求體'
      }, {
        status: 400,
        headers
      });
    }

    const { message, threadId, userId, config, unitId, fileId } = requestBody;

    // 驗證必要參數
    if (!message || !config || !config.assistantId) {
      console.error('[ERROR] 缺少必要參數:', {
        hasMessage: !!message,
        hasConfig: !!config,
        hasAssistantId: !!config?.assistantId
      });
      const origin = request.headers.get('origin');
      const headers = setCORSHeaders(origin);
      return NextResponse.json({
        error: '缺少必要參數',
        details: '需要 message, config 和 assistantId'
      }, {
        status: 400,
        headers
      });
    }

    // 單位識別（目前僅支援 agape 額外隔離）
    const isAgapeUnit = unitId === 'agape' || (config?.type === 'sunday-guide' && typeof request.headers.get('referer') === 'string' && request.headers.get('referer')?.includes('agape-church'));

    // 如為 agape 強制覆寫 vectorStoreId 為專用向量庫（若存在）
    if (isAgapeUnit) {
      try {
        const { VECTOR_STORE_IDS } = await import('../../config/constants');
        if (VECTOR_STORE_IDS.AGAPE_CHURCH) {
          config.vectorStoreId = VECTOR_STORE_IDS.AGAPE_CHURCH;
        }
      } catch (e) {
        console.warn('[WARN] 無法載入 VECTOR_STORE_IDS 以覆寫 Agape 向量庫', e);
      }
    }

    // 解析 assistant 對應的 model/instructions（沿用舊行為：無效 assistantId 直接回 400）
    let profile;
    try {
      profile = await resolveAssistantProfile(openai, config.assistantId);
    } catch (error) {
      if (error instanceof AssistantNotFoundError) {
        console.error('[ERROR] 助手验证失败:', { assistantId: config.assistantId, error });
        const origin = request.headers.get('origin');
        const headers = setCORSHeaders(origin);
        return NextResponse.json({
          error: '助手ID无效',
          details: {
            message: error.message,
            assistantId: config.assistantId,
          }
        }, { status: 400, headers });
      }
      throw error;
    }

    // 取得或建立 conversation；舊 thread_ ID 會被懶遷移為 conversation
    let existingId: string | undefined = threadId;
    if (isConversationId(threadId)) {
      // 與舊行為一致：先驗證仍存在，失敗則建立新的
      try {
        await openai.conversations.retrieve(threadId);
      } catch (error) {
        console.warn('[WARN] 取得現有 conversation 失敗，將建立新的:', error);
        existingId = undefined;
      }
    }
    const { conversationId, migrated } = await ensureConversation(openai, existingId, {
      userId,
      type: config.type,
      assistantId: config.assistantId,
      vectorStoreId: config.vectorStoreId
    });
    if (migrated) {
      console.log('[INFO] 舊 thread 已遷移:', { threadId, conversationId });
    }

    // 併發保護：同一對話僅允許一個進行中的請求（DynamoDB 條件寫入，跨 instance 安全）
    if (!(await acquireConversationLock(conversationId))) {
      const originBusy = request.headers.get('origin');
      const headersBusy = setCORSHeaders(originBusy);
      return NextResponse.json({
        error: 'ThreadBusy',
        message: '上一輪回覆尚未完成，請稍候再發送。',
        threadId: conversationId
      }, { status: 409, headers: headersBusy });
    }
    lockedConversationId = conversationId;

    // Homeschool 指令覆寫（沿用舊 run 級 instructions 覆寫語意）
    const homeschoolInstructions = config.type === 'homeschool' ? await buildHomeschoolInstructions(userId) : undefined;
    const instructions = homeschoolInstructions ?? profile.instructions;

    // 若前端帶了選定的講章 fileId，且該記錄確實屬於本對話的單位/助手，就把 file_search 限縮到這篇；
    // 否則（沒選、或 fileId 是別頁殘留）維持搜尋整個單位向量庫。
    // 檢查對象包含：本對話的 assistantId + 該單位的專屬 assistantId（jian-zhu 用 SUNDAY_GUIDE 助手
    // 對話但記錄掛在 JIAN_ZHU；zhiming-yuan 舊記錄掛在 SUNDAY_GUIDE）。
    let scopedFileId: string | null = null;
    if (fileId && typeof fileId === 'string') {
      const candidateAssistantIds = new Set<string>();
      if (config.assistantId) candidateAssistantIds.add(config.assistantId);
      if (unitId) {
        const uc = getSundayGuideUnitConfig(unitId);
        if (uc?.assistantId) candidateAssistantIds.add(uc.assistantId);
      }
      try {
        const doc = await getDocClient();
        const table = process.env.NEXT_PUBLIC_SUNDAY_GUIDE_TABLE || 'SundayGuide';
        for (const aid of candidateAssistantIds) {
          // 不能用 Limit：DynamoDB 的 Limit 是「套 FilterExpression 前」的讀取上限，
          // 加 Limit:1 只會讀分區第一筆再過濾，通常過濾不到；分區筆數小，整區掃即可。
          const q = await doc.send(new QueryCommand({
            TableName: table,
            KeyConditionExpression: 'assistantId = :aid',
            FilterExpression: 'fileId = :fid',
            ExpressionAttributeValues: { ':aid': aid, ':fid': fileId },
          }));
          const rec = q.Items?.[0];
          if (!rec) continue;
          // 只有當「該講章生成內容所在的單位向量庫」== 本對話實際檢索的向量庫時才限縮，
          // 否則過濾會套用在沒有這些檔案的庫上，導致檢索不到（例如 jian-zhu 對話目前指向
          // 通用 SUNDAY_GUIDE 向量庫，但其生成內容在 JIAN_ZHU 向量庫）。
          const recUnit = rec.unitId || findUnitByAssistantId(rec.assistantId);
          const recStore = getSundayGuideUnitConfig(recUnit)?.vectorStoreId;
          if (recStore && recStore === config.vectorStoreId) {
            scopedFileId = fileId;
            console.log('[DEBUG] Chat 檢索限縮至選定講章:', { fileId, matchedAssistantId: aid, recUnit });
          } else {
            console.log('[DEBUG] 選定講章所屬向量庫與本對話不符，不限縮:', { fileId, recUnit, recStore, chatStore: config.vectorStoreId });
          }
          break;
        }
        if (!scopedFileId) {
          console.log('[DEBUG] 未限縮檢索（未找到記錄或向量庫不符），搜尋整庫:', { fileId, tried: [...candidateAssistantIds], unitId });
        }
      } catch (e) {
        console.warn('[WARN] 驗證選定 fileId 失敗，改為搜尋整庫:', e);
      }
    }

    const fileSearchTool = config.vectorStoreId
      ? {
          type: 'file_search' as const,
          vector_store_ids: [config.vectorStoreId],
          // 限制檢索片段數以壓低 input token（預設約 20 段會把整段內容塞進上下文）
          max_num_results: 8,
          ...(scopedFileId ? { filters: { key: 'sgFileId', type: 'eq' as const, value: scopedFileId } } : {}),
        }
      : null;

    const baseParams = {
      model: profile.model,
      ...(instructions ? { instructions } : {}),
      conversation: conversationId,
      input: [{ role: 'user' as const, content: String(message) }],
      max_output_tokens: 2500,
      // 對話問答不需要深度推理；gpt-5.6 預設 medium 會產生大量計費的推理 token，改用 low
      reasoning: { effort: 'low' as const },
      ...(fileSearchTool ? { tools: [fileSearchTool] } : {})
    };

    // 检查是否請求流式輸出
    if (config.stream) {
      console.log('[DEBUG] 處理流式請求:', {
        userId,
        assistantId: config.assistantId,
        model: profile.model,
        conversationId,
        vectorStoreId: config.vectorStoreId || 'none'
      });

      const responseStream = await openai.responses.create({ ...baseParams, stream: true });

      // 將 Responses 事件轉譯為前端沿用的 Assistants 事件形狀後下發
      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          let responseId: string | null = null;

          try {
            for await (const event of responseStream as AsyncIterable<any>) {
              switch (event.type) {
                case 'response.created': {
                  responseId = event.response?.id || null;
                  controller.enqueue(encoder.encode(sseEncode({
                    event: 'thread.run.created',
                    data: { id: responseId, thread_id: conversationId }
                  })));
                  break;
                }
                case 'response.output_text.delta': {
                  controller.enqueue(encoder.encode(sseEncode({
                    event: 'thread.message.delta',
                    data: { delta: { content: [{ type: 'text', text: { value: event.delta } }] } }
                  })));
                  break;
                }
                case 'response.completed': {
                  // 記錄 token 使用量（Responses usage → 內部 Run usage 形狀）
                  const tokenUsage = toTokenUsage(event.response?.usage);
                  if (tokenUsage) {
                    if (userId) {
                      try {
                        await updateMonthlyTokenUsage(userId, tokenUsage);
                        console.log('[SUCCESS] ✅ 已成功記錄用戶 token 使用量:', { userId, tokenUsage });
                        controller.enqueue(encoder.encode(sseEncode({ event: 'usage.recorded', usage: tokenUsage })));
                      } catch (usageErr: any) {
                        console.error('[ERROR] stream 分支記錄 token 使用量失敗:', {
                          error: usageErr?.message || String(usageErr),
                          userId,
                          conversationId
                        });
                      }
                    } else {
                      console.warn('[WARN] stream 完成但缺少 userId，無法記錄 token 使用量');
                    }
                  }
                  controller.enqueue(encoder.encode(sseEncode({
                    event: 'thread.run.completed',
                    data: { id: responseId || event.response?.id, thread_id: conversationId }
                  })));
                  controller.enqueue(encoder.encode(sseEncode({ event: 'done' })));
                  break;
                }
                case 'response.failed':
                case 'response.incomplete': {
                  console.error('[ERROR] Responses 串流未正常完成:', event.type, event.response?.error || event.response?.incomplete_details);
                  controller.enqueue(encoder.encode(sseEncode({
                    event: 'thread.run.failed',
                    data: {
                      id: responseId,
                      thread_id: conversationId,
                      last_error: event.response?.error || event.response?.incomplete_details || null
                    }
                  })));
                  controller.enqueue(encoder.encode(sseEncode({ event: 'done' })));
                  break;
                }
                case 'error': {
                  console.error('[ERROR] Responses 串流錯誤事件:', event);
                  controller.enqueue(encoder.encode(sseEncode({
                    event: 'thread.run.failed',
                    data: { id: responseId, thread_id: conversationId, last_error: { message: event.message || '串流錯誤' } }
                  })));
                  controller.enqueue(encoder.encode(sseEncode({ event: 'done' })));
                  break;
                }
                default:
                  // 其他事件（file_search 進度等）前端不需要，略過
                  break;
              }
            }
          } catch (error) {
            console.error('[ERROR] 流式處理錯誤:', error);
            controller.enqueue(encoder.encode(sseEncode({
              event: 'error',
              error: error instanceof Error ? error.message : '流式處理失敗'
            })));
          } finally {
            try {
              controller.close();
            } catch (e) {
              console.warn('[WARN] 流關閉時發生錯誤:', e);
            }
            // 無論成功或錯誤釋放鎖
            await releaseConversationLock(conversationId);
          }
        },
        async cancel() {
          console.log('[DEBUG] 客戶端斷開連接，串流已取消');
          await releaseConversationLock(conversationId);
        }
      });

      // 設置 CORS 標頭
      const origin = request.headers.get('origin');
      const corsHeaders = setCORSHeaders(origin);

      // 返回流式响应
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          ...Object.fromEntries(corsHeaders.entries())
        }
      });
    }

    // 非流式请求：單次呼叫即完成（不再需要輪詢）
    const response = await openai.responses.create(baseParams);

    if ((response as any).status && (response as any).status !== 'completed') {
      console.error('[ERROR] 助手回應未完成:', (response as any).status, (response as any).error);
      throw new Error(`Assistant response failed with status: ${(response as any).status}`);
    }

    const assistantReply = extractResponseText(response);

    // 添加 token 使用量记录
    const tokenUsage = toTokenUsage((response as any).usage);
    if (!userId) {
      console.warn('[WARN] 非流式模式完成但缺少 userId，無法記錄 token 使用量');
    } else if (!tokenUsage) {
      console.warn('[WARN] 非流式模式完成但缺少 usage 資料，無法記錄 token 使用量');
    } else {
      try {
        await updateMonthlyTokenUsage(userId, tokenUsage);
        console.log(`[SUCCESS] ✅ 已成功記錄用戶 ${userId} 的聊天 token 使用量 (非流式):`, tokenUsage);
      } catch (usageError: any) {
        // 记录错误但不中断请求
        console.error('[ERROR] 記錄 token 使用量失敗:', {
          error: usageError?.message || String(usageError),
          userId,
          conversationId
        });
      }
    }

    await releaseConversationLock(conversationId);
    lockedConversationId = null;

    // 設置 CORS 標頭
    const origin = request.headers.get('origin');
    const headers = setCORSHeaders(origin);

    return NextResponse.json({
      success: true,
      reply: assistantReply,
      threadId: conversationId,
      debug: {
        responseId: response.id,
        status: (response as any).status || 'completed'
      }
    }, { headers });

  } catch (error) {
    // 發生錯誤時釋放鎖
    if (lockedConversationId) {
      await releaseConversationLock(lockedConversationId);
    }
    console.error('[ERROR] 聊天API错误:', {
      error,
      type: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });

    // 獲取 origin 並設置 CORS 標頭
    const origin = request.headers.get('origin');
    const headers = setCORSHeaders(origin);

    return NextResponse.json({
      error: error instanceof Error ? error.message : '未知错误',
      details: error instanceof Error ? error.stack : undefined
    }, {
      status: 500,
      headers
    });
  }
}

// 保留 OPTIONS 方法用于 CORS
export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin');
  const headers = setCORSHeaders(origin);

  return new Response(null, {
    status: 204,
    headers
  });
}
