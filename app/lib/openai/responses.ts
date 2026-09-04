import OpenAI from 'openai';
import { resolveAssistantProfile } from './profiles';

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  retrieval_tokens: number;
}

// Responses API 的 usage 欄位是 input_tokens/output_tokens，
// 轉成專案內部沿用的 Run usage 形狀（prompt/completion）以免動到記帳與前端。
export function toTokenUsage(usage: any): TokenUsage | null {
  if (!usage) return null;
  const prompt = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const completion = usage.output_tokens ?? usage.completion_tokens ?? 0;
  const total = usage.total_tokens ?? prompt + completion;
  if (!prompt && !completion && !total) return null;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total, retrieval_tokens: 0 };
}

export function extractResponseText(response: any): string {
  if (typeof response?.output_text === 'string' && response.output_text) return response.output_text;
  // 後備：手動聚合 output 內的 message 文字
  const parts: string[] = [];
  for (const item of response?.output || []) {
    if (item?.type === 'message') {
      for (const c of item.content || []) {
        if (c?.type === 'output_text' && c.text) parts.push(c.text);
      }
    }
  }
  return parts.join('\n');
}

export interface GenerateParams {
  assistantId?: string;
  model?: string;
  instructions?: string;
  input: string | Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  vectorStoreId?: string | null;
  vectorStoreIds?: string[];
  conversationId?: string;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  /** Reasoning-model effort (Responses API `reasoning.effort`). Only pass for gpt-5.x models. */
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  requireFileSearch?: boolean;
  metadata?: Record<string, string>;
}

export interface GenerateResult {
  text: string;
  usage: TokenUsage | null;
  responseId: string;
  status: string;
  response: any;
}

/**
 * 單次呼叫完成「舊 thread + run + 輪詢」整段流程的統一替代品。
 * assistantId 僅用來解析 model/instructions（instructions 參數會覆寫 assistant 原設定，
 * 與舊 Assistants API run 級 instructions 的語意一致）。
 */
export async function generateResponse(openai: OpenAI, params: GenerateParams): Promise<GenerateResult> {
  const profile = await resolveAssistantProfile(openai, params.assistantId);
  const vectorStoreIds = params.vectorStoreIds?.length
    ? params.vectorStoreIds
    : params.vectorStoreId
      ? [params.vectorStoreId]
      : [];

  const response = await openai.responses.create({
    model: params.model || profile.model,
    instructions: params.instructions ?? profile.instructions ?? undefined,
    input: params.input as any,
    ...(params.conversationId ? { conversation: params.conversationId } : {}),
    ...(vectorStoreIds.length
      ? { tools: [{ type: 'file_search' as const, vector_store_ids: vectorStoreIds }] }
      : {}),
    ...(params.requireFileSearch && vectorStoreIds.length ? { tool_choice: 'required' as const } : {}),
    ...(params.maxOutputTokens ? { max_output_tokens: params.maxOutputTokens } : {}),
    ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
    ...(params.topP !== undefined ? { top_p: params.topP } : {}),
    ...(params.reasoningEffort ? { reasoning: { effort: params.reasoningEffort } } : {}),
    ...(params.metadata ? { metadata: params.metadata } : {}),
  });

  return {
    text: extractResponseText(response),
    usage: toTokenUsage((response as any).usage),
    responseId: response.id,
    status: (response as any).status || 'completed',
    response,
  };
}
