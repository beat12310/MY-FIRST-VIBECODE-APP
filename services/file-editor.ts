import { writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { logError } from '@/lib/error-handler';

export interface EditedFile {
  path: string;
  content: string;
}

export interface ApplyEditsResult {
  success: boolean;
  filesChanged: string[];
  errors: string[];
}

// Parse [EDIT_START]...[EDIT_END] format returned by the AI editor
export function parseEditFormat(aiResponse: string): EditedFile[] {
  // Try [EDIT_START]...[EDIT_END] first
  const editStart = aiResponse.indexOf('[EDIT_START]');
  const editEnd = aiResponse.indexOf('[EDIT_END]');
  if (editStart !== -1 && editEnd !== -1) {
    return extractFilesFromBlock(aiResponse.slice(editStart + '[EDIT_START]'.length, editEnd));
  }

  // Fallback: [START_PROJECT]...[END_PROJECT]
  const projStart = aiResponse.indexOf('[START_PROJECT]');
  const projEnd = aiResponse.indexOf('[END_PROJECT]');
  if (projStart !== -1 && projEnd !== -1) {
    const block = aiResponse.slice(projStart + '[START_PROJECT]'.length, projEnd);
    return extractFilesFromBlock(block, /* skipMeta */ true);
  }

  return [];
}

function extractFilesFromBlock(block: string, skipMeta = false): EditedFile[] {
  const files: EditedFile[] = [];
  const filePattern = /\[FILE:\s*([^\]]+)\]\n([\s\S]*?)(?=\n?\[FILE:|$)/g;

  let match: RegExpExecArray | null;
  while ((match = filePattern.exec(block)) !== null) {
    const path = match[1].trim();
    const content = match[2].trimEnd();
    // Skip metadata lines that look like [FILE: name: project-foo]
    if (skipMeta && (path.startsWith('name:') || path.startsWith('description:'))) continue;
    // Skip obviously invalid paths
    if (!path || path.includes('\n') || path.length > 200) continue;
    if (content) {
      files.push({ path, content });
    }
  }

  return files;
}

// Write edited files directly into the existing project
export async function applyEditsToProject(
  projectPath: string,
  files: EditedFile[]
): Promise<ApplyEditsResult> {
  const filesChanged: string[] = [];
  const errors: string[] = [];

  for (const file of files) {
    try {
      const absPath = join(projectPath, file.path);
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, file.content, 'utf-8');
      filesChanged.push(file.path);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      errors.push(`Failed to write ${file.path}: ${msg}`);
      logError(`Failed to apply edit to ${file.path}`, err);
    }
  }

  return { success: errors.length === 0, filesChanged, errors };
}
