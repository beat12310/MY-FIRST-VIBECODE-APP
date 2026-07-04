import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import { ApplicationProtocol } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';

export interface WorkerStackProps extends cdk.StackProps {
  /** Apex domain, e.g. dwomohvibe.com (must already have a Route 53 hosted zone). */
  domainName: string;
  /** RapidAPI key for generated-app integrations. Optional — stored in Secrets Manager. */
  rapidApiKey?: string;
  /** Cognito user pool id, so the worker can verify forwarded auth tokens. */
  userPoolId?: string;
  /** Paystack secret key (test or live). Optional — stored in Secrets Manager. */
  paystackSecretKey?: string;
  /** Comma-separated admin emails for the revenue dashboard. */
  adminEmails?: string;
}

export class WorkerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WorkerStackProps) {
    super(scope, id, props);

    const { domainName, rapidApiKey, userPoolId, paystackSecretKey, adminEmails } = props;
    const workerHost = `worker.${domainName}`;
    const previewHost = `preview.${domainName}`;

    // ── DNS + TLS ─────────────────────────────────────────────────────────────
    const zone = route53.HostedZone.fromLookup(this, 'Zone', { domainName });
    const certificate = new acm.Certificate(this, 'WorkerCert', {
      domainName: workerHost,
      subjectAlternativeNames: [previewHost],
      validation: acm.CertificateValidation.fromDns(zone),
    });

    // ── Network + cluster ──────────────────────────────────────────────────────
    // 1 NAT gateway keeps cost down (~$32/mo) while allowing npm/registry egress.
    const vpc = new ec2.Vpc(this, 'Vpc', { maxAzs: 2, natGateways: 1 });
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc, containerInsights: true });

    // ── Billing table (subscriptions, wallet, ledger, payments, domains) ────────
    // Single-table design: pk + sk. Pay-per-request so there's no idle cost.
    const billingTable = new dynamodb.Table(this, 'BillingTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // never auto-delete billing data
    });

    // ── Secrets ────────────────────────────────────────────────────────────────
    // WORKER_SECRET is auto-generated; the deploy script copies it to Amplify so the
    // shim and the worker share the same value.
    const workerSecret = new secretsmanager.Secret(this, 'WorkerSecret', {
      description: 'Shared secret authenticating Amplify → build worker requests',
      generateSecretString: { excludePunctuation: true, passwordLength: 40 },
    });

    const rapidApiSecret = rapidApiKey
      ? new secretsmanager.Secret(this, 'RapidApiKey', {
          description: 'RapidAPI key for generated-app integrations',
          secretStringValue: cdk.SecretValue.unsafePlainText(rapidApiKey),
        })
      : undefined;

    const paystackSecret = paystackSecretKey
      ? new secretsmanager.Secret(this, 'PaystackSecretKey', {
          description: 'Paystack secret key (used for API calls + webhook HMAC verification)',
          secretStringValue: cdk.SecretValue.unsafePlainText(paystackSecretKey),
        })
      : undefined;

    // ── Worker image (built from this repo + worker/Dockerfile during deploy) ────
    // Pinned to ARM64 so the image matches the Fargate runtimePlatform below. The
    // common "exited 255, no logs" failure is an arch mismatch: a Mac (Apple Silicon)
    // builds arm64 by default while Fargate defaults to x86_64, so the container can't
    // exec. Pinning BOTH to ARM64 makes it deterministic (native on Apple Silicon,
    // and cheaper Graviton compute).
    const image = ecs.ContainerImage.fromAsset(path.join(__dirname, '..', '..'), {
      file: 'worker/Dockerfile',
      platform: Platform.LINUX_ARM64,
    });

    // ── Task role: Bedrock (AI) + SES (email), least-privilege ──────────────────
    const taskRole = new iam.Role(this, 'WorkerTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: ['*'],
    }));
    taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: ['*'],
    }));
    // Read/write the billing table (subscriptions, wallet, ledger, payments, domains).
    billingTable.grantReadWriteData(taskRole);

    const environment: Record<string, string> = {
      WORKER_ROLE: 'worker',
      WORKSPACE_DIR: '/workspace',
      PREVIEW_DOMAIN: domainName,
      NODE_ENV: 'production',
      AWS_REGION: this.region,
      NEXT_PUBLIC_AWS_REGION: this.region,
      BILLING_TABLE: billingTable.tableName,
      ...(adminEmails ? { ADMIN_EMAILS: adminEmails } : {}),
      ...(userPoolId ? { NEXT_PUBLIC_USER_POOL_ID: userPoolId } : {}),
    };

    const secrets: Record<string, ecs.Secret> = {
      WORKER_SECRET: ecs.Secret.fromSecretsManager(workerSecret),
      ...(rapidApiSecret ? { RAPIDAPI_KEY: ecs.Secret.fromSecretsManager(rapidApiSecret) } : {}),
      ...(paystackSecret ? { PAYSTACK_SECRET_KEY: ecs.Secret.fromSecretsManager(paystackSecret) } : {}),
    };

    // ── Fargate service behind a public ALB (HTTPS) ─────────────────────────────
    const svc = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'Worker', {
      cluster,
      cpu: 1024,
      memoryLimitMiB: 2048,
      desiredCount: 1,
      publicLoadBalancer: true,
      protocol: ApplicationProtocol.HTTPS,
      redirectHTTP: true,
      certificate,
      domainName: workerHost,
      domainZone: zone,
      healthCheckGracePeriod: cdk.Duration.seconds(180),
      // Must match the image arch (ARM64) — otherwise the container exits 255.
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      taskImageOptions: {
        image,
        containerPort: 8080,
        taskRole,
        environment,
        secrets,
        // Explicit log group so container output (and crash reasons) always land in CloudWatch.
        logDriver: ecs.LogDrivers.awsLogs({
          streamPrefix: 'dwomoh-worker',
          logRetention: logs.RetentionDays.TWO_WEEKS,
        }),
      },
    });

    // Health check hits the edge proxy's fast-path.
    svc.targetGroup.configureHealthCheck({
      path: '/__health',
      healthyHttpCodes: '200',
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(5),
    });

    // Long generations need generous draining/idle timeout.
    svc.loadBalancer.setAttribute('idle_timeout.timeout_seconds', '900');

    // Autoscale on CPU (Phase 2 readiness; v1 effectively runs 1 task).
    const scaling = svc.service.autoScaleTaskCount({ minCapacity: 1, maxCapacity: 4 });
    scaling.scaleOnCpuUtilization('CpuScaling', { targetUtilizationPercent: 65 });

    // preview.<domain> → same ALB (edge proxy routes by Host header).
    new route53.ARecord(this, 'PreviewAlias', {
      zone,
      recordName: 'preview',
      target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(svc.loadBalancer)),
    });

    // ── Outputs (consumed by scripts/set-amplify-env.sh) ────────────────────────
    new cdk.CfnOutput(this, 'WorkerUrl', { value: `https://${workerHost}` });
    new cdk.CfnOutput(this, 'PreviewUrl', { value: `https://${previewHost}` });
    new cdk.CfnOutput(this, 'WorkerSecretArn', { value: workerSecret.secretArn });
    new cdk.CfnOutput(this, 'AlbDnsName', { value: svc.loadBalancer.loadBalancerDnsName });
    // Set this same value as BILLING_TABLE on the Amplify app too — the Paystack
    // webhook runs on Amplify and must read/write the SAME table as the worker.
    new cdk.CfnOutput(this, 'BillingTableName', { value: billingTable.tableName });
  }
}
