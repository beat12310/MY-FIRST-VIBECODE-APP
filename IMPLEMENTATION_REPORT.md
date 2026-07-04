# DWOMOH Vibe Code — AWS-Native Build Worker: Implementation Report

## 1. Root cause

Live generation on `dwomohvibe.com` failed because the generation pipeline runs inside
**AWS Amplify SSR (Lambda)**, which **cannot**:
- write generated files (filesystem is read-only except `/tmp`),
- run `npm install` or spawn processes,
- hold a long-running `next dev` server,
- be reached at `http://localhost:<port>` from the user's browser.

It works on localhost only because the Next.js server, the spawned dev server, and the
browser are the same machine. The browser error *"The string did not match the expected
pattern."* was a downstream Safari/WebKit symptom of the read-only-filesystem crash, not
the cause.

**Fix:** move the generate → write → install → run → preview pipeline onto an
**ECS/Fargate** worker (writable disk, npm, long-running servers) and have Amplify forward
`/api/chat` to it. Localhost is unaffected.

## 2. Files changed (existing code)

| File | Change | Localhost impact |
|---|---|---|
| `lib/workspace-paths.ts` *(new)* | `GENERATED_ROOT` = `WORKSPACE_DIR` or `<cwd>/generated-projects` | none (var unset) |
| `services/project-generator.ts` | use `GENERATED_ROOT`; earlier read-only write-probe guard | none |
| `services/project-store.ts` | use `GENERATED_ROOT` | none |
| `services/project-runner.ts` | use `GENERATED_ROOT` for server-state | none |
| `app/api/chat/route.ts` | **proxy shim** (forward all `/api/chat` to worker when `WORKER_URL` set & not the worker); **worker inbound secret guard**; `publicPreviewUrl()`; `previewUrl` in `start-server` + `open-project` responses | none (shim skipped when `WORKER_URL` unset) |
| `app/builder/page.tsx` | use server-returned `previewUrl` with `http://localhost:<port>` fallback (4 sites) | none (fallback path) |

> Also still present from the prior task: route-manifest reconciliation + honest read-only
> error guard in `project-generator.ts`.

## 3. Files created (worker + infrastructure)

| File | Purpose |
|---|---|
| `worker/Dockerfile` | Worker image: DWOMOH Next.js app + node/npm + Playwright/Chromium |
| `worker/edge-proxy.mjs` | PID 1; spawns `next start`; Host-routes `worker.*`→API, `preview.*`→generated app; proxies HMR websockets |
| `worker/README.md` | Worker overview + local sanity check |
| `infra/lib/worker-stack.ts` | CDK stack: VPC, ECS cluster, Fargate+ALB (HTTPS), ACM cert, Route 53 records, IAM task role (Bedrock+SES), Secrets Manager, autoscaling |
| `infra/bin/app.ts` / `infra/cdk.json` / `infra/package.json` / `infra/tsconfig.json` | CDK app scaffold |
| `scripts/deploy-worker.sh` | One command: build image + provision all AWS infra |
| `scripts/set-amplify-env.sh` | One command: merge `WORKER_URL`/`WORKER_SECRET`/`PREVIEW_DOMAIN` into Amplify env + redeploy |
| `scripts/smoke-test-worker.mjs` | End-to-end verification against the live worker |
| `PRODUCTION_BUILD_WORKER_DESIGN.md` | Full architecture (AWS-NATIVE section appended) |

## 4. Infrastructure the CDK stack creates

- **VPC** (2 AZ, 1 NAT gateway for npm egress)
- **ECS cluster** + **Fargate service** (1 vCPU / 2 GB, autoscale 1→4 on CPU)
- **Application Load Balancer** (HTTPS:443, HTTP→HTTPS redirect), health check `/__health`
- **ACM certificate** for `worker.dwomohvibe.com` + `preview.dwomohvibe.com` (DNS-validated)
- **Route 53** alias records: `worker` and `preview` → ALB
- **IAM task role**: `bedrock:InvokeModel*`, `ses:Send*` (no static AWS keys in the container)
- **Secrets Manager**: auto-generated `WORKER_SECRET`; optional `RAPIDAPI_KEY`
- **CloudWatch logs** + Container Insights

## 5. How the connections are wired

- **Amplify → Worker:** `/api/chat` proxied over HTTPS with `x-worker-secret`; user's Cognito `Authorization` header passed through.
- **Worker → Bedrock:** Fargate task role (no keys); region via env.
- **Worker → Cognito:** verifies forwarded tokens via `NEXT_PUBLIC_USER_POOL_ID` + region (`lib/server-auth.ts`).
- **Preview:** worker returns `https://preview.dwomohvibe.com`; ALB Host-routes it through the edge proxy to the running dev server.

## 6. Tests performed (in this environment)

- ✅ Syntax-checked all changed/new code: `route.ts`, `project-generator.ts`, `project-store.ts`, `project-runner.ts`, `workspace-paths.ts`, `edge-proxy.mjs`, `smoke-test-worker.mjs`, CDK `app.ts` + `worker-stack.ts` — all pass.
- ✅ Shell scripts pass `bash -n`.
- ✅ Confirmed no lingering references to the removed allowlist.
- ✅ Confirmed localhost-safety by construction: every change is gated on `WORKER_URL` / `WORKSPACE_DIR` / `WORKER_ROLE`, all unset locally → identical behavior.

## 7. Final verification — what remains (requires your AWS account)

I cannot run `cdk deploy` into your account, change live DNS, or click Generate on the
live site from here (no AWS credentials / no live access). These three commands complete
and verify it — no manual console clicking:

```bash
# 1. Build image + provision all infrastructure
DOMAIN_NAME=dwomohvibe.com RAPIDAPI_KEY=<key> NEXT_PUBLIC_USER_POOL_ID=<pool> \
  bash scripts/deploy-worker.sh

# 2. Point the live site at the worker + redeploy Amplify
AMPLIFY_APP_ID=<app-id> AMPLIFY_BRANCH=main bash scripts/set-amplify-env.sh

# 3. Verify end-to-end (write → npm install → start → public HTTPS preview)
WORKER_URL=https://worker.dwomohvibe.com \
WORKER_SECRET=<from stack output> PREVIEW_URL=https://preview.dwomohvibe.com \
  node scripts/smoke-test-worker.mjs
```

A `✅ Smoke test PASSED` means a user can visit dwomohvibe.com, enter a prompt, click
Generate, and get a working app served from a public HTTPS preview — no localhost, no
manual steps.

## 8. Known v1 limitations (tracked)

- One preview at a time per task (Phase 3 = Fargate task per session for concurrency).
- Ephemeral workspace (add EFS for persistence; projects are re-creatable from prompts).
- A few secondary Playwright-journey iframe URLs still use `localhost` (core generate→preview path is fixed).

## 9. Prerequisites you must have

- AWS CLI authenticated; Docker installed (for `deploy-worker.sh`).
- `dwomohvibe.com` is a Route 53 hosted zone in the same account.
- Your Amplify App ID and branch name.
- Bedrock model access enabled in the account/region.
