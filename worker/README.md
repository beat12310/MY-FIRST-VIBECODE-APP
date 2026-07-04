# DWOMOH Build Worker (AWS-native)

Runs the generation pipeline (write files → npm install → `next dev` → preview) on
**ECS/Fargate**, because AWS Amplify's Lambda runtime is read-only and can't spawn
processes. Amplify forwards disk/process actions here; AI-only actions stay on Amplify.

See `../PRODUCTION_BUILD_WORKER_DESIGN.md` (section "AWS-NATIVE IMPLEMENTATION") for the
full architecture and rationale.

## What's here
- `Dockerfile` — worker image (Next.js app + node/npm + Playwright).
- `edge-proxy.mjs` — PID 1; spawns `next start` and routes by Host: `worker.*` → API, `preview.*` → the running generated app.

## Deploy
```bash
DOMAIN_NAME=dwomohvibe.com RAPIDAPI_KEY=... NEXT_PUBLIC_USER_POOL_ID=... \
  bash ../scripts/deploy-worker.sh
AMPLIFY_APP_ID=... AMPLIFY_BRANCH=main bash ../scripts/set-amplify-env.sh
```

## Env the container expects
| Var | Set by | Meaning |
|---|---|---|
| `WORKER_ROLE=worker` | Dockerfile/CDK | enables inbound-secret guard |
| `WORKSPACE_DIR=/workspace` | Dockerfile/CDK | writable project root |
| `PREVIEW_DOMAIN` | CDK | builds `https://preview.<domain>` |
| `WORKER_SECRET` | CDK (Secrets Manager) | shared secret with Amplify |
| `RAPIDAPI_KEY` | CDK (Secrets Manager) | generated-app integrations |
| `NEXT_PUBLIC_USER_POOL_ID`, `AWS_REGION` | CDK | Cognito token verification + Bedrock |

AWS credentials are **not** set as env vars — Bedrock/SES use the Fargate **task role**.

## Local sanity check (optional)
```bash
docker build -f worker/Dockerfile -t dwomoh-worker .
docker run --rm -p 8080:8080 -e WORKER_SECRET=test -e WORKSPACE_DIR=/workspace dwomoh-worker
curl localhost:8080/__health   # → ok
```
