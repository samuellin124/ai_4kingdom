import { NextResponse } from 'next/server';
import OpenAI from 'openai';

type PromoShot = {
  tStart: number;
  tEnd: number;
  visual: string;
  overlayText: string;
  camera: string;
};

type PromoScriptPayload = {
  hook: string;
  body: string;
  cta: string;
  voiceover: string;
  shots: PromoShot[];
};

type PromoScriptRequest = {
  summary?: string;
  tone?: 'inspiring' | 'urgent' | 'warm' | 'cinematic';
  durationSec?: number;
  aspectRatio?: '16:9';
  resolution?: '720p';
};

const DEFAULT_DURATION_SEC = 5;

function normalizeSummary(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

function fallbackScript(summary: string, tone: string, durationSec: number): PromoScriptPayload {
  const clipped = summary.length > 90 ? `${summary.slice(0, 90)}...` : summary;
  return {
    hook: '5 秒看懂本週主日信息',
    body: clipped,
    cta: '點擊進入完整信息導航',
    voiceover: `5 秒看懂本週主日信息。${clipped}。點擊進入完整信息導航。`,
    shots: [
      {
        tStart: 0,
        tEnd: Math.min(1.5, durationSec),
        visual: `${tone} lighting, dramatic church interior reveal, clean composition`,
        overlayText: '本週主日重點',
        camera: 'fast push-in',
      },
      {
        tStart: 1.5,
        tEnd: Math.min(4, durationSec),
        visual: 'community worship, warm light rays, subtle particles, cinematic contrast',
        overlayText: clipped,
        camera: 'slow lateral move',
      },
      {
        tStart: 4,
        tEnd: durationSec,
        visual: 'minimal end card, high contrast typography, logo placeholder',
        overlayText: '點擊看完整內容',
        camera: 'static',
      },
    ],
  };
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as PromoScriptRequest;
    const summary = normalizeSummary(body.summary || '');
    const tone = body.tone || 'inspiring';
    const durationSec = body.durationSec || DEFAULT_DURATION_SEC;
    const aspectRatio = body.aspectRatio || '16:9';
    const resolution = body.resolution || '720p';

    if (!summary || summary.length < 20) {
      return NextResponse.json(
        { error: 'INVALID_SUMMARY', message: '請提供至少 20 字的信息總結。' },
        { status: 400 },
      );
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({
        success: true,
        mode: 'fallback',
        script: fallbackScript(summary, tone, durationSec),
        videoSpec: { durationSec, aspectRatio, resolution, fps: 24 },
      });
    }

    const openai = new OpenAI({ apiKey });
    const completion = await openai.chat.completions.create({
      model: 'gpt-5.6-terra',
      // gpt-5.6-terra 為推理模型：不支援 temperature；限制推理+輸出總量。
      reasoning_effort: 'low',
      max_completion_tokens: 8000,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You generate concise Chinese promo scripts for church sermon summaries. Return strict JSON only with keys: hook, body, cta, voiceover, shots[]. Each shot has: tStart, tEnd, visual, overlayText, camera.',
        },
        {
          role: 'user',
          content: `根據以下信息總結，生成 ${durationSec} 秒短影音腳本。\n約束:\n- 影片規格: ${aspectRatio}, ${resolution}\n- 字幕文案精簡、強節奏\n- 旁白總字數控制在 45 字內\n- shots 至少 3 段且 tEnd <= ${durationSec}\n\n總結:\n${summary}`,
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content?.trim() || '';
    const jsonString = extractFirstJsonObject(raw);
    if (!jsonString) {
      return NextResponse.json({
        success: true,
        mode: 'fallback',
        script: fallbackScript(summary, tone, durationSec),
        videoSpec: { durationSec, aspectRatio, resolution, fps: 24 },
      });
    }

    const script = JSON.parse(jsonString) as PromoScriptPayload;
    return NextResponse.json({
      success: true,
      mode: 'llm',
      script,
      videoSpec: { durationSec, aspectRatio, resolution, fps: 24 },
    });
  } catch (error) {
    console.error('[promo-script] Error:', error);
    return NextResponse.json(
      {
        error: 'PROMO_SCRIPT_FAILED',
        message: error instanceof Error ? error.message : '生成腳本失敗',
      },
      { status: 500 },
    );
  }
}

export const dynamic = 'force-dynamic';
export const maxDuration = 60;
