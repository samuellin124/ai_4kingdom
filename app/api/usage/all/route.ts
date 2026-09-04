import { NextResponse } from 'next/server';
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { getDynamoDBConfig } from "@/app/utils/dynamodb";
import type { Subscription } from '@/app/types/auth';
import { TOKEN_LIMITS, TOKEN_TO_CREDIT_RATIO } from '@/app/config/plans';

// 獲取用戶訂閱信息
async function getUserSubscription(userId: string): Promise<Subscription> {
  try {
    // 移除 credentials: 'include'，因為在伺服器端 API 中沒有瀏覽器 cookies
    const response = await fetch(
      `${process.env.WP_API_BASE || process.env.NEXT_PUBLIC_WP_API_BASE || 'https://ai4kingdom.org/wp-json/custom/v1'}/validate_session`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // 伺服器對伺服器查詢他人方案需帶 service token，WP 端才會受理 userId。
          ...(process.env.WP_SERVICE_TOKEN
            ? { 'X-A4K-Service-Token': process.env.WP_SERVICE_TOKEN }
            : {})
        },
        body: JSON.stringify({ userId })
      }
    );

    if (!response.ok) {
      console.error(`[ERROR] Failed to fetch subscription info for user ${userId}, status: ${response.status}`);
      // 返回一個預設的免費訂閱，而不是 null
      return {
        status: 'active',
        type: 'free',
        expiry: null,
        plan_id: null,
        roles: ['free_member']
      };
    }

    const data = await response.json();
    if (!data.subscription) {
      console.warn(`[WARN] No subscription info returned for user ${userId}, using default free subscription`);
      // 如果沒有訂閱信息，返回一個預設的免費訂閱
      return {
        status: 'active',
        type: 'free',
        expiry: null,
        plan_id: null,
        roles: ['free_member']
      };
    }
    return data.subscription;
  } catch (error) {
    console.error(`[ERROR] 獲取用戶 ${userId} 訂閱信息失敗:`, error);
    // 發生錯誤時，返回一個預設的免費訂閱，而不是 null
    return {
      status: 'active',
      type: 'free',
      expiry: null,
      plan_id: null,
      roles: ['free_member']
    };
  }
}

// 獲取所有用戶的 token 使用情況
export async function GET(request: Request) {
  try {
    // 獲取當前年月
    const now = new Date();
    const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    
    // 連接 DynamoDB
    const config = await getDynamoDBConfig();
    const client = new DynamoDBClient(config);
    const docClient = DynamoDBDocumentClient.from(client);
    
    // 掃描 MonthlyTokenUsage 表格獲取所有用戶的當月使用量
    const scanCommand = new ScanCommand({
      TableName: "MonthlyTokenUsage",
      FilterExpression: "YearMonth = :yearMonth",
      ExpressionAttributeValues: {
        ":yearMonth": yearMonth
      }
    });
    
    const monthlyResponse = await docClient.send(scanCommand);
    const monthlyUsageData = monthlyResponse.Items || [];
    
    // 同時掃描所有歷史使用記錄來獲取所有用戶 ID
    const allUsersCommand = new ScanCommand({
      TableName: "MonthlyTokenUsage",
      ProjectionExpression: "UserId"
    });
    
    const allUsersResponse = await docClient.send(allUsersCommand);
    const allUserIds = [...new Set((allUsersResponse.Items || []).map(item => item.UserId))];
    
    console.log('[DEBUG] 找到的所有用戶 ID:', allUserIds);
    console.log('[DEBUG] 當月有使用記錄的用戶:', monthlyUsageData.map(item => item.UserId));
    
    // 為每個找到的用戶 ID 創建使用記錄（包括本月沒有使用的用戶）
    const enrichedUsageData = await Promise.all(allUserIds.map(async (userId) => {
      // 查找該用戶的當月使用記錄
      const userMonthlyData = monthlyUsageData.find(item => item.UserId === userId);
      
      // 嘗試獲取用戶訂閱信息
      const subscription = await getUserSubscription(userId);
      console.log('[DEBUG] User subscription for aggregated usage data:', {
        userId,
        status: subscription.status,
        type: subscription.type,
        isDefault: !subscription.plan_id || subscription.plan_id === null
      });
      
      // getUserSubscription 現在總是會返回有效的訂閱，所以不需要使用可選鏈運算符
      const subscriptionType = subscription.type.toLowerCase();
      const tokenLimit = TOKEN_LIMITS[subscriptionType as keyof typeof TOKEN_LIMITS] || TOKEN_LIMITS.free;
      
      // 如果用戶有當月使用記錄，使用實際數據；否則使用默認值（0使用量）
      const totalTokens = userMonthlyData?.totalTokens || 0;
      const promptTokens = userMonthlyData?.promptTokens || 0;
      const completionTokens = userMonthlyData?.completionTokens || 0;
      const retrievalTokens = userMonthlyData?.retrievalTokens || 0;
      const lastUpdated = userMonthlyData?.lastUpdated || new Date().toISOString();
      
      // 根據用戶訂閱類型計算 token 額度
      return {
        userId,
        totalTokens,
        promptTokens,
        completionTokens,
        retrievalTokens,
        yearMonth,
        lastUpdated,
        subscription: subscriptionType,
        subscriptionExpiry: subscription.expiry || null,
        remainingTokens: Math.max(0, tokenLimit - totalTokens),
        totalCredits: Math.floor(tokenLimit / TOKEN_TO_CREDIT_RATIO),
        remainingCredits: Math.floor(Math.max(0, tokenLimit - totalTokens) / TOKEN_TO_CREDIT_RATIO)
      };
    }));
    
    return NextResponse.json({
      success: true,
      usage: enrichedUsageData,
      yearMonth
    });
  } catch (error) {
    console.error('[ERROR] 獲取所有用戶 token 使用情況失敗:', error);
    return NextResponse.json({
      error: '獲取用戶使用情況失敗',
      details: error instanceof Error ? error.message : '未知錯誤'
    }, { status: 500 });
  }
}
