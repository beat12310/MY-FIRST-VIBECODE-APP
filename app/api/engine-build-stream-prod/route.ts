/**
 * GET /api/engine-build-stream-prod?prompt=…&originalPrompt=…[&force=1] — SSE,
 * production entrypoint for the Send button's build flow.
 *
 * Same single-flight + streaming skeleton as app/api/engine-build-stream/route.ts
 * (the "Engine Build/Test" debug panel's route), but:
 *   - resolves the authenticated user and runs the SAME credit pre-check
 *     app/api/chat/route.ts's action:'create' handler ran, BEFORE acquiring
 *     the build lock (so a build that will be rejected for lack of credits
 *     never occupies the single-flight slot or spends a Bedrock call).
 *   - uses services/engine-adapter.ts's runProductionEngineBuild(), which
 *     wraps the repaired engine's `build` stage with the same project-
 *     persistence side effects the old action:'create' handler ran
 *     (saveProject, initProjectMemory, recordBuild, credit deduction,
 *     safe-tsconfig overwrite, optional saveSpec) — so the Send button gets
 *     billing + project-manifest parity with today's pipeline.
 *   - includes a parsed `port` field in the final `report` event so the
 *     client never has to parse `previewUrl` itself.
 *
 * Behind a server-side flag (see app/builder/page.tsx's runBuildPipeline) —
 * this route existing does not change the old Send-button behavior on its
 * own until the client is wired to call it.
 */
import { NextRequest } from 'next/server';
import { getAuthUser } from '@/lib/server-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const prompt = req.nextUrl.searchParams.get('prompt')?.trim();
  if (!prompt) return new Response('Missing prompt', { status: 400 });
  const originalPrompt = req.nextUrl.searchParams.get('originalPrompt')?.trim() || prompt;
  const force = req.nextUrl.searchParams.get('force') === '1';

  // EventSource cannot set custom headers, so the client passes the auth
  // token as ?token=… — same fallback pattern already established in
  // app/api/claude-bridge/route.ts:377-382 for the same reason.
  const authHeader = req.headers.get('authorization') ?? (
    req.nextUrl.searchParams.get('token') ? `Bearer ${req.nextUrl.searchParams.get('token')}` : null
  );
  const authUser = authHeader
    ? await getAuthUser({ headers: new Headers({ authorization: authHeader }) } as NextRequest)
    : null;
  const ownerUserId = authUser?.sub ?? 'anonymous';

  // ── Credit pre-check — mirrors app/api/chat/route.ts's action:'create'
  // gate exactly, run BEFORE the build lock is acquired or any Bedrock call
  // is made, so an out-of-credits request fails fast and cheaply.
  //
  // ROOT CAUSE fix: this previously returned a plain `application/json` 402
  // response. EventSource can ONLY parse `text/event-stream` bodies — any
  // other content-type (or non-2xx status without that header) makes it
  // fire a bare connection-level `error` event with no payload, which the
  // client then has no way to distinguish from an actual dropped
  // connection. Confirmed live: an out-of-credits rejection surfaced to the
  // user as "Connection to the build engine was lost," which is wrong on
  // BOTH counts — the connection wasn't lost (the server responded
  // immediately and deliberately), and the real reason (no credits) was
  // never shown. Fixed by returning a valid SSE stream with an explicit
  // `error` event carrying the real reason, matching the exact pattern the
  // "busy" (duplicate-build) case below already uses correctly. ──────────
  //
  // SUPER_ADMIN (and any future role granted BYPASS_CREDITS) skips this gate
  // entirely, permission-checked against the database via services/rbac.ts —
  // billing/credits remain fully enforced for every other account.
  let bypassCredits = false;
  if (ownerUserId !== 'anonymous') {
    try {
      const { hasPermission } = await import('@/services/rbac');
      bypassCredits = await hasPermission(ownerUserId, 'BYPASS_CREDITS');
    } catch { /* fail-safe: bypassCredits stays false */ }
  }
  if (ownerUserId !== 'anonymous' && !bypassCredits) {
    try {
      const { ensureInitialGrant, getBalance } = await import('@/services/credit-wallet');
      const { getOrCreateSubscription } = await import('@/services/subscription-manager');
      const { getPlan, CREDIT_CONFIG } = await import('@/lib/billing-config');
      await getOrCreateSubscription(ownerUserId, authUser?.email ?? '');
      await ensureInitialGrant(ownerUserId, getPlan('free').limits.monthlyCredits);
      const balance = await getBalance(ownerUserId);
      if (process.env.ENFORCE_CREDITS !== '0' && balance < CREDIT_CONFIG.generationCostCredits) {
        console.log(`[engine-build-stream-prod] REJECTED — out of credits (balance=${balance}, need=${CREDIT_CONFIG.generationCostCredits}) for owner=${ownerUserId}`);
        const encoder = new TextEncoder();
        const body = new ReadableStream({
          start(controller) {
            const send = (event: string, data: unknown) =>
              controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
            send('error', {
              error: 'You are out of credits. Please top up to keep generating.',
              code: 'NO_CREDITS',
              balance,
              sessionId: 'no-credits',
            });
            controller.close();
          },
        });
        return new Response(body, { headers: sseHeaders() });
      }
    } catch (e) {
      console.warn('[engine-build-stream-prod] credit pre-check skipped (fail-open):', e instanceof Error ? e.message : e);
    }
  }

  const {
    projectKeyFromPrompt, newSessionId, tryAcquire, forceAcquire, release, publish, subscribe,
  } = await import('@/services/engine/build-registry');

  const projectKey = projectKeyFromPrompt(`${ownerUserId}:${prompt}`);
  const sessionId = newSessionId();
  const log = (m: string) => console.log(`[engine-build-stream-prod][${sessionId}][${projectKey}] ${new Date().toISOString()} ${m}`);

  let owns = false;
  if (force) {
    const { displaced } = forceAcquire(projectKey, sessionId, prompt);
    owns = true;
    log(`FORCE build start — displacing ${displaced ? `active session ${displaced.sessionId}` : 'no active session'}.`);
  } else {
    const res = tryAcquire(projectKey, sessionId, prompt);
    if (!res.ok) {
      // ROOT CAUSE fix: this used to reject with a one-shot 'busy' event and
      // immediately close the stream — a dead end. But this module's own
      // original comment already anticipated "EventSource auto-reconnect
      // after a proxy/heartbeat drop" as a normal scenario, and confirmed
      // live: a real ~14-minute build completed successfully server-side
      // (logged HTTP 200), yet the client showed "Connection to the build
      // engine was lost" partway through — the browser's EventSource had
      // reconnected (or the network/tab blipped), and that reconnect hit
      // this dead end instead of resuming the still-running build. Fixed:
      // a reconnect for the SAME project now subscribes to the active
      // build's live event broadcast (services/engine/build-registry.ts's
      // publish/subscribe) instead of being rejected, so it keeps receiving
      // stage/report/done events until the build actually finishes.
      const other = res.active;
      log(`RECONNECTING to already-running build — session ${other.sessionId} (started ${new Date(other.startedAt).toISOString()}).`);
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          let closed = false;
          const safeClose = () => { if (!closed) { closed = true; try { controller.close(); } catch { /* already closed */ } } };
          const send = (event: string, data: unknown) => {
            try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { /* closed */ }
          };
          send('busy', {
            projectKey, activeSessionId: other.sessionId, startedAt: other.startedAt,
            message: 'Reconnected to the build already running for this project.',
          });
          const unsubscribe = subscribe(projectKey, (event, data) => {
            send(event, data);
            if (event === 'done' || event === 'error') { unsubscribe(); safeClose(); }
          });
        },
        cancel() { log('reconnected client disconnected — still subscribed to the original build in the background.'); },
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
      // Every event goes to THIS request's own stream AND is broadcast to
      // any reconnected subscribers for the same project (see the
      // reconnect branch above) — this is the one place events originate.
      const send = (event: string, data: unknown) => {
        try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { /* closed */ }
        publish(projectKey, event, data);
      };
      const heartbeat = setInterval(() => send('ping', { t: Date.now(), sessionId }), 15_000);
      log('pipeline START');
      try {
        send('stage', { stage: 'plan', message: 'Planning architecture', sessionId });
        const { runProductionEngineBuild } = await import('@/services/engine-adapter');
        const { report, projectId } = await runProductionEngineBuild(
          prompt,
          { ownerUserId, email: authUser?.email, originalPrompt },
          (stage, message) => send('stage', { stage, message, sessionId }),
          sessionId,
        );
        const port = report.previewUrl ? Number(new URL(report.previewUrl).port || '0') || null : null;
        send('report', { ...report, projectId, port, sessionId });
        send('done', { status: report.status, success: report.success, sessionId });
        log(`pipeline DONE — status=${report.status}, success=${report.success}, projectId=${projectId}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        send('error', { error: msg, sessionId });
        log(`pipeline ERROR — ${msg}`);
      } finally {
        clearInterval(heartbeat);
        doRelease();
        controller.close();
      }
    },
    cancel() {
      // NOTE: the pipeline continues and keeps publish()-ing regardless — a
      // reconnect (or the original tab coming back) will still see it.
      log('client disconnected (stream cancelled) — pipeline continues, lock retained, events still broadcast to any subscribers.');
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
