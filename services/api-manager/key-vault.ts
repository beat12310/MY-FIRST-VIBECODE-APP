/**
 * Key Vault — server-side only
 *
 * Single source of truth for all external API credentials.
 * Keys are read from process.env (populated from .env.local).
 * They are NEVER written to disk, logged, or returned to the browser.
 */

export type ProviderId =
  | 'rapidapi'
  | 'openai'
  | 'stripe'
  | 'paystack'
  | 'twilio'
  | 'aws'
  | 'supabase'
  | 'google'
  | 'resend';

export interface ProviderKeyConfig {
  id: ProviderId;
  name: string;
  category: string;
  /** The primary env var name (shown in docs, never the value) */
  primaryEnvVar: string;
  /** Additional env vars that must also be set */
  requiredEnvVars?: string[];
  /** Documentation URL for getting a key */
  docsUrl: string;
  /** Short description of what this provider enables */
  description: string;
  isConfigured: boolean;
  /** First 8 chars + "…" — safe to send to browser */
  maskedKey?: string;
}

const PROVIDER_DEFS: Omit<ProviderKeyConfig, 'isConfigured' | 'maskedKey'>[] = [
  {
    id: 'rapidapi',
    name: 'RapidAPI',
    category: 'External APIs',
    primaryEnvVar: 'RAPIDAPI_KEY',
    docsUrl: 'https://rapidapi.com/developer/apps',
    description: 'TikTok downloader, weather, music, sports, currency, news, and 40,000+ APIs',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    category: 'AI',
    primaryEnvVar: 'OPENAI_API_KEY',
    docsUrl: 'https://platform.openai.com/api-keys',
    description: 'GPT-4, DALL·E, Whisper, embeddings',
  },
  {
    id: 'stripe',
    name: 'Stripe',
    category: 'Payments',
    primaryEnvVar: 'STRIPE_SECRET_KEY',
    docsUrl: 'https://dashboard.stripe.com/apikeys',
    description: 'Card payments, subscriptions, invoices',
  },
  {
    id: 'paystack',
    name: 'Paystack',
    category: 'Payments',
    primaryEnvVar: 'PAYSTACK_SECRET_KEY',
    docsUrl: 'https://dashboard.paystack.com/#/settings/developer',
    description: 'Payments for Africa — cards, bank transfer, USSD, mobile money',
  },
  {
    id: 'twilio',
    name: 'Twilio',
    category: 'Communications',
    primaryEnvVar: 'TWILIO_AUTH_TOKEN',
    requiredEnvVars: ['TWILIO_ACCOUNT_SID'],
    docsUrl: 'https://console.twilio.com/us1/account/keys-credentials/api-keys',
    description: 'SMS, WhatsApp, voice calls, email',
  },
  {
    id: 'aws',
    name: 'AWS',
    category: 'Cloud',
    primaryEnvVar: 'AWS_ACCESS_KEY_ID',
    requiredEnvVars: ['AWS_SECRET_ACCESS_KEY'],
    docsUrl: 'https://console.aws.amazon.com/iam/home#/security_credentials',
    description: 'S3, SES, Cognito, Bedrock, Lambda — already configured',
  },
  {
    id: 'supabase',
    name: 'Supabase',
    category: 'Database / Auth',
    primaryEnvVar: 'SUPABASE_SERVICE_ROLE_KEY',
    requiredEnvVars: ['NEXT_PUBLIC_SUPABASE_URL'],
    docsUrl: 'https://supabase.com/dashboard/project/_/settings/api',
    description: 'Postgres database, auth, storage, realtime',
  },
  {
    id: 'google',
    name: 'Google',
    category: 'Maps / AI',
    primaryEnvVar: 'GOOGLE_API_KEY',
    docsUrl: 'https://console.cloud.google.com/apis/credentials',
    description: 'Maps, Places, Gemini AI, YouTube, Gmail',
  },
  {
    id: 'resend',
    name: 'Resend',
    category: 'Email',
    primaryEnvVar: 'RESEND_API_KEY',
    docsUrl: 'https://resend.com/api-keys',
    description: 'Transactional email — 3,000 free emails/month',
  },
];

function read(envVar: string): string {
  return process.env[envVar] || '';
}

function isLiveKey(val: string): boolean {
  return val.length > 8 && !val.startsWith('PASTE_') && !val.startsWith('your_') && !val.startsWith('sk_test_placeholder');
}

function masked(envVar: string): string | undefined {
  const val = read(envVar);
  return isLiveKey(val) ? `${val.slice(0, 8)}…` : undefined;
}

/** Returns all provider configurations — safe to send to the browser (no key values). */
export function getAllProviders(): ProviderKeyConfig[] {
  return PROVIDER_DEFS.map(def => {
    const primary = read(def.primaryEnvVar);
    const allRequired = [def.primaryEnvVar, ...(def.requiredEnvVars ?? [])];
    const isConfigured = allRequired.every(v => isLiveKey(read(v)));
    return {
      ...def,
      isConfigured,
      maskedKey: isConfigured ? masked(def.primaryEnvVar) : undefined,
    };
  });
}

/** Get a live key value — server-side ONLY. Never call this in a response body. */
export function getKey(envVar: string): string {
  const val = read(envVar);
  return isLiveKey(val) ? val : '';
}

/** Returns the RAPIDAPI_KEY if configured, empty string otherwise. */
export function getRapidApiKey(): string {
  return getKey('RAPIDAPI_KEY');
}

/** True if this provider has all required keys set. */
export function isProviderConfigured(id: ProviderId): boolean {
  const def = PROVIDER_DEFS.find(d => d.id === id);
  if (!def) return false;
  const vars = [def.primaryEnvVar, ...(def.requiredEnvVars ?? [])];
  return vars.every(v => isLiveKey(read(v)));
}

/** Get key for a specific provider — server-side only. */
export function getProviderKey(id: ProviderId): string {
  const def = PROVIDER_DEFS.find(d => d.id === id);
  return def ? getKey(def.primaryEnvVar) : '';
}

/** All env var names that should be forwarded to generated apps (never the values here). */
export const FORWARD_ENV_VARS: Array<{ envVar: string; comment: string }> = [
  { envVar: 'RAPIDAPI_KEY', comment: 'RapidAPI — external APIs (weather, TikTok, sports, music, news…)' },
  { envVar: 'STRIPE_SECRET_KEY', comment: 'Stripe — card payments' },
  { envVar: 'PAYSTACK_SECRET_KEY', comment: 'Paystack — Africa payments' },
  { envVar: 'TWILIO_AUTH_TOKEN', comment: 'Twilio — SMS / WhatsApp' },
  { envVar: 'TWILIO_ACCOUNT_SID', comment: 'Twilio — account SID' },
  { envVar: 'OPENAI_API_KEY', comment: 'OpenAI — GPT-4, DALL·E, Whisper' },
  { envVar: 'GOOGLE_API_KEY', comment: 'Google — Maps, Places, Gemini' },
  { envVar: 'SUPABASE_SERVICE_ROLE_KEY', comment: 'Supabase — database / auth' },
  { envVar: 'NEXT_PUBLIC_SUPABASE_URL', comment: 'Supabase — project URL' },
  { envVar: 'RESEND_API_KEY', comment: 'Resend — transactional email' },
];
