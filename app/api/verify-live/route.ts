/**
 * /api/verify-live — Server-Sent Events (SSE) endpoint for live verification.
 *
 * Streams real-time verification events as the browser journey and link crawler
 * run, so the builder's Preview panel can navigate the iframe to match what
 * Playwright is testing and show a live step log.
 *
 * Query params:
 *   port         — port the generated app is running on
 *   projectPath  — absolute path to the generated project
 *   projectType  — optional: marketplace | booking | social | generic
 *   maxPages     — optional: max pages for the link crawler (default 15)
 */

import type { VerifyLiveEvent } from '@/services/verify-live-types';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const port        = parseInt(searchParams.get('port') ?? '0');
  const projectPath = searchParams.get('projectPath') ?? '';
  const maxPages    = parseInt(searchParams.get('maxPages') ?? '15');
  let projectType   = (searchParams.get('projectType') ?? 'generic') as 'marketplace' | 'booking' | 'social' | 'generic';

  if (!port || !projectPath) {
    return new Response('Missing port or projectPath', { status: 400 });
  }

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      function send(event: VerifyLiveEvent) {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch { /* stream already closed */ }
      }

      try {
        // Detect project type from discovery (same logic as run-browser-journey action)
        try {
          const { discoverProject } = await import('@/services/project-discovery');
          const { detectProjectType } = await import('@/services/journey-tester');
          const disc = await discoverProject(projectPath);
          const name = projectPath.split('/').pop() ?? '';
          const detected = detectProjectType(name, disc.apiRoutes ?? [], disc.pages ?? []);
          if (['marketplace', 'booking', 'social'].includes(detected)) {
            projectType = detected as typeof projectType;
          }
        } catch { /* default to generic */ }

        // ── Phase 1: Browser Journey ──────────────────────────────────────────
        send({ type: 'phase', phase: 'journey', message: 'Starting browser journey verification…' });

        const { runBrowserJourney } = await import('@/services/browser-journey-runner');
        const baseUrl = `http://localhost:${port}`;

        const journeyResult = await runBrowserJourney(baseUrl, projectType, send).catch((err) => {
          send({ type: 'error', message: `Journey runner error: ${err instanceof Error ? err.message : String(err)}` });
          return null;
        });

        const journeyVerdict   = journeyResult?.verdict ?? 'SKIPPED';
        const journeyFailedAt  = journeyResult?.failedAt;
        const journeyFailedReqs = journeyResult
          ? (journeyResult.steps ?? []).flatMap((s) => s.failedRequests ?? []).length
          : 0;

        send({
          type: 'journey-complete',
          verdict: journeyVerdict,
          passCount: (journeyResult?.steps ?? []).filter(s => s.passed).length,
          totalSteps: (journeyResult?.steps ?? []).length,
          failedAt: journeyFailedAt,
          failedRequests: journeyFailedReqs,
          durationMs: journeyResult?.totalDurationMs ?? 0,
        });

        if (closed) return;

        // ── Phase 2: Link Crawler ─────────────────────────────────────────────
        send({ type: 'phase', phase: 'crawl', message: 'Crawling all links and buttons for 404 errors…' });

        const { crawlLinks } = await import('@/services/link-crawler');

        const crawlReport = await crawlLinks(baseUrl, projectPath, {
          maxPages,
          maxLinksPerPage: 8,
          timeoutMs: 90_000,
          onEvent: send,
        }).catch(() => null);

        send({
          type: 'crawl-complete',
          verdict: crawlReport?.verdict ?? 'SKIPPED',
          passedLinks: crawlReport?.passed.length ?? 0,
          failedLinks: crawlReport?.failed.length ?? 0,
          pagesVisited: crawlReport?.pagesVisited.length ?? 0,
          missingRouteFiles: crawlReport?.missingRouteFiles ?? [],
          durationMs: crawlReport?.durationMs ?? 0,
        });

        // ── Final summary event ───────────────────────────────────────────────
        send({
          type: 'complete',
          journeyVerdict,
          journeyFailedAt,
          journeyFailedRequests: journeyFailedReqs,
          journeySteps: (journeyResult?.steps ?? []).map(s => ({
            step: s.step,
            passed: s.passed,
            optional: s.optional,
            durationMs: s.durationMs,
            screenshotUrl: s.screenshotPath,
            error: s.error,
          })),
          journeyMetrics: journeyResult?.metrics ?? { formsTested: 0, loginTests: 0, logoutTests: 0, searchTests: 0 },
          crawlVerdict: crawlReport?.verdict ?? 'SKIPPED',
          crawlPassedLinks: crawlReport?.passed.length ?? 0,
          crawlFailedLinks: crawlReport?.failed.length ?? 0,
          crawlMissingRouteFiles: crawlReport?.missingRouteFiles ?? [],
          crawlPagesVisited: crawlReport?.pagesVisited.length ?? 0,
        });

      } catch (err) {
        send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        if (!closed) controller.close();
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
