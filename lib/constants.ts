/**
 * Application-wide constants
 */

export const APP_NAME = 'DWOMOH Vibe Code';
export const APP_VERSION = '1.0.0';

/**
 * AWS Bedrock Model Routing
 *
 * Model IDs discovered via live invoke test on 2026-06-22 against account 859934687821.
 * Only IDs that returned HTTP 200 are used — no assumptions.
 *
 * Tier routing:
 *   HAIKU    — simple chat, quick explanations, small UI edits (fast + cheap)
 *   SONNET   — app generation, coding, debugging, TypeScript fixes, repair loop
 *   STRONGEST — advanced repair, repeated failures, complex reasoning, full rewrites
 *
 * Override any tier via env vars:
 *   BEDROCK_MODEL_HAIKU   → overrides HAIKU default
 *   BEDROCK_MODEL_SONNET  → overrides SONNET default
 *   BEDROCK_MODEL_OPUS / BEDROCK_MODEL_STRONGEST → overrides STRONGEST default (both accepted)
 *   BEDROCK_MODEL_ID      → legacy; only falls back for HAIKU if BEDROCK_MODEL_HAIKU unset
 *
 * NOT available on this account (access denied or end-of-life):
 *   - us.anthropic.claude-fable-5         (ACCESS DENIED)
 *   - global.anthropic.claude-fable-5     (ACCESS DENIED)
 *   - us.anthropic.claude-opus-4-8        (ACCESS DENIED)
 *   - global.anthropic.claude-opus-4-8    (ACCESS DENIED)
 *   - us.anthropic.claude-sonnet-4-5-20251001-v1:0  (INVALID — wrong date suffix)
 *   - us.anthropic.claude-opus-4-20250514-v1:0      (END OF LIFE)
 */
export const BEDROCK_MODELS = {
  // Haiku 4.5 — verified working at 1.1s avg
  HAIKU: process.env.BEDROCK_MODEL_HAIKU ||
    process.env.BEDROCK_MODEL_ID ||
    'us.anthropic.claude-haiku-4-5-20251001-v1:0',

  // Sonnet 4.6 — latest Sonnet, verified working at 1.1s avg
  SONNET: process.env.BEDROCK_MODEL_SONNET ||
    'us.anthropic.claude-sonnet-4-6',

  // Opus 4.6 — latest Opus accessible on this account, verified working at 1.8s avg
  // (Opus 4.8 and Fable 5 are ACCESS DENIED for account 859934687821)
  // Accepts both BEDROCK_MODEL_STRONGEST and BEDROCK_MODEL_OPUS so either name works.
  STRONGEST: process.env.BEDROCK_MODEL_STRONGEST ||
    process.env.BEDROCK_MODEL_OPUS ||
    'global.anthropic.claude-opus-4-6-v1',
} as const;

export type BedrockTier = keyof typeof BEDROCK_MODELS;

/**
 * Fallback chain: if a model returns "model identifier is invalid" or
 * "end of life", the route handler retries with the next ID in the chain.
 * All IDs here are verified working on account 859934687821 as of 2026-06-22.
 */
export const BEDROCK_FALLBACK_CHAINS: Record<BedrockTier, string[]> = {
  HAIKU: [
    'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    'anthropic.claude-3-haiku-20240307-v1:0',
  ],
  SONNET: [
    'us.anthropic.claude-sonnet-4-6',
    'global.anthropic.claude-sonnet-4-6',
    'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
    // Final fallback: drop to Haiku rather than crash
    'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  ],
  STRONGEST: [
    'global.anthropic.claude-opus-4-6-v1',
    'us.anthropic.claude-opus-4-6-v1',
    'global.anthropic.claude-opus-4-5-20251101-v1:0',
    'us.anthropic.claude-opus-4-5-20251101-v1:0',
    // Degrade to Sonnet before Haiku
    'us.anthropic.claude-sonnet-4-6',
    'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  ],
};

/**
 * AWS Bedrock Configuration
 *
 * DEFAULT_MODEL is kept for legacy callers (services/bedrock.ts invokeStreaming).
 * All new callers should pass a tier explicitly.
 */
export const BEDROCK_CONFIG = {
  /** @deprecated Use BEDROCK_MODELS.HAIKU / .SONNET / .STRONGEST instead */
  DEFAULT_MODEL: BEDROCK_MODELS.HAIKU,
  DEFAULT_REGION:
    process.env.AWS_REGION || 'us-east-1',
  MAX_TOKENS_CHAT: 2000,
  MAX_TOKENS_BUILD: 24000,
  MAX_TOKENS_REPAIR: 32000,  // repair/rewrite passes need more room
  TEMPERATURE: 0.7,
  ANTHROPIC_VERSION: 'bedrock-2023-05-31',
};

/**
 * Project Configuration
 */
export const PROJECT_CONFIG = {
  GENERATED_PROJECTS_DIR: 'generated-projects',
  DEFAULT_PORT: 3000,
  PORT_RANGE_START: 3000,
  PORT_RANGE_END: 3100,
  INSTALL_TIMEOUT: 120000, // 2 minutes
  SERVER_START_TIMEOUT: 60000, // 1 minute
  PORT_DETECTION_TIMEOUT: 90000, // 90 seconds — Next.js cold compile needs more time
};

/**
 * Build Status Steps
 */
export const BUILD_STEPS = {
  IDLE: 'idle',
  ANALYZING: 'analyzing',
  GENERATING: 'generating',
  CREATING: 'creating',
  INSTALLING: 'installing',
  STARTING: 'starting',
  SUCCESS: 'success',
  ERROR: 'error',
} as const;

/**
 * Build Step Messages
 */
export const BUILD_MESSAGES = {
  [BUILD_STEPS.IDLE]: '⏳ Ready',
  [BUILD_STEPS.ANALYZING]: '🔍 Analyzing your request...',
  [BUILD_STEPS.GENERATING]: '🚀 Generating application...',
  [BUILD_STEPS.CREATING]: '📁 Creating project structure...',
  [BUILD_STEPS.INSTALLING]: '📦 Installing dependencies...',
  [BUILD_STEPS.STARTING]: '⚙️ Starting development server...',
  [BUILD_STEPS.SUCCESS]: '✅ Application ready!',
  [BUILD_STEPS.ERROR]: '❌ Error occurred',
} as const;

/**
 * Log Messages
 */
export const LOG_MESSAGES = {
  ANALYZING: '🔍 Analyzing your request...',
  DETECTED_BUILD: '✓ Detected: Build mode',
  DETECTED_CHAT: '✓ Detected: Chat mode',
  GENERATING_CODE: '🚀 Generating application code...',
  PARSING_RESPONSE: '📝 Parsing AI response...',
  VALIDATING_JSON: '✔️ Validating JSON structure...',
  CREATING_FOLDERS: '📁 Creating project folders...',
  WRITING_FILES: '✍️ Writing files...',
  INSTALLING_DEPS: '📦 Installing npm packages...',
  STARTING_SERVER: '⚙️ Starting development server...',
  DETECTING_PORT: '🔍 Detecting server port...',
  PORT_FOUND: (port: number) => `✓ Server running on port ${port}`,
  PREVIEW_READY: '✅ Preview is ready!',
  ERROR_INVALID_JSON: '❌ Invalid JSON response',
  ERROR_PARSE_FAILED: '❌ Failed to parse response',
  ERROR_CREATE_FAILED: '❌ Failed to create project',
  ERROR_INSTALL_FAILED: '❌ Failed to install dependencies',
  ERROR_START_FAILED: '❌ Failed to start server',
} as const;

/**
 * Error Messages
 */
export const ERROR_MESSAGES = {
  NO_PROMPT: 'Please enter a prompt',
  INVALID_JSON: 'Could not parse AI response. Please try again.',
  PARSE_ERROR: 'Failed to parse response format. Please try again.',
  CREATE_ERROR: 'Failed to create project. Please try again.',
  INSTALL_ERROR: 'Failed to install dependencies. Please try again.',
  START_ERROR: 'Failed to start development server. Please try again.',
  PORT_ERROR: 'Could not detect running port. Please try again.',
  BEDROCK_ERROR: 'AI service error. Please try again later.',
  MISSING_CREDENTIALS: 'AWS credentials not configured',
  INVALID_PROJECT_NAME: 'Invalid project name',
  PROJECT_EXISTS: 'Project already exists',
} as const;

/**
 * Default Next.js Package.json Template
 */
export const DEFAULT_PACKAGE_JSON = {
  name: 'nextjs-app',
  version: '1.0.0',
  private: true,
  scripts: {
    dev: 'next dev',
    build: 'next build',
    start: 'next start',
    lint: 'next lint',
  },
  dependencies: {
    react: '^19.0.0',
    'react-dom': '^19.0.0',
    next: '^15.0.0',
  },
  devDependencies: {
    typescript: '^5.0.0',
    '@types/node': '^20.0.0',
    '@types/react': '^19.0.0',
    '@types/react-dom': '^19.0.0',
    autoprefixer: '^10.4.0',
    postcss: '^8.4.0',
    tailwindcss: '^3.4.0',
  },
};

/**
 * Default Tailwind CSS Template
 */
export const DEFAULT_GLOBALS_CSS = `@tailwind base;
@tailwind components;
@tailwind utilities;

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen',
    'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue',
    sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

code {
  font-family: source-code-pro, Menlo, Monaco, Consolas, 'Courier New',
    monospace;
}
`;

/**
 * Default Layout Template
 */
export const DEFAULT_LAYOUT_TSX = `import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Next.js App',
  description: 'Generated by DWOMOH Vibe Code',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}`;

/**
 * API Response Status Codes
 */
export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const;

/**
 * Storage Keys for LocalStorage
 */
export const STORAGE_KEYS = {
  CHAT_HISTORY: 'dwomoh_vibecode_chat_history',
  PROJECTS_LIST: 'dwomoh_vibecode_projects',
  CURRENT_PROJECT: 'dwomoh_vibecode_current_project',
  USER_PREFERENCES: 'dwomoh_vibecode_preferences',
} as const;

/**
 * UI Configuration
 */
export const UI_CONFIG = {
  SIDEBAR_WIDTH: '20%',
  CHAT_PANEL_WIDTH: '40%',
  PREVIEW_PANEL_WIDTH: '40%',
  MESSAGE_MAX_WIDTH: '85%',
  ANIMATION_DURATION: 300,
} as const;

/**
 * Deployment Targets
 */
export const DEPLOYMENT_TARGETS = {
  VERCEL: 'vercel',
  NETLIFY: 'netlify',
  GITHUB: 'github',
} as const;