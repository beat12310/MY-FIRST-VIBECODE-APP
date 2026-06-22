'use client';

import { useEffect, useState, useCallback } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface AwsService {
  service: string;
  name: string;
  description: string;
  categories: string[];
  available: boolean;
  requiredVars: string[];
}

interface TierMeta {
  tier: string;
  label: string;
  priority: number;
  ready: boolean;
}

interface ProviderStatus {
  aws: {
    services: AwsService[];
    totalAvailable: number;
    totalConfigured: number;
  };
  rapidapi: {
    keyPrefix: string | null;
    keyConfigured: boolean;
    totalSubscribed: number;
    totalProbed: number;
    categoriesAvailable: string[];
    lastScanned: number | null;
  };
  public: {
    totalAvailable: number;
    categories: string[];
  };
  tiers: TierMeta[];
}

interface SyncResult {
  ok: boolean;
  scannedAt?: number;
  totalSubscribed?: number;
  totalProbed?: number;
  categoriesAvailable?: string[];
  diff?: {
    newlySubscribed: Array<{ host: string; name: string; categories: string[] }>;
    noLongerSubscribed: Array<{ host: string; name: string }>;
    unchanged: number;
  };
  message?: string;
  error?: string;
}

// ── Badge helpers ─────────────────────────────────────────────────────────────

function Badge({ label, color }: { label: string; color: 'green' | 'yellow' | 'red' | 'blue' | 'gray' }) {
  const cls: Record<string, string> = {
    green:  'bg-green-100 text-green-800 border-green-200',
    yellow: 'bg-yellow-100 text-yellow-800 border-yellow-200',
    red:    'bg-red-100 text-red-800 border-red-200',
    blue:   'bg-blue-100 text-blue-800 border-blue-200',
    gray:   'bg-gray-100 text-gray-600 border-gray-200',
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium border ${cls[color]}`}>
      {label}
    </span>
  );
}

function TierBadge({ tier }: { tier: string }) {
  if (tier === 'aws')      return <Badge label="AWS Native" color="blue" />;
  if (tier === 'rapidapi') return <Badge label="RapidAPI" color="yellow" />;
  return <Badge label="Public API" color="gray" />;
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block w-2.5 h-2.5 rounded-full mr-2 ${ok ? 'bg-green-500' : 'bg-red-400'}`}
      title={ok ? 'Available' : 'Unavailable'}
    />
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ProvidersPage() {
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchNeed, setSearchNeed] = useState('');
  const [searchResult, setSearchResult] = useState<Record<string, unknown> | null>(null);
  const [searching, setSearching] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/providers');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: ProviderStatus & { ok: boolean } = await res.json();
      setStatus(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load provider status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleSync() {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch('/api/providers/sync', { method: 'POST' });
      const data: SyncResult = await res.json();
      setSyncResult(data);
      if (data.ok) await load();
    } catch (e) {
      setSyncResult({ ok: false, error: e instanceof Error ? e.message : 'Sync failed' });
    } finally {
      setSyncing(false);
    }
  }

  async function handleSearch() {
    if (!searchNeed.trim()) return;
    setSearching(true);
    setSearchResult(null);
    try {
      const res = await fetch('/api/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'select', need: searchNeed.trim() }),
      });
      setSearchResult(await res.json());
    } catch (e) {
      setSearchResult({ error: e instanceof Error ? e.message : 'Search failed' });
    } finally {
      setSearching(false);
    }
  }

  const rapidapiLastScan = status?.rapidapi.lastScanned
    ? new Date(status.rapidapi.lastScanned).toLocaleString()
    : 'Never';

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Provider Dashboard</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            All 3 tiers — AWS Native · RapidAPI Subscriptions · Approved Public APIs
          </p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={load}
            disabled={loading}
            className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50 disabled:opacity-50"
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <button
            onClick={handleSync}
            disabled={syncing || !status?.rapidapi.keyConfigured}
            className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
            title={!status?.rapidapi.keyConfigured ? 'RAPIDAPI_KEY not configured' : 'Scan all 117+ RapidAPI hosts'}
          >
            {syncing ? 'Scanning…' : 'Sync RapidAPI'}
          </button>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-8 space-y-8">

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
            {error}
          </div>
        )}

        {/* Sync result banner */}
        {syncResult && (
          <div className={`rounded-lg p-4 border ${syncResult.ok ? 'bg-green-50 border-green-200 text-green-800' : 'bg-red-50 border-red-200 text-red-700'}`}>
            <p className="font-medium">{syncResult.ok ? 'Sync complete' : 'Sync failed'}</p>
            {syncResult.message && <p className="text-sm mt-1">{syncResult.message}</p>}
            {syncResult.error && <p className="text-sm mt-1">{syncResult.error}</p>}
            {syncResult.diff && syncResult.diff.newlySubscribed.length > 0 && (
              <div className="mt-2">
                <p className="text-sm font-medium">Newly found:</p>
                <ul className="text-sm list-disc ml-4 mt-1">
                  {syncResult.diff.newlySubscribed.map(e => (
                    <li key={e.host}>{e.name} ({e.categories.join(', ')})</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Tier summary cards */}
        {status && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

            {/* AWS Tier */}
            <div className="bg-white border rounded-xl p-5">
              <div className="flex items-center justify-between mb-3">
                <span className="font-semibold text-gray-900">Tier 1 · AWS Native</span>
                <Badge label="Priority 1" color="blue" />
              </div>
              <div className="text-3xl font-bold text-gray-900">
                {status.aws.totalAvailable}
                <span className="text-lg font-normal text-gray-400">/{status.aws.totalConfigured}</span>
              </div>
              <p className="text-sm text-gray-500 mt-1">services available</p>
              <div className="mt-3 flex items-center gap-2">
                <StatusDot ok={status.aws.totalAvailable > 0} />
                <span className="text-xs text-gray-600">
                  {status.aws.totalAvailable > 0 ? 'Credentials detected' : 'No credentials found'}
                </span>
              </div>
            </div>

            {/* RapidAPI Tier */}
            <div className="bg-white border rounded-xl p-5">
              <div className="flex items-center justify-between mb-3">
                <span className="font-semibold text-gray-900">Tier 2 · RapidAPI</span>
                <Badge label="Priority 2" color="yellow" />
              </div>
              <div className="text-3xl font-bold text-gray-900">
                {status.rapidapi.totalSubscribed}
                <span className="text-lg font-normal text-gray-400">/{status.rapidapi.totalProbed}</span>
              </div>
              <p className="text-sm text-gray-500 mt-1">subscriptions detected</p>
              <div className="mt-3 space-y-1">
                <div className="flex items-center gap-2">
                  <StatusDot ok={status.rapidapi.keyConfigured} />
                  <span className="text-xs text-gray-600">
                    {status.rapidapi.keyConfigured
                      ? `Key: ${status.rapidapi.keyPrefix}`
                      : 'RAPIDAPI_KEY not set'}
                  </span>
                </div>
                <p className="text-xs text-gray-400 ml-4.5">Last scan: {rapidapiLastScan}</p>
              </div>
            </div>

            {/* Public APIs Tier */}
            <div className="bg-white border rounded-xl p-5">
              <div className="flex items-center justify-between mb-3">
                <span className="font-semibold text-gray-900">Tier 3 · Public APIs</span>
                <Badge label="Priority 3" color="gray" />
              </div>
              <div className="text-3xl font-bold text-gray-900">{status.public.totalAvailable}</div>
              <p className="text-sm text-gray-500 mt-1">free APIs available</p>
              <div className="mt-3 flex items-center gap-2">
                <StatusDot ok={true} />
                <span className="text-xs text-gray-600">Always available — no key required</span>
              </div>
            </div>
          </div>
        )}

        {/* Provider search */}
        <div className="bg-white border rounded-xl p-5">
          <h2 className="font-semibold text-gray-900 mb-3">Find Best Provider</h2>
          <p className="text-sm text-gray-500 mb-4">
            Describe what you need and the engine will search all 3 tiers in priority order.
          </p>
          <div className="flex gap-3">
            <input
              value={searchNeed}
              onChange={e => setSearchNeed(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              placeholder="e.g. live football scores, exchange rates, AI text generation…"
              className="flex-1 border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-300 outline-none"
            />
            <button
              onClick={handleSearch}
              disabled={searching || !searchNeed.trim()}
              className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
            >
              {searching ? 'Searching…' : 'Find'}
            </button>
          </div>

          {searchResult && (
            <div className="mt-4 border rounded-lg overflow-hidden">
              {(searchResult as {primary?: {tier:string;name:string;description:string;available:boolean}}).primary ? (
                <div>
                  <div className="bg-green-50 px-4 py-3 border-b flex items-center gap-3">
                    <span className="text-green-600 font-medium text-sm">Best match:</span>
                    <TierBadge tier={(searchResult as {primary:{tier:string}}).primary.tier} />
                    <span className="font-semibold text-sm">
                      {(searchResult as {primary:{name:string}}).primary.name}
                    </span>
                    <Badge
                      label={(searchResult as {primary:{available:boolean}}).primary.available ? 'Available' : 'Not configured'}
                      color={(searchResult as {primary:{available:boolean}}).primary.available ? 'green' : 'red'}
                    />
                  </div>
                  <div className="px-4 py-3">
                    <p className="text-sm text-gray-600">
                      {(searchResult as {primary:{description:string}}).primary.description}
                    </p>
                    <p className="text-xs text-gray-400 mt-2">
                      {(searchResult as {rationale:string}).rationale}
                    </p>
                  </div>
                  {(searchResult as {alternatives?: unknown[]}).alternatives?.length ? (
                    <div className="px-4 pb-3">
                      <p className="text-xs font-medium text-gray-500 mb-2">
                        {(searchResult as {alternatives: unknown[]}).alternatives.length} alternative(s) available
                      </p>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="px-4 py-3 text-sm text-gray-500">
                  {(searchResult as {rationale?: string}).rationale ?? 'No provider found.'}
                </div>
              )}
            </div>
          )}
        </div>

        {/* AWS Services */}
        {status && (
          <div className="bg-white border rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b flex items-center gap-2">
              <h2 className="font-semibold text-gray-900">Tier 1 — AWS Native Services</h2>
              <Badge label={`${status.aws.totalAvailable}/${status.aws.totalConfigured} ready`} color="blue" />
            </div>
            <div className="divide-y">
              {status.aws.services.map(svc => (
                <div key={svc.service} className="px-5 py-4 flex items-start gap-4">
                  <StatusDot ok={svc.available} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-gray-900 text-sm">{svc.name}</span>
                      {svc.categories.map(c => (
                        <Badge key={c} label={c} color="gray" />
                      ))}
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">{svc.description}</p>
                    {!svc.available && (
                      <p className="text-xs text-red-500 mt-1">
                        Missing: {svc.requiredVars.filter(v => !process.env[v]).join(', ') || svc.requiredVars.join(', ')}
                      </p>
                    )}
                  </div>
                  <Badge label={svc.available ? 'Active' : 'Needs config'} color={svc.available ? 'green' : 'red'} />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* RapidAPI categories */}
        {status && status.rapidapi.categoriesAvailable.length > 0 && (
          <div className="bg-white border rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b flex items-center gap-2">
              <h2 className="font-semibold text-gray-900">Tier 2 — RapidAPI Subscriptions</h2>
              <Badge label={`${status.rapidapi.totalSubscribed} subscribed`} color="yellow" />
            </div>
            <div className="px-5 py-4">
              <p className="text-sm text-gray-500 mb-4">
                {status.rapidapi.totalProbed} hosts probed · {status.rapidapi.categoriesAvailable.length} categories available
              </p>
              <div className="flex flex-wrap gap-2">
                {status.rapidapi.categoriesAvailable.map(cat => (
                  <span
                    key={cat}
                    className="px-3 py-1 text-xs rounded-full bg-yellow-50 text-yellow-800 border border-yellow-200 font-medium"
                  >
                    {cat}
                  </span>
                ))}
              </div>
              {status.rapidapi.totalSubscribed === 0 && status.rapidapi.keyConfigured && (
                <div className="mt-4 bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-sm text-yellow-800">
                  Registry not yet scanned. Click <strong>Sync RapidAPI</strong> to probe all 117+ hosts.
                </div>
              )}
            </div>
          </div>
        )}

        {/* Public APIs */}
        {status && (
          <div className="bg-white border rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b flex items-center gap-2">
              <h2 className="font-semibold text-gray-900">Tier 3 — Approved Public APIs</h2>
              <Badge label={`${status.public.totalAvailable} available`} color="gray" />
            </div>
            <div className="px-5 py-4">
              <p className="text-sm text-gray-500 mb-4">
                Free, no-key, production-quality fallback APIs. Always available.
              </p>
              <div className="flex flex-wrap gap-2">
                {status.public.categories.map(cat => (
                  <span
                    key={cat}
                    className="px-3 py-1 text-xs rounded-full bg-gray-100 text-gray-600 border border-gray-200 font-medium"
                  >
                    {cat}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Tier priority guide */}
        <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-5">
          <h3 className="font-semibold text-indigo-900 mb-3">Provider Selection Order</h3>
          <ol className="space-y-2 text-sm">
            <li className="flex items-start gap-3">
              <span className="flex-shrink-0 w-6 h-6 bg-blue-600 text-white rounded-full flex items-center justify-center text-xs font-bold">1</span>
              <div>
                <span className="font-medium text-indigo-900">AWS Native</span>
                <span className="text-indigo-700 ml-2">— Bedrock (AI), Cognito (auth), S3 (files), SES (email), DynamoDB (db)</span>
              </div>
            </li>
            <li className="flex items-start gap-3">
              <span className="flex-shrink-0 w-6 h-6 bg-yellow-500 text-white rounded-full flex items-center justify-center text-xs font-bold">2</span>
              <div>
                <span className="font-medium text-indigo-900">RapidAPI Subscriptions</span>
                <span className="text-indigo-700 ml-2">— Your paid subscriptions, auto-detected and synced</span>
              </div>
            </li>
            <li className="flex items-start gap-3">
              <span className="flex-shrink-0 w-6 h-6 bg-gray-400 text-white rounded-full flex items-center justify-center text-xs font-bold">3</span>
              <div>
                <span className="font-medium text-indigo-900">Approved Public APIs</span>
                <span className="text-indigo-700 ml-2">— Free fallbacks (Open-Meteo, ExchangeRate-API, REST Countries, CoinGecko…)</span>
              </div>
            </li>
          </ol>
        </div>

      </div>
    </div>
  );
}
