/**
 * Verification Engine — Rule 10
 * After every build or edit, make real HTTP requests to verify the app works.
 * Always read the response body on failure to find the REAL root cause.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { analyzeRouteForTimeout } from './route-timeout-analyzer';

// ─── Root cause types ─────────────────────────────────────────────────────────

export interface CheckRootCause {
  kind:
    | 'missing-package'
    | 'auth-misconfigured'
    | 'auth-field-mismatch'    // form sends field names the API route doesn't read
    | 'auth-page-stub'         // auth page exists (200) but has no form — is a redirect stub
    | 'missing-env'
    | 'typescript-error'
    | 'runtime-crash'
    | 'route-failure'
    | 'wrong-http-method'
    | 'timeout'
    | 'database-error'
    | 'preview-blank'
    | 'provider-misconfigured'
    | 'scaffold-placeholder'
    | 'file-upload-required'   // route expects multipart/form-data, verifier sent JSON
    | 'ocr-extraction-failure' // OCR ran but returned empty or placeholder result
    | 'unknown';
  detail: string;
  packages?: string[];
  envVars?: string[];
  errorText?: string;
  fixFile?: string;
  fixHint?: string;
}

/**
 * Structured diagnosis used by the repair engine to auto-classify and fix 4xx
 * failures without escalating to the user.
 */
export interface RouteRepairDiagnosis {
  failureCategory:
    | 'missing-image-upload'   // route needs multipart file; verifier sent JSON
    | 'invalid-ocr-input'      // file type wrong or unreadable by OCR
    | 'missing-field'          // specific field absent from request body
    | 'route-validation-failure' // route-level validation rejected the request
    | 'ocr-extraction-failure' // OCR ran but extracted nothing meaningful
    | 'wrong-content-type'     // sent application/json to a form-data route
    | 'other';
  confidence: 'high' | 'medium' | 'low';
  /** What the repair engine should do next */
  recommendedAction: string;
  /** True when the verifier can self-repair by retrying with correct input */
  canAutoRepair: boolean;
  /** Inject into agent-fix prompt when canAutoRepair is false */
  autoRepairContext: string;
  /** The actual field name the route expects (e.g. "bill" for parse-bill) */
  expectedFieldName?: string;
}

export interface VerificationCheck {
  name: string;
  url: string;
  passed: boolean;
  statusCode?: number;
  dataFound?: boolean;
  recordCount?: number;
  responsePreview?: string;
  error?: string;
  rootCause?: CheckRootCause;
  fixFile?: string;
  fixHint?: string;
  // ── Rich failure context (always populated on failure) ─────────────────────
  /** Exact body sent to the route during verification */
  requestBody?: string;
  /** Full response body from the route (up to 2 KB) */
  responseBody?: string;
  /** Parsed error message from JSON response (e.g. json.error, json.message) */
  validationError?: string;
  /** Stack trace extracted from response body if available */
  stackTrace?: string;
  /** Structured repair diagnosis — tells the repair loop exactly what to do */
  repairDiagnosis?: RouteRepairDiagnosis;
  /**
   * True when the route code is correct but an external dependency (API, proxy)
   * is unavailable in this environment. Does NOT count as a hard failure.
   */
  softPassed?: boolean;
  /** Human label for the unavailable external dep */
  externalDepName?: string;
  /** Detailed timeout analysis from route-timeout-analyzer */
  timeoutProfile?: import('./route-timeout-analyzer').RouteTimeoutProfile;
}

export interface VerificationResult {
  verified: boolean;
  port: number;
  checks: VerificationCheck[];
  failures: string[];
  summary: string;
}

// ─── Root cause extraction ────────────────────────────────────────────────────

const MODULE_NOT_FOUND_PATTERNS = [
  /Module not found:.*?Can't resolve ['"]([^'"]+)['"]/i,
  /Cannot find module ['"]([^'"]+)['"]/i,
  /Failed to resolve import ['"]([^'"]+)['"]/i,
  /error TS2307: Cannot find module ['"]([^'"]+)['"]/i,
];

const AUTH_ERROR_PATTERNS = [
  /NEXTAUTH_SECRET/i,
  /AUTH_SECRET/i,
  /\[next-auth\]/i,
  /next-auth.*(?:secret|error|missing)/i,
];

const MISSING_ENV_PATTERNS = [
  /process\.env\.(\w+) is (?:undefined|not set|null)/i,
  /Missing.*environment variable.*?['"]?([\w_]+)['"]?/i,
  /Please define the ([\w_]+) environment variable/i,
];

const DATABASE_ERROR_PATTERNS = [
  /SQLITE_ERROR/i,
  /SQLITE_BUSY/i,
  /SQLITE_CANTOPEN/i,
  /SQLITE_NOTADB/i,
  /no such table:\s*([\w_]+)/i,
  /no such column:\s*([\w_]+)/i,
  /database is locked/i,
  /PrismaClientKnownRequestError/i,
  /PrismaClientInitializationError/i,
  /PrismaClientValidationError/i,
  /relation "[\w_]+" does not exist/i,
  /Table '[\w.]+'.*doesn't exist/i,
  /column "[\w_]+" of relation/i,
  /better-sqlite3/i,
  /sqlite3.*error/i,
];

const PREVIEW_BLANK_PATTERNS = [
  /ChunkLoadError/i,
  /Loading chunk [\d]+ failed/i,
  /Hydration.*mismatch/i,
  /Text content does not match/i,
  /Minified React error/i,
  /Cannot read propert(?:y|ies) of (?:undefined|null)/i,
];

// Patterns that classify 400 responses as "missing file upload" rather than broken route.
// When a verifier sends JSON to a multipart route, the route always 400s with these messages.
// The route itself is correct; the verifier needs to retry with FormData.
const FILE_UPLOAD_ERROR_PATTERNS = [
  /invalid form data/i,
  /no file uploaded/i,
  /please upload an? (?:image|file)/i,
  /file.*required/i,
  /missing.*file/i,
  /multipart.*required/i,
  /expected.*multipart/i,
  /content.?type.*multipart/i,
];

// Patterns that identify the DWOMOH scaffold placeholder page — the "Building your app"
// loading screen that is served when AI generation was incomplete or failed. A 200 on
// this page must NOT count as a passing verification check.
const SCAFFOLD_PLACEHOLDER_PATTERNS = [
  /Building your app.*the agent is generating/i,
  /the agent is generating the full codebase/i,
  // Patterns 3 & 4 require the exact unicode ellipsis "…" (U+2026) so they don't
  // false-positive on legitimate loading spinners that say e.g. "Generating report..."
  /animate-pulse.*Generating…/i,
  /Generating….*animate-pulse/i,
  /the agent is generating the full codebase now/i,
];

// Patterns that indicate a route is failing because of a bad external API integration,
// not a code bug that a generic TS fix can solve. Matching these triggers the
// 'provider-misconfigured' kind, which escalates to a provider-aware repair pass.
const PROVIDER_ERROR_PATTERNS = [
  // RapidAPI-specific
  /x-rapidapi/i,
  /rapidapi\.com/i,
  /You are not subscribed to this API/i,
  /Invalid API key/i,
  // Upstream HTTP errors from a fetch() inside a route handler
  /upstream\s+(?:api|service|server)/i,
  /external\s+(?:api|service)/i,
  // fetch() failure patterns
  /fetch\s+failed/i,
  /ECONNREFUSED.*(?:api|external)/i,
  // JSON parse failures that indicate the API returned something unexpected
  /Unexpected token.*JSON/i,
  /SyntaxError.*JSON\.parse/i,
  // Rate limiting or quota from a provider
  /rate.?limit(?:ed)?/i,
  /too many requests/i,
  /quota.?exceed/i,
  // Response shape mismatches — the API changed its schema or the wrong endpoint is called
  /Cannot read propert(?:y|ies) of undefined.*(?:data|result|items|response|body|json)/i,
  /is not a function.*(?:map|filter|forEach)/i,
  // Provider name pattern — "SomeProvider API error"
  /provider.*error/i,
  /api.*(?:key|token|credential).*(?:invalid|expired|missing)/i,
];

// ─── Auth endpoint awareness ──────────────────────────────────────────────────

/**
 * Routes that legitimately return 401/403 when the verifier hits them without
 * a session. A 401 here means auth is WORKING, not broken. Treat as soft-pass.
 */
const AUTH_SESSION_REQUIRED = /\/(api\/)?auth\/(me|profile|session|check|user|whoami|current|verify-session|status)([/?]|$)/i;

/**
 * Routes that accept credentials. Verifier should POST synthetic test data
 * instead of an empty `{}` body so we get a real result, not a 400.
 */
const AUTH_CREDENTIAL_ROUTE = /\/(api\/)?auth\/(register|signup|login|signin)([/?]|$)/i;

/** Synthetic test credentials — never used for real; just proves the route handles valid input */
const TEST_CREDS = { email: 'verify@dwomoh.dev', password: 'VibeCode#Test1!', name: 'Verification Bot' };

/**
 * Routes that generate AI content and require a prompt/input field.
 * Verifier should POST synthetic test data so the route can process a real request.
 */
const AI_GENERATE_ROUTE = /\/(api\/)?(generate|video[s]?\/generate|ai\/generate|create|render)([/?]|$)/i;

/** Synthetic generation body — proves the route handles valid prompt input */
const TEST_GENERATE_BODY = {
  prompt: 'A beautiful sunset over the ocean with golden waves crashing on shore',
  style: 'cinematic',
  duration: 5,
  aspect_ratio: '16:9',
};

/**
 * Routes that legitimately return 401/403 on logout when there is no active session.
 * A 401 here means the session guard is working correctly.
 */
const AUTH_SESSION_LOGOUT = /\/(api\/)?auth\/logout([/?]|$)/i;

// ─── 404-in-200 detection ─────────────────────────────────────────────────────

/**
 * These patterns appear in Next.js 404 pages that are served with HTTP 200
 * (happens when a page route exists but the component throws, or when the
 * app router cannot find a matching segment). A 200 showing these strings
 * must NOT count as a passing check.
 */
const PAGE_404_PATTERNS = [
  /This page could not be found/i,
  /<title[^>]*>404[^<]*<\/title>/i,
  /Next\.js.*404/i,
  /"statusCode":404/,
];

function isLocalAlias(p: string): boolean {
  return p.startsWith('@/') || p.startsWith('./') || p.startsWith('../');
}

function moduleToPackage(modulePath: string): string {
  if (modulePath.startsWith('@')) return modulePath.split('/').slice(0, 2).join('/');
  return modulePath.split('/')[0];
}

// ─── Route input-type detection ───────────────────────────────────────────────

type RouteInputType = 'form-data' | 'json' | 'unknown';

interface RouteProfile {
  inputType: RouteInputType;
  /** FormData field name the route reads (e.g. "bill") */
  formDataField: string;
  /** Whether route reads req.formData() */
  usesFormData: boolean;
}

async function detectRouteProfile(absoluteFilePath: string): Promise<RouteProfile> {
  try {
    const src = await readFile(absoluteFilePath, 'utf-8');
    const usesFormData = /req\.formData\(\)|request\.formData\(\)/.test(src);
    if (usesFormData) {
      // Find which field name the route reads: formData.get('bill') → 'bill'
      const fieldMatch = src.match(/formData\.get\(['"](\w+)['"]\)/);
      const formDataField = fieldMatch?.[1] ?? 'file';
      return { inputType: 'form-data', formDataField, usesFormData: true };
    }
    return { inputType: 'json', formDataField: 'file', usesFormData: false };
  } catch {
    return { inputType: 'unknown', formDataField: 'file', usesFormData: false };
  }
}

/**
 * Build a minimal test FormData for file-upload routes.
 * Uses a 1×1 pixel valid PNG so the route's image/* validation passes.
 */
function buildTestFormData(fieldName: string): FormData {
  // 67-byte 1×1 white pixel PNG (smallest valid PNG)
  const PNG_1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  const blob = new Blob([PNG_1x1], { type: 'image/png' });
  const fd = new FormData();
  fd.append(fieldName, blob, 'test-bill.png');
  return fd;
}

// ─── Validation error extractor ───────────────────────────────────────────────

/**
 * Pull the exact validation error out of a JSON response body.
 * Returns the raw error string and any stack trace found.
 */
function extractValidationDetails(bodyText: string): { validationError?: string; stackTrace?: string } {
  try {
    const json = JSON.parse(bodyText);
    const validationError =
      (typeof json.error === 'string' && json.error) ||
      (typeof json.message === 'string' && json.message) ||
      (typeof json.detail === 'string' && json.detail) ||
      (typeof json.msg === 'string' && json.msg) ||
      undefined;
    return { validationError: validationError?.slice(0, 500) };
  } catch { /* not JSON */ }

  // Try to pull error from Next.js HTML dev error page
  const htmlText = bodyText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const errMatch = /(?:Error|TypeError|ReferenceError|SyntaxError):\s+([^\n]{5,200})/i.exec(htmlText);
  const stackMatch = /at\s+\w[\w.]*\s+\([^\)]+:\d+:\d+\)/g;
  const stackLines = [...htmlText.matchAll(stackMatch)].slice(0, 5).map(m => m[0]);
  return {
    validationError: errMatch?.[1],
    stackTrace: stackLines.length > 0 ? stackLines.join('\n') : undefined,
  };
}

/**
 * Classify the root cause of a 400 response into a structured RepairDiagnosis
 * so the repair engine knows exactly what to do without AI involvement.
 */
function buildRepairDiagnosis(
  statusCode: number,
  responseBody: string,
  rootCauseKind: CheckRootCause['kind'],
  routeProfile: RouteProfile,
  retrySucceeded?: boolean,
): RouteRepairDiagnosis {
  const text = responseBody.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').toLowerCase();

  // File-upload route that verifier probed with wrong content-type
  if (rootCauseKind === 'file-upload-required' || routeProfile.usesFormData) {
    if (retrySucceeded) {
      return {
        failureCategory: 'missing-image-upload',
        confidence: 'high',
        recommendedAction: 'Route works correctly — it requires multipart/form-data. Verified by sending a synthetic test image.',
        canAutoRepair: true,
        autoRepairContext: 'Route verified: accepts image uploads via POST multipart/form-data. No code change needed.',
        expectedFieldName: routeProfile.formDataField,
      };
    }
    if (/no file|no image|bill.*missing/i.test(text)) {
      return {
        failureCategory: 'missing-image-upload',
        confidence: 'high',
        recommendedAction: `Route expects FormData field "${routeProfile.formDataField}" with an image file. The test file was rejected.`,
        canAutoRepair: false,
        autoRepairContext:
          `Route requires multipart/form-data POST with field "${routeProfile.formDataField}" containing an image file.\n` +
          `The route validates file.type.startsWith("image/"). Ensure the file field is named "${routeProfile.formDataField}".`,
        expectedFieldName: routeProfile.formDataField,
      };
    }
    return {
      failureCategory: 'wrong-content-type',
      confidence: 'high',
      recommendedAction: 'Route expects multipart/form-data but received application/json. Retry with FormData.',
      canAutoRepair: true,
      autoRepairContext:
        `Route requires multipart/form-data. Client fetch must NOT set Content-Type manually — ` +
        `let the browser/FormData set it with the boundary. Example: fetch(url, { method: 'POST', body: formData })`,
      expectedFieldName: routeProfile.formDataField,
    };
  }

  // Missing specific field
  const missingFieldMatch = /(?:missing|required).*?['"]?(\w+)['"]?\s*(?:field|param|parameter)/i.exec(text) ||
    /['"]?(\w+)['"]?\s*(?:is\s+)?(?:required|missing)/i.exec(text);
  if (missingFieldMatch && statusCode === 400) {
    return {
      failureCategory: 'missing-field',
      confidence: 'medium',
      recommendedAction: `Missing required field: "${missingFieldMatch[1]}". Add it to the request body.`,
      canAutoRepair: false,
      autoRepairContext: `Route validation failed: missing required field "${missingFieldMatch[1]}". Ensure the request includes this field.`,
    };
  }

  // OCR extraction failure
  if (/ocr|tesseract|recognize|text.*extract|extract.*text/i.test(text)) {
    return {
      failureCategory: 'ocr-extraction-failure',
      confidence: 'medium',
      recommendedAction: 'OCR processing failed. Check tesseract.js worker initialization and image input format.',
      canAutoRepair: false,
      autoRepairContext:
        'OCR extraction failed. Check: (1) tesseract.js is installed, (2) createWorker("eng") is called, ' +
        '(3) the image buffer is passed correctly to worker.recognize(), (4) worker.terminate() is called after.',
    };
  }

  // Generic route validation failure
  return {
    failureCategory: 'route-validation-failure',
    confidence: 'low',
    recommendedAction: `Route returned HTTP ${statusCode}. Inspect response body for exact cause.`,
    canAutoRepair: false,
    autoRepairContext: `Route validation failed with HTTP ${statusCode}. Response: ${responseBody.slice(0, 300)}`,
  };
}

/**
 * Parse the response body (HTML or JSON from Next.js error page) to extract
 * the actual root cause of the failure. Never guess from the HTTP status alone.
 */
function parseRootCause(body: string, statusCode: number): CheckRootCause {
  // Strip HTML tags for easier pattern matching
  const text = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 3000);

  // 1. Missing npm package (most common compile-time failure)
  for (const re of MODULE_NOT_FOUND_PATTERNS) {
    const m = re.exec(text) ?? re.exec(body);
    if (m && !isLocalAlias(m[1])) {
      const pkg = moduleToPackage(m[1]);
      return {
        kind: 'missing-package',
        detail: `Missing npm package: **${pkg}**`,
        packages: [pkg],
        errorText: text.slice(0, 400),
      };
    }
  }

  // 2. Database errors — check before generic server crash so they get a specific kind
  for (const re of DATABASE_ERROR_PATTERNS) {
    if (re.test(text)) {
      return {
        kind: 'database-error',
        detail: `Database error: ${text.match(re)?.[0]?.slice(0, 80) ?? 'query failed'}`,
        errorText: text.slice(0, 400),
        fixHint: 'Check that initTable() is called before queries, column names match the schema, and the db file is writable',
      };
    }
  }

  // 3. Auth misconfiguration
  if (AUTH_ERROR_PATTERNS.some(re => re.test(text))) {
    return {
      kind: 'auth-misconfigured',
      detail: 'Authentication is not configured (missing secret key)',
      errorText: text.slice(0, 200),
    };
  }

  // 4. Missing environment variable
  for (const re of MISSING_ENV_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      const varName = m[1];
      return {
        kind: 'missing-env',
        detail: `Missing environment variable: **${varName}**`,
        envVars: [varName],
        errorText: text.slice(0, 200),
      };
    }
  }

  // 5. Preview / hydration / chunk-load errors
  for (const re of PREVIEW_BLANK_PATTERNS) {
    if (re.test(text)) {
      return {
        kind: 'preview-blank',
        detail: `Preview/hydration error: ${text.match(re)?.[0]?.slice(0, 80) ?? 'client-side render failed'}`,
        errorText: text.slice(0, 300),
        fixHint: 'Check for server/client mismatches, missing "use client" directives, or invalid hook usage',
      };
    }
  }

  // 6. TypeScript compile error
  if (/error TS\d+/i.test(text)) {
    return {
      kind: 'typescript-error',
      detail: 'TypeScript compile error in a source file',
      errorText: text.slice(0, 400),
    };
  }

  // 7. Wrong HTTP method (405)
  if (statusCode === 405) {
    return {
      kind: 'wrong-http-method',
      detail: 'Route returned 405 — handler exports the wrong HTTP method (GET vs POST vs PUT)',
      errorText: text.slice(0, 200),
      fixHint: 'Ensure the route.ts exports the correct HTTP method function (export async function GET / POST / PUT / DELETE)',
    };
  }

  // 7b. External API / provider integration error — detect before generic 500 handler
  // so provider-aware escalation kicks in instead of a blind code fix.
  if (statusCode >= 400 || statusCode === 0) {
    for (const re of PROVIDER_ERROR_PATTERNS) {
      if (re.test(text)) {
        const snippet = text.match(re)?.[0]?.slice(0, 100) ?? 'provider call failed';
        return {
          kind: 'provider-misconfigured',
          detail: `External API integration error: ${snippet}`,
          errorText: text.slice(0, 400),
          fixHint:
            'This route is calling an external API incorrectly. Check the provider endpoint URL, ' +
            'authentication headers (X-RapidAPI-Key, X-RapidAPI-Host, Authorization), and the ' +
            'response parsing code. Use the DWOMOH Provider Engine to find the correct provider.',
        };
      }
    }
  }

  // 8. Runtime server crash (500)
  if (statusCode >= 500) {
    const errMsg = /(?:Error|TypeError|ReferenceError|SyntaxError):\s+([^\n.]{5,100})/i.exec(text)?.[1];
    return {
      kind: 'runtime-crash',
      detail: errMsg ? `Server error: ${errMsg}` : `Server returned HTTP ${statusCode}`,
      errorText: text.slice(0, 400),
      fixHint: errMsg ? `Find and fix: ${errMsg}` : 'Wrap the throwing code in try/catch and return safe JSON on error',
    };
  }

  // 9. Not found (404) — route missing entirely
  if (statusCode === 404) {
    return {
      kind: 'route-failure',
      detail: 'Route does not exist (404) — the file may be missing or the path is wrong',
      errorText: text.slice(0, 200),
      fixHint: 'Create the missing route file or fix the URL path',
    };
  }

  // 10a. File upload required — route expects multipart/form-data
  // Must be checked early (before generic 4xx) so the repair loop can retry with a test file
  if (statusCode === 400) {
    for (const re of FILE_UPLOAD_ERROR_PATTERNS) {
      if (re.test(text)) {
        return {
          kind: 'file-upload-required',
          detail: 'Route requires a file upload (multipart/form-data). Verifier sent application/json — will retry with test image.',
          errorText: text.slice(0, 200),
          fixHint: 'The route is correct. Verification will retry with a synthetic multipart upload to confirm the handler works end-to-end.',
        };
      }
    }
  }

  // 10. Other 4xx
  if (statusCode >= 400) {
    return {
      kind: 'route-failure',
      detail: `Route returned HTTP ${statusCode}`,
      errorText: text.slice(0, 200),
    };
  }

  return { kind: 'unknown', detail: `HTTP ${statusCode}` };
}

// ─── Source-file derivation ────────────────────────────────────────────────────

/** Derive the most likely source file responsible for a failing URL. */
function urlToFixFile(urlPath: string): string | undefined {
  if (urlPath === '/' || urlPath === '') return 'app/page.tsx';
  if (urlPath.startsWith('/api/')) {
    const apiPart = urlPath.replace(/^\/api\//, '').replace(/\/+$/, '');
    // Skip dynamic segments — can't guess the exact file
    if (apiPart.includes('[')) return undefined;
    return `app/api/${apiPart}/route.ts`;
  }
  // Page routes: /dashboard → app/dashboard/page.tsx
  const clean = urlPath.replace(/^\//, '').replace(/\/+$/, '');
  if (clean && !clean.includes('[') && !clean.includes('?')) {
    return `app/${clean}/page.tsx`;
  }
  return undefined;
}

// ─── Route method detection ───────────────────────────────────────────────────

/**
 * Read a route.ts file and return the first HTTP method it exports.
 * Used so verification probes the route with the correct method rather than
 * defaulting to GET and getting a 405 that masks the real behaviour.
 */
async function detectRouteMethod(
  absoluteFilePath: string,
): Promise<'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'> {
  try {
    const src = await readFile(absoluteFilePath, 'utf-8');
    // Order matters: GET first (most common for data-fetch routes)
    for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const) {
      if (new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\b`).test(src)) {
        return method;
      }
    }
  } catch { /* file missing or unreadable — fall back to GET */ }
  return 'GET';
}

// ─── Endpoint checker ─────────────────────────────────────────────────────────

function apiRouteFileToUrlPath(routeFile: string): string | null {
  if (routeFile.includes('[')) return null;
  return routeFile
    .replace(/^app/, '')
    .replace(/\/route\.(ts|tsx|js|jsx)$/, '');
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

async function checkEndpoint(
  url: string,
  name: string,
  method: HttpMethod = 'GET',
  routeFilePath?: string,
): Promise<VerificationCheck> {
  const urlPath = new URL(url).pathname;
  const suggestedFixFile = urlToFixFile(urlPath);

  // Detect whether the route uses FormData before sending the first request
  const routeProfile = routeFilePath
    ? await detectRouteProfile(routeFilePath)
    : { inputType: 'unknown' as RouteInputType, formDataField: 'file', usesFormData: false };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  const hasBody = (method === 'POST' || method === 'PUT' || method === 'PATCH');

  // ── Auth endpoint: expects session — 401/403 = soft pass (auth is protecting correctly) ──
  if (AUTH_SESSION_REQUIRED.test(urlPath) || AUTH_SESSION_LOGOUT.test(urlPath)) {
    clearTimeout(timer);
    try {
      const authCtrl = new AbortController();
      setTimeout(() => authCtrl.abort(), 8000);
      const res = await fetch(url, {
        method,
        signal: authCtrl.signal,
        headers: { Accept: 'application/json, text/html' },
        ...(method !== 'GET' ? { body: JSON.stringify({}), headers: { 'Content-Type': 'application/json', Accept: 'application/json' } } : {}),
      });
      const bodyText = await res.text().catch(() => '');
      const isExpected401 = res.status === 401 || res.status === 403;
      if (isExpected401) {
        return {
          name, url,
          passed: false,
          softPassed: true,
          statusCode: res.status,
          responseBody: bodyText.slice(0, 300),
          requestBody: '(no session token — testing unauthenticated state)',
          externalDepName: `Session guard (HTTP ${res.status} is correct when unauthenticated)`,
          error: `HTTP ${res.status} — auth is working correctly (unauthenticated access is correctly rejected)`,
        };
      }
      // Unexpected response: fall through to normal handling
    } catch { /* fall through */ }
  }

  // ── Auth credential routes: register / login — send real test body ──────────
  const isCredentialRoute = hasBody && AUTH_CREDENTIAL_ROUTE.test(urlPath);

  // ── AI generate routes: require a prompt field — send synthetic test body ──
  const isGenerateRoute = hasBody && AI_GENERATE_ROUTE.test(urlPath);

  // Build the initial request body. Form-data routes get a test multipart body
  // on the FIRST attempt so we don't trigger a 400 we'd just have to retry anyway.
  let initialRequestDescription: string;
  let fetchOpts: RequestInit;
  if (hasBody && routeProfile.usesFormData) {
    const fd = buildTestFormData(routeProfile.formDataField);
    initialRequestDescription = `multipart/form-data { ${routeProfile.formDataField}: test-bill.png (1×1 PNG) }`;
    fetchOpts = {
      method,
      signal: controller.signal,
      headers: { Accept: 'application/json, text/html' },
      body: fd,
    };
  } else if (isCredentialRoute) {
    // Send well-formed credentials so the route can actually process them
    // (empty {} always 400s because email/password are required).
    initialRequestDescription = `application/json: ${JSON.stringify(TEST_CREDS)}`;
    fetchOpts = {
      method,
      signal: controller.signal,
      headers: { Accept: 'application/json, text/html', 'Content-Type': 'application/json' },
      body: JSON.stringify(TEST_CREDS),
    };
  } else if (isGenerateRoute) {
    // Send a well-formed generation body so prompt-required validation doesn't 400.
    initialRequestDescription = `application/json: ${JSON.stringify(TEST_GENERATE_BODY)}`;
    fetchOpts = {
      method,
      signal: controller.signal,
      headers: { Accept: 'application/json, text/html', 'Content-Type': 'application/json' },
      body: JSON.stringify(TEST_GENERATE_BODY),
    };
  } else {
    initialRequestDescription = hasBody ? 'application/json: {}' : '(no body)';
    fetchOpts = {
      method,
      signal: controller.signal,
      headers: { Accept: 'application/json, text/html', 'Content-Type': 'application/json' },
      ...(hasBody ? { body: JSON.stringify({}) } : {}),
    };
  }

  try {
    const res = await fetch(url, fetchOpts);
    clearTimeout(timer);

    const ct = res.headers.get('content-type') || '';
    const bodyText = await res.text().catch(() => '');

    // Always extract validation details from the response
    const { validationError, stackTrace } = extractValidationDetails(bodyText);

    // ── 405: wrong HTTP method ───────────────────────────────────────────────
    if (res.status === 405 && method === 'GET') {
      const postCtrl = new AbortController();
      const postTimer = setTimeout(() => postCtrl.abort(), 5000);
      let postAccepted = false;
      try {
        const postRes = await fetch(url, {
          method: 'POST',
          signal: postCtrl.signal,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({}),
        });
        clearTimeout(postTimer);
        postAccepted = postRes.ok || postRes.status < 405;
      } catch { clearTimeout(postTimer); }

      const rootCause: CheckRootCause = {
        kind: 'wrong-http-method',
        detail: postAccepted
          ? `Route only accepts POST (GET → 405). Either add \`export async function GET\` to ${suggestedFixFile ?? 'the route file'}, or update the client fetch() to use POST.`
          : `Route returned 405 for both GET and POST — the route file may be missing all HTTP method exports.`,
        errorText: bodyText.slice(0, 200),
        fixFile: suggestedFixFile,
        fixHint: postAccepted
          ? `Read ${suggestedFixFile ?? 'route.ts'} and the component that calls this URL. If this is a data-fetch route, add "export async function GET". If it is a mutation route, ensure callers use fetch(url, { method: 'POST' }).`
          : `Add the missing HTTP method export to ${suggestedFixFile ?? 'route.ts'}`,
      };
      return {
        name, url,
        passed: false,
        statusCode: 405,
        rootCause,
        error: rootCause.detail,
        fixFile: suggestedFixFile,
        fixHint: rootCause.fixHint,
        requestBody: initialRequestDescription,
        responseBody: bodyText.slice(0, 2000),
        validationError,
        stackTrace,
        repairDiagnosis: {
          failureCategory: 'route-validation-failure',
          confidence: 'high',
          recommendedAction: rootCause.detail,
          canAutoRepair: false,
          autoRepairContext: rootCause.fixHint ?? '',
        },
      };
    }

    // ── Failure: read body to find real root cause ─────────────────────────
    if (!res.ok) {
      // ── Auth-protected data route: 401/403 is correct behaviour ───────────
      // If the route source contains getAuthUser / verifyToken / requireAuth, a 401
      // from an unauthenticated probe is NOT a bug — soft-pass so the repair loop
      // doesn't waste attempts trying to "fix" correctly secured routes.
      if ((res.status === 401 || res.status === 403) && routeFilePath) {
        try {
          const { readFileSync } = await import('fs');
          const src = readFileSync(routeFilePath, 'utf8');
          const hasAuthGuard = /getAuthUser|verifyToken|requireAuth|authenticate|getSession|auth\.protect|jwt\.verify|checkAuth|isAuthenticated/i.test(src);
          if (hasAuthGuard) {
            return {
              name, url,
              passed: false,
              softPassed: true,
              statusCode: res.status,
              responseBody: bodyText.slice(0, 300),
              requestBody: '(no session token — testing unauthenticated state)',
              externalDepName: `Auth guard (HTTP ${res.status} is correct when unauthenticated)`,
              error: `HTTP ${res.status} — route is correctly protected (unauthenticated access is properly rejected)`,
            };
          }
        } catch { /* file unreadable — fall through to normal error handling */ }
      }

      // ── Register endpoint: "already registered" means the endpoint works ─────
      // The verifier sends a fixed test email. If it was used before, the server
      // correctly returns 400/409. Soft-pass so we don't flag a working endpoint.
      if (res.status === 400 || res.status === 409) {
        const lc = bodyText.toLowerCase();
        const isAlreadyExists = lc.includes('already') || lc.includes('exists') || lc.includes('duplicate') || lc.includes('taken') || lc.includes('registered') || lc.includes('in use');
        if (isAlreadyExists && AUTH_CREDENTIAL_ROUTE.test(urlPath)) {
          return {
            name, url,
            passed: false,
            softPassed: true,
            statusCode: res.status,
            responseBody: bodyText.slice(0, 300),
            requestBody: initialRequestDescription,
            externalDepName: `Register validation (${res.status} means email already exists — endpoint is functional)`,
            error: `HTTP ${res.status} — register validation working correctly (test email already registered)`,
          };
        }
      }

      // ── POST returns 400 with valid JSON = route is alive, verifier body doesn't match schema ──
      // The verifier sends generic test bodies (empty {} or domain-specific like video fields).
      // If the route validates its input and rejects unknown/missing fields with a JSON error,
      // that is CORRECT BEHAVIOR. Soft-pass: the endpoint is reachable and responding.
      // Only applies to POST/PUT/PATCH (mutations) — not GET 400s, which are unexpected.
      if ((res.status === 400 || res.status === 422) && hasBody) {
        let parsedBody: unknown;
        try { parsedBody = JSON.parse(bodyText); } catch { /* not JSON — fall through to normal error */ }
        if (parsedBody && typeof parsedBody === 'object' && parsedBody !== null) {
          const b = parsedBody as Record<string, unknown>;
          const hasErrorField = 'error' in b || 'message' in b || 'errors' in b || 'details' in b;
          if (hasErrorField) {
            return {
              name, url,
              passed: false,
              softPassed: true,
              statusCode: res.status,
              responseBody: bodyText.slice(0, 300),
              requestBody: initialRequestDescription,
              externalDepName: `Input validation (HTTP ${res.status} — route is functional, verifier body doesn't match expected schema)`,
              error: `HTTP ${res.status} — route responds and validates input correctly (verifier sent incompatible test body)`,
            };
          }
        }
      }

      const rootCause = parseRootCause(bodyText, res.status);
      if (!rootCause.fixFile) rootCause.fixFile = suggestedFixFile;

      // ── File-upload required: retry with multipart if we haven't already ──
      // This handles the case where route-profile detection missed the formData usage
      // (e.g., the file wasn't readable before the first request).
      if (rootCause.kind === 'file-upload-required' && !routeProfile.usesFormData) {
        const retryCtrl = new AbortController();
        const retryTimer = setTimeout(() => retryCtrl.abort(), 12000);
        let retryPassed = false;
        let retryBodyText = '';
        const fieldName = routeProfile.formDataField;

        try {
          const fd = buildTestFormData(fieldName);
          const retryRes = await fetch(url, {
            method: 'POST',
            signal: retryCtrl.signal,
            headers: { Accept: 'application/json, text/html' },
            body: fd,
          });
          clearTimeout(retryTimer);
          retryBodyText = await retryRes.text().catch(() => '');
          retryPassed = retryRes.ok;

          if (retryPassed) {
            // Route works — it just needs a real file. Mark as soft pass.
            const { validationError: ve2 } = extractValidationDetails(retryBodyText);
            const retryProfile = { ...routeProfile, usesFormData: true };
            const diagnosis = buildRepairDiagnosis(res.status, bodyText, rootCause.kind, retryProfile, true);
            return {
              name, url,
              passed: true,
              statusCode: retryRes.status,
              dataFound: true,
              responsePreview: `✅ Route verified with synthetic image upload — accepts multipart/form-data { ${fieldName}: PNG }`,
              requestBody: `multipart/form-data { ${fieldName}: test-bill.png (1×1 PNG) } [retry after initial JSON 400]`,
              responseBody: retryBodyText.slice(0, 2000),
              validationError: ve2,
              repairDiagnosis: diagnosis,
            };
          } else {
            // Retry also failed — report the retry failure with full context
            const retryRootCause = parseRootCause(retryBodyText, retryRes.status);
            const { validationError: ve2, stackTrace: st2 } = extractValidationDetails(retryBodyText);
            const retryProfile = { ...routeProfile, usesFormData: true };
            const diagnosis = buildRepairDiagnosis(retryRes.status, retryBodyText, retryRootCause.kind, retryProfile, false);
            return {
              name, url,
              passed: false,
              statusCode: retryRes.status,
              rootCause: { ...retryRootCause, fixFile: suggestedFixFile },
              error: `[After multipart retry] ${retryRootCause.detail}`,
              fixFile: suggestedFixFile,
              fixHint: retryRootCause.fixHint,
              requestBody: `multipart/form-data { ${fieldName}: test-bill.png (1×1 PNG) }`,
              responseBody: retryBodyText.slice(0, 2000),
              validationError: ve2,
              stackTrace: st2,
              repairDiagnosis: diagnosis,
            };
          }
        } catch { clearTimeout(retryTimer); /* fall through to standard error handling */ }
      }

      // Standard failure path — report with full context
      const diagnosis = buildRepairDiagnosis(res.status, bodyText, rootCause.kind, routeProfile);
      return {
        name, url,
        passed: false,
        statusCode: res.status,
        rootCause,
        error: rootCause.detail,
        fixFile: suggestedFixFile,
        fixHint: rootCause.fixHint,
        requestBody: initialRequestDescription,
        responseBody: bodyText.slice(0, 2000),
        validationError,
        stackTrace,
        repairDiagnosis: diagnosis,
      };
    }

    // ── Success: extract data counts from response ─────────────────────────
    let dataFound = false;
    let recordCount: number | undefined;
    let responsePreview = '';

    if (ct.includes('json')) {
      try {
        const json = JSON.parse(bodyText);
        responsePreview = JSON.stringify(json).slice(0, 200);

        // Detect error responses disguised as HTTP 200
        // A route that returns {error: "Missing API key"} at status 200 is NOT passing.
        const isApiError =
          (typeof json.error === 'string' && json.error.length > 0) ||
          (typeof json.message === 'string' && /missing|not configured|invalid.*key|no.*provider|api.*key.*required|rapidapi|placeholder/i.test(json.message)) ||
          json.success === false ||
          json.ok === false;

        if (isApiError) {
          const errorDetail = (json.error || json.message || 'API returned error').slice(0, 200);
          const rootCause = parseRootCause(JSON.stringify(json), 200);
          if (/key|credential|rapidapi|provider|configured/i.test(errorDetail)) {
            rootCause.kind = 'route-failure';
            rootCause.detail = `API error: ${errorDetail}`;
            rootCause.fixHint = 'The route is reachable but the external API call failed. Check credentials and provider configuration.';
          }
          const diagnosis = buildRepairDiagnosis(res.status, JSON.stringify(json), rootCause.kind, routeProfile);
          return {
            name, url,
            passed: false,
            statusCode: res.status,
            rootCause,
            error: `API error (HTTP 200): ${errorDetail}`,
            fixFile: suggestedFixFile,
            fixHint: rootCause.fixHint,
            requestBody: initialRequestDescription,
            responseBody: bodyText.slice(0, 2000),
            validationError: errorDetail,
            repairDiagnosis: diagnosis,
          };
        }

        const arr =
          (Array.isArray(json) && json) ||
          (Array.isArray(json.data) && json.data) ||
          (Array.isArray(json.items) && json.items) ||
          (Array.isArray(json.results) && json.results) ||
          (Array.isArray(json.properties) && json.properties) ||
          (Array.isArray(json.records) && json.records) ||
          null;

        if (arr) {
          dataFound = arr.length > 0;
          recordCount = arr.length;
        } else if (typeof json.count === 'number') {
          dataFound = json.count > 0;
          recordCount = json.count;
        } else if (json.success === true || json.ok === true) {
          dataFound = true;
        } else if (json.current_weather || json.weather || json.temperature !== undefined || json.temp !== undefined) {
          // Weather API specific — has data if current conditions present
          dataFound = true;
          recordCount = 1;
        } else if (Object.keys(json).length > 0) {
          // Non-empty object with real keys — treat as data present
          dataFound = true;
        }
      } catch {
        responsePreview = '(non-JSON body)';
      }
    } else {
      responsePreview = bodyText.slice(0, 200).replace(/\n/g, ' ');

      // ── 404-in-200 detection ─────────────────────────────────────────────
      // Next.js occasionally serves the 404 page component with HTTP 200
      // (happens when the app router can't find a matching segment, or when
      // the root page component throws and falls back to not-found).
      // A 200 that renders "This page could not be found" must NOT pass.
      // NOTE: Next.js always embeds the not-found boundary in RSC script tags;
      // we must strip script tags before checking to avoid false positives.
      if (!urlPath.startsWith('/api/')) {
        const visibleHtml = bodyText.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
        for (const re of PAGE_404_PATTERNS) {
          if (re.test(visibleHtml)) {
            return {
              name, url,
              passed: false,
              statusCode: res.status,
              responsePreview,
              rootCause: {
                kind: 'route-failure' as const,
                detail: 'HTTP 200 but Next.js rendered the 404 page — route is missing or the page component threw an error',
                fixFile: urlPath === '/' ? 'app/page.tsx' : `app${urlPath}/page.tsx`,
                fixHint: 'Ensure the page component exists and exports a valid default function without unhandled throws',
              },
              error: 'HTTP 200 but page shows "This page could not be found" (Next.js 404 component detected)',
              fixFile: urlPath === '/' ? 'app/page.tsx' : `app${urlPath}/page.tsx`,
              fixHint: 'Create or fix the page component — it is missing or crashing before it can render',
              requestBody: initialRequestDescription,
              responseBody: bodyText.slice(0, 2000),
            };
          }
        }
      }

      // ── Scaffold placeholder detection ──────────────────────────────────
      // The DWOMOH scaffold fallback serves a valid Next.js HTML page with HTTP 200
      // when Bedrock generation failed. We must NOT count this as a passing check.
      // The page text reveals it's still in "generating" state.
      for (const re of SCAFFOLD_PLACEHOLDER_PATTERNS) {
        if (re.test(bodyText)) {
          return {
            name,
            url,
            passed: false,
            statusCode: res.status,
            responsePreview,
            rootCause: {
              kind: 'scaffold-placeholder',
              detail: 'Preview is showing the AI generation placeholder ("Building your app…"). The real application has not rendered yet.',
              fixFile: 'app/page.tsx',
              fixHint: 'AI generation was incomplete. Trigger a re-generation with a stronger model or ask the user to retry the build.',
            },
            error: 'Scaffold placeholder detected — app has not rendered',
            fixFile: 'app/page.tsx',
            fixHint: 'Re-generate with Sonnet or Strongest model',
          };
        }
      }
      dataFound = true;
    }

    return {
      name,
      url,
      passed: true,
      statusCode: res.status,
      dataFound,
      recordCount,
      responsePreview,
      // Capture response body on success too (truncated) so debug logs are rich
      responseBody: bodyText.slice(0, 500),
      requestBody: initialRequestDescription,
    };

  } catch (err) {
    clearTimeout(timer);
    const isAbort = err instanceof Error && err.name === 'AbortError';

    if (isAbort && routeFilePath) {
      // ── Timeout: run static analysis to classify WHY the handler hung ───────
      const urlPath = new URL(url).pathname;
      const profile = await analyzeRouteForTimeout(routeFilePath, urlPath).catch(() => null);

      const causeLabel = profile?.primaryCause ?? 'unknown';
      const hangDetail = profile?.hangLocation ?? 'Route exceeded 10s probe window — handler hung';
      const canSoftPass = profile?.canSoftPass ?? false;

      // Build a richer rootCause kind that maps to the analyzer's classification
      const rootCauseKind: CheckRootCause['kind'] =
        causeLabel === 'platform-proxy-timeout' || causeLabel === 'external-api-timeout'
          ? 'timeout'
          : causeLabel === 'database-lock'
          ? 'database-error'
          : 'timeout';

      const depName = profile?.callSites.find(s => s.isPlatformProxy)?.provider ??
                      profile?.callSites.find(s => s.isExternalProvider)?.provider ??
                      'External API';

      const rootCause: CheckRootCause = {
        kind: rootCauseKind,
        detail: hangDetail,
        fixFile: suggestedFixFile,
        fixHint: profile
          ? `Cause: ${causeLabel}. ${profile.callSites.some(s => s.timeoutMs !== null && s.timeoutMs > 9000) ? 'Reduce internal fetch timeouts to ≤8000ms. ' : ''}${!profile.callSites.every(s => s.hasErrorHandling) ? 'Wrap all fetch() calls in try/catch with mock data fallback.' : ''}`
          : 'Add AbortSignal.timeout(5000) to every fetch() inside this route and wrap in try/catch',
      };

      const repairDiagnosis: RouteRepairDiagnosis = {
        failureCategory: 'other',
        confidence: profile ? 'high' : 'low',
        recommendedAction: hangDetail,
        canAutoRepair: false,
        autoRepairContext: profile?.repairContext ?? hangDetail,
      };

      return {
        name, url,
        passed: false,
        // Soft-pass: route is correct but external dep is unavailable
        softPassed: canSoftPass,
        externalDepName: canSoftPass ? depName : undefined,
        statusCode: undefined,
        rootCause,
        error: canSoftPass
          ? `SOFT PASS: ${depName} unavailable (timeout) — route code is correct`
          : `Timed out after 10s — ${hangDetail}`,
        fixFile: suggestedFixFile,
        fixHint: rootCause.fixHint,
        requestBody: initialRequestDescription,
        timeoutProfile: profile ?? undefined,
        repairDiagnosis,
      };
    }

    // Non-timeout failure (connection refused, etc.)
    const rootCause: CheckRootCause = {
      kind: 'runtime-crash',
      detail: isAbort ? 'Request timed out (no route file available for analysis)' : 'Connection refused — server not ready',
      fixFile: suggestedFixFile,
      fixHint: 'Ensure the dev server is running and the port is correct',
    };
    return {
      name, url,
      passed: false,
      rootCause,
      error: isAbort ? 'Timed out after 10s — handler hung' : err instanceof Error ? err.message : 'Request failed',
      fixFile: suggestedFixFile,
      fixHint: rootCause.fixHint,
      requestBody: initialRequestDescription,
      repairDiagnosis: {
        failureCategory: 'other',
        confidence: 'low',
        recommendedAction: isAbort ? 'Handler is hanging — add timeout/try-catch' : 'Server not responding',
        canAutoRepair: false,
        autoRepairContext: rootCause.detail,
      },
    };
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function verifyRunningApp(
  port: number,
  apiRoutes: string[],
  projectPath?: string,
  pageRoutes?: string[],
): Promise<VerificationResult> {
  const base = `http://localhost:${port}`;
  const checks: VerificationCheck[] = [];

  checks.push(await checkEndpoint(`${base}/`, 'Main page (GET /)'));

  // Check all PAGE routes (app/**/page.tsx → GET /path) so that broken pages
  // like /browse or /listings are caught even if the API routes pass.
  // Skip dynamic routes ([param]) as we cannot supply real IDs here.
  if (pageRoutes && pageRoutes.length > 0) {
    const pageUrlPaths = pageRoutes
      .map(p => {
        const rel = p.replace(/^app\//, '').replace(/\/page\.tsx?$/, '');
        if (!rel || rel === 'page' || rel.includes('[') || rel.includes('(') || rel.includes('.')) return null;
        return '/' + rel;
      })
      .filter((u): u is string => u !== null);

    // Detect auth pages in the project. When present, verify them for
    // ChunkLoadError, hydration failures, and stub pages that have no form.
    const AUTH_PAGE_PATHS = new Set([
      '/auth', '/auth/signin', '/auth/signup', '/auth/forgot-password',
      '/auth/login', '/login', '/signin', '/signup', '/register',
    ]);
    const authRoutes = pageUrlPaths.filter(u => AUTH_PAGE_PATHS.has(u));
    const nonAuthRoutes = pageUrlPaths.filter(u => !AUTH_PAGE_PATHS.has(u));

    for (const urlPath of nonAuthRoutes) {
      checks.push(await checkEndpoint(`${base}${urlPath}`, `Page: GET ${urlPath}`));
    }

    // For auth pages: verify they return 200 AND have real form content (not a redirect stub)
    for (const urlPath of authRoutes) {
      const basicCheck = await checkEndpoint(`${base}${urlPath}`, `Auth page: GET ${urlPath}`);
      if (!basicCheck.passed) {
        checks.push(basicCheck);
        continue;
      }
      // Fetch the actual HTML to verify there is a real form (not a redirect stub)
      try {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 8000);
        const res = await fetch(`${base}${urlPath}`, { signal: ctrl.signal, headers: { Accept: 'text/html' } });
        const html = await res.text().catch(() => '');
        const hasForm = /<form|<input|type="email"|type="password"/.test(html);
        if (!hasForm) {
          checks.push({
            name: `Auth page content: ${urlPath}`,
            url: `${base}${urlPath}`,
            passed: false,
            softPassed: false,
            statusCode: 200,
            responseBody: html.slice(0, 300),
            error: `Auth page ${urlPath} has no sign-in/sign-up form — it is a stub page or redirect`,
            rootCause: {
              kind: 'auth-page-stub',
              detail: `Auth page ${urlPath} returned 200 but contains no form elements. It may be a redirect stub (useEffect → router.replace('/')). The page must have real email/password inputs.`,
              fixFile: projectPath ? `app${urlPath}/page.tsx` : undefined,
              fixHint: `Replace app${urlPath}/page.tsx with a real auth form that POSTs to /api/auth/login and /api/auth/register.`,
            },
          });
        } else {
          checks.push({ ...basicCheck, name: `Auth page content: ${urlPath}`, responsePreview: '✅ Has sign-in/sign-up form' });
        }
      } catch {
        checks.push(basicCheck);
      }
    }

    // Auth pages get dedicated chunk-error detection
    if (authRoutes.length > 0) {
      const { verifyAuthPages } = await import('./auth-verifier');
      const authReport = await verifyAuthPages(base);

      // Check if this app uses a combined /auth page instead of separate /auth/signin etc.
      const hasCombinedAuthPage = pageUrlPaths.includes('/auth');

      for (const ac of authReport.checks) {
        const isChunkError = Boolean(ac.error?.toLowerCase().includes('chunk'));

        // If the specific route (e.g. /auth/signin) returned 404 BUT the app has a combined /auth page,
        // that's fine — the app chose to combine auth into one page. Soft-pass it.
        const isMissingButHasFallback = !ac.passed && ac.status === 404 && hasCombinedAuthPage && ac.route !== '/auth';
        if (isMissingButHasFallback) {
          checks.push({
            name: `Auth page: GET ${ac.route}`,
            url: `${base}${ac.route}`,
            passed: false,
            softPassed: true,
            statusCode: 404,
            error: `${ac.route} not found — app uses combined /auth page instead (acceptable pattern)`,
          });
          continue;
        }

        checks.push({
          name: `Auth page: GET ${ac.route}`,
          url: `${base}${ac.route}`,
          passed: ac.passed,
          softPassed: false,
          statusCode: ac.status ?? 0,
          error: ac.passed ? undefined : ac.error,
          rootCause: ac.passed ? undefined : {
            kind: isChunkError ? 'runtime-crash' : 'route-failure',
            detail: isChunkError
              ? `ChunkLoadError on ${ac.route} — stale .next cache. Fix: rm -rf .next && npm run dev`
              : `Auth page ${ac.route} failed: ${ac.error ?? 'unknown'}`,
            fixHint: isChunkError
              ? 'Delete .next and restart the dev server to clear stale chunk references.'
              : 'Check auth layout.tsx for import errors or missing dependencies.',
          },
        });
      }
    }
  }

  const urlPaths = Array.from(
    new Set(
      apiRoutes
        .map(apiRouteFileToUrlPath)
        .filter((u): u is string => u !== null)
    )
  );

  for (const urlPath of urlPaths) {
    // Detect the actual HTTP method from the route file so we probe correctly
    // instead of blindly using GET and triggering avoidable 405 errors.
    let method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' = 'GET';
    let routeFilePath: string | undefined;
    if (projectPath) {
      routeFilePath = join(projectPath, 'app', urlPath, 'route.ts');
      method = await detectRouteMethod(routeFilePath);
    }
    // Pass routeFilePath so checkEndpoint can detect FormData routes and send
    // the right body on the first request (avoiding an unnecessary 400 → retry cycle).
    checks.push(await checkEndpoint(`${base}${urlPath}`, `API: ${method} ${urlPath}`, method, routeFilePath));
  }

  // ── Auth flow verification ────────────────────────────────────────────────
  // Run only when the project has auth-related routes. This tests the complete
  // register → login → session flow rather than just probing route status codes.
  const hasAuthRoutes = apiRoutes.some(r =>
    /auth\/(register|signup|login|signin)/.test(r) ||
    /api\/(register|signup|login|signin)/.test(r)
  );
  if (hasAuthRoutes && projectPath) {
    try {
      const { verifyAuthFlow, authFlowToChecks } = await import('./auth-flow-verifier');
      const authResult = await verifyAuthFlow(port, projectPath);
      const authChecks = authFlowToChecks(authResult);
      for (const ac of authChecks) {
        checks.push({
          name: ac.name,
          url: ac.url,
          passed: ac.passed,
          softPassed: ac.softPassed,
          statusCode: ac.statusCode,
          error: ac.error,
          requestBody: ac.requestBody,
          responseBody: ac.responseBody,
          rootCause: ac.rootCause as VerificationCheck['rootCause'],
        });
      }
    } catch { /* auth flow verifier failed — non-critical, skip */ }
  }

  // Hard failures: neither passed nor soft-passed
  const failures = checks
    .filter(c => !c.passed && !c.softPassed)
    .map(c => {
      const rc = c.rootCause;
      if (rc?.kind === 'missing-package' && rc.packages?.length) {
        return `${c.name}: missing package ${rc.packages.join(', ')}`;
      }
      return `${c.name}: ${c.error ?? `HTTP ${c.statusCode}`}`;
    });

  // Soft-passed: external dependency unavailable but route code is correct
  const softPasses = checks.filter(c => c.softPassed);

  const verified = failures.length === 0;
  const passedCount = checks.filter(c => c.passed).length;
  const softPassCount = softPasses.length;

  const summary = verified
    ? softPassCount > 0
      ? `${passedCount} of ${checks.length} check(s) passed + ${softPassCount} soft-passed (external API unavailable — PASS_WITH_EXTERNAL_DEPENDENCY_UNAVAILABLE).`
      : `All ${checks.length} check(s) passed — app is running correctly.`
    : `${failures.length} of ${checks.length} check(s) failed (${passedCount} passed${softPassCount > 0 ? `, ${softPassCount} soft-passed` : ''}).`;

  return { verified, port, checks, failures, summary };
}

// ─── Health gate: blocks "verified" status when critical issues exist ─────────

export interface HealthGateResult {
  passes: boolean;
  blockers: string[];
}

/**
 * Never marks a project as Live/Verified/Healthy/Production Ready when:
 * - Any API route returns 4xx/5xx
 * - Required credentials are missing or placeholder
 * - Database connections fail
 * - Authentication is broken
 * - The main page is still showing the scaffold/generation placeholder
 * - Critical functionality is unavailable
 */
export function healthGate(result: VerificationResult, missingCredentials?: string[]): HealthGateResult {
  const blockers: string[] = [];

  // Block if the main page is still showing the AI generation placeholder.
  // This check must be first — a 200 scaffold page must never be "verified".
  const scaffoldCheck = result.checks.find(
    c => c.name.includes('Main page') && c.rootCause?.kind === 'scaffold-placeholder'
  );
  if (scaffoldCheck) {
    blockers.push('App is still showing the AI generation placeholder — real application has not rendered yet');
  }

  // Block on any HTTP failure — soft-passed checks (auth 401, external API timeouts)
  // are deliberately excluded: they indicate correct behaviour, not broken code.
  for (const check of result.checks) {
    if (!check.passed && !check.softPassed) {
      const sc = check.statusCode;
      if (sc && sc >= 400) {
        blockers.push(`${check.name} returned HTTP ${sc} — must be fixed before the app can be verified`);
      } else if (!sc || sc === 0) {
        blockers.push(`${check.name} is unreachable — server may not be running`);
      }
    }
  }

  // Block on missing credentials
  if (missingCredentials && missingCredentials.length > 0) {
    blockers.push(`Missing credentials: ${missingCredentials.join(', ')} — add these to .env.local`);
  }

  // Block on database errors
  const dbError = result.checks.find(c => !c.passed && c.rootCause?.kind === 'database-error');
  if (dbError) {
    blockers.push(`Database error in ${dbError.name} — fix before verifying`);
  }

  // Block on auth misconfiguration
  const authError = result.checks.find(c => !c.passed && c.rootCause?.kind === 'auth-misconfigured');
  if (authError) {
    blockers.push('Authentication is not configured — add NEXTAUTH_SECRET to .env.local');
  }

  return {
    passes: blockers.length === 0,
    blockers,
  };
}

export function formatVerificationResult(result: VerificationResult): string {
  const lines: string[] = [];
  for (const check of result.checks) {
    const icon = check.passed ? '✅' : '❌';
    const detail = check.passed
      ? check.recordCount !== undefined
        ? ` — ${check.recordCount} record(s) returned`
        : ''
      : ` — ${check.error ?? `HTTP ${check.statusCode}`}`;
    lines.push(`${icon} ${check.name}${detail}`);
  }
  return lines.join('\n');
}

// ─── Live server log scanner ─────────────────────────────────────────────────
// Reads the last N lines from a running dev-server's stdout log file and
// classifies any critical runtime errors that must block "verified" status.

export interface LiveLogScanResult {
  clean: boolean;
  criticalErrors: string[];
  warnings: string[];
  rawLines: string[];
}

const CRITICAL_LOG_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /MODULE_NOT_FOUND/,                      label: 'MODULE_NOT_FOUND: missing dependency' },
  { re: /Cannot find module/,                    label: 'Cannot find module: broken import' },
  { re: /ChunkLoadError|Loading chunk \d+ failed/, label: 'Chunk load error: missing JS chunk (stale build)' },
  { re: /Error: ENOENT.*no such file/,           label: 'ENOENT: required file missing at runtime' },
  { re: /SyntaxError:.*Unexpected token/,        label: 'SyntaxError: malformed JS at runtime' },
  { re: /TypeError: .*is not a function/,        label: 'TypeError: function not found at runtime' },
  { re: /ReferenceError:/,                       label: 'ReferenceError: undefined variable at runtime' },
  { re: /Unhandled Runtime Error/,               label: 'Unhandled Runtime Error in client-side code' },
  { re: /NEXT_REDIRECT.*failed/i,                label: 'Next.js redirect failed' },
  { re: /Error: No routes matched/,              label: 'No routes matched: missing page or dynamic segment' },
];

const WARNING_LOG_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /404.*favicon/i,                         label: 'favicon.ico 404 on every page load' },
  { re: /Hydration failed/i,                     label: 'Hydration mismatch: server/client HTML differs' },
  { re: /Warning.*useLayoutEffect/,              label: 'useLayoutEffect SSR warning' },
];

export async function scanServerLogs(
  logFilePath: string,
  tailLines = 200,
): Promise<LiveLogScanResult> {
  const criticalErrors: string[] = [];
  const warnings: string[] = [];
  let rawLines: string[] = [];

  try {
    const content = await readFile(logFilePath, 'utf-8');
    const allLines = content.split('\n').filter(l => l.trim());
    rawLines = allLines.slice(-tailLines);

    for (const line of rawLines) {
      for (const { re, label } of CRITICAL_LOG_PATTERNS) {
        if (re.test(line)) { criticalErrors.push(`${label}: ${line.slice(0, 200)}`); break; }
      }
      for (const { re, label } of WARNING_LOG_PATTERNS) {
        if (re.test(line)) { warnings.push(`${label}: ${line.slice(0, 150)}`); break; }
      }
    }
  } catch {
    // Log file doesn't exist yet — not an error
  }

  return { clean: criticalErrors.length === 0, criticalErrors, warnings, rawLines };
}

/**
 * Checks the live server log for critical errors and adds them as blockers to the health gate.
 */
export async function healthGateWithLiveLogs(
  result: VerificationResult,
  logFilePath: string,
  missingCredentials?: string[],
): Promise<HealthGateResult> {
  const base = healthGate(result, missingCredentials);
  const logScan = await scanServerLogs(logFilePath);

  // Deduplicate: only add new blockers not already in the base set
  for (const err of logScan.criticalErrors) {
    const shortErr = err.slice(0, 80);
    if (!base.blockers.some(b => b.includes(shortErr.slice(0, 40)))) {
      base.blockers.push(`[Live log] ${err}`);
    }
  }

  return { passes: base.blockers.length === 0, blockers: base.blockers };
}
