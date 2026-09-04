import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { createDynamoDBClient } from '@/app/utils/dynamodb';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { SUNDAY_GUIDE_UNITS, getSundayGuideUnitConfig, findUnitByAssistantId } from '@/app/config/constants';

// 為「本次改動之前」已在單位共用向量庫裡的檔案補上 sgFileId attribute，
// 讓 Chat 依「選定講章」過濾檢索也能命中舊資料。
//
// 用法：POST /api/maintenance/sunday-guide/backfill-vector-attributes
//   body（皆選填）：{ unitId?: string, limit?: number, dryRun?: boolean }
//   不給 unitId 則掃描 SUNDAY_GUIDE_UNITS 全部單位。

export const maxDuration = 300;

const TABLE = process.env.NEXT_PUBLIC_SUNDAY_GUIDE_TABLE || 'SundayGuide';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function setAttr(vectorStoreId: string, fileId: string, sgFileId: string, docType: string) {
  await openai.vectorStores.files.update(fileId, {
    vector_store_id: vectorStoreId,
    attributes: { sgFileId, docType },
  });
}

// 併發池：逐一 await 數百個 OpenAI 呼叫會撞到路由 300s 上限，這裡以固定併發跑完
async function runPool<T>(items: T[], worker: (item: T) => Promise<void>, concurrency = 8) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const item = items[cursor++];
        await worker(item);
      }
    })
  );
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({} as any));
    const { unitId, limit = 200, dryRun = false } = body as { unitId?: string; limit?: number; dryRun?: boolean };

    const units = unitId ? [unitId] : Object.keys(SUNDAY_GUIDE_UNITS);
    const client = await createDynamoDBClient();

    const summary: Record<string, any> = {};
    let processedRecords = 0;

    for (const u of units) {
      const cfg = getSundayGuideUnitConfig(u);
      const vsId = cfg?.vectorStoreId;
      if (!vsId) { summary[u] = { skipped: 'no vectorStoreId' }; continue; }

      // 掃出屬於此單位的記錄
      let items: any[] = [];
      let lastKey: any;
      do {
        const res = await client.send(new ScanCommand({ TableName: TABLE, ExclusiveStartKey: lastKey }));
        for (const it of res.Items || []) {
          const itUnit = it.unitId || findUnitByAssistantId(it.assistantId);
          if (String(itUnit) === String(u)) items.push(it);
        }
        lastKey = (res as any).LastEvaluatedKey;
      } while (lastKey && items.length < limit * 4);

      let tagged = 0, missing = 0, errored = 0, recs = 0;
      // 先攤平成待處理清單，再以併發池執行
      const jobs: Array<{ id: string; sgFileId: string; docType: string }> = [];
      for (const rec of items) {
        if (processedRecords >= limit) break;
        const sgFileId: string | undefined = rec.fileId;
        if (!sgFileId) continue;
        recs++; processedRecords++;

        for (const gid of (rec.generatedFileIds || [])) jobs.push({ id: gid, sgFileId, docType: 'generated' });
        // 原始講章檔也可能在共用庫裡（其 id 就是 record.fileId）
        jobs.push({ id: sgFileId, sgFileId, docType: 'source' });
      }

      if (dryRun) {
        tagged = jobs.length;
      } else {
        await runPool(jobs, async (t) => {
          try {
            await setAttr(vsId, t.id, t.sgFileId, t.docType);
            tagged++;
          } catch (e: any) {
            if (e?.status === 404) missing++;
            else { errored++; console.warn(`[backfill] ${u} ${t.id}: ${e?.message || e}`); }
          }
        });
      }
      summary[u] = { vectorStoreId: vsId, records: recs, files: jobs.length, tagged, missingInStore: missing, errored };
    }

    return NextResponse.json({ success: true, dryRun, limit, processedRecords, summary });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}
