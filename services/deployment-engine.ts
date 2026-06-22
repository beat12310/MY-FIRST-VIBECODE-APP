/**
 * Deployment Engine — Feature 5
 * Generates deployment configuration files for AWS Amplify, Vercel, and Netlify.
 * Validates project readiness before generating deployment artifacts.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

export type DeployTarget = 'amplify' | 'vercel' | 'netlify';

export interface DeployFile {
  path: string;
  content: string;
}

export interface ReadinessCheck {
  name: string;
  passed: boolean;
  message: string;
}

export interface DeployResult {
  target: DeployTarget;
  ready: boolean;
  readinessChecks: ReadinessCheck[];
  files: DeployFile[];
  envVarsNeeded: string[];
  deployCommand: string;
  instructions: string[];
}

// ─── Readiness Validation ─────────────────────────────────────────────────────

async function checkReadiness(projectPath: string): Promise<ReadinessCheck[]> {
  const checks: ReadinessCheck[] = [];

  // package.json has build script
  try {
    const pkg = JSON.parse(await readFile(join(projectPath, 'package.json'), 'utf-8'));
    checks.push({
      name: 'Build script',
      passed: Boolean(pkg.scripts?.build),
      message: pkg.scripts?.build ? `Found: ${pkg.scripts.build}` : 'Missing "build" script in package.json',
    });

    // Node engine specified
    checks.push({
      name: 'Node engine',
      passed: Boolean(pkg.engines?.node),
      message: pkg.engines?.node ? `Node ${pkg.engines.node}` : 'No engines.node — recommend adding "engines": { "node": ">=18" }',
    });
  } catch {
    checks.push({ name: 'package.json', passed: false, message: 'Cannot read package.json' });
  }

  // tsconfig present
  checks.push({
    name: 'TypeScript config',
    passed: existsSync(join(projectPath, 'tsconfig.json')),
    message: existsSync(join(projectPath, 'tsconfig.json')) ? 'tsconfig.json found' : 'Missing tsconfig.json',
  });

  // next.config present or inferred
  const hasNextConfig =
    existsSync(join(projectPath, 'next.config.js')) ||
    existsSync(join(projectPath, 'next.config.ts')) ||
    existsSync(join(projectPath, 'next.config.mjs'));
  checks.push({
    name: 'Next.js config',
    passed: true, // optional but helpful to note
    message: hasNextConfig ? 'next.config found' : 'No next.config (optional — defaults apply)',
  });

  // .env.local.example present
  const hasEnvExample = existsSync(join(projectPath, '.env.local.example'));
  checks.push({
    name: 'Env template',
    passed: hasEnvExample,
    message: hasEnvExample ? '.env.local.example found' : 'No .env.local.example — document required env vars',
  });

  // app/page.tsx present
  checks.push({
    name: 'Root page',
    passed: existsSync(join(projectPath, 'app', 'page.tsx')),
    message: existsSync(join(projectPath, 'app', 'page.tsx')) ? 'app/page.tsx found' : 'Missing app/page.tsx',
  });

  return checks;
}

async function getEnvExampleVars(projectPath: string): Promise<string[]> {
  try {
    const content = await readFile(join(projectPath, '.env.local.example'), 'utf-8');
    return content
      .split('\n')
      .filter(l => l.includes('=') && !l.trim().startsWith('#'))
      .map(l => l.split('=')[0].trim());
  } catch {
    return [];
  }
}

// ─── Amplify ──────────────────────────────────────────────────────────────────

function amplifyFiles(envVars: string[]): DeployFile[] {
  const envBlock = envVars.length > 0
    ? `\n  # Environment variables — set these in Amplify Console > Environment variables\n  # ${envVars.join(', ')}`
    : '';

  return [
    {
      path: 'amplify.yml',
      content: `version: 1
frontend:
  phases:
    preBuild:
      commands:
        - npm ci
    build:
      commands:
        - npm run build
  artifacts:
    baseDirectory: .next
    files:
      - '**/*'
  cache:
    paths:
      - node_modules/**/*
      - .next/cache/**/*
${envBlock}
`,
    },
    {
      path: 'next.config.js',
      content: `/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Required for AWS Amplify hosting
};

module.exports = nextConfig;
`,
    },
  ];
}

// ─── Vercel ───────────────────────────────────────────────────────────────────

function vercelFiles(): DeployFile[] {
  return [
    {
      path: 'vercel.json',
      content: `{
  "framework": "nextjs",
  "buildCommand": "npm run build",
  "outputDirectory": ".next",
  "installCommand": "npm ci",
  "regions": ["iad1"],
  "headers": [
    {
      "source": "/api/(.*)",
      "headers": [
        { "key": "Access-Control-Allow-Origin", "value": "*" },
        { "key": "Access-Control-Allow-Methods", "value": "GET,POST,PUT,DELETE,OPTIONS" }
      ]
    }
  ]
}
`,
    },
    {
      path: '.vercelignore',
      content: `.env.local
.env*.local
node_modules
.next
generated-projects
`,
    },
  ];
}

// ─── Netlify ──────────────────────────────────────────────────────────────────

function netlifyFiles(): DeployFile[] {
  return [
    {
      path: 'netlify.toml',
      content: `[build]
  command = "npm run build"
  publish = ".next"

[build.environment]
  NODE_VERSION = "18"
  NPM_FLAGS = "--legacy-peer-deps"

[[plugins]]
  package = "@netlify/plugin-nextjs"

[[headers]]
  for = "/api/*"
  [headers.values]
    Access-Control-Allow-Origin = "*"
    Access-Control-Allow-Methods = "GET, POST, PUT, DELETE, OPTIONS"

[dev]
  command = "npm run dev"
  port = 3000
`,
    },
    {
      path: '.netlifyignore',
      content: `.env.local
.env*.local
generated-projects
`,
    },
  ];
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function prepareDeployment(projectPath: string, target: DeployTarget): Promise<DeployResult> {
  const readinessChecks = await checkReadiness(projectPath);
  const envVarsNeeded = await getEnvExampleVars(projectPath);
  const ready = readinessChecks.filter(c => !c.passed).length === 0;

  let files: DeployFile[];
  let deployCommand: string;
  let instructions: string[];

  switch (target) {
    case 'amplify':
      files = amplifyFiles(envVarsNeeded);
      deployCommand = 'npx @aws-amplify/cli hosting';
      instructions = [
        '1. Push this project to a GitHub/GitLab/Bitbucket repo',
        '2. Go to AWS Amplify Console > New App > Host web app',
        '3. Connect your repo and select the branch',
        '4. Amplify auto-detects the amplify.yml build settings',
        '5. Add env vars in Amplify Console > App settings > Environment variables',
        '6. Click Save and deploy',
      ];
      break;

    case 'vercel':
      files = vercelFiles();
      deployCommand = 'npx vercel deploy --prod';
      instructions = [
        '1. Install Vercel CLI: npm i -g vercel',
        '2. Run: vercel login',
        '3. From the project directory: vercel deploy --prod',
        'OR: Push to GitHub and connect the repo at vercel.com',
        '4. Add env vars in Vercel Dashboard > Project Settings > Environment Variables',
      ];
      break;

    case 'netlify':
      files = netlifyFiles();
      deployCommand = 'npx netlify deploy --prod';
      instructions = [
        '1. Install Netlify CLI: npm i -g netlify-cli',
        '2. Run: netlify login',
        '3. Run: netlify init (first time) or netlify deploy --prod',
        'OR: Push to GitHub and connect the repo at app.netlify.com',
        '4. Install the @netlify/plugin-nextjs plugin: npm install @netlify/plugin-nextjs',
        '5. Add env vars in Netlify Dashboard > Site Settings > Environment Variables',
      ];
      break;
  }

  return { target, ready, readinessChecks, files, envVarsNeeded, deployCommand, instructions };
}
