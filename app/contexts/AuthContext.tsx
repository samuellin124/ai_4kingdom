'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';
import { FEATURE_ACCESS } from '../types/auth';
import { canUserUpload } from '../config/userPermissions';
import type { UserData, AuthState, AuthContextType, FeatureKey, MemberRole } from '../types/auth';
import type { Subscription } from '../types/auth';

const FREE_SUBSCRIPTION: Subscription = {
  status: 'active',
  type: 'free',
  expiry: null,
  plan_id: null,
  roles: ['free_member'],
};

const VALID_TYPES = ['free', 'pro', 'ultimate'] as const;

/**
 * 把 WP 端回傳的 subscription 正規化。
 * 端點壞掉或欄位缺漏時退回 free，但會留下 warning —— 先前這裡是無聲寫死成 free，
 * 導致付費會員長期拿到免費額度卻沒有任何徵兆。
 */
function normalizeSubscription(raw: unknown): Subscription {
  if (!raw || typeof raw !== 'object') {
    console.warn('[WARN] session 未回傳 subscription，暫以免費方案處理');
    return FREE_SUBSCRIPTION;
  }

  const s = raw as Partial<Subscription>;
  const type = VALID_TYPES.includes(s.type as never) ? (s.type as Subscription['type']) : 'free';

  if (s.type && type !== s.type) {
    console.warn(`[WARN] 未知的方案型別 "${s.type}"，暫以免費方案處理`);
  }

  return {
    status: s.status === 'inactive' ? 'inactive' : 'active',
    type,
    expiry: s.expiry ?? null,
    plan_id: s.plan_id ?? null,
    roles: Array.isArray(s.roles) && s.roles.length > 0 ? (s.roles as MemberRole[]) : [`${type}_member` as MemberRole],
  };
}

interface User {
  user_id: string;
  nonce?: string;
  username: string;
  email: string;
  display_name: string;
  success: boolean;
  // 直接沿用共用型別，避免這裡的內嵌定義再度和 types/auth.ts 漂移
  subscription: Subscription;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children, optional = false }: { children: React.ReactNode; optional?: boolean }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dynamicUploadPermittedUsers, setDynamicUploadPermittedUsers] = useState<string[] | null>(null);
  const isOptional = optional || process.env.NEXT_PUBLIC_AUTH_OPTIONAL === 'true';

  /**
   * 後端路徑說明：
   * - 建議主用：/wp-json/hello-biz/v1/session  (GET)
   * - 你仍可用環境變數覆蓋：NEXT_PUBLIC_WP_API_BASE
   */
  const API_BASE = process.env.NEXT_PUBLIC_PRIMARY_DOMAIN || 'https://ai4kingdom.org';
  const WP_API_BASE =
    process.env.NEXT_PUBLIC_WP_API_BASE || `${API_BASE}/wp-json/hello-biz/v1`;

  /**
   * 通用請求（預設 GET），一律帶上 Cookie
   */
  const makeRequest = async (endpoint: string, options: RequestInit = {}) => {
    const REQUEST_TIMEOUT_MS = 8000; // 加入逾時避免長時間掛起
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${WP_API_BASE}/${endpoint}`, {
        method: options.method || 'GET',
        credentials: 'include', // 🔑 讓瀏覽器攜帶 WP 登入 Cookie
        mode: 'cors',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(options.headers || {}),
        },
        body: options.body,
        signal: controller.signal,
      });

      clearTimeout(timeout); // 成功後立即清除 timeout
      
      if (!response.ok) {
        throw new Error(`API请求失败: ${response.status} ${response.statusText}`);
      }
      return response.json();
    } catch (err) {
      clearTimeout(timeout); // 錯誤時也要清除 timeout
      // 如果是 abort 錯誤，提供更友善的訊息
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('请求超时，请检查网络连接');
      }
      throw err;
    }
  };

  /**
   * 登入（可選）：若你之後提供 /login 端點即可接上
   * （若目前沒有，建議直接走 WP /wp-login.php 頁面，不必調用此函式）
   */
  const login = async (username: string, password: string): Promise<boolean> => {
    try {
      const data = await makeRequest('login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });

      if (data?.success) {
        await checkAuth();
        return true;
      }
      throw new Error(data?.message || '登录失败');
    } catch (err) {
      console.error('[ERROR] 登录失败:', err);
      setError(err instanceof Error ? err.message : '登录失败');
      setLoading(false);
      return false;
    }
  };

  /**
   * 會話檢查（關鍵）：打 /session (GET) 對應 auth.php
   * 回傳格式：{ logged_in, user:{ id, name, email } | null, subscription, nonce }
   */
  const checkAuth = async () => {
    try {
      const data = await makeRequest('session', { method: 'GET' });

      if (data?.logged_in && data?.user) {
        setUser({
          user_id: String(data.user.id),
          nonce: data.nonce,
          username: data.user.name,
          display_name: data.user.name,
          email: data.user.email,
          success: true,
          subscription: normalizeSubscription(data?.subscription),
        });
      } else {
        setUser(null);
      }
    } catch (err) {
      // 在可選模式下，靜默降級為未登入，避免噴錯干擾開發體驗
      if (isOptional) {
        console.warn('[WARN] 会话验证失败（已降級為可選）：', err);
        setUser(null);
        setError(null);
      } else {
        console.error('[ERROR] 会话验证失败:', err);
        setUser(null);
        setError(err instanceof Error ? err.message : '认证失败');
      }
    } finally {
      setLoading(false);
    }
  };

  /**
   * 登出（可選）：若你之後提供 /logout 端點即可接上
   * （或自行導向 WP /wp-login.php?action=logout 完成登出）
   */
  const logout = async () => {
    try {
      await makeRequest('logout', { method: 'POST' });
    } catch (err) {
      console.error('[ERROR] 登出失败:', err);
    } finally {
      setUser(null);
      setLoading(false);
      setError(null);
    }
  };

  // 會員狀態工具方法（保留原有對外 API）
  const getSubscriptionStatus = (): 'active' | 'inactive' => {
    return user?.subscription?.status || 'inactive';
  };

  const getSubscriptionType = (): 'free' | 'pro' | 'ultimate' => {
    return user?.subscription?.type || 'free';
  };

  const isSubscriptionValid = () => {
    const subscription = user?.subscription;
    if (!subscription) return false;
    if (subscription.status !== 'active') return false;
    if (subscription.expiry) {
      const expiryDate = new Date(subscription.expiry);
      if (expiryDate < new Date()) return false;
    }
    return true;
  };

  const hasRole = (role: MemberRole) => {
    return user?.subscription?.roles?.includes(role) || false;
  };

  const canAccessFeature = (feature: FeatureKey) => {
    const userRoles = user?.subscription?.roles || [];
    const requiredRoles = FEATURE_ACCESS[feature];
    return userRoles.some((role) => requiredRoles.includes(role));
  };

  const loadUploadPermissions = async () => {
    try {
      const res = await fetch('/api/admin/permissions', {
        method: 'GET',
        cache: 'no-store',
      });
      if (!res.ok) return;
      const data = await res.json();
      const users = Array.isArray(data?.data?.uploadPermittedUsers)
        ? data.data.uploadPermittedUsers.map((id: unknown) => String(id).trim()).filter(Boolean)
        : null;
      if (users) {
        setDynamicUploadPermittedUsers(users);
      }
    } catch (err) {
      console.warn('[WARN] 無法取得動態上傳權限，改用靜態白名單：', err);
    }
  };

  const canUploadFiles = (): boolean => {
    if (dynamicUploadPermittedUsers && user?.user_id) {
      return dynamicUploadPermittedUsers.includes(String(user.user_id));
    }
    // 動態權限尚未載入或 API 暫時失敗時，退回靜態白名單
    return canUserUpload(user?.user_id);
  };

  // 初始化檢查
  useEffect(() => {
    checkAuth();
    // 若瀏覽器封鎖第三方 Cookie，可在此嘗試 Storage Access API 再重試
    // if ('hasStorageAccess' in document && 'requestStorageAccess' in document) { ... }
  }, []);

  useEffect(() => {
    loadUploadPermissions();
  }, [user?.user_id]);

  useEffect(() => {
    const interval = setInterval(() => {
      loadUploadPermissions();
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const channel = new BroadcastChannel('permissions-updated');
    channel.onmessage = (event) => {
      if (event?.data?.type === 'UPLOAD_PERMISSIONS_UPDATED') {
        loadUploadPermissions();
      }
    };
    return () => channel.close();
  }, []);

  // 每 30 分鐘輪詢一次
  useEffect(() => {
    const sessionCheckInterval = setInterval(() => {
      checkAuth();
    }, 30 * 60 * 1000);
    return () => clearInterval(sessionCheckInterval);
  }, []);

  const value: AuthContextType = {
    user,
    loading,
    error,
    login,
    logout,
    checkAuth,
    getSubscriptionStatus,
    getSubscriptionType,
    isSubscriptionValid,
    hasRole,
    canAccessFeature,
    canUploadFiles,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
