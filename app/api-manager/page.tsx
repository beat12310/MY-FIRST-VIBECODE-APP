'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProviderStatus {
  id: string;
  name: string;
  category: string;
  primaryEnvVar: string;
  description: string;
  docsUrl: string;
  isConfigured: boolean;
  maskedKey?: string;
}

interface CatalogEntry {
  id: string;
  name: string;
  category: string;
  useCase: string;
  rapidApiHost: string;
  status: 'working' | 'failed' | 'needs_setup' | 'untested';
  usageCount: number;
  lastTestedAt?: string;
  lastError?: string;
}

interface ProjectSummary {
  projectId: string;
  projectPath: string;
  updatedAt: string;
  apiCount: number;
  workingCount: number;
  apis: Array<{ category: string; providerName: string; status: string; testedAt?: string }>;
}

interface ManagerData {
  providers: ProviderStatus[];
  rapidApiConfigured: boolean;
  rapidApiKeyPrefix: string | null;
  catalog: CatalogEntry[];
  allProjects: ProjectSummary[];
}

type Tab = 'providers' | 'catalog' | 'projects' | 'routes';

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_BADGE: Record<string, string> = {
  working:     'bg-emerald-900/60 text-emerald-300 border border-emerald-700',
  failed:      'bg-red-900/60 text-red-300 border border-red-700',
  needs_setup: 'bg-amber-900/60 text-amber-300 border border-amber-700',
  untested:    'bg-gray-800 text-gray-400 border border-gray-700',
  configured:  'bg-blue-900/60 text-blue-300 border border-blue-700',
};

const STATUS_DOT: Record<string, string> = {
  working:     'bg-emerald-400',
  failed:      'bg-red-400',
  needs_setup: 'bg-amber-400',
  untested:    'bg-gray-500',
};

const CATEGORY_ICON: Record<string, string> = {
  'External APIs': '🌐',
  'AI':            '🤖',
  'Payments':      '💳',
  'Communications':'📱',
  'Cloud':         '☁️',
  'Database / Auth':'🗄️',
  'Maps / AI':     '🗺️',
  'Email':         '📧',
};

const PLATFORM_ROUTES = [
  { path: '/api/integrations/tiktok-download', label: 'TikTok Download', example: '?url=<tiktok_url>', method: 'GET' },
  { path: '/api/integrations/weather',         label: 'Weather',         example: '?city=Accra&units=metric', method: 'GET' },
  { path: '/api/integrations/music-search',    label: 'Music Search',    example: '?q=one+dance', method: 'GET' },
  { path: '/api/integrations/sports',          label: 'Sports',          example: '?type=fixtures&league=39', method: 'GET' },
  { path: '/api/integrations/currency',        label: 'Currency',        example: '?from=USD&to=GHS', method: 'GET' },
  { path: '/api/integrations/news',            label: 'News',            example: '?q=technology', method: 'GET' },
  { path: '/api/api-manager',                  label: 'Proxy (central)', example: ' (POST: { projectId, category, params })', method: 'POST' },
];

// ─── Component ────────────────────────────────────────────────────────────────

export default function ApiManagerPage() {
  const [data, setData] = useState<ManagerData | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('providers');
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testingAll, setTestingAll] = useState(false);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; preview?: string; error?: string; ms?: number }>>({});
  const [expandedProject, setExpandedProject] = useState<string | null>(null);
  const [catalogFilter, setCatalogFilter] = useState('all');
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/api-manager');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const testOne = async (entryId: string) => {
    setTestingId(entryId);
    try {
      const res = await fetch('/api/api-manager', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test-provider', entryId }),
      });
      const r = await res.json();
      setTestResults(prev => ({ ...prev, [entryId]: r }));
      await fetchData();
    } catch (err) {
      setTestResults(prev => ({ ...prev, [entryId]: { ok: false, error: err instanceof Error ? err.message : 'failed' } }));
    } finally {
      setTestingId(null);
    }
  };

  const testAll = async () => {
    setTestingAll(true);
    try {
      const res = await fetch('/api/api-manager', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test-all' }),
      });
      const r = await res.json();
      if (r.results) setTestResults(prev => ({ ...prev, ...r.results }));
      await fetchData();
    } finally {
      setTestingAll(false);
    }
  };

  // Derived stats
  const workingCount = data?.catalog.filter(e => e.status === 'working').length ?? 0;
  const totalCount = data?.catalog.length ?? 0;
  const configuredProviders = data?.providers.filter(p => p.isConfigured).length ?? 0;

  const catalogCategories = data ? [...new Set(data.catalog.map(e => e.category))] : [];
  const filteredCatalog = data?.catalog.filter(e => catalogFilter === 'all' || e.category === catalogFilter) ?? [];

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-gray-400 text-sm">Loading API Manager…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">

      {/* ── Header ── */}
      <div className="border-b border-gray-800 bg-gray-900 sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-6 py-3 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <Link href="/builder" className="text-gray-500 hover:text-gray-300 text-sm transition-colors">← Builder</Link>
            <span className="text-gray-700">|</span>
            <h1 className="font-semibold text-white">API Manager</h1>
            <span className="text-xs text-gray-600 bg-gray-800 px-2 py-0.5 rounded-full">DWOMOH Vibe Code</span>
          </div>

          {/* Tab nav */}
          <div className="flex items-center gap-1">
            {(['providers', 'catalog', 'projects', 'routes'] as Tab[]).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors capitalize ${
                  tab === t ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          <button
            onClick={testAll}
            disabled={testingAll || !data?.rapidApiConfigured}
            className="flex items-center gap-2 px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm rounded-lg transition-colors"
          >
            {testingAll
              ? <><div className="w-3.5 h-3.5 border border-white border-t-transparent rounded-full animate-spin" /> Testing…</>
              : '⚡ Test All APIs'
            }
          </button>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-8 space-y-6">
        {error && (
          <div className="bg-red-900/30 border border-red-800 text-red-300 rounded-lg p-4 text-sm">{error}</div>
        )}

        {/* ── Summary cards ── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: 'Providers configured', value: configuredProviders, sub: `of ${data?.providers.length ?? 0}`, color: configuredProviders > 0 ? 'text-blue-400' : 'text-gray-500' },
            { label: 'APIs working', value: workingCount, sub: `of ${totalCount} tested`, color: workingCount > 0 ? 'text-emerald-400' : 'text-gray-500' },
            { label: 'Projects tracked', value: data?.allProjects.length ?? 0, sub: 'using APIs', color: 'text-purple-400' },
            { label: 'RapidAPI key', value: data?.rapidApiConfigured ? 'Active' : 'Missing', sub: data?.rapidApiKeyPrefix ?? 'Add to .env.local', color: data?.rapidApiConfigured ? 'text-emerald-400' : 'text-amber-400' },
          ].map(card => (
            <div key={card.label} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <div className={`text-2xl font-bold ${card.color}`}>{card.value}</div>
              <div className="text-white text-sm font-medium mt-0.5">{card.label}</div>
              <div className="text-gray-500 text-xs mt-0.5">{card.sub}</div>
            </div>
          ))}
        </div>

        {/* ══════════════════════════════════════════════════════
            TAB: Providers
            ══════════════════════════════════════════════════════ */}
        {tab === 'providers' && (
          <div className="space-y-4">
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">Provider Keys</h2>
            <p className="text-sm text-gray-500">
              Configure these keys once in <code className="text-gray-400 bg-gray-800 px-1 rounded">.env.local</code>.
              DWOMOH Vibe Code forwards them to every generated app automatically — you never configure them twice.
            </p>

            {/* Group by category */}
            {[...new Set(data?.providers.map(p => p.category) ?? [])].map(cat => (
              <div key={cat}>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-base">{CATEGORY_ICON[cat] ?? '🔑'}</span>
                  <span className="text-sm font-medium text-gray-300">{cat}</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {data?.providers.filter(p => p.category === cat).map(provider => (
                    <div
                      key={provider.id}
                      className={`bg-gray-900 border rounded-xl p-4 transition-colors ${
                        provider.isConfigured ? 'border-gray-700 hover:border-gray-600' : 'border-gray-800'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-white">{provider.name}</span>
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                              provider.isConfigured ? STATUS_BADGE.configured : STATUS_BADGE.needs_setup
                            }`}>
                              {provider.isConfigured ? 'Configured' : 'Not configured'}
                            </span>
                          </div>
                          <p className="text-gray-500 text-xs mt-1">{provider.description}</p>
                          <div className="mt-2 flex items-center gap-2">
                            <code className="text-xs text-gray-600 bg-gray-800 px-2 py-0.5 rounded">
                              {provider.primaryEnvVar}
                            </code>
                            {provider.maskedKey && (
                              <code className="text-xs text-emerald-600">{provider.maskedKey}</code>
                            )}
                          </div>
                        </div>
                        {!provider.isConfigured && (
                          <a
                            href={provider.docsUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-blue-400 hover:text-blue-300 whitespace-nowrap transition-colors"
                          >
                            Get key →
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}

            {/* .env.local instructions */}
            <div className="bg-gray-900/50 border border-gray-800 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-gray-300 mb-3">
                How to add a key to .env.local
              </h3>
              <pre className="text-xs text-gray-400 font-mono bg-gray-950 rounded-lg p-4 overflow-auto">
{`# Open .env.local in the DWOMOH Vibe Code root directory
# Add the key for any provider you want to enable:

RAPIDAPI_KEY=your_rapidapi_key_here
STRIPE_SECRET_KEY=sk_live_...
PAYSTACK_SECRET_KEY=sk_live_...
TWILIO_ACCOUNT_SID=ACxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxx
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=AIzaSy...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
RESEND_API_KEY=re_...

# Once added, restart DWOMOH Vibe Code.
# All future generated apps will use these keys automatically.`}
              </pre>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════
            TAB: Catalog (RapidAPI entries)
            ══════════════════════════════════════════════════════ */}
        {tab === 'catalog' && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => setCatalogFilter('all')}
                className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${catalogFilter === 'all' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}
              >
                All ({totalCount})
              </button>
              {catalogCategories.map(cat => {
                const count = data?.catalog.filter(e => e.category === cat).length ?? 0;
                return (
                  <button key={cat} onClick={() => setCatalogFilter(cat)}
                    className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${catalogFilter === cat ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>
                    {cat.replace(/_/g, ' ')} ({count})
                  </button>
                );
              })}
            </div>

            <div className="space-y-2">
              {filteredCatalog.map(entry => {
                const local = testResults[entry.id];
                const status = local ? (local.ok ? 'working' : 'failed') as CatalogEntry['status'] : entry.status;
                const isTesting = testingId === entry.id;

                return (
                  <div key={entry.id} className="bg-gray-900 border border-gray-800 hover:border-gray-700 rounded-xl p-4 transition-colors">
                    <div className="flex items-start gap-3">
                      <div className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${STATUS_DOT[status]}`} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-3 flex-wrap">
                          <div>
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-medium text-white">{entry.name}</span>
                              <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_BADGE[status]}`}>{status}</span>
                              <span className="text-xs text-gray-600 bg-gray-800 px-2 py-0.5 rounded">{entry.category.replace(/_/g, ' ')}</span>
                              {entry.usageCount > 0 && <span className="text-xs text-blue-400">{entry.usageCount}× used</span>}
                            </div>
                            <p className="text-gray-500 text-xs mt-0.5">{entry.useCase}</p>
                            <code className="text-xs text-gray-700">{entry.rapidApiHost}</code>
                          </div>
                          <button
                            onClick={() => testOne(entry.id)}
                            disabled={isTesting || testingAll || !data?.rapidApiConfigured}
                            className="px-3 py-1 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-gray-300 text-xs rounded-lg border border-gray-700 transition-colors whitespace-nowrap"
                          >
                            {isTesting ? '…' : '▶ Test'}
                          </button>
                        </div>

                        {(local || entry.lastError) && (
                          <div className={`mt-2 p-2 rounded-lg text-xs border ${
                            local?.ok || (!local && status === 'working')
                              ? 'bg-emerald-950/30 border-emerald-900 text-emerald-300'
                              : 'bg-red-950/30 border-red-900 text-red-300'
                          }`}>
                            {local?.ok && local.preview && <div className="text-emerald-400">✓ {local.preview}</div>}
                            {local?.ms && <div className="text-gray-600">{local.ms}ms</div>}
                            {(local?.error || entry.lastError) && <div className="break-words">{local?.error || entry.lastError}</div>}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════
            TAB: Projects
            ══════════════════════════════════════════════════════ */}
        {tab === 'projects' && (
          <div className="space-y-4">
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
              Generated Projects Using APIs ({data?.allProjects.length ?? 0})
            </h2>
            {(data?.allProjects.length ?? 0) === 0 ? (
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center">
                <div className="text-4xl mb-3">📦</div>
                <p className="text-gray-400">No projects tracked yet.</p>
                <p className="text-gray-600 text-sm mt-1">When you build an app that needs external APIs, it will appear here.</p>
              </div>
            ) : (
              data?.allProjects.map(project => (
                <div key={project.projectId} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                  <button
                    onClick={() => setExpandedProject(expandedProject === project.projectId ? null : project.projectId)}
                    className="w-full text-left p-4 hover:bg-gray-800/50 transition-colors"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <span className="text-gray-400 text-sm">{expandedProject === project.projectId ? '▼' : '▶'}</span>
                        <div>
                          <div className="font-medium text-white">{project.projectId}</div>
                          <div className="text-xs text-gray-600 mt-0.5 truncate max-w-xs">{project.projectPath}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 text-right">
                        <div className="text-xs text-gray-500">
                          Updated {new Date(project.updatedAt).toLocaleDateString()}
                        </div>
                        <div className={`text-sm font-semibold ${project.workingCount === project.apiCount ? 'text-emerald-400' : 'text-amber-400'}`}>
                          {project.workingCount}/{project.apiCount} APIs working
                        </div>
                      </div>
                    </div>
                  </button>

                  {expandedProject === project.projectId && (
                    <div className="border-t border-gray-800 divide-y divide-gray-800">
                      {project.apis.map(api => (
                        <div key={api.category} className="px-6 py-3 flex items-center justify-between gap-3">
                          <div>
                            <span className="text-sm text-white capitalize">{api.category.replace(/_/g, ' ')}</span>
                            <span className="text-xs text-gray-500 ml-2">via {api.providerName}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            {api.testedAt && (
                              <span className="text-xs text-gray-600">
                                {new Date(api.testedAt).toLocaleTimeString()}
                              </span>
                            )}
                            <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_BADGE[api.status] ?? STATUS_BADGE.untested}`}>
                              {api.status}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {/* ══════════════════════════════════════════════════════
            TAB: Routes
            ══════════════════════════════════════════════════════ */}
        {tab === 'routes' && (
          <div className="space-y-4">
            <div>
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-1">Platform Proxy</h2>
              <p className="text-sm text-gray-500 mb-3">
                Generated apps call <code className="text-gray-400 bg-gray-800 px-1 rounded">DWOMOH_PLATFORM_URL/api/api-manager</code> to make
                external API requests. RAPIDAPI_KEY stays on the platform — never in the generated app.
              </p>

              <div className="bg-gray-900/50 border border-gray-800 rounded-xl p-4">
                <pre className="text-xs text-gray-400 font-mono overflow-auto">
{`// How a generated app calls the platform proxy:
const res = await fetch(\`\${process.env.DWOMOH_PLATFORM_URL}/api/api-manager\`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    action: 'proxy',
    projectId: process.env.DWOMOH_PROJECT_ID,
    category: 'weather',           // or: video_downloader, music, sports, finance, news
    params: { city: 'Accra', units: 'metric' }
  })
});
const data = await res.json();`}
                </pre>
              </div>
            </div>

            <div>
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-2">
                Platform Integration Routes
              </h2>
              <p className="text-sm text-gray-500 mb-3">
                Also available as direct GET routes on the DWOMOH platform:
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {PLATFORM_ROUTES.map(route => (
                  <div key={route.path} className="bg-gray-900 border border-gray-800 rounded-lg p-3">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${
                        route.method === 'POST' ? 'bg-orange-900/60 text-orange-300' : 'bg-blue-900/60 text-blue-300'
                      }`}>{route.method}</span>
                      <span className="text-white text-xs font-medium">{route.label}</span>
                    </div>
                    <code className="text-xs text-gray-600 break-all">{route.path}{route.example}</code>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="border-t border-gray-800 pt-4 text-center text-xs text-gray-700">
          DWOMOH Vibe Code — API Manager · All keys are server-side only and never sent to the browser
        </div>
      </div>
    </div>
  );
}
