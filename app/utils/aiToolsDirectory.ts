import {
  AttributeDefinition,
  BillingMode,
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  GlobalSecondaryIndex,
  KeySchemaElement,
} from '@aws-sdk/client-dynamodb';
import { QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { PERMISSION_GROUPS, UPLOAD_PERMITTED_USERS } from '@/app/config/userPermissions';
import { createDynamoDBClient, getDynamoDBConfig } from '@/app/utils/dynamodb';
import type { AiToolRecord, AiToolStatus, AiToolsCategoryGroup } from '@/app/types/aiTools';

export const AI_TOOLS_TABLE = process.env.AI_TOOLS_TABLE || process.env.NEXT_PUBLIC_AI_TOOLS_TABLE || 'AiToolsDirectory';

const SUNDAY_GUIDE_TABLE = process.env.NEXT_PUBLIC_SUNDAY_GUIDE_TABLE || 'SundayGuide';
const PERMISSIONS_CONFIG_ASSISTANT_ID = '__SYSTEM_PERMISSIONS__';
const PERMISSIONS_CONFIG_TYPE = 'GLOBAL_UPLOAD_PERMISSIONS';
let ensureAiToolsTablePromise: Promise<void> | null = null;

type PermissionGroups = {
  ADMINS: string[];
  EDITORS: string[];
  SPECIAL_USERS: string[];
};

export interface AiToolInput {
  name: string;
  shortTitle: string;
  description: string;
  category: string;
  subcategory: string;
  iconUrl: string;
  websiteUrl?: string;
  displayOrder?: number;
  status?: AiToolStatus;
  featured?: boolean;
}

export function sanitizeText(value: unknown, maxLength = 500): string {
  return String(value ?? '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export function normalizeUrl(value: unknown): string | undefined {
  const raw = String(value ?? '').trim();
  if (!raw) return undefined;

  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function normalizeIconUrl(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (raw.startsWith('/')) return raw;

  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return url.toString();
  } catch {
    return '';
  }
}

export function normalizeAiToolInput(input: Record<string, unknown>): AiToolInput {
  const displayOrderNumber = Number(input.displayOrder ?? 0);
  const status = input.status === 'inactive' ? 'inactive' : 'active';

  return {
    name: sanitizeText(input.name, 120),
    shortTitle: sanitizeText(input.shortTitle, 160),
    description: sanitizeText(input.description, 1000),
    category: sanitizeText(input.category, 100),
    subcategory: sanitizeText(input.subcategory, 100),
    iconUrl: normalizeIconUrl(input.iconUrl),
    websiteUrl: normalizeUrl(input.websiteUrl),
    displayOrder: Number.isFinite(displayOrderNumber) ? displayOrderNumber : 0,
    status,
    featured: Boolean(input.featured),
  };
}

export function validateAiToolInput(input: AiToolInput): string[] {
  const errors: string[] = [];
  if (!input.name) errors.push('请填写工具名称。');
  if (!input.shortTitle) errors.push('请填写简短标题。');
  if (!input.description) errors.push('请填写说明。');
  if (!input.category) errors.push('请填写分类。');
  if (!input.subcategory) errors.push('请填写子分类。');
  if (!input.iconUrl) errors.push('请上传工具图标。');
  if (input.websiteUrl === undefined && String(input.websiteUrl ?? '').trim()) {
    errors.push('网站网址必须是有效的 http 或 https 地址。');
  }
  return errors;
}

function isResourceNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.name === 'ResourceNotFoundException';
}

function createBaseDynamoDBClient() {
  const config = getDynamoDBConfig();
  return new DynamoDBClient({
    region: config.region,
    credentials: config.credentials,
  });
}

async function waitForAiToolsTable(client: DynamoDBClient) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const result = await client.send(new DescribeTableCommand({ TableName: AI_TOOLS_TABLE }));
    if (result.Table?.TableStatus === 'ACTIVE') return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function createAiToolsTableIfMissing() {
  const client = createBaseDynamoDBClient();

  try {
    await client.send(new DescribeTableCommand({ TableName: AI_TOOLS_TABLE }));
    return;
  } catch (error) {
    if (!isResourceNotFoundError(error)) throw error;
  }

  const attributeDefinitions: AttributeDefinition[] = [
    { AttributeName: 'id', AttributeType: 'S' },
    { AttributeName: 'status', AttributeType: 'S' },
    { AttributeName: 'category', AttributeType: 'S' },
  ];
  const keySchema: KeySchemaElement[] = [{ AttributeName: 'id', KeyType: 'HASH' }];
  const globalSecondaryIndexes: GlobalSecondaryIndex[] = [
    {
      IndexName: 'StatusCategoryIndex',
      KeySchema: [
        { AttributeName: 'status', KeyType: 'HASH' },
        { AttributeName: 'category', KeyType: 'RANGE' },
      ],
      Projection: { ProjectionType: 'ALL' },
    },
  ];

  try {
    await client.send(
      new CreateTableCommand({
        TableName: AI_TOOLS_TABLE,
        AttributeDefinitions: attributeDefinitions,
        KeySchema: keySchema,
        BillingMode: BillingMode.PAY_PER_REQUEST,
        GlobalSecondaryIndexes: globalSecondaryIndexes,
      })
    );
  } catch (error) {
    const alreadyExists = error instanceof Error && error.name === 'ResourceInUseException';
    if (!alreadyExists) throw error;
  }

  await waitForAiToolsTable(client);
}

export async function ensureAiToolsDirectoryTable() {
  ensureAiToolsTablePromise ||= createAiToolsTableIfMissing().finally(() => {
    ensureAiToolsTablePromise = null;
  });
  return ensureAiToolsTablePromise;
}

export function getAiToolsErrorMessage(error: unknown, action: string): string {
  if (error instanceof Error) {
    if (error.name === 'ResourceNotFoundException') {
      return `${action}失败：DynamoDB 资料表「${AI_TOOLS_TABLE}」不存在，请部署 Amplify 后台或授予 API 凭证建立资料表的权限。`;
    }
    if (error.name === 'AccessDeniedException' || error.name === 'UnrecognizedClientException') {
      return `${action}失败：DynamoDB 凭证没有操作资料表「${AI_TOOLS_TABLE}」的权限。`;
    }
    return `${action}失败：${error.message}`;
  }
  return `${action}失败。`;
}

function normalizeStringArray(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((item) => String(item ?? '').trim()).filter(Boolean))];
}

function normalizePermissionGroups(input: unknown): PermissionGroups {
  const groups = (input || {}) as Record<string, unknown>;
  return {
    ADMINS: normalizeStringArray(groups.ADMINS),
    EDITORS: normalizeStringArray(groups.EDITORS),
    SPECIAL_USERS: normalizeStringArray(groups.SPECIAL_USERS),
  };
}

async function readPermissionConfig() {
  try {
    const client = await createDynamoDBClient();
    const result = await client.send(
      new QueryCommand({
        TableName: SUNDAY_GUIDE_TABLE,
        KeyConditionExpression: 'assistantId = :assistantId',
        ExpressionAttributeValues: {
          ':assistantId': PERMISSIONS_CONFIG_ASSISTANT_ID,
        },
        ScanIndexForward: false,
        Limit: 20,
      })
    );

    const record = (result.Items || []).find((item) => item.recordType === PERMISSIONS_CONFIG_TYPE);
    if (!record) return null;

    return {
      uploadPermittedUsers: normalizeStringArray(record.uploadPermittedUsers),
      permissionGroups: normalizePermissionGroups(record.permissionGroups),
    };
  } catch (error) {
    console.warn('[AiToolsDirectory] Permission lookup failed, using static fallback.', error);
    return null;
  }
}

export async function canManageAiTools(userId: unknown): Promise<boolean> {
  const normalizedUserId = String(userId ?? '').trim();
  if (!normalizedUserId) return false;
  if (normalizedUserId === '1') return true;

  const stored = await readPermissionConfig();
  const uploadPermittedUsers = stored?.uploadPermittedUsers || UPLOAD_PERMITTED_USERS;
  const permissionGroups = stored?.permissionGroups || PERMISSION_GROUPS;
  const assignedUsers = new Set([
    ...uploadPermittedUsers,
    ...permissionGroups.ADMINS,
    ...permissionGroups.EDITORS,
    ...permissionGroups.SPECIAL_USERS,
  ].map(String));

  return assignedUsers.has(normalizedUserId);
}

export function sortAiTools(tools: AiToolRecord[]): AiToolRecord[] {
  return [...tools].sort((a, b) => {
    const category = a.category.localeCompare(b.category, 'zh-Hant');
    if (category) return category;
    const subcategory = a.subcategory.localeCompare(b.subcategory, 'zh-Hant');
    if (subcategory) return subcategory;
    const order = (a.displayOrder ?? 0) - (b.displayOrder ?? 0);
    if (order) return order;
    return new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
  });
}

export function groupAiTools(tools: AiToolRecord[]): AiToolsCategoryGroup[] {
  const categories = new Map<string, Map<string, AiToolRecord[]>>();

  for (const tool of sortAiTools(tools)) {
    if (!categories.has(tool.category)) {
      categories.set(tool.category, new Map());
    }
    const subcategories = categories.get(tool.category)!;
    if (!subcategories.has(tool.subcategory)) {
      subcategories.set(tool.subcategory, []);
    }
    subcategories.get(tool.subcategory)!.push(tool);
  }

  return Array.from(categories.entries()).map(([name, subcategoryMap]) => ({
    name,
    subcategories: Array.from(subcategoryMap.entries()).map(([subcategoryName, subcategoryTools]) => ({
      name: subcategoryName,
      tools: subcategoryTools,
    })),
  }));
}

export async function scanAiTools(options: {
  activeOnly?: boolean;
  category?: string | null;
  subcategory?: string | null;
} = {}): Promise<AiToolRecord[]> {
  const client = await createDynamoDBClient();
  const filters: string[] = [];
  const values: Record<string, unknown> = {};
  const names: Record<string, string> = {};

  if (options.activeOnly) {
    filters.push('#status = :status');
    names['#status'] = 'status';
    values[':status'] = 'active';
  }

  if (options.category) {
    filters.push('#category = :category');
    names['#category'] = 'category';
    values[':category'] = options.category;
  }

  if (options.subcategory) {
    filters.push('#subcategory = :subcategory');
    names['#subcategory'] = 'subcategory';
    values[':subcategory'] = options.subcategory;
  }

  let result;
  try {
    result = await client.send(
      new ScanCommand({
        TableName: AI_TOOLS_TABLE,
        ...(filters.length ? { FilterExpression: filters.join(' AND ') } : {}),
        ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
        ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
      })
    );
  } catch (error) {
    if (isResourceNotFoundError(error)) return [];
    throw error;
  }

  return sortAiTools((result.Items || []) as AiToolRecord[]);
}
