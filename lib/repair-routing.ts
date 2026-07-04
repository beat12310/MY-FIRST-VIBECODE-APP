/**
 * DWOMOH Vibe Code — repair-vs-build routing decision, for when a project is
 * already open (app/builder/page.tsx's `if (currentProject) {...}` block).
 *
 * Extracted so the exact decision users hit in practice ("demo login is
 * invalid" while a project is open must route to repair, never to "what kind
 * of app is this?") is a pure function with no React state/network calls,
 * and therefore permanently unit-testable — see
 * lib/__tests__/repair-routing.test.ts. The actual side-effecting actions
 * (calling the scan-and-repair API, running the edit pipeline, etc.) stay in
 * page.tsx; this module only decides WHICH one to take.
 */
import type { MessageIntent } from './intent-classifier';

export type ProjectOpenRoute =
  | 'web_research'
  | 'logo_request'
  | 'logo_edit'
  | 'research'
  | 'scan_and_repair_routes'
  | 'edit_pipeline'
  | 'new_build';

// Extended per explicit requirement: "invalid" (e.g. "demo email and
// password is invalid"), "failed" (e.g. "login failed"), and a bare "stuck"
// (not just "stuck on") are common, everyday ways a user reports a problem
// with the app they already have open.
//
// ROOT CAUSE fix (found by this module's own regression test): this matched
// "blank page" but not the equally common reverse phrasing "page is blank"/
// "settings page is blank" — one of the exact example messages the user
// explicitly listed as an expected repair report. Added "is/looks blank" as
// its own alternative rather than only the fixed "blank page" phrase order.
export const REPORTS_BROKEN_RE = /\b(404|not found|broken|not working|doesn't work|won't load|blank page|is blank|looks blank|white screen|shows? (a |an )?(404|error|blank)|preview shows|page not found|can'?t (see|access|open|reach)|crashed|failed to load|loading forever|stuck( on)?|keeps? (failing|crashing)|error page|something('?s| is) wrong|nothing (loads?|shows?|appears?)|invalid|login (failed|is invalid)|(is|was) invalid|\bfailed\b)\b/i;

const REPORTS_ROUTING_RE = /\b(404|page not found|links? (are |is )?(broken|not working)|navigation|clicking|click|button|dashboard not|can'?t (navigate|open|reach|get to)|routing|routes?)\b/i;

export interface ProjectOpenRoutingParams {
  projectIntent: MessageIntent;
  /** True if the app currently has a live preview running (buildProgress.port or currentProject.port). */
  appRunning: boolean;
  /** True only when BOTH a live project path and a live port are available to scan against. */
  hasLivePathAndPort: boolean;
  userMessage: string;
}

/**
 * Decides where a message goes when a project is already open. Only called
 * from inside page.tsx's `if (currentProject) {...}` gate — this function
 * has no opinion on what happens when no project is open at all.
 *
 * ROOT CAUSE this protects against: detectIntent's long-detailed-spec
 * heuristic (12+ words + any app-vocabulary word like "dashboard") cannot
 * distinguish "build a NEW dashboard app" from "fix bugs in the dashboard of
 * the app I already have open." A "build" classification while a project is
 * open normally means the user wants a NEW app — EXCEPT when they're also
 * reporting a problem with the currently-open app, which always takes
 * priority (confirmed live, more than once, across several differently-
 * worded bug reports).
 */
export function decideProjectOpenRouting(params: ProjectOpenRoutingParams): ProjectOpenRoute {
  const { projectIntent, appRunning, hasLivePathAndPort, userMessage } = params;

  if (projectIntent === 'web_research') return 'web_research';
  if (projectIntent === 'logo_request') return 'logo_request';
  if (projectIntent === 'logo_edit') return 'logo_edit';
  if (projectIntent === 'research') return 'research';

  const reportsBroken = REPORTS_BROKEN_RE.test(userMessage);

  if (projectIntent !== 'build' || (appRunning && reportsBroken)) {
    if (appRunning && reportsBroken && hasLivePathAndPort) return 'scan_and_repair_routes';
    return 'edit_pipeline';
  }
  // 'build' intent with no problem being reported — user wants a brand new app.
  return 'new_build';
}

/** Whether a scan-and-repair-routes attempt's message also mentions routing/navigation specifically. */
export function reportsRoutingProblem(userMessage: string): boolean {
  return REPORTS_ROUTING_RE.test(userMessage);
}
