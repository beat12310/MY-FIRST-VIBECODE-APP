#!/usr/bin/env node
/**
 * Check Amplify domain association status and add any required DNS records to Route 53
 */
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function loadEnv() {
  const raw = readFileSync(join(ROOT, '.env.local'), 'utf-8');
  const env = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return env;
}

const ENV = loadEnv();
const creds = { accessKeyId: ENV.AWS_ACCESS_KEY_ID, secretAccessKey: ENV.AWS_SECRET_ACCESS_KEY };
const DOMAIN       = ENV.DWOMOH_BRANDED_DOMAIN;
const HZ_ID        = ENV.DWOMOH_HOSTED_ZONE_ID;
const APP_ID       = ENV.AMPLIFY_SENTINEL_APP_ID;
const AWS_REGION   = ENV.AWS_REGION || 'us-east-1';

const { AmplifyClient, GetDomainAssociationCommand, GetAppCommand } = await import('@aws-sdk/client-amplify');
const { Route53Client, ChangeResourceRecordSetsCommand, ListResourceRecordSetsCommand } = await import('@aws-sdk/client-route-53');

const ampCli = new AmplifyClient({ region: AWS_REGION, credentials: creds });
const r53    = new Route53Client({ region: 'us-east-1', credentials: creds });

console.log(`\n── Amplify Domain Association Status ────────────────────────────\n`);

const assocRes = await ampCli.send(new GetDomainAssociationCommand({
  appId: APP_ID,
  domainName: DOMAIN,
}));

const assoc = assocRes.domainAssociation;
console.log(`Domain:    ${assoc.domainName}`);
console.log(`App ID:    ${APP_ID}`);
console.log(`Status:    ${assoc.domainStatus}`);
console.log(`Auto SSL:  ${assoc.enableAutoSubDomain}`);

// Certificate verification record
if (assoc.certificateVerificationDNSRecord) {
  const parts = assoc.certificateVerificationDNSRecord.split(' ');
  console.log(`\nAmplify Cert Verification Record:`);
  console.log(`  ${assoc.certificateVerificationDNSRecord}`);

  // Add this to Route 53 if not already there
  if (HZ_ID) {
    const cnameMatch = assoc.certificateVerificationDNSRecord.match(/(\S+)\s+CNAME\s+(\S+)/i);
    if (cnameMatch) {
      const [, name, value] = cnameMatch;
      try {
        await r53.send(new ChangeResourceRecordSetsCommand({
          HostedZoneId: HZ_ID,
          ChangeBatch: {
            Comment: 'Amplify domain verification',
            Changes: [{ Action: 'UPSERT', ResourceRecordSet: {
              Name: name.endsWith('.') ? name : `${name}.`,
              Type: 'CNAME',
              TTL: 300,
              ResourceRecords: [{ Value: value.endsWith('.') ? value : `${value}.` }],
            }}],
          },
        }));
        console.log(`  ✓ Added to Route 53`);
      } catch (e) {
        if (e.message?.includes('same action')) {
          console.log(`  ✓ Already in Route 53`);
        } else {
          console.log(`  ⚠ Route 53 error: ${e.message}`);
        }
      }
    }
  }
}

// Sub-domain DNS records
console.log(`\nSub-domain DNS Records:`);
for (const sub of assoc.subDomains ?? []) {
  console.log(`  prefix: "${sub.subDomainSetting?.prefix}"  branch: ${sub.subDomainSetting?.branchName}`);
  console.log(`  status: ${sub.dnsRecord ?? 'pending'}`);
  if (sub.dnsRecord) {
    // Try to add to Route 53
    const cnameMatch = sub.dnsRecord.match(/(\S+)\s+CNAME\s+(\S+)/i);
    if (cnameMatch && HZ_ID) {
      const [, name, value] = cnameMatch;
      try {
        await r53.send(new ChangeResourceRecordSetsCommand({
          HostedZoneId: HZ_ID,
          ChangeBatch: {
            Comment: `Amplify subdomain ${name}`,
            Changes: [{ Action: 'UPSERT', ResourceRecordSet: {
              Name: name.endsWith('.') ? name : `${name}.`,
              Type: 'CNAME',
              TTL: 300,
              ResourceRecords: [{ Value: value.endsWith('.') ? value : `${value}.` }],
            }}],
          },
        }));
        console.log(`    ✓ Added CNAME to Route 53`);
      } catch (e) {
        console.log(`    ✓ ${e.message?.includes('same action') ? 'Already in Route 53' : `Route53: ${e.message}`}`);
      }
    }
  }
}

console.log(`\n── Current Route 53 Records for ${DOMAIN} ───────────────────────\n`);
const recordsRes = await r53.send(new ListResourceRecordSetsCommand({
  HostedZoneId: HZ_ID,
  MaxItems: 50,
}));

for (const rec of recordsRes.ResourceRecordSets ?? []) {
  const vals = rec.ResourceRecords?.map(r => r.Value).join(', ') ?? rec.AliasTarget?.DNSName ?? '';
  console.log(`  ${rec.Type.padEnd(6)} ${rec.Name.padEnd(50)} ${vals.slice(0, 60)}`);
}

console.log(`\n── Summary ──────────────────────────────────────────────────────\n`);
if (assoc.domainStatus === 'AVAILABLE') {
  console.log(`✓ ${DOMAIN} is FULLY ACTIVE in Amplify`);
  console.log(`  Every project deployment will get {slug}.${DOMAIN} automatically`);
} else {
  console.log(`⏳ Domain association status: ${assoc.domainStatus}`);
  console.log(`  This will become AVAILABLE within 5–15 minutes`);
  console.log(`  Run: node scripts/check-amplify-domain.mjs to check again`);
}
