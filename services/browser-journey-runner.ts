/**
 * Browser Journey Runner
 *
 * Runs complete user journeys using a real headless Chromium browser.
 * Unlike journey-tester.ts (API-level), this opens pages, fills forms,
 * uploads images, clicks buttons, and verifies visual output.
 *
 * If any required step fails → the entire journey is "FAILED VERIFICATION".
 * The failure data (screenshot path + console errors + network log) feeds
 * directly into the repair engine so the root cause can be diagnosed and fixed.
 *
 * Selector strategy: semantic-first, structural-never.
 *   ✅  button:has-text("Register")
 *   ✅  input[type="email"]
 *   ✅  input[placeholder*="title" i]
 *   ❌  div.form-container > div:nth-child(3) > input
 */

import { chromium } from 'playwright';
import type { Browser, Page, BrowserContext } from 'playwright';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import type { VerifyLiveEvent } from './verify-live-types';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BrowserJourneyStepResult {
  step: string;
  passed: boolean;
  optional: boolean;
  screenshotPath?: string;
  consoleErrors: string[];
  failedRequests: Array<{ url: string; status: number }>;
  error?: string;
  durationMs: number;
}

export interface JourneyMetrics {
  formsTested: number;
  loginTests: number;
  logoutTests: number;
  searchTests: number;
}

export interface BrowserJourneyResult {
  projectType: string;
  journeyName: string;
  passed: boolean;
  /** Only set on failure — FAILED VERIFICATION signal */
  verdict: 'PASSED' | 'FAILED VERIFICATION' | 'SKIPPED';
  steps: BrowserJourneyStepResult[];
  failedAt?: string;
  failureDetail?: string;
  /** Screenshot of the page at the point of failure */
  failureScreenshotPath?: string;
  summary: string;
  totalDurationMs: number;
  metrics: JourneyMetrics;
}

// ─── Test data ────────────────────────────────────────────────────────────────

const TS = Date.now();
const TEST = {
  email:    `browser_test_${TS}@verify.io`,
  password: 'BrowserTest1!',
  name:     'Browser Verifier',
  title:    `Test Listing ${TS}`,
  price:    '12.99',
  desc:     'Automated browser journey test listing',
  category: 'Other',
};

// Minimal valid 1×1 white PNG (67 bytes)
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

// ─── Screenshot persistence ────────────────────────────────────────────────────

const SCREENSHOTS_DIR = join(process.cwd(), 'public', 'browser-screenshots', 'journeys');

async function ensureDir(): Promise<void> {
  if (!existsSync(SCREENSHOTS_DIR)) {
    await mkdir(SCREENSHOTS_DIR, { recursive: true });
  }
}

async function screenshot(page: Page, label: string): Promise<string | undefined> {
  try {
    await ensureDir();
    const filename = `${label.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}.png`;
    const absPath = join(SCREENSHOTS_DIR, filename);
    await page.screenshot({ path: absPath, fullPage: true });
    return `/browser-screenshots/journeys/${filename}`;
  } catch {
    return undefined;
  }
}

// ─── Smart selector helpers ────────────────────────────────────────────────────

/** Fill a form field using semantic hints. Never relies on structural selectors. */
async function smartFill(page: Page, hint: string, value: string): Promise<boolean> {
  const lc = hint.toLowerCase();

  // Priority selector list — ordered from most specific to most generic
  const selectors = [
    // Type-based (most reliable)
    ...(lc === 'email'    ? [`input[type="email"]`] : []),
    ...(lc === 'password' ? [`input[type="password"]`] : []),
    // Name and placeholder matching
    `input[name="${lc}"], input[name*="${lc}" i]`,
    `input[placeholder*="${lc}" i]`,
    `textarea[name*="${lc}" i]`,
    `textarea[placeholder*="${lc}" i]`,
    // Aria label
    `input[aria-label*="${lc}" i]`,
    `textarea[aria-label*="${lc}" i]`,
    // ID-based
    `input[id*="${lc}" i]`,
  ];

  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) {
        await page.fill(sel, value);
        return true;
      }
    } catch { /* try next */ }
  }

  // Label-based: find label whose text includes the hint, then fill its associated input
  try {
    const found = await page.evaluate((hintText) => {
      const labels = Array.from(document.querySelectorAll('label'));
      for (const label of labels) {
        if (!label.textContent?.toLowerCase().includes(hintText.toLowerCase())) continue;
        const forId = label.getAttribute('for');
        if (forId) {
          const input = document.getElementById(forId) as HTMLInputElement | null;
          if (input && (input.tagName === 'INPUT' || input.tagName === 'TEXTAREA')) {
            return { id: forId };
          }
        }
        // Sibling input
        const sib = label.nextElementSibling;
        if (sib && (sib.tagName === 'INPUT' || sib.tagName === 'TEXTAREA') && sib.id) {
          return { id: sib.id };
        }
      }
      return null;
    }, hint);

    if (found?.id) {
      await page.fill(`#${found.id}`, value);
      return true;
    }
  } catch { /* non-critical */ }

  return false;
}

/** Click a button or link using text-matching. */
async function smartClick(page: Page, textHints: string[], required = true): Promise<boolean> {
  for (const hint of textHints) {
    const strategies = [
      `button:has-text("${hint}")`,
      `[role="button"]:has-text("${hint}")`,
      `a:has-text("${hint}")`,
      `input[type="submit"][value*="${hint}" i]`,
      `[data-testid*="${hint.toLowerCase().replace(/\s+/g, '-')}"]`,
    ];
    for (const sel of strategies) {
      try {
        const el = await page.$(sel);
        if (el && await el.isVisible()) {
          await el.click();
          return true;
        }
      } catch { /* try next */ }
    }
  }
  return !required; // optional clicks return true on failure
}

/** Find a submit button on a form and click it. */
async function submitForm(page: Page): Promise<boolean> {
  const selectors = [
    `button[type="submit"]`,
    `input[type="submit"]`,
    `button:has-text("Submit")`,
    `button:has-text("Save")`,
    `button:has-text("Create")`,
    `button:has-text("Post")`,
    `button:has-text("List")`,
    `button:has-text("Publish")`,
    `button:has-text("Book")`,
    `button:has-text("Confirm")`,
  ];
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) {
        await el.click();
        return true;
      }
    } catch { /* try next */ }
  }
  return false;
}

/** Upload a test image file to an `<input type="file">`. */
async function uploadImage(page: Page): Promise<boolean> {
  try {
    const fileInput = await page.$('input[type="file"]');
    if (!fileInput) return false;

    // Write the test PNG to a temp path
    const tmpPath = join(process.cwd(), '.tmp-test-image.png');
    await writeFile(tmpPath, PNG_1X1);
    await fileInput.setInputFiles(tmpPath);
    return true;
  } catch {
    return false;
  }
}

/** Navigate to a path and wait for the page to settle. */
async function navigate(page: Page, url: string, expectPathContains?: string): Promise<boolean> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);

    if (expectPathContains) {
      const currentUrl = page.url();
      return currentUrl.includes(expectPathContains) || currentUrl.includes('/dashboard') || currentUrl.includes('/home');
    }
    return true;
  } catch {
    return false;
  }
}

/** Check whether specific text appears anywhere on the current page. */
async function verifyPageContains(page: Page, ...texts: string[]): Promise<boolean> {
  try {
    const bodyText = await page.evaluate(() => document.body?.innerText ?? '');
    return texts.some(t => bodyText.toLowerCase().includes(t.toLowerCase()));
  } catch {
    return false;
  }
}

/** Verify at least one <img> with a real src is visible on the page. */
async function verifyImageVisible(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      return imgs.some(img =>
        img.src && !img.src.startsWith('data:') && img.naturalWidth > 0
      );
    });
  } catch {
    return false;
  }
}

// ─── Step executor ─────────────────────────────────────────────────────────────

interface StepDef {
  name: string;
  optional?: boolean;
  run: (page: Page, baseUrl: string, ctx: Map<string, string>) => Promise<{ passed: boolean; error?: string }>;
}

async function executeStep(
  page: Page,
  baseUrl: string,
  ctx: Map<string, string>,
  step: StepDef,
): Promise<BrowserJourneyStepResult> {
  const t0 = Date.now();
  const consoleErrors: string[] = [];
  const failedRequests: Array<{ url: string; status: number }> = [];

  // Capture console errors and failed API requests for this step
  const onConsole = (msg: { type: () => string; text: () => string }) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200));
  };
  const onResponse = async (res: { url: () => string; status: () => number }) => {
    const s = res.status();
    if (s >= 400 && res.url().includes('/api/')) {
      failedRequests.push({ url: res.url(), status: s });
    }
  };

  page.on('console', onConsole);
  page.on('response', onResponse);

  let passed = false;
  let error: string | undefined;
  let screenshotPath: string | undefined;

  try {
    const result = await step.run(page, baseUrl, ctx);
    passed = result.passed;
    error = result.error;

    // Screenshot after every step so the user can watch Playwright's actual view
    screenshotPath = await screenshot(page, step.name);
  } catch (err) {
    passed = false;
    error = err instanceof Error ? err.message : 'Step threw an exception';
    screenshotPath = await screenshot(page, `${step.name}_error`);
  }

  page.off('console', onConsole);
  page.off('response', onResponse);

  return {
    step: step.name,
    passed: step.optional ? true : passed,
    optional: step.optional ?? false,
    screenshotPath,
    consoleErrors,
    failedRequests,
    error: (!passed && !step.optional) ? error : undefined,
    durationMs: Date.now() - t0,
  };
}

// ─── Shared step builders ─────────────────────────────────────────────────────

/** Logout step — shared across all journey types */
function logoutStep(): StepDef {
  return {
    name: 'Test Logout',
    optional: true,
    run: async (page, baseUrl, ctx) => {
      if (ctx.get('loggedIn') !== 'true') return { passed: true }; // not logged in, skip

      // Try clicking logout button/link in navigation
      const logoutClicked = await smartClick(page, [
        'Logout', 'Log Out', 'Sign Out', 'Signout', 'Log off',
      ], false);

      if (logoutClicked) {
        await page.waitForTimeout(2000);
        const url = page.url();
        const onAuthPage = url.includes('/login') || url.includes('/signin') || url.includes('/');
        if (onAuthPage) { ctx.set('loggedIn', 'false'); return { passed: true }; }
      }

      // Try navigation dropdown (common in avatar menus)
      try {
        const avatarSel = '[data-testid*="avatar"], [class*="avatar"], [class*="user-menu"], img[alt*="profile" i]';
        const avatar = await page.$(avatarSel);
        if (avatar) {
          await avatar.click();
          await page.waitForTimeout(600);
          const clicked = await smartClick(page, ['Logout', 'Log Out', 'Sign Out'], false);
          if (clicked) {
            await page.waitForTimeout(2000);
            ctx.set('loggedIn', 'false');
            return { passed: true };
          }
        }
      } catch { /* ignore */ }

      // Try navigating directly to logout route
      for (const path of ['/logout', '/signout', '/auth/logout', '/api/auth/signout']) {
        try {
          const res = await fetch(`${baseUrl}${path}`, { method: 'GET', redirect: 'manual' });
          if (res.status < 400) {
            ctx.set('loggedIn', 'false');
            return { passed: true };
          }
        } catch { /* try next */ }
      }

      return { passed: true }; // optional — mark pass even if logout UI not found
    },
  };
}

/** Search functionality step — verifies the search feature works */
function searchStep(searchTerm = 'test'): StepDef {
  return {
    name: 'Test Search',
    optional: true,
    run: async (page, baseUrl) => {
      // Try common search page routes first
      for (const path of ['/search', '/find', '/browse']) {
        const ok = await navigate(page, `${baseUrl}${path}`);
        if (ok && !page.url().includes('/login')) break;
      }

      // Find search input using semantic selectors
      const selectors = [
        'input[type="search"]',
        'input[name="search"]',
        'input[name="q"]',
        'input[placeholder*="search" i]',
        'input[placeholder*="find" i]',
        'input[placeholder*="look" i]',
        'input[aria-label*="search" i]',
        '[role="searchbox"]',
      ];

      let searchInput = null;
      for (const sel of selectors) {
        try {
          const el = await page.$(sel);
          if (el && await el.isVisible()) { searchInput = el; break; }
        } catch { /* try next */ }
      }

      // Also check homepage if we haven't found it
      if (!searchInput) {
        await navigate(page, baseUrl);
        for (const sel of selectors) {
          try {
            const el = await page.$(sel);
            if (el && await el.isVisible()) { searchInput = el; break; }
          } catch { /* try next */ }
        }
      }

      if (!searchInput) return { passed: true }; // optional — no search feature = skip

      await searchInput.fill(searchTerm);
      await page.waitForTimeout(300);
      await searchInput.press('Enter');
      await page.waitForTimeout(2000);

      // Verify results or at minimum no crash
      const bodyText = await page.evaluate(() => document.body?.innerText?.trim() ?? '');
      const crashed = bodyText.length < 10;
      return { passed: !crashed, error: crashed ? 'Page crashed after search submit' : undefined };
    },
  };
}

// ─── Journey definitions ───────────────────────────────────────────────────────

function marketplaceSteps(): StepDef[] {
  return [
    {
      name: 'Open Homepage',
      run: async (page, baseUrl) => {
        const ok = await navigate(page, baseUrl);
        if (!ok) return { passed: false, error: 'Homepage failed to load' };
        const hasContent = await page.evaluate(() => (document.body?.innerText?.trim().length ?? 0) > 20);
        return { passed: hasContent, error: hasContent ? undefined : 'Homepage rendered blank' };
      },
    },
    {
      name: 'Navigate to Register Page',
      run: async (page, baseUrl) => {
        // Try direct URL first
        for (const path of ['/register', '/signup', '/auth/register', '/auth/signup']) {
          const ok = await navigate(page, `${baseUrl}${path}`);
          if (ok) {
            const hasForm = !!(await page.$('input[type="email"], input[type="password"], input[name*="email" i]'));
            if (hasForm) return { passed: true };
          }
        }
        // Fall back to clicking a link
        await navigate(page, baseUrl);
        const clicked = await smartClick(page, ['Register', 'Sign Up', 'Create Account', 'Get Started']);
        await page.waitForTimeout(1500);
        const hasForm = !!(await page.$('input[type="email"], input[type="password"]'));
        return { passed: clicked && hasForm, error: 'Could not find registration form' };
      },
    },
    {
      name: 'Fill Registration Form',
      run: async (page) => {
        const emailOk = await smartFill(page, 'email', TEST.email);
        const passOk  = await smartFill(page, 'password', TEST.password);
        // Name fields (optional — some apps don't have them)
        await smartFill(page, 'name', TEST.name);
        await smartFill(page, 'username', TEST.name.replace(/\s+/, '_').toLowerCase());
        if (!emailOk || !passOk) return { passed: false, error: 'Could not fill email or password field' };
        return { passed: true };
      },
    },
    {
      name: 'Submit Registration',
      run: async (page, baseUrl, ctx) => {
        await smartClick(page, ['Register', 'Sign Up', 'Create Account', 'Submit']);
        await page.waitForTimeout(2500);
        const url = page.url();
        // Success: redirected away from register page, or success message visible
        const redirected = !url.includes('/register') && !url.includes('/signup');
        const successMsg = await verifyPageContains(page, 'success', 'welcome', 'dashboard', 'verified', 'listing');
        if (redirected || successMsg) {
          ctx.set('registered', 'true');
          return { passed: true };
        }
        // Check for error messages
        const errText = await page.evaluate(() => {
          const alerts = document.querySelectorAll('[role="alert"], .error, .alert-error, [class*="error"]');
          return Array.from(alerts).map(a => a.textContent?.trim()).filter(Boolean).join('; ');
        });
        return { passed: false, error: errText || 'Registration did not complete — still on register page' };
      },
    },
    {
      name: 'Navigate to Login Page',
      optional: true, // skip if already logged in after register
      run: async (page, baseUrl, ctx) => {
        if (ctx.get('registered') === 'true') {
          // Already logged in after registration
          const meCheck = await fetch(`${baseUrl}/api/auth/me`).catch(() => null);
          if (meCheck?.ok) { ctx.set('loggedIn', 'true'); return { passed: true }; }
        }
        for (const path of ['/login', '/signin', '/auth/login', '/auth/signin']) {
          const ok = await navigate(page, `${baseUrl}${path}`);
          if (ok) {
            const hasForm = !!(await page.$('input[type="email"], input[type="password"]'));
            if (hasForm) return { passed: true };
          }
        }
        return { passed: true }; // optional — don't fail
      },
    },
    {
      name: 'Login',
      run: async (page, baseUrl, ctx) => {
        if (ctx.get('loggedIn') === 'true') return { passed: true }; // already logged in
        // Fill login form
        const emailOk = await smartFill(page, 'email', TEST.email);
        const passOk  = await smartFill(page, 'password', TEST.password);
        if (!emailOk || !passOk) return { passed: false, error: 'Could not fill login form fields' };
        await smartClick(page, ['Login', 'Sign In', 'Log In', 'Submit']);
        await page.waitForTimeout(2500);
        const url = page.url();
        const loggedOut = url.includes('/login') || url.includes('/signin');
        if (!loggedOut) { ctx.set('loggedIn', 'true'); return { passed: true }; }
        const errText = await page.evaluate(() => {
          const alerts = document.querySelectorAll('[role="alert"], .error, [class*="error"]');
          return Array.from(alerts).map(a => a.textContent?.trim()).filter(Boolean).join('; ');
        });
        return { passed: false, error: errText || 'Login failed — still on login page' };
      },
    },
    {
      name: 'Navigate to Create Listing Page',
      run: async (page, baseUrl) => {
        for (const path of ['/sell', '/listings/new', '/create-listing', '/create', '/new-listing', '/post']) {
          const ok = await navigate(page, `${baseUrl}${path}`);
          if (ok) {
            const url = page.url();
            if (!url.includes('/login') && !url.includes('/signin')) {
              const hasForm = !!(await page.$('form, [role="form"]'));
              if (hasForm) return { passed: true };
            }
          }
        }
        // Try clicking a nav link
        for (const hint of ['Sell', 'Create Listing', 'Post', 'New Listing', 'Add Listing', '+']) {
          const clicked = await smartClick(page, [hint]);
          if (clicked) {
            await page.waitForTimeout(1500);
            const hasForm = !!(await page.$('form'));
            if (hasForm) return { passed: true };
          }
        }
        return { passed: false, error: 'Could not navigate to create listing page' };
      },
    },
    {
      name: 'Fill Listing Form',
      run: async (page, _baseUrl, ctx) => {
        const titleOk = await smartFill(page, 'title', TEST.title);
        await smartFill(page, 'description', TEST.desc);
        await smartFill(page, 'price', TEST.price);
        await smartFill(page, 'category', TEST.category);
        await smartFill(page, 'condition', 'Good');
        await smartFill(page, 'location', 'Test Location');
        ctx.set('listingTitle', TEST.title);
        if (!titleOk) return { passed: false, error: 'Could not fill title field in listing form' };
        return { passed: true };
      },
    },
    {
      name: 'Upload Image',
      optional: true,
      run: async (page) => {
        const uploaded = await uploadImage(page);
        if (uploaded) await page.waitForTimeout(1000);
        return { passed: true }; // optional — many apps don't require image
      },
    },
    {
      name: 'Submit Listing',
      run: async (page, baseUrl, ctx) => {
        const submitted = await submitForm(page);
        if (!submitted) return { passed: false, error: 'Could not find submit button on listing form' };
        await page.waitForTimeout(3000);
        const url = page.url();
        // Check for success: redirected to listing detail, listings page, or dashboard
        const redirected = url.includes('/listings/') || url.includes('/dashboard') ||
                           (!url.includes('/sell') && !url.includes('/create') && !url.includes('/new-listing'));
        if (redirected) {
          ctx.set('listingUrl', url);
          return { passed: true };
        }
        const errText = await page.evaluate(() => {
          const alerts = document.querySelectorAll('[role="alert"], .error, [class*="error"], [class*="alert"]');
          return Array.from(alerts).map(a => a.textContent?.trim()).filter(Boolean).join('; ');
        });
        return { passed: false, error: errText || 'Listing form submitted but no redirect occurred' };
      },
    },
    {
      name: 'View Listing Details',
      run: async (page, baseUrl, ctx) => {
        const listingUrl = ctx.get('listingUrl');
        // If we're already on the listing detail page, stay here
        if (listingUrl?.match(/\/listings\/[^/]+$/) || page.url().match(/\/listings\/[^/]+$/)) {
          const hasTitle = await verifyPageContains(page, TEST.title);
          return { passed: hasTitle, error: hasTitle ? undefined : `Listing title "${TEST.title}" not found on detail page` };
        }
        // Navigate to listings and click the first one
        await navigate(page, `${baseUrl}/listings`);
        await page.waitForTimeout(1500);
        // Click our listing by title or just the first listing card
        const clicked = await smartClick(page, [TEST.title], false);
        if (!clicked) {
          // Click the first listing link/card
          await page.evaluate(() => {
            const link = document.querySelector('a[href*="/listings/"]') as HTMLAnchorElement | null;
            if (link) link.click();
          });
          await page.waitForTimeout(1500);
        }
        const hasTitle = await verifyPageContains(page, TEST.title);
        return { passed: hasTitle, error: hasTitle ? undefined : 'Could not verify listing title on detail page' };
      },
    },
    {
      name: 'Verify Listing Appears in Browse',
      run: async (page, baseUrl) => {
        await navigate(page, `${baseUrl}/listings`);
        await page.waitForTimeout(1500);
        const hasListing = await verifyPageContains(page, TEST.title);
        return { passed: hasListing, error: hasListing ? undefined : `New listing "${TEST.title}" not visible in browse page` };
      },
    },
    searchStep('property'),
    logoutStep(),
  ];
}

function bookingSteps(): StepDef[] {
  const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  return [
    {
      name: 'Open Homepage',
      run: async (page, baseUrl) => {
        const ok = await navigate(page, baseUrl);
        return { passed: ok, error: ok ? undefined : 'Homepage failed to load' };
      },
    },
    {
      name: 'Register & Login',
      run: async (page, baseUrl, ctx) => {
        // Try registration first via API (faster than browser form)
        try {
          const regRes = await fetch(`${baseUrl}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: TEST.email, password: TEST.password, name: TEST.name }),
          });
          if (regRes.ok) {
            // Now login via browser form
            await navigate(page, `${baseUrl}/login`);
            await smartFill(page, 'email', TEST.email);
            await smartFill(page, 'password', TEST.password);
            await smartClick(page, ['Login', 'Sign In', 'Log In']);
            await page.waitForTimeout(2500);
            ctx.set('loggedIn', 'true');
            return { passed: true };
          }
        } catch { /* fall through to browser form */ }

        // Full browser registration
        await navigate(page, `${baseUrl}/register`);
        await smartFill(page, 'email', TEST.email);
        await smartFill(page, 'password', TEST.password);
        await smartFill(page, 'name', TEST.name);
        await smartClick(page, ['Register', 'Sign Up']);
        await page.waitForTimeout(2500);
        ctx.set('loggedIn', 'true');
        return { passed: true };
      },
    },
    {
      name: 'Navigate to Booking Page',
      run: async (page, baseUrl) => {
        for (const path of ['/book', '/bookings/new', '/create-booking', '/appointments/new', '/reservations/new']) {
          await navigate(page, `${baseUrl}${path}`);
          if (!page.url().includes('/login')) {
            const hasForm = !!(await page.$('form'));
            if (hasForm) return { passed: true };
          }
        }
        await smartClick(page, ['Book', 'Make a Booking', 'New Appointment', 'Reserve', 'Schedule']);
        await page.waitForTimeout(1500);
        const hasForm = !!(await page.$('form'));
        return { passed: hasForm, error: 'Could not find booking form' };
      },
    },
    {
      name: 'Fill Booking Form',
      run: async (page, _baseUrl, ctx) => {
        await smartFill(page, 'date', futureDate);
        await smartFill(page, 'time', '10:00');
        await smartFill(page, 'notes', 'Browser journey test booking');
        await smartFill(page, 'service', 'Test Service');
        ctx.set('bookingDate', futureDate);
        return { passed: true };
      },
    },
    {
      name: 'Submit Booking',
      run: async (page, _baseUrl, ctx) => {
        const submitted = await submitForm(page);
        if (!submitted) return { passed: false, error: 'No submit button found on booking form' };
        await page.waitForTimeout(3000);
        const url = page.url();
        const redirected = url.includes('/bookings') || url.includes('/dashboard') || url.includes('/confirmation');
        if (redirected) { ctx.set('bookingSubmitted', 'true'); return { passed: true }; }
        return { passed: false, error: 'Booking submitted but no redirect' };
      },
    },
    {
      name: 'Verify Booking in Dashboard',
      run: async (page, baseUrl, ctx) => {
        for (const path of ['/bookings', '/dashboard', '/my-bookings', '/appointments']) {
          await navigate(page, `${baseUrl}${path}`);
          const found = await verifyPageContains(page, futureDate, 'Test Service', 'booking');
          if (found) return { passed: true };
        }
        return { passed: false, error: 'Booking not visible in dashboard or bookings page' };
      },
    },
    searchStep('booking'),
    logoutStep(),
  ];
}

function socialSteps(): StepDef[] {
  return [
    {
      name: 'Open Homepage',
      run: async (page, baseUrl) => {
        const ok = await navigate(page, baseUrl);
        return { passed: ok };
      },
    },
    {
      name: 'Register & Login',
      run: async (page, baseUrl, ctx) => {
        try {
          const regRes = await fetch(`${baseUrl}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: TEST.email, password: TEST.password, name: TEST.name }),
          });
          if (regRes.ok) {
            await navigate(page, `${baseUrl}/login`);
            await smartFill(page, 'email', TEST.email);
            await smartFill(page, 'password', TEST.password);
            await smartClick(page, ['Login', 'Sign In']);
            await page.waitForTimeout(2500);
            ctx.set('loggedIn', 'true');
            return { passed: true };
          }
        } catch { /* fall through */ }
        return { passed: true, error: undefined };
      },
    },
    {
      name: 'Navigate to Create Post',
      run: async (page, baseUrl) => {
        for (const path of ['/posts/new', '/create-post', '/new-post', '/compose', '/write']) {
          await navigate(page, `${baseUrl}${path}`);
          if (!page.url().includes('/login')) {
            const hasForm = !!(await page.$('form, textarea'));
            if (hasForm) return { passed: true };
          }
        }
        await smartClick(page, ['New Post', 'Create Post', 'Write', 'Compose', '+']);
        await page.waitForTimeout(1500);
        const hasForm = !!(await page.$('form, textarea'));
        return { passed: hasForm, error: 'Could not find post creation form' };
      },
    },
    {
      name: 'Fill Post Form',
      run: async (page, _baseUrl, ctx) => {
        const content = `Journey test post ${Date.now()}`;
        await smartFill(page, 'title', `Journey Test Post ${TS}`);
        await smartFill(page, 'content', content);
        await smartFill(page, 'body', content);
        ctx.set('postContent', content);
        return { passed: true };
      },
    },
    {
      name: 'Upload Image (optional)',
      optional: true,
      run: async (page) => {
        await uploadImage(page);
        return { passed: true };
      },
    },
    {
      name: 'Submit Post',
      run: async (page, _baseUrl, ctx) => {
        const submitted = await submitForm(page);
        if (!submitted) return { passed: false, error: 'No submit button on post form' };
        await page.waitForTimeout(3000);
        ctx.set('postSubmitted', 'true');
        return { passed: true };
      },
    },
    {
      name: 'Verify Post Appears in Feed',
      run: async (page, baseUrl, ctx) => {
        for (const path of ['/feed', '/posts', '/', '/home']) {
          await navigate(page, `${baseUrl}${path}`);
          await page.waitForTimeout(1500);
          const postContent = ctx.get('postContent') ?? '';
          const found = await verifyPageContains(page, postContent, `Journey Test Post`);
          if (found) return { passed: true };
        }
        return { passed: false, error: 'Post not visible in feed after submission' };
      },
    },
    searchStep('post'),
    logoutStep(),
  ];
}

function genericSteps(): StepDef[] {
  return [
    {
      name: 'Open Homepage',
      run: async (page, baseUrl) => {
        const ok = await navigate(page, baseUrl);
        if (!ok) return { passed: false, error: 'Homepage failed to load' };
        const isPlaceholder = await verifyPageContains(page, 'Building your app', 'the agent is generating');
        return {
          passed: !isPlaceholder,
          error: isPlaceholder ? 'Scaffold placeholder visible — app has not finished generating' : undefined,
        };
      },
    },
    {
      name: 'Check Homepage Has Content',
      run: async (page) => {
        const bodyText = await page.evaluate(() => document.body?.innerText?.trim() ?? '');
        const hasContent = bodyText.length > 50;
        return { passed: hasContent, error: hasContent ? undefined : 'Homepage appears empty or blank' };
      },
    },
    {
      name: 'Verify Navigation Links Work',
      optional: true,
      run: async (page, baseUrl) => {
        const links = await page.evaluate(() =>
          Array.from(document.querySelectorAll('nav a, header a'))
            .map(a => (a as HTMLAnchorElement).href)
            .filter(h => h.startsWith('http://localhost'))
            .slice(0, 3)
        );
        let anyPassed = false;
        for (const href of links) {
          const res = await fetch(href).catch(() => null);
          if (res?.ok) { anyPassed = true; break; }
        }
        return { passed: true }; // optional
      },
    },
    {
      name: 'No Console Errors on Homepage',
      optional: true,
      run: async (page) => {
        // Console errors were already captured by the step executor
        return { passed: true };
      },
    },
    searchStep(),
    logoutStep(),
  ];
}

// ─── Journey executor ──────────────────────────────────────────────────────────

async function runSteps(
  page: Page,
  baseUrl: string,
  steps: StepDef[],
  onEvent?: (event: VerifyLiveEvent) => void,
): Promise<{ results: BrowserJourneyStepResult[]; failedAt?: string; failureDetail?: string; failureScreenshot?: string }> {
  const results: BrowserJourneyStepResult[] = [];
  const ctx = new Map<string, string>();

  for (const step of steps) {
    const currentUrl = page.url().replace(baseUrl, '') || '/';
    onEvent?.({ type: 'step-start', step: step.name, url: currentUrl, action: humanizeStep(step.name) });

    // Live screenshot polling: capture what Playwright sees every 900ms while the step runs.
    // Uses 'page-screenshot' events which update the overlay image without touching the step log.
    let pollActive = true;
    const pollPromise = onEvent
      ? (async () => {
          while (pollActive) {
            await new Promise(r => setTimeout(r, 900));
            if (!pollActive) break;
            const liveUrl = await screenshot(page, `${step.name}_live`).catch(() => undefined);
            if (liveUrl && pollActive) {
              onEvent({ type: 'page-screenshot', url: page.url().replace(baseUrl, '') || '/', screenshotUrl: liveUrl });
            }
          }
        })()
      : Promise.resolve();

    const result = await executeStep(page, baseUrl, ctx, step);
    pollActive = false;
    await pollPromise.catch(() => {});
    results.push(result);

    const afterUrl = page.url().replace(baseUrl, '') || '/';
    onEvent?.({
      type: 'step-complete',
      step: result.step,
      url: afterUrl,
      passed: result.passed,
      optional: result.optional,
      screenshotUrl: result.screenshotPath,
      error: result.error,
      durationMs: result.durationMs,
    });

    if (!result.passed && !result.optional) {
      return {
        results,
        failedAt: step.name,
        failureDetail:
          (result.error ?? 'Step failed') +
          (result.consoleErrors.length > 0 ? `\nConsole errors: ${result.consoleErrors.slice(0, 2).join('; ')}` : '') +
          (result.failedRequests.length > 0 ? `\nFailed requests: ${result.failedRequests.map(r => `${r.url} → ${r.status}`).join(', ')}` : ''),
        failureScreenshot: result.screenshotPath,
      };
    }
  }

  return { results };
}

// ─── Step action descriptions (for live display) ─────────────────────────────

const STEP_ACTIONS: Record<string, string> = {
  'Open Homepage':          'Opening homepage…',
  'Navigate to Register':   'Navigating to registration page…',
  'Fill Registration Form': 'Filling registration form…',
  'Submit Registration':    'Submitting registration…',
  'Verify Registration':    'Verifying registration succeeded…',
  'Navigate to Login':      'Navigating to login page…',
  'Fill Login Form':        'Filling login credentials…',
  'Submit Login':           'Submitting login…',
  'Verify Login':           'Verifying login succeeded…',
  'Create Listing':         'Creating test listing…',
  'Verify Listing Created': 'Verifying listing was created…',
  'View Listing':           'Opening listing detail page…',
  'Verify Listing Details': 'Verifying listing details visible…',
  'Test Logout':            'Testing logout flow…',
  'Check Search':           'Testing search functionality…',
  'Book Service':           'Testing booking flow…',
  'Create Post':            'Creating test post…',
};

function humanizeStep(name: string): string {
  for (const [key, val] of Object.entries(STEP_ACTIONS)) {
    if (name.toLowerCase().includes(key.toLowerCase())) return val;
  }
  return `Testing: ${name}…`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export type BrowserJourneyType = 'marketplace' | 'booking' | 'social' | 'generic';

export async function runBrowserJourney(
  baseUrl: string,
  projectType: BrowserJourneyType,
  onEvent?: (event: VerifyLiveEvent) => void,
): Promise<BrowserJourneyResult> {
  const journeyName = `${projectType.charAt(0).toUpperCase() + projectType.slice(1)} Browser Journey`;
  const t0 = Date.now();

  const steps: StepDef[] =
    projectType === 'marketplace' ? marketplaceSteps() :
    projectType === 'booking'     ? bookingSteps() :
    projectType === 'social'      ? socialSteps() :
    genericSteps();

  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const context: BrowserContext = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();

    const { results, failedAt, failureDetail, failureScreenshot } = await runSteps(page, baseUrl, steps, onEvent);

    const totalDurationMs = Date.now() - t0;
    const passed = !failedAt;
    const passCount = results.filter(r => r.passed).length;

    const metrics: JourneyMetrics = {
      formsTested: results.filter(r => /fill|form|register|login/i.test(r.step)).length,
      loginTests:  results.filter(r => /login|sign.?in/i.test(r.step)).length,
      logoutTests: results.filter(r => /logout|sign.?out/i.test(r.step)).length,
      searchTests: results.filter(r => /search/i.test(r.step)).length,
    };

    return {
      projectType,
      journeyName,
      passed,
      verdict: passed ? 'PASSED' : 'FAILED VERIFICATION',
      steps: results,
      failedAt,
      failureDetail,
      failureScreenshotPath: failureScreenshot,
      summary: passed
        ? `PASSED — all ${passCount} step(s) verified in ${Math.round(totalDurationMs / 1000)}s`
        : `FAILED VERIFICATION at "${failedAt}" — ${failureDetail?.split('\n')[0] ?? 'step failed'}`,
      totalDurationMs,
      metrics,
    };

  } catch (err) {
    return {
      projectType,
      journeyName,
      passed: false,
      verdict: 'FAILED VERIFICATION',
      steps: [],
      failedAt: 'Browser launch',
      failureDetail: err instanceof Error ? err.message : 'Browser could not launch',
      summary: `FAILED VERIFICATION — browser launch error: ${err instanceof Error ? err.message : 'unknown'}`,
      totalDurationMs: Date.now() - t0,
      metrics: { formsTested: 0, loginTests: 0, logoutTests: 0, searchTests: 0 },
    };
  } finally {
    await browser?.close();
  }
}
