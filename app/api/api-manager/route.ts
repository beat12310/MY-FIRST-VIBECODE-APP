/**
 * Central API Manager Route
 * Serves all API management operations for both the DWOMOH UI
 * and generated applications calling the platform proxy.
 *
 * GET  /api/api-manager                        → system status (safe for browser)
 * POST /api/api-manager  action=proxy          → proxy external API call (server-side key)
 * POST /api/api-manager  action=discover       → detect APIs needed for a prompt
 * POST /api/api-manager  action=plan           → full plan: detect + test + generate code
 * POST /api/api-manager  action=verify         → post-build API verification
 * POST /api/api-manager  action=project-config → get/save project API config
 * POST /api/api-manager  action=test-provider  → test a single catalog entry
 * POST /api/api-manager  action=test-all       → test every catalog entry
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiManager } from '@/services/api-manager/index';
import { API_CATALOG, updateEntryStatus } from '@/services/api-catalog';
import { testProvider } from '@/services/rapidapi-connector';
import { getAllProviders, getRapidApiKey } from '@/services/api-manager/key-vault';
import { listProjectConfigs, getProjectConfig, saveProjectConfig } from '@/services/api-manager/project-store';
import { detectRequiredApis } from '@/services/rapidapi-connector';

// ── GET: system status — safe to return to browser ────────────────────────────

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get('projectId');

  const providers = getAllProviders();
  const rapidApiKey = getRapidApiKey();

  const catalog = API_CATALOG.map(e => ({
    id: e.id,
    name: e.name,
    category: e.category,
    useCase: e.useCase,
    rapidApiHost: e.rapidApiHost,
    status: e.status,
    usageCount: e.usageCount,
    lastTestedAt: e.lastTestedAt,
    lastError: e.lastError,
  }));

  const projectConfig = projectId ? await getProjectConfig(projectId) : null;
  const allProjects = await listProjectConfigs();

  return NextResponse.json({
    // Provider status (no key values)
    providers,
    rapidApiConfigured: rapidApiKey.length > 0,
    rapidApiKeyPrefix: rapidApiKey.length > 8 ? `${rapidApiKey.slice(0, 8)}…` : null,
    // API catalog
    catalog,
    // Per-project (if requested)
    projectConfig,
    // All projects (for the manager UI)
    allProjects: allProjects.map(p => ({
      projectId: p.projectId,
      projectPath: p.projectPath,
      updatedAt: p.updatedAt,
      apiCount: p.apis.length,
      workingCount: p.apis.filter(a => a.status === 'working').length,
      apis: p.apis,
    })),
  });
}

// ── POST: all write / action operations ───────────────────────────────────────

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const action = body.action as string;

  // ── proxy: generated app calls this to make external API requests ───────────
  if (action === 'proxy') {
    const projectId = String(body.projectId || '');
    const category = String(body.category || '');
    const params = (body.params || {}) as Record<string, string>;
    const bdy = body.body;
    const method = (body.method as 'GET' | 'POST' | undefined) || 'GET';

    if (!category) return NextResponse.json({ error: 'Missing category' }, { status: 400 });

    const result = await apiManager.proxyCall({ projectId, category, params, body: bdy, method });
    if (!result.ok) {
      return NextResponse.json({ error: result.error, provider: result.provider }, { status: 502 });
    }
    return NextResponse.json(result.data);
  }

  // ── discover: detect API categories from a build prompt ─────────────────────
  if (action === 'discover') {
    const prompt = String(body.prompt || '');
    if (!prompt) return NextResponse.json({ error: 'Missing prompt' }, { status: 400 });
    const categories = detectRequiredApis(prompt);
    return NextResponse.json({ categories, count: categories.length });
  }

  // ── plan: full API resolution for a build prompt ─────────────────────────────
  if (action === 'plan') {
    const prompt = String(body.prompt || '');
    const projectId = String(body.projectId || `project-${Date.now()}`);
    const platformPort = Number(body.platformPort || 3000);
    if (!prompt) return NextResponse.json({ error: 'Missing prompt' }, { status: 400 });

    const plan = await apiManager.planForPrompt(prompt, projectId, platformPort);

    // Return everything except key values — routes and env additions only contain structure
    return NextResponse.json({
      resolved: plan.resolved,
      missing: plan.missing,
      promptInstructions: plan.promptInstructions,
      routes: plan.routes,
      envAdditions: plan.envAdditions,
      // Forward which env vars have values (names only, never values)
      forwardedEnvVarNames: plan.forwardedKeys.map(k => k.envVar),
    });
  }

  // ── verify: post-build API verification for a project ────────────────────────
  if (action === 'verify') {
    const projectId = String(body.projectId || '');
    if (!projectId) return NextResponse.json({ error: 'Missing projectId' }, { status: 400 });
    const result = await apiManager.verifyProjectApis(projectId);
    return NextResponse.json(result);
  }

  // ── project-config: get or update project API configuration ──────────────────
  if (action === 'project-config') {
    const projectId = String(body.projectId || '');
    const subAction = String(body.subAction || 'get');
    if (!projectId) return NextResponse.json({ error: 'Missing projectId' }, { status: 400 });

    if (subAction === 'get') {
      const config = await getProjectConfig(projectId);
      return NextResponse.json({ config });
    }

    if (subAction === 'save') {
      const config = body.config as Parameters<typeof saveProjectConfig>[0];
      await saveProjectConfig(config);
      return NextResponse.json({ success: true });
    }
  }

  // ── test-provider: test a single catalog entry by id ──────────────────────────
  if (action === 'test-provider') {
    const entryId = String(body.entryId || '');
    const key = getRapidApiKey();
    if (!key) return NextResponse.json({ error: 'RAPIDAPI_KEY not configured' }, { status: 400 });

    const entry = API_CATALOG.find(e => e.id === entryId);
    if (!entry) return NextResponse.json({ error: `No entry with id "${entryId}"` }, { status: 404 });

    const result = await testProvider(entry, key);
    updateEntryStatus(entry.id, { status: result.ok ? 'working' : 'failed', error: result.error });

    return NextResponse.json({
      id: entryId,
      ok: result.ok,
      status: result.status,
      preview: result.preview,
      error: result.error,
      ms: result.responseTime,
    });
  }

  // ── test-all: test every catalog entry ────────────────────────────────────────
  if (action === 'test-all') {
    const key = getRapidApiKey();
    if (!key) return NextResponse.json({ error: 'RAPIDAPI_KEY not configured' }, { status: 400 });

    const results: Record<string, { ok: boolean; preview?: string; error?: string; ms?: number }> = {};
    for (const entry of API_CATALOG) {
      const result = await testProvider(entry, key);
      updateEntryStatus(entry.id, { status: result.ok ? 'working' : 'failed', error: result.error });
      results[entry.id] = { ok: result.ok, preview: result.preview, error: result.error, ms: result.responseTime };
    }
    return NextResponse.json({ results });
  }

  return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
}
