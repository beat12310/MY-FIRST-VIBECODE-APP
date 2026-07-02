/**
 * Real HTTP probe against a live preview server — the SINGLE implementation
 * shared by orchestrator.ts (the runtime verify pass) and repairer.ts's
 * default wiring (so repair's own internal re-verify loop can also become
 * runtime-aware once a preview exists). Two independent copies of "how do we
 * check if a live route is healthy" is exactly the kind of divergence that
 * let repairStatus and verifyStatus disagree — this file exists so there is
 * only ever one.
 *
 * Per-request timeout is generous (30s), not the usual few-second budget —
 * Next.js dev mode compiles each route lazily on its FIRST request, so the
 * very first hit to a given page/route can legitimately take much longer
 * than a warm request.
 */
export interface ProbeRequest { method?: string; path: string; headers?: Record<string, string>; body?: string }
export interface ProbeResponse { status: number; body: string; ms: number; ok: boolean; error?: string }

export function makeHttpProbe(baseUrl: string): (req: ProbeRequest) => Promise<ProbeResponse> {
  return async (req: ProbeRequest): Promise<ProbeResponse> => {
    const t0 = Date.now();
    try {
      const res = await fetch(`${baseUrl}${req.path}`, {
        method: req.method ?? 'GET',
        headers: req.body ? { 'Content-Type': 'application/json', ...(req.headers ?? {}) } : req.headers,
        body: req.body,
        signal: AbortSignal.timeout(30_000),
      });
      const body = await res.text().catch(() => '');
      return { status: res.status, body, ms: Date.now() - t0, ok: res.status >= 200 && res.status < 300 };
    } catch (e) {
      return { status: 0, body: '', ms: Date.now() - t0, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
}
