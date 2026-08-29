'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import styles from './UserCredit.module.css';

// 定義每個用戶類型的 token 額度
const TOKEN_LIMITS = {
  free: 100000,     // 100 credits
  pro: 1000000,     // 1,000 credits
  ultimate: 5000000 // 5,000 credits
};

// Token 轉換為 Credit 的比率
const TOKEN_TO_CREDIT_RATIO = 1000; // 1000 tokens = 1 credit

// 用量達到這些百分比時，提前提醒用戶
const WARNING_THRESHOLD = 80;
const DANGER_THRESHOLD = 95;

const PRICING_URL = `${process.env.NEXT_PUBLIC_PRIMARY_DOMAIN || 'https://ai4kingdom.org'}/pricing-2/`;

interface UsageData {
  monthlyTokens: number;
  dailyTokens?: number;
}

export default function UserCreditPage() {
  const { user, loading: authLoading } = useAuth();
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchUsage = async () => {
    if (!user?.user_id) return;

    setLoading(true);
    setError(null);
    try {
      // 獲取當前年份
      const currentYear = new Date().getFullYear();
      // 獲取當前月份
      const currentMonth = new Date().getMonth() + 1;
      // 建構查詢月份字串，例如 "2025-05"
      const monthStr = `${currentYear}-${currentMonth.toString().padStart(2, '0')}`;

      // 添加隨機參數防止緩存
      const cacheBuster = new Date().getTime();
      // 呼叫 API 獲取用戶使用量
      const response = await fetch(`/api/usage/monthly?userId=${user.user_id}&year=${currentYear}&_=${cacheBuster}`);

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || '無法獲取使用量數據');
      }

      const data = await response.json();

      if (data.success && Array.isArray(data.usage)) {
        // 查找當前月份的使用量
        const currentMonthUsage = data.usage.find((item: any) =>
          item.YearMonth === monthStr
        );

        // 注意這裡的欄位名稱使用與數據庫一致的命名
        setUsage({
          monthlyTokens: currentMonthUsage?.totalTokens || 0,
          dailyTokens: currentMonthUsage?.dailyTokens || 0
        });
      } else {
        // 如果沒有數據，設置為 0
        setUsage({ monthlyTokens: 0, dailyTokens: 0 });
      }
    } catch (err) {
      console.error('[ERROR] 獲取 Token 使用量失敗:', err);
      setError(err instanceof Error ? err.message : '獲取數據時發生錯誤');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!authLoading && user) {
      fetchUsage();
      // 每 5 分鐘刷新一次數據
      const intervalId = setInterval(fetchUsage, 5 * 60 * 1000);
      return () => clearInterval(intervalId);
    } else if (!authLoading && !user) {
      setLoading(false);
    }
  }, [user, authLoading]);

  // 處理到期日期顯示
  const formatExpiryDate = () => {
    // 後端目前回傳 expiry，舊資料可能仍是 expiresAt，兩者都接受
    const subscription = user?.subscription as
      | { expiry?: string | Date | null; expiresAt?: string | Date | null }
      | undefined;
    const expiryValue = subscription?.expiry || subscription?.expiresAt;

    if (!expiryValue) {
      return '永久有效';
    }

    try {
      const expiryDate = new Date(expiryValue);
      if (Number.isNaN(expiryDate.getTime())) return '未知';
      return expiryDate.toLocaleDateString('zh-TW', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
    } catch (err) {
      console.error('日期格式錯誤:', err);
      return '未知';
    }
  };

  if (loading || authLoading) {
    return <div className={styles.loading}>載入中，請稍候...</div>;
  }

  if (!user) {
    return <div className={styles.error}>請先登入</div>;
  }

  if (error) {
    return <div className={styles.error}>錯誤: {error}</div>;
  }

  const subscriptionType = user.subscription?.type || 'free';
  const subscriptionName =
    subscriptionType === 'ultimate' ? 'Ultimate' :
    subscriptionType === 'pro' ? 'Pro' : 'Free';

  const tokenLimit = TOKEN_LIMITS[subscriptionType];
  const usedTokens = Math.max(0, usage?.monthlyTokens || 0);
  const remainingTokens = Math.max(0, tokenLimit - usedTokens);

  // 用量百分比：只有真正用滿才顯示 100%，剛開始使用時至少顯示 1%
  const rawPercent = tokenLimit > 0 ? (usedTokens / tokenLimit) * 100 : 0;
  const percentUsed = rawPercent >= 100
    ? 100
    : Math.max(rawPercent > 0 ? 1 : 0, Math.floor(rawPercent));
  const percentRemaining = 100 - percentUsed;

  const totalCredits = Math.floor(tokenLimit / TOKEN_TO_CREDIT_RATIO);
  const usedCredits = Math.min(totalCredits, Math.floor(usedTokens / TOKEN_TO_CREDIT_RATIO));
  const remainingCredits = Math.floor(remainingTokens / TOKEN_TO_CREDIT_RATIO);

  const isExhausted = remainingTokens <= 0;
  const isNearLimit = !isExhausted && percentUsed >= WARNING_THRESHOLD;
  const isFreePlan = subscriptionType === 'free';
  const canUpgrade = subscriptionType !== 'ultimate';

  const barLevel = isExhausted || percentUsed >= DANGER_THRESHOLD
    ? styles.danger
    : percentUsed >= WARNING_THRESHOLD
      ? styles.warning
      : '';

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>用户额度管理</h1>

      {/* 本月用量百分比 */}
      <div className={styles.usageCard}>
        <div className={styles.usageHeader}>
          <h3 className={styles.usageTitle}>本月 Token 用量</h3>
          <span className={`${styles.planBadge} ${styles[`plan_${subscriptionType}`]}`}>
            {subscriptionName}
          </span>
        </div>

        <div className={styles.percentBlock}>
          <span className={`${styles.percentValue} ${barLevel}`}>{percentUsed}%</span>
          <span className={styles.percentLabel}>已使用（尚余 {percentRemaining}%）</span>
        </div>

        <div
          className={styles.progressContainer}
          role="progressbar"
          aria-valuenow={percentUsed}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="本月 Token 用量百分比"
        >
          <div
            className={`${styles.progressBar} ${barLevel}`}
            style={{ width: `${percentUsed}%` }}
          />
        </div>

        <div className={styles.tokenInfo}>
          <span>{usedTokens.toLocaleString()} / {tokenLimit.toLocaleString()} tokens</span>
          <span>{usedCredits.toLocaleString()} / {totalCredits.toLocaleString()} credits</span>
        </div>

        <div className={styles.lastUpdated}>
          更新时间：{new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}
        </div>
      </div>

      {/* 額度用盡：溫和提醒升級 */}
      {isExhausted && (
        <div className={styles.upgradeCard}>
          <h3 className={styles.upgradeTitle}>
            {isFreePlan
              ? '感谢您使用 AI4Kingdom！本月免费额度已用完'
              : '本月额度已用完'}
          </h3>
          <p className={styles.upgradeText}>
            {isFreePlan
              ? `您的 Free 方案每月 ${totalCredits.toLocaleString()} credits 已全部使用。额度会在下月 1 日自动重置；若希望现在继续使用，欢迎升级方案，立即取得更多 credits 并解锁进阶功能。`
              : `您的 ${subscriptionName} 方案每月 ${totalCredits.toLocaleString()} credits 已全部使用，额度将于下月 1 日自动重置。`}
          </p>
          {canUpgrade && (
            <a
              className={styles.upgradeButton}
              href={PRICING_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              查看方案与升级
            </a>
          )}
        </div>
      )}

      {/* 接近上限：提前預告 */}
      {isNearLimit && (
        <div className={styles.noticeCard}>
          <p className={styles.noticeText}>
            您本月额度已使用 {percentUsed}%，仅剩 {remainingCredits.toLocaleString()} credits。
            {canUpgrade && ' 如需更多用量，可随时升级方案。'}
          </p>
          {canUpgrade && (
            <a
              className={styles.noticeLink}
              href={PRICING_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              查看方案 →
            </a>
          )}
        </div>
      )}

      {/* 帳戶資訊 */}
      <div className={styles.infoCard}>
        <div className={styles.infoRow}>
          <span>用户ID:</span>
          <span>{user.user_id}</span>
        </div>
        <div className={styles.infoRow}>
          <span>方案:</span>
          <span className={styles.plan}>{subscriptionName}</span>
        </div>
        <div className={styles.infoRow}>
          <span>到期时间:</span>
          <span>{formatExpiryDate()}</span>
        </div>
        <div className={styles.infoRow}>
          <span>剩余Credits:</span>
          <span className={styles.credits}>{remainingCredits.toLocaleString()}</span>
        </div>
      </div>

      <div className={styles.creditsExplanation}>
        <p>每月额度将在每月1日重置，未使用的额度不会累计到下个月。</p>
      </div>
    </div>
  );
}
