/**
 * Locate the installed Claude Code CLI executable.
 * Resolution order (first hit wins), so we never hardcode a single path:
 *   1. CLAUDE_CLI_PATH env var (explicit override)
 *   2. PATH lookup (`command -v claude` / `which claude`)
 *   3. Common install locations (Homebrew Apple Silicon + Intel, npm global, ~/.local)
 * Returns the absolute path, or null if not found.
 */
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';

let _cached: string | null | undefined;

export function detectClaudeCli(): string | null {
  if (_cached !== undefined) return _cached;

  const env = process.env.CLAUDE_CLI_PATH?.trim();
  if (env && existsSync(env)) return (_cached = env);

  for (const cmd of ['command -v claude', 'which claude']) {
    try {
      const out = execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
        .trim().split('\n')[0];
      if (out && existsSync(out)) return (_cached = out);
    } catch { /* not on PATH */ }
  }

  const candidates = [
    '/opt/homebrew/bin/claude',                 // macOS Apple Silicon (Homebrew)
    '/usr/local/bin/claude',                    // macOS Intel / Linux
    '/usr/bin/claude',
    join(homedir(), '.claude', 'local', 'claude'),
    join(homedir(), '.local', 'bin', 'claude'),
    join(homedir(), '.npm-global', 'bin', 'claude'),
  ];
  for (const c of candidates) if (existsSync(c)) return (_cached = c);

  return (_cached = null);
}

/** For diagnostics: the detected path + how it was found. */
export function claudeCliInfo(): { path: string | null; source: string } {
  const p = detectClaudeCli();
  if (!p) return { path: null, source: 'not found' };
  if (process.env.CLAUDE_CLI_PATH?.trim() === p) return { path: p, source: 'CLAUDE_CLI_PATH' };
  return { path: p, source: 'auto-detected' };
}

export function resetClaudeCliCache(): void { _cached = undefined; }
