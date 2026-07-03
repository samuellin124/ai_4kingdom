import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import { canManageAiTools, sanitizeText } from '@/app/utils/aiToolsDirectory';

export const runtime = 'nodejs';

const MAX_ICON_BYTES = 1024 * 1024;
const ALLOWED_TYPES: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

function getRequestUserId(request: NextRequest, formData: FormData): string {
  return String(request.headers.get('x-user-id') || formData.get('userId') || '').trim();
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const userId = getRequestUserId(request, formData);

    if (!(await canManageAiTools(userId))) {
      return NextResponse.json(
        { success: false, error: '没有权限上传图标。' },
        { status: 403 }
      );
    }

    const file = formData.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ success: false, error: '请上传图标文件。' }, { status: 400 });
    }

    const extension = ALLOWED_TYPES[file.type];
    if (!extension) {
      return NextResponse.json(
        { success: false, error: '图标仅支持 PNG、JPG、WEBP、GIF 格式。' },
        { status: 400 }
      );
    }

    if (file.size > MAX_ICON_BYTES) {
      return NextResponse.json(
        { success: false, error: '图标文件大小不能超过 1MB。' },
        { status: 400 }
      );
    }

    const originalName = sanitizeText(file.name.replace(/\.[^.]+$/, ''), 60)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'icon';
    const fileName = `${originalName}-${crypto.randomUUID()}${extension}`;
    const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'ai-tools');
    const filePath = path.join(uploadDir, fileName);

    await mkdir(uploadDir, { recursive: true });
    await writeFile(filePath, Buffer.from(await file.arrayBuffer()));

    return NextResponse.json({
      success: true,
      iconUrl: `/uploads/ai-tools/${fileName}`,
    });
  } catch (error) {
    console.error('[AiToolsDirectory] Icon upload failed:', error);
    return NextResponse.json(
      { success: false, error: '无法上传图标。' },
      { status: 500 }
    );
  }
}
