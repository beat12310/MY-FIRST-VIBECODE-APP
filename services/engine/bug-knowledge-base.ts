/**
 * DWOMOH Vibe Code — permanent engine bug knowledge base.
 *
 * Every confirmed engine bug (not an issue in one generated app — a defect
 * in the platform's own build/repair/verify/classify logic) gets an entry
 * here at the time it's fixed, alongside the permanent regression test that
 * protects it going forward. This is deliberately NOT auto-populated from
 * repair history or AI-derived — every entry here was root-caused and
 * confirmed by a human/agent working the specific incident; an
 * automatically-mined "knowledge base" would reintroduce exactly the risk
 * this exists to prevent (silently trusting an unverified pattern).
 *
 * `category: 'generated-app-repair'` entries are searched by repairer.ts
 * BEFORE it asks the model for a fresh fix (see searchKnowledgeBase below) —
 * these describe a failure pattern the repair engine can hit again in a
 * DIFFERENT generated app, so a matching entry's root cause and fix get
 * folded into the repair prompt as a strong hint. Other categories
 * (intent-classification, verification, other) are platform-code bugs with
 * no live "search before repairing" consumer — they're recorded here purely
 * for the historical record and cross-referencing, protected by their own
 * regression tests instead.
 */

export type BugCategory = 'generated-app-repair' | 'intent-classification' | 'verification' | 'other';

export interface BugKnowledgeEntry {
  id: string;
  title: string;
  category: BugCategory;
  rootCause: string;
  filesAffected: string[];
  fixApplied: string;
  verificationPerformed: string;
  regressionTest: string;
  dateFixed: string; // ISO date
  /** Keywords/phrases matched against a failure's text to find this entry again. */
  symptoms: string[];
}

export const BUG_KNOWLEDGE_BASE: BugKnowledgeEntry[] = [
  {
    id: 'prisma-db-ts-hallucination',
    title: "Generated app's lib/managed/db.ts rewritten to import an uninstalled Prisma client",
    category: 'generated-app-repair',
    rootCause:
      "A repair/edit cycle let the model overwrite the deterministically-injected lib/managed/db.ts " +
      "(better-sqlite3-based, written by injectManagedServices() at initial build) with its own " +
      "Prisma-based implementation. Nothing re-asserted these two foundational files after the " +
      "initial build — only the 4 auth API routes + middleware.ts had a re-injection fast-path.",
    filesAffected: ['lib/managed/db.ts', 'lib/managed/auth.ts', 'app/api/billing/route.ts (and any route importing db.ts)'],
    fixApplied:
      "Re-inject the exact deterministic MANAGED_DB_TS/MANAGED_AUTH_TS constants from " +
      "services/project-generator.ts (now exported) whenever verifier.ts's detectManagedServiceCorruption " +
      "flags either file as missing its required exports or importing an uninstalled package.",
    verificationPerformed:
      "Live: rewrote both files by hand for the affected app, ran npx tsc --noEmit (zero errors), " +
      "curl-tested every affected route (register, /api/auth/me, /api/billing, /api/reports, " +
      "/api/dashboard/stats, /api/billing/subscription) with a real registered user.",
    regressionTest: 'services/engine/__tests__/verifier.test.ts — detectManagedServiceCorruption describe block',
    dateFixed: '2026-07-01',
    symptoms: [
      "Module not found: Cannot resolve '@prisma/client'", 'prisma', '@prisma/client',
      'lib/managed/db.ts', 'lib/managed/auth.ts', 'demo email and password is invalid',
      'registerUser is not a function', 'loginUser is not a function', 'getAuthUser is not a function',
    ],
  },
  {
    id: 'managed-cookie-name-mismatch',
    title: "Generated routes read a cookie name that login/register never actually set",
    category: 'generated-app-repair',
    rootCause:
      "Register/login routes set a cookie named 'managed_token', but several other generated route " +
      "files (billing/[id], reports/[id], dashboard/stats, billing/subscription) independently read a " +
      "different, nonexistent cookie name 'auth-token' — no shared constant enforced consistency across " +
      "routes written at different times/by different repair passes.",
    filesAffected: ['app/api/billing/[id]/route.ts', 'app/api/reports/[id]/route.ts', 'app/api/dashboard/stats/route.ts', 'app/api/billing/subscription/route.ts'],
    fixApplied: "Corrected every affected route to read cookieStore.get('managed_token') matching what login/register actually set.",
    verificationPerformed: 'Live: curl-tested each affected route with a real auth cookie from a fresh register/login, confirmed 200s where previously 401.',
    regressionTest: '(not yet a standalone regression test — the underlying contract is exercised by the auth-template.ts routes, which consistently use managed_token)',
    dateFixed: '2026-07-01',
    symptoms: ['auth-token', 'managed_token', 'Unauthorized', '401', 'cookie'],
  },
  {
    id: 'nextjs15-async-dynamic-params',
    title: 'Dynamic route handlers used the Next.js 14 synchronous params signature under Next.js 15',
    category: 'generated-app-repair',
    rootCause:
      "billing/[id]/route.ts and reports/[id]/route.ts destructured params as a plain object " +
      "({ params: { id: string } }) instead of the Promise Next.js 15 requires " +
      "({ params: Promise<{ id: string }> }), causing a route-type constraint failure under tsc.",
    filesAffected: ['app/api/billing/[id]/route.ts', 'app/api/reports/[id]/route.ts'],
    fixApplied: "Changed RouteContext's params field to Promise<{ id: string }> and added `const { id } = await context.params;` at every call site.",
    verificationPerformed: 'Ran npx tsc --noEmit --skipLibCheck against the project; confirmed zero remaining route-type errors.',
    regressionTest: '(not yet a standalone regression test — would need a template-level check that generated dynamic routes always await context.params)',
    dateFixed: '2026-07-01',
    symptoms: ["ParamCheck<RouteContext>", 'params: { id: string }', 'Next.js 15', 'dynamic route'],
  },
  {
    id: 'greeting-prefix-swallows-build-request',
    title: 'A detailed build request opening with "Hi,"/"Hello," was classified as just a greeting',
    category: 'intent-classification',
    rootCause:
      "detectIntent's isGreeting check matched on the message PREFIX alone with no length guard, so " +
      "any message starting with a casual greeting word immediately returned 'greeting' regardless of " +
      "how much build-relevant content followed it.",
    filesAffected: ['lib/intent-classifier.ts (formerly inline in app/builder/page.tsx)'],
    fixApplied: 'Added the same words.length <= 6 guard the deployment/debug checks already used.',
    verificationPerformed: '7 unit tests covering the exact reported scenario plus regressions for genuine short greetings.',
    regressionTest: 'lib/__tests__/intent-classifier.test.ts — "greeting misclassification" describe block',
    dateFixed: '2026-07-01',
    symptoms: ['welcome message', 'example prompts', 'onboarding shown again', 'Hi, I want', 'Hello, I want'],
  },
  {
    id: 'apptype-substring-false-positive',
    title: "hasAppType matched short APP_TYPES entries as substrings inside unrelated words (email, password, profile)",
    category: 'intent-classification',
    rootCause:
      "hasAppType used plain .includes() against short (2-4 letter) APP_TYPES entries ('ai', 'pass', " +
      "'pro', 'go', 'io', 'net', 'dash', 'lab', 'hub', 'box', 'pad'), which match inside ordinary words " +
      "that contain those letters ('ai' inside email/paid/main/again/detail/maintain/contain, 'pass' " +
      "inside password, 'pro' inside profile) — none of which describe an app to build.",
    filesAffected: ['lib/intent-classifier.ts'],
    fixApplied: 'Word-boundary-match (\\b...\\b) short (<=4 char) APP_TYPES entries instead of bare substring search; longer entries keep substring matching since false hits are vanishingly rare at that length.',
    verificationPerformed: '6 unit tests: the exact reported bug report, two additional false-positive examples, and 3 regressions confirming genuine build requests (including ones legitimately mentioning "email"/"AI"/"Pro") still classify correctly.',
    regressionTest: 'lib/__tests__/intent-classifier.test.ts — "APP_TYPES substring false positives" describe block',
    dateFixed: '2026-07-04',
    symptoms: [
      'what kind of app is', 'clarification needed', 'demo email and password is invalid',
      'lost project context', 'lost active project context', 'fix it', 'is invalid',
    ],
  },
  {
    id: 'sse-reconnect-busy-rejection',
    title: 'A reconnecting EventSource got a dead-end "busy" rejection instead of rejoining a still-running build',
    category: 'verification',
    rootCause:
      "The build-stream route only ever rejected a reconnect attempt with a terminal 'busy' event and " +
      "closed the stream — there was no mechanism for a reconnecting client to resume receiving " +
      "progress from the still-running server-side pipeline.",
    filesAffected: ['services/engine/build-registry.ts', 'app/api/engine-build-stream-prod/route.ts'],
    fixApplied: 'Added a publish/subscribe broadcaster so every attached subscriber (original + any reconnects) receives every event, plus a small recent-event replay buffer for context on reconnect.',
    verificationPerformed: '13 unit tests covering broadcast-to-multiple-subscribers, replay-on-late-attach, one-bad-subscriber-does-not-break-others, and lock/release semantics.',
    regressionTest: 'services/engine/__tests__/build-registry.test.ts',
    dateFixed: '2026-06',
    symptoms: ['Connection to the build engine was lost', 'busy', 'reconnect', 'EventSource'],
  },
  {
    id: 'text-scan-false-positives-on-generated-code-templates',
    title: 'A regex-based import scan produced 56 false positives because this platform\'s own source contains code-generation templates',
    category: 'other',
    rootCause:
      "The first version of scripts/check-platform-deps.ts scanned every .ts file's raw TEXT for " +
      "import-like patterns. This platform IS a code-generation engine, so files like " +
      "services/project-generator.ts and services/auth-scaffolder.ts legitimately contain large " +
      "string/template literals holding OTHER programs' import statements as DATA (e.g. the " +
      "MANAGED_DB_TS constant's \"import Database from 'better-sqlite3'\", meant for a GENERATED app) " +
      "— a text scan cannot distinguish a real import from an import statement embedded inside a " +
      "string the file happens to contain.",
    filesAffected: ['scripts/check-platform-deps.ts'],
    fixApplied: "Rewrote the checker to use the TypeScript compiler API (ts.createSourceFile + AST traversal), inspecting only real ImportDeclaration/ExportDeclaration nodes and CallExpression nodes for import()/require() — text inside a string or template literal is a different AST node kind entirely and is structurally impossible to misread as a real import.",
    verificationPerformed: 'Ran the regex version first (56 false positives, all from template-string content), then the AST version (0 false positives) against the same codebase; 10 unit tests including one proving a real import right next to a fake one inside a template literal is correctly told apart.',
    regressionTest: 'scripts/__tests__/check-platform-deps.test.ts',
    dateFixed: '2026-07-04',
    symptoms: ['false positive', 'imports "@prisma/client"', 'imports "next-auth"', 'template literal', 'code generation'],
  },
  {
    id: 'settings-page-is-blank-not-recognized-as-broken',
    title: '"settings page is blank" (reverse word order of "blank page") was not recognized as a problem report',
    category: 'intent-classification',
    rootCause:
      "REPORTS_BROKEN_RE only matched the fixed phrase order 'blank page', not the equally common " +
      "reverse phrasing 'page is blank'/'settings page is blank' — one of the user's own explicitly " +
      "listed example messages. Found by this module's own regression test (lib/__tests__/" +
      "repair-routing.test.ts), written directly from the user's example list, before it ever reached " +
      "a real user again — exactly the kind of gap a permanent regression suite exists to catch early.",
    filesAffected: ['lib/repair-routing.ts (formerly inline in app/builder/page.tsx)'],
    fixApplied: "Added 'is blank'/'looks blank' as their own alternative in REPORTS_BROKEN_RE, not just the fixed 'blank page' phrase order.",
    verificationPerformed: '16 unit tests in lib/__tests__/repair-routing.test.ts, including all 5 of the user\'s own example messages verbatim.',
    regressionTest: 'lib/__tests__/repair-routing.test.ts — "the exact user-reported failure" describe block',
    dateFixed: '2026-07-04',
    symptoms: ['settings page is blank', 'page is blank', 'form is blank'],
  },
  {
    id: 'current-project-lost-on-refresh',
    title: 'currentProject had no persistence — a page refresh silently discarded the open project',
    category: 'other',
    rootCause:
      "currentProject was plain useState<ProjectMeta|null>, set only by explicit user actions " +
      "(opening a project from the sidebar, or a build completing) and never restored on mount. " +
      "The mount-time 'Initial goal-first flow' effect unconditionally showed the cold-start goal " +
      "picker on every fresh page load, with no check for a project that was already open before " +
      "the refresh. A developer comment had already flagged this exact risk before it was fixed: " +
      "\"a null value here means the ENTIRE 'project open -> edit' branch never runs, regardless of " +
      "any fix inside it\" — meaning even a perfectly-correct decideProjectOpenRouting decision was " +
      "moot if currentProject was null because of a refresh, not because no project was ever opened.",
    filesAffected: ['app/builder/page.tsx', 'lib/project-session-storage.ts (new)'],
    fixApplied: "Added lib/project-session-storage.ts (localStorage read/write, SSR-safe, never throws on corrupted data) plus two effects in page.tsx: one persists currentProject on every change, the other checks for a persisted project on mount (before the template/prompt URL params and before showing the goal picker) and calls the existing handleOpenProject to fully re-establish the session (re-discover files, restart the dev server, replay conversation memory).",
    verificationPerformed: '6 unit tests for the storage helpers (round-trip, corrupted-data safety, SSR-safety) plus a clean typecheck confirming ProjectMeta and PersistedProjectRef are structurally compatible.',
    regressionTest: 'lib/__tests__/project-session-storage.test.ts',
    dateFixed: '2026-07-04',
    symptoms: ['what kind of app is this', 'lost project context after refresh', 'project open -> edit branch never runs'],
  },
  {
    id: 'orchestrator-warmup-loop-not-timeout-configurable',
    title: 'orchestrator.ts\'s preview warmup loop (up to 90s) is a raw while-loop, not part of the configurable per-stage timeout system',
    category: 'verification',
    rootCause:
      "runPipeline's post-preview warmup step polls the real previewUrl with fetch() in a plain " +
      "`while (Date.now() - warmupT0 < 90_000)` loop — legitimate for a real dev server cold-starting, " +
      "but NOT wrapped in withTimeout()/deps.timeouts like every other stage. Found while writing the " +
      "deterministic E2E fixture test (services/engine/__tests__/e2e-pipeline.test.ts): pointing " +
      "startPreview at a fake, nothing-listening URL made the 'fast, every commit' test hang for the " +
      "full 90 seconds, since the loop has no way to know the URL is fake and will never respond.",
    filesAffected: ['services/engine/orchestrator.ts (behavior confirmed, not changed — this is legitimate production behavior)', 'services/engine/__tests__/e2e-pipeline.test.ts'],
    fixApplied: "Not an engine fix (the 90s warmup is correct, intentional production behavior for a real dev server). The TEST fix: start an actual tiny local http.Server responding 200 immediately, and use ITS real address as previewUrl in fixture tests — the first real fetch() succeeds in milliseconds, keeping the test fast without touching orchestrator.ts.",
    verificationPerformed: 'Confirmed the naive fake-URL version hung for the full 90s; confirmed the real-tiny-server version completes the full 9-stage pipeline (plan/build/verify/repair/verify/preview/verify/learn/done) in under 50ms.',
    regressionTest: 'services/engine/__tests__/e2e-pipeline.test.ts',
    dateFixed: '2026-07-04',
    symptoms: ['test timed out', 'fetch previewUrl hangs', 'fast CI test taking 90 seconds', 'warmup loop'],
  },
];

/**
 * Simple, deterministic keyword-overlap search — no AI/embedding involved,
 * so the result is transparent and reproducible; a generated app's failure
 * text is checked against each entry's symptoms list.
 */
export function searchKnowledgeBase(failureText: string, category?: BugCategory): BugKnowledgeEntry[] {
  const lower = failureText.toLowerCase();
  return BUG_KNOWLEDGE_BASE
    .filter(e => !category || e.category === category)
    .filter(e => e.symptoms.some(s => lower.includes(s.toLowerCase())));
}

/** Formats matched entries into a short, prompt-injectable hint block. */
export function formatKnowledgeHint(entries: BugKnowledgeEntry[]): string {
  if (entries.length === 0) return '';
  return entries.map(e =>
    `Known issue "${e.title}" (seen before): root cause — ${e.rootCause} Fix — ${e.fixApplied}`
  ).join('\n');
}
