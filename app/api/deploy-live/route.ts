/**
 * POST /api/deploy-live        → start a one-click deploy, stream SSE progress
 * GET  /api/deploy-live        → get current deploy status (last run)
 *
 * SSE events emitted:
 *   { type: 'progress', pct: number, msg: string }
 *   { type: 'phase',    name: string }
 *   { type: 'step',     icon: string, label: string, detail?: string }
 *   { type: 'log',      msg: string }
 *   { type: 'error',    phase: string, msg: string }
 *   { type: 'complete', record: DeploymentRecord }
 *   { type: 'fatal',    msg: string }
 */

import { NextRequest } from 'next/server';
import { spawn } from 'child_process';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';

const ROOT         = process.cwd();
const HISTORY_FILE = join(ROOT, '.dwomoh', 'deployment-history.json');

// ─── GET — current status & history ─────────────────────────────────────────

export async function GET() {
  const history = readHistory();
  const latest  = history[0] ?? null;
  return Response.json({
    status:  latest?.status ?? 'none',
    history: history.slice(0, 10),
    latest,
  });
}

// ─── POST — start deploy ─────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const body    = await req.json().catch(() => ({}));
  const flags: string[] = [];
  if (body.skipBuild)  flags.push('--skip-build');
  if (body.noBrowser)  flags.push('--no-browser');
  if (body.rollback)   flags.push('--rollback', '--skip-build');

  const scriptPath = join(ROOT, 'scripts', 'one-click-deploy.mjs');
  if (!existsSync(scriptPath)) {
    return Response.json({ error: 'Deploy script not found' }, { status: 500 });
  }

  const encoder = new TextEncoder();
  const stream  = new ReadableStream({
    start(controller) {
      function send(event: object) {
        const line = `data: ${JSON.stringify(event)}\n\n`;
        controller.enqueue(encoder.encode(line));
      }

      const proc = spawn('node', [scriptPath, '--emit-json', ...flags], {
        cwd:  ROOT,
        env:  { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';

      proc.stdout.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            send(event);
          } catch {
            send({ type: 'log', msg: line });
          }
        }
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('close', (code: number) => {
        if (code !== 0 && !stderr.includes('FATAL')) {
          send({ type: 'fatal', msg: stderr.slice(-500) || `Process exited with code ${code}` });
        }
        send({ type: 'done', code });
        controller.close();
      });

      proc.on('error', (err: Error) => {
        send({ type: 'fatal', msg: err.message });
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

function readHistory() {
  try { return JSON.parse(readFileSync(HISTORY_FILE, 'utf8')); } catch { return []; }
}

export const maxDuration = 1800; // 30 min — covers full build + deploy cycle
export const dynamic     = 'force-dynamic';
