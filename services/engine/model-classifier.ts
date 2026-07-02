/**
 * Model-based intent classification — a scalable complement to keyword
 * matching (lib/app-types.ts). Keyword matching requires a manual keyword
 * addition for every new phrasing/variant (three substring-collision bugs
 * were found and fixed this way: 'hr', 'and', 'rent'/'chat'), and can never
 * cover every way a user might phrase a request (e.g. "Facebook Downloader",
 * "Pinterest Downloader", "Snapchat Downloader" have no dedicated keywords —
 * only 'tiktok downloader'/'youtube downloader'/'instagram downloader' do).
 *
 * This asks a fast, cheap model to pick the best category from the SAME
 * extensible profile list (lib/app-types.ts) the keyword classifier uses, so
 * adding a new category to that one file automatically makes it available to
 * BOTH classifiers — no further code changes, no keyword tuning per variant.
 *
 * Resilience: returns null on any error, timeout, cancellation, or response
 * that doesn't map to a real category — the caller (orchestrator) falls back
 * to today's keyword classification in every such case. This can only ever
 * make classification better or the same as before, never worse.
 */
import type { AppType, DetectedIntent } from './types';

const META_TYPES = new Set<string>(['hybrid', 'multi_domain', 'unknown']);

export interface ModelClassifierDeps {
  /** Fast model call — returns raw text. Use a cheap/fast tier (e.g. Haiku). */
  classify: (systemPrompt: string, userPrompt: string, signal?: AbortSignal) => Promise<string>;
}

function buildClassifierPrompts(
  prompt: string,
  profiles: Record<string, { label: string; keywords: string[] }>,
): { system: string; user: string } {
  const categories = Object.entries(profiles)
    .filter(([id]) => !META_TYPES.has(id))
    .map(([id, p]) => `- ${id}: ${p.label}`)
    .join('\n');

  const system =
    `You classify web-app build requests into exactly ONE category id from a fixed list.\n` +
    `Respond with ONLY the category id (e.g. "downloader") and nothing else — no punctuation,\n` +
    `no explanation. If the request is genuinely too vague to classify, respond "unknown".\n\n` +
    `Categories:\n${categories}\n- custom: doesn't fit any category above`;

  const user = `Request: "${prompt}"\n\nRespond with only the category id.`;
  return { system, user };
}

/** Parse the model's raw reply into a valid AppType key, or null if unrecognized. */
function parseCategoryId(raw: string, validIds: Set<string>): string | null {
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z_]/g, '');
  return validIds.has(cleaned) ? cleaned : null;
}

export async function classifyIntentWithModel(
  prompt: string,
  deps: ModelClassifierDeps,
  signal?: AbortSignal,
): Promise<DetectedIntent | null> {
  if (signal?.aborted) return null;
  try {
    const { APP_TYPE_PROFILES } = await import('@/lib/app-types');
    const validIds = new Set(Object.keys(APP_TYPE_PROFILES));
    const { system, user } = buildClassifierPrompts(prompt, APP_TYPE_PROFILES);
    const raw = await deps.classify(system, user, signal);
    const typeId = parseCategoryId(raw, validIds);
    // 'unknown'/'custom'/null all fall through to keyword classification —
    // only a SPECIFIC, confident category short-circuits it.
    if (!typeId || META_TYPES.has(typeId) || typeId === 'custom') return null;
    const profile = APP_TYPE_PROFILES[typeId as AppType];
    return { appType: typeId as AppType, secondaryTypes: [], confidence: 0.85, label: profile.label, source: 'model' };
  } catch {
    return null;
  }
}

// ── Default (production) wiring — lazy, not imported anywhere else ───────────
export async function defaultModelClassifierDeps(): Promise<ModelClassifierDeps> {
  return {
    classify: async (systemPrompt, userPrompt, signal) => {
      const { converseWithEngineer } = await import('@/services/bedrock');
      return converseWithEngineer([{ role: 'user', content: userPrompt }], systemPrompt, 'HAIKU', signal);
    },
  };
}
