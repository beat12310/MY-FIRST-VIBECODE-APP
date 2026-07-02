/**
 * Streaming project-file parser for the NEW engine Builder.
 *
 * The model emits files as `[FILE: path]\n<content>` blocks, optionally wrapped in
 * `[START_PROJECT]` … `[END_PROJECT]`. The old `parseProjectFormat` REQUIRED the
 * wrapper and returned 0 files when the model omitted it — forcing a costly second
 * Bedrock "fill" call. This parser:
 *   - extracts `[FILE:]` blocks WITH OR WITHOUT the wrapper,
 *   - can consume the response INCREMENTALLY (as Bedrock streams), emitting each
 *     file the instant its next delimiter (or end-of-stream) arrives,
 *   - handles a `[FILE:` marker split across two stream chunks.
 *
 * Pure and dependency-free → fully unit-testable without Bedrock.
 */
export interface ParsedFile { path: string; content: string }

const FILE_MARK = '[FILE:';
const cleanContent = (s: string): string =>
  s.replace(/\[END_PROJECT\][\s\S]*$/, '').replace(/^\r?\n/, '').replace(/\s+$/, '');

/** Whole-string extraction (wrapper optional). Used for the non-streaming path. */
export function extractProjectFiles(text: string): ParsedFile[] {
  let body = text;
  const start = body.indexOf('[START_PROJECT]');
  if (start !== -1) body = body.slice(start + '[START_PROJECT]'.length);
  const files: ParsedFile[] = [];
  const parts = body.split(/\[FILE:\s*/);
  for (let i = 1; i < parts.length; i++) {
    const close = parts[i].indexOf(']');
    if (close === -1) continue;
    const path = parts[i].slice(0, close).trim();
    const content = cleanContent(parts[i].slice(close + 1));
    if (path && content) files.push({ path, content });
  }
  return files;
}

/**
 * Incremental parser. Feed it `push(delta)` as Bedrock streams; it invokes
 * `onFile(index, path, content)` the moment each file is complete (i.e. when the
 * next `[FILE:` marker begins, or on `end()`).
 */
export class StreamingProjectParser {
  private buffer = '';
  private pendingPath: string | null = null;
  private pendingContent = '';
  private count = 0;
  private onFile: (index: number, path: string, content: string) => void;

  constructor(onFile: (index: number, path: string, content: string) => void) {
    this.onFile = onFile;
  }

  get fileCount(): number { return this.count; }

  push(delta: string): void {
    this.buffer += delta;

    // Drop the wrapper marker if it appears.
    const sp = this.buffer.indexOf('[START_PROJECT]');
    if (sp !== -1) this.buffer = this.buffer.slice(sp + '[START_PROJECT]'.length);

    // Consume every COMPLETE file-boundary currently in the buffer.
    for (;;) {
      const mark = this.buffer.indexOf(FILE_MARK);
      if (mark === -1) break;

      // Text before this marker belongs to the currently-open file (if any).
      if (this.pendingPath !== null) {
        this.pendingContent += this.buffer.slice(0, mark);
        this.emit();
      }

      const rest = this.buffer.slice(mark + FILE_MARK.length);
      const close = rest.indexOf(']');
      if (close === -1) {
        // Marker's path not fully arrived yet — keep from the marker and wait.
        this.buffer = this.buffer.slice(mark);
        return;
      }
      this.pendingPath = rest.slice(0, close).trim();
      this.pendingContent = '';
      this.buffer = rest.slice(close + 1);
    }

    // No more complete markers. Flush most of the buffer into the open file, but
    // KEEP a small tail in case a '[FILE:' marker is split across chunks.
    const keep = FILE_MARK.length;
    if (this.buffer.length > keep) {
      if (this.pendingPath !== null) this.pendingContent += this.buffer.slice(0, this.buffer.length - keep);
      this.buffer = this.buffer.slice(this.buffer.length - keep);
    }
  }

  end(): void {
    if (this.pendingPath !== null) {
      this.pendingContent += this.buffer;
      this.buffer = '';
      this.emit();
    }
  }

  private emit(): void {
    const path = (this.pendingPath ?? '').trim();
    const content = cleanContent(this.pendingContent);
    this.pendingPath = null;
    this.pendingContent = '';
    if (path && content) { this.count++; this.onFile(this.count, path, content); }
  }
}
