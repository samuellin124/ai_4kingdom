import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { NextResponse } from "next/server";
import type { Subscription } from '../../types/auth';
import { getDynamoDBConfig } from "@/app/utils/dynamodb";

// 定义使用限制
interface UsageLimit {
  [key: string]: number;
  free: number;
  pro: number;
  ultimate: number;
}

const WEEKLY_LIMITS: UsageLimit = {
  free: 10,
  pro: 100,
  ultimate: Infinity
};

// 获取用户订阅信息
// 修改返回類型，始終返回 Subscription 而不是 null
async function getUserSubscription(userId: string): Promise<Subscription> {
  try {
    // 在伺服器端 API 路由中不使用 credentials: 'include'，因為沒有用户瀏覽器 cookies
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
      // 如果是 401 或 403 錯誤，可能是認證問題
      if (response.status === 401 || response.status === 403) {
        // 返回一個預設的免費訂閱，而不是 null
        return {
          status: 'active',
          type: 'free',
          expiry: null,
          plan_id: null,
          roles: ['free_member']
        };
      }
      throw new Error(`Failed to fetch subscription info: ${response.status}`);
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
    console.error(`[ERROR] 获取用户 ${userId} 订阅信息失败:`, error);
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

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const userId = searchParams.get("userId");

  if (!userId) {
    return NextResponse.json({ error: "UserId is required" }, { status: 400 });
  }
  try {
    console.log('[DEBUG] Starting usage check for userId:', userId);    // 获取用户订阅信息
    const subscription = await getUserSubscription(userId);
    console.log('[DEBUG] User subscription:', {
      userId,
      status: subscription.status,
      type: subscription.type,
      roles: subscription.roles,
      // 添加一個標記，標明是否使用了默認訂閱
      isDefault: !subscription.plan_id || subscription.plan_id === null
    });

    // 由於我們修改了 getUserSubscription 函數，它總是會返回一個訂閱（至少是免費的）
    // 所以只需檢查訂閱狀態
    if (subscription.status !== 'active') {
      return NextResponse.json({
        error: "Inactive subscription",
        subscription,
        weeklyLimit: WEEKLY_LIMITS.free,
        weeklyCount: 0
      }, { status: 403 });
    }

    // 获取本周使用次数
    const dbConfig = await getDynamoDBConfig();
    const client = new DynamoDBClient(dbConfig);
    const docClient = DynamoDBDocumentClient.from(client);

    // 获取本周开始时间
    const now = new Date();
    const startOfWeek = new Date(now.setDate(now.getDate() - now.getDay()));
    startOfWeek.setHours(0, 0, 0, 0);

    const command = new QueryCommand({
      TableName: "ChatHistory",
      KeyConditionExpression: "UserId = :userId AND Timestamp >= :startTime",
      ExpressionAttributeValues: {
        ":userId": String(userId),
        ":startTime": startOfWeek.toISOString()
      }
    });

    const response = await docClient.send(command);
    const weeklyCount = response.Items?.length || 0;    // 获取用户类型对应的使用限制
    // 由於 subscription 總是可用，不再需要可選鏈運算符
    const subscriptionType = subscription.type.toLowerCase();
    const weeklyLimit = WEEKLY_LIMITS[subscriptionType as keyof UsageLimit] || WEEKLY_LIMITS.free;

    // 添加角色检查
    const hasRequiredRole = subscription.roles.some(role => 
      ['free_member', 'pro_member', 'ultimate_member'].includes(role)
    );

    if (!hasRequiredRole) {
      return NextResponse.json({
        error: "Insufficient permissions",
        subscription,
        weeklyLimit: WEEKLY_LIMITS.free,
        weeklyCount: 0
      }, { status: 403 });
    }

    console.log('[DEBUG] Usage stats:', {
      weeklyCount,
      weeklyLimit,
      subscriptionType,
      remaining: weeklyLimit - weeklyCount
    });

    return NextResponse.json({
      weeklyCount,
      weeklyLimit,
      subscription,
      remaining: weeklyLimit - weeklyCount,
      debug: {
        timestamp: new Date().toISOString(),
        startOfWeek: startOfWeek.toISOString()
      }
    });

  } catch (error) {
    console.error('[ERROR] Usage check failed:', {
      message: error instanceof Error ? error.message : 'Unknown error',
      userId
    });

    return NextResponse.json({
      error: "Failed to fetch usage count",
      details: error instanceof Error ? error.message : '未知错误',
      debug: {
        timestamp: new Date().toISOString(),
        errorType: error instanceof Error ? error.name : 'Unknown'
      }
    }, { status: 500 });
  }
} 