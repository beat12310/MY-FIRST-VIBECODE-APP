# DWOMOH Vibe Code — Production Build-Worker Design

**Problem confirmed by code inspection.** Live generation on `dwomohvibe.com` (AWS Amplify SSR = Lambda) attempts four things Lambda forbids:

| Operation | Where in code | Why it fails on Amplify/Lambda |
|---|---|---|
| **Write project files** | `services/project-generator.ts` → `generateProject()` writes under `process.cwd()/generated-projects/` | App filesystem is **read-only**; only `/tmp` is writable |
| **`npm install`** | `services/project-runner.ts` → `installDependencies()` `spawn('npm', …)` | No npm, no writable cwd, request-scoped runtime |
| **Start dev server** | `services/project-runner.ts` → `startDevServer()` `spawn('npm','run','dev','-p',port)`; also `execSync('lsof …')` | Lambda can't hold a long-running server or run `lsof` |
| **Preview** | `app/builder/page.tsx` → `setPreviewUrl(\`http://localhost:${port}\`)` (10+ sites) | `localhost` is the user's browser, not the server — dead iframe |

It works locally only because the Next.js server, the spawned dev server, and the browser are the same machine. The `claude-bridge` route already proves the intent: it is **hard-disabled in production** and spawns the Claude Code CLI with `HOME=/Users/ghanasongs`.

---

## Target architecture

```
                         (AWS Amplify — unchanged hosting)
   Browser ──HTTPS──►  DWOMOH frontend  ──►  /api/chat
   (builder UI)        + AI-only actions      (Bedrock calls: generate, logo, converse)
                                │
                                │  filesystem/process actions
                                ▼  (HTTPS + shared secret)
                       ┌────────────────────────────────────────┐
                       │      BUILD WORKER  (container/VM)        │
                       │  writable disk · npm · long-run servers  │
                       │                                          │
                       │  POST /jobs        → create workspace    │
                       │  POST /jobs/:id/install                  │
                       │  POST /jobs/:id/build                    │
                       │  POST /jobs/:id/preview → boots server   │
                       │  reverse proxy (Caddy/Traefik):          │
                       │   preview-<id>.dwomohvibe.com → :port    │
                       └────────────────────────────────────────┘
                                │
                                ▼
   Browser ◄──HTTPS── https://preview-<jobId>.dwomohvibe.com  (real preview URL)
```

**Key idea:** the worker runs the *same code you already have* (`project-generator.ts`, `project-runner.ts`, repair, verify), on a host where disk + processes work. Amplify becomes an orchestrator that forwards the disk/process actions and serves the AI-only ones.

---

## The smallest change (no rewrite)

Your builder already calls everything through one helper:

```ts
const api = (body) => fetch('/api/chat', { method:'POST', body: JSON.stringify(body) })
```

and `/api/chat` is a big `if (action === '…')` switch. So the minimal change is a **proxy shim**, not new logic.

### Step 1 — Split actions by whether they touch the project on disk

**Stay on Amplify (stateless, Bedrock-only):**
`generate`, `converse`, `research`, `browse-web`, `analyze-image`, `generate-logo`, `refine-logo`, `think`, `think-agentic`, `discover`.
(These return JSON/text and never write a project to disk. `generate` already just returns files in the response.)

**Forward to the worker (need the project on disk / a process):**
`create`, `edit`, `apply-generated-files`, `install`, `install-package`, `pre-scan-imports`, `check-installed`, `validate`, `check-ts`, `fix-errors`, `clear-cache`, `start-server`, `wait-for-server`, `get-server-logs`, `check-preview-health`, `verify-app`, `debug-project`, `list-projects`, `open-project`, `save-design-baseline`, `restore-baseline-files`, `check-baseline-drift`, `verify-auth-flow`, `run-browser-journey`, all `browser-*`, and the project-memory actions.

### Step 2 — Add a proxy at the top of `/api/chat`

```ts
const WORKER_URL = process.env.WORKER_URL;            // set on Amplify, UNSET on the worker
const WORKER_ACTIONS = new Set(['create','edit','apply-generated-files','install',
  'install-package','pre-scan-imports','check-installed','validate','check-ts',
  'fix-errors','clear-cache','start-server','wait-for-server','get-server-logs',
  'check-preview-health','verify-app','debug-project','list-projects','open-project',
  'save-design-baseline','restore-baseline-files','check-baseline-drift',
  'verify-auth-flow','run-browser-journey','browser-screenshot','browser-click',
  'browser-fill','browser-debug']);

export async function POST(request: NextRequest) {
  const body = await request.json();
  if (WORKER_URL && WORKER_ACTIONS.has(body.action)) {
    const r = await fetch(`${WORKER_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-worker-secret': process.env.WORKER_SECRET! },
      body: JSON.stringify(body),
    });
    return new NextResponse(await r.text(), { status: r.status, headers: { 'Content-Type':'application/json' } });
  }
  // …existing switch runs unchanged (locally, and on the worker itself where WORKER_URL is unset)
}
```

On localhost `WORKER_URL` is unset → **everything runs exactly as today** (this is why localhost is untouched). On Amplify it forwards; on the worker `WORKER_URL` is unset so the real code executes.

### Step 3 — Deploy the *same repo* as the worker

Containerize the existing app (it already has a `Dockerfile`-able Next.js). Host it where disk + processes work: **Render, Railway, Fly.io, or AWS Fargate**. The worker needs Node, npm, and (for `verify-app`) Playwright/Chromium. Give it AWS creds for Bedrock too, since forwarded `fix-errors`/`verify-app` call the model.

### Step 4 — Real preview URLs (replace `http://localhost:${port}`)

This is the only client change. Today 10+ sites build `http://localhost:${port}`. Centralize it:

```ts
// returned by the worker's start-server/verify-app responses
const previewBase = serverResult.previewUrl ?? `http://localhost:${port}`; // fallback = local dev
setPreviewUrl(previewBase + (event?.url ?? ''));
```

The worker assigns each job a port and registers a route in a **reverse proxy** (Caddy or Traefik) so:

```
preview-<jobId>.dwomohvibe.com  →  127.0.0.1:<port>
```

DNS: wildcard `*.dwomohvibe.com` → worker. TLS: Caddy auto-provisions wildcard certs via Let's Encrypt. The worker returns `previewUrl: "https://preview-<jobId>.dwomohvibe.com"` in its `start-server` response; the client just uses it.

### Step 5 — Move the workspace root off cwd (worker-side hardening)

On the worker, write projects under a dedicated writable volume, not the app bundle:

```ts
// services/constants — single source of truth
export const GENERATED_ROOT = process.env.WORKSPACE_DIR
  ?? join(process.cwd(), 'generated-projects');   // localhost default unchanged
```

Then point `project-generator.ts`, `project-store.ts`, and `project-runner.ts` at `GENERATED_ROOT`. (Already low-risk: they share one constant today.)

---

## What changes vs. what you keep

**Keep unchanged:** `project-generator.ts` logic, `project-runner.ts`, the repair loop, `verify-app`, `route-reconciler.ts`, the entire builder UI flow and its `action` verbs.

**Add/modify (small):**
1. Proxy shim in `/api/chat` (~30 lines).
2. `WORKER_URL`, `WORKER_SECRET`, `WORKSPACE_DIR` env vars.
3. One `GENERATED_ROOT` constant wired into 3 files.
4. Centralized `previewUrl` on the client (replace ~10 `http://localhost:${port}` literals).
5. Worker deployment: container + reverse proxy + wildcard DNS/TLS.

That's the whole evolution — a topology + plumbing change, not a rewrite.

---

## Rollout phases

- **Phase 1 — Single persistent worker (smallest viable).** One container on Render/Railway/Fly + Caddy reverse proxy + wildcard subdomain. Proves end-to-end live generation with public previews. Good for early users.
- **Phase 2 — Job queue + cleanup.** Add a queue (SQS/Redis) so concurrent generations don't fight over CPU; reap idle preview servers after N minutes; cap disk per job.
- **Phase 3 — Per-job isolation (scale + safety).** One ephemeral sandbox per generation via **Fly Machines, e2b.dev, Modal, or Daytona**. Each job gets its own container, dies after preview expires.

---

## Security — do not skip

You will be running **AI-generated code and `npm install`** on your infrastructure. That is arbitrary code execution. The worker must:
- run each project as an unprivileged user inside a container with **no AWS/platform credentials mounted** into the generated project;
- restrict outbound network (npm registry + needed APIs only);
- enforce CPU/memory/disk/time limits per job;
- authenticate every Amplify→worker call with `WORKER_SECRET` (and ideally mTLS or a private network), never expose the worker's `/api/chat` publicly without it.

---

## First concrete step

Stand up the worker as Phase 1: deploy this repo as a container to one host, add Caddy with `*.dwomohvibe.com`, set `WORKER_URL`/`WORKER_SECRET` on Amplify, add the proxy shim, and centralize the preview URL. Everything else is reuse.

---

# AWS-NATIVE IMPLEMENTATION (ECS/Fargate) — IMPLEMENTED

Decision: DWOMOH stays 100% AWS. The worker runs on **ECS/Fargate** behind an **ALB**, with **ACM** TLS and **Route 53** DNS, talking to **Bedrock** (AI) and verifying **Cognito** tokens forwarded from Amplify. This section documents what was built in this repo.

## Topology

```
Browser ──HTTPS──► dwomohvibe.com (Amplify SSR: frontend, auth, dashboard)
                     │  /api/chat forwarded wholesale to the worker (deny-by-default)
                     │  Bedrock + disk + npm all run on the worker
                     ▼
        https://worker.dwomohvibe.com  (ALB :443, ACM cert)
                     │  target group → Fargate task :8080 (edge proxy)
                     ▼
   ┌──────────────── Fargate task (cpu 1024 / mem 2048) ────────────────┐
   │ edge-proxy.mjs (PID 1, :8080)                                       │
   │   • Host worker.*  → Next.js app :3000  (this repo, WORKER_ROLE=worker) │
   │   • Host preview.* → current generated dev server (port from         │
   │                       /workspace/.server-state.json)                 │
   │ Next app writes projects to WORKSPACE_DIR=/workspace, runs npm,      │
   │ spawns `next dev`, runs Playwright verify-app                        │
   │ IAM task role: bedrock:InvokeModel*, ses:Send*                       │
   └─────────────────────────────────────────────────────────────────────┘
                     ▲
   Browser ◄──HTTPS── https://preview.dwomohvibe.com  (same ALB, Host-routed)
```

## How each requirement is met

- **Writable workspace:** `WORKSPACE_DIR=/workspace` on the task (writable); localhost stays `<cwd>/generated-projects` because the var is unset. One constant, `lib/workspace-paths.ts → GENERATED_ROOT`, feeds the generator, store, and runner.
- **npm install + dev server:** run inside the Fargate container (full Linux, node+npm, egress via 1 NAT gateway). The edge proxy spawns `next start` for the DWOMOH app; the app spawns `next dev` per generated project.
- **Public preview:** ALB host-routing. `preview.dwomohvibe.com` → edge proxy → the running dev server. The server returns `previewUrl` and the client uses it (localhost fallback preserved).
- **Bedrock:** the task role grants `bedrock:InvokeModel*`; the SDK uses the task role automatically (no static keys in the container).
- **Cognito:** Amplify forwards the user's `Authorization: Bearer` token; the worker verifies it via `NEXT_PUBLIC_USER_POOL_ID` + region (already in `lib/server-auth.ts`). Worker-to-worker calls are additionally gated by `WORKER_SECRET`.
- **Security:** generated code runs in the container under the task role only (no platform secrets injected into generated projects); inbound disk/process actions require `x-worker-secret`; egress limited to NAT.

## Files

| File | Purpose |
|---|---|
| `worker/Dockerfile` | Worker image: Next.js app + node/npm + Playwright/Chromium |
| `worker/edge-proxy.mjs` | Host-based reverse proxy (API vs preview) + HMR websocket upgrade |
| `infra/lib/worker-stack.ts` | CDK: VPC, ECS, Fargate+ALB, ACM, Route 53, IAM, Secrets, autoscaling |
| `infra/bin/app.ts`, `infra/cdk.json`, `infra/package.json`, `infra/tsconfig.json` | CDK app scaffolding |
| `scripts/deploy-worker.sh` | One command: build image + deploy all infra |
| `scripts/set-amplify-env.sh` | One command: point Amplify at the worker + redeploy |
| `scripts/smoke-test-worker.mjs` | End-to-end verification against the live worker |
| `lib/workspace-paths.ts` | `GENERATED_ROOT` (localhost-safe) |
| `app/api/chat/route.ts` | Proxy shim + worker inbound guard + `previewUrl` in responses |

## Deploy (two commands)

```bash
# 1) Build the image and stand up all AWS infra
DOMAIN_NAME=dwomohvibe.com \
RAPIDAPI_KEY=<your key> \
NEXT_PUBLIC_USER_POOL_ID=<your cognito pool id> \
  bash scripts/deploy-worker.sh

# 2) Point the live site at the worker and redeploy Amplify
AMPLIFY_APP_ID=<your amplify app id> AMPLIFY_BRANCH=main \
  bash scripts/set-amplify-env.sh

# 3) Verify end-to-end
WORKER_URL=https://worker.dwomohvibe.com \
WORKER_SECRET=$(aws secretsmanager get-secret-value \
  --secret-id $(aws cloudformation describe-stacks --stack-name DwomohBuildWorker \
  --query "Stacks[0].Outputs[?OutputKey=='WorkerSecretArn'].OutputValue" --output text) \
  --query SecretString --output text) \
PREVIEW_URL=https://preview.dwomohvibe.com \
  node scripts/smoke-test-worker.mjs
```

## Known v1 limitations (tracked for later)

- **One preview at a time per task.** `project-runner` tracks a single server-state; concurrent users need **Phase 3** (one Fargate task per session via `RunTask`, wildcard `*.dwomohvibe.com`). v1 is correct for early traffic.
- **Workspace is ephemeral.** Fargate task storage resets on redeploy; projects are re-creatable from prompts. Add EFS if persistence is needed.
- **Live Playwright-journey iframe navigation** (secondary verify-app UX) still builds `localhost` URLs in a few spots; the core generate→preview path uses the public URL.
