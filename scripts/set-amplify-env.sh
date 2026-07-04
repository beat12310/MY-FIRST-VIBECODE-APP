#!/usr/bin/env bash
# Point the live Amplify app at the deployed build worker:
#  - reads WORKER_URL / WORKER_SECRET / PREVIEW_DOMAIN from the CDK stack
#  - merges them into the Amplify app's environment variables (does NOT wipe others)
#  - triggers a redeploy so the new env takes effect
#
# Usage:
#   bash scripts/set-amplify-env.sh
#   (override defaults: AMPLIFY_APP_ID=dxxxx AMPLIFY_BRANCH=main bash scripts/set-amplify-env.sh)
set -euo pipefail

# Defaults to the dwomohvibe.com platform app; override by exporting AMPLIFY_APP_ID.
# Defined with :- so it is NEVER unbound under `set -u`, however the script is invoked.
AMPLIFY_APP_ID="${AMPLIFY_APP_ID:-d2wdmbsbhl4qo8}"
AMPLIFY_BRANCH="${AMPLIFY_BRANCH:-main}"
STACK="DwomohBuildWorker"
echo "▶ Amplify app: $AMPLIFY_APP_ID  branch: $AMPLIFY_BRANCH"

out() { aws cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }

WORKER_URL="$(out WorkerUrl)"
PREVIEW_URL="$(out PreviewUrl)"
SECRET_ARN="$(out WorkerSecretArn)"
PREVIEW_DOMAIN="${PREVIEW_URL#https://preview.}"
WORKER_SECRET="$(aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" --query SecretString --output text)"

echo "▶ WORKER_URL=$WORKER_URL"
echo "▶ PREVIEW_DOMAIN=$PREVIEW_DOMAIN"

echo "▶ Merging env vars into Amplify app $AMPLIFY_APP_ID…"
EXISTING="$(aws amplify get-app --app-id "$AMPLIFY_APP_ID" --query 'app.environmentVariables' --output json)"
MERGED="$(echo "$EXISTING" | jq \
  --arg wu "$WORKER_URL" --arg ws "$WORKER_SECRET" --arg pd "$PREVIEW_DOMAIN" \
  '. + {WORKER_URL:$wu, WORKER_SECRET:$ws, PREVIEW_DOMAIN:$pd}')"

aws amplify update-app --app-id "$AMPLIFY_APP_ID" --environment-variables "$MERGED" >/dev/null
echo "✅ Env vars set."

echo "▶ Triggering redeploy of branch $AMPLIFY_BRANCH…"
aws amplify start-job --app-id "$AMPLIFY_APP_ID" --branch-name "$AMPLIFY_BRANCH" --job-type RELEASE \
  --query 'jobSummary.{status:status,jobId:jobId}' --output table

echo "✅ Done. Once the Amplify build finishes, run scripts/smoke-test-worker.mjs to verify."
