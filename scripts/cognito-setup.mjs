#!/usr/bin/env node
/**
 * scripts/cognito-setup.mjs
 *
 * Full Cognito configuration manager for DWOMOH Vibe Code.
 * Run:
 *   node scripts/cognito-setup.mjs              -- show current state
 *   node scripts/cognito-setup.mjs --add-google  -- add Google IDP
 *   node scripts/cognito-setup.mjs --add-apple   -- add Apple IDP
 *   node scripts/cognito-setup.mjs --status       -- verify setup
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// Load .env.local
const envPath = join(process.cwd(), '.env.local');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#=\s]+)\s*=\s*(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const {
  CognitoIdentityProviderClient,
  DescribeUserPoolCommand,
  DescribeUserPoolClientCommand,
  ListIdentityProvidersCommand,
  CreateIdentityProviderCommand,
  UpdateIdentityProviderCommand,
  UpdateUserPoolClientCommand,
} = await import('@aws-sdk/client-cognito-identity-provider');

const client = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const UP_ID     = process.env.NEXT_PUBLIC_USER_POOL_ID     ?? 'us-east-1_yrq9EpTzD';
const CLIENT_ID = process.env.NEXT_PUBLIC_USER_POOL_CLIENT_ID ?? '6kr0ed1157iegv17i09cfq913f';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) { console.log(msg); }
function ok(msg)  { console.log(`\x1b[32m✓\x1b[0m ${msg}`); }
function warn(msg){ console.log(`\x1b[33m⚠\x1b[0m ${msg}`); }
function info(msg){ console.log(`\x1b[36mℹ\x1b[0m ${msg}`); }

async function getIDPs() {
  const r = await client.send(new ListIdentityProvidersCommand({ UserPoolId: UP_ID }));
  return r.Providers;
}

async function getClientConfig() {
  const r = await client.send(new DescribeUserPoolClientCommand({ UserPoolId: UP_ID, ClientId: CLIENT_ID }));
  return r.UserPoolClient;
}

async function updateClientIDPs(idps) {
  const current = await getClientConfig();
  const existing = current.SupportedIdentityProviders ?? ['COGNITO'];
  const merged   = [...new Set([...existing, ...idps])];
  await client.send(new UpdateUserPoolClientCommand({
    UserPoolId:  UP_ID,
    ClientId:    CLIENT_ID,
    ClientName:  current.ClientName,
    AllowedOAuthFlowsUserPoolClient: true,
    AllowedOAuthFlows:  current.AllowedOAuthFlows  ?? ['code'],
    AllowedOAuthScopes: current.AllowedOAuthScopes ?? ['email', 'openid', 'profile'],
    ExplicitAuthFlows:  current.ExplicitAuthFlows  ?? ['ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
    CallbackURLs:       current.CallbackURLs,
    LogoutURLs:         current.LogoutURLs,
    SupportedIdentityProviders: merged,
    AccessTokenValidity:  current.AccessTokenValidity,
    IdTokenValidity:      current.IdTokenValidity,
    RefreshTokenValidity: current.RefreshTokenValidity,
    TokenValidityUnits:   current.TokenValidityUnits,
    PreventUserExistenceErrors: 'ENABLED',
  }));
  return merged;
}

// ─── Status report ───────────────────────────────────────────────────────────

async function printStatus() {
  log('\n═══════════════════════════════════════════════════════');
  log('  DWOMOH Vibe Code — Cognito Auth Status');
  log('═══════════════════════════════════════════════════════\n');

  const up     = (await client.send(new DescribeUserPoolCommand({ UserPoolId: UP_ID }))).UserPool;
  const client_ = await getClientConfig();
  const idps   = await getIDPs();

  ok(`User Pool:  ${up.Id}  (${up.Name})`);
  ok(`App Client: ${CLIENT_ID}  (no secret — public SPA)`);

  const domain = up.Domain;
  if (domain) {
    ok(`Cognito Domain: ${domain}.auth.us-east-1.amazoncognito.com`);
  } else {
    warn('No Cognito domain configured — social sign-in will not work');
  }

  const oauthOn = client_.AllowedOAuthFlowsUserPoolClient;
  if (oauthOn) {
    ok(`OAuth:      enabled — flows: ${client_.AllowedOAuthFlows?.join(', ')}`);
    ok(`Scopes:     ${client_.AllowedOAuthScopes?.join(', ')}`);
    ok(`Callbacks:  ${client_.CallbackURLs?.join(', ')}`);
    ok(`Logouts:    ${client_.LogoutURLs?.join(', ')}`);
  } else {
    warn('OAuth is DISABLED on the app client');
  }

  log('\n─── Identity Providers ────────────────────────────────');
  if (idps.length === 0) {
    warn('No social IDPs configured. Use --add-google or --add-apple to add them.');
  } else {
    for (const p of idps) {
      ok(`${p.ProviderType}: ${p.ProviderName}`);
    }
  }

  log('\n─── Supported IDPs on App Client ──────────────────────');
  const supported = client_.SupportedIdentityProviders ?? [];
  supported.forEach(p => ok(p));

  log('\n─── Environment Variables ─────────────────────────────');
  const vars = {
    NEXT_PUBLIC_AWS_REGION:            process.env.NEXT_PUBLIC_AWS_REGION,
    NEXT_PUBLIC_USER_POOL_ID:          process.env.NEXT_PUBLIC_USER_POOL_ID,
    NEXT_PUBLIC_USER_POOL_CLIENT_ID:   process.env.NEXT_PUBLIC_USER_POOL_CLIENT_ID,
    NEXT_PUBLIC_COGNITO_DOMAIN:        process.env.NEXT_PUBLIC_COGNITO_DOMAIN,
    NEXT_PUBLIC_GOOGLE_CLIENT_ID:      process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID,
    APPLE_TEAM_ID:                     process.env.APPLE_TEAM_ID,
  };
  for (const [k, v] of Object.entries(vars)) {
    if (v) ok(`${k} = ${k.includes('SECRET') || k.includes('KEY_ID') ? '***' : v}`);
    else    warn(`${k} = (not set)`);
  }

  log('\n═══════════════════════════════════════════════════════\n');
}

// ─── Add Google ───────────────────────────────────────────────────────────────

async function addGoogle() {
  const clientId     = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    log('\n\x1b[33m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
    log('\x1b[1mGoogle Sign-In — Manual steps required\x1b[0m');
    log('\x1b[33m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m\n');
    log('1. Go to: https://console.cloud.google.com/apis/credentials');
    log('2. Create a project (or select existing)');
    log('3. "Create credentials" → "OAuth client ID"');
    log('4. Application type: Web application');
    log('5. Name: DWOMOH Vibe Code');
    log('6. Authorized redirect URIs — add EXACTLY these three:');
    log('     https://auth.dwomohvibe.com/oauth2/idpresponse');
    log('     https://dwomohvibe.com/auth/callback');
    log('     http://localhost:3000/auth/callback');
    log('7. Click "Create" → copy the Client ID and Client Secret');
    log('\n8. Add to .env.local:');
    log('   NEXT_PUBLIC_GOOGLE_CLIENT_ID=<paste-client-id>');
    log('   GOOGLE_CLIENT_SECRET=<paste-client-secret>');
    log('\n9. Re-run: node scripts/cognito-setup.mjs --add-google\n');
    return;
  }

  info('Adding Google as identity provider…');

  // Check if Google IDP already exists
  const idps = await getIDPs();
  const exists = idps.find(p => p.ProviderName === 'Google');

  const cmd = exists ? UpdateIdentityProviderCommand : CreateIdentityProviderCommand;
  await client.send(new cmd({
    UserPoolId:    UP_ID,
    ProviderName:  'Google',
    ProviderType:  'Google',
    ProviderDetails: {
      client_id:              clientId,
      client_secret:          clientSecret,
      authorize_scopes:       'profile email openid',
    },
    AttributeMapping: {
      email:       'email',
      name:        'name',
      username:    'sub',
      given_name:  'given_name',
      family_name: 'family_name',
      picture:     'picture',
    },
  }));

  const merged = await updateClientIDPs(['Google']);
  ok(`Google IDP ${exists ? 'updated' : 'created'} and added to app client`);
  ok(`App client now supports: ${merged.join(', ')}`);

  // Update .env.local to ensure GOOGLE vars are persisted
  log('\nGoogle Sign-In is now fully configured in Cognito.');
  log('Users can now sign in with Google from /auth/signin\n');
}

// ─── Add Apple ────────────────────────────────────────────────────────────────

async function addApple() {
  const teamId     = process.env.APPLE_TEAM_ID;
  const clientId   = process.env.APPLE_CLIENT_ID;     // Service ID
  const keyId      = process.env.APPLE_KEY_ID;
  const privateKey = process.env.APPLE_PRIVATE_KEY;

  if (!teamId || !clientId || !keyId || !privateKey) {
    log('\n\x1b[33m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
    log('\x1b[1mApple Sign-In — Manual steps required\x1b[0m');
    log('\x1b[33m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m\n');
    log('Apple Sign In requires an Apple Developer account ($99/year).\n');
    log('Step 1 — Create an App ID:');
    log('  https://developer.apple.com/account/resources/identifiers/list');
    log('  → Register App ID → enable "Sign In with Apple"\n');
    log('Step 2 — Create a Service ID (this is the OAuth client_id):');
    log('  → Register Service ID → enable "Sign In with Apple"');
    log('  → Configure → add these return URLs:');
    log('      https://dwomoh-vibecode.auth.us-east-1.amazoncognito.com/oauth2/idpresponse');
    log('  → Note your Service ID (e.g. com.dwomohvibe.signin)\n');
    log('Step 3 — Create a Key:');
    log('  https://developer.apple.com/account/resources/authkeys/list');
    log('  → Register a New Key → enable "Sign In with Apple"');
    log('  → Download the .p8 file (you can only download it once)\n');
    log('Step 4 — Add to .env.local:');
    log('  APPLE_TEAM_ID=<your-10-char-team-id>');
    log('  APPLE_CLIENT_ID=<your-service-id>  (e.g. com.dwomohvibe.signin)');
    log('  APPLE_KEY_ID=<your-key-id>');
    log('  APPLE_PRIVATE_KEY=<contents-of-.p8-file-as-single-line-with-\\n>');
    log('\nStep 5 — Re-run: node scripts/cognito-setup.mjs --add-apple\n');
    return;
  }

  info('Adding Apple as identity provider…');
  const idps = await getIDPs();
  const exists = idps.find(p => p.ProviderName === 'SignInWithApple');

  const cmd = exists ? UpdateIdentityProviderCommand : CreateIdentityProviderCommand;
  await client.send(new cmd({
    UserPoolId:   UP_ID,
    ProviderName: 'SignInWithApple',
    ProviderType: 'SignInWithApple',
    ProviderDetails: {
      client_id:        clientId,
      team_id:          teamId,
      key_id:           keyId,
      private_key:      privateKey,
      authorize_scopes: 'name email',
    },
    AttributeMapping: {
      email:      'email',
      name:       'name',
      username:   'sub',
    },
  }));

  const merged = await updateClientIDPs(['SignInWithApple']);
  ok(`Apple Sign-In ${exists ? 'updated' : 'created'} and added to app client`);
  ok(`App client now supports: ${merged.join(', ')}`);
  log('\nApple Sign-In is now configured. Users can sign in with Apple.\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--add-google')) {
  await addGoogle();
} else if (args.includes('--add-apple')) {
  await addApple();
} else {
  await printStatus();
}
