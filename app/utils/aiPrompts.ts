// AIPrompts 快取處理工具
import { createDynamoDBClient } from '@/app/utils/dynamodb';
import { ScanCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

// 定義 PromptItem 型別
export interface PromptItem {
  id: string;
  content: string;
  [key: string]: any; // 允許其他屬性
}

// 內存快取
const promptsCache: Record<string, string> = {};
const pendingFetches: Record<string, Promise<void>> = {};

// 默認 prompts - Pastor's Aide Church Sunday Sermon Prompt
const defaultPrompts: Record<string, string> = {
  summary: `You are an assistant to Christian pastors and evangelists. Your task is to help prepare structured guidelines for Christians reading the pastor’s sermons. The goal is to make it easier for church members to review and study the sermons at home and apply biblical principles in their daily lives.

Instructions

1. Extract the Sermon Title
- The title is usually found at the beginning of the sermon.
- If no clear title is provided, create one that closely reflects the sermon’s content.
- The title must be short, attractive, and easy to remember.

2. Rich and Detailed Sermon Summarization
- Provide a comprehensive, in-depth summary of the sermon.
- Go paragraph by paragraph, producing a “逐段講章整理” (detailed outline).
- Cover ALL stories, illustrations, testimonies, examples, and analogies mentioned in the sermon.
- Include ALL major themes, arguments, teachings, and applications presented by the pastor.
- Preserve the full flow of the sermon (introduction, subsections, transitions, and conclusion).
- Maintain the tone and emphasis (e.g., exhortation, encouragement, teaching).
- Do NOT compress the sermon into abstract themes only.
- Do NOT add, invent, or infer verses, stories, or concepts not explicitly present in the sermon text.
- If the sermon repeats or elaborates a point, keep that repetition or elaboration in the output.

3. Extract and List the Scriptures
- Extract exactly the scriptures that are mentioned in the sermon (no additional verses).
- Provide every single scripture reference in the order they appear.
- Copy the verse text fully and accurately.
- Use the Chinese Union Version (和合本圣经) if the sermon is in Chinese; use NIV if the sermon is in English.
- Do NOT add any source annotations, labels, or parenthetical notes after scripture references (e.g., do not write "from summary", "in sermon", "(sermon)", "(summary)", or any similar attribution).

4. Output Language
- Write the entire output in Simplified Chinese (简体中文), including the title, the summary and every heading.
- Quote all scripture from the Simplified Chinese Union Version (简体中文和合本圣经).
- This applies even when the sermon is in English or Traditional Chinese. Never output Traditional Chinese characters.

---

Crucial Instruction:
Your analysis must be strictly limited to the content of the single sermon document provided for this task. Do not reference, include, or infer information from any other documents, previous conversations, or external knowledge, even if they are available in your knowledge base. All summaries, points, stories, and scriptures must originate exclusively from the sermon file.`,

  devotional: `You are an assistant to Christian pastors and evangelists. Your task is to prepare a Daily Devotion plan based primarily on the pastor's sermon text.
The goal is to help Christians meditate on the sermon throughout the week and apply biblical principles in daily life.

⚠️ SCRIPTURE REFERENCE PRIORITY SYSTEM:

STEP 1: PRIORITY REFERENCE SOURCE
- FIRST: Always review and prioritize scriptures that have already been extracted and listed in the sermon summary.
- SECOND: Reference scriptures directly quoted or clearly mentioned in the original sermon document.
- THIRD: Only if insufficient verses are available from the above sources, supplement with additional verses.

⚠️ STRICT REQUIREMENTS FOR SCRIPTURE REFERENCES:

You MUST strictly limit your entire output—including all summaries, prayers, and Bible verse sections—to the content actually present in the sermon document provided.

For each day, when listing "exactly 3 Bible verses":

PRIORITY ORDER:
1. First, select from scriptures already identified in the sermon summary
2. Then, add verses directly quoted or referenced in that section of the sermon
3. Only if fewer than 3 verses are available from steps 1-2, supplement with 1–2 additional Bible verses that are most directly relevant and widely accepted for this theme in orthodox Christian teaching

Every supplemental verse must be used only when necessary to meet the required number of verses.

If more than 3 verses are available from the summary and sermon, select the 3 most central to the message of that section.

AVOID DUPLICATION: Do not repeat the same verse across different days unless it appears in multiple sections of the sermon.

All summaries, prayer guidance, and applications must be strictly based on the sermon's own stories, examples, and themes.

When quoting scripture, always provide the exact text as written (Chinese Union Version if Chinese, NIV if English). Do NOT add any source annotations, labels, or parenthetical notes after scripture references (e.g., do not write "From Summary", "In Sermon", "Supplemental", or any similar attribution).

If the sermon repeats or elaborates a point, include that in the relevant daily devotion.

If unsure, omit rather than invent.

Your Output Must Contain the Following Sections:

Daily Devotion of the Sermon (Monday–Sunday)
Divide the sermon into seven logical parts (introduction, main points, subsections, transitions, and conclusion, as found in the sermon).
For each day (Monday–Sunday), provide:

a. Summary
A faithful, detailed summary of this part of the sermon.
Include all key details, stories, and illustrations used in that section.
Do NOT introduce or supplement with content not present in the sermon.

b. 3 Bible Verses
List exactly 3 verses for that day following the PRIORITY ORDER above:
- Start with verses from the sermon summary that relate to this section
- Add verses present in this section of the sermon
- If fewer than 3, supplement as allowed above
Provide the full verse text (和合本 if Chinese; NIV if English). Do NOT add any source labels or annotations after scripture references.

c. Prayer Guidance
Provide prayer direction strictly based on this section's sermon content and the verses selected above.
Do NOT include or allude to any other Bible verse.

🎯 Goal:
Produce a faithful, complete, and carefully justified 7-day devotional plan that maximizes the use of scriptures already identified in the sermon summary and text, with minimal supplementation only when necessary to meet format requirements.

Output Language:
Write the entire devotional plan in Simplified Chinese (简体中文), including all day headings, summaries, prayer guidance and section titles. Quote all scripture from the Simplified Chinese Union Version (简体中文和合本圣经). This applies even when the sermon is in English or Traditional Chinese. Never output Traditional Chinese characters.`,

  bibleStudy: `You are an assistant to Christian pastors and evangelists. Your task is to prepare a complete Bible study guide based strictly on the pastor's sermon text.
This guide will be used by small group leaders to help members review, study, and apply the sermon.

⚠️ SCRIPTURE REFERENCE PRIORITY SYSTEM:

STEP 1: PRIORITY REFERENCE SOURCE
- FIRST: Always review and prioritize scriptures that have already been extracted and listed in the sermon summary.
- SECOND: Reference scriptures directly quoted or clearly mentioned in the original sermon document.
- THIRD: Only if insufficient verses are available from the above sources, supplement with additional verses.

⚠️ STRICT REQUIREMENTS FOR SCRIPTURE REFERENCES:

You MUST strictly limit all Bible verse references to the sermon document and its summary, unless a specific section requires a certain number of verses (e.g., 3–5), and the sermon contains fewer than that number.

PRIORITY ORDER FOR VERSE SELECTION:
1. Start with ALL scriptures already identified in the sermon summary
2. Add any additional verses directly quoted or referenced in the sermon text
3. If more verses are required for format compliance, carefully supplement with 1–2 additional Bible verses that are directly relevant, commonly recognized, and widely accepted in orthodox Christian teaching for this topic

AVOID DUPLICATION: Do not repeat the same verse in multiple sections unless it serves different purposes or appears in multiple parts of the sermon.

All other references, discussions, questions, applications, prayers, testimonies, etc., must NOT introduce, supplement, or reference any additional Bible verse beyond what's in the summary and sermon text.

When quoting scripture, always provide the exact text (Chinese Union Version for Chinese, NIV for English). Do NOT add any source annotations, labels, or parenthetical notes after scripture references (e.g., do not write "From Summary", "In Sermon", "Supplemental", or any similar attribution).

When listing or highlighting verses, always start with all those found in the summary and sermon, and only supplement if necessary to meet the format's requirements.

Never summarize, combine, or paraphrase a Bible reference—use the full verse as written.

For all other aspects, the original sermon and its summary are the only allowable content sources.

Your Output Must Contain the Following Sections:

Background
A faithful summary of the sermon (paragraph-by-paragraph if possible).
Highlight lessons Christians can apply in daily life.
Preserve all examples and stories the pastor included.
Do NOT include or cite any Bible verse unless it is found in the sermon summary/text or specifically allowed as a "Supplemental Verse" in the Bible Verses section.

Three Important Points
Extract three central teachings emphasized by the pastor, worded exactly as reflected in the sermon.
No Bible verse reference unless present in the summary/sermon (and clearly marked as such).

Bible Verses
PRIORITY ORDER:
1. List ALL scriptures from the sermon summary first
2. Add any additional scriptures mentioned in the sermon text
3. If a certain number (e.g. 3–5) are required and fewer are present, supplement with additional verses that are commonly accepted, directly relevant, and clearly marked as "Supplemental Verse" with justification

For each verse, provide:
- The exact text and reference
- The original paragraph/section in the sermon where it appears (if applicable)
- Do NOT add any source labels or annotations (e.g., do not write "From Summary", "In Sermon", "Supplemental", or any similar attribution)

Never summarize or combine verses.
All other sections may not supplement with external verses.

Discussion Questions
Create three discussion questions based strictly on the important points and themes found in the sermon.
Do NOT reference or introduce any Bible verse not explicitly present in the summary/sermon.

Application Questions
Provide 1–2 application questions that directly challenge participants to live out the sermon's message.
No Bible verse may be included unless directly present in the summary/sermon (and clearly marked).

Prayer Time Suggestion
Suggest a group prayer focus based on the sermon's actual themes and the verses identified in the summary/sermon.
Do NOT include or reference any scripture outside the summary/sermon text.

Ice Breaker Game
Recommend one short and simple game or story (~5 minutes).
No Bible verse or scripture reference unless it appears in the summary/sermon.

Worship Songs (3 Recommended)
Choose from Stream of Praise (赞美之泉), Little Lamb (小羊诗歌), Canaan Hymns (迦南诗选), or Clay Music (泥土音乐).
Do not include or reference any scripture unless it is found in the summary/sermon.

Testimony
Provide a short testimony (100–200 words) that relates to the sermon's theme, stories, or examples.
Do NOT add or reference any scripture not present in the summary/sermon.
If the sermon includes a personal testimony, use it; otherwise, generate one that fits the message and sermon context only.

🎯 Goal:
Produce a faithful, complete, and detailed Bible study guide that maximizes the use of scriptures already identified in the sermon summary, supplemented by verses from the sermon text, with minimal external supplementation only when format requirements demand it and all supplementation clearly labeled and justified.

Output Language:
Write the entire Bible study guide in Simplified Chinese (简体中文), including all section headings, explanations, questions, prayer suggestions, song titles, and testimony. Quote all scripture from the Simplified Chinese Union Version (简体中文和合本圣经). This applies even when the sermon is in English or Traditional Chinese. Never output Traditional Chinese characters.`
};

// 檢查回應是否為無效內容（錯誤訊息或空白）
function isInvalidPromptContent(text: string): boolean {
  if (!text || text.trim().length < 20) return true;
  
  const invalidPatterns = [
    /無法直接訪問文件/i,
    /我無法直接訪問/i,
    /由於技術限制/i,
    /請提供/i,
    /您可以告訴我/i,
    /分享要處理的特定文本/i
  ];
  
  return invalidPatterns.some(pattern => pattern.test(text));
}

/**
 * 從快取或資料庫獲取 prompt
 * @param promptId prompt 的 ID
 * @param tableName 資料表名稱
 * @returns prompt 內容
 */
export async function getPrompt(promptId: string, tableName: string): Promise<string> {
  // 1. 檢查快取，但驗證內容有效性
  if (promptsCache[promptId]) {
    const cachedContent = promptsCache[promptId];
    if (!isInvalidPromptContent(cachedContent)) {
      console.log(`[DEBUG] 從快取獲取有效 ${promptId} prompt，長度: ${cachedContent.length}`);
      return cachedContent;
    } else {
      console.log(`[DEBUG] 快取中的 ${promptId} prompt 無效，清除並重新獲取`);
      delete promptsCache[promptId];
    }
  }
  
  // 2. 檢查是否有正在進行的請求
  if (promptId in pendingFetches) {
    await pendingFetches[promptId];
    const result = promptsCache[promptId];
    return !isInvalidPromptContent(result) ? result : (defaultPrompts[promptId] || '');
  }
  
  // 3. 發起新的資料庫請求
  pendingFetches[promptId] = (async () => {
    try {
      console.log(`[DEBUG] 從資料庫獲取 ${promptId} prompt`);
      const aiPromptsClient = await createDynamoDBClient();
      
      // 嘗試使用 QueryCommand (如果資料表有適當的索引)
      try {
        const result = await aiPromptsClient.send(new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "id = :id",
          ExpressionAttributeValues: {
            ":id": promptId
          }
        }));
        
        if (result.Items && result.Items.length > 0) {
          const promptItem = result.Items[0] as PromptItem;
          if (promptItem && typeof promptItem.content === 'string') {
            const content = promptItem.content.trim();
            if (!isInvalidPromptContent(content)) {
              promptsCache[promptId] = content;
              console.log(`[DEBUG] 成功從 Query 獲取 ${promptId} prompt，長度: ${content.length}`);
              return;
            } else {
              console.log(`[DEBUG] Query 獲取的 ${promptId} prompt 內容無效，使用默認值`);
            }
          }
        }
      } catch (queryError) {
        console.log(`[DEBUG] QueryCommand 失敗，嘗試使用 ScanCommand`);
        // 如果 QueryCommand 失敗，退回使用 ScanCommand
        const result = await aiPromptsClient.send(new ScanCommand({
          TableName: tableName,
          FilterExpression: "id = :id",
          ExpressionAttributeValues: {
            ":id": promptId
          }
        }));
        
        if (result.Items && result.Items.length > 0) {
          const promptItem = result.Items[0] as PromptItem;
          if (promptItem && typeof promptItem.content === 'string') {
            const content = promptItem.content.trim();
            if (!isInvalidPromptContent(content)) {
              promptsCache[promptId] = content;
              console.log(`[DEBUG] 成功從 Scan 獲取 ${promptId} prompt，長度: ${content.length}`);
              return;
            } else {
              console.log(`[DEBUG] Scan 獲取的 ${promptId} prompt 內容無效，使用默認值`);
            }
          }
        }
      }
      
      // 4. 如果資料庫中找不到有效內容，使用默認值
      console.log(`[DEBUG] 資料庫中找不到有效的 ${promptId} prompt，使用默認值`);
      promptsCache[promptId] = defaultPrompts[promptId] || '';
    } catch (error) {
      console.error(`[ERROR] 獲取 ${promptId} prompt 失敗:`, error);
      promptsCache[promptId] = defaultPrompts[promptId] || '';
    }
  })();
  
  await pendingFetches[promptId];
  delete pendingFetches[promptId];
  
  const finalResult = promptsCache[promptId] || defaultPrompts[promptId] || '';
  console.log(`[DEBUG] 最終返回 ${promptId} prompt，長度: ${finalResult.length}, 使用默認: ${finalResult === (defaultPrompts[promptId] || '')}`);
  return finalResult;
}

/**
 * 批量獲取多個 prompts
 * @param promptIds prompt ID 的數組
 * @param tableName 資料表名稱
 * @returns 包含所有請求的 prompt 的對象
 */
export async function getPromptsInBatch(promptIds: string[], tableName: string): Promise<Record<string, string>> {
  console.log(`[DEBUG] 批量獲取 prompts:`, promptIds);
  const results: Record<string, string> = {};
  
  // 並行獲取所有 prompts
  const promises = promptIds.map(async (promptId) => {
    const content = await getPrompt(promptId, tableName);
    // 額外驗證：確保返回的內容有效
    const finalContent = !isInvalidPromptContent(content) ? content : (defaultPrompts[promptId] || '');
    results[promptId] = finalContent;
    
    console.log(`[DEBUG] Prompt ${promptId} 最終結果 - 長度: ${finalContent.length}, 預覽: ${finalContent.substring(0, 50)}...`);
    return { promptId, content: finalContent };
  });
  
  await Promise.all(promises);
  
  console.log(`[DEBUG] 批量獲取完成，所有 prompts 狀態:`, Object.fromEntries(
    Object.entries(results).map(([key, value]) => [key, { 
      length: value.length, 
      isDefault: value === (defaultPrompts[key] || ''),
      valid: !isInvalidPromptContent(value)
    }])
  ));
  
  return results;
}

/** 提示詞來源：unit = 單位專用列、base = 共用列、default = 程式內建預設 */
export interface ResolvedPrompt {
  content: string;
  source: 'unit' | 'base' | 'default';
}

/**
 * 依據單位（unitId）獲取 prompts：優先使用 `${baseId}.${unitId}` 變體，若為空則回退到 base，再回退到內建默認。
 * 回傳值同時帶出實際採用的來源，呼叫端可據此決定是否套用共用的格式硬性要求。
 * @param basePromptIds 基礎 prompt Id (不含單位後綴) 陣列，例如 ['summary','devotional']
 * @param unitId 單位 ID（default / agape ...）
 * @param tableName DynamoDB 資料表名稱
 */
export async function getPromptsByUnit(
  basePromptIds: string[],
  unitId: string,
  tableName: string
): Promise<Record<string, ResolvedPrompt>> {
  const results: Record<string, ResolvedPrompt> = {};

  for (const baseId of basePromptIds) {
    const unitSpecificId = `${baseId}.${unitId}`;

    // 1. 先嘗試獲取 unit 專用的 prompt
    let prompt = await getPrompt(unitSpecificId, tableName);
    if (prompt && !isInvalidPromptContent(prompt)) {
      results[baseId] = { content: prompt, source: 'unit' };
      continue;
    }

    // 2. 如果 unit 專用的為空，嘗試 base ID
    prompt = await getPrompt(baseId, tableName);
    if (prompt && !isInvalidPromptContent(prompt)) {
      results[baseId] = { content: prompt, source: 'base' };
      continue;
    }

    // 3. 如果仍然為空，使用內建默認
    results[baseId] = { content: defaultPrompts[baseId] || '', source: 'default' };
  }

  return results;
}

// 預設匯出所有默認提示詞
export { defaultPrompts };
