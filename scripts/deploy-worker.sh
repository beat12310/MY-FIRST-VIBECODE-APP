#!/usr/bin/env bash
# Deploy the DWOMOH build worker to AWS (ECS/Fargate + ALB + DNS + TLS).
# Builds the container, provisions all infrastructure, runs end-to-end.
#
# Prereqs (one time): AWS CLI + Docker installed and `aws sts get-caller-identity` works,
# and dwomohvibe.com is a Route 53 hosted zone in this account.
#
# Usage:
#   DOMAIN_NAME=dwomohvibe.com RAPIDAPI_KEY=xxx NEXT_PUBLIC_USER_POOL_ID=us-east-1_xxx \
#     bash scripts/deploy-worker.sh
set -euo pipefail

DOMAIN_NAME="${DOMAIN_NAME:-dwomohvibe.com}"
RAPIDAPI_KEY="${RAPIDAPI_KEY:-}"
USER_POOL_ID="${NEXT_PUBLIC_USER_POOL_ID:-}"
REGION="${AWS_REGION:-us-east-1}"

echo "▶ Deploying DWOMOH build worker"
echo "  domain=${DOMAIN_NAME} region=${REGION} rapidApiKey=$([ -n "$RAPIDAPI_KEY" ] && echo set || echo unset)"

cd "$(dirname "$0")/../infra"

echo "▶ Installing CDK deps…"
npm install

echo "▶ Bootstrapping CDK (idempotent)…"
npx cdk bootstrap "aws://$(aws sts get-caller-identity --query Account --output text)/${REGION}" >/dev/null

echo "▶ Building image + deploying stack (this builds the Docker image and can take 10–20 min the first time)…"
npx cdk deploy --require-approval never \
  -c domainName="${DOMAIN_NAME}" \
  -c rapidApiKey="${RAPIDAPI_KEY}" \
  -c userPoolId="${USER_POOL_ID}"

echo "✅ Worker deployed. Outputs:"
aws cloudformation describe-stacks --stack-name DwomohBuildWorker \
  --query "Stacks[0].Outputs" --output table

echo ""
echo "Next: run scripts/set-amplify-env.sh to point dwomohvibe.com at the worker."
