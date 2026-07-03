import { NextRequest, NextResponse } from 'next/server';
import { groupAiTools, scanAiTools, sanitizeText } from '@/app/utils/aiToolsDirectory';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const category = sanitizeText(searchParams.get('category'), 100) || null;
    const subcategory = sanitizeText(searchParams.get('subcategory'), 100) || null;

    const tools = await scanAiTools({
      activeOnly: true,
      category,
      subcategory,
    });

    return NextResponse.json({
      success: true,
      data: {
        categories: groupAiTools(tools),
        tools,
      },
    });
  } catch (error) {
    console.error('[AiToolsDirectory] Public read failed:', error);
    return NextResponse.json(
      { success: false, error: '无法载入 AI 工具目录。' },
      { status: 500 }
    );
  }
}
