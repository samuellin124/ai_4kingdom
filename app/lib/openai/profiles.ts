import OpenAI from 'openai';
import { ASSISTANT_PROFILE_OVERRIDES, AssistantProfileOverride } from '@/app/config/assistantProfiles';

export interface AssistantProfile {
  model: string;
  instructions?: string;
  temperature?: number;
  top_p?: number;
}

// 明確代表「assistantId 本身無效」（OpenAI 回 404），對應舊 Assistants API 驗證失敗的情境；
// 與其他錯誤（網路異常、或日落後整個 API 消失）分開處理，避免日落後把每個請求都判定為無效助手。
export class AssistantNotFoundError extends Error {
  constructor(public readonly assistantId: string) {
    super(`Assistant not found: ${assistantId}`);
    this.name = 'AssistantNotFoundError';
  }
}

export const DEFAULT_MODEL = process.env.OPENAI_RESPONSES_MODEL || 'gpt-5.6-terra';

// 每個 server instance 的記憶體快取，避免每則訊息都往返一次 assistants.retrieve
const profileCache = new Map<string, { profile: AssistantProfile; expiresAt: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * 將舊 Assistants API 的 assistantId 解析為 Responses API 需要的 model/instructions。
 * 解析順序：assistantProfiles.ts 快照 → 記憶體快取 → 即時抓取 assistant 設定（日落前有效）→ 預設模型。
 */
export async function resolveAssistantProfile(
  openai: OpenAI,
  assistantId?: string | null
): Promise<AssistantProfile> {
  if (!assistantId) return { model: DEFAULT_MODEL };

  const override: AssistantProfileOverride | undefined = ASSISTANT_PROFILE_OVERRIDES[assistantId];
  if (override?.model) {
    return {
      model: override.model,
      instructions: override.instructions,
      temperature: override.temperature,
      top_p: override.top_p,
    };
  }

  const cached = profileCache.get(assistantId);
  if (cached && cached.expiresAt > Date.now()) return cached.profile;

  let profile: AssistantProfile;
  try {
    const assistant = await openai.beta.assistants.retrieve(assistantId);
    profile = {
      model: assistant.model || DEFAULT_MODEL,
      instructions: assistant.instructions || override?.instructions || undefined,
      temperature: assistant.temperature ?? undefined,
      top_p: assistant.top_p ?? undefined,
    };
  } catch (e) {
    if (e instanceof OpenAI.NotFoundError) {
      // 明確的「無此助手」——維持舊行為，讓呼叫端可以回 400 而不是靜默降級
      throw new AssistantNotFoundError(assistantId);
    }
    // 其他錯誤（網路異常、或 Assistants API 日落後整個端點消失）：優雅降級，
    // 避免遷移後系統因為單一端點退場而整個聊天功能不可用。
    console.warn(
      '[WARN] 無法取得 assistant 設定（非「找不到助手」錯誤，可能是 Assistants API 已移除），改用預設模型:',
      assistantId,
      e instanceof Error ? e.message : e
    );
    profile = { model: DEFAULT_MODEL, instructions: override?.instructions };
  }
  profileCache.set(assistantId, { profile, expiresAt: Date.now() + CACHE_TTL_MS });
  return profile;
}
