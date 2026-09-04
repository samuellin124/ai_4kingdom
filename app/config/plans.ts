// 訂閱方案的月度 token 額度（單一真實來源）。
// 過去這組數字被複製在 CreditContext / api/usage/all / token-management / usercredit 四處，
// 調整時容易漏改，統一收斂到這裡。
//
// 額度為「每自然月」重置：用量存於 DynamoDB MonthlyTokenUsage，key = {UserId, YYYY-MM}；
// 跨月即為新 key，讀不到舊 row → 用量歸零 → 額度恢復。無排程重置作業。

export type SubscriptionType = 'free' | 'pro' | 'ultimate';

export const TOKEN_TO_CREDIT_RATIO = 1000; // 1000 tokens = 1 credit

export const TOKEN_LIMITS: Record<SubscriptionType, number> = {
  free: 300000,      // 300 credits
  pro: 3000000,      // 3,000 credits
  ultimate: 10000000 // 10,000 credits
};

/** 取得指定方案的 token 上限；未知型別一律回退 free。 */
export function getTokenLimit(type?: string | null): number {
  return TOKEN_LIMITS[(type as SubscriptionType)] ?? TOKEN_LIMITS.free;
}

/** token 數換算為 credit（無條件捨去）。 */
export function tokensToCredits(tokens: number): number {
  return Math.floor((tokens || 0) / TOKEN_TO_CREDIT_RATIO);
}
