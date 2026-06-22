import {
  BedrockRuntimeClient,
  InvokeModelWithResponseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { BEDROCK_CONFIG, BEDROCK_MODELS, BEDROCK_FALLBACK_CHAINS, type BedrockTier } from '@/lib/constants';
import { logError, ErrorCode, createError } from '@/lib/error-handler';

export type MultimodalBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string | MultimodalBlock[];
}

// ─── Error classification ──────────────────────────────────────────────────

export type BedrockErrorKind =
  | 'NETWORK_INTERRUPTION'
  | 'TIMEOUT'
  | 'THROTTLED'
  | 'AUTH_ERROR'
  | 'QUOTA_EXCEEDED'
  | 'INVALID_RESPONSE'
  | 'UNKNOWN';

export function classifyBedrockError(message: string): BedrockErrorKind {
  const m = message.toLowerCase();
  if (
    m.includes('connection closed') ||
    m.includes('econnreset') ||
    m.includes('socket hang up') ||
    m.includes('econnrefused') ||
    m.includes('epipe') ||
    m.includes('mid-response') ||
    m.includes('aborted') ||
    m.includes('network error') ||
    m.includes('fetch failed')
  ) return 'NETWORK_INTERRUPTION';
  if (
    m.includes('timeout') ||
    m.includes('timed out') ||
    m.includes('etimedout') ||
    m.includes('bedrock_timeout')
  ) return 'TIMEOUT';
  if (
    m.includes('throttl') ||
    m.includes('too many requests') ||
    m.includes('limitexceeded') ||
    m.includes('429')
  ) return 'THROTTLED';
  if (
    m.includes('credential') ||
    m.includes('unauthorized') ||
    m.includes('forbidden') ||
    m.includes('accessdenied') ||
    m.includes('403') ||
    m.includes('401')
  ) return 'AUTH_ERROR';
  if (
    m.includes('quota') ||
    m.includes('limit exceeded') ||
    m.includes('service quota')
  ) return 'QUOTA_EXCEEDED';
  if (
    m.includes('invalid') ||
    m.includes('malformed') ||
    m.includes('no content')
  ) return 'INVALID_RESPONSE';
  return 'UNKNOWN';
}

export function bedrockErrorMessage(kind: BedrockErrorKind, attempt: number, max: number): string {
  switch (kind) {
    case 'NETWORK_INTERRUPTION':
      return `Network connection interrupted (attempt ${attempt}/${max}) — retrying…`;
    case 'TIMEOUT':
      return `Request timed out (attempt ${attempt}/${max}) — retrying…`;
    case 'THROTTLED':
      return `Rate limit hit (attempt ${attempt}/${max}) — waiting before retry…`;
    case 'AUTH_ERROR':
      return 'Authentication failed — check AWS credentials in .env.local';
    case 'QUOTA_EXCEEDED':
      return 'Bedrock service quota exceeded — try again in a few minutes';
    case 'INVALID_RESPONSE':
      return `AI returned an unexpected format (attempt ${attempt}/${max}) — retrying…`;
    default:
      return `Unexpected error (attempt ${attempt}/${max}) — retrying…`;
  }
}

// ─── Retry configuration ───────────────────────────────────────────────────

const MAX_RETRIES       = 3;
const RETRY_DELAYS_MS   = [2_000, 4_000, 8_000]; // 2s → 4s → 8s exponential backoff
const TIMEOUT_CHAT_MS   =  60_000;  // 60 s — chat responses are short
const TIMEOUT_BUILD_MS  = 270_000;  // 4.5 min — code-gen can be very large

// ─── Client singleton ──────────────────────────────────────────────────────

let bedrockClient: BedrockRuntimeClient | null = null;

function initializeClient(): BedrockRuntimeClient {
  if (bedrockClient) return bedrockClient;

  const region          = process.env.AWS_REGION         || BEDROCK_CONFIG.DEFAULT_REGION;
  const accessKeyId     = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

  if (!accessKeyId || !secretAccessKey) {
    throw createError(
      ErrorCode.MISSING_CREDENTIALS,
      'AWS credentials not configured. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in .env.local',
      401
    );
  }

  bedrockClient = new BedrockRuntimeClient({
    region,
    credentials: { accessKeyId, secretAccessKey },
    // Increase socket timeout so long builds don't get cut by the SDK default
    requestHandler: { requestTimeout: TIMEOUT_BUILD_MS + 30_000 },
  });
  return bedrockClient;
}

// ─── Streaming core ────────────────────────────────────────────────────────
// Using InvokeModelWithResponseStreamCommand instead of InvokeModelCommand.
// Streaming reads the response in small chunks as the model generates them,
// so a connection drop only loses the last partial chunk — not the entire body.

async function invokeStreaming(
  messages:     ConversationTurn[],
  systemPrompt: string,
  maxTokens:    number,
  modelId:      string = BEDROCK_MODELS.HAIKU
): Promise<string> {
  const client  = initializeClient();
  const command = new InvokeModelWithResponseStreamCommand({
    modelId,
    contentType: 'application/json',
    accept:      'application/json',
    body: JSON.stringify({
      anthropic_version: BEDROCK_CONFIG.ANTHROPIC_VERSION,
      max_tokens:        maxTokens,
      temperature:       BEDROCK_CONFIG.TEMPERATURE,
      system:            systemPrompt,
      messages,
    }),
  });

  const response = await client.send(command);
  if (!response.body) throw new Error('Empty response stream from Bedrock');

  const decoder = new TextDecoder();
  let text = '';

  for await (const event of response.body) {
    if (event.chunk?.bytes) {
      try {
        const chunk = JSON.parse(decoder.decode(event.chunk.bytes));
        if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
          text += chunk.delta.text ?? '';
        }
        if (chunk.type === 'message_stop') break;
      } catch {
        // Malformed chunk — skip and keep accumulating
      }
    }
  }

  if (!text) throw new Error('Bedrock stream produced no content — invalid response');
  return text;
}

// ─── Retry wrapper ─────────────────────────────────────────────────────────
// 3 attempts, exponential backoff, per-call timeout.
// Auth errors are never retried (they won't self-resolve).

async function invokeWithRetry(
  messages:     ConversationTurn[],
  systemPrompt: string,
  maxTokens:    number,
  context:      string,
  modelId:      string = BEDROCK_MODELS.HAIKU
): Promise<string> {
  const timeoutMs = maxTokens > 5_000 ? TIMEOUT_BUILD_MS : TIMEOUT_CHAT_MS;
  let lastErr: Error = new Error('Unknown Bedrock error');

  console.log(`[Bedrock][${context}] model=${modelId.split('.').pop()} maxTokens=${maxTokens}`);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 1) {
      const delay = RETRY_DELAYS_MS[attempt - 2];
      const kind  = classifyBedrockError(lastErr.message);
      console.warn(
        `[Bedrock][${context}] ${bedrockErrorMessage(kind, attempt - 1, MAX_RETRIES)}  → waiting ${delay / 1000}s before retry ${attempt}…`
      );
      await new Promise(r => setTimeout(r, delay));
    }

    try {
      const result = await Promise.race([
        invokeStreaming(messages, systemPrompt, maxTokens, modelId),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`BEDROCK_TIMEOUT: ${context} timed out after ${timeoutMs / 1000}s`)),
            timeoutMs
          )
        ),
      ]);

      if (attempt > 1) {
        console.log(`[Bedrock][${context}] Recovered on attempt ${attempt}/${MAX_RETRIES}`);
      }
      return result;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      const kind = classifyBedrockError(lastErr.message);
      console.error(
        `[Bedrock][${context}] Attempt ${attempt}/${MAX_RETRIES} FAILED — [${kind}] ${lastErr.message}`
      );
      // Auth errors will not fix themselves on retry
      if (kind === 'AUTH_ERROR' || kind === 'QUOTA_EXCEEDED') break;
    }
  }

  // Enrich the final error with its classification so callers can act on it
  const kind = classifyBedrockError(lastErr.message);
  throw new Error(`[${kind}] ${lastErr.message}`);
}

// ─── Model-unavailable detection ───────────────────────────────────────────
// These errors signal that a specific model ID is gone (deprecated, invalid,
// or access-denied). They are NOT retryable with the same model — move to
// the next model in the fallback chain instead.

function isModelUnavailableError(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes('model identifier is invalid') ||
    m.includes('provided model identifier') ||
    m.includes('end of life') ||
    m.includes('resourcenotfoundexception') ||
    // ValidationException from Bedrock when the model string isn't recognised
    (m.includes('validationexception') && m.includes('model'))
  );
}

/**
 * Invoke with per-tier model fallback chain.
 *
 * Tries each model ID in BEDROCK_FALLBACK_CHAINS[tier] sequentially.
 * If a model returns an "unavailable" error (deprecated, invalid, access-denied),
 * it logs a warning and moves to the next model automatically.
 * Any other error (network, throttle, auth) is re-thrown immediately.
 */
async function invokeWithModelFallback(
  messages:     ConversationTurn[],
  systemPrompt: string,
  maxTokens:    number,
  context:      string,
  tier:         BedrockTier
): Promise<string> {
  const chain = BEDROCK_FALLBACK_CHAINS[tier];
  let lastErr: Error = new Error(`No models available for tier ${tier}`);

  for (const modelId of chain) {
    try {
      return await invokeWithRetry(messages, systemPrompt, maxTokens, context, modelId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isModelUnavailableError(msg)) {
        console.warn(`[Bedrock][${context}] Model ${modelId} unavailable — trying next in ${tier} chain`);
        lastErr = err instanceof Error ? err : new Error(msg);
        continue;
      }
      throw err; // network/throttle/auth — don't swallow
    }
  }

  throw lastErr;
}

// ─── Public API ────────────────────────────────────────────────────────────
//
// Model routing summary:
//
//   HAIKU    → converseWithEngineer (simple chat / quick explanations)
//              generateLogoWithAI   (SVG generation — no reasoning needed)
//              editWithAI when tier='HAIKU' (small UI edits)
//
//   SONNET   → buildWithAI          (app generation, research, API integration)
//              fixErrorsWithAI      (TypeScript fixes, targeted repair loop)
//              editWithAI (default) (backend/API edits, upgrades)
//              analyzeImageWithAI   (vision — Haiku does not support multimodal here)
//
//   STRONGEST → fixErrorsWithAI when tier='STRONGEST'
//               (advanced repair engine — broader/rewrite strategy, repeated failures,
//                platform-level architecture changes)
//
// All functions accept an optional `tier` parameter so call sites can escalate.

/** @deprecated Use BEDROCK_MODELS directly. Kept for external consumers. */
export { BEDROCK_MODELS, type BedrockTier };

/**
 * Multi-turn conversation with the AI product engineer persona.
 * Uses Haiku — chat responses are short and don't need heavy reasoning.
 */
export async function converseWithEngineer(
  messages:     ConversationTurn[],
  systemPrompt: string,
  tier:         BedrockTier = 'HAIKU'
): Promise<string> {
  try {
    return await invokeWithModelFallback(
      messages, systemPrompt, BEDROCK_CONFIG.MAX_TOKENS_CHAT, 'converse', tier
    );
  } catch (error) {
    logError('Bedrock conversation failed', error);
    throw error;
  }
}

/**
 * Single-turn build call — generates a full project from a build spec.
 * Uses Sonnet — full-stack app generation requires strong code synthesis.
 */
export async function buildWithAI(
  userMessage:  string,
  systemPrompt: string,
  tier:         BedrockTier = 'SONNET'
): Promise<string> {
  try {
    return await invokeWithModelFallback(
      [{ role: 'user', content: userMessage }],
      systemPrompt,
      BEDROCK_CONFIG.MAX_TOKENS_BUILD,
      'build',
      tier
    );
  } catch (error) {
    logError('Bedrock build failed', error);
    throw error;
  }
}

/**
 * Single-turn call for fixing TypeScript errors / repair loops.
 *
 * Default tier: SONNET (targeted fixes, single-pass TypeScript repair)
 * Pass tier='STRONGEST' for broader/rewrite strategy or repeated failures.
 */
export async function fixErrorsWithAI(
  prompt:       string,
  systemPrompt: string,
  tier:         BedrockTier = 'SONNET'
): Promise<string> {
  const maxTokens = tier === 'STRONGEST'
    ? BEDROCK_CONFIG.MAX_TOKENS_REPAIR
    : BEDROCK_CONFIG.MAX_TOKENS_BUILD;
  try {
    return await invokeWithModelFallback(
      [{ role: 'user', content: prompt }],
      systemPrompt,
      maxTokens,
      'fix-errors',
      tier
    );
  } catch (error) {
    logError('Bedrock error-fix failed', error);
    throw error;
  }
}

/**
 * Single-turn call for editing existing project files.
 *
 * Default tier: SONNET (API integration, backend edits, upgrades)
 * Pass tier='HAIKU' for small cosmetic/UI-only edits.
 */
export async function editWithAI(
  contextMessage: string,
  systemPrompt:   string,
  tier:           BedrockTier = 'SONNET'
): Promise<string> {
  try {
    return await invokeWithModelFallback(
      [{ role: 'user', content: contextMessage }],
      systemPrompt,
      BEDROCK_CONFIG.MAX_TOKENS_BUILD,
      'edit',
      tier
    );
  } catch (error) {
    logError('Bedrock edit failed', error);
    throw error;
  }
}

/**
 * Single-turn multimodal call — analyzes an image with an optional text instruction.
 * Uses Sonnet — Haiku's vision quality is insufficient for code-related screenshots.
 * imageBase64 must be raw base64 (no data-URL prefix).
 */
export async function analyzeImageWithAI(
  imageBase64:  string,
  mediaType:    string,
  instruction:  string,
  systemPrompt: string,
  tier:         BedrockTier = 'SONNET'
): Promise<string> {
  const messages: ConversationTurn[] = [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
      { type: 'text', text: instruction },
    ],
  }];
  try {
    return await invokeWithModelFallback(
      messages, systemPrompt, BEDROCK_CONFIG.MAX_TOKENS_CHAT, 'vision', tier
    );
  } catch (error) {
    logError('Bedrock image analysis failed', error);
    throw error;
  }
}

/**
 * Generate SVG logo options — returns raw text from Claude containing SVG blocks.
 * Uses Haiku — SVG generation is a structured low-complexity task.
 */
export async function generateLogoWithAI(
  prompt:       string,
  systemPrompt: string,
  tier:         BedrockTier = 'HAIKU'
): Promise<string> {
  try {
    return await invokeWithModelFallback(
      [{ role: 'user', content: prompt }],
      systemPrompt,
      BEDROCK_CONFIG.MAX_TOKENS_CHAT,
      'logo-gen',
      tier
    );
  } catch (error) {
    logError('Bedrock logo generation failed', error);
    throw error;
  }
}
