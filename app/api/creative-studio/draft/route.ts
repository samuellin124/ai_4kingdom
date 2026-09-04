import { NextResponse } from 'next/server';
import OpenAI from 'openai';

type ReferenceImageInput = {
  dataUrl?: string;
  name?: string;
  mimeType?: string;
};

type PromoShot = {
  tStart: number;
  tEnd: number;
  visual: string;
  overlayText: string;
  camera: string;
};

type SubtitleLine = {
  text: string;
  start: number;
  end: number;
};

type CreativeDraftPayload = {
  hook: string;
  body: string;
  cta: string;
  voiceover: string;
  visualPrompt: string;
  subtitleLines: SubtitleLine[];
  shots: PromoShot[];
};

type CreativeDraftRequest = {
  summary?: string;
  tone?: 'inspiring' | 'urgent' | 'warm' | 'cinematic';
  durationSec?: number;
  language?: 'zh-TW' | 'zh-CN';
  aspectRatio?: '16:9';
  resolution?: '720p';
  voiceGender?: 'female' | 'male';
  referenceImages?: ReferenceImageInput[];
};

const DEFAULT_DURATION_SEC = 10;

function normalizeSummary(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

function normalizeReferenceImages(referenceImages?: ReferenceImageInput[]): ReferenceImageInput[] {
  return (referenceImages || [])
    .filter((image) => /^data:image\/(png|jpe?g|webp);base64,/i.test(image?.dataUrl || ''))
    .slice(0, 3);
}

function buildSubtitleLines(shots: PromoShot[]): SubtitleLine[] {
  return shots.map((shot) => ({
    text: shot.overlayText,
    start: shot.tStart,
    end: shot.tEnd,
  }));
}

function fallbackDraft(
  summary: string,
  tone: string,
  durationSec: number,
  voiceGender: 'female' | 'male',
  referenceImages: ReferenceImageInput[],
): CreativeDraftPayload {
  const clipped = summary.length > 90 ? `${summary.slice(0, 90)}...` : summary;
  const hook = '10 秒完成短影音草稿';
  const shots: PromoShot[] = [
    {
      tStart: 0,
      tEnd: Math.min(3, durationSec),
      visual: `${tone} lighting, opening hero frame, use uploaded photo subjects as primary composition`,
      overlayText: '本週重點速覽',
      camera: 'slow push-in',
    },
    {
      tStart: 3,
      tEnd: Math.min(7, durationSec),
      visual: 'community moment, cinematic depth, warm highlights, soft particle atmosphere',
      overlayText: clipped,
      camera: 'gentle parallax move',
    },
    {
      tStart: 7,
      tEnd: durationSec,
      visual: 'clean ending card, bold subtitle area, clear CTA placement',
      overlayText: '點擊觀看完整內容',
      camera: 'static close',
    },
  ];

  return {
    hook,
    body: clipped,
    cta: '點擊觀看完整內容',
    voiceover:
      voiceGender === 'male'
        ? `十秒掌握本週重點。${clipped}。現在就看完整內容。`
        : `十秒帶你看本週重點。${clipped}。點擊進入完整內容。`,
    visualPrompt: [
      `Create a ${durationSec}-second Chinese inspirational promo video.`,
      `Use up to ${referenceImages.length || 1} uploaded reference images as visual anchors.`,
      'Maintain a clean subtitle-safe composition and cinematic church storytelling tone.',
      `Summary context: ${clipped}`,
    ].join(' '),
    subtitleLines: buildSubtitleLines(shots),
    shots,
  };
}

function sanitizeDraft(payload: Partial<CreativeDraftPayload>, durationSec: number): CreativeDraftPayload {
  const shots = (payload.shots || [])
    .filter((shot): shot is PromoShot => !!shot)
    .slice(0, 5)
    .map((shot, index, array) => {
      const start = Math.max(0, Number(shot.tStart) || 0);
      const fallbackEnd = index === array.length - 1 ? durationSec : Math.min(durationSec, start + 3);
      const end = Math.min(durationSec, Math.max(start + 0.5, Number(shot.tEnd) || fallbackEnd));
      return {
        tStart: Number(start.toFixed(1)),
        tEnd: Number(end.toFixed(1)),
        visual: String(shot.visual || 'cinematic inspirational visual'),
        overlayText: String(shot.overlayText || '').slice(0, 32),
        camera: String(shot.camera || 'steady'),
      };
    });

  const subtitleLines = (payload.subtitleLines || buildSubtitleLines(shots))
    .filter((line): line is SubtitleLine => !!line)
    .slice(0, 5)
    .map((line, index) => ({
      text: String(line.text || shots[index]?.overlayText || '').slice(0, 32),
      start: Math.max(0, Number(line.start) || shots[index]?.tStart || 0),
      end: Math.min(durationSec, Math.max(Number(line.end) || shots[index]?.tEnd || durationSec, 0.5)),
    }));

  return {
    hook: String(payload.hook || '10 秒完成短影音草稿').slice(0, 40),
    body: String(payload.body || '').slice(0, 120),
    cta: String(payload.cta || '點擊觀看完整內容').slice(0, 30),
    voiceover: String(payload.voiceover || '').slice(0, 80),
    visualPrompt: String(payload.visualPrompt || '').slice(0, 1000),
    subtitleLines,
    shots,
  };
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as CreativeDraftRequest;
    const summary = normalizeSummary(body.summary || '');
    const tone = body.tone || 'inspiring';
    const durationSec = Math.min(Math.max(body.durationSec || DEFAULT_DURATION_SEC, 8), 15);
    const language = body.language || 'zh-TW';
    const aspectRatio = body.aspectRatio || '16:9';
    const resolution = body.resolution || '720p';
    const voiceGender = body.voiceGender || 'female';
    const referenceImages = normalizeReferenceImages(body.referenceImages);

    if (!summary || summary.length < 20) {
      return NextResponse.json(
        { error: 'INVALID_SUMMARY', message: '請提供至少 20 字的創作摘要。' },
        { status: 400 },
      );
    }

    if (referenceImages.length === 0) {
      return NextResponse.json(
        { error: 'INVALID_IMAGES', message: '請至少上傳 1 張參考圖片。' },
        { status: 400 },
      );
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({
        success: true,
        mode: 'fallback',
        draft: fallbackDraft(summary, tone, durationSec, voiceGender, referenceImages),
        videoSpec: { durationSec, aspectRatio, resolution, fps: 24 },
      });
    }

    const openai = new OpenAI({ apiKey });
    const completion = await openai.chat.completions.create({
      model: 'gpt-5.6-terra',
      // gpt-5.6-terra 為推理模型：不支援 temperature；限制推理+輸出總量避免過度膨脹。
      reasoning_effort: 'low',
      max_completion_tokens: 8000,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You create concise Chinese promo drafts for a 10-second video. Return strict JSON only with keys: hook, body, cta, voiceover, visualPrompt, subtitleLines[], shots[]. subtitleLines items use text, start, end. shots items use tStart, tEnd, visual, overlayText, camera.',
        },
        {
          role: 'user',
          content: [
            `根據以下創作摘要與參考圖片，生成 ${durationSec} 秒獨立創作助手草稿。`,
            `條件：`,
            `- 影片規格 ${aspectRatio}, ${resolution}`,
            `- 字幕請拆成 3 到 4 句，每句 8 到 18 字`,
            `- visualPrompt 要可直接作為影片生成提示詞`,
            `- voiceover 為自然中文旁白，總長控制在 10 秒可唸完`,
            `- 預設語言：${language}，所有文案與字幕都用中文`,
            `- 聲線偏好：${voiceGender === 'male' ? '男聲' : '女聲'}`,
            `- tone：${tone}`,
            `- 參考圖片數量：${referenceImages.length}`,
            referenceImages.length > 0
              ? `- 參考圖片檔名：${referenceImages.map((image) => image.name || 'unnamed').join(', ')}`
              : '- 參考圖片檔名：無',
            '',
            `創作摘要：${summary}`,
          ].join('\n'),
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content?.trim() || '';
    const parsed = raw ? (JSON.parse(raw) as Partial<CreativeDraftPayload>) : null;
    if (!parsed) {
      return NextResponse.json({
        success: true,
        mode: 'fallback',
        draft: fallbackDraft(summary, tone, durationSec, voiceGender, referenceImages),
        videoSpec: { durationSec, aspectRatio, resolution, fps: 24 },
      });
    }

    const draft = sanitizeDraft(parsed, durationSec);
    return NextResponse.json({
      success: true,
      mode: 'llm',
      draft,
      videoSpec: { durationSec, aspectRatio, resolution, fps: 24 },
    });
  } catch (error) {
    console.error('[creative-studio/draft] Error:', error);
    return NextResponse.json(
      {
        error: 'CREATIVE_DRAFT_FAILED',
        message: error instanceof Error ? error.message : '生成創作草稿失敗',
      },
      { status: 500 },
    );
  }
}

export const dynamic = 'force-dynamic';
export const maxDuration = 60;