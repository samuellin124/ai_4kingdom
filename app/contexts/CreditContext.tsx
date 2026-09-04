'use client';

import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { useAuth } from './AuthContext';
import { TOKEN_LIMITS, TOKEN_TO_CREDIT_RATIO } from '../config/plans';

interface UsageData {
  monthlyTokens: number;
  dailyTokens?: number;
}

interface CreditContextType {
  usage: UsageData | null;
  loading: boolean;
  error: string | null;
  refreshUsage: () => Promise<void>;
  remainingCredits: number;
  lastRefreshTime: Date | null;
  hasInsufficientTokens: boolean; // 新增檢查 token 是否不足的屬性
}

const CreditContext = createContext<CreditContextType | null>(null);

export function CreditProvider({ children }: { children: React.ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshTime, setLastRefreshTime] = useState<Date | null>(null);

  // 獲取用戶使用量數據的函數
  const fetchUsage = useCallback(async () => {
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
      
      console.log('[DEBUG] 獲取用戶使用量數據:', {
        userId: user.user_id,
        data: data,
        時間戳: new Date().toISOString()
      });
      
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
        
        // 更新最後刷新時間
        setLastRefreshTime(new Date());
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
  }, [user]);

  // 初始加載及定期刷新
  useEffect(() => {
    if (!authLoading && user) {
      fetchUsage();
      // 每 5 分鐘刷新一次數據 (縮短自動刷新間隔)
      const intervalId = setInterval(fetchUsage, 5 * 60 * 1000);
      return () => clearInterval(intervalId);
    } else if (!authLoading && !user) {
      setLoading(false);
    }
  }, [user, authLoading, fetchUsage]);

  // 訂閱全局事件，用於從任何組件觸發刷新
  useEffect(() => {
    const handleGlobalRefresh = () => {
      console.log('[DEBUG] 收到全局刷新信用點數請求');
      fetchUsage();
    };
    
    // 註冊事件監聽器
    window.addEventListener('refreshCredits', handleGlobalRefresh);
    
    // 清理函數
    return () => window.removeEventListener('refreshCredits', handleGlobalRefresh);
  }, [fetchUsage]);

  // 計算剩餘 Credits
  const calculateRemainingCredits = useCallback(() => {
    if (!user || !usage) return 0;

    const subscriptionType = user.subscription?.type || 'free';
    const limit = TOKEN_LIMITS[subscriptionType];
    const used = usage.monthlyTokens || 0;
    const remaining = Math.max(0, limit - used);
    return Math.floor(remaining / TOKEN_TO_CREDIT_RATIO);
  }, [user, usage]);

  const remainingCredits = calculateRemainingCredits();
  
  // 檢查是否有足夠的 tokens
  const hasInsufficientTokens = useCallback(() => {
    if (!user || !usage) return false;
    
    const subscriptionType = user.subscription?.type || 'free';
    const limit = TOKEN_LIMITS[subscriptionType];
    const used = usage.monthlyTokens || 0;
    const remaining = limit - used;
    
    return remaining <= 0;
  }, [user, usage]);

  // 提供給外部的上下文值
  const contextValue: CreditContextType = {
    usage,
    loading,
    error,
    refreshUsage: fetchUsage,
    remainingCredits,
    lastRefreshTime,
    hasInsufficientTokens: hasInsufficientTokens() // 添加到 context 中
  };

  return (
    <CreditContext.Provider value={contextValue}>
      {children}
    </CreditContext.Provider>
  );
}

export const useCredit = () => {
  const context = useContext(CreditContext);
  if (!context) {
    throw new Error('useCredit must be used within a CreditProvider');
  }
  return context;
};