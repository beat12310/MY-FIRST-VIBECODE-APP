import { NextRequest, NextResponse } from 'next/server';
import {
  checkDomainAvailability,
  searchDomains,
  suggestDomains,
  purchaseDomain,
  getOperationStatus,
  listRegisteredDomains,
  getDomainDetail,
  checkTransferability,
  getTldPrice,
} from '@/services/deployment/domain-registrar';
import { DeploymentManager } from '@/services/deployment';
import { checkAwsSetupStatus } from '@/services/deployment/aws-setup';
import {
  Route53Client,
  ListHostedZonesByNameCommand,
  ChangeResourceRecordSetsCommand,
} from '@aws-sdk/client-route-53';

const AWS_KEY    = process.env.AWS_ACCESS_KEY_ID    || '';
const AWS_SECRET = process.env.AWS_SECRET_ACCESS_KEY || '';
const PLATFORM_DOMAIN = process.env.DWOMOH_BRANDED_DOMAIN || 'dwomohvibe.com';

function r53() {
  return new Route53Client({
    region: 'us-east-1',
    credentials: { accessKeyId: AWS_KEY, secretAccessKey: AWS_SECRET },
  });
}

export async function GET(req: NextRequest) {
  const action = req.nextUrl.searchParams.get('action');

  if (action === 'list-registered') {
    const domains = await listRegisteredDomains();
    return NextResponse.json({ ok: true, domains });
  }

  if (action === 'setup-status') {
    const status = await checkAwsSetupStatus();
    return NextResponse.json({ ok: true, status });
  }

  if (action === 'platform-domain') {
    // Return the platform domain and its current DNS/SSL status
    const registered = await listRegisteredDomains();
    const platformDomain = registered.find(d => d.domain === PLATFORM_DOMAIN);
    const setupStatus = await checkAwsSetupStatus();
    return NextResponse.json({
      ok: true,
      domain: PLATFORM_DOMAIN,
      registered: !!platformDomain,
      detail: platformDomain,
      sslActive: setupStatus.certificate?.status === 'ISSUED',
      hostedZoneId: setupStatus.hostedZone?.id ?? null,
      ready: setupStatus.ready,
    });
  }

  if (action === 'deployments') {
    const mgr = DeploymentManager.getInstance();
    const all = await mgr.listAll();
    return NextResponse.json({ ok: true, deployments: all });
  }

  return NextResponse.json({ ok: true, platformDomain: PLATFORM_DOMAIN });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { action } = body as { action: string };

  // ── Domain Search ──────────────────────────────────────────────────────────
  if (action === 'search') {
    const { query } = body as { query: string };
    if (!query?.trim()) return NextResponse.json({ error: 'query required' }, { status: 400 });

    const baseName = query.trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    const [searchResults, suggestions] = await Promise.allSettled([
      searchDomains(baseName),
      suggestDomains(baseName),
    ]);

    return NextResponse.json({
      ok: true,
      query: baseName,
      results: searchResults.status === 'fulfilled' ? searchResults.value : [],
      suggestions: suggestions.status === 'fulfilled' ? suggestions.value.slice(0, 10) : [],
    });
  }

  // ── Single Domain Availability ─────────────────────────────────────────────
  if (action === 'check') {
    const { domain } = body as { domain: string };
    if (!domain) return NextResponse.json({ error: 'domain required' }, { status: 400 });
    const result = await checkDomainAvailability(domain.toLowerCase().trim());
    return NextResponse.json({ ok: true, result });
  }

  // ── Purchase Domain ────────────────────────────────────────────────────────
  if (action === 'purchase') {
    const { domain, autoRenew } = body as { domain: string; autoRenew?: boolean };
    if (!domain) return NextResponse.json({ error: 'domain required' }, { status: 400 });

    try {
      const result = await purchaseDomain(domain.toLowerCase().trim(), autoRenew ?? true);
      return NextResponse.json({
        ok: true,
        purchase: result,
        message: `Registration started for ${domain}. Usually completes in 5–15 minutes.`,
      });
    } catch (err) {
      return NextResponse.json({
        ok: false,
        error: err instanceof Error ? err.message : 'Purchase failed',
      }, { status: 500 });
    }
  }

  // ── Check Operation Status ─────────────────────────────────────────────────
  if (action === 'operation-status') {
    const { operationId } = body as { operationId: string };
    if (!operationId) return NextResponse.json({ error: 'operationId required' }, { status: 400 });
    const status = await getOperationStatus(operationId);
    return NextResponse.json({ ok: true, status });
  }

  // ── Connect External Domain ────────────────────────────────────────────────
  if (action === 'connect-external') {
    const { domain, projectId } = body as { domain: string; projectId?: string };
    if (!domain) return NextResponse.json({ error: 'domain required' }, { status: 400 });

    const normalizedDomain = domain.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].trim();

    if (projectId) {
      // Connect to a specific project via Amplify domain association
      const mgr = DeploymentManager.getInstance();
      const domainRecord = await mgr.attachCustomDomain(projectId, normalizedDomain);
      return NextResponse.json({ ok: true, domain: domainRecord });
    }

    // Generic connect — return DNS records the user needs to add
    const setupStatus = await checkAwsSetupStatus();
    const hostedZoneId = setupStatus.hostedZone?.id;

    return NextResponse.json({
      ok: true,
      domain: normalizedDomain,
      instructions: {
        method: 'CNAME',
        steps: [
          `Log into your domain registrar for ${normalizedDomain}`,
          `Add a CNAME record:`,
          `  Name: www   →   Value: ${PLATFORM_DOMAIN}`,
          `  Name: @     →   Value: ${PLATFORM_DOMAIN} (A record, if supported)`,
          `Changes propagate in 24–48 hours (often faster)`,
        ],
        dnsRecords: [
          { type: 'CNAME', name: `www.${normalizedDomain}`, value: PLATFORM_DOMAIN },
        ],
      },
    });
  }

  // ── Add Subdomain for Project ──────────────────────────────────────────────
  if (action === 'add-subdomain') {
    const { projectId, slug } = body as { projectId: string; slug: string };
    if (!projectId || !slug) return NextResponse.json({ error: 'projectId and slug required' }, { status: 400 });

    const mgr = DeploymentManager.getInstance();
    const record = await mgr.getRecord(projectId);
    if (!record) return NextResponse.json({ error: 'No deployment found for this project' }, { status: 404 });

    const brandedUrl = `https://${slug}.${PLATFORM_DOMAIN}`;

    // If already set up via Amplify domain association, done
    if (record.brandedUrl === brandedUrl) {
      return NextResponse.json({ ok: true, brandedUrl, alreadyConfigured: true });
    }

    // Otherwise configure via Amplify
    const { AmplifyProvider } = await import('@/services/deployment/providers/amplify-provider');
    const provider = new AmplifyProvider();
    const { AmplifyClient } = await import('@aws-sdk/client-amplify');
    const amplifyClient = new AmplifyClient({
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: { accessKeyId: AWS_KEY, secretAccessKey: AWS_SECRET },
    });
    await provider.attachBrandedSubdomain(amplifyClient, record.providerAppId, slug);

    return NextResponse.json({ ok: true, brandedUrl });
  }

  // ── List All Domains (registered + connected) ──────────────────────────────
  if (action === 'list-all') {
    const [registered, deployments] = await Promise.allSettled([
      listRegisteredDomains(),
      DeploymentManager.getInstance().listAll(),
    ]);

    const registeredList = registered.status === 'fulfilled' ? registered.value : [];
    const deploymentList = deployments.status === 'fulfilled' ? deployments.value : [];

    // Collect all custom domains from deployments
    const projectDomains: Array<{ domain: string; projectName: string; brandedUrl: string; status: string }> = [];
    for (const dep of deploymentList) {
      // Add branded URL as a domain entry
      projectDomains.push({
        domain: dep.brandedUrl.replace('https://', ''),
        projectName: dep.projectName,
        brandedUrl: dep.brandedUrl,
        status: dep.status,
      });
      // Add custom domains
      for (const cd of dep.customDomains) {
        projectDomains.push({
          domain: cd.domain,
          projectName: dep.projectName,
          brandedUrl: dep.brandedUrl,
          status: cd.status,
        });
      }
    }

    return NextResponse.json({
      ok: true,
      registered: registeredList,
      projectDomains,
      platformDomain: PLATFORM_DOMAIN,
    });
  }

  // ── Transferability Check ──────────────────────────────────────────────────
  if (action === 'check-transfer') {
    const { domain } = body as { domain: string };
    if (!domain) return NextResponse.json({ error: 'domain required' }, { status: 400 });
    const result = await checkTransferability(domain);
    return NextResponse.json({ ok: true, result });
  }

  // ── TLD Price ──────────────────────────────────────────────────────────────
  if (action === 'tld-price') {
    const { tld } = body as { tld: string };
    if (!tld) return NextResponse.json({ error: 'tld required' }, { status: 400 });
    const price = await getTldPrice(tld);
    return NextResponse.json({ ok: true, price });
  }

  return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
}
