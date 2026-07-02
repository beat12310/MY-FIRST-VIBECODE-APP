/**
 * GET /api/engine-build-stream?prompt=…[&force=1]  — Server-Sent Events, NEW engine.
 *
 * Streams live stage progress (planning → building → verifying → repairing →
 * preview) and the final EngineReport.
 *
 * SINGLE-FLIGHT GUARANTEE:
 *   Only ONE build pipeline may run per project (project = slug(prompt)) at a time.
 *   A duplicate request — EventSource auto-reconnect after a proxy/heartbeat drop,
 *   a browser refresh, a second tab, or a rapid re-click — does NOT start a second
 *   buildApp()/Bedrock stream. Instead it receives a `busy` event and closes.
 *   Pass ?force=1 to intentionally restart (the reason is logged).
 *
 *   Every log line carries the build session id (bs_…) for correlation.
 *
 * Test/diagnostic endpoint for the engine panel only. Does not touch billing,
 * Paystack, auth, deployment, the Planner, or the Builder.
 */
import { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const prompt = req.nextUrl.searchParams.get('prompt')?.trim();
  if (!prompt) return new Response('Missing prompt', { status: 400 });
  const force = req.nextUrl.searchParams.get('force') === '1';

  const {
    projectKeyFromPrompt, newSessionId, tryAcquire, forceAcquire, release, getActiveBuild,
  } = await import('@/services/engine/build-registry');

  const projectKey = projectKeyFromPrompt(prompt);
  const sessionId = newSessionId();
  const log = (m: string) => console.log(`[engine-build-stream][${sessionId}][${projectKey}] ${new Date().toISOString()} ${m}`);

  // ── Single-flight acquisition BEFORE any pipeline work ──────────────────────
  let owns = false;
  if (force) {
    const { displaced } = forceAcquire(projectKey, sessionId, prompt);
    owns = true;
    // Requirement 6: log why a second build was started intentionally.
    log(`FORCE build start — displacing ${displaced ? `active session ${displaced.sessionId} (age ${Date.now() - displaced.startedAt}ms)` : 'no active session'}. Reason: client sent force=1.`);
  } else {
    const res = tryAcquire(projectKey, sessionId, prompt);
    if (!res.ok) {
      // Requirement 5: ignore the new request while another build is active.
      const other = res.active;
      log(`REJECTED duplicate build — project already building under session ${other.sessionId} (age ${Date.now() - other.startedAt}ms). Not starting a second pipeline.`);
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          const send = (event: string, data: unknown) =>
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          send('busy', {
            projectKey,
            activeSessionId: other.sessionId,
            startedAt: other.startedAt,
            message: 'A build is already running for this project. Ignoring the duplicate request.',
          });
          controller.close();
        },
      });
      return new Response(body, { headers: sseHeaders() });
    }
    owns = true;
    log('ACQUIRED build lock — single active pipeline for this project.');
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let released = false;
      const doRelease = () => { if (owns && !released) { released = true; release(projectKey, sessionId); log('RELEASED build lock.'); } };
      const send = (event: string, data: unknown) => {
        try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { /* closed */ }
      };
      const heartbeat = setInterval(() => send('ping', { t: Date.now(), sessionId }), 15_000);
      log('pipeline START');
      try {
        send('stage', { stage: 'plan', message: 'Planning architecture', sessionId });
        const { runEngineBuild } = await import('@/services/engine/orchestrator');
        const report = await runEngineBuild(prompt, undefined, undefined, (stage, message) => {
          send('stage', { stage, message, sessionId });
        }, sessionId);
        send('report', { ...report, sessionId });
        send('done', { status: report.status, success: report.success, sessionId });
        log(`pipeline DONE — status=${report.status}, success=${report.success}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        send('error', { error: msg, sessionId });
        log(`pipeline ERROR — ${msg}`);
      } finally {
        clearInterval(heartbeat);
        // Release the lock only when the PIPELINE settles (not on client disconnect),
        // so a reconnect mid-build still sees the project as busy.
        doRelease();
        controller.close();
      }
    },
    cancel() {
      // Client disconnected. Do NOT release here — the server pipeline is still
      // running; releasing would let a reconnect start a duplicate build. The lock
      // is freed when the pipeline settles (or by the stale-eviction TTL).
      log('client disconnected (stream cancelled) — pipeline continues, lock retained.');
    },
  });

  return new Response(stream, { headers: sseHeaders() });
}

function sseHeaders(): HeadersInit {
  return {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  };
}
