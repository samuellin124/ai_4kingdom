import { NextRequest, NextResponse } from 'next/server';
import { DeleteCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createDynamoDBClient } from '@/app/utils/dynamodb';
import {
  AI_TOOLS_TABLE,
  canManageAiTools,
  ensureAiToolsDirectoryTable,
  getAiToolsErrorMessage,
  normalizeAiToolInput,
  scanAiTools,
  sanitizeText,
  validateAiToolInput,
} from '@/app/utils/aiToolsDirectory';
import type { AiToolRecord } from '@/app/types/aiTools';

function getRequestUserId(request: NextRequest, body?: Record<string, unknown>): string {
  return String(
    request.headers.get('x-user-id') ||
    body?.userId ||
    new URL(request.url).searchParams.get('userId') ||
    ''
  ).trim();
}

async function requireAiToolsManager(request: NextRequest, body?: Record<string, unknown>) {
  const userId = getRequestUserId(request, body);
  const allowed = await canManageAiTools(userId);
  if (!allowed) {
    return {
      userId,
      response: NextResponse.json(
        { success: false, error: '没有权限管理 AI 工具。' },
        { status: 403 }
      ),
    };
  }
  return { userId, response: null };
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAiToolsManager(request);
    if (auth.response) return auth.response;

    const { searchParams } = new URL(request.url);
    const category = sanitizeText(searchParams.get('category'), 100) || null;
    const subcategory = sanitizeText(searchParams.get('subcategory'), 100) || null;

    const tools = await scanAiTools({ category, subcategory });
    return NextResponse.json({ success: true, items: tools });
  } catch (error) {
    console.error('[AiToolsDirectory] Admin read failed:', error);
    return NextResponse.json(
      { success: false, error: getAiToolsErrorMessage(error, '载入 AI 工具') },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const auth = await requireAiToolsManager(request, body);
    if (auth.response) return auth.response;

    const input = normalizeAiToolInput(body);
    const errors = validateAiToolInput(input);
    if (errors.length) {
      return NextResponse.json({ success: false, error: errors.join(' ') }, { status: 400 });
    }

    const now = new Date().toISOString();
    const item: AiToolRecord = {
      id: crypto.randomUUID(),
      ...input,
      displayOrder: input.displayOrder ?? 0,
      status: input.status ?? 'active',
      featured: input.featured ?? false,
      createdAt: now,
      updatedAt: now,
      createdBy: auth.userId,
      updatedBy: auth.userId,
    };

    await ensureAiToolsDirectoryTable();
    const client = await createDynamoDBClient();
    await client.send(new PutCommand({ TableName: AI_TOOLS_TABLE, Item: item }));

    return NextResponse.json({ success: true, item });
  } catch (error) {
    console.error('[AiToolsDirectory] Create failed:', error);
    return NextResponse.json(
      { success: false, error: getAiToolsErrorMessage(error, '建立 AI 工具') },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const auth = await requireAiToolsManager(request, body);
    if (auth.response) return auth.response;

    const id = sanitizeText(body.id, 120);
    if (!id) {
      return NextResponse.json({ success: false, error: '缺少工具编号。' }, { status: 400 });
    }

    const input = normalizeAiToolInput(body);
    const errors = validateAiToolInput(input);
    if (errors.length) {
      return NextResponse.json({ success: false, error: errors.join(' ') }, { status: 400 });
    }

    const updatedAt = new Date().toISOString();
    await ensureAiToolsDirectoryTable();
    const client = await createDynamoDBClient();
    await client.send(
      new UpdateCommand({
        TableName: AI_TOOLS_TABLE,
        Key: { id },
        UpdateExpression:
          'set #name = :name, shortTitle = :shortTitle, description = :description, #category = :category, subcategory = :subcategory, iconUrl = :iconUrl, websiteUrl = :websiteUrl, displayOrder = :displayOrder, #status = :status, featured = :featured, updatedAt = :updatedAt, updatedBy = :updatedBy',
        ExpressionAttributeNames: {
          '#name': 'name',
          '#category': 'category',
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':name': input.name,
          ':shortTitle': input.shortTitle,
          ':description': input.description,
          ':category': input.category,
          ':subcategory': input.subcategory,
          ':iconUrl': input.iconUrl,
          ':websiteUrl': input.websiteUrl || '',
          ':displayOrder': input.displayOrder ?? 0,
          ':status': input.status ?? 'active',
          ':featured': input.featured ?? false,
          ':updatedAt': updatedAt,
          ':updatedBy': auth.userId,
        },
      })
    );

    return NextResponse.json({ success: true, item: { id, ...input, updatedAt, updatedBy: auth.userId } });
  } catch (error) {
    console.error('[AiToolsDirectory] Update failed:', error);
    return NextResponse.json(
      { success: false, error: getAiToolsErrorMessage(error, '更新 AI 工具') },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const auth = await requireAiToolsManager(request, body);
    if (auth.response) return auth.response;

    const id = sanitizeText(body.id, 120);
    if (!id) {
      return NextResponse.json({ success: false, error: '缺少工具编号。' }, { status: 400 });
    }

    await ensureAiToolsDirectoryTable();
    const client = await createDynamoDBClient();
    await client.send(new DeleteCommand({ TableName: AI_TOOLS_TABLE, Key: { id } }));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[AiToolsDirectory] Delete failed:', error);
    return NextResponse.json(
      { success: false, error: getAiToolsErrorMessage(error, '删除 AI 工具') },
      { status: 500 }
    );
  }
}
