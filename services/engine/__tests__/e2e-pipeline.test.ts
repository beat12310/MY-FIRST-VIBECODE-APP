import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'http';
import { runPipeline, type OrchestratorDeps } from '../orchestrator';
import type { AppPlan, BuildResult, VerifyResult, ClassifiedFailure } from '../types';

/**
 * The orchestrator's real preview-warmup step (a hard-coded, non-configurable
 * up-to-90-second polling loop — orchestrator.ts's `while (Date.now() -
 * warmupT0 < 90_000) { fetch(previewUrl) ... }`) genuinely fetch()es whatever
 * URL startPreview returns, waiting for it to respond before continuing.
 * Confirmed live while writing this test: pointing it at a fake, nothing-
 * listening URL made this "fast" test hang for the full 90 seconds. A tiny
 * real local HTTP server (not a mock) makes the FIRST real fetch() succeed
 * immediately, keeping this deterministic AND fast without touching the
 * orchestrator's real warmup behavior at all.
 */
let previewServer: Server;
let previewUrl: string;
beforeAll(() => new Promise<void>((resolve) => {
  previewServer = createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
  previewServer.listen(0, () => {
    const address = previewServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    previewUrl = `http://localhost:${port}`;
    resolve();
  });
}));
afterAll(() => new Promise<void>((resolve) => previewServer.close(() => resolve())));

/**
 * Level 1 (fast CI, every commit) end-to-end pipeline test — build → verify
 * → repair → re-verify → preview, chained together exactly as the real
 * orchestrator wires them, using a DETERMINISTIC fixture (no Bedrock, no
 * real dev server) per the explicitly agreed testing architecture: fast,
 * free, and reproducible on every commit. Real-AI behavior is exercised
 * separately by the Level 2 scheduled suite, which this file does not
 * replace.
 *
 * The "real project" here is a fixed, in-memory file set with an
 * intentionally planted defect (a route importing a package that was never
 * installed — the same failure class as the live Prisma incident this
 * session traced) that must be found by verify, fixed by repair, and
 * confirmed resolved by a second verify pass — proving the FULL chain
 * works together, not just each stage in isolation.
 */

const minimalPlan: AppPlan = {
  projectName: 'fixture-app', displayName: 'Fixture App', description: 'A deterministic E2E fixture',
  intent: { appType: 'saas', secondaryTypes: [], confidence: 1, label: 'SaaS', source: 'keyword' },
  pages: [{ route: '/', filePath: 'app/page.tsx', title: 'Home', purpose: 'landing' }],
  apiRoutes: [{ route: '/api/orders', filePath: 'app/api/orders/route.ts', methods: ['GET'], purpose: 'list orders' }],
  components: [], dataModels: [], requiresAuth: false,
  seo: { sitemap: false, robots: false, metadata: false, schema: false },
  uiStyle: { preset: 'modern', palette: [], animations: false },
  capabilities: [], resolvedCapabilities: [],
};

const BROKEN_ORDERS_ROUTE = `import { PrismaClient } from '@prisma/client';\nconst db = new PrismaClient();\nexport async function GET() { return Response.json(await db.order.findMany()); }\n`;
const FIXED_ORDERS_ROUTE = `import { db, initTable } from '@/lib/managed/db';\ninitTable('CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY)');\nexport async function GET() { return Response.json(db.all('SELECT * FROM orders')); }\n`;

function classify(files: { path: string; content: string }[]): ClassifiedFailure[] {
  // Deterministic stand-in for verifier.ts's real detectManagedServiceCorruption/
  // uninstalledImports logic — this fixture test is about proving the
  // PIPELINE wiring, not re-testing that detection logic (already covered by
  // services/engine/__tests__/verifier.test.ts).
  const failures: ClassifiedFailure[] = [];
  for (const f of files) {
    if (f.content.includes('@prisma/client')) {
      failures.push({ origin: 'internal', area: 'structural', detail: `${f.path} imports "@prisma/client", which is not installed`, repairable: true });
    }
  }
  return failures;
}

describe('E2E pipeline (deterministic fixture) — build → verify → repair → re-verify → preview', () => {
  it('finds a planted defect, repairs it, and confirms resolution — the full happy-path chain', async () => {
    // In-memory "project" — mutated by the fake repair step exactly like a
    // real file-editor would mutate real files on disk.
    let files = [
      { path: 'app/page.tsx', content: 'export default function Home() { return null; }' },
      { path: 'app/api/orders/route.ts', content: BROKEN_ORDERS_ROUTE },
    ];

    const progressEvents: string[] = [];
    const deps: OrchestratorDeps = {
      plan: () => minimalPlan,
      needsClarification: () => false,
      clarificationQuestion: () => '',
      build: async () => ({
        projectPath: '/fixture/project', isFreshFolder: true,
        filesCreated: files.map(f => ({ path: f.path, bytes: f.content.length })),
        foldersCreated: 2, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
        recoveredFromLooseFormat: false, logs: [],
      } as BuildResult),
      verify: async () => {
        const failures = classify(files);
        return {
          passed: failures.length === 0, fileCount: files.length, routes: ['/'], apiRoutes: ['/api/orders'],
          pagesGenerated: 1, deadLinks: [], notFoundRoutes: [], brokenImports: [], buildErrors: [],
          classifiedFailures: failures, externalIssues: [], workflowTests: [], securityChecks: [], performance: [],
        } as unknown as VerifyResult;
      },
      repair: async (_plan, _path, verify) => {
        // Deterministic "fix": the one known failure pattern this fixture
        // plants gets replaced with the correct, working contract — mirrors
        // repairer.ts's real fast-path re-injection for this exact failure.
        const toFix = verify.classifiedFailures.filter(f => f.repairable);
        const changed: string[] = [];
        if (toFix.some(f => f.detail.includes('@prisma/client'))) {
          files = files.map(f => f.path === 'app/api/orders/route.ts' ? { ...f, content: FIXED_ORDERS_ROUTE } : f);
          changed.push('app/api/orders/route.ts');
        }
        return { attempts: 1, maxAttempts: 5, changedFiles: changed, resolved: changed.length > 0, remainingIssues: [], skippedExternalIssues: [] };
      },
      startPreview: async () => ({ url: previewUrl, started: true }),
      learn: async () => undefined,
      onProgress: (stage) => progressEvents.push(stage),
    };

    const result = await runPipeline('build a fixture app', deps);

    // The full chain actually ran, in order.
    // static verify -> repair -> re-verify, THEN preview starts, THEN a
    // further RUNTIME verify pass against the live preview (this is what
    // lets previewLoads-style checks run at all), then learn persists the
    // successful run.
    expect(progressEvents).toEqual(['plan', 'build', 'verify', 'repair', 'verify', 'preview', 'verify', 'learn', 'done']);
    // The defect was found, then fixed, then confirmed resolved by the
    // post-repair re-verify — not just "repair says it's fixed."
    expect(result.repair?.changedFiles).toContain('app/api/orders/route.ts');
    expect(result.verifyStatus).toBe('passed');
    expect(result.repairStatus).toBe('passed');
    expect(result.previewStatus).toBe('available');
    expect(files.find(f => f.path === 'app/api/orders/route.ts')?.content).toBe(FIXED_ORDERS_ROUTE);
  });

  it('when nothing is broken, repair is skipped entirely (zero unnecessary Bedrock cost) and preview still starts', async () => {
    const files = [
      { path: 'app/page.tsx', content: 'export default function Home() { return null; }' },
      { path: 'app/api/orders/route.ts', content: FIXED_ORDERS_ROUTE },
    ];
    let repairCalled = false;
    const deps: OrchestratorDeps = {
      plan: () => minimalPlan,
      needsClarification: () => false,
      clarificationQuestion: () => '',
      build: async () => ({
        projectPath: '/fixture/project', isFreshFolder: true,
        filesCreated: files.map(f => ({ path: f.path, bytes: f.content.length })),
        foldersCreated: 2, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
        recoveredFromLooseFormat: false, logs: [],
      } as BuildResult),
      verify: async () => ({
        passed: true, fileCount: files.length, routes: ['/'], apiRoutes: ['/api/orders'], pagesGenerated: 1,
        deadLinks: [], notFoundRoutes: [], brokenImports: [], buildErrors: [],
        classifiedFailures: [], externalIssues: [], workflowTests: [], securityChecks: [], performance: [],
      } as unknown as VerifyResult),
      repair: async () => { repairCalled = true; return { attempts: 0, maxAttempts: 5, changedFiles: [], resolved: true, remainingIssues: [], skippedExternalIssues: [] }; },
      startPreview: async () => ({ url: previewUrl, started: true }),
      learn: async () => undefined,
    };

    const result = await runPipeline('build a fixture app', deps);

    expect(repairCalled).toBe(false); // orchestrator itself never calls repair() when verify already passed
    expect(result.verifyStatus).toBe('passed');
    expect(result.previewStatus).toBe('available');
  });

  it('a build producing no files is reported as failed and the pipeline stops before wasting a verify/repair cycle', async () => {
    const deps: OrchestratorDeps = {
      plan: () => minimalPlan,
      needsClarification: () => false,
      clarificationQuestion: () => '',
      build: async () => ({
        projectPath: '/fixture/project', isFreshFolder: true, filesCreated: [], foldersCreated: 0,
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
        recoveredFromLooseFormat: false, logs: [],
      } as BuildResult),
      verify: async () => { throw new Error('verify should never be called when the build produced nothing'); },
      repair: async () => { throw new Error('repair should never be called when the build produced nothing'); },
      learn: async () => undefined,
    };

    const result = await runPipeline('build a fixture app', deps);
    expect(result.buildStatus).toBe('failed');
    expect(result.success).toBe(false);
  });
});
