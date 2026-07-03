import { NextRequest, NextResponse } from 'next/server';
import { getAiToolById, sanitizeText } from '@/app/utils/aiToolsDirectory';

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const id = sanitizeText(params.id, 200);
    if (!id) {
      return NextResponse.json({ success: false, error: '缺少工具编号。' }, { status: 400 });
    }

    const tool = await getAiToolById(id, { activeOnly: true });
    if (!tool) {
      return NextResponse.json({ success: false, error: '找不到这个工具。' }, { status: 404 });
    }

    return NextResponse.json({ success: true, data: { tool } });
  } catch (error) {
    console.error('[AiToolsDirectory] Public detail read failed:', error);
    return NextResponse.json(
      { success: false, error: '无法载入工具资料。' },
      { status: 500 }
    );
  }
}
