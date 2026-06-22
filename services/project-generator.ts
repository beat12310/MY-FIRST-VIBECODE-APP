import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { PROJECT_CONFIG, LOG_MESSAGES } from '@/lib/constants';
import { ProjectFile } from '@/lib/types';
import { createError, ErrorCode, logError } from '@/lib/error-handler';

// ─── Default file templates ────────────────────────────────────────────────
// Injected when the AI omits them or generates malformed versions.

const DEFAULT_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2017',
    lib: ['dom', 'dom.iterable', 'esnext'],
    allowJs: true,
    skipLibCheck: true,
    strict: false,
    noEmit: true,
    esModuleInterop: true,
    moduleResolution: 'bundler',
    resolveJsonModule: true,
    isolatedModules: true,
    jsx: 'preserve',
    baseUrl: '.',
    paths: { '@/*': ['./*'] },
    plugins: [{ name: 'next' }],
  },
  include: ['next-env.d.ts', '.next/types/**/*.ts', '**/*.ts', '**/*.tsx'],
  exclude: ['node_modules'],
}, null, 2);

const DEFAULT_NEXT_CONFIG = `const path = require('path');
/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: path.join(__dirname),
  // Required for better-sqlite3 and other native modules used by lib/managed/
  serverExternalPackages: ['better-sqlite3'],
  images: {
    remotePatterns: [{ protocol: 'https', hostname: '**' }],
  },
};
module.exports = nextConfig;
`;

// ─── Known package versions ────────────────────────────────────────────────
// When the AI imports one of these but omits it from package.json, the scanner
// adds it automatically. Extend this map as new packages are encountered.
const KNOWN_PACKAGE_VERSIONS: Record<string, string> = {
  'lucide-react': '^0.447.0',
  'clsx': '^2.1.1',
  'tailwind-merge': '^2.5.2',
  'class-variance-authority': '^0.7.0',
  'framer-motion': '^11.11.11',
  'react-hook-form': '^7.53.0',
  'zod': '^3.23.8',
  'axios': '^1.7.7',
  'date-fns': '^4.1.0',
  'recharts': '^2.13.3',
  '@tanstack/react-query': '^5.59.20',
  'react-hot-toast': '^2.4.1',
  'sonner': '^1.5.0',
  'react-icons': '^5.3.0',
  '@radix-ui/react-dialog': '^1.1.2',
  '@radix-ui/react-dropdown-menu': '^2.1.2',
  '@radix-ui/react-tabs': '^1.1.1',
  '@radix-ui/react-tooltip': '^1.1.3',
  '@radix-ui/react-select': '^2.1.2',
  '@radix-ui/react-checkbox': '^1.1.2',
  '@radix-ui/react-switch': '^1.1.1',
  '@radix-ui/react-label': '^2.1.0',
  '@radix-ui/react-popover': '^1.1.2',
  '@radix-ui/react-accordion': '^1.2.1',
  '@radix-ui/react-separator': '^1.1.0',
  '@radix-ui/react-avatar': '^1.1.1',
  '@radix-ui/react-progress': '^1.1.0',
  '@radix-ui/react-slider': '^1.2.1',
  '@radix-ui/react-alert-dialog': '^1.1.2',
  // Managed backend services (injected into every project via injectManagedServices)
  'better-sqlite3': '^9.4.3',
  '@types/better-sqlite3': '^7.6.11',
  'bcryptjs': '^2.4.3',
  '@types/bcryptjs': '^2.4.6',
  'jose': '^5.9.3',
  'qrcode': '^1.5.4',
  '@types/qrcode': '^1.5.5',
  '@aws-sdk/client-ses': '^3.621.0',
  '@aws-sdk/client-s3': '^3.621.0',
  '@aws-sdk/s3-request-presigner': '^3.621.0',
  'uuid': '^10.0.0',
  '@types/uuid': '^10.0.0',
};

function extractImportedPackages(content: string): string[] {
  const packages = new Set<string>();
  // ES import: import ... from 'pkg'  |  import 'pkg'
  const esImport = /(?:^|\n)\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"./][^'"]*)['"]/g;
  // dynamic import / require
  const dynImport = /(?:import|require)\s*\(\s*['"]([^'"./][^'"]*)['"]\s*\)/g;

  for (const re of [esImport, dynImport]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const raw = m[1];
      // @scope/name(/sub) → @scope/name;  name(/sub) → name
      const name = raw.startsWith('@')
        ? raw.split('/').slice(0, 2).join('/')
        : raw.split('/')[0];
      packages.add(name);
    }
  }

  return Array.from(packages);
}

async function enrichPackageJson(
  baseDir: string,
  files: ProjectFile[],
  logs: string[]
): Promise<void> {
  const pkgFile = files.find(f => f.path === 'package.json');
  if (!pkgFile) return;

  let pkg: Record<string, any>;
  try {
    const raw = typeof pkgFile.content === 'string'
      ? pkgFile.content
      : JSON.stringify(pkgFile.content);
    pkg = JSON.parse(raw);
  } catch {
    return; // malformed package.json — skip silently
  }

  const allDeclared = new Set<string>([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ]);

  // Collect every npm package imported across all source files
  const codeExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);
  const detected = new Set<string>();
  for (const file of files) {
    const ext = '.' + file.path.split('.').pop();
    if (!codeExts.has(ext)) continue;
    for (const pkg of extractImportedPackages(typeof file.content === 'string' ? file.content : '')) {
      detected.add(pkg);
    }
  }

  // Add missing packages that are in our known list
  const toAdd: Record<string, string> = {};
  for (const name of Array.from(detected)) {
    if (!allDeclared.has(name) && KNOWN_PACKAGE_VERSIONS[name]) {
      toAdd[name] = KNOWN_PACKAGE_VERSIONS[name];
      logs.push(`📦 Auto-added missing dep: ${name}@${KNOWN_PACKAGE_VERSIONS[name]}`);
    }
  }

  if (Object.keys(toAdd).length === 0) return;

  pkg.dependencies = { ...(pkg.dependencies ?? {}), ...toAdd };
  const pkgPath = join(baseDir, 'package.json');
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2), 'utf-8');
}

// ─── Post-generation patchers ──────────────────────────────────────────────
// These run after writing all AI-generated files and silently fix the most
// common generation bugs before npm install and dev server launch.

/**
 * The AI often generates `export default function Home()` in app/page.tsx
 * while also importing `{ Home }` from lucide-react in the same file.
 * At runtime this causes infinite React recursion → Node.js OOM crash.
 * Fix: rename the page export to `Page` (Next.js doesn't care about the name).
 */
function applyHomeConflictFix(content: string): string {
  const hasHomeLucideImport = /import\s*\{[^}]*\bHome\b[^}]*\}\s*from\s*['"]lucide-react['"]/.test(content);
  const hasHomeFunction = /export\s+default\s+function\s+Home\s*[\s(]/.test(content);
  if (!hasHomeLucideImport || !hasHomeFunction) return content;
  return content.replace(
    /export\s+default\s+function\s+Home\s*\(/g,
    'export default function Page('
  );
}

async function patchPageFile(baseDir: string, files: ProjectFile[], logs: string[]): Promise<void> {
  const pageFile = files.find(f => f.path === 'app/page.tsx');
  if (!pageFile) return;
  const content = typeof pageFile.content === 'string' ? pageFile.content : '';
  const fixed = applyHomeConflictFix(content);
  if (fixed !== content) {
    await writeFile(join(baseDir, 'app', 'page.tsx'), fixed, 'utf-8');
    logs.push('🔧 Fixed: renamed page export Home → Page (prevents lucide-react Home icon conflict)');
  }
}

async function patchTsconfig(baseDir: string, files: ProjectFile[], logs: string[]): Promise<void> {
  const tsconfigPath = join(baseDir, 'tsconfig.json');
  const aiGenerated = files.find(f => f.path === 'tsconfig.json');

  if (aiGenerated) {
    try {
      const raw = typeof aiGenerated.content === 'string' ? aiGenerated.content : JSON.stringify(aiGenerated.content);
      const tsconfig = JSON.parse(raw);
      const co = tsconfig.compilerOptions || {};
      let patched = false;
      if (!co.baseUrl || co.baseUrl !== '.') { co.baseUrl = '.'; patched = true; }
      if (!co.paths?.['@/*']) { co.paths = { ...(co.paths || {}), '@/*': ['./*'] }; patched = true; }
      if (co.moduleResolution === 'node') { co.moduleResolution = 'bundler'; patched = true; }
      if (patched) {
        tsconfig.compilerOptions = co;
        await writeFile(tsconfigPath, JSON.stringify(tsconfig, null, 2), 'utf-8');
        logs.push('🔧 Patched tsconfig.json: added @/* path alias');
      }
    } catch {
      await writeFile(tsconfigPath, DEFAULT_TSCONFIG, 'utf-8');
      logs.push('🔧 Replaced malformed tsconfig.json with default (@/* alias included)');
    }
  } else {
    await writeFile(tsconfigPath, DEFAULT_TSCONFIG, 'utf-8');
    logs.push('🔧 Generated tsconfig.json with @/* path alias');
  }
}

async function ensureNextConfig(baseDir: string, files: ProjectFile[], logs: string[]): Promise<void> {
  const hasNextConfig = files.some(
    f => f.path === 'next.config.js' || f.path === 'next.config.ts' || f.path === 'next.config.mjs'
  );
  if (!hasNextConfig) {
    await writeFile(join(baseDir, 'next.config.js'), DEFAULT_NEXT_CONFIG, 'utf-8');
    logs.push('🔧 Generated next.config.js (workspace root + external image support)');
    return;
  }
  // Patch AI-generated next.config.js to add serverExternalPackages for better-sqlite3
  const configFile = files.find(f => f.path === 'next.config.js' || f.path === 'next.config.mjs');
  if (configFile) {
    const content = typeof configFile.content === 'string' ? configFile.content : '';
    if (!content.includes('serverExternalPackages')) {
      const patched = content.replace(
        /const nextConfig\s*=\s*\{/,
        'const nextConfig = {\n  serverExternalPackages: [\'better-sqlite3\'],'
      );
      if (patched !== content) {
        await writeFile(join(baseDir, configFile.path), patched, 'utf-8');
        logs.push('🔧 Patched next.config.js: added serverExternalPackages for better-sqlite3');
      }
    }
  }
}

// ─── Managed Backend Service Templates ────────────────────────────────────────
// These files are injected into EVERY generated project so apps work immediately
// without the user setting up any third-party services.
//
//  lib/managed/db.ts      — SQLite persistent database (zero config)
//  lib/managed/auth.ts    — JWT + bcrypt authentication (zero config)
//  lib/managed/email.ts   — Email (console log in dev; AWS SES when configured)
//  lib/managed/storage.ts — File storage (local disk; AWS S3 when configured)
//  lib/managed/qr.ts      — QR code generation (pure JS, zero config)

const MANAGED_DB_TS = `import Database from 'better-sqlite3';
import { join } from 'path';

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;
  _db = new Database(join(process.cwd(), 'project.db'));
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  return _db;
}

export function initTable(sql: string): void {
  getDb().exec(sql);
}

export const db = {
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return getDb().prepare(sql).all(...params) as T[];
  },
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
    return getDb().prepare(sql).get(...params) as T | undefined;
  },
  run(sql: string, ...params: unknown[]): Database.RunResult {
    return getDb().prepare(sql).run(...params);
  },
};
`;

const MANAGED_AUTH_TS = `import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import { db, initTable } from '@/lib/managed/db';
import crypto from 'crypto';

const JWT_SECRET = new TextEncoder().encode(
  process.env.MANAGED_JWT_SECRET || 'dwomoh-change-in-production-' + process.cwd()
);
const SALT_ROUNDS = 10;

// Initialize auth tables on first import
initTable(\`CREATE TABLE IF NOT EXISTS managed_users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT DEFAULT '',
  role TEXT DEFAULT 'user',
  email_verified INTEGER DEFAULT 0,
  avatar_url TEXT DEFAULT '',
  metadata TEXT DEFAULT '{}',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
)\`);

initTable(\`CREATE TABLE IF NOT EXISTS managed_otps (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  purpose TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)\`);

export interface ManagedUser {
  id: string;
  email: string;
  name: string;
  role: string;
  email_verified: number;
  avatar_url: string;
  metadata: string;
  created_at: string;
}

export async function registerUser(email: string, password: string, name = '') {
  const existing = db.get('SELECT id FROM managed_users WHERE email = ?', email.toLowerCase());
  if (existing) throw new Error('Email already registered');
  const id = crypto.randomUUID();
  const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
  db.run(
    'INSERT INTO managed_users (id, email, password_hash, name) VALUES (?, ?, ?, ?)',
    id, email.toLowerCase(), password_hash, name
  );
  return { id, email: email.toLowerCase(), name };
}

export async function loginUser(email: string, password: string) {
  const user = db.get<ManagedUser & { password_hash: string }>(
    'SELECT * FROM managed_users WHERE email = ?', email.toLowerCase()
  );
  if (!user) throw new Error('Invalid email or password');
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) throw new Error('Invalid email or password');
  const token = await new SignJWT({ sub: user.id, email: user.email, role: user.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('7d')
    .sign(JWT_SECRET);
  const { password_hash: _, ...safeUser } = user;
  return { token, user: safeUser };
}

export async function verifyToken(token: string): Promise<{ sub: string; email: string; role: string } | null> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return payload as { sub: string; email: string; role: string };
  } catch {
    return null;
  }
}

export async function getAuthUser(request: Request): Promise<{ sub: string; email: string; role: string } | null> {
  const auth = request.headers.get('authorization') || '';
  const cookie = request.headers.get('cookie') || '';
  let token = '';
  if (auth.startsWith('Bearer ')) {
    token = auth.slice(7);
  } else {
    const match = cookie.match(/managed_token=([^;]+)/);
    if (match) token = match[1];
  }
  if (!token) return null;
  return verifyToken(token);
}

export function getUserById(id: string): ManagedUser | undefined {
  return db.get<ManagedUser>('SELECT id, email, name, role, email_verified, avatar_url, metadata, created_at FROM managed_users WHERE id = ?', id);
}

export function getUserByEmail(email: string): ManagedUser | undefined {
  return db.get<ManagedUser>('SELECT id, email, name, role, email_verified, avatar_url, metadata, created_at FROM managed_users WHERE email = ?', email.toLowerCase());
}

export function updateUser(id: string, fields: Partial<{ name: string; avatar_url: string; metadata: string; email_verified: number }>) {
  const sets = Object.keys(fields).map(k => \`\${k} = ?\`).join(', ');
  const vals = Object.values(fields);
  db.run(\`UPDATE managed_users SET \${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?\`, ...vals, id);
}

export function createOTP(email: string, purpose: 'verify-email' | 'reset-password' | 'login'): string {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const id = crypto.randomUUID();
  const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  db.run('DELETE FROM managed_otps WHERE email = ? AND purpose = ?', email.toLowerCase(), purpose);
  db.run(
    'INSERT INTO managed_otps (id, email, code, purpose, expires_at) VALUES (?, ?, ?, ?, ?)',
    id, email.toLowerCase(), code, purpose, expires
  );
  return code;
}

export function verifyOTP(email: string, code: string, purpose: string): boolean {
  const otp = db.get<{ id: string; expires_at: string; used: number }>(
    'SELECT id, expires_at, used FROM managed_otps WHERE email = ? AND code = ? AND purpose = ? AND used = 0',
    email.toLowerCase(), code, purpose
  );
  if (!otp || new Date(otp.expires_at) < new Date()) return false;
  db.run('UPDATE managed_otps SET used = 1 WHERE id = ?', otp.id);
  return true;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function checkPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
`;

const MANAGED_EMAIL_TS = `// DWOMOH Vibe Code — Shared Email Service
// Sends real emails via DWOMOH's verified AWS SES identity (zero config per app).
// Branding (name, color) is read from NEXT_PUBLIC_APP_NAME / NEXT_PUBLIC_APP_COLOR
// so each generated app gets its own look without additional setup.

export interface EmailResult {
  delivered: boolean;
  provider: 'ses' | 'resend' | 'console';
  /** Set when SES sandbox blocks the recipient — show a clean UI message, not raw AWS error */
  sandboxBlocked?: boolean;
  /** Human-readable reason for delivery failure */
  reason?: string;
}

interface EmailPayload {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

// Resolved once per import — reads from env so every generated app is independently branded
const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || process.env.APP_NAME || 'App';
const APP_COLOR = process.env.NEXT_PUBLIC_APP_COLOR || process.env.APP_COLOR || '#1e40af';

// ─── Shared branded HTML template ────────────────────────────────────────────
function buildEmailHtml(opts: {
  appName: string;
  appColor: string;
  title: string;
  body: string;
  otp?: string;
  otpLabel?: string;
  footer?: string;
}): string {
  const { appName, appColor, title, body, otp, otpLabel, footer } = opts;
  const otpSection = otp ? \`
    <tr><td style="padding:0 32px 24px">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="background:\${appColor}12;border:2px solid \${appColor}33;border-radius:10px;padding:24px;text-align:center">
          <p style="margin:0 0 8px;color:#6b7280;font-size:13px">\${otpLabel || 'Your verification code'}</p>
          <span style="font-size:42px;font-weight:700;letter-spacing:14px;color:\${appColor};font-family:Courier New,monospace">\${otp}</span>
        </td></tr>
      </table>
    </td></tr>\` : '';
  return \`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f3f4f6;padding:40px 0">
<tr><td align="center"><table width="560" cellpadding="0" cellspacing="0" role="presentation" style="max-width:560px;width:100%">
  <!-- Header bar -->
  <tr><td style="background:\${appColor};padding:22px 32px;border-radius:10px 10px 0 0">
    <span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:-0.3px">\${appName}</span>
  </td></tr>
  <!-- Body -->
  <tr><td style="background:#ffffff;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;padding:32px 32px 8px">
    <h1 style="margin:0 0 12px;color:#111827;font-size:22px;font-weight:700">\${title}</h1>
    <p style="margin:0 0 24px;color:#6b7280;font-size:15px;line-height:1.6">\${body}</p>
  </td></tr>
  \${otpSection}
  <!-- Footer -->
  <tr><td style="background:#ffffff;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;padding:0 32px 24px">
    <p style="margin:0;color:#9ca3af;font-size:13px">\${footer || 'If you did not request this email, you can safely ignore it.'}</p>
  </td></tr>
  <tr><td style="background:#f9fafb;border:1px solid #e5e7eb;border-top:none;padding:14px 32px;border-radius:0 0 10px 10px;text-align:center">
    <p style="margin:0;color:#9ca3af;font-size:12px">\${appName} · Built with DWOMOH Vibe Code</p>
  </td></tr>
</table></td></tr></table>
</body></html>\`;
}

// ─── AWS SES delivery ─────────────────────────────────────────────────────────
async function sendViaSES(payload: EmailPayload, displayName: string): Promise<{ ok: boolean; sandboxBlocked?: boolean; reason?: string }> {
  const key = process.env.DWOMOH_AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
  const secret = process.env.DWOMOH_AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
  const region = process.env.DWOMOH_AWS_REGION || process.env.AWS_REGION || 'us-east-1';
  const from = process.env.DWOMOH_SES_FROM_EMAIL || process.env.SES_FROM_EMAIL;
  if (!key || !secret || !from) return { ok: false, reason: 'SES credentials not configured' };
  try {
    const { SESClient, SendEmailCommand } = await import('@aws-sdk/client-ses');
    const client = new SESClient({ region, credentials: { accessKeyId: key, secretAccessKey: secret } });
    await client.send(new SendEmailCommand({
      Source: \`\${displayName} <\${from}>\`,
      Destination: { ToAddresses: [payload.to] },
      Message: {
        Subject: { Data: payload.subject },
        Body: {
          Html: { Data: payload.html },
          Text: { Data: payload.text || payload.html.replace(/<[^>]+>/g, '') },
        },
      },
    }));
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('not verified') || msg.includes('sandbox') || msg.includes('MessageRejected')) {
      // SES sandbox — recipient not verified. Do NOT expose raw AWS error to end users.
      console.warn(\`[managed/email] SES sandbox mode: \${payload.to} is not a verified recipient. Visit https://console.aws.amazon.com/ses/home to request production access.\`);
      return { ok: false, sandboxBlocked: true, reason: \`Email delivery restricted: \${payload.to} is not verified in AWS SES Sandbox Mode. Production access required to email non-verified addresses.\` };
    }
    console.error('[managed/email] SES error:', msg);
    return { ok: false, reason: msg };
  }
}

// ─── Resend fallback ──────────────────────────────────────────────────────────
async function sendViaResend(payload: EmailPayload, displayName: string): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return false;
  try {
    const { Resend } = await import('resend');
    const from = process.env.DWOMOH_SES_FROM_EMAIL || process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
    const r = new Resend(apiKey);
    const result = await r.emails.send({ from: \`\${displayName} <\${from}>\`, to: payload.to, subject: payload.subject, html: payload.html });
    if (result.error) { console.error('[managed/email] Resend error:', result.error); return false; }
    return true;
  } catch (e) {
    console.error('[managed/email] Resend error:', e instanceof Error ? e.message : e);
    return false;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function sendEmail(payload: EmailPayload): Promise<EmailResult> {
  const sesResult = await sendViaSES(payload, APP_NAME);
  if (sesResult.ok) return { delivered: true, provider: 'ses' };

  // If SES is configured but sandbox-blocked, skip Resend (same credentials issue) and report clearly
  if (sesResult.sandboxBlocked) {
    return { delivered: false, provider: 'ses', sandboxBlocked: true, reason: sesResult.reason };
  }

  if (await sendViaResend(payload, APP_NAME)) return { delivered: true, provider: 'resend' };
  const preview = \`To: \${payload.to}\\nSubject: \${payload.subject}\\n\`;
  console.log(\`\\n[MANAGED EMAIL — DEV MODE]\\n\${preview}Configure DWOMOH_SES_FROM_EMAIL + AWS keys in .env.local for real delivery.\\n\`);
  return { delivered: false, provider: 'console', reason: sesResult.reason };
}

export async function sendVerificationEmail(
  email: string,
  otp: string,
  appName = APP_NAME,
  appColor = APP_COLOR,
): Promise<EmailResult> {
  return sendEmail({
    to: email,
    subject: \`\${appName} — Verify your email\`,
    html: buildEmailHtml({
      appName,
      appColor,
      title: 'Verify your email address',
      body: 'Enter the code below to activate your account. It expires in 60 minutes.',
      otp,
      otpLabel: 'Your verification code',
    }),
    text: \`Your \${appName} verification code is: \${otp}\\nExpires in 60 minutes.\`,
  });
}

export async function sendPasswordResetEmail(
  email: string,
  otp: string,
  appName = APP_NAME,
  appColor = '#dc2626',
): Promise<EmailResult> {
  return sendEmail({
    to: email,
    subject: \`\${appName} — Password reset code\`,
    html: buildEmailHtml({
      appName,
      appColor,
      title: 'Reset your password',
      body: 'Use the code below to reset your password. It expires in 15 minutes.',
      otp,
      otpLabel: 'Your reset code',
      footer: 'If you did not request a password reset, you can safely ignore this email.',
    }),
    text: \`Your \${appName} password reset code is: \${otp}\\nExpires in 15 minutes.\`,
  });
}

export async function sendWelcomeEmail(
  email: string,
  name: string,
  appName = APP_NAME,
  appColor = APP_COLOR,
): Promise<EmailResult> {
  return sendEmail({
    to: email,
    subject: \`Welcome to \${appName}!\`,
    html: buildEmailHtml({
      appName,
      appColor,
      title: \`Welcome, \${name || 'there'}!\`,
      body: \`Your account on <strong>\${appName}</strong> has been created successfully. You can now sign in and start using all features.\`,
    }),
    text: \`Welcome to \${appName}! Your account has been created. You can now sign in.\`,
  });
}

export async function sendNotificationEmail(
  email: string,
  subject: string,
  message: string,
  appName = APP_NAME,
  appColor = APP_COLOR,
): Promise<EmailResult> {
  return sendEmail({
    to: email,
    subject: \`[\${appName}] \${subject}\`,
    html: buildEmailHtml({ appName, appColor, title: subject, body: message }),
    text: message,
  });
}
`;

const MANAGED_STORAGE_TS = `// File storage managed service.
// Default: saves files to public/uploads/ (accessible at /uploads/filename).
// With AWS credentials (DWOMOH_AWS_ACCESS_KEY_ID + DWOMOH_S3_BUCKET): uploads to S3.

import { join, extname } from 'path';
import crypto from 'crypto';

function safeFilename(original: string): string {
  const ext = extname(original) || '.bin';
  const rand = crypto.randomBytes(12).toString('hex');
  return \`\${Date.now()}-\${rand}\${ext}\`;
}

async function uploadToS3(buffer: Buffer, filename: string, mimeType: string): Promise<string | null> {
  const key = process.env.DWOMOH_AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
  const secret = process.env.DWOMOH_AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
  const region = process.env.DWOMOH_AWS_REGION || process.env.AWS_REGION || 'us-east-1';
  const bucket = process.env.DWOMOH_S3_BUCKET;
  if (!key || !secret || !bucket) return null;
  try {
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const s3 = new S3Client({ region, credentials: { accessKeyId: key, secretAccessKey: secret } });
    const s3Key = \`uploads/\${filename}\`;
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: s3Key, Body: buffer, ContentType: mimeType }));
    return \`https://\${bucket}.s3.\${region}.amazonaws.com/\${s3Key}\`;
  } catch (e) {
    console.error('[managed/storage] S3 upload error:', e);
    return null;
  }
}

async function uploadToLocal(buffer: Buffer, filename: string): Promise<string> {
  const { mkdir, writeFile } = await import('fs/promises');
  const uploadsDir = join(process.cwd(), 'public', 'uploads');
  await mkdir(uploadsDir, { recursive: true });
  await writeFile(join(uploadsDir, filename), buffer);
  return \`/uploads/\${filename}\`;
}

export async function uploadFile(buffer: Buffer, originalFilename: string, mimeType: string): Promise<{ url: string; filename: string; size: number }> {
  const filename = safeFilename(originalFilename);
  const s3Url = await uploadToS3(buffer, filename, mimeType);
  const url = s3Url || await uploadToLocal(buffer, filename);
  return { url, filename, size: buffer.length };
}

export async function uploadFromRequest(request: Request, fieldName = 'file'): Promise<{ url: string; filename: string; size: number; mimeType: string } | null> {
  try {
    const form = await request.formData();
    const file = form.get(fieldName) as File | null;
    if (!file) return null;
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await uploadFile(buffer, file.name, file.type);
    return { ...result, mimeType: file.type };
  } catch {
    return null;
  }
}

export async function deleteFile(urlOrFilename: string): Promise<void> {
  const filename = urlOrFilename.includes('/') ? urlOrFilename.split('/').pop()! : urlOrFilename;
  const key = process.env.DWOMOH_AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
  const secret = process.env.DWOMOH_AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
  const bucket = process.env.DWOMOH_S3_BUCKET;
  if (key && secret && bucket) {
    try {
      const { S3Client, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
      const region = process.env.DWOMOH_AWS_REGION || 'us-east-1';
      const s3 = new S3Client({ region, credentials: { accessKeyId: key, secretAccessKey: secret } });
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: \`uploads/\${filename}\` }));
    } catch { /* ignore */ }
  } else {
    try {
      const { unlink } = await import('fs/promises');
      await unlink(join(process.cwd(), 'public', 'uploads', filename));
    } catch { /* ignore */ }
  }
}
`;

const MANAGED_QR_TS = `// QR code generation — pure JavaScript, zero configuration required.
// Returns data URLs (base64 PNG) or SVG strings ready to embed in HTML.

export async function generateQRDataURL(data: string, size = 256): Promise<string> {
  const QRCode = await import('qrcode');
  return QRCode.default.toDataURL(data, { width: size, margin: 1 });
}

export async function generateQRBuffer(data: string, size = 512): Promise<Buffer> {
  const QRCode = await import('qrcode');
  return QRCode.default.toBuffer(data, { width: size, margin: 1 });
}

export async function generateQRSVG(data: string): Promise<string> {
  const QRCode = await import('qrcode');
  return QRCode.default.toString(data, { type: 'svg' });
}

// Convenience: generate a QR code and return it as a base64 src for <img>
export async function qrImageSrc(data: string, size = 256): Promise<string> {
  return generateQRDataURL(data, size);
}
`;

const MANAGED_PACKAGE_PATCH = (pkg: Record<string, unknown>): Record<string, unknown> => {
  const deps = (pkg.dependencies || {}) as Record<string, string>;
  const devDeps = (pkg.devDependencies || {}) as Record<string, string>;
  return {
    ...pkg,
    dependencies: {
      ...deps,
      'better-sqlite3': 'latest',   // 'latest' required for Node v22+ arm64 binary support
      'bcryptjs': '^2.4.3',
      'jose': '^5.9.3',
      'qrcode': '^1.5.4',
      '@aws-sdk/client-ses': '^3.0.0',
      '@aws-sdk/client-s3': '^3.0.0',
      'resend': '^4.0.0',
    },
    devDependencies: {
      ...devDeps,
      '@types/better-sqlite3': '^7.6.11',
      '@types/bcryptjs': '^2.4.6',
      '@types/qrcode': '^1.5.5',
    },
  };
};

// Convert a slug like 'gatepass-ghana' → 'GatePass Ghana'
function slugToDisplayName(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Pick a professional brand color deterministically from the project name
function slugToBrandColor(slug: string): string {
  const palette = [
    '#1e40af', // blue
    '#065f46', // emerald
    '#7c3aed', // violet
    '#b45309', // amber
    '#be123c', // rose
    '#0e7490', // cyan
    '#4338ca', // indigo
    '#059669', // green
    '#9333ea', // purple
    '#0369a1', // sky
  ];
  let hash = 0;
  for (let i = 0; i < slug.length; i++) hash = (hash * 31 + slug.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length];
}

async function injectManagedServices(baseDir: string, files: ProjectFile[], logs: string[], projectName?: string): Promise<void> {
  const libManagedDir = join(baseDir, 'lib', 'managed');
  await mkdir(libManagedDir, { recursive: true });

  const managedFiles: Array<[string, string]> = [
    ['db.ts', MANAGED_DB_TS],
    ['auth.ts', MANAGED_AUTH_TS],
    ['email.ts', MANAGED_EMAIL_TS],
    ['storage.ts', MANAGED_STORAGE_TS],
    ['qr.ts', MANAGED_QR_TS],
  ];

  for (const [name, content] of managedFiles) {
    const filePath = join(libManagedDir, name);
    await writeFile(filePath, content, 'utf-8');
  }

  // Patch package.json with managed service dependencies
  const pkgPath = join(baseDir, 'package.json');
  try {
    const { readFile } = await import('fs/promises');
    const raw = await readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw);
    const patched = MANAGED_PACKAGE_PATCH(pkg);
    await writeFile(pkgPath, JSON.stringify(patched, null, 2), 'utf-8');
  } catch {
    // package.json not yet written — enrichPackageJson handles it
  }

  const fileExists = async (p: string): Promise<boolean> => {
    try { await (await import('fs/promises')).access(p); return true; } catch { return false; }
  };

  // Ensure .gitignore protects credentials and local state
  const gitignorePath = join(baseDir, '.gitignore');
  if (!(await fileExists(gitignorePath))) {
    await writeFile(gitignorePath, [
      '/node_modules', '/.next/', '/out/', '/build',
      '# Local env files — NEVER commit (contain AWS keys, JWT secrets)',
      '.env', '.env.local', '.env*.local',
      '# SQLite database files',
      '/data/*.db', '/data/*.db-shm', '/data/*.db-wal', 'project.db', '*.db',
      'npm-debug.log*', '.DS_Store', 'next-env.d.ts',
    ].join('\n'), 'utf-8');
  }

  // Derive app display name and brand color from the project slug
  const slug = projectName || require('path').basename(baseDir);
  const appDisplayName = slugToDisplayName(slug);
  const appBrandColor = slugToBrandColor(slug);

  // Forward DWOMOH platform credentials to the generated app so email works immediately,
  // without the user needing to configure SES separately for every project.
  const dwomohKey    = process.env.DWOMOH_AWS_ACCESS_KEY_ID    || process.env.AWS_ACCESS_KEY_ID    || '';
  const dwomohSecret = process.env.DWOMOH_AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || '';
  const dwomohFrom   = process.env.DWOMOH_SES_FROM_EMAIL        || process.env.SES_FROM_EMAIL        || '';
  const dwomohRegion = process.env.DWOMOH_AWS_REGION            || process.env.AWS_REGION            || 'us-east-1';
  const dwomohBucket = process.env.DWOMOH_S3_BUCKET             || process.env.S3_BUCKET             || '';
  const hasDwomohCreds = !!(dwomohKey && dwomohSecret && dwomohFrom);
  const rapidApiKey  = process.env.RAPIDAPI_KEY || '';

  // Write .env.local (gitignored, never committed)
  const envPath = join(baseDir, '.env.local');
  if (!(await fileExists(envPath))) {
    const crypto = await import('crypto');
    const jwtSecret = crypto.randomBytes(32).toString('hex');

    const lines: string[] = [
      '# DWOMOH Managed Services — auto-generated, gitignored, never committed',
      '',
      `# App identity — read by lib/managed/email.ts for branded email templates`,
      `NEXT_PUBLIC_APP_NAME=${appDisplayName}`,
      `NEXT_PUBLIC_APP_COLOR=${appBrandColor}`,
      '',
      `MANAGED_JWT_SECRET=${jwtSecret}`,
      '',
    ];

    if (hasDwomohCreds) {
      // DWOMOH platform credentials forwarded — real email delivery enabled immediately
      lines.push('# AWS SES — DWOMOH shared sender (real email delivery, no per-app setup required)');
      lines.push(`DWOMOH_AWS_ACCESS_KEY_ID=${dwomohKey}`);
      lines.push(`DWOMOH_AWS_SECRET_ACCESS_KEY=${dwomohSecret}`);
      lines.push(`DWOMOH_AWS_REGION=${dwomohRegion}`);
      lines.push(`DWOMOH_SES_FROM_EMAIL=${dwomohFrom}`);
      if (dwomohBucket) {
        lines.push('');
        lines.push(`DWOMOH_S3_BUCKET=${dwomohBucket}`);
      }
      logs.push('📧 DWOMOH SES credentials forwarded — real email delivery active immediately');
    } else {
      // No platform credentials available — scaffold commented-out vars
      lines.push('# AWS SES — real email delivery (fill in to enable)');
      lines.push('# DWOMOH_AWS_ACCESS_KEY_ID=');
      lines.push('# DWOMOH_AWS_SECRET_ACCESS_KEY=');
      lines.push(`# DWOMOH_AWS_REGION=${dwomohRegion}`);
      lines.push('# DWOMOH_SES_FROM_EMAIL=');
      lines.push('');
      lines.push('# Resend — alternative (free: 3,000 emails/month)');
      lines.push('# RESEND_API_KEY=');
    }

    // RapidAPI — forward platform key so generated apps can call external APIs immediately
    if (rapidApiKey && rapidApiKey !== 'PASTE_MY_X_RAPIDAPI_KEY_HERE') {
      lines.push('');
      lines.push('# RapidAPI — platform-managed key (forwarded by DWOMOH Vibe Code)');
      lines.push('# Used by /api/integrations/* routes for external API calls — server-side only');
      lines.push(`RAPIDAPI_KEY=${rapidApiKey}`);
      logs.push('🌐 RapidAPI key forwarded — external API integrations active');
    } else {
      lines.push('');
      lines.push('# RapidAPI — add your key to enable TikTok download, weather, music, sports, etc.');
      lines.push('# RAPIDAPI_KEY=');
    }

    // DWOMOH API Manager — proxy routing so generated apps can call the platform without exposing keys
    const platformPort = process.env.PORT || '3000';
    lines.push('');
    lines.push('# DWOMOH API Manager — all external API calls go through the platform proxy');
    lines.push(`DWOMOH_PLATFORM_URL=http://localhost:${platformPort}`);
    lines.push(`DWOMOH_PROJECT_ID=${slug}`);
    logs.push('🔗 DWOMOH API Manager proxy configured — platform manages all external API keys');

    await writeFile(envPath, lines.join('\n'), 'utf-8');
  }

  logs.push('🔌 Injected DWOMOH Managed Services (db, auth, email, storage, qr)');
}

/**
 * Result from project generation
 */
export interface GenerateProjectResult {
  projectPath: string;
  projectName: string;
  foldersCreated: number;
  filesCreated: number;
  logs: string[];
}

/**
 * Create project directory structure and files
 */
export async function generateProject(
  projectName: string,
  files: ProjectFile[]
): Promise<GenerateProjectResult> {
  const logs: string[] = [];

  try {
    logs.push(LOG_MESSAGES.CREATING_FOLDERS);

    // Validate project name
    if (!projectName || typeof projectName !== 'string') {
      throw createError(
        ErrorCode.INVALID_PROJECT_NAME,
        'Invalid project name'
      );
    }

    const baseDir = join(
      process.cwd(),
      PROJECT_CONFIG.GENERATED_PROJECTS_DIR,
      projectName
    );

    logs.push(`📂 Project directory: ${baseDir}`);

    const createdPaths = new Set<string>();
    let foldersCreated = 0;
    let filesCreated = 0;

    // Process each file
    for (const file of files) {
      if (!file.path || file.content === undefined) {
        logs.push(`⚠️ Skipping invalid file: ${file.path}`);
        continue;
      }

      const filePath = join(baseDir, file.path);
      const dirPath = filePath.substring(0, filePath.lastIndexOf('/'));

      // Create directory if needed
      if (!createdPaths.has(dirPath)) {
        try {
          await mkdir(dirPath, { recursive: true });
          foldersCreated++;
          createdPaths.add(dirPath);
          logs.push(`✓ Created folder: ${dirPath.replace(baseDir, '')}`);
        } catch (error) {
          logError(`Failed to create directory ${dirPath}`, error);
          throw createError(
            ErrorCode.FILE_CREATE_ERROR,
            `Failed to create directory: ${dirPath}`
          );
        }
      }

      // Write file
      try {
        // Convert content to string if needed
        let content = file.content;
        if (typeof content === 'object') {
          content = JSON.stringify(content, null, 2);
        }

        await writeFile(filePath, content, 'utf-8');
        filesCreated++;
        logs.push(`✓ Created file: ${file.path}`);
      } catch (error) {
        logError(`Failed to write file ${filePath}`, error);
        throw createError(
          ErrorCode.FILE_WRITE_ERROR,
          `Failed to write file: ${file.path}`
        );
      }
    }

    logs.push(LOG_MESSAGES.WRITING_FILES);

    // Inject DWOMOH Managed Services into every project (db, auth, email, storage, qr)
    await injectManagedServices(baseDir, files, logs, projectName);

    // Scan imports and patch package.json with any missing known dependencies
    await enrichPackageJson(baseDir, files, logs);

    // Post-process generated files to fix common AI generation bugs
    await patchPageFile(baseDir, files, logs);
    await patchTsconfig(baseDir, files, logs);
    await ensureNextConfig(baseDir, files, logs);

    logs.push(`✅ Project created with ${filesCreated} files in ${foldersCreated} folders`);

    return {
      projectPath: baseDir,
      projectName,
      foldersCreated,
      filesCreated,
      logs,
    };
  } catch (error) {
    logError('Project generation failed', error);

    if (error instanceof Error && 'code' in error) {
      throw error;
    }

    throw createError(
      ErrorCode.PROJECT_CREATE_ERROR,
      'Failed to generate project',
      500,
      error
    );
  }
}

/**
 * Validate generated files
 */
export function validateFiles(files: ProjectFile[]): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const requiredFiles = ['package.json', 'app/layout.tsx', 'app/page.tsx'];
  const filePaths = files.map(f => f.path);

  // Check for required files
  for (const required of requiredFiles) {
    if (!filePaths.includes(required)) {
      errors.push(`Missing required file: ${required}`);
    }
  }

  // Check each file
  files.forEach((file, index) => {
    if (!file.path) {
      errors.push(`File ${index}: missing path`);
    }
    if (file.content === undefined || file.content === null) {
      errors.push(`File ${file.path}: missing content`);
    }
  });

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Get project path
 */
export function getProjectPath(projectName: string): string {
  return join(process.cwd(), PROJECT_CONFIG.GENERATED_PROJECTS_DIR, projectName);
}

/**
 * Check if project exists
 */
export async function projectExists(projectName: string): Promise<boolean> {
  try {
    const fs = await import('fs/promises');
    const path = getProjectPath(projectName);
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate .env.local template
 */
export function generateEnvTemplate(): string {
  return `# Environment Variables — DWOMOH Managed Backend
# The app works immediately without filling in anything here.
# Add credentials below to enable real email, S3 storage, and production auth.

# App name shown in emails and UI
NEXT_PUBLIC_APP_NAME=My App

# ─── Auth (auto-generated secret — change before deploying to production) ───
MANAGED_JWT_SECRET=dwomoh-local-dev-secret-${Date.now()}

# ─── Email (optional — without these, OTPs are logged to the terminal) ───────
# DWOMOH_SES_FROM_EMAIL=noreply@yourdomain.com
# DWOMOH_AWS_ACCESS_KEY_ID=
# DWOMOH_AWS_SECRET_ACCESS_KEY=
# DWOMOH_AWS_REGION=us-east-1

# ─── File Storage (optional — without these, files save to public/uploads/) ──
# DWOMOH_S3_BUCKET=your-s3-bucket-name

# ─── External APIs (add only what your app uses) ──────────────────────────────
# GOOGLE_MAPS_API_KEY=
# OPENAI_API_KEY=
# PAYSTACK_SECRET_KEY=
# STRIPE_SECRET_KEY=
`;
}

/**
 * Ensure file has content
 */
export function ensureFileContent(file: ProjectFile): ProjectFile {
  return {
    path: file.path,
    content: file.content || '',
  };
}

/**
 * Add env file to project if not present
 */
export function addEnvFileIfMissing(files: ProjectFile[]): ProjectFile[] {
  const hasEnv = files.some(f => f.path === '.env.local');

  if (!hasEnv) {
    files.push({
      path: '.env.local',
      content: generateEnvTemplate(),
    });
  }

  return files;
}

/**
 * Add gitignore if not present
 */
export function addGitignoreIfMissing(files: ProjectFile[]): ProjectFile[] {
  const hasGitignore = files.some(f => f.path === '.gitignore');

  if (!hasGitignore) {
    files.push({
      path: '.gitignore',
      content: `# Next.js
.next/
out/
build/

# Dependencies
node_modules/
.pnp
.pnp.js

# Env
.env
.env.local
.env.development.local
.env.test.local
.env.production.local

# Misc
.DS_Store
*.pem

# Debug
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# IDE
.vscode/
.idea/
*.swp
*.swo`,
    });
  }

  return files;
}

/**
 * Prepare files for generation
 */
export function prepareFilesForGeneration(files: ProjectFile[]): ProjectFile[] {
  let prepared = files.map(ensureFileContent);
  prepared = addEnvFileIfMissing(prepared);
  prepared = addGitignoreIfMissing(prepared);
  return prepared;
}