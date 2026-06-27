'use client';

/**
 * DeployDashboard — One-click deploy control panel for DWOMOH Vibe Code.
 *
 * Features:
 *  - Deploy to Live button (streams SSE progress)
 *  - Live progress bar + phase log
 *  - Deployment history table
 *  - Rollback to Previous button
 *  - Real-time URL status indicators
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DeployEvent {
  type: 'progress' | 'phase' | 'step' | 'log' | 'error' | 'complete' | 'fatal' | 'done';
  pct?: number;
  msg?: string;
  name?: string;
  icon?: string;
  label?: string;
  detail?: string;
  phase?: string;
  record?: DeployRecord;
  code?: number;
}

interface DeployRecord {
  id: string;
  commitHash: string;
  commitMessage: string;
  timestamp: string;
  status: 'success' | 'partial' | 'failed';
  durationMs: number;
  amplifyJobId: string;
  appId: string;
  urls: string[];
  rollbackTarget?: string;
}

interface LogLine {
  id: number;
  type: string;
  text: string;
  timestamp: string;
}

// ─── Status indicator ─────────────────────────────────────────────────────────

function StatusDot({ status }: { status: 'idle' | 'running' | 'success' | 'failed' }) {
  const colors: Record<string, string> = {
    idle:    'bg-gray-400',
    running: 'bg-yellow-400 animate-pulse',
    success: 'bg-green-500',
    failed:  'bg-red-500',
  };
  return <span className={`inline-block w-2.5 h-2.5 rounded-full ${colors[status] ?? 'bg-gray-400'}`} />;
}

// ─── Progress bar ─────────────────────────────────────────────────────────────

function ProgressBar({ pct, running }: { pct: number; running: boolean }) {
  return (
    <div className="relative h-3 bg-gray-800 rounded-full overflow-hidden">
      <motion.div
        className={`h-full rounded-full ${running ? 'bg-gradient-to-r from-blue-500 via-purple-500 to-pink-500' : pct >= 100 ? 'bg-green-500' : 'bg-blue-500'}`}
        initial={{ width: 0 }}
        animate={{ width: `${pct}%` }}
        transition={{ ease: 'easeOut', duration: 0.5 }}
      />
      {running && (
        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent animate-[shimmer_1.5s_infinite]" />
      )}
    </div>
  );
}

// ─── Duration formatter ───────────────────────────────────────────────────────

function fmtDur(ms: number) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function DeployDashboard() {
  const [status, setStatus]         = useState<'idle' | 'running' | 'success' | 'failed'>('idle');
  const [progress, setProgress]     = useState(0);
  const [progressMsg, setProgressMsg] = useState('');
  const [currentPhase, setCurrentPhase] = useState('');
  const [log, setLog]               = useState<LogLine[]>([]);
  const [history, setHistory]       = useState<DeployRecord[]>([]);
  const [selectedTab, setSelectedTab] = useState<'deploy' | 'history'>('deploy');
  const [urlStatus, setUrlStatus]   = useState<Record<string, 'checking' | 'ok' | 'fail'>>({});
  const logRef                      = useRef<HTMLDivElement>(null);
  const logCounter                  = useRef(0);

  // Load history on mount
  useEffect(() => {
    fetch('/api/deploy-live/history')
      .then(r => r.json())
      .then(d => setHistory(d.history ?? []))
      .catch(() => {});
  }, []);

  // Auto-scroll log
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [log]);

  function addLog(type: string, text: string) {
    setLog(prev => [...prev.slice(-200), {
      id: logCounter.current++,
      type,
      text,
      timestamp: new Date().toLocaleTimeString(),
    }]);
  }

  const handleEvent = useCallback((evt: DeployEvent) => {
    switch (evt.type) {
      case 'progress':
        setProgress(evt.pct ?? 0);
        setProgressMsg(evt.msg ?? '');
        addLog('progress', `${evt.pct}%  ${evt.msg}`);
        break;
      case 'phase':
        setCurrentPhase(evt.name ?? '');
        addLog('phase', `── ${evt.name} ──`);
        break;
      case 'step':
        addLog('step', `${evt.icon ?? '•'} ${evt.label}${evt.detail ? '  ' + evt.detail : ''}`);
        break;
      case 'log':
        if (evt.msg?.trim()) addLog('log', evt.msg.trim());
        break;
      case 'error':
        addLog('error', `ERROR [${evt.phase}]: ${evt.msg}`);
        setStatus('failed');
        break;
      case 'fatal':
        addLog('error', `FATAL: ${evt.msg}`);
        setStatus('failed');
        break;
      case 'complete':
        setProgress(100);
        setStatus('success');
        if (evt.record) {
          setHistory(prev => [evt.record!, ...prev.slice(0, 19)]);
        }
        addLog('success', '🚀 Deployment complete!');
        break;
      case 'done':
        if (status !== 'success') setStatus(evt.code === 0 ? 'success' : 'failed');
        break;
    }
  }, [status]);

  async function startDeploy(opts: { skipBuild?: boolean; rollback?: boolean } = {}) {
    setStatus('running');
    setProgress(0);
    setProgressMsg('Starting…');
    setLog([]);
    setCurrentPhase('');
    addLog('phase', `── ${opts.rollback ? 'ROLLBACK' : 'DEPLOY TO LIVE'} ──`);

    try {
      const res = await fetch('/api/deploy-live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...opts, noBrowser: true }),
      });

      if (!res.ok || !res.body) {
        setStatus('failed');
        addLog('error', `Failed to start: HTTP ${res.status}`);
        return;
      }

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let   buffer  = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const line = part.replace(/^data: /, '');
          if (!line.trim()) continue;
          try { handleEvent(JSON.parse(line)); } catch { }
        }
      }
    } catch (e) {
      setStatus('failed');
      addLog('error', String(e));
    }
  }

  async function checkLiveUrls() {
    const urls = ['https://dwomohvibe.com', 'https://www.dwomohvibe.com'];
    setUrlStatus(Object.fromEntries(urls.map(u => [u, 'checking'])));
    for (const url of urls) {
      try {
        const r = await fetch(`/api/check-url?url=${encodeURIComponent(url)}`);
        const d = await r.json();
        setUrlStatus(prev => ({ ...prev, [url]: d.ok ? 'ok' : 'fail' }));
      } catch {
        setUrlStatus(prev => ({ ...prev, [url]: 'fail' }));
      }
    }
  }

  const logColors: Record<string, string> = {
    phase:   'text-purple-400 font-semibold',
    progress:'text-blue-400',
    step:    'text-gray-200',
    log:     'text-gray-400',
    error:   'text-red-400',
    success: 'text-green-400 font-semibold',
  };

  return (
    <div className="h-full flex flex-col bg-gray-950 text-gray-100 font-mono text-sm select-none">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 bg-gray-900">
        <div className="flex items-center gap-3">
          <span className="text-lg">🚀</span>
          <span className="font-semibold text-white">Deploy Dashboard</span>
          <StatusDot status={status} />
          <span className="text-xs text-gray-500">
            {status === 'running' ? progressMsg : status === 'success' ? 'Last deploy succeeded' : status === 'failed' ? 'Last deploy failed' : 'Ready'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {['deploy', 'history'].map(t => (
            <button
              key={t}
              onClick={() => setSelectedTab(t as 'deploy' | 'history')}
              className={`px-3 py-1 rounded text-xs transition-colors ${selectedTab === t ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}
            >
              {t === 'deploy' ? '⚡ Deploy' : '📋 History'}
            </button>
          ))}
        </div>
      </div>

      {/* Tab: Deploy */}
      <AnimatePresence mode="wait">
        {selectedTab === 'deploy' && (
          <motion.div key="deploy" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex-1 flex flex-col overflow-hidden">
            {/* Action bar */}
            <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-3 flex-wrap">
              <button
                onClick={() => startDeploy()}
                disabled={status === 'running'}
                className="flex items-center gap-2 px-5 py-2 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition-all shadow-lg shadow-blue-900/30"
              >
                {status === 'running' ? (
                  <><span className="animate-spin">⏳</span> Deploying…</>
                ) : (
                  <><span>🚀</span> Deploy to Live</>
                )}
              </button>

              <button
                onClick={() => startDeploy({ skipBuild: true })}
                disabled={status === 'running'}
                className="flex items-center gap-2 px-3 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-300 text-xs rounded-lg transition-colors"
              >
                ⚡ Quick Deploy
              </button>

              <button
                onClick={() => startDeploy({ rollback: true })}
                disabled={status === 'running' || history.filter(h => h.status === 'success').length < 2}
                className="flex items-center gap-2 px-3 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-300 text-xs rounded-lg transition-colors"
                title="Rollback to previous successful deployment"
              >
                ⏮ Rollback
              </button>

              <button
                onClick={checkLiveUrls}
                className="ml-auto flex items-center gap-2 px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs rounded-lg transition-colors"
              >
                🔍 Check Live
              </button>
            </div>

            {/* Progress */}
            <div className="px-4 py-3 border-b border-gray-800">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-gray-400">{currentPhase || (status === 'idle' ? 'Ready to deploy' : progressMsg)}</span>
                <span className="text-xs text-gray-500">{progress}%</span>
              </div>
              <ProgressBar pct={progress} running={status === 'running'} />
            </div>

            {/* URL status badges */}
            {Object.keys(urlStatus).length > 0 && (
              <div className="px-4 py-2 border-b border-gray-800 flex items-center gap-4">
                {Object.entries(urlStatus).map(([url, s]) => (
                  <div key={url} className="flex items-center gap-2 text-xs">
                    <StatusDot status={s === 'ok' ? 'success' : s === 'fail' ? 'failed' : 'running'} />
                    <a href={url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">{url.replace('https://', '')}</a>
                    <span className={s === 'ok' ? 'text-green-400' : s === 'fail' ? 'text-red-400' : 'text-yellow-400'}>
                      {s === 'ok' ? 'HTTP 200' : s === 'fail' ? 'FAIL' : '…'}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Log */}
            <div ref={logRef} className="flex-1 overflow-y-auto px-4 py-2 space-y-0.5">
              {log.length === 0 ? (
                <div className="text-gray-600 text-center py-8">
                  Click "Deploy to Live" to start the deployment pipeline.<br />
                  <span className="text-xs">Lint → TypeScript → Build → Commit → Push → Amplify → Verify</span>
                </div>
              ) : (
                log.map(line => (
                  <div key={line.id} className={`flex gap-2 leading-5 ${logColors[line.type] ?? 'text-gray-400'}`}>
                    <span className="shrink-0 text-gray-600 text-xs pt-0.5">{line.timestamp}</span>
                    <span className="break-all whitespace-pre-wrap">{line.text}</span>
                  </div>
                ))
              )}
              {status === 'success' && (
                <div className="mt-4 p-3 bg-green-900/30 border border-green-700 rounded-lg text-green-300 text-center">
                  ✅ Deployment complete — <a href="https://dwomohvibe.com" target="_blank" rel="noopener noreferrer" className="underline">dwomohvibe.com</a>
                </div>
              )}
              {status === 'failed' && (
                <div className="mt-4 p-3 bg-red-900/30 border border-red-700 rounded-lg text-red-300 text-center">
                  ❌ Deployment failed — check log above for details
                </div>
              )}
            </div>
          </motion.div>
        )}

        {/* Tab: History */}
        {selectedTab === 'history' && (
          <motion.div key="history" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex-1 overflow-y-auto">
            {history.length === 0 ? (
              <div className="text-gray-600 text-center py-12">No deployment history yet.</div>
            ) : (
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-gray-900 border-b border-gray-800">
                  <tr className="text-left text-gray-500">
                    <th className="px-4 py-2">#</th>
                    <th className="px-4 py-2">Status</th>
                    <th className="px-4 py-2">Time</th>
                    <th className="px-4 py-2">Commit</th>
                    <th className="px-4 py-2">Duration</th>
                    <th className="px-4 py-2">Job</th>
                    <th className="px-4 py-2">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((dep, i) => (
                    <tr key={dep.id} className="border-b border-gray-800/50 hover:bg-gray-900/50 transition-colors">
                      <td className="px-4 py-2 text-gray-500">{i + 1}</td>
                      <td className="px-4 py-2">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                          dep.status === 'success' ? 'bg-green-900/50 text-green-300' :
                          dep.status === 'partial' ? 'bg-yellow-900/50 text-yellow-300' :
                          'bg-red-900/50 text-red-300'
                        }`}>
                          {dep.status === 'success' ? '✅' : dep.status === 'partial' ? '⚠️' : '❌'} {dep.status}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-gray-400">{fmtTime(dep.timestamp)}</td>
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-2">
                          <code className="text-purple-400">{dep.commitHash.slice(0, 7)}</code>
                          <span className="text-gray-400 truncate max-w-[200px]" title={dep.commitMessage}>{dep.commitMessage.slice(0, 45)}</span>
                        </div>
                      </td>
                      <td className="px-4 py-2 text-gray-400">{fmtDur(dep.durationMs)}</td>
                      <td className="px-4 py-2">
                        <a
                          href={`https://console.aws.amazon.com/amplify/home#/apps/${dep.appId}/branches/main/deployments/${dep.amplifyJobId}`}
                          target="_blank" rel="noopener noreferrer"
                          className="text-blue-400 hover:underline"
                        >
                          #{dep.amplifyJobId}
                        </a>
                      </td>
                      <td className="px-4 py-2">
                        {i > 0 && dep.status === 'success' && (
                          <button
                            onClick={() => { setSelectedTab('deploy'); startDeploy({ rollback: true }); }}
                            disabled={status === 'running'}
                            className="text-xs px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded disabled:opacity-50 transition-colors"
                            title={`Rollback to ${dep.commitHash.slice(0,7)}`}
                          >
                            ⏮ Rollback
                          </button>
                        )}
                        {i === 0 && <span className="text-green-500 text-xs">← current</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
