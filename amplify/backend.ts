import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource';
import { secret } from '@aws-amplify/backend';
import { RemovalPolicy } from 'aws-cdk-lib';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';

const backend = defineBackend({
  auth
});

const aiToolsStack = backend.createStack('ai-tools-directory');
const aiToolsDirectoryTable = new Table(aiToolsStack, 'AiToolsDirectoryTable', {
  tableName: 'AiToolsDirectory',
  partitionKey: {
    name: 'id',
    type: AttributeType.STRING,
  },
  billingMode: BillingMode.PAY_PER_REQUEST,
  removalPolicy: RemovalPolicy.RETAIN,
});

aiToolsDirectoryTable.addGlobalSecondaryIndex({
  indexName: 'StatusCategoryIndex',
  partitionKey: {
    name: 'status',
    type: AttributeType.STRING,
  },
  sortKey: {
    name: 'category',
    type: AttributeType.STRING,
  },
});

backend.addOutput({
  custom: {
    aiToolsDirectoryTableName: aiToolsDirectoryTable.tableName,
  },
});

// 定义 OpenAI 相关的密钥
export const openaiApiKey = secret('OPENAI_API_KEY');
export const openaiOrgId = secret('OPENAI_ORG_ID');

export const awsAccessKey = secret('AWS_ACCESS_KEY');
export const awsSecretKey = secret('AWS_SECRET_KEY');

export default backend;
