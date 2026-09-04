/**
 * 批次處理腳本：遠志明神學問答集 PDF → 生成 Summary / Devotional / BibleStudy → TXT → 上傳 Vector Store
 *
 * 用法：
 *   node scripts/batch-process-zhiming-yuan.mjs              # 執行全批次
 *   node scripts/batch-process-zhiming-yuan.mjs --dry-run    # 只列清單，不呼叫 AI
 *   node scripts/batch-process-zhiming-yuan.mjs --force      # 強制重跑已完成的項目
 *   node scripts/batch-process-zhiming-yuan.mjs --file "001-1.1 愛是自然的本質.pdf"  # 只跑單一檔案
 *   node scripts/batch-process-zhiming-yuan.mjs --from 10   # 從第 10 個 PDF 開始
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import OpenAI from 'openai';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// ── 載入 .env.local ───────────────────────────────────────────────────────────
const envPath = resolve(process.cwd(), '.env.local');
const envVars = readFileSync(envPath, 'utf-8')
  .split('\n')
  .filter(l => l.trim() && !l.startsWith('#'))
  .reduce((acc, l) => {
    const eqIdx = l.indexOf('=');
    if (eqIdx < 0) return acc;
    acc[l.slice(0, eqIdx).trim()] = l.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    return acc;
  }, {});
Object.assign(process.env, envVars);

// ── 常數 ──────────────────────────────────────────────────────────────────────
const ZHIMING_VS_ID      = 'vs_699d07be23448191b874b7653f8c7829';  // 遠志明神學問答集
const ZHIMING_UNIT_ID    = 'zhiming-yuan';
// 遠志明神學問答集專用助手（獨立）
const BATCH_ASSISTANT_ID = 'asst_syEv0z4BpjKRsk4VVlxOeoeb';
const SUNDAY_GUIDE_TABLE = process.env.NEXT_PUBLIC_SUNDAY_GUIDE_TABLE || 'SundayGuide';
const PROGRESS_FILE      = resolve(process.cwd(), 'scripts', 'zhiming-yuan-batch-progress.json');

const POLL_INTERVAL_MS = 4000;  // 4 秒輪詢間隔（與 process-document/route.ts 一致）
const MAX_POLLS        = 25;    // 最多等 100 秒
const MAX_RETRIES      = 2;
const THROTTLE_MS      = 2000;  // 每個 PDF 完成後等待 2 秒

// ── CLI 參數解析 ──────────────────────────────────────────────────────────────
const argv     = process.argv.slice(2);
const DRY_RUN  = argv.includes('--dry-run');
const FORCE    = argv.includes('--force');
const fileArg  = argv.find(a => a.startsWith('--file='))?.slice(7)
              || (argv.includes('--file') ? argv[argv.indexOf('--file') + 1] : null);
const fromArg  = argv.find(a => a.startsWith('--from='))?.slice(7)
              || (argv.includes('--from') ? argv[argv.indexOf('--from') + 1] : null);
const FROM_IDX = fromArg ? Math.max(0, parseInt(fromArg, 10) - 1) : 0;

// ── 遠志明專屬 Prompts ────────────────────────────────────────────────────────
const PROMPTS = {
  summary: `請根據這篇遠志明「耶穌頌」神學課程文章，生成一份結構化的信息總結。

要求：
1. 文章主題與核心論點（2-3 段，100-150 字）
2. 主要神學觀點（條列，3-5 點，每點 40-80 字）
3. 關鍵聖經依據（列出文中引用的主要經節，含完整經文，3-5 節）
4. 信仰應用（實際生活層面的反思，100-150 字）

總字數 800-1200 字。語氣忠實反映遠志明的神學風格：以恩典為本、道成肉身的愛、個人見證。
請確保內容完整、格式清晰。`,

  devotional: `根據此篇遠志明「耶穌頌」文章內容，生成 7 天靈修指引（週一至週日）。

每天必須包含：
a) 主題標題（5-10 字）
b) 文章相關核心思想摘要（80-120 字）
c) 今日靈修重點（150-200 字，深刻但平易近人）
d) 相關聖經經文（2-3 節，含完整經文，標注出處）
e) 禱告引導（80-100 字）

語氣：溫暖、個人化、適合安靜默想。
總字數 2500-3500 字。每天內容相互銜接，形成一週完整的靈修旅程。`,

  bibleStudy: `根據此篇遠志明「耶穌頌」文章，生成一份小組查經指引。

必須包含以下完整結構：
1. 背景介紹（此文在耶穌頌系列的位置與核心主題，100-150 字）
2. 主要聖經段落（3-5 節，含完整經文與簡要釋義）
3. 破冰問題（1 個，輕鬆引入主題）
4. 深入討論問題（3 個，由觀察→解釋→應用遞進，各含引導提示）
5. 個人應用挑戰（1-2 個具體行動）
6. 禱告方向（100 字）
7. 推薦詩歌（2-3 首，來自讚美之泉、小羊詩歌或迦南詩選，與主題相關）

適合 60-90 分鐘小組使用。總字數 1800-2500 字。`
};

// 生成內容中視為「失敗」的關鍵字（與 process-document/route.ts 相同）
const FAILURE_PHRASES = [
  '無法直接訪問', '无法直接访问', '我無法直接訪問',
  '請提供', '無法讀取', '[MISSING]', '無法從您上傳的文件中檢索到'
];

// ── 初始化 clients ────────────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 解析批次助手的 model（Assistants API 日落後改用環境變數/預設值）
let _batchProfile = null;
async function resolveBatchProfile() {
  if (_batchProfile) return _batchProfile;
  try {
    const a = await openai.beta.assistants.retrieve(BATCH_ASSISTANT_ID);
    _batchProfile = { model: a.model, instructions: a.instructions || undefined };
  } catch {
    _batchProfile = { model: process.env.OPENAI_RESPONSES_MODEL || 'gpt-5.6-terra', instructions: undefined };
  }
  return _batchProfile;
}

const dynamo = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    region: process.env.NEXT_PUBLIC_REGION || 'us-east-2',
    credentials: {
      accessKeyId:     process.env.NEXT_PUBLIC_ACCESS_KEY_ID,
      secretAccessKey: process.env.NEXT_PUBLIC_SECRET_ACCESS_KEY,
    },
  })
);

// ── 進度檔工具 ────────────────────────────────────────────────────────────────
function loadProgress() {
  if (!existsSync(PROGRESS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(PROGRESS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveProgress(progress) {
  writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2), 'utf-8');
}

// ── Vector Store 檔案列表 ─────────────────────────────────────────────────────
async function listVectorStoreFiles(vsId) {
  process.stdout.write('正在列出 Vector Store 中的檔案...');
  const vsFiles = [];
  let after;
  do {
    const page = await openai.vectorStores.files.list(vsId, {
      limit: 100,
      ...(after ? { after } : {}),
    });
    vsFiles.push(...page.data);
    after = page.hasNextPage() ? page.data[page.data.length - 1]?.id : null;
  } while (after);
  process.stdout.write(` 共 ${vsFiles.length} 個 (僅 completed)\n`);

  // 並行取得每個檔案的 fileName
  const details = await Promise.all(
    vsFiles
      .filter(f => f.status === 'completed')
      .map(async f => {
        try {
          const info = await openai.files.retrieve(f.id);
          return { fileId: f.id, fileName: info.filename };
        } catch {
          return null;
        }
      })
  );
  return details.filter(Boolean);
}

// ── 輔助：sleep ───────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 輔助：提取講道標題 ────────────────────────────────────────────────────────
async function extractSermonTitle(summary, fileName) {
  if (!summary) return fileName.replace(/\.pdf$/i, '');
  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-5.6-terra',
      messages: [{
        role: 'user',
        content: `從以下文章總結中提取文章標題，只回答標題本身，不要任何其他內容或標點。\n文件名稱（參考）：${fileName}\n\n${summary.slice(0, 600)}`
      }],
      // gpt-5.6-terra 為推理模型：max_tokens 改用 max_completion_tokens，不支援 temperature；機械式抽取關閉推理。
      max_completion_tokens: 200,
      reasoning_effort: 'none',
    });
    const title = res.choices[0]?.message?.content?.trim();
    return title ? title.slice(0, 80) : fileName.replace(/\.pdf$/i, '');
  } catch {
    return fileName.replace(/\.pdf$/i, '');
  }
}

// ── 核心：生成單一內容類型 ────────────────────────────────────────────────────
async function generateContent({ fileName, fileId, type, prompt, summaryText }) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const profile = await resolveBatchProfile();
    const input = [];

    // 若為 devotional / bibleStudy，先注入 summary 以強化聖經引用一致性
    if (type !== 'summary' && summaryText) {
      input.push({
        role: 'user',
        content: `以下是本文章已生成的信息總結，請在選用聖經經文時優先引用其中已出現的經節：\n---\n${summaryText}\n---`,
      });
    }

    input.push({
      role: 'user',
      content: `請基於文件「${fileName}」的內容執行以下任務：\n\n${prompt}`,
    });

    const tokenLimits = { summary: 8000, devotional: 16000, bibleStudy: 14000 };

    let response;
    try {
      response = await openai.responses.create({
        model: profile.model,
        input,
        tools: [{ type: 'file_search', vector_store_ids: [ZHIMING_VS_ID] }],
        tool_choice: 'required',
        max_output_tokens: tokenLimits[type] || 12000,
        // gpt-5.6-terra 僅接受預設 temperature/top_p，故不再傳入
        instructions: `嚴格根據文件「${fileName}」的內容生成${type}。只使用文件中的資訊，若不確定請寫「[MISSING]」而非猜測。`,
        store: false,
      });
    } catch (e) {
      const err = `responses.create 失敗：${e?.message || e}（嘗試 ${attempt}/${MAX_RETRIES}）`;
      if (attempt === MAX_RETRIES) throw new Error(`${type} 生成失敗：${err}`);
      process.stdout.write(` ⚠ ${err}，重試...\n`);
      await sleep(1000);
      continue;
    }

    if (response.status && response.status !== 'completed') {
      const err = `response 狀態 = ${response.status}（嘗試 ${attempt}/${MAX_RETRIES}）`;
      if (attempt === MAX_RETRIES) throw new Error(`${type} 生成失敗：${err}`);
      process.stdout.write(` ⚠ ${err}，重試...\n`);
      await sleep(1000);
      continue;
    }

    const content = response.output_text || '';

    const invalid = FAILURE_PHRASES.some(p => content.includes(p)) || content.trim().length < 50;
    if (invalid) {
      if (attempt < MAX_RETRIES) {
        process.stdout.write(` ⚠ 內容無效（含失敗關鍵字或過短），重試...\n`);
        await sleep(800);
        continue;
      }
      throw new Error(`${type} 生成內容無效`);
    }

    return content;
  }
  throw new Error(`${type} 達到最大重試次數`);
}

// ── 上傳 TXT 到 Vector Store ──────────────────────────────────────────────────
// sgFileId / docType 寫成向量庫檔案 attribute，供 Chat 依「選定講章」過濾檢索
async function uploadTxtToVS(vsId, name, content, sgFileId, docType) {
  const f = new File([content], name, { type: 'text/plain' });
  const uploaded = await openai.files.create({ file: f, purpose: 'assistants' });
  await openai.vectorStores.files.create(vsId, {
    file_id: uploaded.id,
    ...(sgFileId ? { attributes: { sgFileId, docType: docType || 'generated' } } : {}),
  });
  return uploaded.id;
}

// ── 確認 DynamoDB 中是否已有完成記錄 ─────────────────────────────────────────
async function checkDynamoCompleted(fileId) {
  let items = [], lastKey;
  do {
    const res = await dynamo.send(new ScanCommand({
      TableName: SUNDAY_GUIDE_TABLE,
      FilterExpression: 'fileId = :fid AND unitId = :uid AND generationStatus = :gs',
      ExpressionAttributeValues: { ':fid': fileId, ':uid': ZHIMING_UNIT_ID, ':gs': 'completed' },
      ExclusiveStartKey: lastKey,
    }));
    items = items.concat(res.Items || []);
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items.length > 0;
}

// ── 儲存到 DynamoDB ───────────────────────────────────────────────────────────
async function saveToDynamo({ fileName, fileId, summary, devotional, bibleStudy, sermonTitle, genFileIds }) {
  await dynamo.send(new PutCommand({
    TableName: SUNDAY_GUIDE_TABLE,
    Item: {
      assistantId:      BATCH_ASSISTANT_ID,
      Timestamp:        new Date().toISOString(),
      vectorStoreId:    ZHIMING_VS_ID,
      fileId,
      fileName,
      unitId:           ZHIMING_UNIT_ID,
      userId:           'batch-script',
      summary:          summary || '',
      devotional:       devotional || '',
      bibleStudy:       bibleStudy || '',
      sermonTitle:      sermonTitle || fileName.replace(/\.pdf$/i, ''),
      generatedFileIds: genFileIds,
      generationStatus: 'completed',
      completed:        true,
      createdAt:        new Date().toISOString(),
    },
  }));
}

// ── 處理單一 PDF ──────────────────────────────────────────────────────────────
async function processOnePdf({ fileName, fileId }, idx, total) {
  const label = `[${idx}/${total}] ${fileName}`;

  // ① summary
  process.stdout.write(`  → summary...`);
  const summary = await generateContent({ fileName, fileId, type: 'summary', prompt: PROMPTS.summary });
  process.stdout.write(` ✓ (${summary.length} 字)\n`);

  // ② devotional + bibleStudy 並行
  process.stdout.write(`  → devotional + bibleStudy 並行...`);
  const [devResult, bsResult] = await Promise.allSettled([
    generateContent({ fileName, fileId, type: 'devotional', prompt: PROMPTS.devotional, summaryText: summary }),
    generateContent({ fileName, fileId, type: 'bibleStudy', prompt: PROMPTS.bibleStudy,  summaryText: summary }),
  ]);
  const devotional = devResult.status === 'fulfilled' ? devResult.value : null;
  const bibleStudy = bsResult.status  === 'fulfilled' ? bsResult.value  : null;
  if (!devotional) console.warn(`\n  ⚠ ${label}: devotional 生成失敗 —`, devResult.reason?.message);
  if (!bibleStudy) console.warn(`\n  ⚠ ${label}: bibleStudy 生成失敗 —`, bsResult.reason?.message);
  process.stdout.write(` ✓ devotional(${devotional?.length ?? 0}字) bibleStudy(${bibleStudy?.length ?? 0}字)\n`);

  // ③ 提取標題
  const sermonTitle = await extractSermonTitle(summary, fileName);

  // ④ 上傳 TXT 到 VS
  const baseName = fileName.replace(/\.pdf$/i, '').slice(0, 60);
  const genFileIds = [];
  for (const [type, content] of [['summary', summary], ['devotional', devotional], ['bibleStudy', bibleStudy]]) {
    if (!content) continue;
    process.stdout.write(`  → 上傳 ${type}.txt...`);
    const fid = await uploadTxtToVS(ZHIMING_VS_ID, `${baseName}_${type}.txt`, content, fileId, type);
    genFileIds.push(fid);
    process.stdout.write(` ✓ ${fid}\n`);
  }
  // 原始講章檔（已在向量庫中）也補上 sgFileId attribute
  try {
    await openai.vectorStores.files.update(fileId, {
      vector_store_id: ZHIMING_VS_ID,
      attributes: { sgFileId: fileId, docType: 'source' },
    });
  } catch (e) {
    console.warn(`  ⚠ 標記原始檔 ${fileId} attribute 失敗（不阻斷）:`, e?.message || e);
  }

  // ⑤ DynamoDB 寫入
  process.stdout.write(`  → DynamoDB 寫入...`);
  await saveToDynamo({ fileName, fileId, summary, devotional, bibleStudy, sermonTitle, genFileIds });
  process.stdout.write(` ✓\n`);
}

// ── 主程式 ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('══════════════════════════════════════════════════════');
  console.log('  遠志明神學問答集 — 批次 Process Document');
  console.log('══════════════════════════════════════════════════════');
  console.log(`  Vector Store : ${ZHIMING_VS_ID}`);
  console.log(`  Assistant    : ${BATCH_ASSISTANT_ID}`);
  console.log(`  DynamoDB Table: ${SUNDAY_GUIDE_TABLE}`);
  console.log(`  模式: ${DRY_RUN ? '⚠ DRY-RUN（不執行 AI）' : '正式執行'}`);
  if (FORCE)   console.log('  --force: 強制重跑已完成項目');
  if (fileArg) console.log(`  --file: 只處理「${fileArg}」`);
  if (FROM_IDX > 0) console.log(`  --from: 從第 ${FROM_IDX + 1} 個開始`);
  console.log('');

  if (!process.env.OPENAI_API_KEY) { console.error('❌ 缺少 OPENAI_API_KEY'); process.exit(1); }
  if (!process.env.NEXT_PUBLIC_ACCESS_KEY_ID) { console.error('❌ 缺少 AWS 憑證'); process.exit(1); }

  // 1. 取得所有 PDF 檔案
  const allFiles = await listVectorStoreFiles(ZHIMING_VS_ID);
  let pdfFiles = allFiles
    .filter(f => f.fileName.toLowerCase().endsWith('.pdf'))
    .sort((a, b) => a.fileName.localeCompare(b.fileName));

  console.log(`找到 ${pdfFiles.length} 個 PDF（過濾掉 ${allFiles.length - pdfFiles.length} 個非 PDF）\n`);

  if (pdfFiles.length === 0) {
    console.error('❌ 沒有找到 PDF 檔案，請確認 Vector Store ID 正確');
    process.exit(1);
  }

  // 2. 套用 --file / --from 篩選
  if (fileArg) {
    pdfFiles = pdfFiles.filter(f => f.fileName === fileArg);
    if (pdfFiles.length === 0) {
      console.error(`❌ 找不到檔案「${fileArg}」，請確認檔名（含副檔名）`);
      console.log('可用的 PDF 檔案：');
      allFiles.filter(f => f.fileName.endsWith('.pdf')).forEach(f => console.log('  ' + f.fileName));
      process.exit(1);
    }
  } else if (FROM_IDX > 0) {
    pdfFiles = pdfFiles.slice(FROM_IDX);
    console.log(`從第 ${FROM_IDX + 1} 個開始，共 ${pdfFiles.length} 個待處理\n`);
  }

  // 3. 載入進度檔
  const progress = loadProgress();
  const alreadyDone = Object.values(progress).filter(v => v === 'completed').length;
  console.log(`進度檔：已完成 ${alreadyDone}，總計 ${Object.keys(progress).length} 筆紀錄\n`);

  // 4. Dry-run：只列清單
  if (DRY_RUN) {
    console.log('── Dry-run：待處理清單 ──────────────────────────────');
    let toProcess = 0;
    for (let i = 0; i < pdfFiles.length; i++) {
      const f = pdfFiles[i];
      const done = !FORCE && progress[f.fileName] === 'completed';
      console.log(`  ${String(i + 1 + FROM_IDX).padStart(2)}. [${done ? '✓ 已完成' : '待處理'}] ${f.fileName} (${f.fileId})`);
      if (!done) toProcess++;
    }
    console.log(`\n共 ${toProcess} 個待處理（${pdfFiles.length - toProcess} 個已跳過）`);
    console.log('\n移除 --dry-run 開始實際執行。');
    return;
  }

  // 5. 正式執行
  const stats = { success: 0, skip: 0, fail: 0 };
  const total = pdfFiles.length;

  for (let i = 0; i < pdfFiles.length; i++) {
    const file = pdfFiles[i];
    const num  = i + 1 + FROM_IDX;
    console.log(`\n[${num}/${total + FROM_IDX}] ${file.fileName}`);
    console.log(`  fileId: ${file.fileId}`);

    // skip 判斷（進度檔 + DynamoDB 雙重確認，除非 --force）
    if (!FORCE) {
      if (progress[file.fileName] === 'completed') {
        console.log('  ✅ 進度檔顯示已完成，跳過（--force 可覆蓋）');
        stats.skip++;
        continue;
      }
      try {
        const dbDone = await checkDynamoCompleted(file.fileId);
        if (dbDone) {
          console.log('  ✅ DynamoDB 已有完成記錄，跳過（--force 可覆蓋）');
          progress[file.fileName] = 'completed';
          saveProgress(progress);
          stats.skip++;
          continue;
        }
      } catch (e) {
        console.warn(`  ⚠ DynamoDB 查詢失敗（將繼續處理）: ${e.message}`);
      }
    }

    // 標記 in_progress
    progress[file.fileName] = 'in_progress';
    saveProgress(progress);

    try {
      await processOnePdf(file, num, total + FROM_IDX);
      progress[file.fileName] = 'completed';
      stats.success++;
      console.log(`  ✅ 完成`);
    } catch (e) {
      progress[file.fileName] = `failed: ${e.message}`;
      stats.fail++;
      console.error(`  ❌ 失敗: ${e.message}`);
    }

    saveProgress(progress);

    // throttle（最後一個不需要等）
    if (i < pdfFiles.length - 1) {
      process.stdout.write(`  ⏳ 等待 ${THROTTLE_MS / 1000}s...\n`);
      await sleep(THROTTLE_MS);
    }
  }

  // 6. 最終報告
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  批次處理完成');
  console.log('══════════════════════════════════════════════════════');
  console.log(`  ✅ 成功: ${stats.success}`);
  console.log(`  ⏭  跳過: ${stats.skip}`);
  console.log(`  ❌ 失敗: ${stats.fail}`);

  if (stats.fail > 0) {
    console.log('\n失敗清單（可重新執行腳本自動重試）:');
    Object.entries(progress)
      .filter(([, v]) => v.startsWith('failed'))
      .forEach(([k, v]) => console.log(`  • ${k}\n    ${v}`));
  }

  if (stats.success > 0) {
    console.log(`\n✅ Vector Store ${ZHIMING_VS_ID} 已新增 ${stats.success * 3} 個 TXT 檔案`);
    console.log(`✅ DynamoDB ${SUNDAY_GUIDE_TABLE} 已新增 ${stats.success} 筆記錄（unitId='${ZHIMING_UNIT_ID}'）`);
  }

  console.log(`\n進度檔：${PROGRESS_FILE}`);
}

main().catch(e => {
  console.error('\n❌ 腳本發生未預期錯誤:', e);
  process.exit(1);
});
