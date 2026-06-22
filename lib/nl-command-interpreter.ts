/**
 * Natural Language Command Interpreter
 *
 * Detects engineering intent from plain-English commands so non-technical
 * users don't need to know how to phrase technical requests.
 *
 * Recognizes commands like:
 *   "Fix this", "Make it work", "Connect the database",
 *   "Fix authentication", "Use RapidAPI", "Investigate the error"
 * and returns a structured EngineeringIntent.
 */

export type EngineeringAction =
  | 'investigate'        // "Find the problem", "What's wrong"
  | 'investigate_and_fix' // "Fix this", "Make it work", "Repair the app"
  | 'fix_frontend'       // "Fix the UI", "Fix the frontend"
  | 'fix_backend'        // "Fix the backend", "Fix the server"
  | 'fix_auth'           // "Fix authentication", "Fix login"
  | 'fix_api'            // "Fix the API", "Fix the integration"
  | 'fix_database'       // "Fix the database"
  | 'configure_api'      // "Configure the API", "Use RapidAPI"
  | 'connect_service'    // "Connect Supabase", "Connect Stripe"
  | 'connect_database'   // "Connect the database", "Add a database"
  | 'deploy'             // "Deploy", "Publish", "Go live"
  | 'build';             // Default — create something new (not an engineering command)

export interface EngineeringIntent {
  action: EngineeringAction;
  /** Named external service, if specified (e.g. 'rapidapi', 'supabase', 'stripe') */
  service?: string;
  /** Specific layer to focus on, if the user named one */
  targetLayer?: 'frontend' | 'backend' | 'auth' | 'api' | 'database' | 'credentials';
  /** 0–1: how confident we are this is an engineering command vs. a new build request */
  confidence: number;
  originalText: string;
  /** True when this command should skip normal conversation and trigger the investigation flow */
  isEngineeringCommand: boolean;
}

// ── Canonical engineering phrases ─────────────────────────────────────────────

const FIX_GENERIC = /\b(fix|repair|restore|resolve|correct|sort out)\b/i;
const MAKE_WORK = /\b(make it work|make this work|make it run|get it working|get it running|make it functional)\b/i;
const BROKEN = /\b(broken|not working|isn't working|doesn't work|won't work|stopped working|crashes|crashed|failing|failed|error|broken|bust|busted)\b/i;
const INVESTIGATE = /\b(investigate|diagnose|debug|check what('s| is) wrong|find the (problem|bug|issue|error)|what('s| is) wrong|why (is it|does it|won't it|doesn't it)|what('s| is) the (error|issue|problem))\b/i;
const DEPLOY = /\b(deploy|publish|push to prod|go live|release|ship it|ship this)\b/i;

const FRONTEND_TARGET = /\b(frontend|front.end|ui|interface|display|layout|page|screen|rendering|react|component|style|css|design)\b/i;
const BACKEND_TARGET = /\b(backend|back.end|server|api route|route|endpoint|handler|controller|express|node)\b/i;
const AUTH_TARGET = /\b(auth|authentication|login|log.in|sign.?in|sign.?up|register|session|jwt|cognito|next.?auth|password|credential)\b/i;
const API_TARGET = /\b(api|rapidapi|integration|webhook|third.?party|external|provider)\b/i;
const DB_TARGET = /\b(database|db|sqlite|postgres|mysql|mongodb|prisma|supabase.*database|data|connection|connection|query|schema|migration)\b/i;
const CREDENTIALS_TARGET = /\b(key|credential|secret|env|environment variable|api.?key|token|password)\b/i;

const CONNECT_DATABASE = /\b(connect.*database|add.*database|set.?up.*database|use.*database|link.*database|database.*connect)\b/i;
const CONFIGURE_API = /\b(configure.*api|set.?up.*api|use rapidapi|connect.*rapidapi|enable.*api|add.*api)\b/i;

const SERVICE_NAMES: Record<string, string> = {
  rapidapi: 'rapidapi',
  'rapid api': 'rapidapi',
  supabase: 'supabase',
  stripe: 'stripe',
  paystack: 'paystack',
  twilio: 'twilio',
  sendgrid: 'sendgrid',
  resend: 'resend',
  openai: 'openai',
  'open ai': 'openai',
  firebase: 'firebase',
  mongodb: 'mongodb',
  postgres: 'postgres',
  postgresql: 'postgres',
  mysql: 'mysql',
  redis: 'redis',
  aws: 'aws',
  s3: 'aws-s3',
  cloudinary: 'cloudinary',
  mailchimp: 'mailchimp',
};

function extractService(text: string): string | undefined {
  const lower = text.toLowerCase();
  for (const [pattern, name] of Object.entries(SERVICE_NAMES)) {
    if (lower.includes(pattern)) return name;
  }
  return undefined;
}

// ── Core interpreter ──────────────────────────────────────────────────────────

export function interpretCommand(input: string): EngineeringIntent {
  const text = input.trim();
  const lower = text.toLowerCase();
  const service = extractService(lower);

  // ── Investigate only (no fix implied) ────────────────────────────────────
  if (INVESTIGATE.test(text) && !FIX_GENERIC.test(text) && !MAKE_WORK.test(text)) {
    return {
      action: 'investigate',
      service,
      confidence: 0.92,
      originalText: text,
      isEngineeringCommand: true,
    };
  }

  // ── Deploy ────────────────────────────────────────────────────────────────
  if (DEPLOY.test(text) && text.length < 50) {
    return {
      action: 'deploy',
      confidence: 0.9,
      originalText: text,
      isEngineeringCommand: true,
    };
  }

  // ── Connect database ──────────────────────────────────────────────────────
  if (CONNECT_DATABASE.test(text)) {
    return {
      action: 'connect_database',
      service: service ?? 'sqlite',
      targetLayer: 'database',
      confidence: 0.93,
      originalText: text,
      isEngineeringCommand: true,
    };
  }

  // ── Configure API / named service ─────────────────────────────────────────
  if (CONFIGURE_API.test(text) || (service && /\b(connect|use|add|integrate|enable|set.?up)\b/i.test(text))) {
    return {
      action: 'connect_service',
      service: service ?? 'api',
      targetLayer: 'api',
      confidence: 0.9,
      originalText: text,
      isEngineeringCommand: true,
    };
  }

  // ── Layer-targeted fix ────────────────────────────────────────────────────
  if (FIX_GENERIC.test(text)) {
    if (AUTH_TARGET.test(text)) {
      return { action: 'fix_auth', targetLayer: 'auth', confidence: 0.91, originalText: text, isEngineeringCommand: true };
    }
    if (DB_TARGET.test(text)) {
      return { action: 'fix_database', targetLayer: 'database', confidence: 0.9, originalText: text, isEngineeringCommand: true };
    }
    if (API_TARGET.test(text)) {
      return { action: 'fix_api', service, targetLayer: 'api', confidence: 0.88, originalText: text, isEngineeringCommand: true };
    }
    if (BACKEND_TARGET.test(text)) {
      return { action: 'fix_backend', targetLayer: 'backend', confidence: 0.88, originalText: text, isEngineeringCommand: true };
    }
    if (FRONTEND_TARGET.test(text)) {
      return { action: 'fix_frontend', targetLayer: 'frontend', confidence: 0.88, originalText: text, isEngineeringCommand: true };
    }
    if (CREDENTIALS_TARGET.test(text) && text.length < 80) {
      return { action: 'fix_api', targetLayer: 'credentials', confidence: 0.85, originalText: text, isEngineeringCommand: true };
    }
    // Generic "fix this" with no specific target
    if (text.length < 100) {
      return { action: 'investigate_and_fix', confidence: 0.82, originalText: text, isEngineeringCommand: true };
    }
  }

  // ── "Make it work" / "It's broken" ───────────────────────────────────────
  if (MAKE_WORK.test(text) || (BROKEN.test(text) && text.length < 80)) {
    return {
      action: 'investigate_and_fix',
      confidence: MAKE_WORK.test(text) ? 0.9 : 0.75,
      originalText: text,
      isEngineeringCommand: true,
    };
  }

  // ── "Fix this" variations with BROKEN indicators ──────────────────────────
  if (FIX_GENERIC.test(text) && BROKEN.test(text)) {
    return {
      action: 'investigate_and_fix',
      confidence: 0.8,
      originalText: text,
      isEngineeringCommand: true,
    };
  }

  // Not an engineering command — let it go through the normal chat/build flow
  return {
    action: 'build',
    service,
    confidence: 0,
    originalText: text,
    isEngineeringCommand: false,
  };
}

/**
 * Returns a short label for display in the builder UI during the investigation phase.
 */
export function getActionLabel(intent: EngineeringIntent): string {
  switch (intent.action) {
    case 'investigate':            return '🔍 Diagnosing — Investigating the root cause…';
    case 'investigate_and_fix':    return '🔍 Diagnosing — Finding the root cause before fixing…';
    case 'fix_frontend':           return '🖥️ Diagnosing frontend — Checking UI and rendering…';
    case 'fix_backend':            return '⚙️ Diagnosing backend — Checking API routes and server logic…';
    case 'fix_auth':               return '🔐 Diagnosing auth — Checking authentication config…';
    case 'fix_api':                return '🌐 Diagnosing API — Checking external integrations…';
    case 'fix_database':           return '🗄️ Diagnosing database — Checking connections and queries…';
    case 'connect_database':       return '🗄️ Connecting database — Setting up database integration…';
    case 'configure_api':          return '🌐 Configuring API — Setting up integration…';
    case 'connect_service':        return `🔗 Connecting ${intent.service ?? 'service'} — Setting up integration…`;
    case 'deploy':                 return '🚀 Preparing to deploy…';
    default:                       return '🤖 Processing your request…';
  }
}

/**
 * Returns the investigation prompt additions for a targeted fix.
 * These are appended to the root cause investigation to steer the AI
 * toward the right layer.
 */
export function getLayerInvestigationHint(intent: EngineeringIntent): string {
  switch (intent.action) {
    case 'fix_frontend':
      return 'FOCUS: Check app/page.tsx, layout files, and client components for rendering errors, missing "use client" directives, and hydration issues.';
    case 'fix_backend':
      return 'FOCUS: Check all files in app/api/ for missing handlers, TypeScript errors, and incorrect HTTP methods.';
    case 'fix_auth':
      return 'FOCUS: Check NEXTAUTH_SECRET, auth route at app/api/auth/[...nextauth], and session configuration.';
    case 'fix_api':
      return `FOCUS: Check API key configuration${intent.service ? ` for ${intent.service}` : ''}, verify credentials in .env.local, and test the API endpoint.`;
    case 'fix_database':
      return 'FOCUS: Check DATABASE_URL, database initialization code, and query syntax.';
    case 'connect_database':
      return `FOCUS: Set up a ${intent.service ?? 'SQLite'} database. Add DATABASE_URL to .env.local, create the schema, and wire it to the API routes.`;
    case 'connect_service':
      return `FOCUS: Integrate ${intent.service ?? 'the service'} — add the credentials to .env.local, create the client, and add the API routes.`;
    default:
      return '';
  }
}
