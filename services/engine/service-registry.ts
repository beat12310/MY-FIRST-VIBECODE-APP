/**
 * DWOMOH VIBE CODE — Service Capability Registry (DATA ONLY).
 *
 * Single source of truth for which providers fulfil each capability, how they are
 * reached, their priority/failover/health/quota/config, the pinned API version,
 * and a CONFIGURABLE pricing key. PURE DATA — no network, no logic, no side
 * effects. Nothing imports this yet.
 *
 * Design intent (future wiring, not implemented here):
 *  - Generated apps NEVER receive secrets. They call a platform proxy
 *    (/api/services/<capability>); the platform attaches the key server-side.
 *  - Pricing is resolved at runtime from external config via `pricing.configKey`
 *    (DB / Parameter Store / env); `defaultCredits` is only a fallback.
 *  - Providers carry priority + fallback + health + quota so the orchestrator can
 *    fail over automatically when one is down or over quota.
 *  - Each provider is pinned to a `version` so projects don't break on API changes.
 */
import type {
  CapabilityId, ProviderMode, ProviderHealth, NotificationChannel, CreditPricing,
} from './types';

export interface ProviderQuota {
  monthlyCallLimit?: number;
  rateLimitPerMinute?: number;
  notes?: string;
}

export interface RegistryProvider {
  name: string;
  mode: ProviderMode;
  /** Lower = preferred. Used for selection + automatic failover order. */
  priority: number;
  /** Provider to fail over to when this one is down / over quota. */
  fallbackProvider?: string;
  /** Declared health; live status is resolved at runtime. */
  healthStatus: ProviderHealth;
  quota?: ProviderQuota;
  /** Settings/env vars required (server-side) before this provider is usable. */
  configRequirements: string[];
  /** Pinned provider API version (capability versioning). */
  version: string;
  notes?: string;
}

/** A single delivery channel for the first-class Notifications capability. */
export interface NotificationChannelConfig {
  channel: NotificationChannel;
  defaultProvider: string;
  providers: RegistryProvider[];
}

export interface CapabilityEntry {
  id: CapabilityId;
  label: string;
  /** Registry schema/version for this capability entry. */
  version: string;
  /** Default provider name (must exist in `providers`). */
  defaultProvider: string;
  providers: RegistryProvider[];
  /** Configurable pricing — resolved from external config at runtime. */
  pricing: CreditPricing;
  /** Proxy path generated apps will call (wiring comes later). */
  proxyPath: string;
  /** Prompt signals that imply this capability is needed. */
  detectSignals: string[];
  /** For multi-channel capabilities (notifications). */
  channels?: NotificationChannelConfig[];
}

export const SERVICE_REGISTRY: Record<CapabilityId, CapabilityEntry> = {
  payments: {
    id: 'payments', label: 'Payments & Checkout', version: '1.0.0', defaultProvider: 'paystack',
    pricing: { configKey: 'pricing.payments', defaultCredits: 0, unit: 'per_call' }, proxyPath: '/api/services/payments',
    detectSignals: ['pay', 'checkout', 'subscription', 'invoice', 'cart', 'order', 'sell', 'price'],
    providers: [
      { name: 'paystack', mode: 'platform', priority: 1, fallbackProvider: 'stripe', healthStatus: 'healthy', configRequirements: ['PAYSTACK_SECRET_KEY'], version: 'v1', notes: 'Africa-first: card, MoMo, bank' },
      { name: 'stripe', mode: 'byok', priority: 2, healthStatus: 'unknown', configRequirements: ['STRIPE_SECRET_KEY'], version: '2024-06-20', notes: 'Global cards (BYO)' },
    ],
  },
  auth: {
    id: 'auth', label: 'Authentication', version: '1.0.0', defaultProvider: 'cognito',
    pricing: { configKey: 'pricing.auth', defaultCredits: 0, unit: 'per_call' }, proxyPath: '/api/services/auth',
    detectSignals: ['login', 'signup', 'register', 'account', 'user', 'auth', 'sign in'],
    providers: [
      { name: 'cognito', mode: 'platform', priority: 1, fallbackProvider: 'managed-jwt', healthStatus: 'healthy', configRequirements: ['NEXT_PUBLIC_USER_POOL_ID'], version: 'v1', notes: 'Platform Cognito' },
      { name: 'managed-jwt', mode: 'platform', priority: 2, healthStatus: 'healthy', configRequirements: ['MANAGED_JWT_SECRET'], version: 'v1', notes: 'Injected JWT scaffold for generated apps' },
    ],
  },
  database: {
    id: 'database', label: 'Database', version: '1.0.0', defaultProvider: 'dynamodb',
    pricing: { configKey: 'pricing.database', defaultCredits: 0, unit: 'per_call' }, proxyPath: '/api/services/db',
    detectSignals: ['data', 'store', 'records', 'crud', 'persist', 'list', 'save'],
    providers: [
      { name: 'dynamodb', mode: 'platform', priority: 1, fallbackProvider: 'sqlite', healthStatus: 'healthy', configRequirements: ['BILLING_TABLE'], version: '2012-08-10', notes: 'Platform DynamoDB (per-app namespacing)' },
      { name: 'sqlite', mode: 'platform', priority: 2, healthStatus: 'healthy', configRequirements: [], version: '3', notes: 'Injected local DB for simple generated apps' },
      { name: 'supabase', mode: 'byok', priority: 3, healthStatus: 'unknown', configRequirements: ['SUPABASE_URL', 'SUPABASE_KEY'], version: 'v1', notes: 'BYO relational option' },
    ],
  },
  email: {
    id: 'email', label: 'Email', version: '1.0.0', defaultProvider: 'ses',
    pricing: { configKey: 'pricing.email', defaultCredits: 1, unit: 'per_call' }, proxyPath: '/api/services/email',
    detectSignals: ['email', 'newsletter', 'contact form', 'notify', 'confirmation'],
    providers: [
      { name: 'ses', mode: 'platform', priority: 1, fallbackProvider: 'resend', healthStatus: 'healthy', quota: { rateLimitPerMinute: 14 }, configRequirements: ['DWOMOH_SES_FROM_EMAIL'], version: 'v2', notes: 'AWS SES' },
      { name: 'resend', mode: 'byok', priority: 2, healthStatus: 'unknown', configRequirements: ['RESEND_API_KEY'], version: 'v1', notes: 'Fallback / BYO' },
    ],
  },
  sms: {
    id: 'sms', label: 'SMS & OTP', version: '1.0.0', defaultProvider: 'termii',
    pricing: { configKey: 'pricing.sms', defaultCredits: 2, unit: 'per_call' }, proxyPath: '/api/services/sms',
    detectSignals: ['sms', 'otp', 'verify phone', 'text message', 'one-time code', 'phone verification'],
    providers: [
      { name: 'termii', mode: 'platform', priority: 1, fallbackProvider: 'hubtel', healthStatus: 'unknown', configRequirements: ['TERMII_API_KEY'], version: 'v1', notes: 'Africa-first (needs setup)' },
      { name: 'hubtel', mode: 'platform', priority: 2, fallbackProvider: 'twilio', healthStatus: 'unknown', configRequirements: ['HUBTEL_CLIENT_ID', 'HUBTEL_CLIENT_SECRET'], version: 'v1', notes: 'Ghana (needs setup)' },
      { name: 'africas_talking', mode: 'byok', priority: 3, healthStatus: 'unknown', configRequirements: ['AT_API_KEY', 'AT_USERNAME'], version: 'v1' },
      { name: 'twilio', mode: 'byok', priority: 4, healthStatus: 'unknown', configRequirements: ['TWILIO_SID', 'TWILIO_TOKEN'], version: '2010-04-01', notes: 'Global fallback' },
    ],
  },
  maps: {
    id: 'maps', label: 'Maps & Location', version: '1.0.0', defaultProvider: 'mapbox',
    pricing: { configKey: 'pricing.maps', defaultCredits: 1, unit: 'per_call' }, proxyPath: '/api/services/maps',
    detectSignals: ['map', 'location', 'directions', 'nearby', 'geocode', 'address', 'delivery area'],
    providers: [
      { name: 'mapbox', mode: 'platform', priority: 1, fallbackProvider: 'google_maps', healthStatus: 'unknown', configRequirements: ['MAPBOX_TOKEN'], version: 'v1', notes: 'Predictable pricing (needs setup)' },
      { name: 'google_maps', mode: 'byok', priority: 2, healthStatus: 'unknown', configRequirements: ['GOOGLE_MAPS_KEY'], version: 'v1' },
    ],
  },
  seo: {
    id: 'seo', label: 'SEO (sitemap/schema/metadata/robots)', version: '1.0.0', defaultProvider: 'builtin',
    pricing: { configKey: 'pricing.seo', defaultCredits: 0, unit: 'per_call' }, proxyPath: '/api/services/seo',
    detectSignals: ['seo', 'sitemap', 'metadata', 'search engine', 'ranking', 'schema', 'og tags'],
    providers: [
      { name: 'builtin', mode: 'platform', priority: 1, healthStatus: 'healthy', configRequirements: [], version: '1.0.0', notes: 'Generated locally — no external vendor' },
    ],
  },
  ai_text: {
    id: 'ai_text', label: 'AI Text', version: '1.0.0', defaultProvider: 'bedrock',
    pricing: { configKey: 'pricing.ai_text', defaultCredits: 3, unit: 'per_1k_tokens' }, proxyPath: '/api/services/ai-text',
    detectSignals: ['ai', 'chatbot', 'assistant', 'summarize', 'generate text', 'gpt', 'write'],
    providers: [
      { name: 'bedrock', mode: 'platform', priority: 1, healthStatus: 'healthy', configRequirements: ['BEDROCK_MODEL_ID', 'AWS_REGION'], version: 'bedrock-2023-05-31', notes: 'Claude on Bedrock' },
    ],
  },
  ai_image: {
    id: 'ai_image', label: 'AI Image', version: '1.0.0', defaultProvider: 'bedrock_image',
    pricing: { configKey: 'pricing.ai_image', defaultCredits: 5, unit: 'per_image' }, proxyPath: '/api/services/ai-image',
    detectSignals: ['generate image', 'ai image', 'art', 'logo generation', 'illustration', 'avatar'],
    providers: [
      { name: 'bedrock_image', mode: 'platform', priority: 1, fallbackProvider: 'stability', healthStatus: 'healthy', configRequirements: ['AWS_REGION'], version: 'v1', notes: 'Titan/Stability via Bedrock (stays in-AWS)' },
      { name: 'stability', mode: 'byok', priority: 2, healthStatus: 'unknown', configRequirements: ['STABILITY_API_KEY'], version: 'v2beta' },
    ],
  },
  ai_video: {
    id: 'ai_video', label: 'AI Video', version: '1.0.0', defaultProvider: 'replicate',
    pricing: { configKey: 'pricing.ai_video', defaultCredits: 15, unit: 'per_video' }, proxyPath: '/api/services/ai-video',
    detectSignals: ['generate video', 'ai video', 'text to video', 'video creation'],
    providers: [
      { name: 'replicate', mode: 'byok', priority: 1, fallbackProvider: 'runway', healthStatus: 'unknown', configRequirements: ['REPLICATE_API_TOKEN'], version: 'v1', notes: 'No AWS-native option — external dependency' },
      { name: 'runway', mode: 'byok', priority: 2, healthStatus: 'unknown', configRequirements: ['RUNWAY_API_KEY'], version: 'v1' },
    ],
  },
  storage: {
    id: 'storage', label: 'File Storage', version: '1.0.0', defaultProvider: 's3',
    pricing: { configKey: 'pricing.storage', defaultCredits: 0, unit: 'per_call' }, proxyPath: '/api/services/storage',
    detectSignals: ['upload', 'file', 'image upload', 'attachment', 'media', 'document'],
    providers: [
      { name: 's3', mode: 'platform', priority: 1, healthStatus: 'healthy', configRequirements: ['AWS_REGION'], version: '2006-03-01', notes: 'AWS S3 (per-app prefix)' },
    ],
  },
  analytics: {
    id: 'analytics', label: 'Analytics', version: '1.0.0', defaultProvider: 'plausible',
    pricing: { configKey: 'pricing.analytics', defaultCredits: 0, unit: 'per_call' }, proxyPath: '/api/services/analytics',
    detectSignals: ['analytics', 'track', 'visitors', 'pageviews', 'metrics', 'stats'],
    providers: [
      { name: 'plausible', mode: 'platform', priority: 1, fallbackProvider: 'google_analytics', healthStatus: 'unknown', configRequirements: ['PLAUSIBLE_DOMAIN'], version: 'v1', notes: 'Privacy-friendly' },
      { name: 'google_analytics', mode: 'byok', priority: 2, healthStatus: 'unknown', configRequirements: ['GA_MEASUREMENT_ID'], version: 'v4' },
    ],
  },
  domains: {
    id: 'domains', label: 'Domains', version: '1.0.0', defaultProvider: 'route53',
    pricing: { configKey: 'pricing.domains', defaultCredits: 0, unit: 'per_call' }, proxyPath: '/api/services/domains',
    detectSignals: ['custom domain', 'buy domain', 'connect domain'],
    providers: [
      { name: 'route53', mode: 'platform', priority: 1, healthStatus: 'healthy', configRequirements: ['AWS_REGION'], version: '2014-05-15', notes: 'AWS Route 53 (payment-gated separately)' },
    ],
  },
  deployment: {
    id: 'deployment', label: 'Deployment', version: '1.0.0', defaultProvider: 'amplify',
    pricing: { configKey: 'pricing.deployment', defaultCredits: 0, unit: 'per_call' }, proxyPath: '/api/services/deploy',
    detectSignals: ['deploy', 'publish', 'go live', 'hosting'],
    providers: [
      { name: 'amplify', mode: 'platform', priority: 1, fallbackProvider: 'fargate-worker', healthStatus: 'healthy', configRequirements: [], version: 'v1', notes: 'AWS Amplify' },
      { name: 'fargate-worker', mode: 'platform', priority: 2, healthStatus: 'healthy', configRequirements: ['WORKER_URL'], version: 'v1', notes: 'ECS/Fargate build worker' },
    ],
  },
  // ── Notifications: first-class, multi-channel (NOT an email alias) ──────────
  notifications: {
    id: 'notifications', label: 'Notifications', version: '1.0.0', defaultProvider: 'push',
    pricing: { configKey: 'pricing.notifications', defaultCredits: 1, unit: 'per_call' }, proxyPath: '/api/services/notify',
    detectSignals: ['notification', 'alert', 'remind', 'push', 'whatsapp', 'slack', 'discord', 'webhook'],
    providers: [],
    channels: [
      {
        channel: 'push', defaultProvider: 'web_push',
        providers: [
          { name: 'web_push', mode: 'platform', priority: 1, healthStatus: 'unknown', configRequirements: ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'], version: 'v1', notes: 'Web Push (VAPID)' },
          { name: 'fcm', mode: 'byok', priority: 2, healthStatus: 'unknown', configRequirements: ['FCM_SERVER_KEY'], version: 'v1' },
        ],
      },
      {
        channel: 'email', defaultProvider: 'ses',
        providers: [
          { name: 'ses', mode: 'platform', priority: 1, fallbackProvider: 'resend', healthStatus: 'healthy', configRequirements: ['DWOMOH_SES_FROM_EMAIL'], version: 'v2' },
        ],
      },
      {
        channel: 'sms', defaultProvider: 'termii',
        providers: [
          { name: 'termii', mode: 'platform', priority: 1, fallbackProvider: 'twilio', healthStatus: 'unknown', configRequirements: ['TERMII_API_KEY'], version: 'v1' },
        ],
      },
      {
        channel: 'whatsapp', defaultProvider: 'whatsapp_cloud',
        providers: [
          { name: 'whatsapp_cloud', mode: 'byok', priority: 1, healthStatus: 'unknown', configRequirements: ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID'], version: 'v18.0', notes: 'Meta WhatsApp Cloud API' },
        ],
      },
      {
        channel: 'slack', defaultProvider: 'slack_webhook',
        providers: [
          { name: 'slack_webhook', mode: 'byok', priority: 1, healthStatus: 'unknown', configRequirements: ['SLACK_WEBHOOK_URL'], version: 'v1' },
        ],
      },
      {
        channel: 'discord', defaultProvider: 'discord_webhook',
        providers: [
          { name: 'discord_webhook', mode: 'byok', priority: 1, healthStatus: 'unknown', configRequirements: ['DISCORD_WEBHOOK_URL'], version: 'v1' },
        ],
      },
      {
        channel: 'webhook', defaultProvider: 'generic_webhook',
        providers: [
          { name: 'generic_webhook', mode: 'byok', priority: 1, healthStatus: 'unknown', configRequirements: ['WEBHOOK_URL'], version: 'v1', notes: 'POST to a user-supplied URL' },
        ],
      },
    ],
  },
};

/** Convenience: list every capability id in the registry. */
export const ALL_CAPABILITIES = Object.keys(SERVICE_REGISTRY) as CapabilityId[];
