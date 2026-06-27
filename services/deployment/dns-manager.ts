/**
 * DNS Manager — Route 53 wildcard subdomain management for *.dwomohvibe.app
 *
 * Prerequisites (one-time setup):
 *   1. Register dwomohvibe.app and add it as a hosted zone in Route 53
 *   2. Set DWOMOH_HOSTED_ZONE_ID in .env.local
 *   3. Verify the domain in AWS Amplify Console so Amplify can issue ACM certs
 *
 * How branding works:
 *   • Amplify creates: main.{appId}.amplifyapp.com
 *   • We call Amplify's CreateDomainAssociation to add {slug}.dwomohvibe.app
 *   • Amplify provisions the ACM cert and sets Route 53 CNAME records automatically
 *   • Users see only {slug}.dwomohvibe.app — never the amplifyapp.com URL
 */

import {
  Route53Client,
  ChangeResourceRecordSetsCommand,
  ListHostedZonesByNameCommand,
  GetChangeCommand,
} from '@aws-sdk/client-route-53';

const BRANDED_DOMAIN = process.env.DWOMOH_BRANDED_DOMAIN || 'dwomohvibe.com';
const HOSTED_ZONE_ID = process.env.DWOMOH_HOSTED_ZONE_ID || '';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || '';
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || '';

function getRoute53Client() {
  return new Route53Client({
    region: 'us-east-1', // Route 53 is always us-east-1
    credentials: {
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
    },
  });
}

/** Convert a project name into a URL-safe subdomain slug */
export function slugifyProjectName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')       // remove non-alphanumeric
    .replace(/\s+/g, '-')                // spaces → hyphens
    .replace(/-+/g, '-')                 // collapse multiple hyphens
    .replace(/^-|-$/g, '')              // trim leading/trailing hyphens
    .slice(0, 50);                       // max length
}

/** Build the full branded URL for a project slug */
export function buildBrandedUrl(slug: string): string {
  return `https://${slug}.${BRANDED_DOMAIN}`;
}

/** Look up the Route 53 hosted zone ID for the branded domain */
async function findHostedZoneId(): Promise<string | null> {
  if (HOSTED_ZONE_ID) return HOSTED_ZONE_ID;

  const client = getRoute53Client();
  try {
    const res = await client.send(new ListHostedZonesByNameCommand({
      DNSName: BRANDED_DOMAIN,
      MaxItems: 1,
    }));
    const zone = res.HostedZones?.find(z =>
      z.Name === `${BRANDED_DOMAIN}.` || z.Name === BRANDED_DOMAIN
    );
    return zone?.Id?.replace('/hostedzone/', '') ?? null;
  } catch {
    return null;
  }
}

/**
 * Create a CNAME record in Route 53: {slug}.dwomohvibe.app → {amplifyDefaultUrl}
 *
 * NOTE: For full SSL support, prefer using Amplify's CreateDomainAssociation instead
 * (see AmplifyProvider.attachBrandedSubdomain). This function is a fallback for when
 * you want pure Route 53 control (e.g., pointing at a non-Amplify backend).
 */
export async function createSubdomainCNAME(slug: string, targetHost: string): Promise<{
  success: boolean;
  record: string;
  changeId?: string;
  error?: string;
}> {
  const zoneId = await findHostedZoneId();
  if (!zoneId) {
    return {
      success: false,
      record: `${slug}.${BRANDED_DOMAIN}`,
      error: `Route 53 hosted zone for ${BRANDED_DOMAIN} not found. Set DWOMOH_HOSTED_ZONE_ID in .env.local or create the hosted zone in Route 53.`,
    };
  }

  const client = getRoute53Client();
  const fqdn = `${slug}.${BRANDED_DOMAIN}`;

  try {
    const res = await client.send(new ChangeResourceRecordSetsCommand({
      HostedZoneId: zoneId,
      ChangeBatch: {
        Comment: `DWOMOH Vibe Code — ${slug} deployment`,
        Changes: [{
          Action: 'UPSERT',
          ResourceRecordSet: {
            Name: fqdn,
            Type: 'CNAME',
            TTL: 300,
            ResourceRecords: [{ Value: targetHost }],
          },
        }],
      },
    }));

    return {
      success: true,
      record: fqdn,
      changeId: res.ChangeInfo?.Id,
    };
  } catch (err) {
    return {
      success: false,
      record: fqdn,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Delete a CNAME subdomain record from Route 53 */
export async function deleteSubdomainCNAME(slug: string, targetHost: string): Promise<boolean> {
  const zoneId = await findHostedZoneId();
  if (!zoneId) return false;

  const client = getRoute53Client();
  try {
    await client.send(new ChangeResourceRecordSetsCommand({
      HostedZoneId: zoneId,
      ChangeBatch: {
        Changes: [{
          Action: 'DELETE',
          ResourceRecordSet: {
            Name: `${slug}.${BRANDED_DOMAIN}`,
            Type: 'CNAME',
            TTL: 300,
            ResourceRecords: [{ Value: targetHost }],
          },
        }],
      },
    }));
    return true;
  } catch {
    return false;
  }
}

/** Wait for a Route 53 change to propagate */
export async function waitForDnsChange(changeId: string, timeoutMs = 60_000): Promise<boolean> {
  const client = getRoute53Client();
  const start = Date.now();
  const id = changeId.replace('/change/', '');

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await client.send(new GetChangeCommand({ Id: id }));
      if (res.ChangeInfo?.Status === 'INSYNC') return true;
    } catch { /* ignore */ }
    await new Promise(r => setTimeout(r, 5000));
  }
  return false;
}

export { BRANDED_DOMAIN };
