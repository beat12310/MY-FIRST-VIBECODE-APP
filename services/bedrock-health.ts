/**
 * Bedrock health check for the NEW engine Builder ONLY.
 *
 * Runs a fast, tiny probe (8 tokens, ~1–2s) BEFORE the full code-generation call so
 * a misconfigured model/region/credentials fails in ~20s with an EXACT reason,
 * instead of being masked by the orchestrator's 180s build-stage timeout.
 *
 * `checkBedrockEnv` is pure (no SDK) so it is unit-testable. `bedrockHealthCheck`
 * lazy-loads the AWS SDK only when it actually probes. This module is used only by
 * services/engine/builder.ts — it does not touch the old pipeline.
 */
import { BEDROCK_MODELS, BEDROCK_CONFIG, type BedrockTier } from '@/lib/constants';

export interface BedrockEnvCheck {
  modelId: string;
  region: string;
  accessKey: boolean;
  secretKey: boolean;
  missing: string[];
}

/** Pure: which model/region/credentials are configured, and what's missing. */
export function checkBedrockEnv(tier: BedrockTier = 'SONNET'): BedrockEnvCheck {
  const region = process.env.AWS_REGION || BEDROCK_CONFIG.DEFAULT_REGION;
  const accessKey = !!process.env.AWS_ACCESS_KEY_ID;
  const secretKey = !!process.env.AWS_SECRET_ACCESS_KEY;
  const modelId = BEDROCK_MODELS[tier];
  const missing: string[] = [];
  if (!accessKey) missing.push('AWS_ACCESS_KEY_ID');
  if (!secretKey) missing.push('AWS_SECRET_ACCESS_KEY');
  if (!modelId) missing.push(`BEDROCK_MODEL_${tier}`);
  return { modelId, region, accessKey, secretKey, missing };
}

export interface BedrockHealth {
  ok: boolean;
  modelId: string;
  region: string;
  credentials: { accessKey: boolean; secretKey: boolean };
  /** Did the Bedrock request actually start (vs. blocked on config)? */
  callStarted: boolean;
  /** Did Bedrock return a response? */
  responded: boolean;
  latencyMs?: number;
  error?: string;
  recommendation?: string;
}

function recommend(msg: string, modelId: string, region: string): string {
  const m = msg.toLowerCase();
  if (m.includes('accessdenied') || m.includes('access denied') || m.includes('not authorized') || m.includes('forbidden') || m.includes('403'))
    return `Model access denied for '${modelId}' in ${region}. In the AWS Bedrock console → Model access, enable this model, and ensure the IAM user allows bedrock:InvokeModel.`;
  if (m.includes('validation') || m.includes('invalid') || m.includes('not found') || m.includes('could not resolve') || m.includes('does not exist'))
    return `Model ID '${modelId}' may be invalid/unavailable in ${region}. Verify BEDROCK_MODEL_SONNET and AWS_REGION (Anthropic Bedrock IDs look like 'us.anthropic.claude-…-v1:0').`;
  if (m.includes('timeout') || m.includes('timed out') || m.includes('did not respond') || m.includes('etimedout') || m.includes('econnrefused') || m.includes('enotfound') || m.includes('fetch failed'))
    return `Bedrock endpoint in ${region} was unreachable/slow. Check network egress and that '${modelId}' exists in ${region}.`;
  if (m.includes('credential') || m.includes('signature') || m.includes('security token') || m.includes('token'))
    return `Credentials were rejected. Verify AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY belong to an account/region with Bedrock access.`;
  return `Check AWS_REGION (${region}), model ID ('${modelId}'), and Bedrock model access.`;
}

/** Probe Bedrock with a tiny request. Never throws — returns a structured diagnostic. */
export async function bedrockHealthCheck(tier: BedrockTier = 'SONNET', timeoutMs = 20_000, signal?: AbortSignal): Promise<BedrockHealth> {
  const env = checkBedrockEnv(tier);
  const base: BedrockHealth = {
    ok: false, modelId: env.modelId, region: env.region,
    credentials: { accessKey: env.accessKey, secretKey: env.secretKey },
    callStarted: false, responded: false,
  };

  if (env.missing.length > 0) {
    return { ...base, error: `Missing configuration: ${env.missing.join(', ')}`, recommendation: `Set ${env.missing.join(', ')} in .env.local` };
  }
  if (signal?.aborted) {
    return { ...base, error: 'Cancelled before probe started', recommendation: 'n/a — orchestrator stage was aborted' };
  }

  const t0 = Date.now();
  // Combine the caller's cancellation signal with this probe's own timeout so BOTH
  // physically abort the in-flight request via the AWS SDK's abortSignal option,
  // instead of merely giving up on waiting for it while it keeps running.
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener('abort', onExternalAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { BedrockRuntimeClient, InvokeModelCommand } = await import('@aws-sdk/client-bedrock-runtime');
    const client = new BedrockRuntimeClient({
      region: env.region,
      credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID as string, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY as string },
      requestHandler: { requestTimeout: timeoutMs },
    });
    const command = new InvokeModelCommand({
      modelId: env.modelId, contentType: 'application/json', accept: 'application/json',
      body: JSON.stringify({ anthropic_version: BEDROCK_CONFIG.ANTHROPIC_VERSION, max_tokens: 8, temperature: 0, messages: [{ role: 'user', content: 'ping' }] }),
    });
    console.log(`[bedrock-health] probing model=${env.modelId} region=${env.region} (timeout ${timeoutMs}ms)`);
    base.callStarted = true;
    await client.send(command, { abortSignal: controller.signal });
    base.responded = true;
    base.latencyMs = Date.now() - t0;
    console.log(`[bedrock-health] OK — responded in ${base.latencyMs}ms`);
    return { ...base, ok: true };
  } catch (e) {
    const msg = signal?.aborted
      ? 'Cancelled — orchestrator stage was aborted'
      : controller.signal.aborted
        ? `Bedrock did not respond within ${timeoutMs / 1000}s`
        : e instanceof Error ? e.message : String(e);
    console.error(`[bedrock-health] FAILED — ${msg}`);
    return { ...base, latencyMs: Date.now() - t0, error: msg, recommendation: recommend(msg, env.modelId, env.region) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}
