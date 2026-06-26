/**
 * Preview Verification Engine
 *
 * Inspects the RENDERED preview to confirm the app is visually functional.
 * "Build passing" is not proof of a working app — a broken CSS setup, missing
 * Tailwind config, or server-side crash can produce a running server that
 * renders plain unstyled HTML with no working UI.
 *
 * This service proves the app works by checking:
 *  1. Server responds at the preview URL
 *  2. CSS bundle is loaded and has meaningful size (>1KB indicates Tailwind is generating)
 *  3. Tailwind utility classes appear in the rendered HTML
 *  4. Core UI structure exists: navigation, main content, not just plain text
 *  5. Key pages respond (/, /login, /signup, /dashboard as applicable)
 *
 * Used as a gate: TypeScript ✅ + Build ✅ + Preview ✅ = success
 *                 TypeScript ✅ + Build ✅ + Preview ❌ = broken (must fix)
 */

import { readFile, readdir } from 'fs/promises';
import { join } from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

export type PreviewVerdict = 'healthy' | 'degraded' | 'unstyled' | 'error-page' | 'unreachable';

export interface PageCheckResult {
  url: string;
  statusCode: number;
  responseTimeMs: number;
  hasTailwindClasses: boolean;
  tailwindClassCount: number;
  hasNavigation: boolean;
  hasForms: boolean;
  hasContent: boolean;
  isErrorPage: boolean;
  isPlainHtml: boolean;
}

export interface PreviewInspectionResult {
  accessible: boolean;
  cssLoaded: boolean;
  cssSizeKb: number;
  tailwindClassCount: number;          // total across all inspected pages
  hasNavigation: boolean;
  hasForms: boolean;
  isUnstyled: boolean;                 // CSS present but no Tailwind classes
  isPlainHtml: boolean;                // no CSS at all
  pageResults: PageCheckResult[];
  issues: string[];
  verdict: PreviewVerdict;
  summary: string;
  debugDetail: string;
}

// ─── Tailwind class detection ─────────────────────────────────────────────────

// Common Tailwind utility prefixes — if these appear in class attributes,
// Tailwind is active and generating styles
const TAILWIND_PREFIX_RE = /\b(?:bg-|text-|flex(?:-|$)|grid(?:-|$)|items-|justify-|p-|px-|py-|pt-|pb-|pl-|pr-|m-|mx-|my-|mt-|mb-|ml-|mr-|w-|h-|max-w-|min-h-|min-w-|max-h-|rounded(?:-|$)|border(?:-|$)|shadow(?:-|$)|font-|leading-|tracking-|gap-|space-|overflow-|z-|opacity-|transition(?:-|$)|duration-|ease-|cursor-|inline(?:-|$)|block(?:$)|hidden(?:$)|absolute(?:$)|relative(?:$)|fixed(?:$)|sticky(?:$)|flex-|grid-|col-|row-|aspect-|inset-|top-|bottom-|left-|right-|sr-only)/;

function countTailwindClasses(html: string): number {
  const CLASS_ATTR_RE = /class(?:Name)?="([^"]+)"/gi;
  let total = 0;
  let m: RegExpExecArray | null;
  while ((m = CLASS_ATTR_RE.exec(html)) !== null) {
    const classes = m[1].split(/\s+/);
    total += classes.filter(c => TAILWIND_PREFIX_RE.test(c)).length;
  }
  return total;
}

function hasNavElements(html: string): boolean {
  return /<nav[\s>]|<header[\s>]|role="navigation"|<a\s[^>]*href/i.test(html);
}

function hasFormElements(html: string): boolean {
  return /<form[\s>]|<input[\s>]|<button[\s>]|<textarea[\s>]/i.test(html);
}

function hasContent(html: string): boolean {
  // Strip tags and check if meaningful text remains
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > 100;
}

function isNextJsErrorPage(html: string): boolean {
  return /nextjs__container_errors|__NEXT_DATA__|_next_error|Application error|Failed to compile/i.test(html);
}

// ─── CSS bundle check ─────────────────────────────────────────────────────────

async function checkCssBundle(
  port: number,
  html: string,
): Promise<{ loaded: boolean; sizeKb: number }> {
  // Find CSS link in HTML — Next.js injects these
  const cssLinkRe = /<link[^>]*href="([^"]+\.css[^"]*)"[^>]*\/?>/gi;
  let m: RegExpExecArray | null;
  let maxSize = 0;

  while ((m = cssLinkRe.exec(html)) !== null) {
    const href = m[1];
    const cssUrl = href.startsWith('http') ? href : `http://localhost:${port}${href}`;
    try {
      const res = await fetch(cssUrl, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const text = await res.text();
        maxSize = Math.max(maxSize, text.length);
      }
    } catch { /* skip */ }
  }

  return { loaded: maxSize > 0, sizeKb: maxSize / 1024 };
}

// ─── Per-page check ───────────────────────────────────────────────────────────

async function checkPage(port: number, path: string): Promise<PageCheckResult> {
  const url = `http://localhost:${port}${path}`;
  const t0 = Date.now();

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'Accept': 'text/html' },
    });
    const html = await res.text();
    const elapsed = Date.now() - t0;
    const twCount = countTailwindClasses(html);

    return {
      url,
      statusCode: res.status,
      responseTimeMs: elapsed,
      hasTailwindClasses: twCount >= 5,
      tailwindClassCount: twCount,
      hasNavigation: hasNavElements(html),
      hasForms: hasFormElements(html),
      hasContent: hasContent(html),
      isErrorPage: isNextJsErrorPage(html) || res.status >= 500,
      isPlainHtml: twCount < 3,
    };
  } catch (err) {
    return {
      url, statusCode: 0, responseTimeMs: Date.now() - t0,
      hasTailwindClasses: false, tailwindClassCount: 0,
      hasNavigation: false, hasForms: false, hasContent: false,
      isErrorPage: false, isPlainHtml: true,
    };
  }
}

// ─── Detect which pages exist ─────────────────────────────────────────────────

async function detectProjectPages(projectPath: string): Promise<string[]> {
  const pages: string[] = ['/'];
  const authPages = ['/login', '/signin', '/signup', '/register', '/forgot-password'];
  const dashPages = ['/dashboard'];

  async function tryPage(relPath: string, urlPath: string): Promise<void> {
    for (const ext of ['page.tsx', 'page.ts', 'page.jsx', 'page.js']) {
      try {
        await readFile(join(projectPath, 'app', relPath, ext), 'utf-8').catch(
          () => readFile(join(projectPath, 'app', relPath.replace(/^\//, ''), ext), 'utf-8')
        );
        pages.push(urlPath);
        return;
      } catch { /* try next */ }
    }
    // Also check under route groups
    try {
      const appDir = join(projectPath, 'app');
      const entries = await readdir(appDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && /^\([^)]+\)$/.test(e.name)) {
          const groupPath = join(appDir, e.name, relPath.replace(/^\//, ''));
          for (const ext of ['page.tsx', 'page.ts', 'page.jsx']) {
            try {
              await readFile(join(groupPath, ext), 'utf-8');
              pages.push(urlPath);
              return;
            } catch { /* continue */ }
          }
        }
      }
    } catch { /* skip */ }
  }

  await Promise.all([
    ...authPages.map(p => tryPage(p, p)),
    ...dashPages.map(p => tryPage(p, p)),
  ]);

  return [...new Set(pages)];
}

// ─── Main inspection function ─────────────────────────────────────────────────

export async function inspectPreview(
  port: number,
  projectPath: string,
): Promise<PreviewInspectionResult> {
  const issues: string[] = [];
  const debugLines: string[] = [];

  // Step 1: Check if server is reachable
  const homePage = await checkPage(port, '/');
  debugLines.push(`GET / → HTTP ${homePage.statusCode} (${homePage.responseTimeMs}ms)`);

  if (homePage.statusCode === 0) {
    return {
      accessible: false, cssLoaded: false, cssSizeKb: 0,
      tailwindClassCount: 0, hasNavigation: false, hasForms: false,
      isUnstyled: false, isPlainHtml: true,
      pageResults: [homePage],
      issues: ['Preview server is not responding — server may be starting or crashed'],
      verdict: 'unreachable',
      summary: 'Preview server is not responding',
      debugDetail: debugLines.join('\n'),
    };
  }

  if (homePage.isErrorPage) {
    issues.push('Homepage returns an error page (HTTP 500 or Next.js error overlay)');
  }

  // Step 2: Check CSS bundle
  let htmlContent = '';
  try {
    const res = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(5000) });
    htmlContent = await res.text();
  } catch { /* use empty string */ }

  const cssBundle = await checkCssBundle(port, htmlContent);
  debugLines.push(`CSS bundle: ${cssBundle.loaded ? `loaded (${cssBundle.sizeKb.toFixed(1)}KB)` : 'NOT FOUND'}`);

  if (!cssBundle.loaded) {
    issues.push('No CSS bundle found in page HTML — Tailwind/CSS may not be configured');
  } else if (cssBundle.sizeKb < 1) {
    issues.push(`CSS bundle is suspiciously small (${cssBundle.sizeKb.toFixed(2)}KB) — Tailwind may not be generating styles`);
  }

  // Step 3: Check each project page
  const pagePaths = await detectProjectPages(projectPath);
  debugLines.push(`Checking pages: ${pagePaths.join(', ')}`);

  const pageResults = await Promise.all(
    pagePaths.slice(0, 5).map(p => checkPage(port, p))
  );

  for (const pr of pageResults) {
    debugLines.push(`  ${pr.url} → ${pr.statusCode} | TW:${pr.tailwindClassCount} nav:${pr.hasNavigation} form:${pr.hasForms}`);
    if (pr.isErrorPage) issues.push(`${pr.url} returns an error page`);
    if (pr.isPlainHtml) issues.push(`${pr.url} appears to be rendering plain HTML with no Tailwind styles`);
  }

  // Step 4: Aggregate metrics
  const totalTwClasses = pageResults.reduce((n, p) => n + p.tailwindClassCount, 0);
  const anyNavigation = pageResults.some(p => p.hasNavigation);
  const anyForms = pageResults.some(p => p.hasForms);
  const allPlainHtml = pageResults.every(p => p.isPlainHtml);
  const anyErrorPages = pageResults.some(p => p.isErrorPage);

  debugLines.push(`Total Tailwind classes: ${totalTwClasses}`);
  debugLines.push(`Navigation found: ${anyNavigation}`);
  debugLines.push(`Forms found: ${anyForms}`);

  if (totalTwClasses < 10 && pagePaths.length > 0) {
    issues.push(`Very few Tailwind utility classes found (${totalTwClasses}) — app appears unstyled`);
  }

  if (!anyNavigation && homePage.statusCode === 200) {
    issues.push('No navigation elements found — header/nav may not be rendering');
  }

  // Step 5: Determine verdict
  let verdict: PreviewVerdict;
  if (anyErrorPages && totalTwClasses < 5) {
    verdict = 'error-page';
  } else if (allPlainHtml || (totalTwClasses < 5 && !cssBundle.loaded)) {
    verdict = 'unstyled';
  } else if (totalTwClasses < 10 || !cssBundle.loaded || issues.length >= 3) {
    verdict = 'degraded';
  } else {
    verdict = 'healthy';
  }

  const summary = verdict === 'healthy'
    ? `Preview verified — ${totalTwClasses} Tailwind classes, CSS loaded (${cssBundle.sizeKb.toFixed(0)}KB)`
    : `Preview broken: ${issues[0] ?? 'unknown issue'}`;

  return {
    accessible: true,
    cssLoaded: cssBundle.loaded,
    cssSizeKb: cssBundle.sizeKb,
    tailwindClassCount: totalTwClasses,
    hasNavigation: anyNavigation,
    hasForms: anyForms,
    isUnstyled: allPlainHtml && cssBundle.loaded,
    isPlainHtml: !cssBundle.loaded || totalTwClasses < 3,
    pageResults,
    issues,
    verdict,
    summary,
    debugDetail: debugLines.join('\n'),
  };
}
