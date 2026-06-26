/**
 * Feature Understanding Layer
 *
 * Before the AI generates code for a new feature, this service:
 *   1. Detects what type of feature is being requested
 *   2. Expands it to the COMPLETE set of requirements (pages, APIs, DB, env vars)
 *   3. Checks the project map for existing structure (route groups, auth setup)
 *   4. Generates a "feature specification block" that is injected into the edit prompt
 *
 * This prevents partial implementation (e.g., "forgot password" that only adds one
 * page with no API route, no token table, no email delivery) and prevents route
 * conflicts (creating app/X/page.tsx when app/(auth)/X/page.tsx already exists).
 *
 * All detection and expansion is deterministic — no AI call. Runs in <10ms.
 */

import type { ProjectMap } from './project-map';

// ─── Types ────────────────────────────────────────────────────────────────────

export type FeatureCategory =
  | 'auth-password-reset'
  | 'auth-email-verification'
  | 'auth-oauth'
  | 'auth-login-signup'
  | 'payment-checkout'
  | 'file-upload'
  | 'email-notification'
  | 'search-filter'
  | 'crud-resource'
  | 'dashboard-analytics'
  | 'booking-system'
  | 'messaging'
  | 'user-profile'
  | 'admin-panel'
  | 'unknown';

export interface FeaturePlan {
  category: FeatureCategory;
  detectedFeature: string;

  /** New pages that must be created, with their exact path */
  requiredPages: Array<{ path: string; purpose: string }>;
  /** API routes that must be created */
  requiredApiRoutes: Array<{ path: string; methods: string[]; purpose: string }>;
  /** DB tables that must exist */
  requiredDbTables: Array<{ name: string; columns: string[] }>;
  /** Env vars that must be present */
  requiredEnvVars: string[];
  /** npm packages to install if missing */
  requiredPackages: string[];

  /** Complete requirements checklist for the AI */
  checklist: string[];
  /** Route structure constraint: where to place new pages */
  routeStructureNote: string;
  /** Formatted block to inject into the AI edit prompt */
  specificationBlock: string;
}

// ─── Feature detection ────────────────────────────────────────────────────────

const FEATURE_PATTERNS: Array<{ category: FeatureCategory; patterns: RegExp[] }> = [
  {
    category: 'auth-password-reset',
    patterns: [/forgot\s*password/i, /reset\s*password/i, /password\s*reset/i, /password\s*recovery/i],
  },
  {
    category: 'auth-email-verification',
    patterns: [/email\s*verif/i, /verify\s*email/i, /confirm\s*email/i, /account\s*activat/i],
  },
  {
    category: 'auth-oauth',
    patterns: [/google\s*(?:login|auth|sign)/i, /github\s*(?:login|auth|sign)/i, /oauth/i, /social\s*login/i],
  },
  {
    category: 'auth-login-signup',
    patterns: [/(?:add|create|build)\s+(?:a\s+)?(?:login|signin|sign.in|signup|register|auth)/i],
  },
  {
    category: 'payment-checkout',
    patterns: [/stripe|paystack|payment|checkout|subscription|billing|invoice/i],
  },
  {
    category: 'file-upload',
    patterns: [/file\s*upload|image\s*upload|photo\s*upload|upload\s*(?:feature|support|component)/i],
  },
  {
    category: 'email-notification',
    patterns: [/send\s*email|email\s*notification|email\s*template|smtp|sendgrid|mailgun|ses\s*email/i],
  },
  {
    category: 'search-filter',
    patterns: [/(?:add|build|implement)\s+search|search\s*(?:feature|functionality|filter)|filter\s*(?:by|results)/i],
  },
  {
    category: 'dashboard-analytics',
    patterns: [/dashboard|analytics|statistics|metrics|charts?|graphs?|reporting/i],
  },
  {
    category: 'booking-system',
    patterns: [/booking|reservation|availability|schedule|calendar|appointment/i],
  },
  {
    category: 'messaging',
    patterns: [/(?:add|build|implement)\s+(?:chat|messaging|inbox|direct\s*message|notifications?)/i],
  },
  {
    category: 'user-profile',
    patterns: [/user\s*profile|profile\s*(?:page|edit|settings?)|account\s*settings/i],
  },
  {
    category: 'admin-panel',
    patterns: [/admin\s*(?:panel|dashboard|area|section|page)|moderat/i],
  },
  {
    category: 'crud-resource',
    patterns: [/(?:add|create|build)\s+(?:a\s+)?(?:listing|product|item|post|article|property|course|service)/i],
  },
];

function detectFeatureCategory(request: string): FeatureCategory {
  for (const { category, patterns } of FEATURE_PATTERNS) {
    if (patterns.some(p => p.test(request))) return category;
  }
  return 'unknown';
}

// ─── Route structure detection ────────────────────────────────────────────────

function detectAuthRouteGroup(map: ProjectMap | null): string | null {
  if (!map) return null;
  for (const f of map.files) {
    const m = /^app\/(\([^)]+\))\/(?:login|signin|signup|register)\/page/.exec(f.path);
    if (m) return m[1]; // e.g. "(auth)"
  }
  return null;
}

function detectDashboardRouteGroup(map: ProjectMap | null): string | null {
  if (!map) return null;
  for (const f of map.files) {
    const m = /^app\/(\([^)]+\))\/dashboard\/page/.exec(f.path);
    if (m) return m[1];
  }
  return null;
}

function routeGroupNote(group: string | null, context: string): string {
  if (!group) return `Create new pages in the appropriate directory under app/.`;
  return (
    `CRITICAL: The existing project uses route group ${group} for ${context} pages. ` +
    `Place ALL new ${context} pages inside app/${group}/, NOT in bare app/X/. ` +
    `For example: app/${group}/forgot-password/page.tsx — NOT app/forgot-password/page.tsx. ` +
    `Creating a page at app/X/page.tsx when app/${group}/X/page.tsx exists causes a build-fatal route conflict.`
  );
}

// ─── Feature-specific requirement expansion ───────────────────────────────────

function expandPasswordReset(map: ProjectMap | null): Partial<FeaturePlan> {
  const authGroup = detectAuthRouteGroup(map);
  const prefix = authGroup ? `app/${authGroup}` : 'app/(auth)';

  return {
    requiredPages: [
      { path: `${prefix}/forgot-password/page.tsx`, purpose: 'Email input form → calls POST /api/auth/forgot-password' },
      { path: `${prefix}/reset-password/page.tsx`, purpose: 'New password form → reads ?token= from URL → calls POST /api/auth/reset-password' },
    ],
    requiredApiRoutes: [
      {
        path: 'app/api/auth/forgot-password/route.ts', methods: ['POST'],
        purpose: 'Accept email, generate reset token, store in DB, send email via SES',
      },
      {
        path: 'app/api/auth/reset-password/route.ts', methods: ['POST'],
        purpose: 'Validate token (exists + not expired), update password, invalidate token',
      },
    ],
    requiredDbTables: [
      { name: 'password_reset_tokens', columns: ['id', 'user_id', 'token', 'expires_at', 'used', 'created_at'] },
    ],
    requiredEnvVars: ['DWOMOH_SES_FROM_EMAIL', 'NEXT_PUBLIC_APP_URL'],
    requiredPackages: [],
    checklist: [
      'Forgot password page: email input, submit handler, success/error states',
      'Reset password page: reads ?token= param, new password + confirm, strength hint',
      'POST /api/auth/forgot-password: validates email, generates crypto token, stores in DB, sends email',
      'POST /api/auth/reset-password: validates token exists & not expired, hashes new password, marks token used',
      'password_reset_tokens table: id, user_id, token (random 32-byte hex), expires_at (1 hour), used boolean',
      'Email: use SES via DWOMOH_SES_FROM_EMAIL — include reset link with token in query string',
      'Token expiry: check expires_at before allowing reset, return "link expired" error if stale',
      'After successful reset: redirect user to login page',
      'ALL auth pages must go in ' + prefix + '/, not in bare app/ directory',
    ],
    routeStructureNote: routeGroupNote(authGroup, 'auth'),
  };
}

function expandEmailVerification(map: ProjectMap | null): Partial<FeaturePlan> {
  const authGroup = detectAuthRouteGroup(map);
  const prefix = authGroup ? `app/${authGroup}` : 'app/(auth)';

  return {
    requiredPages: [
      { path: `${prefix}/verify-email/page.tsx`, purpose: 'Shows verification status, handles ?token= param' },
    ],
    requiredApiRoutes: [
      { path: 'app/api/auth/send-verification/route.ts', methods: ['POST'], purpose: 'Send verification email' },
      { path: 'app/api/auth/verify-email/route.ts', methods: ['POST'], purpose: 'Validate token, mark email as verified' },
    ],
    requiredDbTables: [
      { name: 'email_verification_tokens', columns: ['id', 'user_id', 'token', 'expires_at', 'verified_at'] },
    ],
    requiredEnvVars: ['DWOMOH_SES_FROM_EMAIL', 'NEXT_PUBLIC_APP_URL'],
    requiredPackages: [],
    checklist: [
      'Verification page: reads ?token= from URL, auto-submits verification, shows success/error',
      'POST /api/auth/send-verification: generates token, stores in DB, sends email with verification link',
      'POST /api/auth/verify-email: validates token, sets user.email_verified = true, returns success',
      'Send verification email automatically on signup',
      'email_verification_tokens table: token, user_id, expires_at, verified_at',
      'Check email_verified before allowing access to protected features',
      'ALL auth pages must go in ' + prefix + '/, not in bare app/ directory',
    ],
    routeStructureNote: routeGroupNote(authGroup, 'auth'),
  };
}

function expandFileUpload(map: ProjectMap | null): Partial<FeaturePlan> {
  return {
    requiredPages: [],
    requiredApiRoutes: [
      { path: 'app/api/upload/route.ts', methods: ['POST'], purpose: 'Accept multipart file, validate size/type, store, return URL' },
    ],
    requiredDbTables: [],
    requiredEnvVars: [],
    requiredPackages: ['formidable'],
    checklist: [
      'Upload API route: accept multipart/form-data, validate file type (images: jpg/png/webp), max 5MB',
      'Store files in public/uploads/ directory with a unique filename (use crypto.randomUUID)',
      'Return { url: "/uploads/filename.jpg" } on success',
      'Client component: file input, preview, progress, error states',
      'Add "use client" to any component using useState for preview',
      'Pass Content-Type: multipart/form-data automatically — do NOT set it manually with fetch',
    ],
    routeStructureNote: 'Place upload API at app/api/upload/route.ts.',
  };
}

function expandPayment(map: ProjectMap | null): Partial<FeaturePlan> {
  return {
    requiredPages: [
      { path: 'app/checkout/page.tsx', purpose: 'Payment form — collects card details via Stripe.js' },
      { path: 'app/payment-success/page.tsx', purpose: 'Success page after payment completes' },
    ],
    requiredApiRoutes: [
      { path: 'app/api/payment/create-intent/route.ts', methods: ['POST'], purpose: 'Create Stripe PaymentIntent' },
      { path: 'app/api/payment/webhook/route.ts', methods: ['POST'], purpose: 'Handle Stripe webhook events' },
    ],
    requiredDbTables: [
      { name: 'payments', columns: ['id', 'user_id', 'amount', 'currency', 'stripe_payment_intent_id', 'status', 'created_at'] },
    ],
    requiredEnvVars: ['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY', 'STRIPE_WEBHOOK_SECRET'],
    requiredPackages: ['stripe', '@stripe/stripe-js'],
    checklist: [
      'POST /api/payment/create-intent: create Stripe PaymentIntent, return client_secret',
      'Checkout page: load Stripe.js, mount CardElement, call confirmPayment on submit',
      'POST /api/payment/webhook: verify Stripe signature, handle payment_intent.succeeded event',
      'Record payment in DB when webhook confirms success (not before)',
      'Add "use client" to checkout page (uses Stripe hooks)',
      'STRIPE_PUBLISHABLE_KEY must be set as NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY for client access',
    ],
    routeStructureNote: 'Place checkout page in app/checkout/page.tsx (no route group needed unless dashboard layout applies).',
  };
}

function expandCrudResource(request: string, map: ProjectMap | null): Partial<FeaturePlan> {
  const resource = /add\s+(?:a\s+)?(\w+)/i.exec(request)?.[1] ?? 'item';
  const plural = resource.endsWith('s') ? resource : `${resource}s`;

  return {
    requiredPages: [
      { path: `app/${plural}/page.tsx`, purpose: `List all ${plural}` },
      { path: `app/${plural}/new/page.tsx`, purpose: `Create new ${resource}` },
      { path: `app/${plural}/[id]/page.tsx`, purpose: `View single ${resource}` },
    ],
    requiredApiRoutes: [
      { path: `app/api/${plural}/route.ts`, methods: ['GET', 'POST'], purpose: `List + create ${plural}` },
      { path: `app/api/${plural}/[id]/route.ts`, methods: ['GET', 'PUT', 'DELETE'], purpose: `Read + update + delete ${resource}` },
    ],
    requiredDbTables: [
      { name: plural, columns: ['id', 'user_id', 'title', 'description', 'created_at', 'updated_at'] },
    ],
    requiredEnvVars: [],
    requiredPackages: [],
    checklist: [
      `GET /api/${plural}: return all ${plural} (with optional search/filter query params)`,
      `POST /api/${plural}: validate request body, insert into DB, return created record`,
      `GET /api/${plural}/[id]: return single ${resource} or 404`,
      `PUT /api/${plural}/[id]: validate + update, verify ownership before updating`,
      `DELETE /api/${plural}/[id]: verify ownership before deleting`,
      `List page: fetch data server-side if possible, or useEffect on client`,
      `Create page: form with validation, calls POST /api/${plural}`,
      `Detail page: show all fields, edit and delete buttons`,
    ],
    routeStructureNote: `Place ${resource} pages in app/${plural}/. If a dashboard route group exists, consider placing them inside it.`,
  };
}

function expandSearchFilter(map: ProjectMap | null): Partial<FeaturePlan> {
  return {
    requiredPages: [],
    requiredApiRoutes: [],
    requiredDbTables: [],
    requiredEnvVars: [],
    requiredPackages: [],
    checklist: [
      'Add query params to existing GET /api/[resource]: ?q= for text search, ?filter= for category',
      'Backend: use SQL LIKE or WHERE clauses — never filter in-memory on large datasets',
      'Search input: debounce with 300ms delay, update URL query params on change',
      'Results: show "No results" state when empty, loading state during fetch',
      'Preserve other query params (pagination, filters) when search changes',
      'Add "use client" to any component managing search state with useState',
    ],
    routeStructureNote: 'Search is added to the existing resource API route, not a new route.',
  };
}

// ─── Main function ────────────────────────────────────────────────────────────

export function planFeature(request: string, map: ProjectMap | null): FeaturePlan {
  const category = detectFeatureCategory(request);

  let expansion: Partial<FeaturePlan> = {};
  switch (category) {
    case 'auth-password-reset':    expansion = expandPasswordReset(map); break;
    case 'auth-email-verification': expansion = expandEmailVerification(map); break;
    case 'file-upload':             expansion = expandFileUpload(map); break;
    case 'payment-checkout':        expansion = expandPayment(map); break;
    case 'search-filter':           expansion = expandSearchFilter(map); break;
    case 'crud-resource':           expansion = expandCrudResource(request, map); break;
    default:
      expansion = {
        requiredPages: [], requiredApiRoutes: [], requiredDbTables: [],
        requiredEnvVars: [], requiredPackages: [], checklist: [],
        routeStructureNote: checkRouteStructure(map),
      };
  }

  const plan: FeaturePlan = {
    category,
    detectedFeature: request.slice(0, 80),
    requiredPages: expansion.requiredPages ?? [],
    requiredApiRoutes: expansion.requiredApiRoutes ?? [],
    requiredDbTables: expansion.requiredDbTables ?? [],
    requiredEnvVars: expansion.requiredEnvVars ?? [],
    requiredPackages: expansion.requiredPackages ?? [],
    checklist: expansion.checklist ?? [],
    routeStructureNote: expansion.routeStructureNote ?? checkRouteStructure(map),
    specificationBlock: '',
  };

  plan.specificationBlock = formatFeatureSpec(plan);
  return plan;
}

function checkRouteStructure(map: ProjectMap | null): string {
  if (!map) return '';
  const authGroup = detectAuthRouteGroup(map);
  const dashGroup = detectDashboardRouteGroup(map);
  const notes: string[] = [];
  if (authGroup) notes.push(`Auth route group: ${authGroup} (put auth pages here)`);
  if (dashGroup) notes.push(`Dashboard route group: ${dashGroup} (put dashboard pages here)`);
  return notes.join('. ') || '';
}

function formatFeatureSpec(plan: FeaturePlan): string {
  if (plan.category === 'unknown' && plan.checklist.length === 0) return '';

  const lines: string[] = [
    '╔═══════════════════════════════════════════════════════════════════╗',
    `║  FEATURE IMPLEMENTATION PLAN — ${plan.category.toUpperCase().padEnd(35)}║`,
    '╠═══════════════════════════════════════════════════════════════════╣',
  ];

  if (plan.routeStructureNote) {
    lines.push('║  ROUTE STRUCTURE (read before creating any files):               ║');
    const words = plan.routeStructureNote.split(' ');
    let line = '║  ';
    for (const word of words) {
      if ((line + word).length > 68) { lines.push(line.padEnd(68) + '║'); line = '║    '; }
      line += word + ' ';
    }
    if (line.trim() !== '║') lines.push(line.padEnd(68) + '║');
  }

  if (plan.requiredPages.length > 0) {
    lines.push('║  REQUIRED PAGES:                                                 ║');
    for (const p of plan.requiredPages) lines.push(`║    • ${p.path.padEnd(62)}║`);
  }

  if (plan.requiredApiRoutes.length > 0) {
    lines.push('║  REQUIRED API ROUTES:                                            ║');
    for (const r of plan.requiredApiRoutes) {
      const desc = `${r.path} [${r.methods.join(',')}]`;
      lines.push(`║    • ${desc.slice(0, 62).padEnd(62)}║`);
    }
  }

  if (plan.requiredDbTables.length > 0) {
    lines.push('║  REQUIRED DB TABLES:                                             ║');
    for (const t of plan.requiredDbTables) {
      lines.push(`║    • ${t.name}: ${t.columns.join(', ')}`.slice(0, 68).padEnd(68) + '║');
    }
  }

  if (plan.requiredEnvVars.length > 0) {
    lines.push('║  REQUIRED ENV VARS:                                              ║');
    lines.push(`║    ${plan.requiredEnvVars.join(', ').slice(0, 64).padEnd(64)}║`);
  }

  if (plan.checklist.length > 0) {
    lines.push('║  IMPLEMENTATION CHECKLIST (all items required):                  ║');
    for (const item of plan.checklist) {
      lines.push(`║    ✓ ${item.slice(0, 62).padEnd(62)}║`);
    }
  }

  lines.push('║  BUILD ALL ITEMS ABOVE. Do NOT create a partial implementation.  ║');
  lines.push('╚═══════════════════════════════════════════════════════════════════╝');
  return lines.join('\n');
}
