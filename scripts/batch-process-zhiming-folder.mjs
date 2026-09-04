import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import OpenAI from 'openai';
import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, extname, join, resolve } from 'path';

const DEFAULT_FOLDER = 'C:\\Users\\hsian\\Desktop\\GPTs\\陸博士\\Ai4kingdom\\遠志明牧師\\耶稣颂其他课程';
const ZHIMING_VECTOR_STORE_ID = 'vs_699d07be23448191b874b7653f8c7829';
const PROCESSING_ASSISTANT_ID = 'asst_4QKJubuGno3Rw4iALWHExIh4';
const UNIT_ID = 'zhiming-yuan';
const USER_ID = 'batch-script';
const PROGRESS_FILE = resolve(process.cwd(), 'scripts', 'zhiming-yuan-folder-batch-progress.json');

const argv = process.argv.slice(2);
const RUN = argv.includes('--run');
const FORCE = argv.includes('--force');
const folderArg = readArg('--folder') || DEFAULT_FOLDER;
const fileArg = readArg('--file');
const limitArg = readArg('--limit');
const fromArg = readArg('--from');
const LIMIT = limitArg ? Math.max(1, Number.parseInt(limitArg, 10)) : null;
const FROM = fromArg ? Math.max(0, Number.parseInt(fromArg, 10) - 1) : 0;

loadEnv();

const SUNDAY_GUIDE_TABLE = process.env.NEXT_PUBLIC_SUNDAY_GUIDE_TABLE || process.env.SUNDAY_GUIDE_TABLE_NAME || 'SundayGuide';
const AI_PROMPTS_TABLE = process.env.NEXT_PUBLIC_AI_PROMPTS_TABLE || 'AIPrompts';
const REGION = process.env.NEXT_PUBLIC_REGION || 'us-east-2';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  organization: process.env.OPENAI_ORG_ID || undefined,
  project: process.env.OPENAI_PROJECT || undefined,
});

const dynamo = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    region: REGION,
    credentials: {
      accessKeyId: process.env.NEXT_PUBLIC_ACCESS_KEY_ID,
      secretAccessKey: process.env.NEXT_PUBLIC_SECRET_ACCESS_KEY,
    },
  }),
  { marshallOptions: { removeUndefinedValues: true } }
);

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function readArg(name) {
  const eq = argv.find((arg) => arg.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const idx = argv.indexOf(name);
  return idx >= 0 ? argv[idx + 1] : null;
}

function loadEnv() {
  const envPath = resolve(process.cwd(), '.env.local');
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const idx = trimmed.indexOf('=');
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
}

function loadProgress() {
  if (!existsSync(PROGRESS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(PROGRESS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveProgress(progress) {
  writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2), 'utf8');
}

function listLocalPdfs(folder) {
  if (!existsSync(folder)) {
    throw new Error(`Folder does not exist: ${folder}`);
  }

  return readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.pdf')
    .map((entry) => {
      const fullPath = join(folder, entry.name);
      const buffer = readFileSync(fullPath);
      return {
        fileName: entry.name,
        path: fullPath,
        bytes: buffer.byteLength,
        sha256: createHash('sha256').update(buffer).digest('hex'),
      };
    })
    .sort((a, b) => a.fileName.localeCompare(b.fileName, 'zh-Hans-u-kn-true'));
}

async function scanAll(params) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const result = await dynamo.send(new ScanCommand({ ...params, ExclusiveStartKey }));
    items.push(...(result.Items || []));
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function getExistingDynamoRecords() {
  const items = await scanAll({
    TableName: SUNDAY_GUIDE_TABLE,
    FilterExpression: 'unitId = :unitId',
    ExpressionAttributeValues: { ':unitId': UNIT_ID },
  });

  return new Map(
    items
      .filter((item) => item.fileName)
      .map((item) => [String(item.fileName), item])
  );
}

async function getVectorStoreFileNames() {
  const rows = [];
  let page = await openai.vectorStores.files.list(ZHIMING_VECTOR_STORE_ID, { limit: 100 });
  rows.push(...page.data);
  while (page.hasNextPage()) {
    page = await page.getNextPage();
    rows.push(...page.data);
  }

  const names = new Map();
  for (const row of rows) {
    try {
      const file = await openai.files.retrieve(row.id);
      names.set(file.filename, { fileId: row.id, status: row.status });
    } catch {
      names.set(row.id, { fileId: row.id, status: row.status });
    }
  }
  return names;
}

async function getPrompt(promptId) {
  try {
    const queried = await dynamo.send(new QueryCommand({
      TableName: AI_PROMPTS_TABLE,
      KeyConditionExpression: 'id = :id',
      ExpressionAttributeValues: { ':id': promptId },
    }));
    const content = queried.Items?.[0]?.content;
    if (typeof content === 'string' && content.trim().length > 20) return content.trim();
  } catch {
    const scanned = await dynamo.send(new ScanCommand({
      TableName: AI_PROMPTS_TABLE,
      FilterExpression: 'id = :id',
      ExpressionAttributeValues: { ':id': promptId },
    }));
    const content = scanned.Items?.[0]?.content;
    if (typeof content === 'string' && content.trim().length > 20) return content.trim();
  }

  throw new Error(`Missing prompt in ${AI_PROMPTS_TABLE}: ${promptId}`);
}

async function getPrompts() {
  const [summary, devotional, bibleStudy] = await Promise.all([
    getPrompt('summary'),
    getPrompt('devotional'),
    getPrompt('bibleStudy'),
  ]);
  return { summary, devotional, bibleStudy };
}

async function waitForVectorFile(fileId, timeoutMs = 120000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const row = await openai.vectorStores.files.retrieve(fileId, { vector_store_id: ZHIMING_VECTOR_STORE_ID });
    if (row.status === 'completed') return;
    if (row.status === 'failed') {
      throw new Error(`Vector store indexing failed for ${fileId}: ${row.last_error?.message || 'unknown error'}`);
    }
    await sleep(2000);
  }
  throw new Error(`Timed out waiting for vector store indexing: ${fileId}`);
}

async function uploadPdf(localFile, existingVectorFiles) {
  const existing = existingVectorFiles.get(localFile.fileName);
  if (existing && existing.status === 'completed' && !FORCE) {
    return { fileId: existing.fileId, reused: true };
  }

  const buffer = readFileSync(localFile.path);
  const file = new File([buffer], localFile.fileName, { type: 'application/pdf' });
  const uploaded = await openai.files.create({ file, purpose: 'assistants' });
  await openai.vectorStores.files.create(ZHIMING_VECTOR_STORE_ID, {
    file_id: uploaded.id,
    attributes: { sgFileId: uploaded.id, docType: 'source' }, // 供 Chat 依「選定講章」過濾
  });
  await waitForVectorFile(uploaded.id);
  existingVectorFiles.set(localFile.fileName, { fileId: uploaded.id, status: 'completed' });
  return { fileId: uploaded.id, reused: false };
}

async function putPendingRecord(localFile, fileId) {
  const now = new Date().toISOString();
  await dynamo.send(new PutCommand({
    TableName: SUNDAY_GUIDE_TABLE,
    Item: {
      assistantId: PROCESSING_ASSISTANT_ID,
      Timestamp: now,
      vectorStoreId: ZHIMING_VECTOR_STORE_ID,
      fileId,
      fileName: localFile.fileName,
      fileSize: localFile.bytes,
      fileType: 'application/pdf',
      sha256: localFile.sha256,
      unitId: UNIT_ID,
      userId: USER_ID,
      uploadedBy: USER_ID,
      uploadTimestamp: now,
      updatedAt: now,
      generationStatus: 'processing',
      completed: false,
      attemptCount: 1,
      accessType: 'public',
      batchSourcePath: localFile.path,
    },
  }));
  return now;
}

// 解析批次助手的 model/instructions（Assistants API 日落後改用環境變數/預設值）
let _profile = null;
async function resolveProfile() {
  if (_profile) return _profile;
  try {
    const a = await openai.beta.assistants.retrieve(PROCESSING_ASSISTANT_ID);
    _profile = { model: a.model, instructions: a.instructions || undefined };
  } catch {
    _profile = { model: process.env.OPENAI_RESPONSES_MODEL || 'gpt-5.6-terra', instructions: undefined };
  }
  return _profile;
}

async function generateContent({ fileName, type, prompt, summaryText }) {
  const profile = await resolveProfile();
  const input = [];
  if (type !== 'summary' && summaryText) {
    input.push({
      role: 'user',
      content: `Here is the sermon summary already generated. Use it to preserve the same scripture priority and structure:\n\n${summaryText}`,
    });
  }
  input.push({
    role: 'user',
    content: `Please process only the document named "${fileName}".\n\n${prompt}`,
  });

  const tokenLimits = { summary: 8000, devotional: 16000, bibleStudy: 14000 };
  const response = await openai.responses.create({
    model: profile.model,
    input,
    tools: [{ type: 'file_search', vector_store_ids: [ZHIMING_VECTOR_STORE_ID] }],
    tool_choice: 'required',
    max_output_tokens: tokenLimits[type] || 12000,
    // gpt-5.6-terra 僅接受預設 temperature/top_p，故不再傳入
    instructions: [
      'STRICT MODE:',
      `Only use the single document named "${fileName}".`,
      'Follow the exact structure requested by the prompt.',
      'If uncertain, omit rather than invent.',
    ].join('\n'),
    store: false,
  });

  if (response.status && response.status !== 'completed') {
    throw new Error(`${type} generation ended with status ${response.status}`);
  }

  const content = (response.output_text || '').trim();

  if (!content || content.length < 50 || content.includes('[MISSING]')) {
    throw new Error(`${type} generation returned invalid or too-short content`);
  }
  return content;
}

async function extractTitle(summary, fileName) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-5.6-terra',
      // gpt-5.6-terra 為推理模型：max_tokens 改用 max_completion_tokens，不支援 temperature；機械式抽取關閉推理。
      max_completion_tokens: 200,
      reasoning_effort: 'none',
      messages: [{
        role: 'user',
        content: `Extract a short Chinese sermon/course title from this summary. Return only the title.\nFile name: ${fileName}\n\n${summary.slice(0, 900)}`,
      }],
    });
    return response.choices[0]?.message?.content?.trim()?.slice(0, 80) || fileName.replace(/\.pdf$/i, '');
  } catch {
    return fileName.replace(/\.pdf$/i, '');
  }
}

async function uploadGeneratedTxt(baseName, type, content, sgFileId) {
  const safeBase = baseName.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
  const file = new File([content], `${safeBase}_${type}.txt`, { type: 'text/plain' });
  const uploaded = await openai.files.create({ file, purpose: 'assistants' });
  await openai.vectorStores.files.create(ZHIMING_VECTOR_STORE_ID, {
    file_id: uploaded.id,
    ...(sgFileId ? { attributes: { sgFileId, docType: type } } : {}),
  });
  await waitForVectorFile(uploaded.id);
  return uploaded.id;
}

async function updateCompleted(timestamp, fields) {
  await dynamo.send(new UpdateCommand({
    TableName: SUNDAY_GUIDE_TABLE,
    Key: { assistantId: PROCESSING_ASSISTANT_ID, Timestamp: timestamp },
    UpdateExpression: [
      'SET summary = :summary',
      'devotional = :devotional',
      'bibleStudy = :bibleStudy',
      'sermonTitle = :sermonTitle',
      'generatedFileIds = :generatedFileIds',
      'generationStatus = :generationStatus',
      'completed = :completed',
      'processingTime = :processingTime',
      'updatedAt = :updatedAt',
    ].join(', '),
    ExpressionAttributeValues: {
      ':summary': fields.summary,
      ':devotional': fields.devotional,
      ':bibleStudy': fields.bibleStudy,
      ':sermonTitle': fields.sermonTitle,
      ':generatedFileIds': fields.generatedFileIds,
      ':generationStatus': 'completed',
      ':completed': true,
      ':processingTime': fields.processingTime,
      ':updatedAt': new Date().toISOString(),
    },
  }));
}

async function markFailed(timestamp, error) {
  await dynamo.send(new UpdateCommand({
    TableName: SUNDAY_GUIDE_TABLE,
    Key: { assistantId: PROCESSING_ASSISTANT_ID, Timestamp: timestamp },
    UpdateExpression: 'SET generationStatus = :status, completed = :completed, lastError = :error, updatedAt = :updatedAt',
    ExpressionAttributeValues: {
      ':status': 'failed',
      ':completed': false,
      ':error': error.message || String(error),
      ':updatedAt': new Date().toISOString(),
    },
  }));
}

async function processOne(localFile, prompts, existingVectorFiles) {
  const started = Date.now();
  const upload = await uploadPdf(localFile, existingVectorFiles);
  const timestamp = await putPendingRecord(localFile, upload.fileId);

  try {
    const summary = await generateContent({
      fileName: localFile.fileName,
      type: 'summary',
      prompt: prompts.summary,
    });

    const [devotional, bibleStudy] = await Promise.all([
      generateContent({
        fileName: localFile.fileName,
        type: 'devotional',
        prompt: prompts.devotional,
        summaryText: summary,
      }),
      generateContent({
        fileName: localFile.fileName,
        type: 'bibleStudy',
        prompt: prompts.bibleStudy,
        summaryText: summary,
      }),
    ]);

    const sermonTitle = await extractTitle(summary, localFile.fileName);
    const baseName = sermonTitle || basename(localFile.fileName, '.pdf');
    const generatedFileIds = [];
    generatedFileIds.push(await uploadGeneratedTxt(baseName, 'summary', summary, upload.fileId));
    generatedFileIds.push(await uploadGeneratedTxt(baseName, 'devotional', devotional, upload.fileId));
    generatedFileIds.push(await uploadGeneratedTxt(baseName, 'bibleStudy', bibleStudy, upload.fileId));

    await updateCompleted(timestamp, {
      summary,
      devotional,
      bibleStudy,
      sermonTitle,
      generatedFileIds,
      processingTime: Date.now() - started,
    });

    return { fileId: upload.fileId, generatedFileIds, reusedUpload: upload.reused };
  } catch (error) {
    await markFailed(timestamp, error);
    throw error;
  }
}

async function main() {
  if (!process.env.OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY');
  if (!process.env.NEXT_PUBLIC_ACCESS_KEY_ID || !process.env.NEXT_PUBLIC_SECRET_ACCESS_KEY) {
    throw new Error('Missing AWS credentials in .env.local');
  }

  let localFiles = listLocalPdfs(folderArg);
  if (fileArg) localFiles = localFiles.filter((file) => file.fileName === fileArg);
  if (FROM > 0) localFiles = localFiles.slice(FROM);
  if (LIMIT) localFiles = localFiles.slice(0, LIMIT);

  const progress = loadProgress();
  const [dynamoRecords, vectorFiles] = await Promise.all([
    getExistingDynamoRecords(),
    getVectorStoreFileNames(),
  ]);

  const candidates = localFiles.map((file) => {
    const dynamoRecord = dynamoRecords.get(file.fileName);
    const vectorRecord = vectorFiles.get(file.fileName);
    const completed = dynamoRecord?.generationStatus === 'completed' && dynamoRecord?.completed === true;
    const progressDone = progress[file.fileName]?.status === 'completed';
    const skip = !FORCE && (completed || progressDone);
    return { ...file, dynamoRecord, vectorRecord, completed, progressDone, skip };
  });

  console.log(JSON.stringify({
    mode: RUN ? 'run' : 'dry-run',
    folder: folderArg,
    assistantId: PROCESSING_ASSISTANT_ID,
    vectorStoreId: ZHIMING_VECTOR_STORE_ID,
    unitId: UNIT_ID,
    table: SUNDAY_GUIDE_TABLE,
    localPdfCount: localFiles.length,
    toProcess: candidates.filter((item) => !item.skip).length,
    skipped: candidates.filter((item) => item.skip).length,
  }, null, 2));

  for (const [idx, item] of candidates.entries()) {
    const status = item.skip ? 'skip' : 'process';
    const reason = item.completed ? 'dynamo-completed' : item.progressDone ? 'progress-completed' : item.vectorRecord ? 'uploaded-not-completed' : 'new';
    console.log(`${String(idx + 1).padStart(3, '0')}. [${status}] ${item.fileName} (${item.bytes} bytes, ${reason})`);
  }

  if (!RUN) {
    console.log('\nDry-run only. Add --run to upload/process. Start with --run --limit 1 for the smoke test.');
    return;
  }

  const prompts = await getPrompts();
  const stats = { completed: 0, skipped: 0, failed: 0 };

  for (const [idx, item] of candidates.entries()) {
    if (item.skip) {
      stats.skipped += 1;
      continue;
    }

    console.log(`\n[${idx + 1}/${candidates.length}] Processing ${item.fileName}`);
    progress[item.fileName] = { status: 'processing', updatedAt: new Date().toISOString() };
    saveProgress(progress);

    try {
      const result = await processOne(item, prompts, vectorFiles);
      progress[item.fileName] = {
        status: 'completed',
        fileId: result.fileId,
        generatedFileIds: result.generatedFileIds,
        reusedUpload: result.reusedUpload,
        updatedAt: new Date().toISOString(),
      };
      stats.completed += 1;
      console.log(`Completed ${item.fileName}`);
    } catch (error) {
      progress[item.fileName] = {
        status: 'failed',
        error: error.message || String(error),
        updatedAt: new Date().toISOString(),
      };
      stats.failed += 1;
      console.error(`Failed ${item.fileName}: ${error.message || String(error)}`);
    }
    saveProgress(progress);
    await sleep(1000);
  }

  console.log('\nBatch result:', stats);
  console.log(`Progress file: ${PROGRESS_FILE}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
