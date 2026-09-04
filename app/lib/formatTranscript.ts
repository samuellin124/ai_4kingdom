import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * 使用 gpt-5.6-terra（reasoning_effort: none）為 Whisper 原始轉錄文字加上標點符號、分段，提升可讀性。
 *
 * @param rawText  Whisper 輸出的原始文字（無標點）
 * @returns        格式化後的文字
 */
export async function formatTranscript(rawText: string): Promise<string> {
  if (!rawText || rawText.trim().length === 0) return rawText;

  // 若文字很短（< 50 字），直接回傳，不必呼叫 API
  if (rawText.trim().length < 50) return rawText.trim();

  try {
    // 超長文字分段處理（每段最多約 2000 字，避免單次 token 過多）
    const CHUNK_SIZE = 2000;
    const chunks = splitIntoChunks(rawText.trim(), CHUNK_SIZE);

    const formattedParts: string[] = [];
    for (const chunk of chunks) {
      const formatted = await formatChunk(chunk);
      formattedParts.push(formatted);
    }

    return formattedParts.join('\n\n');
  } catch (err) {
    // 格式化失敗時靜默降級，回傳原始文字
    console.warn('[formatTranscript] GPT formatting failed, returning raw text:', err);
    return rawText.trim();
  }
}

async function formatChunk(text: string): Promise<string> {
  const completion = await openai.chat.completions.create({
    model: 'gpt-5.6-terra',
    // gpt-5.6-terra 為推理模型：不支援 temperature。標點/分段屬機械式編輯，關閉推理以避免
    // 推理 token 佔用輸出額度導致轉錄內容被截斷（下游會因回覆過短而退回原始文字）。
    reasoning_effort: 'none',
    messages: [
      {
        role: 'system',
        content: `你是一位專業的文字編輯，負責整理語音轉錄文字。
請對輸入的文字進行以下處理：
1. 加上正確的中文標點符號（句號、逗號、問號、感嘆號、頓號等）
2. 適當分段，使文字結構清晰（根據語意換行，段落之間加一個空行）
3. 修正明顯的同音字/語音辨識錯誤（如「的地得」、「再在」等）
4. 保留所有原始語義，不刪減、不改寫、不添加內容
5. 如原文有重複詞彙（口語習慣），保留不刪
6. 若原文含英文，保留英文原文不翻譯
只輸出整理後的文字，不要加任何說明或前言。`,
      },
      {
        role: 'user',
        content: text,
      },
    ],
    max_completion_tokens: 16384,
  });

  return completion.choices[0]?.message?.content?.trim() ?? text;
}

/**
 * 按大約字數切分文字，盡量在句子邊界切分
 */
function splitIntoChunks(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = start + maxChars;
    if (end >= text.length) {
      chunks.push(text.slice(start));
      break;
    }

    // 嘗試在標點或空格處切分
    const breakChars = ['。', '！', '？', '…', '\n', ' ', '，'];
    let cutAt = end;
    for (const ch of breakChars) {
      const idx = text.lastIndexOf(ch, end);
      if (idx > start + maxChars * 0.5) {
        cutAt = idx + 1;
        break;
      }
    }

    chunks.push(text.slice(start, cutAt));
    start = cutAt;
  }

  return chunks;
}
