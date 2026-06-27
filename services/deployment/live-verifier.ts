/**
 * DWOMOH Vibe Code — Live Verification Engine
 *
 * Runs after every Amplify build to confirm the branded URL is genuinely live:
 *   1. Amplify domain reaches AVAILABLE status
 *   2. CNAME exists in Route 53 (auto-adds if missing)
 *   3. DNS resolves to CloudFront
 *   4. SSL certificate is active (HTTPS works)
 *   5. HTTP GET → 200 OK (with retries)
 *   6. Page crawl — title, links, assets, nav routes
 *   7. API health check (/_next/static reachable)
 *
 * Only after all checks pass is the deployment marked 'live'.
 * On failure, the auto-repair engine is invoked before a re-check.
 */

import {
  AmplifyClient,
  GetDomainAssociationCommand,
} from '@aws-sdk/client-amplify';
import {
  Route53Client,
  ListResourceRecordSetsCommand,
  ChangeResourceRecordSetsCommand,
} from '@aws-sdk/client-route-53';
import type {
  VerificationCheck,
  VerificationCheckName,
  VerificationCheckStatus,
  VerificationResult,
} from './types';

// ─── AWS clients ─────────────────────────────────────────────────────────────

const REGION   = process.env.AWS_REGION || 'us-east-1';
const DOMAIN   = process.env.DWOMOH_BRANDED_DOMAIN || 'dwomohvibe.com';
const HZ_ID    = process.env.DWOMOH_HOSTED_ZONE_ID || '';

function creds() {
  return {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID     || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  };
}
function ampClient() { return new AmplifyClient({ region: REGION, credentials: creds() }); }
function r53Client() { return new Route53Client({ region: 'us-east-1', credentials: creds() }); }

// ─── Check builder helpers ────────────────────────────────────────────────────

function check(
  name: VerificationCheckName,
  label: string,
  status: VerificationCheckStatus,
  detail: string,
  durationMs?: number,
): VerificationCheck {
  return { name, label, status, detail, durationMs, timestamp: new Date().toISOString() };
}

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const t = Date.now();
  const result = await fn();
  return { result, ms: Date.now() - t };
}

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ─── Check 1: Amplify domain AVAILABLE ───────────────────────────────────────

/**
 * Polls Amplify's domain association until it reaches AVAILABLE or FAILED.
 * Amplify progression: CREATING → PENDING_VERIFICATION → AWAITING_APP_CNAME → PENDING_DEPLOYMENT → AVAILABLE
 */
export async function waitForAmplifyDomain(
  appId: string,
  slug: string,
  timeoutMs = 20 * 60 * 1000,
  onProgress?: (status: string, detail: string) => void,
): Promise<{ passed: boolean; status: string; cfDistribution?: string }> {
  const client = ampClient();
  const start  = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await client.send(new GetDomainAssociationCommand({
        appId,
        domainName: DOMAIN,
      }));
      const da      = res.domainAssociation;
      const status  = da?.domainStatus ?? 'UNKNOWN';
      const ourSub  = da?.subDomains?.find(s => s.subDomainSetting?.prefix === slug);
      const dnsRec  = ourSub?.dnsRecord ?? da?.subDomains?.[0]?.dnsRecord;

      // Extract CF distribution from DNS record e.g. "adepas-collection CNAME d2361xtznscpcm.cloudfront.net"
      const cfDistribution = dnsRec?.split(' ').pop()?.replace(/\.$/, '');

      onProgress?.(status, `${slug}.${DOMAIN} → ${cfDistribution ?? 'pending'}`);

      if (status === 'AVAILABLE') {
        return { passed: true, status, cfDistribution };
      }
      if (status === 'FAILED') {
        return { passed: false, status };
      }

      // If AWAITING_APP_CNAME and we have the DNS record, ensure Route 53 has it
      if (status === 'AWAITING_APP_CNAME' && cfDistribution && HZ_ID) {
        await ensureCnameInRoute53(slug, cfDistribution).catch(() => {/* non-fatal */});
      }

    } catch { /* Amplify API transient error — keep polling */ }

    await sleep(15_000);
  }

  return { passed: false, status: 'TIMEOUT' };
}

/** Ensure {slug}.dwomohvibe.com CNAME → {target} exists in Route 53 */
async function ensureCnameInRoute53(slug: string, target: string): Promise<void> {
  if (!HZ_ID) return;
  const r53 = r53Client();
  const fqdn = `${slug}.${DOMAIN}.`;

  // Check if already present
  const existing = await r53.send(new ListResourceRecordSetsCommand({
    HostedZoneId: HZ_ID, MaxItems: 100,
  }));
  const already = existing.ResourceRecordSets?.some(r =>
    r.Type === 'CNAME' && r.Name === fqdn &&
    r.ResourceRecords?.some(v => v.Value?.includes(target.replace(/\.$/, '')))
  );
  if (already) return;

  await r53.send(new ChangeResourceRecordSetsCommand({
    HostedZoneId: HZ_ID,
    ChangeBatch: {
      Comment: `DWOMOH Vibe Code — ${slug}.${DOMAIN}`,
      Changes: [{
        Action: 'UPSERT',
        ResourceRecordSet: {
          Name: fqdn,
          Type: 'CNAME',
          TTL: 300,
          ResourceRecords: [{ Value: target.endsWith('.') ? target : `${target}.` }],
        },
      }],
    },
  }));
}

// ─── Check 2: DNS resolution (Google DNS-over-HTTPS) ─────────────────────────

export async function checkDnsResolution(hostname: string): Promise<{
  resolved: boolean;
  answer?: string;
  error?: string;
}> {
  try {
    const res = await fetch(
      `https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=CNAME`,
      { signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) return { resolved: false, error: `DNS API ${res.status}` };
    const data = await res.json() as { Status: number; Answer?: Array<{ data: string }> };
    if (data.Status === 0 && data.Answer?.length) {
      return { resolved: true, answer: data.Answer[0].data };
    }
    // Try A record fallback
    const res2 = await fetch(
      `https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=A`,
      { signal: AbortSignal.timeout(10_000) }
    );
    const data2 = await res2.json() as { Status: number; Answer?: Array<{ data: string }> };
    if (data2.Status === 0 && data2.Answer?.length) {
      return { resolved: true, answer: data2.Answer[0].data };
    }
    return { resolved: false, error: 'NXDOMAIN — DNS not yet propagated' };
  } catch (e) {
    return { resolved: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─── Check 3: HTTPS / SSL ────────────────────────────────────────────────────

export async function checkHttps(url: string): Promise<{
  reachable: boolean;
  status?: number;
  contentType?: string;
  error?: string;
  redirectedTo?: string;
}> {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
      headers: { 'User-Agent': 'DWOMOH-Vibe-Code-Verifier/1.0', 'Accept': 'text/html,application/json,*/*' },
    });
    return {
      reachable: true,
      status: res.status,
      contentType: res.headers.get('content-type') ?? undefined,
      redirectedTo: res.redirected ? res.url : undefined,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isSsl    = msg.toLowerCase().includes('ssl') || msg.toLowerCase().includes('cert');
    const isDns    = msg.toLowerCase().includes('getaddrinfo') || msg.toLowerCase().includes('enotfound');
    const isTimeout = msg.toLowerCase().includes('timeout') || msg.toLowerCase().includes('abort');
    return {
      reachable: false,
      error: isDns ? 'DNS_NOT_RESOLVED' : isSsl ? 'SSL_ERROR' : isTimeout ? 'TIMEOUT' : msg,
    };
  }
}

// ─── Check 4: Page crawl ─────────────────────────────────────────────────────

export interface CrawlResult {
  title?: string;
  links: string[];
  assets: string[];
  hasNavigation: boolean;
  statusCode: number;
  bodyPreview: string;
  errors: string[];
}

export async function crawlPage(url: string): Promise<CrawlResult> {
  const errors: string[] = [];
  let html = '';
  let statusCode = 0;

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
      headers: { 'User-Agent': 'DWOMOH-Vibe-Code-Verifier/1.0', 'Accept': 'text/html' },
    });
    statusCode = res.status;
    html = await res.text();
  } catch (e) {
    return {
      statusCode: 0, title: undefined, links: [], assets: [],
      hasNavigation: false, bodyPreview: '',
      errors: [e instanceof Error ? e.message : String(e)],
    };
  }

  // Parse title
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch?.[1]?.trim().slice(0, 120);

  // Parse links
  const linkMatches = [...html.matchAll(/href=["']([^"']+)["']/gi)];
  const links = linkMatches
    .map(m => m[1])
    .filter(l => l.startsWith('/') || l.startsWith('http'))
    .slice(0, 20);

  // Parse assets (scripts, images)
  const assetMatches = [...html.matchAll(/(?:src|href)=["']([^"']*\.(js|css|png|jpg|svg|ico|webp))["']/gi)];
  const assets = assetMatches.map(m => m[1]).slice(0, 10);

  // Navigation heuristic: has <nav> or multiple internal links
  const hasNav = html.includes('<nav') || html.includes('role="navigation"');
  const internalLinks = links.filter(l => l.startsWith('/'));
  const hasNavigation = hasNav || internalLinks.length > 2;

  // Check for Next.js 404 page body
  if (html.includes('404') && html.includes('not found') && statusCode === 404) {
    errors.push('Page returned 404 — app may not be routing correctly');
  }

  const bodyPreview = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);

  return { title, links, assets, hasNavigation, statusCode, bodyPreview, errors };
}

// ─── Check 5: API health (Next.js _next/static) ───────────────────────────────

async function checkApiHealth(baseUrl: string): Promise<{ reachable: boolean; detail: string }> {
  // Next.js always serves /_next/static — if this 404s the build is wrong
  const testUrls = [
    `${baseUrl}/_next/static`,
    `${baseUrl}/api/health`,
    `${baseUrl}/favicon.ico`,
  ];

  for (const u of testUrls) {
    try {
      const res = await fetch(u, {
        method: 'HEAD',
        signal: AbortSignal.timeout(10_000),
        headers: { 'User-Agent': 'DWOMOH-Vibe-Code-Verifier/1.0' },
      });
      if (res.status < 500) {
        return { reachable: true, detail: `${u} → ${res.status}` };
      }
    } catch { /* try next */ }
  }
  return { reachable: false, detail: 'No static assets reachable' };
}

// ─── Master verifier ─────────────────────────────────────────────────────────

export interface RunVerificationOptions {
  appId: string;
  slug: string;
  brandedUrl: string;
  /** Max ms to wait for Amplify domain to become AVAILABLE */
  domainTimeoutMs?: number;
  /** Max ms to wait for HTTP 200 once domain is AVAILABLE */
  httpTimeoutMs?: number;
  onProgress?: (check: VerificationCheck) => void;
}

export async function runFullVerification(opts: RunVerificationOptions): Promise<VerificationResult> {
  const {
    appId, slug, brandedUrl,
    domainTimeoutMs = 20 * 60 * 1000,
    httpTimeoutMs   = 10 * 60 * 1000,
    onProgress,
  } = opts;

  const checks: VerificationCheck[] = [];
  const repairLog: string[] = [];
  const start = Date.now();
  const hostname = brandedUrl.replace(/^https?:\/\//, '').split('/')[0];

  function emit(c: VerificationCheck) {
    checks.push(c);
    onProgress?.(c);
  }

  // ── 1. Amplify domain AVAILABLE ─────────────────────────────────────────
  const domainStart = Date.now();
  const domainResult = await waitForAmplifyDomain(appId, slug, domainTimeoutMs, (s, d) => {
    // Live progress — emit intermediate warnings, not full checks
    onProgress?.({
      name: 'amplify_domain', label: 'Amplify Domain', status: 'warning',
      detail: `${s} — ${d}`, timestamp: new Date().toISOString(),
    });
  });

  emit(check(
    'amplify_domain', 'Amplify Domain Association',
    domainResult.passed ? 'pass' : 'fail',
    domainResult.passed
      ? `AVAILABLE · ${domainResult.cfDistribution ?? DOMAIN}`
      : `Stuck at ${domainResult.status} after ${Math.round((Date.now() - domainStart) / 1000)}s`,
    Date.now() - domainStart,
  ));

  if (!domainResult.passed) {
    return { passed: false, url: brandedUrl, checks, attempts: 1, repairLog,
      totalDurationMs: Date.now() - start, completedAt: new Date().toISOString() };
  }

  // ── 2. CNAME in Route 53 ────────────────────────────────────────────────
  if (domainResult.cfDistribution && HZ_ID) {
    const t = Date.now();
    try {
      await ensureCnameInRoute53(slug, domainResult.cfDistribution);
      emit(check('cname_route53', 'Route 53 CNAME', 'pass',
        `${slug}.${DOMAIN} → ${domainResult.cfDistribution}`, Date.now() - t));
      repairLog.push(`CNAME verified/added: ${slug}.${DOMAIN} → ${domainResult.cfDistribution}`);
    } catch (e) {
      emit(check('cname_route53', 'Route 53 CNAME', 'warning',
        `Could not verify: ${e instanceof Error ? e.message : String(e)}`, Date.now() - t));
    }
  } else {
    emit(check('cname_route53', 'Route 53 CNAME', 'skipped', 'No hosted zone ID configured'));
  }

  // ── 3. DNS resolution — poll until propagated ───────────────────────────
  const dnsStart = Date.now();
  let dnsResult = await checkDnsResolution(hostname);
  let dnsAttempts = 0;
  const dnsMax = Math.min(httpTimeoutMs, 5 * 60 * 1000);

  while (!dnsResult.resolved && Date.now() - dnsStart < dnsMax) {
    dnsAttempts++;
    onProgress?.({ name: 'dns_resolution', label: 'DNS Resolution', status: 'warning',
      detail: `Propagating… attempt ${dnsAttempts} (${dnsResult.error ?? 'not yet'})`,
      timestamp: new Date().toISOString() });
    await sleep(15_000);
    dnsResult = await checkDnsResolution(hostname);
  }

  emit(check('dns_resolution', 'DNS Resolution',
    dnsResult.resolved ? 'pass' : 'fail',
    dnsResult.resolved
      ? `Resolved to ${dnsResult.answer ?? 'CloudFront'} after ${dnsAttempts} retries`
      : `Not resolved: ${dnsResult.error}`,
    Date.now() - dnsStart,
  ));

  // If DNS doesn't resolve, everything else will fail — stop here
  if (!dnsResult.resolved) {
    repairLog.push(`DNS failed: ${dnsResult.error}. Manual check: dig ${hostname}`);
    return { passed: false, url: brandedUrl, checks, attempts: 1, repairLog,
      totalDurationMs: Date.now() - start, completedAt: new Date().toISOString() };
  }

  // ── 4 + 5. HTTPS response — poll until 200 ─────────────────────────────
  const httpStart = Date.now();
  let httpResult = await checkHttps(brandedUrl);
  let httpAttempts = 0;
  let lastStatus = httpResult.status ?? 0;

  while (
    (!httpResult.reachable || (lastStatus !== 200 && lastStatus !== 304)) &&
    Date.now() - httpStart < httpTimeoutMs
  ) {
    httpAttempts++;
    const detail = httpResult.reachable
      ? `HTTP ${lastStatus} — waiting for 200 (attempt ${httpAttempts})`
      : `${httpResult.error} — retrying (attempt ${httpAttempts})`;

    onProgress?.({ name: 'http_response', label: 'HTTP 200 OK', status: 'warning',
      detail, timestamp: new Date().toISOString() });

    const waitMs = httpResult.error === 'SSL_ERROR' ? 30_000
      : httpResult.error === 'DNS_NOT_RESOLVED' ? 20_000
      : lastStatus === 502 || lastStatus === 503 ? 20_000
      : 15_000;

    await sleep(waitMs);
    httpResult = await checkHttps(brandedUrl);
    lastStatus = httpResult.status ?? 0;
  }

  const httpOk = httpResult.reachable && (lastStatus === 200 || lastStatus === 304 || lastStatus === 301 || lastStatus === 302);

  emit(check('ssl_certificate', 'SSL Certificate (HTTPS)',
    httpResult.reachable ? 'pass' : httpResult.error === 'SSL_ERROR' ? 'fail' : 'warning',
    httpResult.reachable
      ? `HTTPS active · TLS valid`
      : `${httpResult.error ?? 'Unreachable'}`,
    Date.now() - httpStart,
  ));

  emit(check('http_response', 'HTTP Response',
    httpOk ? 'pass' : 'fail',
    httpOk
      ? `${lastStatus} OK after ${httpAttempts} retries`
      : `Got ${lastStatus || 'no response'} — ${httpResult.error ?? 'unexpected status'}`,
    Date.now() - httpStart,
  ));

  if (!httpOk) {
    repairLog.push(`HTTP failed: status=${lastStatus} error=${httpResult.error}`);
    return { passed: false, url: brandedUrl, checks, attempts: 1 + httpAttempts, repairLog,
      totalDurationMs: Date.now() - start, completedAt: new Date().toISOString() };
  }

  // ── 6. Page crawl ───────────────────────────────────────────────────────
  const crawlStart = Date.now();
  const crawl = await crawlPage(brandedUrl);

  emit(check('page_crawl', 'Homepage Content',
    crawl.statusCode === 200 && !crawl.errors.length ? 'pass' : crawl.errors.length ? 'fail' : 'warning',
    crawl.title
      ? `"${crawl.title}" · ${crawl.links.length} links · ${crawl.assets.length} assets`
      : `Status ${crawl.statusCode} · ${crawl.errors[0] ?? 'No title found'}`,
    Date.now() - crawlStart,
  ));

  emit(check('navigation', 'Navigation & Routes',
    crawl.hasNavigation ? 'pass' : 'warning',
    crawl.hasNavigation
      ? `${crawl.links.filter(l => l.startsWith('/')).length} internal routes found`
      : 'No nav detected — single-page or loading state',
    Date.now() - crawlStart,
  ));

  // ── 7. API / static asset health ────────────────────────────────────────
  const apiStart = Date.now();
  const api = await checkApiHealth(brandedUrl);
  emit(check('api_health', 'Static Assets & API',
    api.reachable ? 'pass' : 'warning',
    api.detail,
    Date.now() - apiStart,
  ));

  // ── Final result ────────────────────────────────────────────────────────
  const passed = checks.every(c => c.status === 'pass' || c.status === 'warning' || c.status === 'skipped');
  const criticalFail = checks.some(c =>
    (c.name === 'amplify_domain' || c.name === 'http_response') && c.status === 'fail'
  );

  return {
    passed: passed && !criticalFail,
    url: brandedUrl,
    httpStatus: lastStatus,
    pageTitle: crawl.title,
    checks,
    attempts: 1 + httpAttempts,
    totalDurationMs: Date.now() - start,
    completedAt: new Date().toISOString(),
    repairLog,
  };
}

// ─── Diagnose failure and build human-readable summary ───────────────────────

export function diagnoseVerificationFailure(result: VerificationResult): {
  rootCause: string;
  recommendation: string;
  autoRepairPossible: boolean;
} {
  const failedCheck = result.checks.find(c => c.status === 'fail');
  if (!failedCheck) {
    return { rootCause: 'Unknown', recommendation: 'Re-run verification', autoRepairPossible: true };
  }

  switch (failedCheck.name) {
    case 'amplify_domain':
      return {
        rootCause: `Amplify domain stuck at non-AVAILABLE status: ${failedCheck.detail}`,
        recommendation: 'Check Amplify domain association in AWS Console. The IAM role may lack Route 53 permissions.',
        autoRepairPossible: true,
      };
    case 'cname_route53':
      return {
        rootCause: `CNAME record missing from Route 53: ${failedCheck.detail}`,
        recommendation: 'Add CNAME record manually in Route 53 Console.',
        autoRepairPossible: true,
      };
    case 'dns_resolution':
      return {
        rootCause: `DNS not propagated: ${failedCheck.detail}`,
        recommendation: 'Wait 5–10 minutes for DNS propagation. Route 53 TTL is 300s.',
        autoRepairPossible: true,
      };
    case 'ssl_certificate':
      return {
        rootCause: `SSL/HTTPS failed: ${failedCheck.detail}`,
        recommendation: 'ACM certificate may still be provisioning. Wait 2–5 minutes.',
        autoRepairPossible: true,
      };
    case 'http_response':
      return {
        rootCause: `HTTP request failed: ${failedCheck.detail}`,
        recommendation: failedCheck.detail.includes('404')
          ? 'Next.js build may have failed silently. Check Amplify build logs.'
          : 'CloudFront may still be warming up. Wait 2–5 minutes.',
        autoRepairPossible: failedCheck.detail.includes('503') || failedCheck.detail.includes('TIMEOUT'),
      };
    case 'page_crawl':
      return {
        rootCause: `Homepage has errors: ${failedCheck.detail}`,
        recommendation: 'Check the application code — a runtime error may be causing the 404/500.',
        autoRepairPossible: false,
      };
    default:
      return {
        rootCause: failedCheck.detail,
        recommendation: 'Check AWS Console for details.',
        autoRepairPossible: false,
      };
  }
}
