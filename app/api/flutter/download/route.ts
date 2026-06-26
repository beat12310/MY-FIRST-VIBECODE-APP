export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { readFile, access } from 'fs/promises';
import { join } from 'path';

/**
 * GET /api/flutter/download?path=/abs/path/to/app-release.apk
 *
 * Serves a built Flutter APK file as a binary download.
 * The path must be inside the generated-projects directory to prevent
 * directory traversal attacks.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const apkPath = request.nextUrl.searchParams.get('path') ?? '';

  if (!apkPath) {
    return NextResponse.json({ error: 'Missing path parameter' }, { status: 400 });
  }

  // Security: only serve files inside generated-projects/
  const allowedRoot = join(process.cwd(), 'generated-projects');
  const resolvedPath = join('/', apkPath); // normalize

  if (!resolvedPath.startsWith(allowedRoot)) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }

  // Must end in .apk
  if (!resolvedPath.endsWith('.apk')) {
    return NextResponse.json({ error: 'Only .apk files can be downloaded' }, { status: 400 });
  }

  try {
    await access(resolvedPath);
    const buffer = await readFile(resolvedPath);
    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Disposition': 'attachment; filename="app-release.apk"',
        'Content-Length': buffer.length.toString(),
      },
    });
  } catch {
    return NextResponse.json({ error: 'APK file not found' }, { status: 404 });
  }
}
