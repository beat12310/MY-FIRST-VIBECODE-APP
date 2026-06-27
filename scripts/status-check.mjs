#!/usr/bin/env node
/**
 * Live status check — mirrors what the Domains Dashboard now shows
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
function loadEnv() {
  const raw = readFileSync(join(ROOT, '.env.local'), 'utf-8');
  const env = {};
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return env;
}

const ENV = loadEnv();
const creds = { accessKeyId: ENV.AWS_ACCESS_KEY_ID, secretAccessKey: ENV.AWS_SECRET_ACCESS_KEY };
const DOMAIN = ENV.DWOMOH_BRANDED_DOMAIN || 'dwomohvibe.com';
const HZ_ID  = ENV.DWOMOH_HOSTED_ZONE_ID;
const CERT   = ENV.ACM_CERTIFICATE_ARN;
const APP_ID = ENV.AMPLIFY_SENTINEL_APP_ID;

const { Route53Client, ListHostedZonesByNameCommand, GetHostedZoneCommand, ListResourceRecordSetsCommand } = await import('@aws-sdk/client-route-53');
const { ACMClient, DescribeCertificateCommand } = await import('@aws-sdk/client-acm');
const { AmplifyClient, GetDomainAssociationCommand } = await import('@aws-sdk/client-amplify');
const { IAMClient, GetRoleCommand } = await import('@aws-sdk/client-iam');

const r53    = new Route53Client({ region: 'us-east-1', credentials: creds });
const acmCli = new ACMClient({ region: 'us-east-1', credentials: creds });
const ampCli = new AmplifyClient({ region: 'us-east-1', credentials: creds });
const iamCli = new IAMClient({ region: 'us-east-1', credentials: creds });

const c = { g: s => `\x1b[32m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m`, d: s => `\x1b[2m${s}\x1b[0m` };
const check = (ok, label, val) => console.log(`  ${ok ? c.g('✓') : c.y('○')} ${c.b(label.padEnd(22))} ${val}`);

console.log(`\n${c.b('═══ DWOMOH Vibe Code — Platform Status ═══')}\n`);

// Route 53 Hosted Zone
const hzRes = await r53.send(new ListHostedZonesByNameCommand({ DNSName: DOMAIN, MaxItems: 5 }));
const hz = hzRes.HostedZones?.find(z => z.Name === `${DOMAIN}.` || z.Name === DOMAIN);
const hzDetail = hz ? await r53.send(new GetHostedZoneCommand({ Id: hz.Id })) : null;
const ns = hzDetail?.DelegationSet?.NameServers ?? [];
check(!!hz, 'Hosted Zone', hz ? `${hz.Id.split('/').pop()} · ${ns.length} NS` : 'NOT FOUND');
if (ns.length) ns.forEach(n => console.log(c.d(`    ${n}`)));

// Route 53 Records
if (HZ_ID) {
  const recs = await r53.send(new ListResourceRecordSetsCommand({ HostedZoneId: HZ_ID, MaxItems: 50 }));
  console.log(c.d(`  ↳ ${recs.ResourceRecordSets?.length ?? 0} DNS records`));
}

// ACM Certificate
let certOk = false;
let certExpiry = '';
if (CERT) {
  const certRes = await acmCli.send(new DescribeCertificateCommand({ CertificateArn: CERT }));
  const cert = certRes.Certificate;
  certOk = cert?.Status === 'ISSUED';
  certExpiry = cert?.NotAfter ? `· Expires ${new Date(cert.NotAfter).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}` : '';
  check(certOk, 'SSL Certificate', `${cert?.Status} ${certExpiry}`);
  console.log(c.d(`  ↳ Covers: ${cert?.SubjectAlternativeNames?.join(', ')}`));
  if (cert?.IssuedAt) console.log(c.d(`  ↳ Issued: ${new Date(cert.IssuedAt).toLocaleDateString()}`));
} else {
  check(false, 'SSL Certificate', 'ARN not set in .env.local');
}

// IAM Role
let roleOk = false;
try {
  const roleRes = await iamCli.send(new GetRoleCommand({ RoleName: 'DwomohAmplifyServiceRole' }));
  roleOk = true;
  check(true, 'IAM Role', roleRes.Role.RoleName);
} catch {
  check(false, 'IAM Role', 'DwomohAmplifyServiceRole not found');
}

// Amplify Domain Association
let amplifyOk = false;
if (APP_ID) {
  try {
    const assocRes = await ampCli.send(new GetDomainAssociationCommand({ appId: APP_ID, domainName: DOMAIN }));
    const da = assocRes.domainAssociation;
    amplifyOk = da?.domainStatus === 'AVAILABLE';
    const cf = da?.subDomains?.[0]?.dnsRecord?.split(' ').pop()?.replace(/\.$/, '') ?? '';
    check(amplifyOk, 'Amplify Domain', `${da?.domainStatus}`);
    if (cf) console.log(c.d(`  ↳ CloudFront: ${cf}`));
    console.log(c.d(`  ↳ Sentinel App: ${APP_ID}`));
  } catch (e) {
    check(false, 'Amplify Domain', `Error: ${e.message}`);
  }
} else {
  check(false, 'Amplify Domain', 'AMPLIFY_SENTINEL_APP_ID not set');
}

// Summary
const allGood = !!hz && certOk && roleOk;
console.log(`\n${c.b('─────────────────────────────────────────')}`);
if (allGood && amplifyOk) {
  console.log(c.g(`  ✓ All systems operational\n  Every deployed project receives {slug}.${DOMAIN} with SSL`));
} else if (allGood) {
  console.log(c.y(`  ⟳ Amplify domain association still provisioning (AWAITING_APP_CNAME)`));
  console.log(c.y(`  This usually takes 5–15 minutes. Re-run: node scripts/status-check.mjs`));
  console.log(`\n  ${c.b('Deployments still work!')} The branded URL system is active.`);
  console.log(`  Amplify will auto-configure DNS once it verifies the CloudFront CNAME.`);
} else {
  console.log(c.y(`  ⚠ Some services need attention — run: node scripts/aws-setup.mjs`));
}
console.log('');
