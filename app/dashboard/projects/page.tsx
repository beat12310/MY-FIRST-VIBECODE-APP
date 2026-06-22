'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';

interface Project {
  name: string;
  path: string;
  port?: number;
  createdAt: string;
  status: string;
}

export default function ProjectsPage() {
  const { getToken } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const token = await getToken();
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      fetch('/api/projects', { headers })
        .then(r => r.json())
        .then(d => setProjects(d.projects ?? []))
        .catch(() => {})
        .finally(() => setLoading(false));
    })();
  }, [getToken]);

  return (
    <div style={{ color: '#f8fafc', maxWidth: 900 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 36 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-0.03em', marginBottom: 6 }}>My Projects</h1>
          <p style={{ color: '#64748b', fontSize: 15 }}>{projects.length} project{projects.length !== 1 ? 's' : ''} generated</p>
        </div>
        <Link href="/builder" style={{
          display: 'inline-flex', alignItems: 'center', gap: 8,
          background: 'linear-gradient(135deg,#8b5cf6,#6366f1)', color: '#fff',
          padding: '10px 20px', borderRadius: 8, fontSize: 14, fontWeight: 600, textDecoration: 'none',
        }}>
          ⚡ New project
        </Link>
      </div>

      {loading && (
        <div style={{ color: '#64748b', fontSize: 14 }}>Loading projects…</div>
      )}

      {!loading && projects.length === 0 && (
        <div style={{ textAlign: 'center', padding: '80px 40px', background: 'rgba(15,15,25,0.4)', border: '1px dashed rgba(255,255,255,0.08)', borderRadius: 16 }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>📂</div>
          <h3 style={{ fontSize: 18, fontWeight: 700, color: '#f8fafc', marginBottom: 8 }}>No projects yet</h3>
          <p style={{ color: '#64748b', fontSize: 14, marginBottom: 24 }}>Head to the builder and generate your first app.</p>
          <Link href="/builder" style={{ display: 'inline-block', background: 'linear-gradient(135deg,#8b5cf6,#6366f1)', color: '#fff', padding: '10px 24px', borderRadius: 8, fontSize: 14, fontWeight: 600, textDecoration: 'none' }}>
            Open builder
          </Link>
        </div>
      )}

      {!loading && projects.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', gap: 20 }}>
          {projects.map((p, i) => (
            <div key={i} style={{
              background: 'rgba(15,15,25,0.6)', border: '1px solid rgba(255,255,255,0.07)',
              borderRadius: 14, padding: 24, display: 'flex', flexDirection: 'column', gap: 16,
              transition: 'border-color 0.15s',
            }}
              onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(139,92,246,0.3)')}
              onMouseLeave={e => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)')}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ width: 44, height: 44, borderRadius: 10, background: 'linear-gradient(135deg,rgba(139,92,246,0.2),rgba(99,102,241,0.2))', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20 }}>📱</div>
                <div style={{ fontSize: 11, color: '#22c55e', background: 'rgba(34,197,94,0.1)', padding: '3px 8px', borderRadius: 100, flexShrink: 0 }}>
                  {p.status ?? 'built'}
                </div>
              </div>

              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#f8fafc', marginBottom: 4 }}>{p.name}</div>
                <div style={{ fontSize: 12, color: '#64748b' }}>{new Date(p.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}</div>
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                {p.port && (
                  <a href={`http://localhost:${p.port}`} target="_blank" rel="noreferrer" style={{
                    flex: 1, textAlign: 'center',
                    background: 'linear-gradient(135deg,#8b5cf6,#6366f1)', color: '#fff',
                    padding: '8px', borderRadius: 7, fontSize: 13, fontWeight: 600, textDecoration: 'none',
                  }}>
                    Open preview
                  </a>
                )}
                <Link href="/builder" style={{
                  flex: 1, textAlign: 'center',
                  background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)',
                  color: '#94a3b8', padding: '8px', borderRadius: 7, fontSize: 13, fontWeight: 600, textDecoration: 'none',
                }}>
                  Edit
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
