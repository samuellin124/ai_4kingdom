'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import styles from './TokenManagement.module.css';
import { TOKEN_LIMITS, TOKEN_TO_CREDIT_RATIO } from '../config/plans';

interface UserUsage {
  userId: string;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  retrievalTokens: number;
  yearMonth: string;
  lastUpdated: string;
  subscription: string;
  subscriptionExpiry: string | null;
  remainingTokens: number;
  totalCredits: number;
  remainingCredits: number;
}

export default function TokenManagementPage() {
  const [usageData, setUsageData] = useState<UserUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);  const [filter, setFilter] = useState('');
  const [resetInProgress, setResetInProgress] = useState<string | null>(null);
  const [lastRefreshTime, setLastRefreshTime] = useState<Date | null>(null);
  const [bulkResetInProgress, setBulkResetInProgress] = useState(false);
  const [sortField, setSortField] = useState<keyof UserUsage>('remainingTokens');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

  // 獲取所有用戶的使用數據
  const fetchAllUsage = async () => {
    setLoading(true);
    setError(null);
    try {
      // 添加隨機參數防止緩存
      const cacheBuster = new Date().getTime();
      const response = await fetch(`/api/usage/all?_=${cacheBuster}`);
      
      console.log('[DEBUG] API 回應狀態:', response.status);
      
      if (!response.ok) {
        const errorData = await response.json();
        console.error('[DEBUG] API 錯誤:', errorData);
        throw new Error(errorData.error || '無法獲取使用量數據');
      }

      const data = await response.json();
      console.log('[DEBUG] API 回應數據:', data);
      
      if (data.success && Array.isArray(data.usage)) {
        console.log('[DEBUG] 成功獲取', data.usage.length, '個用戶的數據');
        setUsageData(data.usage);
        setLastRefreshTime(new Date());
      } else {
        console.log('[DEBUG] API 回應格式異常:', data);
        setUsageData([]);
      }
    } catch (err) {
      console.error('[ERROR] 獲取所有用戶 Token 使用量失敗:', err);
      setError(err instanceof Error ? err.message : '獲取數據時發生錯誤');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAllUsage();
    // 每 5 分鐘刷新一次數據
    const intervalId = setInterval(fetchAllUsage, 5 * 60 * 1000);
    return () => clearInterval(intervalId);
  }, []);
  // 重置用戶的 token 使用量
  const resetUserTokens = async (userId: string) => {
    setResetInProgress(userId);
    setError(null);
    setSuccess(null);
    
    try {
      const response = await fetch('/api/usage/reset', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ userId }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || '重置用戶 token 失敗');
      }

      const result = await response.json();
      if (result.success) {
        setSuccess(`已成功重置用戶 ${userId} 的 token 使用量`);
        // 重新獲取最新數據
        fetchAllUsage();
      } else {
        throw new Error(result.message || '操作未完成');
      }
    } catch (err) {
      console.error('[ERROR] 重置用戶 token 失敗:', err);
      setError(err instanceof Error ? err.message : '操作時發生錯誤');
    } finally {
      setResetInProgress(null);
    }
  };

  // 批量重置所有過濾後的用戶 token
  const resetAllFilteredUsersTokens = async () => {
    if (!confirm('確定要重置所有過濾後的用戶 token 嗎？此操作不可逆。')) {
      return;
    }

    setBulkResetInProgress(true);
    setError(null);
    setSuccess(null);
    
    try {
      const resetPromises = filteredData.map(async (user) => {
        try {
          const response = await fetch('/api/usage/reset', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ userId: user.userId }),
          });

          if (!response.ok) {
            const errorData = await response.json();
            console.error(`重置用戶 ${user.userId} 失敗:`, errorData);
            return { userId: user.userId, success: false };
          }

          return { userId: user.userId, success: true };
        } catch (err) {
          console.error(`重置用戶 ${user.userId} 出錯:`, err);
          return { userId: user.userId, success: false };
        }
      });

      const results = await Promise.all(resetPromises);
      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;

      if (failCount > 0) {
        setError(`批量重置完成，${successCount} 個用戶重置成功，${failCount} 個用戶重置失敗`);
      } else {
        setSuccess(`成功重置所有 ${successCount} 個用戶的 token 使用量`);
      }

      // 重新獲取最新數據
      fetchAllUsage();
    } catch (err) {
      console.error('[ERROR] 批量重置用戶 token 失敗:', err);
      setError(err instanceof Error ? err.message : '批量重置操作時發生錯誤');
    } finally {
      setBulkResetInProgress(false);
    }
  };
  // 切換排序方式
  const handleSort = (field: keyof UserUsage) => {
    if (sortField === field) {
      // 如果已經按此欄位排序，則切換排序方向
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      // 如果是新欄位，預設為升序
      setSortField(field);
      setSortDirection('asc');
    }
  };

  // 根據用戶 ID 過濾數據，並根據排序條件排序
  const filteredData = usageData
    .filter(user => user.userId.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => {
      // 根據選定的欄位和方向進行排序
      if (sortField === 'userId') {
        return sortDirection === 'asc'
          ? a.userId.localeCompare(b.userId)
          : b.userId.localeCompare(a.userId);
      } else {
        // 數值欄位的排序
        const aValue = a[sortField] as number;
        const bValue = b[sortField] as number;
        return sortDirection === 'asc' ? aValue - bValue : bValue - aValue;
      }
    });
  return (
    <div className={styles.container}>
      <Link href="/management" className={styles.backButton}>返回後台管理</Link>
      <h1 className={styles.title}>用戶點數管理</h1>
      
      {error && <div className={styles.error}>{error}</div>}
      {success && <div className={styles.success}>{success}</div>}
        <div className={styles.filterContainer}>
        <input 
          type="text" 
          placeholder="按用戶 ID 搜尋..." 
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button 
          className={styles.refreshButton} 
          onClick={fetchAllUsage}
          disabled={loading || bulkResetInProgress}
        >
          刷新數據
        </button>
        {filteredData.length > 0 && (
          <button 
            className={`${styles.resetButton} ${styles.bulkResetButton}`} 
            onClick={resetAllFilteredUsersTokens}
            disabled={loading || bulkResetInProgress}
          >
            {bulkResetInProgress ? '批量重置中...' : `批量重置 ${filteredData.length} 個用戶`}
          </button>
        )}
      </div>
      
      {loading ? (
        <div className={styles.loadingOverlay}>載入中，請稍候...</div>
      ) : (
        <>
          <table className={styles.usersTable}>            <thead>
              <tr>
                <th onClick={() => handleSort('userId')}>
                  用戶 ID 
                  {sortField === 'userId' && (
                    <span className={styles.sortIndicator}>
                      {sortDirection === 'asc' ? ' ▲' : ' ▼'}
                    </span>
                  )}
                </th>
                <th onClick={() => handleSort('totalTokens')}>
                  已用 Token / Credit
                  {sortField === 'totalTokens' && (
                    <span className={styles.sortIndicator}>
                      {sortDirection === 'asc' ? ' ▲' : ' ▼'}
                    </span>
                  )}
                </th>
                <th onClick={() => handleSort('remainingTokens')}>
                  剩餘 Token / Credit
                  {sortField === 'remainingTokens' && (
                    <span className={styles.sortIndicator}>
                      {sortDirection === 'asc' ? ' ▲' : ' ▼'}
                    </span>
                  )}
                </th>
                <th>總額度 Token / Credit</th>
                <th onClick={() => handleSort('subscription')}>
                  訂閱類型
                  {sortField === 'subscription' && (
                    <span className={styles.sortIndicator}>
                      {sortDirection === 'asc' ? ' ▲' : ' ▼'}
                    </span>
                  )}
                </th>
                <th>到期日期</th>
                <th onClick={() => handleSort('lastUpdated')}>
                  上次更新時間
                  {sortField === 'lastUpdated' && (
                    <span className={styles.sortIndicator}>
                      {sortDirection === 'asc' ? ' ▲' : ' ▼'}
                    </span>
                  )}
                </th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filteredData.length > 0 ? (
                filteredData.map((user) => (
                  <tr key={user.userId}>
                    <td className={styles.userId}>{user.userId}</td>                    <td>
                      {user.totalTokens.toLocaleString()} / {Math.floor(user.totalTokens / TOKEN_TO_CREDIT_RATIO)}
                    </td>                    <td className={
                      user.remainingTokens <= 0 ? styles.dangerTokens :
                      user.remainingTokens / TOKEN_LIMITS[user.subscription as keyof typeof TOKEN_LIMITS] < 0.2 ? styles.warningTokens :
                      styles.goodTokens
                    }>
                      {user.remainingTokens.toLocaleString()} / {user.remainingCredits}
                      <div className={styles.progressContainer}>
                        {(() => {
                          const tokenLimit = TOKEN_LIMITS[user.subscription as keyof typeof TOKEN_LIMITS];
                          const percentUsed = Math.min(100, Math.round((user.totalTokens / tokenLimit) * 100));
                          return (
                            <div 
                              className={`${styles.progressBar} ${percentUsed >= 80 ? styles.warning : ''} ${percentUsed >= 95 ? styles.danger : ''}`} 
                              style={{ width: `${percentUsed}%` }}
                            />
                          );
                        })()}
                      </div>
                    </td>
                    <td>
                      {TOKEN_LIMITS[user.subscription as keyof typeof TOKEN_LIMITS].toLocaleString()} / {Math.floor(TOKEN_LIMITS[user.subscription as keyof typeof TOKEN_LIMITS] / TOKEN_TO_CREDIT_RATIO)}
                    </td>                    <td>
                      {user.subscription.charAt(0).toUpperCase() + user.subscription.slice(1)}
                    </td>
                    <td>
                      {user.subscriptionExpiry 
                        ? new Date(user.subscriptionExpiry).toLocaleDateString('zh-TW')
                        : '永久'}
                    </td>
                    <td>
                      {new Date(user.lastUpdated).toLocaleString('zh-TW')}
                    </td>
                    <td>
                      <button 
                        className={styles.resetButton}
                        onClick={() => resetUserTokens(user.userId)}
                        disabled={resetInProgress === user.userId}
                      >
                        {resetInProgress === user.userId ? '重置中...' : '重置 Token'}
                      </button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>                  <td colSpan={8} style={{ textAlign: 'center' }}>
                    {filter ? '沒有找到符合條件的用戶' : '沒有用戶數據'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          
          <div className={styles.status}>
            上次數據更新時間: {lastRefreshTime ? lastRefreshTime.toLocaleString('zh-TW') : '未更新'}
          </div>
        </>
      )}
    </div>
  );
}
