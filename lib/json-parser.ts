export interface ParseResult {
  success: boolean;
  data: any;
  error?: string;
}

export interface ProjectFileData {
  path: string;
  content: string;
}

export interface ProjectData {
  projectName: string;
  description: string;
  mode: string;
  files: ProjectFileData[];
}

// ─── Delimiter-format parser ───────────────────────────────────────────────
// The build prompt asks the AI to use [START_PROJECT] ... [END_PROJECT] with
// [FILE: path] sections. This avoids ALL JSON-escaping problems in code content.

export function parseProjectFormat(text: string): ProjectData | null {
  const startTag = '[START_PROJECT]';
  const endTag = '[END_PROJECT]';

  const startIdx = text.indexOf(startTag);
  if (startIdx === -1) return null;

  const endIdx = text.indexOf(endTag);
  const inner = text.slice(
    startIdx + startTag.length,
    endIdx !== -1 ? endIdx : text.length
  );

  // Split on [FILE: to get metadata block + per-file blocks
  const parts = inner.split(/\[FILE:\s*/);
  const metaBlock = parts[0];

  const nameMatch = metaBlock.match(/^name:\s*(.+)$/m);
  const descMatch = metaBlock.match(/^description:\s*(.+)$/m);
  const modeMatch = metaBlock.match(/^mode:\s*(.+)$/m);

  const projectName = (nameMatch?.[1] ?? '').trim() || 'generated-app';
  const description = (descMatch?.[1] ?? '').trim();
  const mode = (modeMatch?.[1] ?? '').trim() || 'Full-Stack App';

  const files: ProjectFileData[] = [];

  for (let i = 1; i < parts.length; i++) {
    const bracketClose = parts[i].indexOf(']');
    if (bracketClose === -1) continue;

    const filePath = parts[i].slice(0, bracketClose).trim();
    const fileContent = parts[i].slice(bracketClose + 1).trim();

    if (filePath && fileContent) {
      files.push({ path: filePath, content: fileContent });
    }
  }

  if (files.length === 0) return null;

  return { projectName, description, mode, files };
}

// ─── Tolerant fallback file extractor ──────────────────────────────────────
// When the model ignores the strict [START_PROJECT]/[FILE:] format and instead
// returns a "FULL BUILD SPECIFICATION" with code blocks (a common failure mode),
// recover real files so we still build a real app instead of a placeholder.
// Recognizes: (1) <file path="...">…</file>, (2) a path label line
// (**path**, ### path, `path`, File: path, path:) right before a fenced block,
// (3) a path given as the first-line comment inside a fenced block.
const PROJECT_PATH = String.raw`(?:src\/)?(?:app|components|lib|pages|services|public|styles)\/[\w./\-\[\]]+\.\w+|package\.json|next\.config\.\w+|tsconfig\.json|tailwind\.config\.\w+|postcss\.config\.\w+|middleware\.ts`;

export function parseLooseProjectFiles(text: string): ProjectFileData[] {
  const files: ProjectFileData[] = [];
  const seen = new Set<string>();
  const looksLikePath = new RegExp(`^(?:${PROJECT_PATH})$`);

  const add = (rawPath: string, rawContent: string) => {
    const path = rawPath.trim().replace(/^["'`]+|["'`:]+$/g, '').replace(/^\.\//, '');
    const content = rawContent.replace(/\s+$/, '').trim();
    if (!path || !content || seen.has(path)) return;
    if (!looksLikePath.test(path)) return;            // only accept real project paths
    seen.add(path);
    files.push({ path, content });
  };

  // 1. Explicit <file path="...">...</file> blocks (edit format).
  const fileTag = /<file\s+path=["']([^"']+)["']\s*>([\s\S]*?)<\/file>/gi;
  let m: RegExpExecArray | null;
  while ((m = fileTag.exec(text))) add(m[1], m[2]);
  if (files.length) return files;

  // 2 & 3. Fenced code blocks with a nearby path label or first-line comment.
  const fence = /```[a-zA-Z0-9]*\n([\s\S]*?)```/g;
  let lastIndex = 0;
  const labelRe = new RegExp(`(?:^|\\n)\\s*(?:\\*\\*|#{1,4}\\s*|File:\\s*|Path:\\s*|\`)?\\s*(${PROJECT_PATH})\\s*(?:\\*\\*|\`)?\\s*:?\\s*$`);
  const commentRe = new RegExp(`^\\s*(?:\\/\\/|#|\\/\\*)\\s*(${PROJECT_PATH})\\s*(?:\\*\\/)?\\s*$`);
  while ((m = fence.exec(text))) {
    const block = m[1];
    const before = text.slice(lastIndex, m.index);
    lastIndex = fence.lastIndex;
    const label = before.match(labelRe);
    if (label) { add(label[1], block); continue; }
    const firstLine = block.split('\n', 1)[0];
    const cm = firstLine.match(commentRe);
    if (cm) add(cm[1], block.split('\n').slice(1).join('\n'));
  }
  return files;
}

// ─── Character-by-character string fixer ──────────────────────────────────
// Fixes unescaped newlines/tabs/carriage-returns inside JSON string values
// WITHOUT touching structural JSON whitespace (the old repairJSON got this wrong).

function fixUnescapedCharsInStrings(text: string): string {
  const out: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      out.push(ch);
      escaped = false;
      continue;
    }

    if (ch === '\\' && inString) {
      out.push(ch);
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      out.push(ch);
      continue;
    }

    if (inString) {
      if (ch === '\n') { out.push('\\n'); continue; }
      if (ch === '\r') { out.push('\\r'); continue; }
      if (ch === '\t') { out.push('\\t'); continue; }
    }

    out.push(ch);
  }

  return out.join('');
}

// ─── Bracket-matching JSON extractor ──────────────────────────────────────
// More reliable than the /{[\s\S]*}/ regex which grabs from first { to last }.

function extractOutermostJSON(text: string): string | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        return text.slice(start, i + 1);
      }
    }
  }

  // Truncated: return everything from start to end (partial JSON)
  if (start !== -1 && depth > 0) return text.slice(start);
  return null;
}

// ─── Truncation recovery ──────────────────────────────────────────────────
// When the model hits the token limit the JSON is cut off mid-value.
// Close any open string then close open braces/brackets.

function closeTruncatedJSON(text: string): string {
  let inString = false;
  let escaped = false;
  const depth: ('{' | '[')[] = [];

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') depth.push(ch);
    else if (ch === '}' || ch === ']') depth.pop();
  }

  let recovered = text.trimEnd();
  if (inString) recovered += '"';              // close open string
  for (let i = depth.length - 1; i >= 0; i--) {
    recovered += depth[i] === '{' ? '}' : ']'; // close open containers
  }
  return recovered;
}

// ─── Main JSON parser ──────────────────────────────────────────────────────

export function parseJSON(text: string): ParseResult {
  if (!text || typeof text !== 'string') {
    return { success: false, data: null, error: 'Input must be a non-empty string' };
  }

  const attempt = (src: string) => {
    try { return { success: true, data: JSON.parse(src) }; } catch { return null; }
  };

  // 1. Direct parse
  const d1 = attempt(text);
  if (d1) return d1;

  // 2. Extract from markdown code block, then parse
  const codeBlock = text.match(/```(?:json)?\n?([\s\S]*?)\n?```/);
  if (codeBlock) {
    const d2 = attempt(codeBlock[1]);
    if (d2) return d2;
    const d2b = attempt(fixUnescapedCharsInStrings(codeBlock[1]));
    if (d2b) return d2b;
  }

  // 3. Bracket-match to find the outermost object, then parse
  const extracted = extractOutermostJSON(text);
  if (extracted) {
    const d3 = attempt(extracted);
    if (d3) return d3;

    // 4. Fix unescaped chars inside strings, then parse
    const fixed = fixUnescapedCharsInStrings(extracted);
    const d4 = attempt(fixed);
    if (d4) return d4;

    // 5. Recover from truncation, then parse (with and without char fix)
    const recovered = closeTruncatedJSON(extracted);
    const d5 = attempt(recovered);
    if (d5) return d5;

    const recoveredFixed = fixUnescapedCharsInStrings(recovered);
    const d5b = attempt(recoveredFixed);
    if (d5b) return d5b;

    // 6. Strip trailing commas then parse
    const stripped = extracted.replace(/,(\s*[}\]])/g, '$1');
    const d6 = attempt(stripped);
    if (d6) return d6;

    const strippedFixed = fixUnescapedCharsInStrings(stripped);
    const d6b = attempt(strippedFixed);
    if (d6b) return d6b;
  }

  return { success: false, data: null, error: 'Could not parse JSON from provided text' };
}

export function validateBuildResponse(data: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!data.projectName) errors.push('Missing: projectName');
  if (!Array.isArray(data.files)) {
    errors.push('Missing: files array');
  } else {
    data.files.forEach((file: any, index: number) => {
      if (!file.path) errors.push(`File ${index}: missing path`);
      if (!file.content && file.content !== '') errors.push(`File ${index}: missing content`);
    });
  }
  return { valid: errors.length === 0, errors };
}

export function validateChatResponse(data: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!data.response && typeof data.response !== 'string') {
    errors.push('Missing: response field');
  }
  return { valid: errors.length === 0, errors };
}
