import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';

export interface GithubOidcStackProps extends cdk.StackProps {
  /** e.g. "beat12310/MY-FIRST-VIBECODE-APP" — no other repo may assume this role. */
  githubRepo: string;
  /** Only this branch may assume the role — PRs, other branches, forks cannot. */
  allowedBranch: string;
}

/**
 * DWOMOH Vibe Code — GitHub Actions OIDC role for the scheduled Level 2/3
 * real-AI verification workflows (.github/workflows/scheduled-verification.yml).
 *
 * No long-lived AWS keys are stored in GitHub at all — GitHub's OIDC token
 * is exchanged for short-lived AWS credentials at workflow run time via
 * sts:AssumeRoleWithWebIdentity, scoped by the trust policy below to:
 *   - this exact repo (beat12310/MY-FIRST-VIBECODE-APP), and
 *   - this exact branch (main) only — no PR, no fork, no other branch can
 *     ever assume this role, even with a valid GitHub Actions OIDC token.
 *
 * Permissions granted are intentionally minimal:
 *   - bedrock:InvokeModel / InvokeModelWithResponseStream on Anthropic
 *     models only (what services/bedrock.ts actually calls) — no other
 *     model vendors, no Bedrock admin actions (no CreateModel, no
 *     PutModelInvocationLoggingConfiguration, etc.)
 *   - Nothing else. The scheduled scripts (scripts/real-ai-verification.ts,
 *     scripts/golden-project-suite.ts) call services/engine/orchestrator.ts's
 *     runPipeline() directly with defaultOrchestratorDeps() — this path
 *     never touches DynamoDB/S3/the production credit-wallet or billing
 *     tables (those are wired in at the API-route layer, e.g.
 *     app/api/chat/route.ts, which this workflow never calls) and
 *     services/engine/learner.ts's inMemoryLearnerStore() used here is
 *     in-process only, not a real persisted store.
 *   - Explicit Deny statements below are defense-in-depth, not the only
 *     thing preventing broader access — the Allow list itself never grants
 *     iam:*, any *Delete* action, or any dynamodb/s3 action to begin with.
 */
export class GithubOidcStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GithubOidcStackProps) {
    super(scope, id, props);

    const { githubRepo, allowedBranch } = props;

    const provider = new iam.OpenIdConnectProvider(this, 'GithubOidcProvider', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });

    const role = new iam.Role(this, 'GithubActionsVerificationRole', {
      roleName: 'dwomoh-github-actions-verification',
      // Plain ASCII only: IAM role descriptions are validated against
      // [\t\n\r\x20-\x7E\xA1-\xFF]*, which does NOT include U+2014 (em-dash)
      // — confirmed live, this exact character failed CREATE_FAILED with
      // "1 validation error detected... Member must satisfy regular
      // expression pattern" during the first deploy attempt.
      description: 'Assumed by GitHub Actions (OIDC) for scheduled real-AI verification only - main branch of beat12310/MY-FIRST-VIBECODE-APP, Bedrock invoke access only.',
      maxSessionDuration: cdk.Duration.hours(6), // Level 3's golden suite can run 1-3+ hours
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
        StringLike: {
          // Only this exact repo + this exact branch — not PRs
          // (repo:owner/name:pull_request), not other branches, not forks.
          'token.actions.githubusercontent.com:sub': `repo:${githubRepo}:ref:refs/heads/${allowedBranch}`,
        },
      }),
    });

    role.addToPolicy(new iam.PolicyStatement({
      sid: 'BedrockInvokeAnthropicOnly',
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        // Cross-region inference profiles (what lib/constants.ts's
        // BEDROCK_MODELS actually uses — "us.anthropic.*" / "global.anthropic.*").
        `arn:aws:bedrock:*:${cdk.Stack.of(this).account}:inference-profile/*anthropic*`,
        // The underlying per-region foundation-model resources those
        // profiles route to — Anthropic models only, not other vendors.
        'arn:aws:bedrock:*::foundation-model/anthropic.*',
      ],
    }));

    // Defense-in-depth explicit denies, matching the requirement in plain
    // terms even though the allow-list above never grants these to begin
    // with: no admin, no delete, no production data access. IAM action
    // strings require a valid "service:ActionName" shape — a wildcard can't
    // span the colon (e.g. "*:Delete*" is invalid) — so this denies entire
    // services outright (iam, dynamodb, s3, rds, ec2, organizations) rather
    // than trying to pattern-match "any delete action across any service."
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'ExplicitDenyAdminAndProductionDataServices',
      effect: iam.Effect.DENY,
      actions: [
        'iam:*',
        'dynamodb:*',
        's3:*',
        'rds:*',
        'ec2:*',
        'organizations:*',
      ],
      resources: ['*'],
    }));

    new cdk.CfnOutput(this, 'RoleArn', {
      value: role.roleArn,
      description: 'Set as the role-to-assume input for aws-actions/configure-aws-credentials in .github/workflows/scheduled-verification.yml',
    });
  }
}
