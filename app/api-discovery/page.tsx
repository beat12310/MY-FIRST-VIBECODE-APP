'use client';

import { useState, useCallback } from 'react';
import type { DynamicRegistryResult, DiscoveredEntry } from '@/services/dynamic-registry';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ApiResponse extends Partial<DynamicRegistryResult> {
  ok?: boolean;
  keyConfigured?: boolean;
  error?: string;
  message?: string;
}

interface FindResponse {
  ok?: boolean;
  prompt?: string;
  matched?: Array<{
    host: string;
    name: string;
    categories: string[];
    description: string;
    httpStatus?: number;
    responseMs: number;
  }>;
  count?: number;
  error?: string;
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ subscribed, status }: { subscribed: boolean; status?: number }) {
  if (subscribed) {
    return (
      <span style={{ background: '#065f46', color: '#d1fae5', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700 }}>
        SUBSCRIBED {status ? `(${status})` : ''}
      </span>
    );
  }
  const notSub = status === 403;
  return (
    <span style={{ background: notSub ? '#581c87' : '#7f1d1d', color: notSub ? '#e9d5ff' : '#fee2e2', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700 }}>
      {notSub ? 'NOT SUBSCRIBED' : status ? `ERR ${status}` : 'TIMEOUT'}
    </span>
  );
}

// ── Category tag ──────────────────────────────────────────────────────────────

function CatTag({ label }: { label: string }) {
  return (
    <span style={{ background: '#1e293b', color: '#94a3b8', padding: '1px 6px', borderRadius: 3, fontSize: 10, marginRight: 4, marginBottom: 4, display: 'inline-block' }}>
      {label}
    </span>
  );
}

// ── Entry row ─────────────────────────────────────────────────────────────────

function EntryRow({ e }: { e: DiscoveredEntry }) {
  return (
    <tr>
      <td style={{ padding: '8px 10px', borderBottom: '1px solid #1e293b', whiteSpace: 'nowrap' }}>
        <StatusBadge subscribed={e.subscribed} status={e.httpStatus} />
      </td>
      <td style={{ padding: '8px 10px', borderBottom: '1px solid #1e293b', fontWeight: 600, fontSize: 13 }}>
        {e.name}
      </td>
      <td style={{ padding: '8px 10px', borderBottom: '1px solid #1e293b', color: '#64748b', fontSize: 11 }}>
        {e.host}
      </td>
      <td style={{ padding: '8px 10px', borderBottom: '1px solid #1e293b', fontSize: 11 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap' }}>
          {e.categories.map(c => <CatTag key={c} label={c} />)}
        </div>
      </td>
      <td style={{ padding: '8px 10px', borderBottom: '1px solid #1e293b', color: '#475569', fontSize: 11, whiteSpace: 'nowrap' }}>
        {e.responseMs}ms
      </td>
    </tr>
  );
}

// ── Category section ──────────────────────────────────────────────────────────

function CategorySection({ category, entries }: { category: string; entries: DiscoveredEntry[] }) {
  const label = category.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return (
    <div style={{ marginBottom: 12, padding: '12px 16px', background: '#0f172a', borderRadius: 8, border: '1px solid #065f46' }}>
      <div style={{ fontWeight: 700, color: '#34d399', marginBottom: 8, fontSize: 14 }}>
        {label} — {entries.length} provider{entries.length !== 1 ? 's' : ''}
      </div>
      {entries.map(e => (
        <div key={e.host} style={{ fontSize: 12, color: '#cbd5e1', marginBottom: 4 }}>
          <strong>{e.name}</strong>
          <span style={{ color: '#475569', marginLeft: 8, fontSize: 11 }}>{e.host}</span>
        </div>
      ))}
    </div>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, padding: '14px 16px' }}>
      <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: highlight ? '#34d399' : '#e2e8f0' }}>{value}</div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ApiDiscoveryPage() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [findPrompt, setFindPrompt] = useState('');
  const [findResult, setFindResult] = useState<FindResponse | null>(null);
  const [finding, setFinding] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/api-discovery');
      setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      const res = await fetch('/api/api-discovery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'scan' }),
      });
      setData(await res.json());
    } finally {
      setScanning(false);
    }
  }, []);

  const find = useCallback(async () => {
    if (!findPrompt.trim()) return;
    setFinding(true);
    setFindResult(null);
    try {
      const res = await fetch('/api/api-discovery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'find', prompt: findPrompt }),
      });
      setFindResult(await res.json());
    } finally {
      setFinding(false);
    }
  }, [findPrompt]);

  const categories = data?.byCategory ? Object.keys(data.byCategory).sort() : [];
  const allEntries = data?.entries ?? [];
  const subscribedEntries = allEntries.filter(e => e.subscribed);
  const notSubscribed = allEntries.filter(e => !e.subscribed);
  const displayEntries = showAll ? allEntries : allEntries.slice(0, 80);

  return (
    <div style={{ minHeight: '100vh', background: '#0a0f1e', color: '#e2e8f0', fontFamily: 'ui-monospace, SFMono-Regular, monospace', padding: '32px 24px' }}>
      <div style={{ maxWidth: 1200, margin: '0 auto' }}>

        {/* Header */}
        <div style={{ marginBottom: 32 }}>
          <h1 style={{ fontSize: 28, fontWeight: 800, color: '#34d399', margin: 0 }}>
            DWOMOH — Dynamic API Registry
          </h1>
          <p style={{ color: '#64748b', marginTop: 8, fontSize: 13 }}>
            Probes 150+ RapidAPI hosts to discover every API your key is subscribed to.
            Results cached 30 min in-process and 4 hours on disk (.dwomoh/api-registry.json).
          </p>
        </div>

        {/* Action bar */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 32, flexWrap: 'wrap' }}>
          <button onClick={load} disabled={loading || scanning}
            style={{ background: '#1e293b', color: '#e2e8f0', border: '1px solid #334155', padding: '10px 20px', borderRadius: 8, cursor: 'pointer', fontWeight: 600, opacity: loading ? 0.6 : 1 }}>
            {loading ? 'Loading…' : 'Load Cached'}
          </button>
          <button onClick={scan} disabled={loading || scanning}
            style={{ background: '#065f46', color: '#d1fae5', border: 'none', padding: '10px 24px', borderRadius: 8, cursor: 'pointer', fontWeight: 700, opacity: scanning ? 0.6 : 1 }}>
            {scanning ? `Scanning ${data?.totalProbed ?? 0}+ hosts…` : 'Run Full Scan (150+ hosts)'}
          </button>
        </div>

        {/* Key / summary stats */}
        {data && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 32 }}>
            <StatCard label="Key Prefix" value={data.keyPrefix ?? '—'} />
            <StatCard label="Hosts Probed" value={String(data.totalProbed ?? 0)} />
            <StatCard label="Subscribed" value={String(data.totalSubscribed ?? 0)} highlight={(data.totalSubscribed ?? 0) > 0} />
            <StatCard label="Categories" value={String(categories.length)} highlight={categories.length > 0} />
            <StatCard label="Scanned At" value={data.scannedAt ? new Date(data.scannedAt).toLocaleTimeString() : '—'} />
          </div>
        )}

        {/* No key */}
        {data && !data.keyConfigured && (
          <div style={{ background: '#450a0a', border: '1px solid #7f1d1d', borderRadius: 8, padding: '16px 20px', marginBottom: 24 }}>
            <strong style={{ color: '#f87171' }}>No API key configured.</strong>
            <div style={{ color: '#fca5a5', marginTop: 4, fontSize: 13 }}>
              Add <code>RAPIDAPI_KEY=your_key</code> to <code>.env.local</code> and restart.
            </div>
          </div>
        )}

        {/* Find APIs for prompt */}
        {data && (data.totalSubscribed ?? 0) > 0 && (
          <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, padding: '20px', marginBottom: 32 }}>
            <h2 style={{ fontSize: 16, fontWeight: 700, color: '#e2e8f0', marginBottom: 12 }}>Find APIs for a Prompt</h2>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                value={findPrompt}
                onChange={e => setFindPrompt(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && find()}
                placeholder="e.g. build a sports score tracker app"
                style={{ flex: 1, background: '#1e293b', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 6, padding: '8px 12px', fontSize: 13, outline: 'none' }}
              />
              <button onClick={find} disabled={finding || !findPrompt.trim()}
                style={{ background: '#1d4ed8', color: '#dbeafe', border: 'none', padding: '8px 20px', borderRadius: 6, cursor: 'pointer', fontWeight: 600, opacity: finding ? 0.6 : 1 }}>
                {finding ? 'Matching…' : 'Find'}
              </button>
            </div>
            {findResult && (
              <div style={{ marginTop: 16 }}>
                {findResult.error && <div style={{ color: '#f87171', fontSize: 13 }}>{findResult.error}</div>}
                {findResult.matched && findResult.matched.length === 0 && (
                  <div style={{ color: '#64748b', fontSize: 13 }}>No subscribed APIs matched that prompt.</div>
                )}
                {findResult.matched && findResult.matched.length > 0 && (
                  <>
                    <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>
                      Top {findResult.matched.length} matches for: <em style={{ color: '#94a3b8' }}>{findResult.prompt}</em>
                    </div>
                    {findResult.matched.map(m => (
                      <div key={m.host} style={{ padding: '8px 12px', background: '#1e293b', borderRadius: 6, marginBottom: 6 }}>
                        <div style={{ fontWeight: 600, color: '#34d399', fontSize: 13 }}>{m.name}</div>
                        <div style={{ color: '#64748b', fontSize: 11, marginTop: 2 }}>{m.host}</div>
                        <div style={{ color: '#94a3b8', fontSize: 12, marginTop: 4 }}>{m.description}</div>
                        <div style={{ marginTop: 6 }}>
                          {m.categories.map(c => <CatTag key={c} label={c} />)}
                        </div>
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* Category overview grid */}
        {categories.length > 0 && (
          <div style={{ marginBottom: 32 }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: '#e2e8f0', marginBottom: 16 }}>
              Active by Category ({categories.length} categories, {subscribedEntries.length} providers)
            </h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
              {categories.map(cat => (
                <CategorySection
                  key={cat}
                  category={cat}
                  entries={(data!.byCategory as Record<string, DiscoveredEntry[]>)[cat]}
                />
              ))}
            </div>
          </div>
        )}

        {/* Full results table */}
        {allEntries.length > 0 && (
          <div style={{ marginBottom: 32 }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: '#e2e8f0', marginBottom: 12 }}>
              All Results ({allEntries.length} probed)
            </h2>
            <div style={{ overflowX: 'auto', background: '#0f172a', borderRadius: 8, border: '1px solid #1e293b' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: '#1e293b' }}>
                    {['Status', 'Name', 'Host', 'Categories', 'Latency'].map(h => (
                      <th key={h} style={{ padding: '10px 10px', textAlign: 'left', color: '#94a3b8', fontWeight: 600, fontSize: 10, textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {displayEntries.map(e => <EntryRow key={e.host} e={e} />)}
                </tbody>
              </table>
            </div>
            {allEntries.length > 80 && !showAll && (
              <button onClick={() => setShowAll(true)}
                style={{ marginTop: 12, background: '#1e293b', color: '#94a3b8', border: '1px solid #334155', padding: '8px 16px', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>
                Show all {allEntries.length} results
              </button>
            )}
          </div>
        )}

        {/* Not subscribed section */}
        {notSubscribed.length > 0 && (
          <div style={{ marginBottom: 32 }}>
            <h2 style={{ fontSize: 16, fontWeight: 700, color: '#64748b', marginBottom: 8 }}>
              Not Subscribed ({notSubscribed.length})
            </h2>
            <div style={{ color: '#475569', fontSize: 12, marginBottom: 10 }}>
              These hosts returned 403 Not Subscribed or timed out.
              Subscribe at <span style={{ color: '#34d399' }}>rapidapi.com</span> with key <strong>{data?.keyPrefix}</strong>.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 6 }}>
              {notSubscribed.map(e => (
                <div key={e.host} style={{ padding: '8px 10px', background: '#0f172a', borderRadius: 6, border: '1px solid #1e293b', fontSize: 12 }}>
                  <div style={{ color: '#94a3b8', fontWeight: 600 }}>{e.name}</div>
                  <div style={{ color: '#334155', fontSize: 10, marginTop: 2 }}>{e.host}</div>
                  {e.lastError && e.lastError !== 'Not subscribed' && (
                    <div style={{ color: '#7f1d1d', fontSize: 10, marginTop: 2 }}>{e.lastError}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Empty state */}
        {!data && !loading && !scanning && (
          <div style={{ textAlign: 'center', padding: '60px 0', color: '#475569' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>&#x1F50D;</div>
            <div style={{ fontSize: 18, color: '#64748b' }}>
              Click <strong style={{ color: '#34d399' }}>Run Full Scan</strong> to discover your active RapidAPI subscriptions.
            </div>
            <div style={{ fontSize: 13, marginTop: 8 }}>
              150+ hosts are tested in parallel — takes ~20-60 seconds.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
