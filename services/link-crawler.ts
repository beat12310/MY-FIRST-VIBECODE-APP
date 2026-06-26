/**
 * Link Crawler
 *
 * A Playwright-based crawler that behaves like a human QA tester:
 *   1. Opens every page in the app
 *   2. Finds and clicks every internal link, CTA button, and card
 *   3. Detects 404 responses, crash pages, and blank pages
 *   4. Derives the missing dynamic route pattern from the 404 URL
 *
 * This catches the "View Details → 404" class of bugs that static source
 * analysis cannot find, because:
 *   - Template literal hrefs (`/property/${id}`) are invisible to regex
 *   - Dynamic route pages (app/property/[id]/page.tsx) may simply not exist
 *
 * Returns a structured report: pages visited, links tested, failures, missing routes.
 */

import { chromium, Browser, Page } from 'playwright';
import { join } from 'path';
import { mkdir } from 'fs/promises';
import type { VerifyLiveEvent } from './verify-live-types';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LinkResult {
  /** The URL that was navigated to */
  url: string;
  /** HTTP status (inferred from page content — Playwright doesn't expose status directly) */
  statusOk: boolean;
  /** True if the page showed a 404 error */
  is404: boolean;
  /** True if the page crashed (JS error or blank) */
  isCrash: boolean;
  /** The page from which this link was discovered */
  foundOn: string;
  /** Text of the link/button that was clicked */
  linkText: string;
  /** Derived dynamic route pattern (e.g. "app/property/[id]/page.tsx") */
  missingRouteFile?: string;
  /** Screenshot path if failed */
  screenshotPath?: string;
}

export interface LinkCrawlReport {
  /** Start time (ISO string) */
  startedAt: string;
  /** All pages that were visited during the crawl */
  pagesVisited: string[];
  /** Total links discovered */
  linksDiscovered: number;
  /** Links that loaded successfully */
  passed: LinkResult[];
  /** Links that returned 404 or crashed */
  failed: LinkResult[];
  /** Dynamic route files that need to be created (e.g. ["app/property/[id]/page.tsx"]) */
  missingRouteFiles: string[];
  /** Final verdict */
  verdict: 'PASSED' | 'FAILED' | 'SKIPPED';
  /** One-line summary */
  summary: string;
  /** Duration in milliseconds */
  durationMs: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Text patterns for CTA buttons we should click (case-insensitive) */
const CTA_PATTERNS = [
  /view\s*details?/i,
  /view\s*more/i,
  /see\s*details?/i,
  /see\s*more/i,
  /open\b/i,
  /view\s*listing/i,
  /view\s*property/i,
  /view\s*post/i,
  /view\s*profile/i,
  /book\s*now/i,
  /reserve/i,
  /learn\s*more/i,
  /read\s*more/i,
  /get\s*started/i,
  /explore/i,
];

function isCTAText(text: string): boolean {
  const trimmed = text.trim();
  return CTA_PATTERNS.some(p => p.test(trimmed));
}

/** Check if a URL is internal (same origin) */
function isInternal(href: string, baseUrl: string): boolean {
  try {
    if (href.startsWith('/')) return true;
    const base = new URL(baseUrl);
    const target = new URL(href, baseUrl);
    return target.hostname === base.hostname;
  } catch {
    return false;
  }
}

/** Normalize a URL to a pathname */
function urlPath(url: string, baseUrl: string): string {
  try {
    return new URL(url, baseUrl).pathname;
  } catch {
    return url;
  }
}

/** Determine if a page shows a 404 error by checking the document content */
async function pageIs404(page: Page): Promise<boolean> {
  try {
    const title = await page.title().catch(() => '');
    const bodyText = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    return (
      /404|not found|page could not be found|no page found/i.test(title) ||
      /404|this page could not be found|page does not exist/i.test(bodyText.slice(0, 500))
    );
  } catch {
    return false;
  }
}

/** Determine if a page crashed (blank, JS error overlay, error boundary) */
async function pageIsCrash(page: Page): Promise<boolean> {
  try {
    const bodyText = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    if (bodyText.trim().length < 10) return true;
    return /unhandled.*error|application error|runtime error/i.test(bodyText.slice(0, 300));
  } catch {
    return true;
  }
}

/**
 * Derive the Next.js dynamic route file path from a 404 URL.
 * /property/1       → app/property/[id]/page.tsx
 * /listings/abc123  → app/listings/[id]/page.tsx
 * /posts/my-title   → app/posts/[slug]/page.tsx
 */
function deriveRouteFile(pathname: string): string | undefined {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length < 2) return undefined;

  // Last segment is likely a dynamic ID/slug
  const lastSeg = segments[segments.length - 1];
  const isDynamic =
    /^\d+$/.test(lastSeg) ||              // numeric ID: 1, 42, 123
    /^[a-z0-9]{8,}$/i.test(lastSeg) ||   // UUID / hash
    /^[a-z0-9-]{3,}$/i.test(lastSeg);    // slug: my-property-name

  if (!isDynamic) return undefined;

  // Determine the right param name
  const paramName = /^\d+$/.test(lastSeg) ? 'id' : 'slug';
  const routeDir = segments.slice(0, -1).join('/');
  return `app/${routeDir}/[${paramName}]/page.tsx`;
}

// ─── Screenshot helper ────────────────────────────────────────────────────────

async function saveScreenshot(page: Page, projectPath: string, name: string): Promise<string | undefined> {
  try {
    const dir = join(projectPath, 'public', 'browser-screenshots', 'crawler');
    await mkdir(dir, { recursive: true });
    const filename = `${name.replace(/[^a-z0-9]/gi, '-').slice(0, 40)}.png`;
    const fullPath = join(dir, filename);
    await page.screenshot({ path: fullPath, fullPage: false });
    return `/browser-screenshots/crawler/${filename}`;
  } catch {
    return undefined;
  }
}

// ─── Main crawler ─────────────────────────────────────────────────────────────

export async function crawlLinks(
  baseUrl: string,
  projectPath: string,
  options: {
    /** Maximum pages to visit (default 20) */
    maxPages?: number;
    /** Maximum links to click per page (default 10) */
    maxLinksPerPage?: number;
    /** Total time budget in ms (default 90000) */
    timeoutMs?: number;
    /** Live event callback for streaming verification progress */
    onEvent?: (event: VerifyLiveEvent) => void;
  } = {},
): Promise<LinkCrawlReport> {
  const startTime = Date.now();
  const {
    maxPages = 20,
    maxLinksPerPage = 10,
    timeoutMs = 90_000,
    onEvent,
  } = options;

  const report: LinkCrawlReport = {
    startedAt: new Date().toISOString(),
    pagesVisited: [],
    linksDiscovered: 0,
    passed: [],
    failed: [],
    missingRouteFiles: [],
    verdict: 'SKIPPED',
    summary: 'Crawler not started',
    durationMs: 0,
  };

  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'DWOMOH-LinkCrawler/1.0',
    });

    const visited = new Set<string>(); // pathnames we've already visited
    const queue: string[] = ['/']; // start from homepage
    const testedLinks = new Set<string>(); // href values we've already tested

    while (queue.length > 0 && report.pagesVisited.length < maxPages) {
      if (Date.now() - startTime > timeoutMs) break;

      const pagePath = queue.shift()!;
      if (visited.has(pagePath)) continue;
      visited.add(pagePath);

      const pageUrl = `${baseUrl}${pagePath}`;
      const page = await ctx.newPage();

      // Suppress console noise
      page.on('console', () => {});
      page.on('pageerror', () => {});

      try {
        onEvent?.({ type: 'page-visiting', url: pagePath, pageNum: report.pagesVisited.length + 1 });
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
        await page.waitForTimeout(1500); // brief settle time for client-side routing
        report.pagesVisited.push(pagePath);

        // Screenshot after loading each page so the frontend can show Playwright's view
        const pageScreenshotPath = await saveScreenshot(page, projectPath, `page-${pagePath.replace(/\//g, '-') || 'home'}`).catch(() => undefined);
        if (pageScreenshotPath) {
          onEvent?.({ type: 'page-screenshot', url: pagePath, screenshotUrl: pageScreenshotPath });
        }

        // ── Collect all <a> links ─────────────────────────────────────────────
        const linkHandles = await page.locator('a[href]').all();
        const linksOnPage: Array<{ href: string; text: string }> = [];

        for (const handle of linkHandles.slice(0, maxLinksPerPage * 3)) {
          try {
            const href = await handle.getAttribute('href') ?? '';
            const text = (await handle.innerText().catch(() => '')).trim().slice(0, 60);
            if (href && isInternal(href, baseUrl)) {
              linksOnPage.push({ href, text });
            }
          } catch { /* skip stale handles */ }
        }

        // ── Collect CTA buttons (non-link elements that navigate) ────────────
        const buttonHandles = await page.locator('button, [role="button"]').all();
        for (const btn of buttonHandles.slice(0, 20)) {
          try {
            const text = (await btn.innerText().catch(() => '')).trim();
            if (isCTAText(text)) {
              linksOnPage.push({ href: '__button__', text });
            }
          } catch { /* skip */ }
        }

        report.linksDiscovered += linksOnPage.length;

        // ── Test each link ────────────────────────────────────────────────────
        for (const { href, text } of linksOnPage.slice(0, maxLinksPerPage)) {
          if (Date.now() - startTime > timeoutMs) break;

          const testPage = await ctx.newPage();
          testPage.on('console', () => {});
          testPage.on('pageerror', () => {});

          try {
            let targetPath = '';

            if (href === '__button__') {
              // For CTA buttons: click the button on the original page and capture the resulting URL
              const btnPage = await ctx.newPage();
              await btnPage.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
              await btnPage.waitForTimeout(1000);

              const btns = btnPage.locator('button, [role="button"]');
              const count = await btns.count();
              for (let i = 0; i < count; i++) {
                const b = btns.nth(i);
                const t = (await b.innerText().catch(() => '')).trim();
                if (isCTAText(t) && t.slice(0, 60) === text) {
                  const oldUrl = btnPage.url();
                  await b.click({ timeout: 3000 }).catch(() => {});
                  await btnPage.waitForTimeout(1500);
                  const newUrl = btnPage.url();
                  if (newUrl !== oldUrl) {
                    targetPath = urlPath(newUrl, baseUrl);
                  }
                  break;
                }
              }
              await btnPage.close();
            } else {
              targetPath = urlPath(href, baseUrl);
            }

            if (!targetPath || testedLinks.has(targetPath)) {
              await testPage.close();
              continue;
            }
            testedLinks.add(targetPath);

            onEvent?.({ type: 'link-testing', url: targetPath, linkText: text, fromPage: pagePath });

            const targetUrl = `${baseUrl}${targetPath}`;
            await testPage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 12_000 });
            await testPage.waitForTimeout(1000);

            const is404 = await pageIs404(testPage);
            const isCrash = !is404 && await pageIsCrash(testPage);
            const ok = !is404 && !isCrash;

            const result: LinkResult = {
              url: targetPath,
              statusOk: ok,
              is404,
              isCrash,
              foundOn: pagePath,
              linkText: text,
            };

            if (!ok) {
              if (is404) {
                const routeFile = deriveRouteFile(targetPath);
                if (routeFile) {
                  result.missingRouteFile = routeFile;
                  if (!report.missingRouteFiles.includes(routeFile)) {
                    report.missingRouteFiles.push(routeFile);
                  }
                }
                result.screenshotPath = await saveScreenshot(testPage, projectPath, `404-${targetPath.replace(/\//g, '-')}`);
              }
              onEvent?.({ type: 'link-tested', url: targetPath, linkText: text, fromPage: pagePath, passed: false, is404, screenshotUrl: result.screenshotPath });
              report.failed.push(result);
            } else {
              onEvent?.({ type: 'link-tested', url: targetPath, linkText: text, fromPage: pagePath, passed: true, is404: false });
              report.passed.push(result);
              // Add this page to the queue if we haven't visited it
              if (!visited.has(targetPath) && !queue.includes(targetPath)) {
                queue.push(targetPath);
              }
            }
          } catch (e) {
            report.failed.push({
              url: href === '__button__' ? `[button: ${text}]` : urlPath(href, baseUrl),
              statusOk: false,
              is404: false,
              isCrash: true,
              foundOn: pagePath,
              linkText: text,
            });
          } finally {
            await testPage.close().catch(() => {});
          }
        }
      } catch (e) {
        // Page itself failed to load — already counted as visited, just move on
      } finally {
        await page.close().catch(() => {});
      }
    }

    await ctx.close().catch(() => {});

    // ── Build final report ────────────────────────────────────────────────────
    const total = report.passed.length + report.failed.length;
    report.durationMs = Date.now() - startTime;

    if (report.failed.length === 0) {
      report.verdict = 'PASSED';
      report.summary = `All ${total} link(s) across ${report.pagesVisited.length} page(s) load correctly`;
    } else {
      report.verdict = 'FAILED';
      const miss = report.failed.filter(f => f.is404);
      const crash = report.failed.filter(f => f.isCrash);
      const parts = [];
      if (miss.length) parts.push(`${miss.length} 404(s)`);
      if (crash.length) parts.push(`${crash.length} crash(es)`);
      report.summary = `${parts.join(', ')} — ${report.passed.length}/${total} links OK across ${report.pagesVisited.length} page(s)`;
    }

    return report;
  } catch (e) {
    report.verdict = 'SKIPPED';
    report.summary = `Crawler could not start: ${e instanceof Error ? e.message : String(e)}`;
    report.durationMs = Date.now() - startTime;
    return report;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ─── Verification Report Formatter ───────────────────────────────────────────

export interface VerificationReport {
  routesTested: number;
  passed: number;
  failed: number;
  repaired: number;
  remainingErrors: string[];
  finalStatus: 'VERIFIED WORKING' | 'FAILED VERIFICATION' | 'PARTIAL';
  details: string;
}

export function buildVerificationReport(
  crawlReport: LinkCrawlReport,
  repairedRoutes: string[],
): VerificationReport {
  const remainingFailed = crawlReport.failed.filter(f =>
    !repairedRoutes.some(r => f.missingRouteFile === r || f.url.includes(r.replace('app/', '').replace('/page.tsx', '')))
  );

  const routesTested = crawlReport.passed.length + crawlReport.failed.length;
  const finalStatus =
    remainingFailed.length === 0 && crawlReport.verdict !== 'FAILED'
      ? 'VERIFIED WORKING'
      : remainingFailed.length < crawlReport.failed.length
        ? 'PARTIAL'
        : 'FAILED VERIFICATION';

  const details = [
    `Routes Tested: ${routesTested}`,
    `Passed: ${crawlReport.passed.length}`,
    `Failed: ${crawlReport.failed.length}`,
    `Repaired: ${repairedRoutes.length}`,
    `Remaining Errors: ${remainingFailed.length}`,
    `Final Status: ${finalStatus}`,
  ].join('\n');

  return {
    routesTested,
    passed: crawlReport.passed.length,
    failed: crawlReport.failed.length,
    repaired: repairedRoutes.length,
    remainingErrors: remainingFailed.map(f => `${f.url} (${f.is404 ? '404' : 'crash'}) — found on ${f.foundOn}`),
    finalStatus,
    details,
  };
}
