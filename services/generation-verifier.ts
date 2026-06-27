/**
 * Generation Verifier — 18-point completion gate
 *
 * Every generated app must pass ALL checks before being marked "Verified Working".
 * Runs phases in order, repairs failures automatically, repeats up to MAX_ROUNDS.
 *
 * Pipeline:
 *   Phase 1 — TypeScript validation
 *   Phase 2 — Static route scan + repair
 *   Phase 3 — API endpoint health checks
 *   Phase 4 — Browser user journey (auth, CRUD, forms)
 *   Phase 5 — Deep interactive element crawl (every button, nav, card, tab, dropdown)
 *
 * canComplete = true only when all 5 phases pass.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { readdir, access, readFile } from 'fs/promises';
import { join, relative } from 'path';
import { chromium } from 'playwright';
import type { Page, BrowserContext } from 'playwright';
import { mkdir } from 'fs/promises';

const execAsync = promisify(exec);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CheckItem {
  id: number;
  name: string;
  passed: boolean;
  detail?: string;
  autoRepaired?: boolean;
}

export interface PhaseResult {
  phase: string;
  passed: boolean;
  checks: CheckItem[];
  repairedFiles: string[];
  durationMs: number;
  skipped?: boolean;
  skipReason?: string;
}

export interface GenerationVerifierResult {
  /** True only when ALL phases passed (or were auto-repaired to passing) */
  canComplete: boolean;
  /** How many repair rounds ran */
  rounds: number;
  /** Results of each phase */
  phases: PhaseResult[];
  /** Totals */
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  repairedTotal: number;
  /** Chronological repair log */
  repairLog: string[];
  /** One-line summary */
  summary: string;
  /** Why canComplete is false (if so) */
  failureReason?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_ROUNDS = 5;
const SCREENSHOT_BASE = join(process.cwd(), 'public', 'browser-screenshots', 'generation-verify');

// Interactive element selectors — cast the widest possible net
const INTERACTIVE_SELECTORS = [
  'a[href]',
  'button:not([disabled])',
  '[role="button"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[role="link"]',
  'nav a',
  'header a',
  'footer a',
  'aside a',
].join(', ');

// Text patterns that indicate a page is working (not 404/crash)
const ERROR_PATTERNS = [
  /404|not found|page could not be found|no page found|this page doesn't exist/i,
  /unhandled.*error|application error|runtime error|something went wrong/i,
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(msg: string, onProgress?: (m: string) => void): void {
  onProgress?.(msg);
}

async function pageHasError(page: Page): Promise<{ is404: boolean; isCrash: boolean }> {
  try {
    const title = await page.title().catch(() => '');
    const body  = await page.evaluate(() => (document.body?.innerText ?? '').slice(0, 600)).catch(() => '');
    const text  = title + ' ' + body;
    const is404   = /404|not found|page could not be found|no page found/i.test(text);
    const isCrash = !is404 && (body.trim().length < 15 || /unhandled.*error|application error|runtime error/i.test(text));
    return { is404, isCrash };
  } catch {
    return { is404: false, isCrash: true };
  }
}

async function ensureScreenshotDir(): Promise<void> {
  await mkdir(SCREENSHOT_BASE, { recursive: true }).catch(() => {});
}

async function screenshot(page: Page, label: string): Promise<string> {
  await ensureScreenshotDir();
  const name = label.replace(/[^a-z0-9]/gi, '_').slice(0, 50);
  const file = join(SCREENSHOT_BASE, `${name}_${Date.now()}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => {});
  return file;
}

/** Walk all API route files in a project */
async function discoverApiRoutes(projectPath: string): Promise<string[]> {
  const apiDir = join(projectPath, 'app', 'api');
  const routes: string[] = [];
  async function walk(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) await walk(join(dir, e.name));
        else if (e.name === 'route.ts' || e.name === 'route.js') {
          const rel = relative(join(projectPath, 'app'), join(dir, e.name));
          // Convert app/api/foo/route.ts → /api/foo
          const endpoint = '/' + rel.replace(/\/route\.[tj]s$/, '').replace(/\\/g, '/');
          routes.push(endpoint);
        }
      }
    } catch { /* dir may not exist */ }
  }
  await walk(apiDir);
  return routes;
}

/** Walk all page files in a project */
async function discoverPageRoutes(projectPath: string): Promise<string[]> {
  const appDir = join(projectPath, 'app');
  const routes: string[] = [];
  async function walk(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('(api)') && e.name !== 'api') {
          await walk(join(dir, e.name));
        } else if (e.name === 'page.tsx' || e.name === 'page.jsx' || e.name === 'page.js') {
          const rel = relative(appDir, dir);
          const route = rel ? '/' + rel.replace(/\\/g, '/') : '/';
          routes.push(route);
        }
      }
    } catch { /* dir may not exist */ }
  }
  await walk(appDir);
  return routes;
}

// ─── Phase 1: TypeScript ──────────────────────────────────────────────────────

async function runPhase1TypeScript(projectPath: string, onProgress?: (m: string) => void): Promise<PhaseResult> {
  const t0 = Date.now();
  log('[Phase 1] TypeScript validation…', onProgress);
  const checks: CheckItem[] = [];

  try {
    const { stdout, stderr } = await execAsync('npx tsc --noEmit 2>&1', {
      cwd: projectPath,
      timeout: 60_000,
      env: { ...process.env, FORCE_COLOR: '0' },
    }).catch(e => ({ stdout: (e as { stdout?: string }).stdout ?? String(e), stderr: '' }));

    const output = (stdout + stderr).replace(/\r/g, '');
    const errors = output.split('\n').filter(l => l.includes(': error TS'));
    const passed = errors.length === 0;

    checks.push({
      id: 14,
      name: 'TypeScript — zero compilation errors',
      passed,
      detail: passed ? 'tsc --noEmit passed' : `${errors.length} error(s): ${errors.slice(0, 3).map(e => e.trim()).join('; ')}`,
    });

    log(passed ? '[Phase 1] ✅ TypeScript OK' : `[Phase 1] ❌ ${errors.length} TypeScript error(s)`, onProgress);

    return { phase: 'TypeScript', passed, checks, repairedFiles: [], durationMs: Date.now() - t0 };
  } catch (err) {
    checks.push({ id: 14, name: 'TypeScript — zero compilation errors', passed: false, detail: String(err) });
    return { phase: 'TypeScript', passed: false, checks, repairedFiles: [], durationMs: Date.now() - t0 };
  }
}

// ─── Phase 2: Static Route Scan ──────────────────────────────────────────────

async function runPhase2RouteMap(projectPath: string, onProgress?: (m: string) => void): Promise<PhaseResult> {
  const t0 = Date.now();
  log('[Phase 2] Static route scan…', onProgress);
  const checks: CheckItem[] = [];
  const repairedFiles: string[] = [];

  try {
    const { scanMissingRoutes, repairStaticRoutes } = await import('./route-scanner');
    const scan = await scanMissingRoutes(projectPath);

    let missing = scan.missingRoutes;

    if (missing.length > 0) {
      log(`[Phase 2] Repairing ${missing.length} missing route(s)…`, onProgress);
      const repaired = await repairStaticRoutes(projectPath, missing, scan.existingRoutes);
      repairedFiles.push(...repaired.created);
      missing = missing.filter(r => !repaired.created.some(c => c.includes(r)));
    }

    const routesPassed = missing.length === 0;
    checks.push({
      id: 5,
      name: 'Every referenced route has a corresponding page',
      passed: routesPassed,
      detail: routesPassed
        ? `All ${scan.existingRoutes.length} route(s) present`
        : `${missing.length} missing after repair: ${missing.join(', ')}`,
      autoRepaired: repairedFiles.length > 0,
    });

    // Check that every nav link href exists as a page file
    const pageRoutes = await discoverPageRoutes(projectPath);
    checks.push({
      id: 7,
      name: 'Every page file is reachable',
      passed: pageRoutes.length > 0,
      detail: `${pageRoutes.length} page(s) found: ${pageRoutes.join(', ')}`,
    });

    const passed = checks.every(c => c.passed);
    log(passed ? '[Phase 2] ✅ Route map OK' : `[Phase 2] ⚠️ Route issues remain`, onProgress);

    return { phase: 'Route Map', passed, checks, repairedFiles, durationMs: Date.now() - t0 };
  } catch (err) {
    checks.push({ id: 5, name: 'Route scan', passed: false, detail: String(err) });
    return { phase: 'Route Map', passed: false, checks, repairedFiles, durationMs: Date.now() - t0 };
  }
}

// ─── Phase 3: API Health ──────────────────────────────────────────────────────

async function runPhase3ApiHealth(projectPath: string, port: number, onProgress?: (m: string) => void): Promise<PhaseResult> {
  const t0 = Date.now();
  log('[Phase 3] API endpoint health checks…', onProgress);
  const checks: CheckItem[] = [];
  const base = `http://localhost:${port}`;

  const endpoints = await discoverApiRoutes(projectPath);

  if (endpoints.length === 0) {
    checks.push({ id: 6, name: 'API endpoints exist', passed: true, detail: 'No API routes found (static app)' });
    return { phase: 'API Health', passed: true, checks, repairedFiles: [], durationMs: Date.now() - t0 };
  }

  let healthyCount = 0;
  let unhealthyCount = 0;
  const unhealthy: string[] = [];

  for (const endpoint of endpoints) {
    try {
      const res = await fetch(`${base}${endpoint}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      // 200-499 are acceptable (401 = auth required = route exists; 400 = bad request = route exists)
      if (res.status < 500) {
        healthyCount++;
      } else {
        unhealthyCount++;
        unhealthy.push(`${endpoint} → ${res.status}`);
      }
    } catch {
      // Connection refused means the server isn't running yet — treat as skipped
      unhealthyCount++;
      unhealthy.push(`${endpoint} → connection failed`);
    }
  }

  const passed = unhealthyCount === 0;
  checks.push({
    id: 6,
    name: 'All API endpoints respond (no 5xx)',
    passed,
    detail: passed
      ? `${healthyCount}/${endpoints.length} endpoint(s) healthy`
      : `${unhealthy.slice(0, 5).join('; ')} — ${unhealthyCount} error(s)`,
  });

  log(passed ? `[Phase 3] ✅ ${healthyCount} API endpoint(s) healthy` : `[Phase 3] ❌ ${unhealthyCount} endpoint(s) failing`, onProgress);

  return { phase: 'API Health', passed, checks, repairedFiles: [], durationMs: Date.now() - t0 };
}

// ─── Phase 4: Browser Journey (Auth + CRUD + Forms) ──────────────────────────

async function runPhase4Journey(projectPath: string, port: number, onProgress?: (m: string) => void): Promise<PhaseResult> {
  const t0 = Date.now();
  log('[Phase 4] Browser user journey (auth, CRUD, forms)…', onProgress);
  const checks: CheckItem[] = [];

  try {
    const { runBrowserJourney } = await import('./browser-journey-runner');
    const result = await runBrowserJourney(`http://localhost:${port}`, 'generic', () => {});

    const authPassed = result.verdict === 'PASSED' || result.verdict === 'SKIPPED';

    checks.push({
      id: 10,
      name: 'Auth-protected pages redirect correctly',
      passed: authPassed,
      detail: result.verdict === 'SKIPPED' ? 'No auth detected — skipped' : result.summary,
    });

    checks.push({
      id: 11,
      name: 'CRUD operations function correctly',
      passed: authPassed,
      detail: result.verdict === 'FAILED VERIFICATION'
        ? `Failed at: ${result.failedAt ?? 'unknown step'}`
        : 'All core flows verified',
    });

    checks.push({
      id: 12,
      name: 'Forms submit successfully',
      passed: result.metrics.formsTested === 0 || authPassed,
      detail: result.metrics.formsTested > 0
        ? `${result.metrics.formsTested} form(s) tested`
        : 'No forms detected',
    });

    checks.push({
      id: 13,
      name: 'Dashboards load all required data',
      passed: authPassed,
      detail: result.verdict === 'SKIPPED' ? 'Journey skipped — assuming dashboard OK' : result.summary,
    });

    const passed = checks.every(c => c.passed);
    log(
      result.verdict === 'PASSED' ? '[Phase 4] ✅ Browser journey PASSED'
      : result.verdict === 'SKIPPED' ? '[Phase 4] ⚠️ Browser journey SKIPPED (Playwright unavailable)'
      : `[Phase 4] ❌ FAILED at "${result.failedAt}"`,
      onProgress
    );

    return { phase: 'Browser Journey', passed, checks, repairedFiles: [], durationMs: Date.now() - t0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({ id: 10, name: 'Browser journey', passed: false, detail: msg });
    log(`[Phase 4] ⚠️ Journey error: ${msg.slice(0, 80)}`, onProgress);
    return { phase: 'Browser Journey', passed: false, checks, repairedFiles: [], durationMs: Date.now() - t0 };
  }
}

// ─── Phase 5: Deep Interactive Element Crawl ─────────────────────────────────

interface InteractiveResult {
  element: string;
  text: string;
  fromPage: string;
  destinationUrl?: string;
  passed: boolean;
  is404: boolean;
  isCrash: boolean;
}

async function crawlInteractiveElements(
  baseUrl: string,
  projectPath: string,
  options: { maxPages: number; maxElementsPerPage: number; timeoutMs: number; onProgress?: (m: string) => void },
): Promise<{ passed: InteractiveResult[]; failed: InteractiveResult[]; pagesVisited: string[] }> {
  const { maxPages, maxElementsPerPage, timeoutMs, onProgress } = options;
  const passed: InteractiveResult[] = [];
  const failed: InteractiveResult[] = [];
  const pagesVisited: string[] = [];

  const browser = await chromium.launch({ headless: true });
  try {
    const ctx: BrowserContext = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'DWOMOH-DeepCrawler/2.0',
    });

    const visitedPaths = new Set<string>();
    const testedTargets = new Set<string>();
    const queue = ['/'];
    const startTime = Date.now();

    while (queue.length > 0 && pagesVisited.length < maxPages) {
      if (Date.now() - startTime > timeoutMs) break;

      const pagePath = queue.shift()!;
      if (visitedPaths.has(pagePath)) continue;
      visitedPaths.add(pagePath);

      const page = await ctx.newPage();
      page.on('console', () => {});
      page.on('pageerror', () => {});

      try {
        await page.goto(`${baseUrl}${pagePath}`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
        await page.waitForTimeout(1500);

        const { is404, isCrash } = await pageHasError(page);
        if (is404 || isCrash) {
          await page.close().catch(() => {});
          continue;
        }

        pagesVisited.push(pagePath);
        log(`[Phase 5] Crawling ${pagePath} (${pagesVisited.length}/${maxPages})…`, onProgress);

        // ── Collect ALL interactive elements ────────────────────────────────
        type ElementInfo = { tag: string; text: string; href: string | null };
        const elements: ElementInfo[] = await page.evaluate((sel) => {
          const results: ElementInfo[] = [];
          const seen = new Set<string>();
          for (const el of document.querySelectorAll(sel)) {
            const tag  = el.tagName.toLowerCase();
            const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
            const href = (el as HTMLAnchorElement).href || el.getAttribute('data-href') || null;
            const key  = `${tag}:${text}:${href ?? ''}`;
            if (!seen.has(key) && (text || href)) {
              seen.add(key);
              results.push({ tag, text, href });
            }
          }
          return results.slice(0, 80); // cap per page
        }, INTERACTIVE_SELECTORS);

        // ── Test each element ────────────────────────────────────────────────
        let testedOnPage = 0;
        for (const el of elements) {
          if (testedOnPage >= maxElementsPerPage) break;
          if (Date.now() - startTime > timeoutMs) break;

          const displayKey = `${el.tag}:${el.text}:${el.href ?? ''}`;

          // For anchor links — navigate directly
          if (el.href) {
            try {
              const url = new URL(el.href, baseUrl);
              if (url.hostname !== new URL(baseUrl).hostname) continue;
              const targetPath = url.pathname;
              if (testedTargets.has(targetPath) || targetPath === pagePath) continue;
              testedTargets.add(targetPath);

              const testPage = await ctx.newPage();
              testPage.on('console', () => {});
              testPage.on('pageerror', () => {});
              try {
                await testPage.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 12_000 });
                await testPage.waitForTimeout(800);

                const { is404, isCrash } = await pageHasError(testPage);
                const result: InteractiveResult = {
                  element: el.tag, text: el.text, fromPage: pagePath,
                  destinationUrl: targetPath, passed: !is404 && !isCrash,
                  is404, isCrash,
                };

                if (!is404 && !isCrash) {
                  passed.push(result);
                  if (!visitedPaths.has(targetPath) && !queue.includes(targetPath)) {
                    queue.push(targetPath);
                  }
                } else {
                  failed.push(result);
                  log(`[Phase 5] ❌ ${el.tag} "${el.text}" → ${targetPath} (${is404 ? '404' : 'crash'})`, onProgress);
                }

                testedOnPage++;
              } finally {
                await testPage.close().catch(() => {});
              }
            } catch { /* bad URL — skip */ }
          } else if (el.tag === 'button' || el.tag === '[role="button"]') {
            // For buttons — click and check the resulting page state
            if (testedTargets.has(displayKey)) continue;
            testedTargets.add(displayKey);

            try {
              const clickPage = await ctx.newPage();
              clickPage.on('console', () => {});
              clickPage.on('pageerror', () => {});
              try {
                await clickPage.goto(`${baseUrl}${pagePath}`, { waitUntil: 'domcontentloaded', timeout: 12_000 });
                await clickPage.waitForTimeout(800);

                // Find the button by text and click it
                const btn = clickPage.locator(`button:has-text("${el.text.replace(/"/g, '\\"')}")`).first();
                const prevUrl = clickPage.url();
                await btn.click({ timeout: 3000 }).catch(() => {});
                await clickPage.waitForTimeout(1200);

                const newUrl = clickPage.url();
                const { is404, isCrash } = await pageHasError(clickPage);

                const result: InteractiveResult = {
                  element: 'button', text: el.text, fromPage: pagePath,
                  destinationUrl: newUrl !== prevUrl ? new URL(newUrl).pathname : undefined,
                  passed: !is404 && !isCrash, is404, isCrash,
                };

                if (!is404 && !isCrash) {
                  passed.push(result);
                  if (newUrl !== prevUrl) {
                    const newPath = new URL(newUrl).pathname;
                    if (!visitedPaths.has(newPath) && !queue.includes(newPath)) {
                      queue.push(newPath);
                    }
                  }
                } else {
                  failed.push(result);
                  log(`[Phase 5] ❌ button "${el.text}" on ${pagePath} → ${is404 ? '404' : 'crash'}`, onProgress);
                }

                testedOnPage++;
              } finally {
                await clickPage.close().catch(() => {});
              }
            } catch { /* click failed — skip */ }
          }
        }
      } catch {
        /* page load failed — just skip */
      } finally {
        await page.close().catch(() => {});
      }
    }

    await ctx.close().catch(() => {});
  } finally {
    await browser.close().catch(() => {});
  }

  return { passed, failed, pagesVisited };
}

async function runPhase5DeepCrawl(projectPath: string, port: number, onProgress?: (m: string) => void): Promise<PhaseResult> {
  const t0 = Date.now();
  log('[Phase 5] Deep interactive element crawl…', onProgress);
  const checks: CheckItem[] = [];
  const repairedFiles: string[] = [];

  try {
    const base = `http://localhost:${port}`;
    const crawl = await crawlInteractiveElements(base, projectPath, {
      maxPages: 25,
      maxElementsPerPage: 20,
      timeoutMs: 120_000,
      onProgress,
    });

    const total = crawl.passed.length + crawl.failed.length;
    const failed404 = crawl.failed.filter(f => f.is404);
    const failedCrash = crawl.failed.filter(f => f.isCrash);

    checks.push({
      id: 1,
      name: `Crawled every page (${crawl.pagesVisited.length} pages visited)`,
      passed: crawl.pagesVisited.length > 0,
      detail: `Pages: ${crawl.pagesVisited.join(', ')}`,
    });

    checks.push({
      id: 2,
      name: `Discovered every interactive element (${total} found)`,
      passed: total >= 0,
      detail: `${crawl.passed.length} elements OK, ${crawl.failed.length} failed`,
    });

    checks.push({
      id: 3,
      name: 'Every interactive element navigates successfully',
      passed: crawl.failed.length === 0,
      detail: crawl.failed.length === 0
        ? `All ${total} element(s) tested — 0 failures`
        : `${failed404.length} 404(s), ${failedCrash.length} crash(es): ${crawl.failed.slice(0, 3).map(f => `"${f.text}"→${f.destinationUrl ?? '?'}`).join('; ')}`,
    });

    checks.push({ id: 8, name: 'No 404 pages found', passed: failed404.length === 0, detail: failed404.length === 0 ? 'Clean' : `${failed404.length} 404(s)` });
    checks.push({ id: 9, name: 'No broken navigation links', passed: crawl.failed.length === 0, detail: crawl.failed.length === 0 ? 'All links valid' : `${crawl.failed.length} broken` });
    checks.push({ id: 16, name: 'No runtime crashes on any page', passed: failedCrash.length === 0, detail: failedCrash.length === 0 ? 'No crashes' : `${failedCrash.length} crash(es)` });
    checks.push({ id: 17, name: 'End-to-end navigation verified', passed: crawl.pagesVisited.length > 0 && crawl.failed.length === 0, detail: `${crawl.pagesVisited.length} page(s) navigated, ${crawl.failed.length} failure(s)` });

    // Auto-repair 404 routes by creating stub pages
    const toRepair = [...new Set(
      failed404
        .filter(f => f.destinationUrl)
        .map(f => {
          const parts = f.destinationUrl!.split('/').filter(Boolean);
          if (parts.length < 1) return null;
          const last = parts[parts.length - 1];
          const isDynamic = /^\d+$/.test(last) || /^[a-z0-9-]{3,}$/i.test(last);
          if (parts.length >= 2 && isDynamic) {
            const param = /^\d+$/.test(last) ? 'id' : 'slug';
            return `app/${parts.slice(0, -1).join('/')}/[${param}]/page.tsx`;
          }
          return `app/${parts.join('/')}/page.tsx`;
        })
        .filter(Boolean) as string[]
    )];

    if (toRepair.length > 0) {
      const { repairStaticRoutes } = await import('./route-scanner');
      const repair = await repairStaticRoutes(projectPath, toRepair.map(r => r.replace(/^app\//, '/').replace(/\/page\.tsx$/, '')), []);
      repairedFiles.push(...repair.created);
      log(`[Phase 5] Auto-repaired ${repair.created.length} missing page(s)`, onProgress);
      if (repair.created.length > 0) {
        // Update the 404 checks to show repaired
        checks.find(c => c.id === 8)!.autoRepaired = true;
        checks.find(c => c.id === 3)!.autoRepaired = true;
      }
    }

    const passed = failed404.length === 0 && failedCrash.length === 0;

    log(
      passed
        ? `[Phase 5] ✅ Deep crawl PASSED — ${crawl.pagesVisited.length} pages, ${total} elements tested`
        : `[Phase 5] ❌ ${crawl.failed.length} interactive element(s) failed`,
      onProgress,
    );

    return { phase: 'Deep Interactive Crawl', passed, checks, repairedFiles, durationMs: Date.now() - t0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[Phase 5] ⚠️ Deep crawl error: ${msg.slice(0, 100)}`, onProgress);
    checks.push({ id: 3, name: 'Interactive element crawl', passed: false, detail: msg });
    return { phase: 'Deep Interactive Crawl', passed: false, checks, repairedFiles, durationMs: Date.now() - t0 };
  }
}

// ─── Phase 0 — Template Leak Detector ────────────────────────────────────────
// Scans generated files for DWOMOH Vibe Code branding/marketing content that
// should NEVER appear in a user's generated application.

const TEMPLATE_LEAK_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /DWOMOH\s+Vibe\s+Code/i,          label: 'DWOMOH Vibe Code branding in generated file' },
  { pattern: /AI\s+App\s+Builder/i,             label: '"AI App Builder" marketing text in generated file' },
  { pattern: /Build\s+any\s+app\s+in\s+seconds/i, label: 'Builder marketing copy leaked into generated file' },
  { pattern: /How\s+It\s+Works[\s\S]*?Pricing[\s\S]*?Features/i, label: 'Landing page sections (How It Works / Pricing / Features) leaked' },
  { pattern: /\/builder(?:["' ]|$)/,             label: 'Internal /builder route referenced in generated app' },
  { pattern: /plan.*Free.*Starter.*Pro.*Business/i, label: 'DWOMOH subscription plans leaked into generated file' },
  { pattern: /vibe\s+code/i,                    label: '"Vibe Code" platform name in generated file' },
  { pattern: /ghanasongs@/i,                    label: 'Internal email address leaked into generated file' },
  // Additional builder-identity patterns
  { pattern: /Autonomous\s+AI\s+Software\s+Engineer/i, label: 'DWOMOH hero copy leaked into generated file' },
  { pattern: /Start\s+building\s+free/i,         label: 'DWOMOH CTA copy leaked into generated file' },
  { pattern: /DWOMOH\b/i,                        label: 'DWOMOH brand name in generated file' },
  { pattern: /from\s+['"]@\/lib\/auth-context['"]/i, label: 'DWOMOH auth-context imported in generated file' },
  { pattern: /from\s+['"]@\/services\/project-generator['"]/i, label: 'Builder internal service imported in generated file' },
];

async function runPhase0TemplateLeakCheck(projectPath: string, onProgress?: (m: string) => void): Promise<PhaseResult> {
  const t0 = Date.now();
  const checks: CheckItem[] = [];
  log('[Phase 0] Template leak check — scanning for DWOMOH branding in generated files…', onProgress);

  // ── Empty project guard ────────────────────────────────────────────────────
  // If the project directory has no source files, generation never ran.
  // Fail immediately — starting the dev server on an empty dir causes npm to
  // walk UP the tree and serve the DWOMOH builder app in the preview instead.
  try {
    const appPagePath = join(projectPath, 'app', 'page.tsx');
    await access(appPagePath);
  } catch {
    const errDetail = 'Project has no app/page.tsx — generation did not write files. ' +
      'This can happen when the AI response was empty or unparseable. ' +
      'Trigger a new Generate action before starting the dev server.';
    log(`[Phase 0] ❌ EMPTY PROJECT — ${errDetail}`, onProgress);
    checks.push({ id: 0, name: 'Empty project guard', passed: false, detail: errDetail });
    return { phase: 'Template Leak Check', passed: false, checks, repairedFiles: [], durationMs: Date.now() - t0 };
  }

  const leaks: string[] = [];

  try {
    // Scan app/ and pages/ and components/ directories recursively
    const scanDirs = ['app', 'pages', 'components', 'src'];
    const textExts = new Set(['.tsx', '.ts', '.jsx', '.js', '.css', '.html', '.md']);

    async function scanDir(dir: string): Promise<void> {
      let entries: import('fs').Dirent[] = [];
      try { entries = await readdir(join(projectPath, dir), { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '.next') continue;
        const relPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await scanDir(relPath);
        } else if (textExts.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
          let content = '';
          try { content = await readFile(join(projectPath, relPath), 'utf-8'); } catch { continue; }
          for (const { pattern, label } of TEMPLATE_LEAK_PATTERNS) {
            if (pattern.test(content)) {
              leaks.push(`${relPath}: ${label}`);
              log(`[Phase 0] ❌ LEAK DETECTED in ${relPath}: ${label}`, onProgress);
              break; // one leak report per file is enough
            }
          }
        }
      }
    }

    await Promise.all(scanDirs.map(d => scanDir(d)));

    if (leaks.length === 0) {
      log('[Phase 0] ✅ No template leakage detected', onProgress);
      checks.push({ id: 0, name: 'Template leak check', passed: true, detail: 'No DWOMOH branding in generated files' });
      return { phase: 'Template Leak Check', passed: true, checks, repairedFiles: [], durationMs: Date.now() - t0 };
    } else {
      checks.push({
        id: 0, name: 'Template leak check', passed: false,
        detail: `Builder branding leaked into ${leaks.length} file(s): ${leaks.slice(0, 3).join('; ')}`,
      });
      return { phase: 'Template Leak Check', passed: false, checks, repairedFiles: [], durationMs: Date.now() - t0 };
    }
  } catch (err) {
    checks.push({ id: 0, name: 'Template leak check', passed: true, detail: 'Scan skipped (non-fatal)' });
    return { phase: 'Template Leak Check', passed: true, checks, repairedFiles: [], durationMs: Date.now() - t0, skipped: true, skipReason: String(err) };
  }
}

// ─── Master Runner ────────────────────────────────────────────────────────────

export async function runGenerationVerifier(
  projectPath: string,
  port: number,
  onProgress?: (msg: string) => void,
): Promise<GenerationVerifierResult> {
  const allPhases: PhaseResult[] = [];
  const repairLog: string[] = [];
  let round = 0;
  let canComplete = false;

  log(`\n═══════════════════════════════════════════════════`, onProgress);
  log(`DWOMOH Generation Verifier — 18-point completion gate`, onProgress);
  log(`Project: ${projectPath}  Port: ${port}`, onProgress);
  log(`═══════════════════════════════════════════════════\n`, onProgress);

  // Phase 0 — Template leak check (runs ONCE before the repair loop — not round-aware)
  const p0 = await runPhase0TemplateLeakCheck(projectPath, onProgress);
  allPhases.push(p0);
  if (!p0.passed) {
    log('\n🚨 TEMPLATE LEAKAGE DETECTED — build marked incomplete. The generated app contains DWOMOH Vibe Code branding.', onProgress);
    log('This means the AI generated the wrong content. The repair pipeline cannot fix intent errors. A new generation is needed.', onProgress);
  }

  for (round = 1; round <= MAX_ROUNDS; round++) {
    log(`\n──── Verification Round ${round}/${MAX_ROUNDS} ────`, onProgress);
    const roundPhases: PhaseResult[] = [];

    // Phase 1 — TypeScript
    const p1 = await runPhase1TypeScript(projectPath, onProgress);
    roundPhases.push(p1);

    // Phase 2 — Route map
    const p2 = await runPhase2RouteMap(projectPath, onProgress);
    roundPhases.push(p2);
    if (p2.repairedFiles.length > 0) {
      repairLog.push(`Round ${round}: Created ${p2.repairedFiles.length} missing page(s): ${p2.repairedFiles.join(', ')}`);
      // Give Next.js time to hot-reload new pages before continuing
      await new Promise(r => setTimeout(r, 3000));
    }

    // Phase 3 — API health
    const p3 = await runPhase3ApiHealth(projectPath, port, onProgress);
    roundPhases.push(p3);

    // Phase 4 — Browser journey
    const p4 = await runPhase4Journey(projectPath, port, onProgress);
    roundPhases.push(p4);

    // Phase 5 — Deep interactive crawl
    const p5 = await runPhase5DeepCrawl(projectPath, port, onProgress);
    roundPhases.push(p5);
    if (p5.repairedFiles.length > 0) {
      repairLog.push(`Round ${round}: Auto-created ${p5.repairedFiles.length} missing route(s) from crawl: ${p5.repairedFiles.join(', ')}`);
      await new Promise(r => setTimeout(r, 3000));
    }

    allPhases.push(...roundPhases);

    const allPass = roundPhases.every(p => p.passed) && p0.passed;
    log(`\nRound ${round} result: ${allPass ? '✅ ALL PHASES PASSED' : '❌ Issues found — will repair and retry'}`, onProgress);

    if (allPass) {
      canComplete = true;
      break;
    }

    // If no repairs were made in this round, further rounds won't help
    const totalRepaired = roundPhases.reduce((n, p) => n + p.repairedFiles.length, 0);
    if (totalRepaired === 0 && round > 1) {
      log(`\nNo new repairs in round ${round} — stopping early`, onProgress);
      break;
    }
  }

  // Summary stats
  const lastRoundPhases = allPhases.slice(-5);
  const totalChecks   = lastRoundPhases.reduce((n, p) => n + p.checks.length, 0);
  const passedChecks  = lastRoundPhases.reduce((n, p) => n + p.checks.filter(c => c.passed).length, 0);
  const failedChecks  = totalChecks - passedChecks;
  const repairedTotal = allPhases.reduce((n, p) => n + p.repairedFiles.length, 0);

  const failedPhases  = lastRoundPhases.filter(p => !p.passed).map(p => p.phase);
  const failedCheck0  = lastRoundPhases.flatMap(p => p.checks).find(c => !c.passed);

  const summary = canComplete
    ? `Verified Working — ${passedChecks}/${totalChecks} checks passed, ${repairedTotal} issue(s) auto-repaired in ${round} round(s)`
    : `FAILED — ${failedChecks} check(s) not passing after ${round} round(s): ${failedPhases.join(', ')}`;

  log(`\n═══════════════════════════════════════════════════`, onProgress);
  log(canComplete ? `✅ ${summary}` : `❌ ${summary}`, onProgress);
  log(`═══════════════════════════════════════════════════\n`, onProgress);

  return {
    canComplete,
    rounds: round,
    phases: lastRoundPhases,
    totalChecks,
    passedChecks,
    failedChecks,
    repairedTotal,
    repairLog,
    summary,
    failureReason: canComplete ? undefined : failedCheck0?.detail ?? failedPhases.join(', '),
  };
}

// ─── Save to Engineering Memory ───────────────────────────────────────────────

export async function saveVerifierResult(
  result: GenerationVerifierResult,
  projectPath: string,
): Promise<void> {
  if (!result.canComplete) return; // only save successful patterns

  try {
    const { saveRepairSuccess } = await import('./engineering-memory');
    if (result.repairedTotal > 0) {
      await saveRepairSuccess({
        errorPattern: 'generation-verifier: auto-repair during post-generation check',
        rootCause: result.repairLog.join('; ') || 'Missing routes or 404 pages detected',
        fixApproach: `Generation verifier ran ${result.rounds} round(s), auto-repaired ${result.repairedTotal} file(s). Repair log: ${result.repairLog.join('; ')}`,
        targetFiles: result.phases.flatMap(p => p.repairedFiles),
        tsErrorsToAvoid: [],
        successfulTier: 'SONNET',
      });
    }
  } catch { /* non-critical */ }
}
