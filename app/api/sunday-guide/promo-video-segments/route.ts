import { NextResponse } from 'next/server';
import OpenAI from 'openai';

type PromoSegmentRequest = {
  summary: string;
  tone?: 'inspiring' | 'urgent' | 'warm' | 'cinematic';
  durationSec?: number; // total duration for all 5 segments
};

type PromoSegment = {
  segmentIndex: number; // 0-4
  durationSec: number; // 12 by default
  aspectRatio: '16:9';
  chineseCaption: string;
  voiceoverText: string; // for TTS
  soraPrompt: string; // detailed Sora prompt
  editableFields: {
    caption?: string;
    voiceover?: string;
    soraPrompt?: string;
  };
};

type PromoSegmentResponse = {
  success: boolean;
  totalDurationSec: number;
  segments: PromoSegment[];
};

async function generateSegmentPrompts(
  summary: string,
  tone: string,
  totalDurationSec: number
): Promise<PromoSegment[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Fallback without API
    return generateFallbackSegments(summary, tone, totalDurationSec);
  }

  const openai = new OpenAI({ apiKey });
  const segmentDurationSec = Math.max(8, totalDurationSec / 5);

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-5.6-terra',
      // gpt-5.6-terra 為推理模型：不支援 temperature；限制推理+輸出總量。
      reasoning_effort: 'low',
      max_completion_tokens: 8000,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You are a professional video producer specializing in cinematic church promo videos. 
Generate 5 segments for a ${totalDurationSec}s total video (each ~${segmentDurationSec}s).
Each segment must have:
- chineseCaption: 8-15 characters, compelling short text
- voiceoverText: 15-25 characters in Chinese
- soraPrompt: detailed Sora API prompt (including visual style, cinematography, lighting, color grading, text overlay position)
Return ONLY valid JSON matching: { segments: [{ segmentIndex, chineseCaption, voiceoverText, soraPrompt }, ...] }`,
        },
        {
          role: 'user',
          content: `Create a ${totalDurationSec}s promo video for a church sermon with this tone: "${tone}".
Summary: ${summary}

Generate 5 compelling video segments in 16:9 format (1280x720). Each segment should:
1. Show progression from hook → message → call-to-action
2. Include Chinese captions and voiceover
3. Have distinct visual transitions
4. Include cinematic details for Sora (lighting, camera movement, color palette)

Return valid JSON only.`,
        },
      ],
    });

    const content = completion.choices[0]?.message?.content?.trim() || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return generateFallbackSegments(summary, tone, totalDurationSec);

    const parsed = JSON.parse(jsonMatch[0]);
    const rawSegments = parsed.segments || [];

    return rawSegments.slice(0, 5).map((seg: any, idx: number) => ({
      segmentIndex: idx,
      durationSec: segmentDurationSec,
      aspectRatio: '16:9' as const,
      chineseCaption: (seg.chineseCaption || `場景 ${idx + 1}`).substring(0, 30),
      voiceoverText: (seg.voiceoverText || '').substring(0, 100),
      soraPrompt: (seg.soraPrompt || '').substring(0, 1000),
      editableFields: {
        caption: seg.chineseCaption,
        voiceover: seg.voiceoverText,
        soraPrompt: seg.soraPrompt,
      },
    }));
  } catch (error) {
    console.error('[segments] Error calling OpenAI:', error);
    return generateFallbackSegments(summary, tone, totalDurationSec);
  }
}

function generateFallbackSegments(summary: string, tone: string, totalDurationSec: number): PromoSegment[] {
  const segmentDurationSec = Math.max(8, totalDurationSec / 5);
  const clipped = summary.substring(0, 60);

  const templates = [
    {
      caption: '本週主日重點',
      voiceover: '五秒看懂本週信息重點',
      visual: 'dramatic church interior, warm light rays, cinematic depth, fast push-in zoom',
    },
    {
      caption: `${clipped}...`,
      voiceover: clipped,
      visual: 'community worship scene, golden hour lighting, slow lateral camera move, particles',
    },
    {
      caption: '信息精華',
      voiceover: '核心信息帶來生命改變',
      visual: 'subtle text animation, minimal design, high contrast typography, static lighting',
    },
    {
      caption: '我的回應',
      voiceover: '邀請你參與信息反思',
      visual: 'personal moments, intimate lighting, camera push-in, warm tone',
    },
    {
      caption: '點擊看完整',
      voiceover: '進入完整信息導航',
      visual: 'end card minimal style, logo reveal, geometric shapes, fade transition',
    },
  ];

  return templates.map((tpl, idx) => ({
    segmentIndex: idx,
    durationSec: segmentDurationSec,
    aspectRatio: '16:9' as const,
    chineseCaption: tpl.caption,
    voiceoverText: tpl.voiceover,
    soraPrompt: `Cinematic ${tone} church promo segment. ${tpl.visual}. Duration: ${segmentDurationSec}s, 16:9 format, 1280x720.`,
    editableFields: {
      caption: tpl.caption,
      voiceover: tpl.voiceover,
      soraPrompt: `Cinematic ${tone} church promo segment. ${tpl.visual}. Duration: ${segmentDurationSec}s, 16:9 format, 1280x720.`,
    },
  }));
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as PromoSegmentRequest;
    const summary = (body.summary || '').trim();
    const tone = body.tone || 'inspiring';
    const totalDurationSec = Math.min(Math.max(body.durationSec || 60, 40), 120);

    if (!summary || summary.length < 20) {
      return NextResponse.json(
        {
          success: false,
          error: 'INVALID_SUMMARY',
          message: '請提供至少 20 字的信息總結。',
        },
        { status: 400 }
      );
    }

    const segments = await generateSegmentPrompts(summary, tone, totalDurationSec);

    return NextResponse.json({
      success: true,
      totalDurationSec,
      segments,
    } as PromoSegmentResponse);
  } catch (error) {
    console.error('[promo-video-segments] POST Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'SEGMENT_GENERATION_FAILED',
        message: error instanceof Error ? error.message : '分段生成失敗',
      },
      { status: 500 }
    );
  }
}

export const dynamic = 'force-dynamic';
export const maxDuration = 60;
