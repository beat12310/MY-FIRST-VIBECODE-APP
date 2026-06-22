/**
 * Browser Automation & Debugging — Feature 1 & 2
 * Uses Playwright (headless Chromium) to open pages, click, fill forms,
 * capture screenshots, and collect console/network/error debug info.
 */

import { chromium } from 'playwright';
import type { Browser, Page, ConsoleMessage, Request as PWRequest, Response as PWResponse } from 'playwright';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

export interface ScreenshotResult {
  success: boolean;
  screenshotUrl?: string;
  error?: string;
}

export interface ConsoleEntry {
  type: string;
  text: string;
}

export interface NetworkEntry {
  method: string;
  url: string;
  status?: number;
  responseBody?: string;
}

export interface DebugResult {
  success: boolean;
  pageTitle?: string;
  pageUrl?: string;
  consoleLogs?: ConsoleEntry[];
  networkRequests?: NetworkEntry[];
  runtimeErrors?: string[];
  screenshotUrl?: string;
  error?: string;
}

const SCREENSHOTS_DIR = join(process.cwd(), 'public', 'browser-screenshots');

async function ensureDir() {
  if (!existsSync(SCREENSHOTS_DIR)) {
    await mkdir(SCREENSHOTS_DIR, { recursive: true });
  }
}

async function launch(): Promise<Browser> {
  return chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
}

async function savePage(page: Page, prefix: string): Promise<string> {
  await ensureDir();
  const filename = `${prefix}-${Date.now()}.png`;
  await page.screenshot({ path: join(SCREENSHOTS_DIR, filename), fullPage: true });
  return `/browser-screenshots/${filename}`;
}

/** Open a URL and capture a full-page screenshot. */
export async function captureScreenshot(url: string, waitMs = 1500): Promise<ScreenshotResult> {
  let browser: Browser | null = null;
  try {
    browser = await launch();
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(waitMs);
    const screenshotUrl = await savePage(page, 'screenshot');
    return { success: true, screenshotUrl };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Screenshot failed' };
  } finally {
    await browser?.close();
  }
}

/** Click a CSS selector on a page and screenshot the result. */
export async function clickElement(url: string, selector: string): Promise<ScreenshotResult> {
  let browser: Browser | null = null;
  try {
    browser = await launch();
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.click(selector, { timeout: 10000 });
    await page.waitForTimeout(1200);
    const screenshotUrl = await savePage(page, 'click');
    return { success: true, screenshotUrl };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : `Click on "${selector}" failed` };
  } finally {
    await browser?.close();
  }
}

/**
 * Fill form fields and optionally submit, then screenshot.
 * fields: { 'input[name="city"]': 'Accra', 'select#type': 'rent' }
 */
export async function fillForm(
  url: string,
  fields: Record<string, string>,
  submitSelector?: string
): Promise<ScreenshotResult> {
  let browser: Browser | null = null;
  try {
    browser = await launch();
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

    for (const [selector, value] of Object.entries(fields)) {
      const tag = await page.evaluate(
        (sel: string) => document.querySelector(sel)?.tagName.toLowerCase(),
        selector
      );
      if (tag === 'select') {
        await page.selectOption(selector, value, { timeout: 8000 });
      } else {
        await page.fill(selector, value, { timeout: 8000 });
      }
    }

    if (submitSelector) {
      await page.click(submitSelector, { timeout: 8000 });
      await page.waitForTimeout(2000);
    }

    const screenshotUrl = await savePage(page, 'form');
    return { success: true, screenshotUrl };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Form interaction failed' };
  } finally {
    await browser?.close();
  }
}

/**
 * Open a page and collect console logs, network requests, API responses,
 * and runtime JS errors. Returns a screenshot alongside the debug data.
 */
export async function debugPage(url: string): Promise<DebugResult> {
  let browser: Browser | null = null;
  try {
    browser = await launch();
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });

    const consoleLogs: ConsoleEntry[] = [];
    const networkRequests: NetworkEntry[] = [];
    const runtimeErrors: string[] = [];

    page.on('console', (msg: ConsoleMessage) => {
      consoleLogs.push({ type: msg.type(), text: msg.text().slice(0, 300) });
    });

    page.on('pageerror', (err: Error) => {
      runtimeErrors.push(err.message + (err.stack ? '\n' + err.stack.split('\n')[1] : ''));
    });

    page.on('request', (req: PWRequest) => {
      if (req.url().includes('/api/')) {
        networkRequests.push({ method: req.method(), url: req.url() });
      }
    });

    page.on('response', async (res: PWResponse) => {
      if (!res.url().includes('/api/')) return;
      const entry = networkRequests.find(r => r.url === res.url() && r.status === undefined);
      if (!entry) return;
      entry.status = res.status();
      try {
        const body = await res.text();
        entry.responseBody = body.slice(0, 400);
      } catch { /* non-critical */ }
    });

    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2500);

    const pageTitle = await page.title();
    const pageUrl = page.url();
    const screenshotUrl = await savePage(page, 'debug');

    return { success: true, pageTitle, pageUrl, consoleLogs, networkRequests, runtimeErrors, screenshotUrl };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Debug session failed' };
  } finally {
    await browser?.close();
  }
}
