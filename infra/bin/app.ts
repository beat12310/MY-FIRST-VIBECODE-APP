#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { WorkerStack } from '../lib/worker-stack';
import { GithubOidcStack } from '../lib/github-oidc-stack';

const app = new cdk.App();

// Configuration via CDK context (-c key=value) or env, with sensible defaults.
const domainName       = app.node.tryGetContext('domainName')   || process.env.DOMAIN_NAME   || 'dwomohvibe.com';
const rapidApiKey      = app.node.tryGetContext('rapidApiKey')  || process.env.RAPIDAPI_KEY  || '';
const userPoolId       = app.node.tryGetContext('userPoolId')   || process.env.NEXT_PUBLIC_USER_POOL_ID || '';
const paystackSecretKey = app.node.tryGetContext('paystackSecretKey') || process.env.PAYSTACK_SECRET_KEY || '';
const adminEmails      = app.node.tryGetContext('adminEmails')  || process.env.ADMIN_EMAILS  || '';
const awsRegion        = process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION || 'us-east-1';

new WorkerStack(app, 'DwomohBuildWorker', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: awsRegion,
  },
  domainName,
  rapidApiKey,
  userPoolId,
  paystackSecretKey,
  adminEmails,
  description: 'DWOMOH Vibe Code — ECS/Fargate build worker (generate/install/preview/billing).',
});

new GithubOidcStack(app, 'DwomohGithubOidc', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: awsRegion,
  },
  githubRepo: 'beat12310/MY-FIRST-VIBECODE-APP',
  allowedBranch: 'main',
  description: 'DWOMOH Vibe Code — GitHub Actions OIDC role for scheduled real-AI verification (Bedrock invoke only, main branch only, no long-lived keys).',
});
