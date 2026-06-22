export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir } from 'fs/promises';
import { join, extname, basename } from 'path';
import { existsSync } from 'fs';

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const ALLOWED_MIME  = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/svg+xml']);
const ALLOWED_EXT   = new Set(['.jpg', '.jpeg', '.png', '.webp', '.svg']);

function sanitizeFilename(name: string): string {
  return basename(name)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .substring(0, 100);
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file      = formData.get('file')      as File   | null;
    const projectId = formData.get('projectId') as string | null;

    if (!file) {
      return NextResponse.json({ success: false, error: 'No file provided' }, { status: 400 });
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ success: false, error: 'File too large. Maximum 5 MB per image.' }, { status: 400 });
    }

    if (!ALLOWED_MIME.has(file.type)) {
      return NextResponse.json({ success: false, error: 'Invalid file type. Supported: JPG, PNG, WebP, SVG.' }, { status: 400 });
    }

    const ext = extname(file.name).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      return NextResponse.json({ success: false, error: 'Invalid file extension.' }, { status: 400 });
    }

    const folder   = sanitizeFilename(projectId || 'temp');
    const filename = `${Date.now()}_${sanitizeFilename(file.name)}`;
    const dir      = join(process.cwd(), 'public', 'uploads', folder);

    if (!existsSync(dir)) await mkdir(dir, { recursive: true });

    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(join(dir, filename), buffer);

    return NextResponse.json({
      success: true,
      url:  `/uploads/${folder}/${filename}`,
      name: file.name,
      type: file.type,
      size: file.size,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Upload failed';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
