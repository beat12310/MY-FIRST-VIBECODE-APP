'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface BuildEvent {
  projectName: string;
  projectPath: string;
  action: 'generated' | 'rebuilt' | 'verified' | 'deployed';
  timestamp: string;
  durationMs?: number;
  success: boolean;
  notes?: string;
}

interface Project {
  name: string;
  path: string;
  createdAt: string;
  status: string;
  port?: number;
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  if (m > 0) return `${m}m ago`;
  return 'just now';
}

function formatDuration(ms?: number): string {
  if (!ms) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function HistoryPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [events, setEvents] = useState<BuildEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'projects' | 'events'>('projects');

  useEffect(() => {
    Promise.all([
      fetch('/api/projects').then(r => r.json()).catch(() => ({ projects: [] })),
      fetch('/api/build-history').then(r => r.json()).catch(() => ({ events: [] })),
    ]).then(([pd, ed]) => {
      setProjects(pd.projects ?? []);
      setEvents(ed.events ?? []);
    }).finally(() => setLoading(false));
  }, []);

  // Derive synthetic events from project list if no real events yet
  const displayEvents: BuildEvent[] = events.length > 0
    ? events
    : projects.map(p => ({
        projectName: p.name,
        projectPath: p.path,
        action: 'generated' as const,
        timestamp: p.createdAt,
        success: true,
        notes: 'Generated via DWOMOH Vibe Code pipeline',
      }));

  return (
    <div style={{ color: '#f8fafc', maxWidth: 900 }}>
      <div style={{ marginBottom: 36 }}>
        <h1 style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-0.03em', marginBottom: 6 }}>Build History</h1>
        <p style={{ color: '#64748b', fontSize: 15 }}>{projects.length} project{projects.length !== 1 ? 's' : ''} generated</p>
      </div>

      {/* View toggle */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 32, background: 'rgba(255,255,255,0.04)', borderRadius: 10, padding: 4, width: 'fit-content' }}>
        {(['projects', 'events'] as const).map(v => (
          <button key={v} onClick={() => setView(v)} style={{
            padding: '8px 20px', borderRadius: 8, border: 'none', cursor: 'pointer',
            background: view === v ? 'rgba(139,92,246,0.2)' : 'transparent',
            color: view === v ? '#a78bfa' : '#64748b',
            fontSize: 14, fontWeight: view === v ? 600 : 400, textTransform: 'capitalize',
          }}>
            {v === 'projects' ? 'Projects' : 'Build Events'}
          </button>
        ))}
      </div>

      {loading && <div style={{ color: '#64748b', fontSize: 14 }}>Loading…</div>}

      {!loading && view === 'projects' && (
        projects.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '80px 40px', background: 'rgba(15,15,25,0.4)', border: '1px dashed rgba(255,255,255,0.08)', borderRadius: 16 }}>
            <div style={{ fontSize: 40, marginBottom: 14 }}>📂</div>
            <h3 style={{ fontSize: 17, fontWeight: 700, marginBottom: 8 }}>No projects yet</h3>
            <p style={{ color: '#64748b', fontSize: 14, marginBottom: 24 }}>Generate your first app to see it here.</p>
            <Link href="/builder" style={{ display: 'inline-block', background: 'linear-gradient(135deg,#8b5cf6,#6366f1)', color: '#fff', padding: '10px 24px', borderRadius: 8, fontSize: 14, fontWeight: 600, textDecoration: 'none' }}>
              Open builder
            </Link>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {projects.map((p, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 16,
                background: 'rgba(15,15,25,0.6)', border: '1px solid rgba(255,255,255,0.07)',
                borderRadius: 12, padding: '16px 20px',
                transition: 'border-color 0.15s',
              }}
                onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(139,92,246,0.25)')}
                onMouseLeave={e => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)')}>
                <div style={{ width: 40, height: 40, borderRadius: 10, background: 'linear-gradient(135deg,rgba(139,92,246,0.2),rgba(99,102,241,0.2))', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, flexShrink: 0 }}>
                  📱
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#f8fafc', marginBottom: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>
                  <div style={{ fontSize: 12, color: '#64748b' }}>
                    {new Date(p.createdAt).toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })}
                    {' · '}{formatRelative(p.createdAt)}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  <span style={{ fontSize: 11, color: '#22c55e', background: 'rgba(34,197,94,0.1)', padding: '3px 8px', borderRadius: 100 }}>built</span>
                  {p.port && (
                    <a href={`http://localhost:${p.port}`} target="_blank" rel="noreferrer" style={{
                      fontSize: 12, color: '#8b5cf6', background: 'rgba(139,92,246,0.1)', padding: '3px 10px', borderRadius: 100, textDecoration: 'none',
                    }}>
                      Preview ↗
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {!loading && view === 'events' && (
        displayEvents.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px', color: '#475569', fontSize: 14 }}>No build events recorded yet.</div>
        ) : (
          <div style={{ position: 'relative' }}>
            {/* Timeline line */}
            <div style={{ position: 'absolute', left: 19, top: 0, bottom: 0, width: 1, background: 'rgba(255,255,255,0.06)' }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              {displayEvents.map((ev, i) => (
                <div key={i} style={{ display: 'flex', gap: 20, paddingBottom: 24 }}>
                  {/* Dot */}
                  <div style={{ width: 38, flexShrink: 0, display: 'flex', alignItems: 'flex-start', paddingTop: 2 }}>
                    <div style={{
                      width: 14, height: 14, borderRadius: '50%', marginLeft: 6, marginTop: 2,
                      background: ev.success ? '#22c55e' : '#ef4444',
                      boxShadow: ev.success ? '0 0 8px rgba(34,197,94,0.4)' : '0 0 8px rgba(239,68,68,0.4)',
                    }} />
                  </div>
                  <div style={{
                    flex: 1, background: 'rgba(15,15,25,0.6)', border: '1px solid rgba(255,255,255,0.07)',
                    borderRadius: 10, padding: '14px 18px',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                      <div>
                        <span style={{ fontSize: 13, fontWeight: 700, color: '#f8fafc' }}>{ev.projectName}</span>
                        <span style={{ fontSize: 12, color: '#64748b', marginLeft: 10 }}>
                          {{generated: 'Generated', rebuilt: 'Rebuilt', verified: 'Verified', deployed: 'Deployed'}[ev.action]}
                        </span>
                      </div>
                      <div style={{ fontSize: 12, color: '#475569', whiteSpace: 'nowrap' }}>{formatRelative(ev.timestamp)}</div>
                    </div>
                    {ev.notes && <p style={{ fontSize: 12, color: '#64748b', marginTop: 6 }}>{ev.notes}</p>}
                    {ev.durationMs && (
                      <div style={{ marginTop: 6, fontSize: 11, color: '#475569' }}>Duration: {formatDuration(ev.durationMs)}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      )}
    </div>
  );
}
