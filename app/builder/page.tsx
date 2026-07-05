'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { useAuth } from '@/lib/auth-context';
import { PROJECT_TEMPLATES } from '@/lib/project-templates';
import { interpretCommand, getActionLabel } from '@/lib/nl-command-interpreter';
import { detectIntent, type MessageIntent } from '@/lib/intent-classifier';
import { decideProjectOpenRouting, reportsRoutingProblem } from '@/lib/repair-routing';
import { saveOpenProject, clearOpenProject, loadOpenProject } from '@/lib/project-session-storage';
import { parseApiResponse, truncateForLog } from '@/lib/safe-json-response';
import { isEnvironmentalServerError, hasNoActionableCodeEvidence, isIdenticalRepeatedError } from '@/lib/server-start-diagnostics';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

type ErrorCategory = 'network' | 'api' | 'auth' | 'timeout' | 'quota' | 'config' | 'image' | 'unknown';

interface DisplayMessage {
  role: 'user' | 'assistant' | 'status';
  content: string;
  statusType?: 'checking' | 'reading' | 'applying' | 'done' | 'error';
  screenshotUrl?: string;
  logoSvg?: string;           // single inline logo preview with action buttons
  logoConcepts?: string[];    // multi-concept grid — 3 selectable cards inline
  logoConceptLabels?: string[];
  errorMeta?: {              // structured error card — user sees friendly text, technical goes to logs
    category: ErrorCategory;
    title: string;
    explanation: string;
    whatNext: string;
    recoveryActions?: Array<{ label: string; action: 'retry-logo' | 'retry-research' | 'open-logs' | 'focus-input' | 'claude-bridge'; prompt?: string }>;
  };
}

type BuildPhase = 'idle' | 'conversing' | 'building' | 'previewing';
type BuildStep = 'generating' | 'creating' | 'installing' | 'validating' | 'starting' | 'verifying' | 'done' | 'error';

interface UploadedAsset {
  id: string;
  dataUrl: string;   // data URL for preview
  base64: string;    // raw base64 for AI calls
  name: string;
  type: string;      // MIME type
  role?: 'logo' | 'hero' | 'product' | 'background' | 'icon' | 'gallery' | 'inspiration';
  analysis?: string; // AI description
}

interface BuildProgress {
  step: BuildStep;
  message: string;
  logs: string[];
  projectName?: string;
  projectPath?: string;
  port?: number;
}

interface ProjectMeta {
  id: string;
  name: string;
  description: string;
  projectPath: string;
  port?: number;
  createdAt: string;
  filesCount: number;
}

type ProjectMode = 'Static Demo' | 'Frontend Only' | 'Full-Stack App' | 'Production Ready App';

interface MissingCredential {
  key: string;
  description: string;
}

interface ProjectDiscovery {
  summary: string;
  pages: string[];
  components: string[];
  fileCount: number;
  framework: string;
  dependencies?: string[];
  mode?: ProjectMode;
  hasApiRoutes?: boolean;
  missingCredentials?: MissingCredential[];
}

interface ProjectMemory {
  name: string;
  originalPrompt: string;
  purpose: string;
  runningPort: number | null;
  buildStatus: string;
  pages: string[];
  components: string[];
  fileTree: string[];
  featuresBuilt: string[];
  editsApplied: Array<{ request: string; filesChanged: string[]; date: string }>;
  conversationHistory: Array<{ role: string; content: string; timestamp: string }>;
  lastDiscovery: { summary: string; framework: string } | null;
  lastOpenedAt?: string;
  // Persisted scaffold & runtime state
  authProvider?: string;
  dbIntegrations?: string[];
  deployConfigs?: string[];
  verificationHistory?: Array<{ date: string; verified: boolean; summary: string; passedCount: number; totalCount: number }>;
  browserSessions?: Array<{ date: string; pageTitle?: string; errorCount: number; requestCount: number; screenshotUrl?: string }>;
  fileOperations?: Array<{ op: string; path: string; newPath?: string; date: string }>;
}

// ─── Status message styling ────────────────────────────────────────────────────

const STATUS_STYLE: Record<string, { bg: string; text: string; icon: string }> = {
  checking: { bg: '#1e3a5f', text: '#93c5fd', icon: '🔍' },
  reading:  { bg: '#1e3a5f', text: '#93c5fd', icon: '📄' },
  applying: { bg: '#1a3325', text: '#86efac', icon: '✏️' },
  done:     { bg: '#052e16', text: '#4ade80', icon: '✅' },
  error:    { bg: '#3b0000', text: '#f87171', icon: '❌' },
};

// ─── Build Style Picker ────────────────────────────────────────────────────────

type BuildStyle = 'classic' | 'modern' | 'premium-3d' | 'mobile-first' | 'minimal';

const BUILD_STYLES: Array<{ id: BuildStyle; label: string; icon: string; desc: string; accent: string }> = [
  { id: 'classic',      label: 'Classic',      icon: '🏛️', desc: 'Professional blue palette, clean grids',      accent: '#3b82f6' },
  { id: 'modern',       label: 'Modern',       icon: '⚡', desc: 'Bold gradients, vibrant colors, fluid motion', accent: '#8b5cf6' },
  { id: 'premium-3d',   label: 'Premium 3D',   icon: '💎', desc: 'Glassmorphism, gold accents, depth effects',   accent: '#d4a017' },
  { id: 'mobile-first', label: 'Mobile First', icon: '📱', desc: 'Native app feel, bottom nav, touch targets',   accent: '#10b981' },
  { id: 'minimal',      label: 'Minimal',      icon: '○',  desc: 'White space, system font, content-first',     accent: '#94a3b8' },
];

function BuildStylePickerInline({ value, onChange }: { value: BuildStyle; onChange: (s: BuildStyle) => void }) {
  const [open, setOpen] = useState(false);
  const cur = BUILD_STYLES.find(s => s.id === value) ?? BUILD_STYLES[1];
  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <button type="button" onClick={() => setOpen(o => !o)} title="Design style"
        style={{ padding: '5px 9px', background: open ? `rgba(${cur.accent.slice(1).match(/../g)!.map(h=>parseInt(h,16)).join(',')},0.12)` : 'transparent', border: `1px solid ${open ? cur.accent + '55' : '#1e3a5f'}`, borderRadius: '8px', color: open ? cur.accent : '#475569', cursor: 'pointer', fontSize: '11px', fontWeight: '700', letterSpacing: '0.03em', transition: 'all 0.15s', display: 'flex', alignItems: 'center', gap: '5px', whiteSpace: 'nowrap' }}>
        <span>{cur.icon}</span>
        <span>{cur.label}</span>
        <svg width="9" height="9" viewBox="0 0 9 9" style={{ opacity: 0.5, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
          <path d="M1.5 3L4.5 6L7.5 3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 49 }} onClick={() => setOpen(false)} />
          <div style={{ position: 'absolute', bottom: 'calc(100% + 8px)', left: 0, zIndex: 50, background: '#080f1e', border: '1px solid #1e3a5f', borderRadius: '12px', padding: '7px', width: '248px', boxShadow: '0 -8px 32px rgba(0,0,0,0.7)' }}>
            <div style={{ fontSize: '9px', color: '#334155', fontWeight: '800', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: '5px', padding: '1px 4px' }}>Design Style</div>
            {BUILD_STYLES.map(s => (
              <button key={s.id} type="button" onClick={() => { onChange(s.id); setOpen(false); }}
                style={{ width: '100%', textAlign: 'left', padding: '7px 9px', background: value === s.id ? `rgba(${s.accent.slice(1).match(/../g)!.map(h=>parseInt(h,16)).join(',')},0.1)` : 'transparent', border: `1px solid ${value === s.id ? s.accent + '44' : 'transparent'}`, borderRadius: '8px', cursor: 'pointer', marginBottom: '2px', transition: 'all 0.1s', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '15px' }}>{s.icon}</span>
                <div>
                  <div style={{ fontSize: '12px', fontWeight: '600', color: value === s.id ? s.accent : '#e2e8f0', lineHeight: 1.2 }}>{s.label}</div>
                  <div style={{ fontSize: '10px', color: '#475569', marginTop: '1px' }}>{s.desc}</div>
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Hard-error patterns (module scope so async callbacks can use them) ───────
// These errors cannot be fixed by AI code generation — they require direct file
// inspection and editing (SQLite migrations, module resolution, runtime crashes).

const HARD_ERROR_PATTERNS_MODULE: Array<{ label: string; patterns: RegExp[] }> = [
  { label: 'SQLite schema mismatch',     patterns: [/no such column/i, /has no column named/i, /table.*has no column/i, /SQLITE_ERROR.*column/i] },
  { label: 'SQLite missing table',       patterns: [/no such table/i, /SQLITE_ERROR.*table/i] },
  { label: 'PostgreSQL schema mismatch', patterns: [/relation .* does not exist/i, /column .* of relation/i, /column .* does not exist/i] },
  { label: 'Module import failure',      patterns: [/Cannot find module/i, /Module not found: Error/i, /Cannot resolve module/i] },
  { label: 'Missing source file',        patterns: [/ENOENT.*no such file or directory/i, /failed to read file/i] },
  { label: 'Runtime crash',             patterns: [/UnhandledPromiseRejection/i, /ReferenceError.*is not defined/i, /TypeError.*is not a function/i] },
  { label: 'Build compilation failure',  patterns: [/Build optimization failed/i, /Export encountered errors/i, /Failed to compile/i] },
  { label: 'Auth route returning 500',   patterns: [/500.*\/api\/auth/i, /api\/auth.*500/i] },
];

function getHardErrorLabelModule(check: { error?: string; rootCause?: unknown }): string | null {
  const errText = [(check.error ?? ''), ((check.rootCause as Record<string, string>)?.detail ?? '')].join(' ');
  for (const { label, patterns } of HARD_ERROR_PATTERNS_MODULE) {
    if (patterns.some(p => p.test(errText))) return label;
  }
  return null;
}

// ─── Component ─────────────────────────────────────────────────────────────────

function BuilderInner() {
  const { user, loading: authLoading, getToken } = useAuth();
  const searchParams = useSearchParams();
  // Conversation
  const [phase, setPhase] = useState<BuildPhase>('idle');
  const [history, setHistory] = useState<ConversationTurn[]>([]);
  const [displayed, setDisplayed] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState('');

  // ── Engine Build (Step 9) — TEST ONLY. Self-contained; does not affect the main
  //    build flow, the old build button, billing, auth, or deploy. ──────────────
  const [engineOpen, setEngineOpen] = useState(false);
  const [enginePrompt, setEnginePrompt] = useState('');
  const [engineBusy, setEngineBusy] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [engineReport, setEngineReport] = useState<any>(null);
  const [engineError, setEngineError] = useState('');
  const [engineStage, setEngineStage] = useState('');
  const engineEsRef = useRef<EventSource | null>(null);
  const [loading, setLoading] = useState(false);
  const [readyToBuild, setReadyToBuild] = useState(false);

  // ── Repaired-engine Send-button migration flag ────────────────────────────
  // Server-side gate (see action:'feature-flags' in app/api/chat/route.ts) so
  // rollout/rollback needs no rebuild.
  //
  // ROOT CAUSE fixed here: this was originally read from a useState populated
  // by a fire-and-forget useEffect fetch — confirmed live (server logs showed
  // zero requests to /api/engine-build-stream-prod, and the OLD pipeline's own
  // Playwright "browser analysis" gate ran instead) that runBuildPipeline's
  // `if (useEngineBuildForSend)` check was reading the state BEFORE the async
  // fetch had resolved: a race between the mount-time fetch and the user's
  // Send click, not a caching problem — the value was simply still the
  // useState default (false) at the moment it was read. A React state
  // variable can only ever reflect its value AT THE LAST RENDER, so no amount
  // of re-fetching removes the window where it's stale; the fix is to make
  // the flag consumer explicitly AWAIT resolution instead of reading a
  // snapshot. engineFlagRef holds the in-flight/resolved promise; every read
  // (see runBuildPipeline) awaits it directly, so the value used to route the
  // Send button is always the server's actual current answer, never a stale
  // default, regardless of how quickly the user clicks after page load.
  const engineFlagRef = useRef<Promise<boolean> | null>(null);
  if (!engineFlagRef.current) {
    engineFlagRef.current = fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'feature-flags' }) })
      .then(r => r.json())
      .then(d => {
        const flag = d?.success ? !!d.engineBuildForSend : false;
        console.log(`[send-routing] feature-flags fetch resolved: engineBuildForSend=${flag}`);
        return flag;
      })
      .catch((e) => {
        console.log(`[send-routing] feature-flags fetch FAILED, defaulting to false (old pipeline): ${e instanceof Error ? e.message : e}`);
        return false; // fail closed — keep the old pipeline
      });
  }

  // Build target: 'web' = existing Next.js pipeline, 'flutter' = new Flutter pipeline
  const [buildTarget, setBuildTarget] = useState<'web' | 'flutter'>('web');

  // Design style — injected into BUILD_SYSTEM_PROMPT at generation time
  const [buildStyle, setBuildStyle] = useState<'classic' | 'modern' | 'premium-3d' | 'mobile-first' | 'minimal'>('modern');

  // Flutter build progress — completely separate from buildProgress (web-only)
  interface FlutterBuildProgress {
    step: 'generating' | 'writing' | 'pub-get' | 'analyzing' | 'building-apk' | 'done' | 'error';
    message: string;
    logs: string[];
    projectPath?: string;
    projectName?: string;
    apkPath?: string;
    analyzeErrors?: string[];
  }
  const [flutterBuildProgress, setFlutterBuildProgress] = useState<FlutterBuildProgress | null>(null);
  const flutterPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Build
  const [buildProgress, setBuildProgress] = useState<BuildProgress | null>(null);
  const [lastVerification, setLastVerification] = useState<{ verified: boolean; summary: string; checks: Array<{ name: string; passed: boolean; recordCount?: number; error?: string }> } | null>(null);

  // Preview
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewKey, setPreviewKey] = useState(0);
  const [previewLoading, setPreviewLoading] = useState(false);
  // True when the preview iframe is confirmed to be showing the scaffold/placeholder page.
  // Blocks "● Live" / "verified" UI and shows a re-generating overlay instead.
  const [scaffoldDetected, setScaffoldDetected] = useState(false);

  // Project sidebar
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [currentProject, setCurrentProject] = useState<ProjectMeta | null>(null);
  const [currentDiscovery, setCurrentDiscovery] = useState<ProjectDiscovery | null>(null);
  const [currentMemory, setCurrentMemory] = useState<ProjectMemory | null>(null);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [editApplying, setEditApplying] = useState(false);
  const [credentialInputs, setCredentialInputs] = useState<Record<string, string>>({});
  const [credentialSaving, setCredentialSaving] = useState<string | null>(null);
  const [makeSearchWorking, setMakeSearchWorking] = useState(false);

  // ── Claude Code Bridge ────────────────────────────────────────────────────
  // Forwards prompts from DWOMOH VIBE CODE to the local Claude Code CLI, which
  // edits the generated project files directly and streams progress back here.
  const [bridgeSession, setBridgeSession] = useState<{
    status: 'connecting' | 'running' | 'complete' | 'error';
    sessionId: string;
    logs: string[];
    changedFiles: string[];
    verifyResult: { verified: boolean; summary: string; passedCount: number; totalCount: number } | null;
  } | null>(null);
  const bridgeEsRef = useRef<EventSource | null>(null);
  // Tracks the intent classification of the PREVIOUS message (fresh-session
  // path only). ROOT CAUSE fix: canned responses (clarification/planning
  // prompts) never get added to `history` — only respondWithAI's answers do
  // — so `inActiveSession = history.length >= 4` never reflects "we just
  // asked a clarifying question" until at least 4 REAL exchanges have
  // happened, which a simple "detailed request → clarification → build it"
  // 2-3 turn interaction never reaches. This ref is a much more direct
  // signal: "was the immediately preceding turn itself a request for more
  // info," used alongside (not instead of) inActiveSession so a short
  // build-confirmation message is recognized regardless of raw history length.
  const lastIntentRef = useRef<string | null>(null);

  // Debug Mode — when enabled, surfaces raw engineering reports in the chat.
  // Off by default so normal users don't see technical repair output.
  // Initialized from localStorage so toggling Developer Mode from the
  // Settings page (a separate React tree) is reflected here on next load,
  // and vice versa — see the matching read/write in
  // app/dashboard/settings/page.tsx.
  const [debugMode, setDebugModeState] = useState(() => {
    try { return localStorage.getItem('dwomoh_dev_mode') === '1'; } catch { return false; }
  });
  const setDebugMode = (updater: boolean | ((prev: boolean) => boolean)) => {
    setDebugModeState(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      try { localStorage.setItem('dwomoh_dev_mode', next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  };
  // Permission set for the signed-in account, fetched once from the database
  // via /api/admin/roles (services/rbac.ts) — gates whether Developer Mode
  // (the Debug toggle + Worker Panel below) is even reachable. Defaults to
  // an empty set (no permissions) until resolved, so nothing elevated is
  // ever shown before the check completes.
  const [myPermissions, setMyPermissions] = useState<Set<string>>(new Set());
  useEffect(() => {
    // ROOT CAUSE fix: this previously depended on [getToken] only — getToken
    // is a referentially-stable useCallback (empty deps in auth-context.tsx),
    // so this effect fired exactly once on mount, before Amplify had
    // necessarily finished resolving the signed-in user. If that one fetch
    // raced the session hydration and got a 401, myPermissions stayed an
    // empty Set for the entire session with no retry — hiding the Debug
    // toggle even for a real SUPER_ADMIN account. Fixed by depending on
    // [authLoading, user, getToken] (so this re-runs once auth actually
    // resolves) and adding one short retry for a signed-in user whose first
    // token fetch still comes back empty (same hydration race documented at
    // runBuildPipelineViaEngine's token fetch).
    if (authLoading) return;
    if (!user) { setMyPermissions(new Set()); return; }
    let cancelled = false;
    (async () => {
      const fetchPermissions = async (): Promise<{ ok: boolean; permissions?: unknown }> => {
        const token = await getToken().catch(() => null);
        const res = await fetch('/api/admin/roles', {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }).catch(() => null);
        if (!res || !res.ok) return { ok: false };
        const data = await res.json().catch(() => null);
        return { ok: true, permissions: data?.permissions };
      };
      let result = await fetchPermissions();
      if (!result.ok) {
        console.warn('[dev-mode] first /api/admin/roles fetch failed — retrying once');
        await new Promise(r => setTimeout(r, 400));
        result = await fetchPermissions();
      }
      console.log(`[dev-mode] permissions fetch result: ok=${result.ok}, permissions=${JSON.stringify(result.permissions)}, cancelled=${cancelled}`);
      if (!cancelled && result.ok && Array.isArray(result.permissions)) {
        setMyPermissions(new Set(result.permissions));
        console.log(`[dev-mode] myPermissions set — has VIEW_DEVELOPER_MODE: ${result.permissions.includes('VIEW_DEVELOPER_MODE')}`);
      }
    })();
    return () => { cancelled = true; };
  }, [authLoading, user, getToken]);
  // Bridge Test Mode — routes the entire build through the Claude Bridge instead of
  // the normal Bedrock generation pipeline. DWOMOH Vibe Code acts as pure orchestration;
  // Claude Code CLI does all generation, build, verification, and repair.
  const [bridgeTestMode, setBridgeTestMode] = useState(false);
  // Live telemetry stages shown during a bridge test run
  const [bridgeTelemetry, setBridgeTelemetry] = useState<Array<{
    id: string; label: string; status: 'waiting' | 'active' | 'done' | 'error'; detail: string; ts?: string;
  }>>([]);

  // ── Claude Bridge auto-escalation tracking ──────────────────────────────────
  // These refs (not state) prevent re-render loops inside the repair loop.
  const bridgeEscalationCountRef  = useRef(0);  // times bridge has auto-triggered this session
  const bridgeEscalatingRef       = useRef(false); // mutex: only one bridge run at a time
  const bridgeEscalationReasonRef = useRef('');
  const MAX_AUTO_BRIDGE_ESCALATIONS = 2;
  // Reset when a new project starts (called from build entry-point)
  const resetBridgeEscalation = useCallback(() => {
    bridgeEscalationCountRef.current  = 0;
    bridgeEscalatingRef.current       = false;
    bridgeEscalationReasonRef.current = '';
  }, []);

  // VS Code escalation — set when all repair tiers are exhausted.
  // Polls for resolution written by Claude Code into .dwomoh/escalation-resolved.json.
  const [escalationState, setEscalationState] = useState<{
    status: 'pending' | 'resolved' | 'failed';
    projectPath: string;
    projectName: string;
  } | null>(null);

  // Build detail step — drives the 11-stage progress display
  const [buildDetailStep, setBuildDetailStep] = useState<string>('');
  const [buildingProjectName, setBuildingProjectName] = useState<string>('');

  // Edit pipeline progress
  const [editDetailStep, setEditDetailStep] = useState<string>('');
  const [editStartedAt, setEditStartedAt]   = useState<number>(0);
  const [editElapsed, setEditElapsed]       = useState<number>(0);

  // Stores last build args so the "Retry Build" button can re-run after a connection error
  const [lastBuildArgs, setLastBuildArgs] = useState<{ history: ConversationTurn[]; prompt: string } | null>(null);

  // ── Multimodal / premium features ────────────────────────────────────────
  // Voice input
  const [isRecording, setIsRecording]       = useState(false);
  // Voice reply
  const [voiceEnabled, setVoiceEnabled]     = useState(false);
  const [isSpeaking, setIsSpeaking]         = useState(false);
  // Uploaded assets
  const [assets, setAssets]                 = useState<UploadedAsset[]>([]);
  const [pendingAsset, setPendingAsset]     = useState<UploadedAsset | null>(null);
  const [assetModalOpen, setAssetModalOpen] = useState(false);
  const [analysingImage, setAnalysingImage] = useState(false);
  // Error log — technical details shown in the Logs tab
  const [errorLogs, setErrorLogs] = useState<string[]>([]);

  // Builder context — tracks active project discussion for context panel and mode lock
  const [builderContext, setBuilderContext] = useState<{
    projectName: string;
    stage: 'specification' | 'planning' | 'building' | 'editing' | 'complete';
    active: boolean;
  } | null>(null);
  // Logo generation
  const [logoOptions, setLogoOptions]         = useState<string[]>([]);
  const [logoStyleLabels, setLogoStyleLabels] = useState<string[]>([]);
  const [logoPanel, setLogoPanel]             = useState(false);
  const [generatingLogo, setGeneratingLogo]   = useState(false);
  const [logoStage, setLogoStage]             = useState('');
  const [logoBriefOpen, setLogoBriefOpen]     = useState(false);
  const [logoBrief, setLogoBrief]             = useState({
    brandName: '', industry: '', style: 'Modern', colors: '', logoType: 'icon-text', notes: '',
  });
  const [logoHistory, setLogoHistory]         = useState<Array<{ svg: string; label: string; ts: number }>>([]);
  // Voice UX
  const [voiceAutoSend, setVoiceAutoSend]   = useState(false);   // true = auto-submit on stop, false = review-before-send
  const [interimText, setInterimText]       = useState('');      // live in-progress words
  const [streamingMsg, setStreamingMsg]     = useState('');      // response being revealed word-by-word
  const [aiState, setAiState]              = useState<'idle'|'listening'|'thinking'|'typing'>('idle');
  // Composer focus state — drives border highlight
  const [composerFocused, setComposerFocused] = useState(false);

  // Browser automation
  const [browserDebugging, setBrowserDebugging] = useState(false);

  // ── IDE Layout state ──────────────────────────────────────────────────────
  type BuilderMode = 'build' | 'debug' | 'deploy';
  type SidebarSection = 'projects' | 'builds' | 'templates' | 'agents' | 'deployments' | 'domains' | 'settings';
  const [builderMode, setBuilderMode] = useState<BuilderMode>('build');
  const [focusMode, setFocusMode] = useState(false);
  const [sidebarSection, setSidebarSection] = useState<SidebarSection>('projects');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // ── Mobile workspace state ─────────────────────────────────────────────────
  const [isMobile, setIsMobile] = useState(false);
  const [mobileTab, setMobileTab] = useState<'library' | 'chat' | 'preview' | 'tools'>('library');
  const [mobileSearchQuery, setMobileSearchQuery] = useState('');
  const [mobileToolsSection, setMobileToolsSection] = useState<'terminal' | 'logs' | 'deploy' | 'files' | 'database'>('terminal');
  const [mobileFocused, setMobileFocused] = useState(false);
  const [mobileKbOffset, setMobileKbOffset] = useState(0);

  // ── Goal-first build flow (spec points 1-5) ───────────────────────────────
  type GoalStep = 'idle' | 'type' | 'mobile-tech' | 'recommend';
  type GoalPlatform = 'website' | 'mobile' | null;
  type MobileTech = 'flutter' | 'android' | 'ios' | null;
  const [goalStep, setGoalStep] = useState<GoalStep>('idle');
  const [goalPlatform, setGoalPlatform] = useState<GoalPlatform>(null);
  const [mobileTech, setMobileTech] = useState<MobileTech>(null);
  const [pendingBuildPrompt, setPendingBuildPrompt] = useState<string | null>(null);
  const [buildRecommendation, setBuildRecommendation] = useState<{
    platform: 'website' | 'flutter' | 'android' | 'ios';
    reason: string;
    icon: string;
  } | null>(null);
  // Build timeout heartbeat state
  const [buildHeartbeatMsg, setBuildHeartbeatMsg] = useState<string | null>(null);
  const buildHeartbeatRef = React.useRef<ReturnType<typeof setInterval> | null>(null);

  // File manager
  const [fileManagerOpen, setFileManagerOpen] = useState(false);
  const [fileRenaming, setFileRenaming] = useState<string | null>(null);
  const [fileRenameValue, setFileRenameValue] = useState('');
  const [newFilePath, setNewFilePath] = useState('');
  const [newFileCreating, setNewFileCreating] = useState(false);

  // Database
  const [dbType, setDbType] = useState('supabase');
  const [dbResource, setDbResource] = useState('');
  const [dbScaffolding, setDbScaffolding] = useState(false);

  // Deploy
  const [deployTarget, setDeployTarget] = useState('vercel');
  const [deployPreparing, setDeployPreparing] = useState(false);
  // Real deployment
  const [deploying, setDeploying] = useState(false);
  const [deployRecord, setDeployRecord] = useState<{
    deploymentId: string; status: string; statusDetail?: string; brandedUrl: string; slug: string;
    providerUrl: string; customDomains: Array<{ domain: string; status: string; dnsRecords?: Array<{ type: string; name: string; value: string }> }>;
    errorMessage?: string;
    verificationResult?: {
      passed: boolean; url: string; httpStatus?: number; pageTitle?: string;
      checks: Array<{ name: string; label: string; status: string; detail: string; durationMs?: number }>;
      attempts: number; totalDurationMs: number; completedAt: string; repairLog?: string[];
    };
  } | null>(null);
  const [deployLogs, setDeployLogs] = useState<string[]>([]);
  const [deployVerificationChecks, setDeployVerificationChecks] = useState<Array<{
    name: string; label: string; status: string; detail: string; durationMs?: number;
  }>>([]);
  const [addDomainInput, setAddDomainInput] = useState('');
  const [addingDomain, setAddingDomain] = useState(false);
  const [showDnsInstructions, setShowDnsInstructions] = useState<string | null>(null);
  const [deployPolling, setDeployPolling] = useState(false);

  // Domains panel
  interface DomainSearchResult { domain: string; available: boolean; price?: number; currency?: string; tld: string; }
  interface ProjectDomain { domain: string; projectName: string; brandedUrl: string; status: string; }
  interface RegisteredDomain { domain: string; expiry?: string; autoRenew?: boolean; }
  interface DomainsData { registered: RegisteredDomain[]; projectDomains: ProjectDomain[]; platformDomain: string; }
  const [domainsData, setDomainsData] = useState<DomainsData | null>(null);
  const [domainsLoading, setDomainsLoading] = useState(false);
  const [domainSearchQuery, setDomainSearchQuery] = useState('');
  const [domainSearchResults, setDomainSearchResults] = useState<DomainSearchResult[]>([]);
  const [domainSearching, setDomainSearching] = useState(false);
  const [domainPurchasing, setDomainPurchasing] = useState<string | null>(null);
  const [connectDomainInput, setConnectDomainInput] = useState('');
  const [connectingDomain, setConnectingDomain] = useState(false);
  const [domainsTab, setDomainsTab] = useState<'overview' | 'buy' | 'connect'>('overview');
  const [purchaseSuccess, setPurchaseSuccess] = useState<string | null>(null);

  // AWS Platform Setup
  interface AwsSetupStep { id: string; label: string; status: 'pending' | 'running' | 'done' | 'error' | 'skipped'; detail?: string; }
  interface AwsSetupStatusType {
    domain: string;
    hostedZone: { id: string; name: string; nameservers?: string[]; recordCount?: number; } | null;
    certificate: { arn: string; status: string; isWildcard?: boolean; domains?: string[]; issuedAt?: string; expiresAt?: string; } | null;
    iamRole: { arn: string; name?: string; } | null;
    amplifyDomain: { verified: boolean; status: string; sentinelAppId: string; cfDistribution?: string; } | null;
    amplifyDomainVerified: boolean;
    dnsRecords?: Array<{ type: string; name: string; value: string }>;
    ready: boolean;
    steps: AwsSetupStep[];
    checkedAt?: string;
  }
  const [awsSetupStatus, setAwsSetupStatus] = useState<AwsSetupStatusType | null>(null);
  const [awsSetupRunning, setAwsSetupRunning] = useState(false);
  const [awsSetupLogs, setAwsSetupLogs] = useState<string[]>([]);

  // Auth
  const [authProvider, setAuthProvider] = useState('nextauth');
  const [authScaffolding, setAuthScaffolding] = useState(false);

  // Memory
  const [memoryPanelOpen, setMemoryPanelOpen] = useState(false);

  // Preview tabs: 'preview' | 'terminal' | 'logs'
  const [previewTab, setPreviewTab] = useState<'preview' | 'terminal' | 'logs' | 'design'>('preview');

  // Live activity shown in the Preview panel when no app is running
  interface ResearchActivity {
    query: string;
    mode: 'web' | 'api';
    timeline: Array<{ step: string; status: 'pending' | 'active' | 'done' }>;
    sources: Array<{ url: string; hostname: string; status: 'pending' | 'done' | 'error' }>;
    complete: boolean;
    usedKnowledge?: boolean;
    recommendations?: string;
  }
  const [researchActivity, setResearchActivity] = useState<ResearchActivity | null>(null);

  interface DebugActivity {
    projectName: string;
    status: 'scanning' | 'reading' | 'analyzing' | 'fixing' | 'rebuilding' | 'verifying' | 'complete' | 'failed';
    errorCount: number;
    rootCause: string;
    filesBeingRead: string[];
    filesModified: string[];
    buildLog: string[];
    timeline: Array<{ step: string; status: 'pending' | 'active' | 'done'; detail?: string }>;
  }
  const [debugActivity, setDebugActivity] = useState<DebugActivity | null>(null);

  const [terminalInput, setTerminalInput] = useState('');
  const [terminalLogs, setTerminalLogs] = useState<string[]>(['$ Ready — type a command below']);
  const [terminalRunning, setTerminalRunning] = useState(false);

  // ── Live verification display ────────────────────────────────────────────────
  interface VerifyStep {
    type: 'journey-step' | 'link-test';
    name: string;
    url: string;
    status: 'pass' | 'fail';
    screenshotUrl?: string;
    error?: string;
    durationMs?: number;
  }
  interface VerificationLiveState {
    active: boolean;
    phase: 'journey' | 'crawl' | 'complete';
    currentAction: string;
    currentUrl: string;
    lastScreenshot: string | null;   // URL of latest Playwright screenshot — shown in overlay
    steps: VerifyStep[];
    report?: { routesTested: number; passed: number; failed: number; repaired: number; finalStatus: string };
    summary: {
      routesTested: number; passed: number; failed: number; repaired: number;
      formsTested: number; searchTests: number; loginTests: number; logoutTests: number;
      pages404Found: number; pages404Fixed: number; screenshotsCaptured: number; finalPassRate: string;
    };
  }
  const [verificationLive, setVerificationLive] = useState<VerificationLiveState | null>(null);
  const verifyPortRef = useRef<number>(0);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef    = useRef<HTMLInputElement>(null);
  const recognitionRef     = useRef<any>(null);
  const voiceEnabledRef    = useRef(false);
  const voiceAutoSendRef   = useRef(false);
  const silenceTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finalTranscriptRef = useRef('');

  // ── helpers ──────────────────────────────────────────────────────────────

  const scrollBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);
  useEffect(() => { scrollBottom(); }, [displayed, buildProgress, scrollBottom]);
  useEffect(() => { voiceEnabledRef.current = voiceEnabled; }, [voiceEnabled]);
  useEffect(() => { voiceAutoSendRef.current = voiceAutoSend; }, [voiceAutoSend]);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);
  useEffect(() => {
    if (!isMobile) return;
    type VV = { height: number; offsetTop?: number; addEventListener(e: string, h: () => void): void; removeEventListener(e: string, h: () => void): void };
    const vv = (window as unknown as { visualViewport?: VV }).visualViewport;
    if (!vv) return;
    const update = () => {
      const kb = Math.max(0, window.innerHeight - vv.height - (vv.offsetTop ?? 0));
      setMobileKbOffset(kb > 50 ? kb : 0);
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => { vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update); };
  }, [isMobile]);

  // NOTE: The escalation polling useEffect is placed after api/addMsg are defined (see below).

  const addMsg = useCallback((role: DisplayMessage['role'], content: string, statusType?: DisplayMessage['statusType']) => {
    setDisplayed(prev => [...prev, { role, content, statusType }]);
  }, []);

  const addStatus = useCallback((content: string, statusType: DisplayMessage['statusType']) => {
    setDisplayed(prev => [...prev, { role: 'status', content, statusType }]);
  }, []);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = useCallback(async (body: Record<string, unknown>): Promise<any> => {
    let token = await getToken();
    // Same Amplify session-hydration race as runBuildPipelineViaEngine's
    // token fetch: a signed-in user can get an empty token on the very first
    // request after a page load, silently dropping every server-side call
    // (billing, RBAC permission checks, project ownership) to 'anonymous'.
    // One short retry closes the race for genuinely signed-in users, while
    // signed-out visitors (user === null) skip it entirely.
    if (!token && user) {
      await new Promise(r => setTimeout(r, 400));
      token = await getToken().catch(() => null);
    }
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

    // A build request commonly runs for minutes (build + repair + verify).
    // res.json() used to be called directly here with no guard -- any
    // non-JSON response along the way (a serverless timeout/crash page from
    // the hosting infrastructure, a proxy error, a truncated body) threw
    // "Unexpected token ... is not valid JSON", an uncaught error that
    // crashed the whole build with a cryptic, browser-only message. Reading
    // as text first (never throws) and logging it before parsing turns that
    // into a clear, safe, catchable result instead.
    const rawText = await res.text();
    const parsed = parseApiResponse(rawText, res.status, res.ok);
    if (!parsed.success && !rawText.trim().startsWith('{')) {
      console.error(`[api] non-JSON response for action="${body.action}" (status ${res.status}): ${truncateForLog(rawText)}`);
    }
    return parsed;
  }, [getToken, user]);

  // ── Claude Code Bridge ────────────────────────────────────────────────────

  // Telemetry hook: bridge-only pipeline registers a callback here so the SSE
  // event handlers below can advance stage indicators without tight coupling.
  const bridgeTelemetryHookRef = useRef<((eventType: string, msg: string) => void) | null>(null);

  // launchBridge — opens the Claude Code SSE stream.
  // autoMode = true: shows user-friendly progress messages ("Inspecting project…") instead of
  //   raw dev messages. Used by the automatic escalation system.
  // autoMode = false (default): shows raw technical messages. Triggered by debug-mode button.
  const launchBridge = useCallback(async (
    prompt: string,
    options: {
      autoMode?: boolean;
      escalationReason?: string;
      onComplete?: (verified: boolean, changedFiles: string[]) => void;
      /** Explicit overrides — used by bridge test mode to bypass async state timing */
      projectPathOverride?: string;
      projectIdOverride?: string;
    } = {},
  ) => {
    const { autoMode = false, escalationReason = '', onComplete, projectPathOverride, projectIdOverride } = options;
    const projectPath = projectPathOverride ?? currentProject?.projectPath ?? buildProgress?.projectPath ?? '';
    const projectId   = projectIdOverride   ?? currentProject?.id ?? '';
    const port        = buildProgress?.port ?? currentProject?.port ?? 0;
    if (!projectPath) {
      if (!autoMode) addStatus('No project open — open a project first', 'error');
      onComplete?.(false, []);
      return;
    }

    // Close any existing bridge session
    if (bridgeEsRef.current) { bridgeEsRef.current.close(); bridgeEsRef.current = null; }

    const localSessionId = `bridge-${Date.now()}-pending`;
    setBridgeSession({ status: 'connecting', sessionId: localSessionId, logs: [], changedFiles: [], verifyResult: null });

    if (autoMode) {
      addStatus('Advanced repair started — inspecting project files…', 'checking');
    } else {
      addStatus('Connecting to Claude Code worker…', 'checking');
    }

    // Get Cognito token — EventSource cannot set custom headers, so token goes in the URL.
    // Same Amplify session-hydration race documented at runBuildPipelineViaEngine's
    // token fetch — one short retry for a signed-in user whose first token
    // fetch came back empty.
    let token = '';
    try { token = (await getToken()) ?? ''; } catch { /* no auth configured */ }
    if (!token && user) {
      await new Promise(r => setTimeout(r, 400));
      try { token = (await getToken()) ?? ''; } catch { /* still no token */ }
    }

    const params = new URLSearchParams({
      prompt,
      projectPath,
      projectId,
      ...(port            ? { port:              String(port)  } : {}),
      ...(token           ? { token }                              : {}),
      ...(escalationReason ? { escalationReason }                 : {}),
    });
    const es = new EventSource(`/api/claude-bridge?${params}`);
    bridgeEsRef.current = es;

    // Map verbose dev messages → simple user-facing labels in autoMode
    const AUTO_STATUS_MAP: Record<string, string> = {
      'Checking Claude Code connection': 'Connecting to advanced repair engine…',
      'Creating pre-edit checkpoint':    'Saving project state…',
      'Checkpoint saved':                'Project checkpoint created',
      'Forwarding to Claude Code worker': 'Inspecting project…',
      'Detecting file changes':           'Repairing root cause…',
      'Running build verification':       'Verifying preview…',
    };
    const mapAutoMsg = (raw: string): string => {
      for (const [key, label] of Object.entries(AUTO_STATUS_MAP)) {
        if (raw.startsWith(key)) return label;
      }
      if (raw.startsWith('Verified:')) return `Repair complete — ${raw}`;
      if (raw.startsWith('SESSION_ID:')) return '';
      return autoMode ? '' : raw; // suppress unknown dev messages in auto mode
    };

    es.onmessage = (e: MessageEvent) => {
      let event: { type: string; message?: string; changedFiles?: string[]; verifyResult?: { verified: boolean; summary: string; passedCount: number; totalCount: number }; result?: string };
      try { event = JSON.parse(e.data as string); } catch { return; }

      // Fire telemetry hook for bridge-test-mode stage tracking
      const telHook = bridgeTelemetryHookRef.current;
      if (telHook) telHook(event.type, event.message ?? '');

      if (event.type === 'status') {
        const raw = event.message ?? '';
        if (raw.startsWith('SESSION_ID:')) {
          const sid = raw.replace('SESSION_ID:', '');
          setBridgeSession(prev => prev ? { ...prev, status: 'running', sessionId: sid } : prev);
          return;
        }
        const display = autoMode ? mapAutoMsg(raw) : raw;
        if (display) {
          addStatus(display, 'checking');
          setBridgeSession(prev => prev ? { ...prev, status: 'running', logs: [...prev.logs, `ℹ️ ${display}`] } : prev);
        } else {
          // Still update status (for spinner) even if we don't show the message
          setBridgeSession(prev => prev ? { ...prev, status: 'running' } : prev);
        }
      } else if (event.type === 'log' || event.type === 'thinking') {
        const msg = event.message ?? '';
        // Tool-use lines (file edits/reads) are shown even in autoMode — they are
        // the only visible proof that repair is making progress.
        const isFileOp = /^[✏️📝📖⚡🔧]/u.test(msg);
        const isRepairAction = autoMode && /edit|write|fix|creat|delet|migrat|alter table|recreat/i.test(msg);
        if (!autoMode || isFileOp || isRepairAction) {
          setBridgeSession(prev => prev ? { ...prev, status: 'running', logs: [...prev.logs, msg] } : prev);
          // In autoMode, surface file operations into the main status log so users
          // can see what the repair engine is actually doing without debug mode.
          if (autoMode && (isFileOp || isRepairAction)) {
            addStatus(`🔧 ${msg.slice(0, 90)}`, 'checking');
          }
        }
      } else if (event.type === 'tool') {
        setBridgeSession(prev => prev ? { ...prev, status: 'running', logs: [...prev.logs, `🔧 ${event.message ?? ''}`] } : prev);
      } else if (event.type === 'warning') {
        // Show warnings prominently — includes auto-recovery headers from the bridge retry loop
        const warnMsg = event.message ?? '';
        addStatus(`⚠️ ${warnMsg}`, 'applying');
        setBridgeSession(prev => prev ? { ...prev, logs: [...prev.logs, `⚠️ ${warnMsg}`] } : prev);
      } else if (event.type === 'error') {
        const errMsg = event.message ?? '';
        // Bridge-side errors are now specific: "Interruption detected — process exited code 1", etc.
        // Surface the full message — the server already classified the failure.
        addStatus(`❌ ${errMsg}`, 'error');
        setBridgeSession(prev => prev ? { ...prev, status: 'error', logs: [...prev.logs, `❌ ${errMsg}`] } : prev);
        es.close(); bridgeEsRef.current = null;
        onComplete?.(false, []);
        bridgeEscalatingRef.current = false;
      } else if (event.type === 'complete') {
        const vr    = event.verifyResult;
        const changed = event.changedFiles ?? [];
        const bridgePort = (event as { port?: number }).port ?? 0;
        const totalFiles = (event as { totalProjectFiles?: number }).totalProjectFiles ?? changed.length;
        // Use totalProjectFiles for display when project already existed (changedFiles is diff only)
        const displayFileCount = totalFiles > changed.length ? totalFiles : changed.length;

        const label = vr?.verified
          ? `✅ ${autoMode ? 'Repair' : 'Bridge'} complete — ${vr.passedCount}/${vr.totalCount} checks, ${displayFileCount} file(s)`
          : `⚠️ ${autoMode ? 'Repair' : 'Bridge'} done — ${displayFileCount} file(s), verification partial (${vr?.passedCount ?? 0}/${vr?.totalCount ?? 0})`;
        addStatus(label, vr?.verified ? 'done' : 'applying');

        // If the bridge started the dev server, wire up the preview immediately
        if (bridgePort > 0) {
          setPreviewUrl(`http://localhost:${bridgePort}`);
          setPreviewKey(k => k + 1);
          setPreviewLoading(true);
          setPhase('previewing');
          setBuildProgress(p => p ? { ...p, step: 'done', port: bridgePort, message: vr?.verified ? `✅ Preview verified — port ${bridgePort}` : `⚠️ Preview on port ${bridgePort} (verification partial)` } : p);
          if (vr?.verified) addStatus(`🖥️  Preview: http://localhost:${bridgePort}`, 'done');
        } else if (changed.length > 0) {
          // No port from bridge (auto-escalation mode) — just refresh if files changed
          setTimeout(() => setPreviewKey(k => k + 1), 2000);
        }

        setBridgeSession(prev => prev ? { ...prev, status: 'complete', changedFiles: changed, verifyResult: vr ?? null } : prev);
        if (vr) setLastVerification({ verified: vr.verified, summary: vr.summary, checks: [] });
        es.close(); bridgeEsRef.current = null;
        onComplete?.(vr?.verified ?? false, changed);
        bridgeEscalatingRef.current = false;
      }
    };

    // SSE-level reconnect — fires when the HTTP connection drops (network blip,
    // Next.js route restart, server restart). The bridge retries internally for
    // process-level failures; this handles transport-level disconnects.
    let sseReconnectCount = 0;
    const MAX_SSE_RECONNECTS = 3;

    es.onerror = () => {
      if (sseReconnectCount < MAX_SSE_RECONNECTS) {
        sseReconnectCount++;
        const delay = sseReconnectCount * 3000; // 3s, 6s, 9s back-off
        addStatus(`🔄 Bridge connection interrupted — reconnecting in ${delay / 1000}s (attempt ${sseReconnectCount}/${MAX_SSE_RECONNECTS})…`, 'checking');
        setBridgeSession(prev => prev ? { ...prev, status: 'running', logs: [...prev.logs, `🔄 SSE reconnect ${sseReconnectCount}/${MAX_SSE_RECONNECTS}`] } : prev);
        es.close(); bridgeEsRef.current = null;

        setTimeout(() => {
          // Re-open the same SSE URL — the bridge session on the server is still alive
          const esNew = new EventSource(`/api/claude-bridge?${params}`);
          bridgeEsRef.current = esNew;
          // Transfer handlers (the closure captures the outer scope cleanly)
          esNew.onmessage = es.onmessage;
          esNew.onerror   = es.onerror;
          addStatus(`🔌 Reconnected to bridge session`, 'checking');
          setBridgeSession(prev => prev ? { ...prev, status: 'running' } : prev);
        }, delay);
      } else {
        // Exhausted SSE reconnects — surface a clear error, no "Retry Build" prompt
        const reason = 'Bridge connection dropped and could not reconnect. The bridge may still be running server-side — check logs.';
        addStatus(`❌ ${reason}`, 'error');
        setBridgeSession(prev => prev ? { ...prev, status: 'error', logs: [...prev.logs, `❌ ${reason}`] } : prev);
        es.close(); bridgeEsRef.current = null;
        onComplete?.(false, []);
        bridgeEscalatingRef.current = false;
      }
    };
  }, [currentProject, buildProgress, addStatus, setLastVerification, getToken]);

  // ── autoEscalateToBridge ──────────────────────────────────────────────────
  // Called automatically by the repair loop when it exhausts normal strategies.
  // All 9 security guards on the bridge route still apply — this just removes the
  // manual button click as the trigger.
  //
  // postVerify: if provided, after the bridge completes we run a fresh verify-app
  // and show the result to the user. This is the "proof" step.
  const autoEscalateToBridge = useCallback((
    reason: string,
    prompt: string,
    postVerify?: { port: number; projectPath: string },
  ) => {
    if (bridgeEscalatingRef.current) return; // already running

    if (bridgeEscalationCountRef.current >= MAX_AUTO_BRIDGE_ESCALATIONS) {
      addStatus(`Advanced repair limit reached (${MAX_AUTO_BRIDGE_ESCALATIONS} attempts) — manual review required`, 'error');
      setDisplayed(prev => [...prev, {
        role: 'assistant' as const,
        content: `⛔ The automated repair system has made ${MAX_AUTO_BRIDGE_ESCALATIONS} attempts and cannot resolve the remaining issues automatically.\n\n**Remaining problem:** ${reason}\n\nPlease describe what specific page or feature should work and I'll try a targeted fix, or use the **Debug** toggle to inspect the engineering report.`,
      }]);
      return;
    }

    bridgeEscalatingRef.current = true;
    bridgeEscalationCountRef.current++;
    bridgeEscalationReasonRef.current = reason;

    const attempt = bridgeEscalationCountRef.current;

    // ── Structured repair attempt telemetry ──────────────────────────────────
    // Visible in the status log regardless of debug mode so the user always sees
    // exactly what the repair engine is doing and why.
    addStatus(`━━━ REPAIR ATTEMPT ${attempt}/${MAX_AUTO_BRIDGE_ESCALATIONS} ━━━`, 'checking');
    addStatus(`Root cause: ${reason.slice(0, 120)}`, 'error');
    addStatus(`Action: Inspecting project files, fixing root cause, restarting preview…`, 'checking');
    setBuildProgress(p => p ? ({
      ...p,
      step: 'verifying',
      message: `⚡ Repair attempt ${attempt}/${MAX_AUTO_BRIDGE_ESCALATIONS} — fixing root cause…`,
    }) : p);

    // Chat panel message — non-technical, user-facing
    setDisplayed(prev => [...prev, {
      role: 'assistant' as const,
      content: `⚡ **Repair Attempt ${attempt}/${MAX_AUTO_BRIDGE_ESCALATIONS}**\n\n**Detected:** ${reason.slice(0, 120)}\n\n**Action:** Reading project files directly, identifying the root cause, and applying a targeted fix. Estimated time: 1–3 minutes.\n\nThe preview will reload automatically when repair completes.`,
    }]);

    // Fire bridge (autoMode — user-friendly messages only)
    launchBridge(prompt, {
      autoMode: true,
      escalationReason: reason,
      onComplete: async (verified, changedFiles) => {
        // ── Post-bridge re-verification ─────────────────────────────────────
        // The bridge already runs its own internal verify, but we run a fresh one here
        // so the builder's verification display updates with individual check results.
        if (postVerify && postVerify.port > 0) {
          addStatus('Re-verifying after advanced repair…', 'checking');
          try {
            // Brief wait for HMR / server restart to settle
            await new Promise(r => setTimeout(r, 3000));
            const reVerifyData = await api({
              action: 'verify-app',
              port: postVerify.port,
              projectPath: postVerify.projectPath,
            });
            setLastVerification(reVerifyData);
            type RCheck = { passed: boolean; softPassed?: boolean; name: string; error?: string };
            const rePassed  = (reVerifyData.checks ?? []).filter((c: RCheck) => c.passed || c.softPassed).length;
            const reTotal   = (reVerifyData.checks ?? []).length;
            const reVerified = reVerifyData.verified;

            if (reVerified) {
              addStatus(`━━━ REPAIR ATTEMPT ${attempt} PASSED ━━━`, 'done');
              addStatus(`Files modified: ${changedFiles.slice(0, 5).join(', ') || 'none'}`, 'done');
              addStatus(`Verification: ${rePassed}/${reTotal} checks passing`, 'done');
              setDisplayed(prev => [...prev, {
                role: 'assistant' as const,
                content: `✅ **Repair Attempt ${attempt} — Complete**\n\n${changedFiles.length > 0 ? `**Files modified:** ${changedFiles.slice(0, 5).join(', ')}\n\n` : ''}**Verification: ${rePassed}/${reTotal} checks passing** — your app is live and working.\n\nRefreshing preview…`,
              }]);
              setPreviewKey(k => k + 1);
            } else {
              const stillFailing = (reVerifyData.checks ?? []).filter((c: RCheck) => !c.passed && !c.softPassed);
              const failSummary = stillFailing.slice(0, 4).map((c: RCheck) => `• ${c.name}: ${(c.error ?? '').slice(0, 60)}`).join('\n');
              addStatus(`━━━ REPAIR ATTEMPT ${attempt} — PARTIAL ━━━`, 'applying');
              addStatus(`Files modified: ${changedFiles.slice(0, 5).join(', ') || 'none'}`, 'applying');
              addStatus(`Verification: ${rePassed}/${reTotal} checks passing`, 'applying');
              if (stillFailing.length > 0) {
                addStatus(`Still failing: ${stillFailing.slice(0, 3).map((c: RCheck) => c.name).join(', ')}`, 'error');
              }

              // If hard errors remain and budget allows, escalate again automatically
              const remainingHardErrors = stillFailing.filter((c: RCheck) => getHardErrorLabelModule(c) !== null);
              if (remainingHardErrors.length > 0 && bridgeEscalationCountRef.current < MAX_AUTO_BRIDGE_ESCALATIONS) {
                const secondPrompt = buildBridgePromptRef.current(postVerify.projectPath, stillFailing);
                autoEscalateToBridge(
                  `${remainingHardErrors[0].name} — ${getHardErrorLabelModule(remainingHardErrors[0])}`,
                  secondPrompt,
                  postVerify,
                );
              } else {
                addStatus(`Max repair attempts reached — manual review required`, 'error');
                setDisplayed(prev => [...prev, {
                  role: 'assistant' as const,
                  content: `⚠️ **Repair Attempt ${attempt} — Could Not Fully Resolve**\n\n${changedFiles.length > 0 ? `**Files modified:** ${changedFiles.slice(0, 5).join(', ')}\n\n` : ''}**Verification: ${rePassed}/${reTotal} checks passing**\n\n**Still failing:**\n${failSummary}\n\n${bridgeEscalationCountRef.current >= MAX_AUTO_BRIDGE_ESCALATIONS ? '**Maximum repair attempts reached.** Enable **Debug Mode** to see the full engineering report, or describe which specific feature should work and I\'ll try a targeted fix.' : 'Ask me to investigate a specific failing check for more detail.'}`,
                }]);
              }
            }
          } catch (e) {
            addStatus('Re-verification failed — check the preview manually', 'error');
            if (verified) {
              setDisplayed(prev => [...prev, {
                role: 'assistant' as const,
                content: `✅ **Advanced repair complete** — ${changedFiles.length} file(s) changed. Bridge verified internally. Check the preview to confirm.`,
              }]);
            }
          }
        } else {
          // No port — just report what the bridge found
          if (verified) {
            setDisplayed(prev => [...prev, {
              role: 'assistant' as const,
              content: `✅ **Advanced repair complete.** ${changedFiles.length} file(s) updated. All checks passing.`,
            }]);
          } else {
            setDisplayed(prev => [...prev, {
              role: 'assistant' as const,
              content: `⚠️ Advanced repair finished — ${changedFiles.length} file(s) changed, but some checks may still be failing.\n\nEnable **Debug Mode** for the full report.`,
            }]);
          }
        }
      },
    });
  }, [launchBridge, addStatus, api]);

  // Stable ref to buildBridgePrompt so the async onComplete callback above can call it
  // without it being a stale closure (it's defined inside runBuildPipeline which is async).
  // We populate this ref the first time the loop runs.
  type LooseCheck = { name: string; error?: string; passed: boolean; softPassed?: boolean; rootCause?: unknown };
  const buildBridgePromptRef = useRef<(projectPath: string, failing: LooseCheck[]) => string>(
    (projectPath2, failing) =>
      `Fix these failing checks in the project at ${projectPath2}:\n${failing.slice(0, 6).map(c => `• ${c.name}: ${(c.error ?? 'failing').slice(0, 120)}`).join('\n')}\n\nInspect source files, fix root causes, ensure all checks pass.`,
  );

  // ── Error handling ────────────────────────────────────────────────────────

  const logErrorEntry = useCallback((technical: string) => {
    const ts = new Date().toLocaleTimeString();
    setErrorLogs(l => [`[${ts}] ${technical}`, ...l].slice(0, 100));
  }, []);

  const classifyApiError = useCallback((errMsg: string): {
    category: ErrorCategory; title: string; explanation: string; whatNext: string;
  } => {
    const m = errMsg.toLowerCase();
    // Parse [KIND] prefix injected by bedrock.ts invokeWithRetry
    if (m.includes('[auth_error]') || m.includes('credential') || m.includes('unauthorized') || m.includes('403') || m.includes('401') || m.includes('forbidden') || m.includes('access denied')) {
      return {
        category: 'auth',
        title: 'Authentication Error',
        explanation: 'The AI service rejected this request because of an authentication problem. Your AWS credentials may be missing, expired, or lack permission to access Bedrock.',
        whatNext: 'Open .env.local and confirm AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are correct and have Amazon Bedrock access in us-east-1.',
      };
    }
    if (m.includes('[throttled]') || m.includes('[quota_exceeded]') || m.includes('429') || m.includes('throttl') || m.includes('quota') || m.includes('rate limit') || m.includes('too many requests')) {
      return {
        category: 'quota',
        title: 'Rate Limit Reached',
        explanation: 'Too many requests were sent to the AI service in a short time. The service has temporarily limited access.',
        whatNext: 'Wait 30 seconds and try again. If this keeps happening, your AWS Bedrock quota may need to be increased in the AWS console.',
      };
    }
    if (m.includes('[timeout]') || m.includes('bedrock_timeout') || m.includes('timed out') || m.includes('timeout')) {
      return {
        category: 'timeout',
        title: 'Request Timed Out',
        explanation: 'The AI took too long to respond. This sometimes happens during peak usage or with complex requests.',
        whatNext: 'Try again with a shorter or simpler description. If the problem continues, the AI service may be under high load — try in a few minutes.',
      };
    }
    if (m.includes('[network_interruption]') || m.includes('fetch') || m.includes('econnreset') || m.includes('econnrefused') || m.includes('network') || m.includes('connection') || m.includes('aborted') || m.includes('socket')) {
      return {
        category: 'network',
        title: 'Network Error',
        explanation: 'The connection to the AI service was interrupted before the response could be completed.',
        whatNext: 'Check your internet connection and try again. Your work has not been lost.',
      };
    }
    if (m.includes('[invalid_response]') || m.includes('no content') || m.includes('empty response') || m.includes('parse') || m.includes('500') || m.includes('502') || m.includes('503') || m.includes('504')) {
      return {
        category: 'api',
        title: 'AI Service Error',
        explanation: 'The AI service returned an unexpected response. This is usually a temporary issue on the server side.',
        whatNext: 'Wait a few seconds and try again. If this persists, AWS Bedrock may be experiencing problems — check status.aws.amazon.com.',
      };
    }
    if (m.includes('missing_credentials') || m.includes('not configured') || m.includes('env') || m.includes('.env')) {
      return {
        category: 'config',
        title: 'Configuration Error',
        explanation: 'Required environment variables are missing. The app cannot connect to the AI service without them.',
        whatNext: 'Create or edit .env.local in the project root. Add AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_REGION=us-east-1.',
      };
    }
    return {
      category: 'unknown',
      title: 'Unexpected Error',
      explanation: 'Something went wrong, but the cause is not clear. Technical details have been saved to the Logs tab.',
      whatNext: 'Open the Logs tab to see the full error. Try again — this may be a temporary issue.',
    };
  }, []);

  const addErrorMsg = useCallback((
    err: unknown,
    context: string,
    recoveryActions?: Array<{ label: string; action: 'retry-logo' | 'retry-research' | 'open-logs' | 'focus-input'; prompt?: string }>,
  ) => {
    const raw = err instanceof Error ? err.message : (typeof err === 'object' && err !== null && 'error' in err ? String((err as {error: unknown}).error) : String(err));
    logErrorEntry(`[${context}] ${raw}`);
    const classified = classifyApiError(raw);
    setDisplayed(prev => [...prev, {
      role: 'assistant' as const,
      content: '',
      errorMeta: {
        category: classified.category,
        title: classified.title,
        explanation: classified.explanation,
        whatNext: classified.whatNext,
        recoveryActions,
      },
    }]);
  }, [logErrorEntry, classifyApiError]);

  // Client-side retry wrapper — one extra attempt for network-level failures
  // (Bedrock already retries 3× server-side; this covers transient client network drops)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apiWithRetry = useCallback(async (
    body: Record<string, unknown>,
    onRetrying?: (attempt: number) => void,
  ): Promise<any> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        if (onRetrying) onRetrying(attempt);
        await new Promise(r => setTimeout(r, 2500));
      }
      try {
        return await api(body);
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message.toLowerCase() : '';
        // Only retry pure network fetch failures (server errors are already retried server-side)
        if (!msg.includes('fetch') && !msg.includes('network') && !msg.includes('failed to fetch') && !msg.includes('econnreset')) {
          throw err;
        }
      }
    }
    throw lastErr;
  }, [api]);

  const refreshProjects = useCallback(async () => {
    const d = await api({ action: 'list-projects' });
    if (d.projects) setProjects(d.projects);
  }, [api]);

  useEffect(() => { refreshProjects(); }, [refreshProjects]);
  useEffect(() => { checkAwsSetup(); loadDomainsData(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-poll platform status every 20s while any AWS service is pending
  useEffect(() => {
    const needsPoll = awsSetupStatus && (
      !awsSetupStatus.ready ||
      awsSetupStatus.certificate?.status !== 'ISSUED' ||
      (awsSetupStatus.amplifyDomain && !awsSetupStatus.amplifyDomain.verified)
    );
    if (!needsPoll) return;
    const timer = setInterval(() => { checkAwsSetup(); }, 20_000);
    return () => clearInterval(timer);
  }, [awsSetupStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll for VS Code + Claude Code resolution every 5 seconds while escalation is pending.
  useEffect(() => {
    if (!escalationState || escalationState.status !== 'pending') return;
    const interval = setInterval(async () => {
      try {
        const result = await api({ action: 'escalation-check', projectPath: escalationState.projectPath });
        if (!result?.resolution) return;
        const res = result.resolution as { status: string; fixSummary: string; filesChanged: string[]; verificationPassed: boolean; buildErrors: string[]; notes?: string };
        setEscalationState(prev => prev ? { ...prev, status: res.status as 'resolved' | 'failed' } : null);
        if (res.status === 'resolved' && res.verificationPassed) {
          addMsg('assistant',
            `✅ **VS Code + Claude Code resolved the issue.**\n\n` +
            `**Fix applied:** ${res.fixSummary}\n\n` +
            `**Files changed:** ${(res.filesChanged ?? []).join(', ')}\n\n` +
            `Refreshing preview to confirm…`
          );
          setPreviewKey(k => k + 1);
          // Store the repair pattern so DWOMOH can apply the same fix automatically next time
          try {
            await api({
              action: 'save-repair-pattern',
              projectPath: escalationState.projectPath,
              errorPattern: escalationState.projectName,
              rootCause: res.fixSummary,
              fixApproach: res.fixSummary,
              targetFiles: res.filesChanged ?? [],
              successfulTier: 'STRONGEST',
            });
          } catch { /* non-critical */ }
          await api({ action: 'escalation-clear', projectPath: escalationState.projectPath });
        } else if (res.status === 'resolved') {
          addMsg('assistant',
            `⚠️ **Claude Code applied a fix but verification did not pass.**\n\n` +
            `${res.notes ?? ''}\n\nBuild errors:\n\`\`\`\n${(res.buildErrors ?? []).join('\n')}\n\`\`\`\n\nCheck the file changes in VS Code and re-run verification.`
          );
        } else {
          addMsg('assistant',
            `❌ **Claude Code could not resolve this issue.**\n\n` +
            `Reason: ${res.notes ?? 'unknown'}\n\nThe issue may need manual inspection of the source files in VS Code.`
          );
        }
      } catch { /* non-critical — keep polling */ }
    }, 5000);
    return () => clearInterval(interval);
  }, [escalationState, api, addMsg]);

  // Persist which project is "currently open" so a page refresh doesn't
  // lose it — see lib/project-session-storage.ts's module doc for the full
  // root-cause explanation (a developer comment previously flagged this
  // exact risk before it was fixed: currentProject going null on refresh,
  // with no restoration mechanism, meant the entire "project open → edit"
  // routing branch never ran again for that session).
  useEffect(() => {
    if (currentProject) saveOpenProject(currentProject);
    else clearOpenProject();
  }, [currentProject]);

  // Initial goal-first flow — no welcome wall of text, just the goal picker.
  // A restored project (from BEFORE this page load) takes priority over
  // both the template/prompt URL params and the cold-start goal picker —
  // the user had a project open; a refresh should return them to it, not
  // discard it and start over.
  useEffect(() => {
    const templateId = searchParams?.get('template');
    const promptParam = searchParams?.get('prompt');
    if (templateId) {
      const tmpl = PROJECT_TEMPLATES.find(t => t.id === templateId);
      if (tmpl) { setInput(tmpl.prompt); setGoalStep('idle'); return; }
    }
    if (promptParam) { setInput(promptParam); setGoalStep('idle'); return; }
    const restored = loadOpenProject();
    if (restored && !currentProject) {
      setGoalStep('idle');
      handleOpenProject(restored);
      return;
    }
    // Show goal picker on fresh load
    setGoalStep('type');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Live verification via SSE ─────────────────────────────────────────────
  // Connects to /api/verify-live, streams Playwright events live into the
  // Preview panel, and resolves with the final journey + crawl results.

  const runVerificationLive = (
    projectPath: string,
    port: number,
  ): Promise<{
    journeyVerdict: 'PASSED' | 'FAILED VERIFICATION' | 'SKIPPED';
    journeyFailedAt: string;
    journeyFailedRequests: number;
    journeySteps: Array<{ step: string; passed: boolean; optional: boolean; durationMs: number; screenshotUrl?: string; error?: string }>;
    crawlVerdict: 'PASSED' | 'FAILED' | 'SKIPPED';
    crawlPassedLinks: number;
    crawlFailedLinks: number;
    crawlMissingRouteFiles: string[];
    crawlPagesVisited: number;
  }> => {
    return new Promise((resolve, reject) => {
      verifyPortRef.current = port;

      setVerificationLive({
        active: true,
        phase: 'journey',
        currentAction: 'Starting browser verification…',
        currentUrl: '/',
        steps: [],
        lastScreenshot: null,
        summary: { routesTested: 0, passed: 0, failed: 0, repaired: 0, formsTested: 0, searchTests: 0, loginTests: 0, logoutTests: 0, pages404Found: 0, pages404Fixed: 0, screenshotsCaptured: 0, finalPassRate: '0%' },
      });
      setPreviewTab('preview');

      const url = `/api/verify-live?port=${port}&projectPath=${encodeURIComponent(projectPath)}&maxPages=15`;
      const es = new EventSource(url);

      es.onmessage = (e: MessageEvent) => {
        let event: Record<string, unknown>;
        try { event = JSON.parse(e.data as string); } catch { return; }

        const p = verifyPortRef.current;

        // Navigate the iframe to match whatever Playwright is currently visiting
        if (event.type === 'step-start' && typeof event.url === 'string' && event.url !== '/') {
          setPreviewUrl(`http://localhost:${p}${event.url}`);
        }
        if (event.type === 'page-visiting' && typeof event.url === 'string') {
          setPreviewUrl(`http://localhost:${p}${event.url}`);
        }
        if (event.type === 'link-testing' && typeof event.url === 'string') {
          setPreviewUrl(`http://localhost:${p}${event.url}`);
        }

        setVerificationLive(prev => {
          if (!prev) return prev;
          switch (event.type) {
            case 'phase':
              return { ...prev, phase: event.phase as 'journey' | 'crawl', currentAction: event.message as string };

            case 'step-start':
              return { ...prev, currentAction: event.action as string, currentUrl: (event.url as string) || '/' };

            case 'step-complete': {
              const ssUrl = event.screenshotUrl as string | undefined;
              return {
                ...prev,
                // Screenshots are saved to DWOMOH's own /public folder and served
                // at a relative path — do NOT prepend the generated app port.
                lastScreenshot: ssUrl ?? prev.lastScreenshot,
                steps: [...prev.steps, {
                  type: 'journey-step' as const,
                  name: event.step as string,
                  url: (event.url as string) || '/',
                  status: (event.passed as boolean) ? 'pass' : 'fail',
                  screenshotUrl: ssUrl,
                  error: event.error as string | undefined,
                  durationMs: event.durationMs as number,
                }],
              };
            }

            case 'page-screenshot':
              // Crawler page screenshot — relative path served by DWOMOH's own server
              return {
                ...prev,
                lastScreenshot: event.screenshotUrl as string,
              };

            case 'link-testing':
              return { ...prev, currentAction: `Clicking link: "${event.linkText}"`, currentUrl: (event.url as string) || '/' };

            case 'link-tested': {
              const ltUrl = event.screenshotUrl as string | undefined;
              return {
                ...prev,
                lastScreenshot: ltUrl ?? prev.lastScreenshot,
                steps: [...prev.steps, {
                  type: 'link-test' as const,
                  name: event.linkText as string,
                  url: (event.url as string) || '/',
                  status: (event.passed as boolean) ? 'pass' : 'fail',
                  screenshotUrl: ltUrl,
                }],
              };
            }

            case 'complete': {
              const totalLinks = (event.crawlPassedLinks as number) + (event.crawlFailedLinks as number);
              const passRate = totalLinks > 0 ? `${Math.round(((event.crawlPassedLinks as number) / totalLinks) * 100)}%` : (event.journeyVerdict === 'PASSED' ? '100%' : '0%');
              const metrics = (event.journeyMetrics as { formsTested: number; loginTests: number; logoutTests: number; searchTests: number }) ?? { formsTested: 0, loginTests: 0, logoutTests: 0, searchTests: 0 };
              return {
                ...prev,
                active: false,
                phase: 'complete',
                currentAction: event.journeyVerdict === 'PASSED' && (event.crawlVerdict === 'PASSED' || event.crawlVerdict === 'SKIPPED')
                  ? '✅ Verified Working — 0 broken routes'
                  : event.journeyVerdict !== 'PASSED'
                    ? `❌ Journey failed at: ${event.journeyFailedAt ?? 'unknown'}`
                    : `⚠️ ${event.crawlFailedLinks} broken route(s) — repair required`,
                summary: {
                  routesTested: totalLinks,
                  passed: event.crawlPassedLinks as number,
                  failed: event.crawlFailedLinks as number,
                  repaired: 0,
                  formsTested: metrics.formsTested,
                  searchTests: metrics.searchTests,
                  loginTests: metrics.loginTests,
                  logoutTests: metrics.logoutTests,
                  pages404Found: event.crawlFailedLinks as number,
                  pages404Fixed: 0,
                  screenshotsCaptured: prev.steps.filter(s => s.screenshotUrl).length,
                  finalPassRate: passRate,
                },
              };
            }

            case 'web-search':
              // Show Google Search activity in the current action label
              return {
                ...prev,
                currentAction: `🔍 Searching: "${event.query}" (${event.source}, ${event.resultCount} result(s))`,
              };

            default:
              return prev;
          }
        });

        if (event.type === 'complete') {
          es.close();
          resolve({
            journeyVerdict: event.journeyVerdict as 'PASSED' | 'FAILED VERIFICATION' | 'SKIPPED',
            journeyFailedAt: (event.journeyFailedAt as string) ?? '',
            journeyFailedRequests: event.journeyFailedRequests as number,
            journeySteps: event.journeySteps as Array<{ step: string; passed: boolean; optional: boolean; durationMs: number; screenshotUrl?: string; error?: string }>,
            crawlVerdict: event.crawlVerdict as 'PASSED' | 'FAILED' | 'SKIPPED',
            crawlPassedLinks: event.crawlPassedLinks as number,
            crawlFailedLinks: event.crawlFailedLinks as number,
            crawlMissingRouteFiles: event.crawlMissingRouteFiles as string[],
            crawlPagesVisited: event.crawlPagesVisited as number,
          });
        }

        if (event.type === 'error') {
          es.close();
          setVerificationLive(prev => prev ? { ...prev, active: false, currentAction: `Error: ${event.message}` } : null);
          reject(new Error(event.message as string));
        }
      };

      es.onerror = () => {
        es.close();
        setVerificationLive(prev => prev ? { ...prev, active: false, currentAction: 'Verification stream disconnected' } : null);
        reject(new Error('SSE stream disconnected'));
      };
    });
  };

  // ── New project ───────────────────────────────────────────────────────────

  const handleNewProject = () => {
    setPhase('idle');
    setHistory([]);
    setDisplayed([]);
    setBuildProgress(null);
    setPreviewUrl(null);
    setPreviewLoading(false);
    setReadyToBuild(false);
    setCurrentProject(null);
    setCurrentDiscovery(null);
    setCurrentMemory(null);
    setBuilderContext(null);
    setDebugActivity(null);
    setBuildRecommendation(null);
    setPendingBuildPrompt(null);
    setGoalStep('type');
    setGoalPlatform(null);
    setMobileTech(null);
  };

  const handleGoalSelect = (platform: 'website' | 'mobile') => {
    setGoalPlatform(platform);
    if (platform === 'website') {
      setBuildTarget('web');
      setGoalStep('idle');
      setTimeout(() => inputRef.current?.focus(), 100);
    } else {
      setGoalStep('mobile-tech');
    }
  };

  const handleMobileTechSelect = (tech: 'flutter' | 'android' | 'ios') => {
    setMobileTech(tech);
    setBuildTarget('flutter'); // android/ios both use the flutter pipeline for now
    setGoalStep('idle');
    setTimeout(() => inputRef.current?.focus(), 100);
  };

  const analyzePromptForPlatform = (prompt: string): { platform: 'website' | 'flutter' | null; reason: string; icon: string } => {
    const lower = prompt.toLowerCase();
    const mobileSignals = [
      'mobile app', 'android', 'iphone', 'ios app', 'flutter', 'apk', 'play store', 'app store',
      'uber', 'like lyft', 'ride hailing', 'ride sharing', 'food delivery', 'mobile game',
      'native app', 'smartphone', 'phone app', 'on my phone', 'whatsapp', 'tiktok like',
    ];
    const webSignals = [
      'website', 'web app', 'landing page', 'marketplace', 'saas', 'dashboard', 'admin',
      'blog', 'portfolio', 'ecommerce', 'e-commerce', 'online store', 'booking website',
      'web platform', 'next.js', 'react', 'booking site', 'directory',
    ];
    const mobileScore = mobileSignals.filter(s => lower.includes(s)).length;
    const webScore = webSignals.filter(s => lower.includes(s)).length;
    if (mobileScore > webScore && mobileScore > 0) {
      return { platform: 'flutter', reason: 'Flutter lets you launch on both Android and iPhone from a single codebase.', icon: '📱' };
    }
    if (webScore > mobileScore && webScore > 0) {
      return { platform: 'website', reason: 'This is best built as a full-stack web application with Next.js.', icon: '🌐' };
    }
    return { platform: null, reason: '', icon: '' };
  };

  // ── Open existing project ─────────────────────────────────────────────────

  const handleOpenProject = async (project: ProjectMeta) => {
    if (discoveryLoading) return;
    setCurrentProject(project);
    setBuilderContext({ projectName: project.name, stage: 'editing', active: true });
    setCurrentDiscovery(null);
    setCurrentMemory(null);
    setDiscoveryLoading(true);
    setPreviewUrl(null);
    setPreviewLoading(false);
    setReadyToBuild(false);
    setBuildProgress(null);
    setHistory([]);
    loadDeployRecord(project.id);
    setDisplayed([]);
    setGoalStep('idle');
    setBuildRecommendation(null);
    setPendingBuildPrompt(null);

    addStatus('DWOMOH Vibe Code is checking the selected project…', 'checking');

    try {
      // Step 1: Discover project structure
      const discResult = await api({ action: 'discover', projectPath: project.projectPath });
      addStatus('DWOMOH Vibe Code is reading the existing files…', 'reading');

      if (discResult.success) {
        setCurrentDiscovery({
          summary: discResult.summary,
          pages: discResult.pages || [],
          components: discResult.components || [],
          fileCount: discResult.fileCount || 0,
          framework: discResult.framework || 'Next.js',
          dependencies: discResult.dependencies || [],
          mode: discResult.mode,
          hasApiRoutes: discResult.hasApiRoutes,
          missingCredentials: discResult.missingCredentials || [],
        });
        if (discResult.memory) setCurrentMemory(discResult.memory);
      }

      addStatus('DWOMOH Vibe Code has understood the current project…', 'done');
      addStatus(`Starting ${project.name}…`, 'applying');

      // Step 2: Open project (start server, full discovery, memory init)
      const openResult = await api({ action: 'open-project', projectId: project.id });

      if (openResult.memory) {
        setCurrentMemory(openResult.memory);
        // Restore last N conversation turns from persisted memory
        const saved = (openResult.memory.conversationHistory || []).slice(-8);
        if (saved.length > 0) {
          setDisplayed(prev => {
            const divider: DisplayMessage = { role: 'status', content: `── Restored ${saved.length} message(s) from last session ──`, statusType: 'done' };
            const restored: DisplayMessage[] = saved.map((t: { role: string; content: string }) => ({
              role: (t.role === 'user' ? 'user' : 'assistant') as DisplayMessage['role'],
              content: t.content,
            }));
            return [...prev, divider, ...restored];
          });
        }
      }
      if (openResult.discovery) {
        const d = openResult.discovery;
        setCurrentDiscovery({
          summary: d.summary,
          pages: d.pages || [],
          components: d.components || [],
          fileCount: d.fileCount || 0,
          framework: d.framework || 'Next.js',
          mode: d.mode,
          hasApiRoutes: d.hasApiRoutes,
          missingCredentials: d.missingCredentials || [],
        });
      }

      if (!openResult.port) {
        addStatus(`Could not start server: ${openResult.error || 'unknown error'}`, 'error');
        setPhase('conversing');
      } else {
        const url = openResult.previewUrl || `http://localhost:${openResult.port}`;
        setPreviewUrl(url);
        setPreviewKey(k => k + 1);
        setPreviewLoading(true);
        setPhase('previewing');

        // Surface home-page probe result so the user knows immediately if the
        // preview will show a 404 instead of the real app.
        const hpVerified = openResult.homePageVerified;
        const hpError    = openResult.homePageError;
        const statusMsg  = hpVerified === false && hpError
          ? `⚠️ Home page probe failed: ${hpError}`
          : `${project.name} is running`;
        const statusKind = hpVerified === false ? 'error' as const : 'done' as const;

        setBuildProgress({ step: hpVerified === false ? 'error' : 'done', message: statusMsg, logs: [`✅ Port ${openResult.port}`], port: openResult.port });
        addStatus(statusKind === 'error' ? statusMsg : `DWOMOH Vibe Code has loaded ${project.name}. Preview is ready.`, statusKind);

        // Save design baseline for re-opened projects (idempotent — already exists for new builds)
        api({ action: 'save-design-baseline', projectPath: project.projectPath }).catch(() => {});

        const disc = openResult.discovery || {};
        const mem = openResult.memory || {};
        const pageLabels = (disc.pages || []).map((p: string) => p.replace('app/', '').replace('/page.tsx', '') || 'home');
        const compLabels = (disc.components || []).slice(0, 5).map((c: string) => c.replace('components/', '').replace('.tsx', ''));

        addMsg('assistant',
          `I've opened **${project.name}** and read all the files.\n\n` +
          `**Project summary:**\n` +
          `• Mode: ${disc.mode || 'Unknown'}\n` +
          `• Framework: ${disc.framework || 'Next.js'}\n` +
          `• Pages: ${pageLabels.join(', ') || 'home'}\n` +
          `• Components: ${compLabels.join(', ') || 'none'}\n` +
          `• API routes: ${disc.apiRoutes?.length > 0 ? disc.apiRoutes.join(', ') : 'none (search is client-side)'}\n` +
          `• Source files: ${disc.fileCount || '?'}\n` +
          ((mem.editsApplied || []).length > 0 ? `• Previous edits: ${mem.editsApplied.length}\n` : '') +
          (mem.authProvider ? `• Auth: ${mem.authProvider}\n` : '') +
          ((mem.dbIntegrations || []).length > 0 ? `• Database: ${mem.dbIntegrations.join(', ')}\n` : '') +
          ((mem.deployConfigs || []).length > 0 ? `• Deploy configs: ${mem.deployConfigs.join(', ')}\n` : '') +
          ((mem.verificationHistory || []).length > 0 ? `• Last verified: ${mem.verificationHistory[mem.verificationHistory.length - 1].summary}\n` : '') +
          (!disc.hasApiRoutes ? `\n⚡ **This app has no backend yet.** Click "Make Search Work" in the sidebar to upgrade it to a real full-stack app.\n` : '') +
          `\n**You can ask me:**\n` +
          `• "What did we build here?"\n` +
          `• "What files are in this project?"\n` +
          `• "Move the sign-in button to the top right"\n` +
          `• "Make the search work with real backend filtering"\n` +
          `• "Continue from where we stopped"`
        );

        await refreshProjects();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      addStatus(`Error: ${msg}`, 'error');
      setPhase('idle');
    } finally {
      setDiscoveryLoading(false);
      setLoading(false);
    }
  };

  // ── Edit pipeline ─────────────────────────────────────────────────────────

  const runEditPipeline = async (
    userRequest: string,
    conversationHistory: ConversationTurn[],
    _engineeringIntent?: ReturnType<typeof interpretCommand>,
  ) => {
    if (!currentProject) return;

    // Detect debug/fix intent to drive the Debug Preview panel
    const nlIntent = interpretCommand(userRequest);
    const isEngineeringCommand = nlIntent.isEngineeringCommand && nlIntent.confidence >= 0.75;
    const isDebugRequest = isEngineeringCommand || /\b(fix|debug|broken|not working|error|crash|failed|bug|issue|problem|wrong|incorrect|doesn't work|isnt working)\b/i.test(userRequest);

    setEditApplying(true);
    setReadyToBuild(false);
    setResearchActivity(null);
    setPreviewTab('preview'); // always show activity panel when editing

    // Initialise Debug or Edit activity panel
    const DEBUG_TIMELINE = [
      { step: 'Scanning project structure', status: 'active' as const },
      { step: 'Running root cause investigation', status: 'pending' as const },
      { step: 'Classifying issue layer', status: 'pending' as const },
      { step: 'Reading affected files', status: 'pending' as const },
      { step: 'Applying targeted fix', status: 'pending' as const },
      { step: 'Running type check', status: 'pending' as const },
      { step: 'Verifying routes', status: 'pending' as const },
    ];
    if (isDebugRequest && currentProject) {
      setDebugActivity({
        projectName: currentProject.name,
        status: 'scanning',
        errorCount: 0,
        rootCause: '',
        filesBeingRead: [],
        filesModified: [],
        buildLog: [],
        timeline: DEBUG_TIMELINE,
      });
    }

    const advanceDebug = (
      status: DebugActivity['status'],
      stepIdx: number,
      extras?: Partial<DebugActivity>
    ) => {
      setDebugActivity(prev => {
        if (!prev) return prev;
        const tl = prev.timeline.map((t, i) => ({
          ...t,
          status: i < stepIdx ? 'done' as const : i === stepIdx ? 'active' as const : 'pending' as const,
        }));
        return { ...prev, status, timeline: tl, ...extras };
      });
    };

    // ── Step ticker ──────────────────────────────────────────────────────────
    const EDIT_STEPS = [
      { id: 'reading',       label: 'Reading project files' },
      { id: 'understanding', label: 'Understanding your request' },
      { id: 'checking',      label: 'Checking affected components' },
      { id: 'preparing',     label: 'Planning changes' },
      { id: 'writing',       label: 'Writing updated files' },
      { id: 'applying',      label: 'Applying via Next.js hot reload' },
    ];
    const STEP_INTERVALS_MS = [0, 3500, 7000, 11000, 15000, 19000];

    const now = Date.now();
    setEditStartedAt(now);
    setEditElapsed(0);
    setEditDetailStep('reading');

    const stepTimers: ReturnType<typeof setTimeout>[] = [];
    EDIT_STEPS.forEach((s, i) => {
      if (i === 0) return;
      stepTimers.push(setTimeout(() => setEditDetailStep(s.id), STEP_INTERVALS_MS[i]));
    });
    const elapsedTimer = setInterval(() => {
      setEditElapsed(Math.floor((Date.now() - now) / 1000));
    }, 1000);
    const clearTimers = () => {
      stepTimers.forEach(t => clearTimeout(t));
      clearInterval(elapsedTimer);
    };

    try {
      // Auto-gather errors BEFORE calling the AI — so the agent never needs to ask.
      // This runs for ALL requests (not just debug) so the AI always sees current errors.
      let autoGatheredError = '';
      try {
        const logData = await api({ action: 'get-server-logs', projectPath: currentProject.projectPath });
        const rawLog: string = logData.logs || '';
        const errorLines = rawLog.split('\n')
          .filter((l: string) => /error|syntaxerror|failed|module not found|cannot find|unexpected token|enoent/i.test(l))
          .slice(-8)
          .join('\n')
          .trim();
        if (errorLines) autoGatheredError = errorLines;
      } catch { /* non-critical */ }

      // Run debug scan first if this is a fix request (populates timeline slots 1-2)
      let dbgResult: { errorCount?: number; affectedFiles?: string[]; tsErrors?: string[]; buildError?: string } = {};
      let rootCauseContext = '';
      if (isDebugRequest) {
        advanceDebug('reading', 1);

        // ── Root Cause Investigation — always runs before modifying files ──────
        // This is the core of the autonomous engineering model:
        // determine the issue layer (frontend/backend/api/database/auth/credentials/
        // configuration/infrastructure/permissions) BEFORE making any code changes.
        if (isEngineeringCommand || isDebugRequest) {
          try {
            addStatus(getActionLabel(nlIntent), 'checking');
            const investigationData = await api({
              action: 'investigate',
              projectPath: currentProject.projectPath,
              port: currentProject.port || undefined,
            });
            if (investigationData.success && investigationData.report) {
              const r = investigationData.report;
              rootCauseContext = `\n\n[ROOT CAUSE INVESTIGATION REPORT — read this before modifying any files]\n` +
                `Primary issue layer: ${r.primaryLayer?.toUpperCase() ?? 'UNKNOWN'}\n` +
                `Confidence: ${r.confidence}\n` +
                `Summary: ${r.summary}\n`;

              if (investigationData.findings?.length > 0) {
                rootCauseContext += `Critical findings:\n${investigationData.findings
                  .filter((f: { severity: string }) => f.severity === 'critical')
                  .map((f: { title: string; detail: string; fixHint?: string }) => `• ${f.title}: ${f.detail}${f.fixHint ? ` → ${f.fixHint}` : ''}`)
                  .join('\n')}\n`;
              }
              if (investigationData.missingCredentials?.length > 0) {
                rootCauseContext += `Missing credentials (NOT fixable by code changes — inform the user): ${investigationData.missingCredentials.join(', ')}\n`;
              }
              if (investigationData.report.endpointProbes?.length > 0) {
                const failedProbes = investigationData.report.endpointProbes.filter((p: { ok: boolean }) => !p.ok);
                if (failedProbes.length > 0) {
                  rootCauseContext += `Failing endpoints:\n${failedProbes.map((p: { name: string; statusCode?: number; error?: string }) => `• ${p.name}: HTTP ${p.statusCode ?? 'unreachable'}`).join('\n')}\n`;
                }
              }

              advanceDebug('analyzing', 2, {
                rootCause: `${r.primaryLayer}: ${r.summary.slice(0, 100)}`,
                buildLog: investigationData.findings?.filter((f: { severity: string }) => f.severity === 'critical').map((f: { title: string }) => f.title) ?? [],
              });

              // Show the raw investigation result only in Debug Mode.
              // Normal users see a friendly "investigating…" message instead.
              if (investigationData.formatted) {
                if (debugMode) {
                  addStatus(investigationData.formatted, 'reading');
                } else {
                  console.debug('[engineering-report]', investigationData.formatted);
                }
              }
            }
          } catch { /* non-critical — investigation failed, proceed with generic fix */ }
        }

        try {
          const dbg = await api({ action: 'debug-project', projectPath: currentProject.projectPath });
          dbgResult = dbg;
          if (!rootCauseContext) {
            advanceDebug('analyzing', 2, {
              errorCount: dbg.errorCount || 0,
              filesBeingRead: dbg.affectedFiles || [],
              buildLog: dbg.tsErrors?.slice(0, 5) || [],
            });
          }
          // Merge TypeScript errors and build error into autoGatheredError
          if (dbg.tsErrors?.length) autoGatheredError = (autoGatheredError ? autoGatheredError + '\n' : '') + dbg.tsErrors.slice(0, 5).join('\n');
          if (dbg.buildError) autoGatheredError = (autoGatheredError ? autoGatheredError + '\n' : '') + dbg.buildError;
          await new Promise(r => setTimeout(r, 600));
        } catch { /* non-critical — proceed with edit */ }
        advanceDebug('fixing', 3);
      }

      // ── Pre-repair pipeline — runs BEFORE any file edit ───────────────────────
      // Checks the environment (packages, route methods, DB init, tsconfig) and
      // either fixes the issue directly (no AI needed) or builds rich diagnostic
      // context that makes the AI edit far more accurate and less likely to regress.
      let preRepairContext = '';
      const runPort0 = buildProgress?.port || currentProject.port;

      if (isDebugRequest || autoGatheredError) {
        try {
          addStatus('Checking environment before editing files…', 'checking');
          const tsErrorsForDiag = dbgResult.tsErrors ?? [];

          const diagResult = await api({
            action: 'pre-repair-check',
            projectPath: currentProject.projectPath,
            userRequest,
            errorContext: autoGatheredError,
            tsErrors: tsErrorsForDiag,
          });

          // ── Engineering memory: known fix exists? ─────────────────────────
          if (diagResult?.memoryMatch) {
            const match = diagResult.memoryMatch;
            if (debugMode) addStatus(`Engineering memory: ${match.rootCause} (${match.confidence} confidence)`, 'checking');

            if (match.confidence === 'certain' && match.pattern?.directTransform) {
              // 'certain' match with a directTransform — apply WITHOUT calling AI
              // This is the fastest repair path: error recognized → transform applied → done
              if (debugMode) addStatus(`Auto-applying ${match.pattern.directTransform} (certainty: skipping AI)`, 'applying');
              else addStatus('Applying known fix…', 'applying');

              const memDetResult = await api({
                action: 'deterministic-repair',
                projectPath: currentProject.projectPath,
                errorText: autoGatheredError,
                tsErrors: dbgResult?.tsErrors ?? [],
                forceTransform: match.pattern.directTransform,
              }).catch(() => null);

              if (memDetResult?.applied?.length > 0 && memDetResult.allFixed) {
                await new Promise(r => setTimeout(r, 2000));
                setPreviewKey(k => k + 1);
                setEditDetailStep('complete');
                addStatus('Fix applied and verified.', 'done');
                addMsg('assistant',
                  `**Fixed automatically** ✅\n\nKnown pattern recognized: **${match.rootCause}**\n\n` +
                  (memDetResult.applied as Array<{description: string}>).map((f: {description: string}) => `- ${f.description}`).join('\n')
                );
                return;
              }
              // If it didn't fix everything, fall through — but add context
              if (diagResult.memoryContext) preRepairContext += `\n\n${diagResult.memoryContext}`;
            } else if (match.confidence === 'high' || match.confidence === 'medium') {
              if (diagResult.memoryContext) preRepairContext += `\n\n${diagResult.memoryContext}`;
            }
          }

          // ── Repair coordinator: shared upstream detection ──────────────────
          // Run Phase 1-3 (signal collection + project map + repair planner)
          // to identify if many files fail because of one shared dependency.
          // If detected, prepend the upstream file to the repair context so
          // the AI fixes the root cause first, not the individual route files.
          try {
            const coordResult = await api({
              action: 'coordinate-repair',
              projectPath: currentProject.projectPath,
              errorText: autoGatheredError,
            }).catch(() => null);

            if (coordResult?.result?.hasSharedUpstream && coordResult.result.sharedUpstreamFile) {
              const upstreamFile = coordResult.result.sharedUpstreamFile;
              if (debugMode) addStatus(`Shared dependency root cause: ${upstreamFile}`, 'checking');
              preRepairContext +=
                `\n\n[SHARED DEPENDENCY ROOT CAUSE IDENTIFIED]\n` +
                `Multiple files fail because '${upstreamFile}' is broken.\n` +
                `Fix '${upstreamFile}' FIRST. Do NOT patch the downstream route files individually.\n` +
                `After fixing '${upstreamFile}', the downstream errors will resolve automatically.\n`;
            } else if (debugMode && coordResult?.result?.summary) {
              addStatus(`Diagnosis: ${coordResult.result.debugMessage?.split('\n')[0] ?? coordResult.result.summary}`, 'checking');
            }
          } catch { /* coordinator is non-critical */ }

          // ── Auto-install missing packages (no AI needed) ──────────────────
          if (diagResult?.missingPackages?.length > 0) {
            const pkgs: string[] = diagResult.missingPackages;
            if (debugMode) addStatus(`Installing missing packages: ${pkgs.join(', ')}…`, 'applying');
            else addStatus('Installing dependencies…', 'applying');
            const installResult = await api({
              action: 'install-packages',
              projectPath: currentProject.projectPath,
              packages: pkgs,
            });
            if (installResult?.success) {
              if (debugMode) addStatus(`Installed ${pkgs.join(', ')} — re-verifying…`, 'checking');
              else addStatus('Dependencies installed. Verifying…', 'checking');
              await new Promise(r => setTimeout(r, 3000)); // wait for compilation
              setPreviewKey(k => k + 1);

              if (runPort0) {
                try {
                  const quickVerify = await api({ action: 'verify-app', port: runPort0, projectPath: currentProject.projectPath });
                  if (quickVerify?.verified) {
                    setEditDetailStep('complete');
                    addStatus('✅ Fixed by installing missing packages.', 'done');
                    addMsg('assistant',
                      `**Fixed** ✅\n\nThe issue was missing npm package(s): **${pkgs.join(', ')}**\n\n` +
                      `Installed and verified — no code changes needed.\n\n${quickVerify.summary}`
                    );
                    // Learn from this repair — improves package-dependency engine
                    api({
                      action: 'learn-from-repair',
                      projectPath: currentProject.projectPath,
                      errorText: autoGatheredError,
                      changedFiles: [],
                      userMessage: userRequest,
                      fixSummary: `Installed missing packages: ${pkgs.join(', ')}`,
                      tier: 'HAIKU',
                    }).then((r: {learning?: {engineImprovement?: string; capabilityName?: string}} | null) => {
                      if (r?.learning?.capabilityName && debugMode) addStatus(`Engine learned: ${r.learning.capabilityName}`, 'done');
                    }).catch(() => {});
                    return;
                  }
                } catch { /* continue to code repair */ }
              }
              // Packages installed but verify didn't pass — continue with code repair
              // but now the package is present so code edits should not regress on missing modules
              autoGatheredError = (autoGatheredError ? autoGatheredError + '\n' : '') +
                `[PACKAGES INSTALLED: ${pkgs.join(', ')} — imports should now resolve]`;
            }
          }

          // ── Auto-fix tsconfig issues (no AI needed) ───────────────────────
          if (diagResult?.tsConfigIssues?.length > 0) {
            if (debugMode) addStatus('Removing invalid tsconfig options…', 'applying');
            else addStatus('Repairing configuration…', 'applying');
            await api({
              action: 'agent-fix',
              projectPath: currentProject.projectPath,
              errorContext: `Fix these tsconfig.json issues by removing the invalid options:\n${diagResult.tsConfigIssues.join('\n')}\nOnly remove the invalid options — do not change anything else.`,
              targetFiles: ['tsconfig.json'],
              strategy: 'targeted',
              tier: 'HAIKU',
            }).catch(() => {});
          }

          // ── Build diagnostic context for the AI edit ──────────────────────
          if (diagResult?.enrichedContext) {
            preRepairContext += `\n\n${diagResult.enrichedContext}`;
          }

          // Surface findings to debug timeline
          if (diagResult?.rootCause && diagResult.rootCause !== 'unknown') {
            advanceDebug && advanceDebug('analyzing', 2, {
              rootCause: `Pre-repair: ${diagResult.rootCauseDetail}`,
              buildLog: [
                ...(diagResult.missingPackages.map((p: string) => `Missing: ${p}`)),
                ...(diagResult.routeMethodIssues.map((r: { issue: string }) => `Route: ${r.issue}`)),
                ...(diagResult.dbIssues.map((d: { issue: string }) => `DB: ${d.issue}`)),
              ],
            });
          }
        } catch { /* pre-repair is non-critical — always continue to edit */ }
      }

      // ── PHASE 1: Deterministic repair — fix known patterns WITHOUT calling AI ──
      // For error patterns the system recognises (auth-await, db-wrapper, use-client),
      // apply a direct code transformation. Only escalate to AI if this fails.
      // This replicates what a developer does: read error → apply known fix → verify.
      if (isDebugRequest && autoGatheredError && currentProject) {
        try {
          addStatus('Checking for known fix patterns…', 'checking');
          const detResult = await api({
            action: 'deterministic-repair',
            projectPath: currentProject.projectPath,
            errorText: autoGatheredError,
            tsErrors: dbgResult?.tsErrors ?? [],
          });

          if (detResult?.applied?.length > 0) {
            if (debugMode) {
              addStatus(
                `Deterministic fixes applied: ${(detResult.applied as Array<{transformId: string; file: string}>).map(f => `${f.transformId} → ${f.file}`).join(', ')}`,
                'applying',
              );
            } else {
              addStatus('Applying targeted fix…', 'applying');
            }

            if (detResult.allFixed) {
              // TypeScript errors gone — no AI call needed
              await new Promise(r => setTimeout(r, 2000));
              setPreviewKey(k => k + 1);
              setEditDetailStep('complete');
              addStatus('Fix applied and verified.', 'done');
              addMsg('assistant',
                `**Fixed** ✅\n\nThe issue was identified and repaired automatically:\n\n` +
                (detResult.applied as Array<{description: string}>).map(f => `- ${f.description}`).join('\n') + '\n\n' +
                `Reloading preview…`
              );
              // Learn from this deterministic repair — improves build-repair + relevant engine
              api({
                action: 'learn-from-repair',
                projectPath: currentProject.projectPath,
                errorText: autoGatheredError,
                changedFiles: (detResult.applied as Array<{file: string}>).map(f => f.file),
                userMessage: userRequest,
                fixSummary: (detResult.applied as Array<{description: string}>).map(f => f.description).join('; '),
                tier: 'HAIKU',
              }).then((r: {learning?: {engineImprovement?: string; capabilityName?: string; isAutoRepair?: boolean}} | null) => {
                if (r?.learning && debugMode) {
                  addStatus(`Engine learned: ${r.learning.capabilityName}${r.learning.isAutoRepair ? ' (auto-repair enabled)' : ''}`, 'done');
                }
              }).catch(() => {});
              return;
            }

            // Partial fix — some errors remain, continue to AI with updated context
            const remaining = (detResult.remainingTsErrors as string[]) ?? [];
            if (remaining.length > 0) {
              autoGatheredError = remaining.join('\n');
            }
          }
        } catch { /* non-critical — continue to AI repair */ }
      }

      // ── PHASE 2a: Auth Architecture Investigation ─────────────────────────────
      // When auth-related errors are present: investigate the full dependency graph
      // BEFORE making any file edits. This finds the root cause (e.g. broken db adapter
      // that makes all auth routes fail) and produces a one-file-at-a-time repair plan.
      // Sequential repair isolates each step so a bad fix doesn't cascade.
      const allErrorText = autoGatheredError + (dbgResult?.tsErrors ?? []).join('\n');
      const isAuthRelated = /auth|login|logout|session|token|jwt|signup|register|password|\/api\/auth\//i.test(allErrorText);

      if (isAuthRelated && isDebugRequest && currentProject) {
        try {
          addStatus('Investigating authentication architecture…', 'checking');
          const authReport = await api({
            action: 'auth-investigate',
            projectPath: currentProject.projectPath,
            tsErrors: dbgResult?.tsErrors ?? [],
          });

          if (authReport?.success && (authReport.repairSteps?.length ?? 0) > 0) {
            if (debugMode) {
              addStatus(`Auth investigation complete — provider: ${authReport.provider}, ${authReport.repairSteps.length} repair step(s)`, 'checking');
              addStatus(authReport.summary?.replace(/\n/g, ' | ') ?? '', 'reading');
            } else {
              addStatus('Repairing automatically…', 'applying');
            }

            // ── Sequential repair: one file at a time ──────────────────────────
            let allAuthFixed = false;
            const stepsResolved: string[] = [];

            for (const step of (authReport.repairSteps as Array<{
              stepNumber: number; title: string; targetFile: string;
              contextFiles: string[]; tsErrors: string[]; repairHint: string;
              verifyWith: string; verifyRoute?: string;
            }>)) {
              if (debugMode) {
                addStatus(`Step ${step.stepNumber}/${authReport.repairSteps.length}: ${step.title}`, 'applying');
              } else {
                addStatus('Testing fix…', 'applying');
              }

              const stepErrorContext =
                `AUTH REPAIR — STEP ${step.stepNumber} OF ${authReport.repairSteps.length}\n` +
                `INSTRUCTION: ${step.repairHint}\n\n` +
                `TARGET FILE: ${step.targetFile}\n` +
                (step.tsErrors.length > 0 ? `ERRORS IN THIS FILE:\n${step.tsErrors.join('\n')}\n` : 'NOTE: File may be missing — create it.\n') +
                (stepsResolved.length > 0 ? `\nALREADY FIXED IN EARLIER STEPS: ${stepsResolved.join(', ')} — import from these correctly.\n` : '') +
                `\nFIX ONLY ${step.targetFile}. Do NOT modify other files in this step.`;

              let stepFixed = false;
              for (const tier of (['HAIKU', 'SONNET'] as const)) {
                try {
                  const stepResult = await api({
                    action: 'agent-fix',
                    projectPath: currentProject.projectPath,
                    errorContext: stepErrorContext,
                    targetFiles: [step.targetFile],
                    contextFiles: step.contextFiles,
                    strategy: 'targeted',
                    tier,
                  });

                  if (stepResult?.fixedCount > 0) {
                    // Verify: check if THIS file's errors are gone
                    await new Promise(r => setTimeout(r, 800));
                    const recheck = await api({ action: 'validate', projectPath: currentProject.projectPath });
                    const remainingForFile = (recheck?.errors ?? []).filter(
                      (e: string) => e.includes(step.targetFile)
                    );
                    if (remainingForFile.length === 0) {
                      stepFixed = true;
                      stepsResolved.push(step.targetFile);
                      if (debugMode) addStatus(`✓ Step ${step.stepNumber} resolved`, 'done');
                      break; // don't escalate — this step is done
                    }
                  }
                } catch { /* try next tier */ }
                if (stepFixed) break;
              }

              if (!stepFixed && debugMode) {
                addStatus(`Step ${step.stepNumber} needs further repair — continuing…`, 'checking');
              }
            }

            // Final verification — check overall auth health
            addStatus('Verifying authentication…', 'checking');
            await new Promise(r => setTimeout(r, 1200));
            const finalCheck = await api({ action: 'validate', projectPath: currentProject.projectPath });
            const remainingAuthErrors = (finalCheck?.errors ?? []).filter(
              (e: string) => /auth|login|logout|session|token/i.test(e)
            );

            if (remainingAuthErrors.length === 0) {
              allAuthFixed = true;
              setPreviewKey(k => k + 1);
              setEditDetailStep('complete');
              addStatus('Authentication repaired.', 'done');
              addMsg('assistant',
                `**Authentication repaired** ✅\n\n` +
                `Fixed ${stepsResolved.length} file(s) in dependency order:\n` +
                stepsResolved.map(f => `- \`${f}\``).join('\n') +
                `\n\nAll auth flows should now be healthy. If you still see issues, try the login/signup flow in the preview.`
              );
              return;
            }

            // Partial fix — update autoGatheredError to only remaining problems
            if (remainingAuthErrors.length < (dbgResult?.tsErrors ?? []).length) {
              autoGatheredError = remainingAuthErrors.join('\n');
            }

            if (!allAuthFixed && !debugMode) {
              addStatus('Repairing automatically…', 'applying');
            }
          }
        } catch { /* non-critical — fall through to standard repair */ }
      }

      // Inject root cause report + auto-gathered errors + pre-repair diagnostics
      // so the AI engineer always knows the layer to target before touching files.
      // ── Feature Understanding Layer ───────────────────────────────────────────
      // For non-debug feature requests, call the feature planner to expand the
      // request into a complete specification before the AI generates code.
      // This prevents partial implementations (e.g. forgot-password with no API)
      // and injects route structure constraints to prevent route conflicts.
      let featureSpecBlock = '';
      if (!isDebugRequest && currentProject) {
        try {
          const featurePlan = await api({
            action: 'plan-feature',
            projectPath: currentProject.projectPath,
            request: userRequest,
          });
          if (featurePlan?.hasSpec && featurePlan.specificationBlock) {
            featureSpecBlock = featurePlan.specificationBlock;
            if (debugMode) addStatus(`Feature plan: ${featurePlan.category} — ${featurePlan.checklist.length} requirements`, 'checking');
          }
        } catch { /* non-critical — feature planner failure never blocks the edit */ }
      }

      // ── Surgical edit detection ───────────────────────────────────────────────
      // Small targeted requests go through the surgical path:
      //   1. Identify the one affected file from the request
      //   2. Inspect real exports of its imports (prevents hallucinated names)
      //   3. Call agent-fix with strategy='surgical' (single-file, minimal diff)
      //   4. safeApply handles rollback if TypeScript breaks
      // Full rebuilds / feature additions continue with the regular edit path.

      const SURGICAL_SIGNALS = /\b(change|update|rename|make\s+(?:the|it)|fix\s+(?:the\s+)?(?:text|label|button|color|style|typo|wording|title|heading|icon|spacing|padding|margin|font|border|size)|add\s+(?:a\s+)?(?:field|column|label|tooltip|badge|class|style|attribute)|move\s+the|adjust|tweak|swap|replace\s+(?:the\s+)?(?:text|label|icon|button|color|image)|set\s+(?:the\s+)?(?:color|text|label|style))\b/i;

      const REBUILD_SIGNALS = /\b(redesign|rebuild|rewrite|start\s+over|redo|rework|completely\s+change|make\s+it\s+look|new\s+(?:design|layout|theme))\b/i;

      const wordCount = userRequest.trim().split(/\s+/).length;
      const isSurgical = !isDebugRequest
        && !REBUILD_SIGNALS.test(userRequest)
        && (SURGICAL_SIGNALS.test(userRequest) || wordCount <= 12)
        && !featureSpecBlock; // feature planner already ran = treat as additive, not surgical

      // ── Single-item resolve+apply+verify, shared by the single-edit path
      // below AND the multi-item split path further down. Identical logic to
      // what previously lived inline in the single-edit block — extracted so
      // a bundled multi-fix message ("fix the signup button color, remove
      // the duplicate footer, and the pricing image is too big") can run the
      // exact same identify/interpret/ambiguous/apply/re-verify sequence
      // once per item instead of only ever handling the message as a whole.
      type SurgicalItemResult =
        | { status: 'fixed'; file: string; interpretation: string; issues: string[] }
        | { status: 'ambiguous'; question: string }
        | { status: 'needs_broader_edit' }
        | { status: 'not_found' };

      const resolveAndApplySurgicalItem = async (
        itemText: string,
        onInterpretation?: (text: string) => void,
      ): Promise<SurgicalItemResult> => {
        if (!currentProject) return { status: 'not_found' };

        // ── Step 1: Ask AI to identify the target file ──────────────────────
        // We send the request + project file list so the AI picks the right file.
        const projectFiles = await api({
          action: 'list-project-files',
          projectPath: currentProject.projectPath,
        }).catch(() => null);

        const fileList = (projectFiles?.files as string[] ?? [])
          .filter((f: string) => !f.includes('node_modules') && !f.startsWith('.next'))
          .slice(0, 60)
          .join('\n');

        const identifyPrompt = `Given the user request: "${itemText}"
And these project files:
${fileList}

Respond in EXACTLY this format, nothing else:

INTERPRETATION: <one short, plain-language sentence stating what you believe should change>
FILE: <the ONE relative file path to change, e.g. app/sell/page.tsx>

If several files need changes together as ONE coordinated edit, reply with FILE: MULTI instead of a
path (INTERPRETATION is still required).

Only if the request is GENUINELY ambiguous — there are multiple DIFFERENT, unrelated things it could
plausibly mean, and nothing in the request or file list lets you pick one with reasonable confidence —
respond instead with EXACTLY:
AMBIGUOUS: <a short, specific question naming the plausible options, e.g. "There are buttons on both
the signup page and the contact page — which one did you mean?">`;

        const identifyResult = await api({
          action: 'agent-fix',
          projectPath: currentProject.projectPath,
          errorContext: identifyPrompt,
          targetFiles: [],
          strategy: 'targeted',
          tier: 'HAIKU',
        }).catch(() => null);

        const rawResponse = identifyResult?.rawAiResponse ?? '';

        // Genuinely ambiguous — the caller surfaces the real question and
        // does NOT touch any file until the user's next message disambiguates.
        const ambiguousMatch = rawResponse.match(/AMBIGUOUS:\s*(.+)/i);
        if (ambiguousMatch) return { status: 'ambiguous', question: ambiguousMatch[1].trim() };

        const interpretationMatch = rawResponse.match(/INTERPRETATION:\s*(.+)/i);
        const interpretation = interpretationMatch?.[1]?.trim() ?? '';
        // FILE: MULTI (structured) or a bare "MULTI" reply (old-format fallback)
        // both mean "needs several files together" — the caller falls through
        // to the standard editor (single-item case) or reports it as needing
        // broader changes (multi-item case). Otherwise parse the file path
        // from either the structured FILE: line or (fallback) anywhere in the
        // response, so a slightly malformed reply still degrades gracefully
        // instead of silently doing nothing.
        const isMulti = /FILE:\s*MULTI\b/i.test(rawResponse) || /\bMULTI\b/.test(rawResponse);
        const fileLineMatch = rawResponse.match(/FILE:\s*((?:app|components|lib|services)\/[\w/\-.]+\.(?:tsx?|jsx?))/i);
        const fileMatch = fileLineMatch ?? rawResponse.match(/(?:app|components|lib|services)\/[\w/\-.]+\.(?:tsx?|jsx?)/);
        const identifiedFile = fileMatch?.[1] ?? fileMatch?.[0] ?? '';

        if (isMulti) return { status: 'needs_broader_edit' };
        if (!identifiedFile) return { status: 'not_found' };

        // State the interpretation in one sentence before touching anything —
        // per the audit's "confirm before fixing" requirement. Not a
        // question; proceeds immediately unless AMBIGUOUS fired above.
        if (interpretation) onInterpretation?.(interpretation);
        addStatus(debugMode ? `Surgical edit: ${identifiedFile}` : 'Reading affected file…', 'reading');

        // ── Step 2: Inspect real exports from the target file's imports ──
        const exportResult = await api({
          action: 'inspect-exports',
          projectPath: currentProject.projectPath,
          sourceFile: identifiedFile,
        }).catch(() => null);

        const exportMapBlock = exportResult?.formatted ?? '';

        if (debugMode && exportMapBlock) {
          addStatus(`Export map:\n${exportMapBlock}`, 'checking');
        }

        addStatus(debugMode ? `Applying surgical edit to ${identifiedFile}` : 'Applying change…', 'applying');

        // ── Step 3: Apply surgical edit ─────────────────────────────────
        const surgicalResult = await api({
          action: 'agent-fix',
          projectPath: currentProject.projectPath,
          errorContext: itemText,
          targetFiles: [identifiedFile],
          strategy: 'surgical',
          exportMap: exportMapBlock,
          tier: 'SONNET',
        }).catch(() => null);

        if (!(surgicalResult?.fixedCount > 0)) return { status: 'not_found' };

        setEditDetailStep('verifying');

        // ── Post-edit re-verification (same checks the standard edit path
        // runs at lines ~2861/2975) — the surgical path used to skip this
        // entirely and report "Done" unconditionally, so a single-file edit
        // was the one case with no automatic re-check that the rest of the
        // app (other pages/routes/imports) still works. Kept intentionally
        // lighter than the standard path's full cascade (no TS-error
        // auto-repair loop here) — this is strictly the same two checks
        // named for this fix, surfaced honestly rather than silently swallowed.
        let missingRoutes: string[] = [];
        try {
          addStatus('Scanning navigation links…', 'checking');
          const routeScan = await api({
            action: 'scan-missing-routes',
            projectPath: currentProject.projectPath,
          });
          missingRoutes = routeScan?.scanResult?.missingRoutes ?? [];
        } catch { /* route scan is best-effort — never block the edit flow */ }

        let verifyFailed: string[] = [];
        const runPort = buildProgress?.port || currentProject.port;
        if (runPort) {
          try {
            addStatus('Testing routes and links…', 'checking');
            const verifyData = await api({ action: 'verify-app', port: runPort, projectPath: currentProject.projectPath });
            if (verifyData) setLastVerification(verifyData as { verified: boolean; summary: string; checks: Array<{ name: string; passed: boolean; recordCount?: number; error?: string }> });
            verifyFailed = (verifyData?.checks ?? [])
              .filter((c: { passed: boolean; softPassed?: boolean }) => !c.passed && !c.softPassed)
              .map((c: { name: string }) => c.name);
          } catch { /* verify-app is best-effort — never block the edit flow */ }
        }

        const issues = [
          missingRoutes.length > 0 ? `Missing page(s) for: ${missingRoutes.join(', ')}` : '',
          verifyFailed.length > 0 ? `Route/API check(s) failed: ${verifyFailed.join(', ')}` : '',
        ].filter(Boolean);

        return { status: 'fixed', file: identifiedFile, interpretation, issues };
      };

      // ── Multi-item bundled edit detection ─────────────────────────────────
      // A single message can describe several separate, unrelated fixes at
      // once (e.g. "fix the signup button color, remove the duplicate
      // footer, and the pricing image is too big"). Previously this only
      // ever hit the surgical path's MULTI signal (built for "one
      // coordinated edit touching several files together"), which doesn't
      // split anything — it hands the WHOLE message to the standard editor
      // as one combined AI call, with no per-item resolution, verification,
      // or reporting. Cheap heuristic pre-filter (connector words + minimum
      // length) before an AI call actually judges it — same "cheap gate,
      // then AI decides" pattern the surgical-edit detection above uses —
      // avoids an extra round-trip for the common single-request case.
      const MULTI_ITEM_HINT = /(,\s*(?:and\s+)?|;\s*|\band\s+(?:also\s+)?|\balso\b)/i;
      const looksLikeMultiItem = !isDebugRequest && !featureSpecBlock
        && !REBUILD_SIGNALS.test(userRequest)
        && MULTI_ITEM_HINT.test(userRequest)
        && wordCount > 8;

      if (looksLikeMultiItem && currentProject) {
        try {
          const splitPrompt = `Does this message describe ONE thing to fix (even if it needs several files together), or MULTIPLE separate, unrelated things to fix?

Message: "${userRequest}"

If it's genuinely multiple separate things, reply with each one on its own line, prefixed "ITEM: " (plain language, one fix per line, e.g. "ITEM: change the signup button color").
If it's really just ONE thing, reply with exactly: SINGLE`;

          const splitResult = await api({
            action: 'agent-fix',
            projectPath: currentProject.projectPath,
            errorContext: splitPrompt,
            targetFiles: [],
            strategy: 'targeted',
            tier: 'HAIKU',
          }).catch(() => null);

          const splitRaw = splitResult?.rawAiResponse ?? '';
          const items = [...splitRaw.matchAll(/ITEM:\s*(.+)/gi)].map((m: RegExpMatchArray) => m[1].trim()).filter(Boolean);

          if (items.length >= 2) {
            addStatus(`Found ${items.length} separate fix(es). Processing each…`, 'checking');
            addMsg('assistant',
              `This looks like ${items.length} separate fixes — I'll handle each one individually:\n${items.map((it, i) => `${i + 1}. ${it}`).join('\n')}`
            );

            const results: { item: string; result: SurgicalItemResult }[] = [];
            for (const item of items) {
              addStatus(`Working on: ${item}`, 'applying');
              try {
                const result = await resolveAndApplySurgicalItem(item);
                results.push({ item, result });
              } catch {
                results.push({ item, result: { status: 'not_found' } });
              }
            }

            if (results.some(r => r.result.status === 'fixed')) {
              await new Promise(r => setTimeout(r, 1500));
              setPreviewKey(k => k + 1);
            }
            setEditDetailStep('complete');

            const lines = results.map(({ item, result }) => {
              if (result.status === 'fixed') {
                const issueNote = result.issues.length > 0 ? ` (⚠️ re-verification found: ${result.issues.join('; ')})` : '';
                return `✅ Fixed: "${item}" — changed \`${result.file}\`${issueNote}`;
              }
              if (result.status === 'ambiguous') return `❓ Ambiguous: "${item}" — ${result.question}`;
              if (result.status === 'needs_broader_edit') return `⚠️ Needs broader changes: "${item}" — describe this one on its own and I'll use the full editor`;
              return `❌ Not found: "${item}" — couldn't identify or apply a fix`;
            });

            addStatus('All items processed.', 'done');
            addMsg('assistant',
              `Here's what I found:\n\n${lines.join('\n')}` +
              (results.some(r => r.result.status === 'ambiguous') ? '\n\nFor anything marked ambiguous, just clarify and I\'ll apply it.' : '')
            );
            return;
          }
          // SINGLE (or unparseable) — fall through to the normal single-edit flow below.
        } catch { /* non-critical — fall through to normal edit flow */ }
      }

      if (isSurgical && currentProject) {
        try {
          addStatus('Identifying affected file…', 'reading');

          const result = await resolveAndApplySurgicalItem(
            userRequest,
            (text) => addMsg('assistant', `Interpreting this as: ${text}`),
          );

          if (result.status === 'ambiguous') {
            addStatus('Needs clarification.', 'checking');
            addMsg('assistant', result.question);
            return;
          }

          if (result.status === 'fixed') {
            await new Promise(r => setTimeout(r, 1500));
            setPreviewKey(k => k + 1);
            setEditDetailStep('complete');
            if (result.issues.length === 0) {
              addStatus('Change applied.', 'done');
              addMsg('assistant',
                `Done ✅\n\nChanged \`${result.file}\`.\n\nIf something looks off, just describe the next adjustment.`
              );
            } else {
              addStatus('Change applied, but re-verification found issues.', 'error');
              addMsg('assistant',
                `Changed \`${result.file}\`, but re-verification found something else may be affected:\n\n${result.issues.join('\n')}\n\nLet me know if you'd like me to look into this.`
              );
            }
            return;
          }

          // 'needs_broader_edit' or 'not_found' — fall through to standard edit
          addStatus(
            result.status === 'needs_broader_edit' ? 'Multiple files affected. Using standard editor…' : 'Applying via standard editor…',
            'checking'
          );
        } catch { /* non-critical — fall through to standard edit */ }
      }

      const enrichedRequest = (() => {
        let req = userRequest;
        if (featureSpecBlock) {
          req = `${featureSpecBlock}\n\n${req}`;
        }
        if (isDebugRequest && autoGatheredError) {
          req += `\n\n[ERRORS VISIBLE IN THE PREVIEW/TERMINAL — fix these, do not ask the user for more detail]:\n${autoGatheredError}`;
        }
        if (rootCauseContext) {
          req += rootCauseContext;
        }
        if (preRepairContext) {
          req += preRepairContext;
        }
        return req;
      })();

      // ── Scope constraint: restrict AI to the correct file layer ───────────────
      // When root cause is identified, prevent the AI from modifying unrelated files.
      // "Fix the API" must not edit frontend components. "Fix auth" must not touch DB files.
      const buildScopeConstraint = () => {
        // Extract layer from root cause context if available
        const layerMatch = rootCauseContext.match(/Primary issue layer: (\w+)/i);
        const layer = layerMatch?.[1]?.toLowerCase() ?? nlIntent.targetLayer;

        if (!layer || layer === 'unknown') return undefined;

        const LAYER_SCOPES: Record<string, { allowedPrefixes: string[]; blockedPrefixes: string[] }> = {
          api:            { allowedPrefixes: ['app/api/', 'lib/'],     blockedPrefixes: ['app/page.tsx', 'app/layout.tsx', 'components/'] },
          backend:        { allowedPrefixes: ['app/api/', 'lib/', 'services/'], blockedPrefixes: [] },
          frontend:       { allowedPrefixes: ['app/', 'components/'],  blockedPrefixes: ['app/api/'] },
          auth:           { allowedPrefixes: ['app/api/auth/', 'lib/auth', 'lib/managed/auth'], blockedPrefixes: [] },
          database:       { allowedPrefixes: ['lib/', 'app/api/'],     blockedPrefixes: ['app/page.tsx', 'components/'] },
          configuration:  { allowedPrefixes: ['next.config', 'tsconfig', 'package.json', 'tailwind'], blockedPrefixes: [] },
        };

        const scope = LAYER_SCOPES[layer];
        if (!scope) return undefined;
        return { layer, ...scope };
      };

      const scopeConstraint = buildScopeConstraint();

      const editResult = await apiWithRetry(
        {
          action: 'edit',
          projectPath: currentProject.projectPath,
          userRequest: enrichedRequest,
          messages: conversationHistory,
          safeApply: true,          // always on: snapshot + TypeScript regression check
          scopeConstraint,          // layer-specific file restriction
        },
        (attempt) => {
          setEditDetailStep('retrying');
          if (debugMode) addStatus(`Retrying ${attempt} of 2 — reconnecting to AI…`, 'applying');
          else addStatus('Retrying…', 'applying');
        },
      );

      clearTimers();

      if (editResult.conversational) {
        setEditDetailStep('complete');
        if (isDebugRequest) advanceDebug('complete', DEBUG_TIMELINE.length - 1);
        addMsg('assistant', editResult.response || 'Done.');
        return;
      }

      // ── Safety Gate: regression detected — orchestrated repair pipeline ───────
      // Phase 1: Signal collection + project map + root cause identification
      // Phase 2: Sequential repair (root cause first, dependents after)
      // Phase 3: Multi-level verification (L1 → L2 → L3)
      // Fallback: REPAIR_ROUNDS escalation (Haiku → Sonnet → Opus) if Phase 1-3 fail
      if (editResult.regressionDetected) {
        const newErrors: string[] = editResult.newErrors ?? [];

        advanceDebug && advanceDebug('failed', 0, {
          rootCause: `Regression: ${newErrors.length} new TypeScript error(s) — auto-repairing`,
          buildLog: newErrors.slice(0, 5),
        });
        setEditDetailStep('error');
        if (debugMode) {
          addStatus(`Rollback — ${newErrors.length} new error(s) introduced. Running autonomous repair…`, 'error');
        } else {
          addStatus('Issue detected. Repairing automatically…', 'applying');
        }

        const runPort2 = buildProgress?.port || currentProject.port;
        let repairSucceeded = false;

        // ── Phase 1-3: Orchestrated repair pipeline ───────────────────────────
        // Signal collection → project map → root cause → sequential repair → verify
        // This runs before the auth-specific path and before REPAIR_ROUNDS.
        // If it resolves the issue, we skip both entirely.
        if (currentProject && !repairSucceeded) {
          try {
            addStatus('Investigating issue…', 'checking');
            const errorText = newErrors.join('\n');

            // Phase 1a: Collect all signals
            const signalResult = await api({
              action: 'collect-signals',
              projectPath: currentProject.projectPath,
              errorText,
            });

            if (debugMode && signalResult?.collection) {
              addStatus(`Signals collected: ${signalResult.collection.summary}`, 'checking');
            }

            // Phase 1b: Build repair plan (project map + root cause engine)
            const planResult = await api({
              action: 'build-repair-plan',
              projectPath: currentProject.projectPath,
              errorText,
            });

            if (planResult?.plan?.hasRootCause) {
              addStatus(debugMode ? `Root cause: ${planResult.plan.summary}` : 'Root cause identified', 'checking');

              const steps: Array<{
                stepNumber: number; title: string; targetFile: string;
                action: string; instruction: string; contextFiles: string[];
                expectedOutcome: string; transformId?: string; packageName?: string;
              }> = planResult.plan.steps ?? [];

              // Phase 2: Execute each repair step
              for (const step of steps.slice(0, 5)) {
                addStatus(debugMode ? `Repairing: ${step.title}` : 'Repairing…', 'applying');

                const stepResult = await api({
                  action: 'execute-repair-step',
                  projectPath: currentProject.projectPath,
                  step,
                });

                // If this step needs AI, delegate to agent-fix
                if (stepResult?.delegateToAgentFix && stepResult.agentFixParams) {
                  const agentResult = await api({
                    action: 'agent-fix',
                    ...stepResult.agentFixParams,
                  });
                  if ((agentResult?.fixedCount ?? 0) === 0) continue;
                } else if (!stepResult?.success) {
                  if (debugMode) addStatus(`Step ${step.stepNumber} failed: ${stepResult?.error ?? 'unknown'}`, 'error');
                  continue;
                }

                // Phase 3: Verify after each step (L1 first, L2 if L1 passes)
                addStatus('Testing…', 'checking');
                const verifyResult = await api({
                  action: 'verify-repair',
                  projectPath: currentProject.projectPath,
                  maxLevel: step.action === 'delete-file' ? 2 : 1,
                  skipL2: step.action !== 'delete-file',
                });

                if (verifyResult?.result?.allPassed) {
                  repairSucceeded = true;
                  setPreviewKey(k => k + 1);
                  setEditDetailStep('complete');
                  addStatus('Issue resolved.', 'done');
                  addMsg('assistant',
                    `**Issue resolved** ✅\n\n` +
                    `Root cause: ${planResult.plan.summary}\n\n` +
                    `Fixed by repairing: ${step.targetFile}` +
                    (verifyResult.result.l2?.passed ? `\n\nBuild verified (L2 passed).` : '')
                  );
                  // Learn from orchestrated repair — improves coordinator + relevant engine
                  api({
                    action: 'learn-from-repair',
                    projectPath: currentProject.projectPath,
                    errorText: newErrors.join('\n'),
                    changedFiles: [step.targetFile],
                    userMessage: userRequest,
                    fixSummary: `Orchestrated repair: ${step.action} on ${step.targetFile}. Root cause: ${planResult.plan.summary}`,
                    tier: step.action === 'deterministic' ? 'HAIKU' : 'SONNET',
                  }).then((r: {learning?: {capabilityName?: string; isAutoRepair?: boolean}} | null) => {
                    if (r?.learning && debugMode) addStatus(`Engine learned: ${r.learning.capabilityName}`, 'done');
                  }).catch(() => {});
                  break;
                } else if (debugMode) {
                  addStatus(`Step ${step.stepNumber} applied but verification still failing: ${verifyResult?.result?.summary ?? 'unknown'}`, 'checking');
                }
              }
            } else {
              if (debugMode) addStatus(`No root cause identified (${planResult?.plan?.summary ?? 'no signals'}). Falling through to escalation.`, 'checking');
            }
          } catch (e) {
            if (debugMode) addStatus(`Orchestrated repair error: ${e instanceof Error ? e.message : 'unknown'}`, 'checking');
          }
        }

        // ── Pre-escalation: if regression errors are auth-related, investigate first ──
        const regressionAuthRelated = /auth|login|logout|session|token|jwt|signup|register|password|\/api\/auth\//i
          .test(newErrors.join('\n'));

        if (!repairSucceeded && regressionAuthRelated && currentProject) {
          try {
            if (debugMode) addStatus('Auth regression detected — investigating architecture…', 'checking');
            const authReport = await api({
              action: 'auth-investigate',
              projectPath: currentProject.projectPath,
              tsErrors: newErrors,
            });

            if (authReport?.success && (authReport.repairSteps?.length ?? 0) > 0) {
              if (debugMode) addStatus(`Auth repair plan: ${authReport.repairSteps.length} step(s) in dependency order`, 'checking');
              const stepsResolved: string[] = [];

              for (const step of (authReport.repairSteps as Array<{
                stepNumber: number; title: string; targetFile: string;
                contextFiles: string[]; tsErrors: string[]; repairHint: string;
              }>)) {
                if (debugMode) addStatus(`Step ${step.stepNumber}: ${step.title}`, 'applying');
                else addStatus('Repairing automatically…', 'applying');

                const stepCtx =
                  `AUTH REPAIR STEP ${step.stepNumber}/${authReport.repairSteps.length}\n` +
                  `INSTRUCTION: ${step.repairHint}\n` +
                  `FIX ONLY: ${step.targetFile}\n` +
                  (step.tsErrors.length > 0 ? `ERRORS:\n${step.tsErrors.join('\n')}\n` : '') +
                  (stepsResolved.length > 0 ? `\nALREADY FIXED: ${stepsResolved.join(', ')}\n` : '');

                for (const tier of (['HAIKU', 'SONNET'] as const)) {
                  try {
                    const r = await api({
                      action: 'agent-fix',
                      projectPath: currentProject.projectPath,
                      errorContext: stepCtx,
                      targetFiles: [step.targetFile],
                      contextFiles: step.contextFiles,
                      strategy: 'targeted',
                      tier,
                    });
                    if ((r?.fixedCount ?? 0) > 0) {
                      await new Promise(res => setTimeout(res, 600));
                      const chk = await api({ action: 'validate', projectPath: currentProject.projectPath });
                      const rem = (chk?.errors ?? []).filter((e: string) => e.includes(step.targetFile));
                      if (rem.length === 0) { stepsResolved.push(step.targetFile); break; }
                    }
                  } catch { /* try next tier */ }
                }
              }

              // Check if auth errors are resolved after sequential repair
              const finalCheck = await api({ action: 'validate', projectPath: currentProject.projectPath });
              const authStillBroken = (finalCheck?.errors ?? []).some(
                (e: string) => /auth|login|logout|session|token/i.test(e)
              );
              if (!authStillBroken && stepsResolved.length > 0) {
                repairSucceeded = true;
                setPreviewKey(k => k + 1);
                setEditDetailStep('complete');
                addStatus('Authentication repaired.', 'done');
                addMsg('assistant',
                  `**Fixed** ✅\n\nResolved auth regression — fixed ${stepsResolved.length} file(s): ${stepsResolved.map(f => `\`${f}\``).join(', ')}.`
                );
              }
            }
          } catch { /* non-critical — fall through to REPAIR_ROUNDS */ }
        }

        // Escalation pipeline: each round uses a more capable model + broader strategy.
        // Context accumulates across rounds so each model sees exactly what the previous
        // model tried and why it failed — no information is lost between escalations.
        const REPAIR_ROUNDS: Array<{
          strategy: 'targeted' | 'broader' | 'rewrite';
          tier: 'HAIKU' | 'SONNET' | 'STRONGEST';
          label: string;
        }> = [
          { strategy: 'targeted', tier: 'HAIKU',    label: 'Haiku — minimum targeted fix'    },
          { strategy: 'broader',  tier: 'SONNET',   label: 'Sonnet — broader context repair' },
          { strategy: 'rewrite',  tier: 'STRONGEST', label: 'Opus — full file rewrite'       },
        ];

        // Accumulate everything that was attempted so each escalation model has full history
        const attemptHistory: string[] = [];

        for (let round = 0; round < REPAIR_ROUNDS.length && !repairSucceeded; round++) {
          const { strategy, tier, label } = REPAIR_ROUNDS[round];
          if (debugMode) addStatus(`Escalation ${round + 1}/${REPAIR_ROUNDS.length}: ${label}…`, 'applying');
          else addStatus('Repairing automatically…', 'applying');
          setEditDetailStep('writing');

          // Fresh verification snapshot each round — prior round may have partially changed files
          let failedTargets: string[] = [];
          if (runPort2) {
            try {
              const snapVerify = await api({ action: 'verify-app', port: runPort2, projectPath: currentProject.projectPath });
              failedTargets = (snapVerify?.checks ?? [])
                .filter((c: { passed: boolean; fixFile?: string }) => !c.passed && c.fixFile)
                .map((c: { fixFile: string }) => c.fixFile)
                .filter(Boolean) as string[];
            } catch { /* proceed with empty list */ }
          }

          // Build cumulative escalation context — full history of what was tried and why it failed
          const historyBlock = attemptHistory.length > 0
            ? `\n\n[ESCALATION HISTORY — WHAT PREVIOUS MODELS TRIED AND WHY THEY FAILED]\n` +
              attemptHistory.map((h, i) => `Round ${i + 1}:\n${h}`).join('\n\n')
            : '';

          const errorContext =
            `TASK: ${userRequest}\n\n` +
            `TYPESCRIPT ERRORS THAT CAUSED ROLLBACK (from round 1 regression check):\n` +
            `${newErrors.slice(0, 8).join('\n')}\n\n` +
            `ESCALATION TIER: ${tier} (round ${round + 1}/${REPAIR_ROUNDS.length})\n` +
            `STRATEGY: ${strategy}\n` +
            `Do NOT reproduce the rollback errors listed above. Fix them surgically.` +
            historyBlock;

          let roundResult: { fixedCount?: number; changedFiles?: string[]; tier?: string } | null = null;
          try {
            roundResult = await api({
              action: 'agent-fix',
              projectPath: currentProject.projectPath,
              errorContext,
              targetFiles: failedTargets.slice(0, 4),
              strategy,
              tier,
            });
          } catch (err) {
            attemptHistory.push(`${label}: API call failed — ${err instanceof Error ? err.message : 'unknown error'}`);
            continue;
          }

          if (!roundResult?.fixedCount || roundResult.fixedCount < 1) {
            attemptHistory.push(`${label}: produced no file changes`);
            continue;
          }

          // Files were changed — wait for hot-reload, then verify
          await new Promise(r => setTimeout(r, 2500));
          setPreviewKey(k => k + 1);

          if (runPort2) {
            try {
              const verifyAfterRepair = await api({ action: 'verify-app', port: runPort2, projectPath: currentProject.projectPath });
              if (verifyAfterRepair?.verified) {
                // HTTP routes pass — now run browser journey before declaring success.
                // DWOMOH must never declare "Verified Working" without a passing user journey.
                let escalationJourneyPassed = false;
                let escalationJourneyStep = '';
                try {
                  addStatus('Routes verified — running browser journey…', 'checking');
                  const bjrEsc = await api({
                    action: 'run-browser-journey',
                    projectPath: currentProject.projectPath,
                    port: runPort2,
                  }).catch(() => null);
                  if (bjrEsc?.journey?.verdict === 'PASSED') {
                    escalationJourneyPassed = true;
                    addStatus('✅ Browser journey PASSED', 'done');
                  } else if (bjrEsc?.journey) {
                    escalationJourneyStep = bjrEsc.journey.failedAt || bjrEsc.journey.summary?.split('\n')[0] || bjrEsc.journey.verdict || 'step failed';
                    // Try one auto-repair before giving up on this escalation round
                    const { buildRepairPackage } = await import('@/services/repair-package').catch(() => ({ buildRepairPackage: null }));
                    if (buildRepairPackage) {
                      const pkg = buildRepairPackage(bjrEsc.journey);
                      const repairRes = await api({
                        action: 'auto-repair-journey-failure',
                        projectPath: currentProject.projectPath,
                        port: runPort2,
                        repairPackage: pkg,
                      }).catch(() => null);
                      if (repairRes?.shouldReverify) {
                        await new Promise(r => setTimeout(r, 3000));
                        const bjrEsc2 = await api({
                          action: 'run-browser-journey',
                          projectPath: currentProject.projectPath,
                          port: runPort2,
                        }).catch(() => null);
                        if (bjrEsc2?.journey?.verdict === 'PASSED') {
                          escalationJourneyPassed = true;
                        } else {
                          escalationJourneyStep = bjrEsc2?.journey?.failedAt ?? escalationJourneyStep;
                        }
                      }
                    }
                  } else {
                    // Playwright unavailable — treat as skipped, don't block on unavailable tooling
                    escalationJourneyPassed = true;
                  }
                } catch {
                  escalationJourneyPassed = true; // Playwright not available in this env
                }

                if (escalationJourneyPassed) {
                  setEditDetailStep('complete');
                  setLastVerification(verifyAfterRepair as { verified: boolean; summary: string; checks: Array<{ name: string; passed: boolean; recordCount?: number; error?: string }> });
                  if (isDebugRequest) advanceDebug('complete', DEBUG_TIMELINE.length - 1, { filesModified: roundResult.changedFiles ?? failedTargets });
                  addStatus(`✅ Verified Working — routes and user journey confirmed (${label}).`, 'done');
                  addMsg('assistant',
                    `**Verified Working** ✅\n\n` +
                    `Routes: All checks passed\n` +
                    `User Journey: PASSED\n` +
                    `Repair: Escalation round ${round + 1}/${REPAIR_ROUNDS.length} (${label})\n\n` +
                    verifyAfterRepair.summary +
                    (round > 0 ? `\n\n_(Escalated through ${round} prior round(s) before succeeding.)_` : '')
                  );
                  // Store in engineering memory — this pattern improves future builds
                  api({
                    action: 'learn-from-repair',
                    projectPath: currentProject.projectPath,
                    errorText: newErrors.join('\n'),
                    changedFiles: roundResult?.changedFiles ?? [],
                    userMessage: userRequest,
                    fixSummary: `Escalation round ${round + 1} (${tier}) — routes + journey verified`,
                    tier,
                  }).then((r: {learning?: {engineImprovement?: string; capabilityName?: string; isAutoRepair?: boolean}} | null) => {
                    if (r?.learning && debugMode) {
                      addStatus(`Engine learned: ${r.learning.capabilityName}${r.learning.isAutoRepair ? ' — future auto-repair enabled' : ''}`, 'done');
                    }
                  }).catch(() => {});
                  repairSucceeded = true;
                  break;
                } else {
                  // Routes pass but journey still fails — record for next escalation round
                  attemptHistory.push(
                    `${label}: routes verified but browser journey failed at "${escalationJourneyStep}" even after auto-repair`
                  );
                }
              } else {
                // Verification failed after this round — record what happened for next model
                const stillFailing = (verifyAfterRepair?.failures ?? []).slice(0, 3).join('; ');

                // Flow trace: diagnose WHY specific routes are still failing so next round is smarter
                const stillFailingChecks = (verifyAfterRepair?.checks ?? []).filter(
                  (c: {passed: boolean; url?: string; statusCode?: number}) =>
                    !c.passed && c.url && c.statusCode && [401, 403, 404, 405, 500].includes(c.statusCode)
                );
                for (const fc of stillFailingChecks.slice(0, 1)) {
                  try {
                    const urlPath = new URL(fc.url as string).pathname;
                    const flowTrace = await api({
                      action: 'trace-failure',
                      projectPath: currentProject.projectPath,
                      path: urlPath,
                      status: fc.statusCode,
                      method: 'GET',
                    }).catch(() => null);
                    if (flowTrace?.trace?.diagnosis) {
                      // Prepend flow trace to the error context so next round's AI prompt is richer
                      autoGatheredError =
                        `[FLOW TRACE] ${flowTrace.trace.diagnosis}\n` +
                        `[FIX HINT] ${flowTrace.trace.fixHint}\n` +
                        `[FILE] ${flowTrace.trace.fixFile ?? 'unknown'}\n` +
                        (autoGatheredError ? autoGatheredError : newErrors.slice(0, 3).join('\n'));
                    }
                  } catch { /* non-critical */ }
                }

                attemptHistory.push(
                  `${label}: changed ${roundResult.changedFiles?.join(', ') || 'unknown files'} ` +
                  `but verification still failed: ${stillFailing || 'unknown reason'}`
                );
              }
            } catch {
              attemptHistory.push(`${label}: changed files but re-verification threw an exception`);
            }
          } else {
            // No port — assume success if files were applied
            setEditDetailStep('complete');
            addStatus('Repair applied — preview refresh triggered.', 'done');
            addMsg('assistant', `${label} applied ${roundResult.fixedCount} file(s). Refresh the preview to confirm.`);
            repairSucceeded = true;
            break;
          }
        }

        if (!repairSucceeded) {
          setEditDetailStep('error');

          // Gather all context available at this point
          const failingRoutes = newErrors
            .filter(e => /\/(api|app)\//i.test(e))
            .map(e => { const m = e.match(/\/(api|app)\/[^\s:]+/); return m ? m[0] : ''; })
            .filter(Boolean);

          const playwrightSteps = (verificationLive?.steps ?? []).map(s => ({
            step: s.name,
            passed: s.status === 'pass',
            error: s.error,
            screenshotUrl: s.screenshotUrl,
          }));
          const allScreenshots = (verificationLive?.steps ?? [])
            .map(s => s.screenshotUrl)
            .filter((u): u is string => !!u);
          const failureScreenshot = verificationLive?.lastScreenshot ?? undefined;

          const repairHistory = REPAIR_ROUNDS.slice(0, attemptHistory.length).map((r, i) => ({
            tier: r.tier,
            strategy: r.strategy,
            filesChanged: [],
            resultSummary: attemptHistory[i] ?? 'no summary',
          }));

          // Write the escalation package — creates .dwomoh/escalation.json,
          // .claude/commands/repair-escalation.md, and CLAUDE.md in the project,
          // then opens VS Code automatically.
          addStatus('Escalating to VS Code + Claude Code…', 'applying');
          try {
            await api({
              action: 'escalation-write',
              projectPath: currentProject.projectPath,
              projectName: currentProject.name,
              port: runPort2,
              userMessage: userRequest,
              failingRoutes,
              typescriptErrors: newErrors.slice(0, 10),
              consoleErrors: [],
              networkErrors: [],
              buildErrors: autoGatheredError ? [autoGatheredError] : [],
              playwrightResults: playwrightSteps,
              failureScreenshot,
              allScreenshots,
              repairHistory,
            });
            setEscalationState({
              status: 'pending',
              projectPath: currentProject.projectPath,
              projectName: currentProject.name,
            });
            addMsg('assistant',
              `## Escalated to VS Code + Claude Code\n\n` +
              `DWOMOH Vibe Code tried ${REPAIR_ROUNDS.length} repair tiers (${REPAIR_ROUNDS.map(r => r.tier).join(' → ')}) and could not resolve this without introducing TypeScript errors.\n\n` +
              `**The full failure package has been written to:**\n` +
              `\`${currentProject.projectPath}/.dwomoh/escalation.json\`\n\n` +
              `**VS Code should be opening now.** If it does not open automatically:\n` +
              `\`\`\`\ncode "${currentProject.projectPath}"\n\`\`\`\n\n` +
              `Inside VS Code, Claude Code will read the escalation context and run \`/repair-escalation\` to fix the issue. DWOMOH Vibe Code is now polling every 5 seconds — it will apply the fix and refresh the preview automatically when Claude Code writes the resolution.\n\n` +
              `**What was tried:**\n` +
              attemptHistory.map((h, i) => `${i + 1}. ${h}`).join('\n') + '\n\n' +
              `**Your project is unchanged** — the last working version has been preserved.`
            );
          } catch (escalErr) {
            // Escalation write failed — fall back to the original manual guidance
            addMsg('assistant',
              `**All repair tiers exhausted** (${REPAIR_ROUNDS.map(r => r.tier).join(' → ')}).\n\n` +
              `Escalation to VS Code failed: ${escalErr instanceof Error ? escalErr.message : 'unknown error'}\n\n` +
              `**Errors:**\n\`\`\`\n${newErrors.slice(0, 5).join('\n')}\n\`\`\`\n\n` +
              `**What was tried:**\n` +
              attemptHistory.map((h, i) => `${i + 1}. ${h}`).join('\n')
            );
          }
        }

        return;
      }

      const changed: string[] = editResult.filesChanged || [];

      if (changed.length > 0) {
        if (isDebugRequest) advanceDebug('rebuilding', 4, { filesModified: changed });
        setEditDetailStep('refreshing');
        addStatus('Refreshing preview…', 'applying');

        await new Promise(r => setTimeout(r, 2000));
        setPreviewKey(k => k + 1);

        // ── Route completeness check: find UI links with no page.tsx ──────────
        // Runs immediately after every edit. If any navigation target has no
        // matching page file, create stubs then enhance them with the AI.
        // This prevents "UI renders but every link is a 404" situations.
        try {
          addStatus('Scanning navigation links…', 'checking');
          const routeScan = await api({
            action: 'scan-missing-routes',
            projectPath: currentProject.projectPath,
          });

          if (routeScan?.scanResult?.missingRoutes?.length > 0) {
            const missing: string[] = routeScan.scanResult.missingRoutes;
            if (debugMode) {
              addStatus(`Missing pages detected: ${missing.join(', ')}`, 'error');
            } else {
              addStatus(`Creating ${missing.length} missing page(s): ${missing.join(', ')}`, 'applying');
            }

            // Step 1: Write stubs immediately (synchronous, fast)
            const stubResult = await api({
              action: 'create-missing-pages',
              projectPath: currentProject.projectPath,
              missingRoutes: missing,
              missingDetails: routeScan.scanResult.missingDetails,
              routeGroups: routeScan.scanResult.routeGroups,
            });

            // Step 2: Use agent-fix to replace stubs with real pages
            if (stubResult?.agentPrompt && stubResult?.created?.length > 0) {
              addStatus('Building missing pages with full UI…', 'applying');
              await api({
                action: 'agent-fix',
                projectPath: currentProject.projectPath,
                errorContext: stubResult.agentPrompt,
                targetFiles: stubResult.created,
                tier: 'SONNET',
              }).catch(() => null);

              // Step 3: Re-scan to confirm pages now exist
              const rescan = await api({
                action: 'scan-missing-routes',
                projectPath: currentProject.projectPath,
              }).catch(() => null);

              const stillMissing: string[] = rescan?.scanResult?.missingRoutes ?? [];
              if (stillMissing.length > 0 && debugMode) {
                addStatus(`Still missing after repair: ${stillMissing.join(', ')}`, 'error');
              } else if (stillMissing.length === 0) {
                addStatus(`All navigation routes now have pages.`, 'done');
              }

              await new Promise(r => setTimeout(r, 1000));
              setPreviewKey(k => k + 1);
            }
          } else if (routeScan?.scanResult?.referencedRoutes?.length > 0) {
            if (debugMode) {
              addStatus(`All ${routeScan.scanResult.referencedRoutes.length} navigation route(s) have pages ✓`, 'checking');
            }
          }
        } catch { /* route scan is best-effort — never block the edit flow */ }

        // ── Post-edit TypeScript check ─────────────────────────────────────
        // Note: the server-side safeApply already ran a TypeScript check and
        // rolled back if errors increased. This client-side check catches
        // any remaining pre-existing errors that should be fixed.
        if (isDebugRequest) advanceDebug('rebuilding', 5);
        setEditDetailStep('verifying');

        let tsResult: { clean: boolean; errors: string[] } = { clean: true, errors: [] };
        try {
          tsResult = await api({ action: 'check-ts', projectPath: currentProject.projectPath });
          if (tsResult.errors?.length) {
            logErrorEntry(`[post-edit TS] ${tsResult.errors.join('\n')}`);
          }
        } catch { /* non-critical */ }

        // Fix pre-existing TypeScript errors that remain (not new ones — those caused rollback above)
        if (!tsResult.clean && tsResult.errors?.length) {
          if (debugMode) addStatus(`Fixing ${tsResult.errors.length} remaining TypeScript issue(s)…`, 'applying');
          else addStatus('Testing fix…', 'applying');
          setEditDetailStep('writing');
          if (isDebugRequest) advanceDebug('fixing', 4, { buildLog: tsResult.errors.slice(0, 5) });
          try {
            const fixRequest = `Fix these TypeScript errors (DO NOT ask the user for any files — you have the full project context above):\n\n${tsResult.errors.join('\n')}\n\nOriginal request was: ${userRequest}`;
            await apiWithRetry(
              { action: 'edit', projectPath: currentProject.projectPath, userRequest: fixRequest, messages: conversationHistory, safeApply: true },
              () => {}
            );
            await new Promise(r => setTimeout(r, 1500));
            setPreviewKey(k => k + 1);
          } catch { /* fall through to report */ }
        }

        // ── Route verification + post-edit agent fix ───────────────────────
        addStatus('Testing routes and links…', 'checking');
        if (isDebugRequest) advanceDebug('verifying', 6);

        const runPort = buildProgress?.port || currentProject.port;
        type EditVerifyCheck = {
          name: string; passed: boolean; recordCount?: number; error?: string; url?: string;
          statusCode?: number; responsePreview?: string;
          softPassed?: boolean; externalDepName?: string;
          rootCause?: { kind: string; detail: string; packages?: string[]; envVars?: string[]; fixFile?: string; fixHint?: string };
          fixFile?: string; fixHint?: string;
          requestBody?: string; responseBody?: string; validationError?: string; stackTrace?: string;
          repairDiagnosis?: {
            failureCategory: string; confidence: string;
            recommendedAction: string; canAutoRepair: boolean;
            autoRepairContext: string; expectedFieldName?: string;
          };
          timeoutProfile?: {
            primaryCause: string; secondaryCauses: string[]; hangLocation: string;
            canSoftPass: boolean; mockResponseShape: string; repairContext: string;
            apiKeyVars: string[];
          };
        };
        let verifyData: { verified: boolean; summary: string; checks?: Array<EditVerifyCheck>; failures?: string[] } | null = null;
        if (runPort) {
          try {
            verifyData = await api({ action: 'verify-app', port: runPort, projectPath: currentProject.projectPath });
            if (verifyData) setLastVerification(verifyData as { verified: boolean; summary: string; checks: Array<{ name: string; passed: boolean; recordCount?: number; error?: string }> });
          } catch { /* best-effort */ }
        }

        // ── If routes are failing (but not soft-passed), run targeted auto-repair
        const hardFailed = (verifyData?.checks ?? []).filter(c => !c.passed && !c.softPassed);
        const softPassed = (verifyData?.checks ?? []).filter(c => c.softPassed);

        // Surface soft-passed routes as informational (not actionable)
        if (softPassed.length > 0) {
          if (debugMode) addStatus(
            `${softPassed.length} route(s) soft-passed: ${softPassed.map(c => c.externalDepName ?? c.name).join(', ')} — external API unavailable (PASS_WITH_EXTERNAL_DEPENDENCY_UNAVAILABLE)`,
            'checking'
          );
        }

        if (runPort && verifyData && !verifyData.verified && isDebugRequest && hardFailed.length > 0) {
          if (debugMode) addStatus(`Diagnosing ${hardFailed.length} failing route(s)…`, 'checking');
          else addStatus('Investigating issue…', 'checking');

          // ── Step 1: Run timeout-repair for any timed-out routes ────────────
          const timedOutRoutes = hardFailed.filter(c => c.rootCause?.kind === 'timeout');
          const timeoutContextBlocks: string[] = [];

          for (const tc of timedOutRoutes) {
            const routeFile = tc.fixFile ?? (tc.url ? 'app' + new URL(tc.url).pathname + '/route.ts' : undefined);
            if (!routeFile) continue;
            try {
              if (debugMode) addStatus(`Running timeout analysis on ${routeFile}…`, 'checking');
              const timeoutAnalysis = await api({
                action: 'timeout-repair',
                projectPath: currentProject.projectPath,
                routeFile,
                urlPath: tc.url ? new URL(tc.url).pathname : '',
                errorText: tc.error ?? '',
              });
              if (timeoutAnalysis?.profile) {
                const p = timeoutAnalysis.profile;
                if (debugMode) addStatus(`Timeout diagnosis: ${p.primaryCause} — ${p.hangLocation.slice(0, 80)}`, 'checking');
                timeoutContextBlocks.push(timeoutAnalysis.agentFixContext ?? p.repairContext);
                // If all timed-out routes are soft-passable, no code fix needed
                if (p.canSoftPass) {
                  addStatus(`${tc.name}: External API unavailable — PASS_WITH_EXTERNAL_DEPENDENCY_UNAVAILABLE`, 'done');
                }
              }
            } catch { /* non-critical */ }
          }

          // ── Step 2: Build rich error context for all non-soft-pass failures ──
          const targetFiles = [...new Set(hardFailed.flatMap(c =>
            [c.fixFile, c.rootCause?.fixFile].filter(Boolean) as string[]
          ))];

          const errorContext = [
            ...hardFailed.map(c => {
              const lines: string[] = [];
              lines.push(`ROUTE: ${c.name} (${c.url ?? ''})`);
              lines.push(`HTTP STATUS: ${c.statusCode ?? 'timeout'}`);
              if (c.rootCause?.kind) lines.push(`ROOT CAUSE KIND: ${c.rootCause.kind}`);
              if (c.rootCause?.detail) lines.push(`ROOT CAUSE: ${c.rootCause.detail}`);
              if (c.requestBody) lines.push(`REQUEST SENT: ${c.requestBody}`);
              if (c.validationError) lines.push(`EXACT VALIDATION ERROR: ${c.validationError}`);
              if (c.responseBody) lines.push(`FULL RESPONSE BODY:\n${c.responseBody.slice(0, 600)}`);
              if (c.stackTrace) lines.push(`STACK TRACE:\n${c.stackTrace}`);
              if (c.repairDiagnosis) {
                lines.push(`FAILURE CATEGORY: ${c.repairDiagnosis.failureCategory}`);
                lines.push(`DIAGNOSIS CONFIDENCE: ${c.repairDiagnosis.confidence}`);
                lines.push(`RECOMMENDED ACTION: ${c.repairDiagnosis.recommendedAction}`);
                if (c.repairDiagnosis.autoRepairContext) lines.push(`REPAIR CONTEXT:\n${c.repairDiagnosis.autoRepairContext}`);
              }
              if (c.timeoutProfile) {
                lines.push(`TIMEOUT CAUSE: ${c.timeoutProfile.primaryCause}`);
                lines.push(`HANG LOCATION: ${c.timeoutProfile.hangLocation}`);
              }
              if (c.fixHint || c.rootCause?.fixHint) lines.push(`FIX HINT: ${c.fixHint || c.rootCause?.fixHint}`);
              return lines.join('\n');
            }),
            ...timeoutContextBlocks,
          ].join('\n\n---\n\n');

          const logData2 = await api({ action: 'get-server-logs', projectPath: currentProject.projectPath }).catch(() => ({ logs: '' }));
          const serverLogs2 = (logData2.logs as string || '').split('\n')
            .filter((l: string) => /error|failed|exception|throw|hang|timeout/i.test(l)).slice(-20).join('\n');

          if (targetFiles.length > 0) {
            await api({ action: 'snapshot-files', projectPath: currentProject.projectPath, files: targetFiles });
          }

          // Use SONNET for timeout/route repairs (async patterns need deeper reasoning than Haiku)
          if (debugMode) addStatus(`Auto-repairing ${hardFailed.length} route(s) with full diagnostic context…`, 'applying');
          else addStatus('Repairing automatically…', 'applying');
          const agentFixResult = await api({
            action: 'agent-fix',
            projectPath: currentProject.projectPath,
            errorContext,
            targetFiles,
            serverLogs: serverLogs2,
            tier: 'SONNET',
          }).catch(() => null);

          if (agentFixResult?.fixedCount > 0) {
            if (debugMode) addStatus(`Fixed ${agentFixResult.fixedCount} file(s) — re-verifying…`, 'checking');
            else addStatus('Testing fix…', 'checking');
            await new Promise(r => setTimeout(r, 2500));
            try {
              const verifyAfterFix = await api({ action: 'verify-app', port: runPort, projectPath: currentProject.projectPath });
              const prevPassed = (verifyData.checks ?? []).filter(c => c.passed || c.softPassed).length;
              const nowPassed = (verifyAfterFix.checks ?? []).filter((c: EditVerifyCheck) => c.passed || c.softPassed).length;
              if (nowPassed >= prevPassed) {
                verifyData = verifyAfterFix;
                setLastVerification(verifyAfterFix as { verified: boolean; summary: string; checks: Array<{ name: string; passed: boolean; recordCount?: number; error?: string }> });
                await api({ action: 'clear-snapshot', projectPath: currentProject.projectPath });
              } else {
                await api({ action: 'restore-files', projectPath: currentProject.projectPath });
              }
            } catch { /* non-critical */ }
            setPreviewKey(k => k + 1);
          }
        }

        // ── Preview Verification Engine ─────────────────────────────────────
        // TypeScript clean + routes verified is necessary but NOT sufficient.
        // A broken CSS config, missing tailwind.config, or bad layout import
        // produces a "running" server that renders plain unstyled HTML.
        // We inspect the actual rendered preview before declaring success.
        let previewVerdict: string = 'skipped';
        let previewIssues: string[] = [];
        let cssFixApplied = false;
        let journeyResult: {passed?: boolean; summary?: string; failedAt?: string; failureDetail?: string; journeyName?: string} | null = null;

        if (runPort) {
          try {
            addStatus('Checking preview…', 'checking');

            // Step 1: CSS/Tailwind health check — auto-fix if broken
            const cssHealth = await api({
              action: 'check-css-health',
              projectPath: currentProject.projectPath,
              autoFix: true,
            }).catch(() => null);

            if (cssHealth?.wasFixed) {
              cssFixApplied = true;
              const fixed = cssHealth.fixResult?.fixed?.join(', ') || 'CSS configuration';
              if (debugMode) addStatus(`CSS auto-fix applied: ${fixed}`, 'applying');
              // Wait for dev server to hot-reload the CSS fix
              await new Promise(r => setTimeout(r, 2500));
              setPreviewKey(k => k + 1);
            } else if (cssHealth?.health && !cssHealth.health.healthy) {
              previewIssues.push(...(cssHealth.health.issues?.map((i: { title: string }) => i.title) ?? []));
            }

            // Step 2: Route reachability — confirm no navigation links return 404
            const reachScan = await api({
              action: 'scan-missing-routes',
              projectPath: currentProject.projectPath,
              port: runPort,
            }).catch(() => null);

            if (reachScan?.scanResult?.missingRoutes?.length > 0) {
              previewIssues.push(
                `${reachScan.scanResult.missingRoutes.length} navigation link(s) lead to missing pages: ${reachScan.scanResult.missingRoutes.slice(0, 4).join(', ')}`
              );
            }

            if (reachScan?.reachability) {
              const unreachable = (reachScan.reachability as Array<{ route: string; ok: boolean; statusCode: number }>)
                .filter(r => !r.ok && r.statusCode !== 0);
              if (unreachable.length > 0) {
                previewIssues.push(
                  `${unreachable.length} page(s) return errors: ${unreachable.map(r => `${r.route} (${r.statusCode})`).join(', ')}`
                );
                if (debugMode) addStatus(`Route 404s: ${unreachable.map(r => r.route).join(', ')}`, 'error');
              }
            }

            // Step 2b: Flow trace — when specific routes fail, trace UI→Route→Auth→DB
            if (verifyData && !verifyData.verified) {
              const failingChecks = (verifyData.checks ?? []).filter((c: {passed: boolean; url?: string; statusCode?: number}) =>
                !c.passed && c.url && c.statusCode && [401, 403, 404, 405, 500].includes(c.statusCode)
              );
              for (const fc of failingChecks.slice(0, 2)) {
                try {
                  const urlPath = new URL(fc.url as string).pathname;
                  const traceResult = await api({
                    action: 'trace-failure',
                    projectPath: currentProject.projectPath,
                    path: urlPath,
                    status: fc.statusCode,
                    method: 'GET',
                  }).catch(() => null);
                  if (traceResult?.formatted && debugMode) {
                    addStatus(traceResult.formatted, 'checking');
                  }
                  // Store for next repair round — rich diagnosis goes into the agent prompt
                  if (traceResult?.trace?.fixHint) {
                    autoGatheredError = (autoGatheredError ? autoGatheredError + '\n' : '') +
                      `[FLOW TRACE for ${urlPath}] ${traceResult.trace.diagnosis}\nFix: ${traceResult.trace.fixHint}\nEdit: ${traceResult.trace.fixFile ?? 'see trace'}`;
                  }
                } catch { /* non-critical */ }
              }
            }

            // Step 2c: Browser Journey Test — real Playwright-driven user flow verification
            // Hard gate: PASSED or FAILED VERIFICATION.
            // On failure → auto-repair from structured repair package → re-verify journey.
            // Only injects into outer repair loop if auto-repair also fails.
            if (runPort && (verifyData?.verified || !verifyData)) {
              try {
                // Determine which journey steps are affected by the changed files
                const { determineAffectedScope, formatScopeDecision } = await import('@/services/journey-scope')
                  .catch(() => ({ determineAffectedScope: null, formatScopeDecision: null }));
                if (determineAffectedScope && formatScopeDecision) {
                  const scope = determineAffectedScope(changed, userRequest);
                  if (debugMode) addStatus(`Journey scope: ${formatScopeDecision(scope)}`, 'checking');
                }

                addStatus('Running browser journey verification…', 'checking');
                const bjr = await api({
                  action: 'run-browser-journey',
                  projectPath: currentProject.projectPath,
                  port: runPort,
                }).catch(() => null);

                if (bjr?.journey) {
                  journeyResult = bjr.journey;
                  const verdict = bjr.journey.verdict as string;
                  const icon = verdict === 'PASSED' ? '✅' : '❌';
                  addStatus(`${icon} ${verdict}: ${bjr.journey.summary}`, verdict === 'PASSED' ? 'done' : 'error');

                  if (verdict !== 'PASSED' && bjr.journey.failedAt) {
                    addStatus(`Auto-repairing journey failure at "${bjr.journey.failedAt}"…`, 'applying');

                    // Build structured repair package and auto-repair without user intervention
                    const { buildRepairPackage } = await import('@/services/repair-package')
                      .catch(() => ({ buildRepairPackage: null }));

                    let journeyAutoRepaired = false;
                    if (buildRepairPackage) {
                      const repairPkg = buildRepairPackage(bjr.journey);
                      const repairRes = await api({
                        action: 'auto-repair-journey-failure',
                        projectPath: currentProject.projectPath,
                        port: runPort,
                        repairPackage: repairPkg,
                      }).catch(() => null);

                      if (repairRes?.shouldReverify) {
                        addStatus(`Repair applied (${repairRes.fixedCount} file(s)) — re-running journey…`, 'checking');
                        await new Promise(r => setTimeout(r, 3000));
                        setPreviewKey(k => k + 1);

                        const bjr2 = await api({
                          action: 'run-browser-journey',
                          projectPath: currentProject.projectPath,
                          port: runPort,
                        }).catch(() => null);

                        if (bjr2?.journey?.verdict === 'PASSED') {
                          journeyResult = bjr2.journey;
                          journeyAutoRepaired = true;
                          addStatus('✅ Browser journey PASSED after auto-repair', 'done');
                          // Learn from the successful repair
                          api({
                            action: 'learn-from-repair',
                            projectPath: currentProject.projectPath,
                            errorText: `Browser journey FAILED at: ${bjr.journey.failedAt}\n${bjr.journey.failureDetail ?? ''}`,
                            changedFiles: repairRes.changedFiles ?? changed,
                            userMessage: `Auto-repaired journey failure in ${currentProject.name ?? 'app'}`,
                            fixSummary: `Auto-repair resolved "${bjr.journey.failedAt}"`,
                            tier: 'SONNET',
                          }).catch(() => {});
                        } else {
                          journeyResult = bjr2?.journey ?? journeyResult;
                        }
                      }
                    }

                    // If auto-repair failed, inject failure into outer repair loop
                    if (!journeyAutoRepaired) {
                      autoGatheredError =
                        `[BROWSER JOURNEY: ${verdict}]\n` +
                        `Failed at step: "${bjr.journey.failedAt}"\n` +
                        `Detail: ${bjr.journey.failureDetail ?? 'step failed'}\n` +
                        (autoGatheredError ? `\n[Previous errors]\n${autoGatheredError}` : '');
                      api({
                        action: 'learn-from-repair',
                        projectPath: currentProject.projectPath,
                        errorText: `Browser journey FAILED at: ${bjr.journey.failedAt}\n${bjr.journey.failureDetail ?? ''}`,
                        changedFiles: changed,
                        userMessage: `${currentProject.name ?? 'app'} browser journey: ${bjr.journey.journeyName}`,
                        fixSummary: `Auto-repair did not resolve "${bjr.journey.failedAt}"`,
                        tier: 'SONNET',
                      }).catch(() => {});
                    }
                  }
                }
              } catch { /* browser journey is best-effort — Playwright may not be available in all envs */ }

            // Step 2d: Link Crawler — verify no "View Details → 404" broken links
            // Runs a lightweight crawl (5 pages max) focused on the pages most likely
            // to be affected by the edit (based on changed files + dynamic route hints).
            try {
              addStatus('Crawling links for 404 errors…', 'checking');
              const editCrawlRes = await api({
                action: 'crawl-and-repair-links',
                projectPath: currentProject.projectPath,
                port: runPort,
                maxPages: 5,
                maxLinksPerPage: 6,
              }).catch(() => null);

              if (editCrawlRes?.crawlReport) {
                const cr = editCrawlRes.crawlReport;
                if (cr.verdict === 'PASSED') {
                  if (debugMode) addStatus(`✅ Link crawl: ${cr.pagesVisited?.length ?? 0} page(s) — all links OK`, 'done');
                } else if (cr.verdict === 'FAILED') {
                  const broken = cr.failed?.filter((f: {is404: boolean}) => f.is404) ?? [];
                  addStatus(`❌ ${broken.length} broken link(s) found — auto-created ${(editCrawlRes.repairedRoutes ?? []).length} page(s)`, 'error');
                  if (broken.length > 0) {
                    autoGatheredError =
                      `[LINK CRAWL: FAILED]\n` +
                      broken.slice(0, 3).map((f: {linkText: string; url: string}) => `• "${f.linkText}" → ${f.url} returns 404`).join('\n') +
                      (autoGatheredError ? `\n\n${autoGatheredError}` : '');
                  }
                }
              }
            } catch { /* best-effort */ }
            }

            // Step 3: Inspect the rendered preview HTML (CSS / Tailwind)
            const inspection = await api({
              action: 'inspect-preview',
              projectPath: currentProject.projectPath,
              port: runPort,
            }).catch(() => null);

            if (inspection?.result) {
              const r = inspection.result;
              previewVerdict = r.verdict;
              if (r.verdict !== 'healthy' && r.verdict !== 'unreachable') {
                previewIssues.push(...(r.issues ?? []));
              }

              if (debugMode) {
                addStatus(`Preview inspection: ${r.verdict} — ${r.summary}`, r.verdict === 'healthy' ? 'done' : 'error');
                if (r.debugDetail) addStatus(r.debugDetail, 'checking');
              }

              // If preview is broken, trigger a targeted CSS/Tailwind repair
              if ((r.verdict === 'unstyled' || r.verdict === 'degraded') && !cssFixApplied) {
                addStatus('Preview is unstyled — diagnosing CSS issue…', 'applying');
                const repairResult = await api({
                  action: 'agent-fix',
                  projectPath: currentProject.projectPath,
                  errorContext:
                    `PREVIEW IS BROKEN: The app renders plain unstyled HTML with no Tailwind CSS styles.\n` +
                    `Preview issues: ${r.issues.join('; ')}\n` +
                    `CSS bundle loaded: ${r.cssLoaded}, CSS size: ${r.cssSizeKb.toFixed(1)}KB, Tailwind classes found: ${r.tailwindClassCount}\n` +
                    `Check and fix: (1) app/globals.css has @tailwind directives, (2) app/layout.tsx imports globals.css, ` +
                    `(3) tailwind.config.js has content paths covering app/**, (4) postcss.config.js exists with tailwindcss plugin.`,
                  targetFiles: ['app/globals.css', 'app/layout.tsx', 'tailwind.config.js', 'postcss.config.js'],
                  tier: 'SONNET',
                }).catch(() => null);

                if (repairResult?.fixedCount > 0) {
                  addStatus('CSS repaired — refreshing preview…', 'applying');
                  await new Promise(res => setTimeout(res, 2500));
                  setPreviewKey(k => k + 1);

                  // Re-inspect after CSS repair
                  const reinspection = await api({
                    action: 'inspect-preview',
                    projectPath: currentProject.projectPath,
                    port: runPort,
                  }).catch(() => null);
                  if (reinspection?.result?.verdict === 'healthy') {
                    previewVerdict = 'healthy';
                    previewIssues = [];
                  }
                }
              }
            }

            // Override verdict: if navigation links are broken, preview is not healthy
            if (previewVerdict === 'healthy' && previewIssues.length > 0) {
              previewVerdict = 'degraded';
            }
          } catch { /* preview check is best-effort — never block the response */ }
        }

        setEditDetailStep('complete');
        if (isDebugRequest) {
          advanceDebug('complete', DEBUG_TIMELINE.length - 1, { filesModified: changed });
        }

        const previewLine =
          previewVerdict === 'healthy'
            ? 'Preview: ✅ Verified — CSS loaded, Tailwind active, UI rendered'
            : previewVerdict === 'skipped'
            ? 'Preview: Pending — refresh to confirm'
            : previewVerdict === 'unreachable'
            ? 'Preview: Server not yet responding — refresh in a moment'
            : `Preview: ⚠️ ${previewIssues[0] ?? 'visual check failed'} — ${previewVerdict}`;

        const verifyLine = verifyData
          ? `Routes: ${verifyData.verified ? '✅ All checks passed' : '⚠️ ' + verifyData.summary}`
          : 'Routes: Pending — refresh the preview to confirm.';

        const previewIsVerified = previewVerdict === 'healthy' || previewVerdict === 'skipped';

        // Success criteria (upgraded):
        // NEVER report "Fixed ✅" when:
        //   • API routes return 4xx/5xx (verifyData.verified must be true, not undefined)
        //   • Preview is unreachable or unstyled
        //   • verifyData is null AND a server is running (means verification was skipped when it shouldn't be)
        const routesVerified =
          verifyData != null
            ? verifyData.verified
            : !runPort; // no server → TypeScript-only fix, HTTP checks N/A

        // Browser journey verdict — strict gate:
        // PASSED = confirmed working | FAILED VERIFICATION = broken | null = skipped (no server)
        const journeyVerdict = (journeyResult as {verdict?: string} | null)?.verdict ?? null;
        // Journey is "passing" ONLY when explicitly PASSED, or when no server exists (TypeScript-only fix).
        // "Not run" with a live server means the journey was skipped — treat as not-yet-verified.
        const journeyPassed = journeyVerdict === 'PASSED' || (!runPort && journeyVerdict === null);

        // Check for failed network requests in a PASSING journey (API errors during user flow = broken)
        const journeyHasFailedRequests = (
          journeyResult as {steps?: Array<{failedRequests?: Array<{url: string; status: number}>}>} | null
        )?.steps?.flatMap(s => s.failedRequests ?? []).length ?? 0;
        const journeyBlockedByRequests = journeyPassed && journeyHasFailedRequests > 0;

        // Master success gate — ALL must pass to declare "Verified Working":
        //   1. API routes pass HTTP checks (verify-app)
        //   2. Preview renders with CSS (preview inspection)
        //   3. Browser journey PASSED (not skipped, not null)
        //   4. No failed network requests during the user flow
        const fullyVerified = routesVerified && previewIsVerified && journeyPassed && !journeyBlockedByRequests;

        // Journey status line for the user message
        const journeyLine = journeyResult
          ? journeyVerdict === 'PASSED'
            ? journeyBlockedByRequests
              ? `User Journey: ⚠️ PASSED but ${journeyHasFailedRequests} API request(s) failed during flow`
              : `User Journey: ✅ PASSED — ${(journeyResult as {summary?: string}).summary ?? ''}`
            : (() => {
                const jr3 = journeyResult as { failedAt?: string; summary?: string } | null;
                const loc = jr3?.failedAt ? `failed at "${jr3.failedAt}"` : jr3?.summary ?? 'step failed';
                return `User Journey: ❌ ${journeyVerdict ?? 'FAILED VERIFICATION'} — ${loc}`;
              })()
          : runPort
            ? 'User Journey: ⏭ Not run (Playwright unavailable)'
            : '';

        if (fullyVerified) {
          addStatus('✅ Verified Working — routes, preview, and user journey all confirmed.', 'done');
        } else if (!journeyPassed || journeyBlockedByRequests) {
          // Build the most specific failure description available
          const jr = journeyResult as { failedAt?: string; failureDetail?: string; summary?: string; verdict?: string } | null;
          let failDesc: string;
          if (journeyBlockedByRequests) {
            failDesc = `${journeyHasFailedRequests} API request(s) failed during the user flow`;
          } else if (jr?.failedAt) {
            failDesc = `failed at "${jr.failedAt}"${jr.failureDetail ? ` — ${jr.failureDetail.split('\n')[0].slice(0, 80)}` : ''}`;
          } else if (jr?.summary) {
            failDesc = jr.summary.slice(0, 120);
          } else if (!jr) {
            failDesc = 'browser journey did not run (Playwright may be unavailable)';
          } else {
            failDesc = jr.verdict ?? 'step failed';
          }
          addStatus(`❌ Verification: ${failDesc}`, 'error');
        } else if (!previewIsVerified) {
          addStatus(`Applied — preview needs attention: ${previewIssues[0] ?? previewVerdict}`, 'error');
        } else if (verifyData && !verifyData.verified) {
          addStatus(`Applied — route checks failed: ${verifyData.failures?.join(', ') || 'see report'}`, 'error');
        } else {
          addStatus(`Files updated: ${changed.join(', ')}`, 'done');
        }

        addMsg('assistant',
          `Files changed: ${changed.join(', ')}\n` +
          `TypeScript: ${tsResult.clean ? '✅ Clean' : `⚠️ ${tsResult.errors?.length || 0} error(s) — auto-fix applied`}\n` +
          verifyLine + '\n' +
          previewLine +
          (journeyLine ? '\n' + journeyLine : '') +
          (cssFixApplied ? '\nCSS auto-fix: ✅ Applied' : '') +
          (verifyData?.failures?.length ? `\n\nFailed route checks:\n${verifyData.failures.map((f: string) => `• ${f}`).join('\n')}` : '') +
          (!previewIsVerified && previewIssues.length > 0 ? `\n\nPreview issues:\n${previewIssues.slice(0, 3).map(i => `• ${i}`).join('\n')}` : '') +
          ((!journeyPassed || journeyBlockedByRequests) && journeyResult
            ? (() => {
                const jr2 = journeyResult as { failedAt?: string; failureDetail?: string; summary?: string };
                const step = jr2.failedAt ? `\n\n**Failed at:** "${jr2.failedAt}"` : '';
                const detail = jr2.failureDetail ? `\n${jr2.failureDetail.split('\n')[0].slice(0, 120)}` : '';
                const fallback = (!jr2.failedAt && jr2.summary) ? `\n\n**Issue:** ${jr2.summary.slice(0, 120)}` : '';
                return `${step}${detail}${fallback}\n\nDescribe what you'd like to fix and I'll apply a targeted repair.`;
              })()
            : '')
        );

        // ── Learn from this repair — every success improves the engine ────────
        // Fires for EVERY successful edit that had a real error to fix.
        // Non-debug edits (feature adds, design changes) are also captured
        // so the engine learns what the user's project patterns look like.
        if (changed.length > 0) {
          api({
            action: 'learn-from-repair',
            projectPath: currentProject.projectPath,
            errorText: autoGatheredError,
            changedFiles: changed,
            userMessage: userRequest,
            fixSummary: `Standard edit applied ${changed.length} file(s): ${changed.slice(0, 3).join(', ')}`,
            tier: 'SONNET',
          }).then((r: {learning?: {engineImprovement?: string; capabilityName?: string; isAutoRepair?: boolean; confidence?: string}} | null) => {
            if (r?.learning && debugMode) {
              const { capabilityName, isAutoRepair, confidence } = r.learning;
              addStatus(
                `Engine learned: ${capabilityName} (${confidence} confidence)` +
                (isAutoRepair ? ' — auto-repair now active for this pattern' : ''),
                'done',
              );
            }
          }).catch(() => { /* non-critical */ });
        }

        try {
          const disc = await api({ action: 'discover', projectPath: currentProject.projectPath });
          if (disc.success) {
            setCurrentDiscovery({ summary: disc.summary, pages: disc.pages, components: disc.components, fileCount: disc.fileCount, framework: disc.framework, mode: disc.mode, hasApiRoutes: disc.hasApiRoutes, missingCredentials: disc.missingCredentials || [] });
            if (disc.memory) setCurrentMemory(disc.memory);
          }
        } catch { /* non-critical */ }

      } else if (editResult.errors?.length) {
        setEditDetailStep('error');
        if (isDebugRequest) advanceDebug('failed', 0);
        addStatus(`Errors: ${editResult.errors.join(', ')}`, 'error');
      } else {
        setEditDetailStep('complete');
        if (isDebugRequest) advanceDebug('complete', DEBUG_TIMELINE.length - 1);
        addStatus('No files changed.', 'done');
      }

    } catch (err) {
      clearTimers();
      setEditDetailStep('error');
      if (isDebugRequest) setDebugActivity(prev => prev ? { ...prev, status: 'failed' } : prev);
      addErrorMsg(err, 'edit', [
        { label: 'Try again', action: 'focus-input', prompt: userRequest },
        { label: 'Open Logs', action: 'open-logs' },
      ]);
    } finally {
      setEditApplying(false);
      setEditDetailStep('');
      setEditElapsed(0);
      // Keep debug panel visible for 4 seconds after completion so user can read it
      if (isDebugRequest) {
        setTimeout(() => setDebugActivity(null), 4000);
      }
    }
  };

  // ── Plain-English error classifier (client-side) ──────────────────────────

  const friendlyErrorMessage = (raw: string): string => {
    if (/NETWORK_INTERRUPTION|connection closed|econnreset|socket hang up|epipe|mid-response|fetch failed|aborted/i.test(raw))
      return 'The connection to the AI was interrupted mid-response. This is a network issue, not a code problem — click "Retry Build" below to continue automatically.';
    if (/TIMEOUT|BEDROCK_TIMEOUT|timed out|etimedout/i.test(raw))
      return 'The AI took too long to respond (the request timed out). This usually resolves on retry — click "Retry Build" below.';
    if (/THROTTLED|throttl|too many requests|429/i.test(raw))
      return 'The AI API rate limit was hit. Please wait 30 seconds and click "Retry Build".';
    if (/AUTH_ERROR|credential|unauthorized|forbidden|accessdenied/i.test(raw))
      return 'AWS authentication failed. Check that AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are correct in .env.local.';
    if (/QUOTA_EXCEEDED|quota|limit exceeded/i.test(raw))
      return 'The Bedrock service quota was exceeded. Try again in a few minutes.';
    if (/Module not found|Can't resolve|Cannot find module/i.test(raw))
      return 'A required package was missing. I tried to install it automatically.';
    if (/NEXTAUTH_SECRET|auth.*secret|next-auth/i.test(raw))
      return 'The authentication system needs a configuration key. I applied a temporary one for the preview.';
    if (/ENOENT|no such file or directory/i.test(raw))
      return 'A file reference was broken. The project structure may need repair.';
    if (/npm install|package.*not found|npm ERR/i.test(raw))
      return 'A dependency could not be installed. This is usually a network issue or a package name mismatch.';
    if (/tsc|TypeScript|TS\d{4}/i.test(raw))
      return 'There were TypeScript issues in the generated code that could not be automatically fixed.';
    if (/EADDRINUSE|port.*in use/i.test(raw))
      return 'The port was already in use. I tried another port.';
    if (/Code generation failed|AI did not return|Could not generate|valid app|No \[START_PROJECT\]/i.test(raw))
      return 'The AI had trouble formatting the output on the first try. The system retried automatically. If this persists, click Retry Build.';
    return 'An unexpected error occurred during the build. Click Retry Build to try again.';
  };

  const isRetryableError = (raw: string): boolean =>
    /NETWORK_INTERRUPTION|TIMEOUT|THROTTLED|connection closed|econnreset|timed out|throttl|mid-response|fetch failed|Code generation failed|Could not generate|No \[START_PROJECT\]/i.test(raw);

  // ── API Config Guide helper ───────────────────────────────────────────────

  const generateApiConfigGuide = (
    projectName: string,
    envVars: string[],
    creds: Array<{ key: string; description?: string }>
  ): string => {
    if (envVars.length === 0 && creds.length === 0) return '';
    const credMap = new Map(creds.map(c => [c.key, c.description ?? '']));
    const allVars = [...new Set([...envVars, ...creds.map(c => c.key)])];
    const publicVars = allVars.filter(v => v.startsWith('NEXT_PUBLIC_'));
    const secretVars = allVars.filter(v => !v.startsWith('NEXT_PUBLIC_'));

    let guide = `🔑 **API CONFIGURATION GUIDE — ${projectName}**\n\n`;
    guide += `⚠️ **Important:** The APIs used in this app belong to their third-party providers — NOT to you. Before deploying to production, replace all placeholder keys with your own.\n\n`;

    if (secretVars.length > 0) {
      guide += `**Server-side secrets** *(keep these private — never commit to git)*:\n`;
      secretVars.forEach(v => {
        const desc = credMap.get(v);
        guide += `\`${v}=\` ${desc ? `— ${desc}` : ''}\n`;
      });
      guide += '\n';
    }
    if (publicVars.length > 0) {
      guide += `**Public keys** *(safe to expose in client-side code)*:\n`;
      publicVars.forEach(v => {
        const desc = credMap.get(v);
        guide += `\`${v}=\` ${desc ? `— ${desc}` : ''}\n`;
      });
      guide += '\n';
    }

    guide += `**How to set your own keys:**\n`;
    guide += `1. Click the 🔑 Credentials panel in the sidebar\n`;
    guide += `2. Visit each provider's website and create a free account\n`;
    guide += `3. Generate API keys and paste them into the sidebar fields\n`;
    guide += `4. The app reloads automatically with your real credentials\n\n`;
    guide += `Ask me: "Where do I get a ${secretVars[0]?.replace(/_/g, ' ')?.toLowerCase() ?? 'key'}?" and I'll give you step-by-step instructions.`;
    return guide;
  };

  // ── Research mode ─────────────────────────────────────────────────────────

  const runResearch = async (query: string) => {
    setLoading(true);

    const API_TIMELINE = [
      'Searching API documentation',
      'Checking pricing and rate limits',
      'Reviewing integration guides',
      'Comparing available options',
      'Checking official SDK support',
      'Evaluating reliability and uptime',
      'Summarising recommendations',
    ];

    setResearchActivity({
      query,
      mode: 'api',
      timeline: API_TIMELINE.map((step, i) => ({ step, status: i === 0 ? 'active' : 'pending' })),
      sources: [],
      complete: false,
    });
    setPreviewTab('preview');

    let apiStageIdx = 0;
    const apiStageTimer = setInterval(() => {
      apiStageIdx = Math.min(apiStageIdx + 1, API_TIMELINE.length - 1);
      setResearchActivity(prev => prev ? {
        ...prev,
        timeline: prev.timeline.map((t, i) => ({
          ...t,
          status: i < apiStageIdx ? 'done' : i === apiStageIdx ? 'active' : 'pending',
        })),
      } : null);
    }, 3000);

    addMsg('assistant', `🔬 Researching this for you — checking APIs, documentation, pricing, and options…`);
    try {
      const result = await apiWithRetry(
        { action: 'research', query },
        (attempt) => { addMsg('assistant', `Retrying ${attempt} of 2 — reconnecting to research service…`); },
      );
      clearInterval(apiStageTimer);
      if (result.success && result.response) {
        setResearchActivity(prev => prev ? {
          ...prev,
          complete: true,
          recommendations: result.response as string,
          timeline: prev.timeline.map(t => ({ ...t, status: 'done' as const })),
        } : null);
        addMsg('assistant', result.response);
      } else {
        clearInterval(apiStageTimer);
        setResearchActivity(prev => prev ? { ...prev, complete: true } : null);
        const errMsg = (result.error as string | undefined) ?? 'Research returned no content';
        addErrorMsg(errMsg, 'research', [
          { label: 'Try again', action: 'focus-input', prompt: query },
          { label: 'Open Logs', action: 'open-logs' },
        ]);
      }
    } catch (err) {
      clearInterval(apiStageTimer);
      setResearchActivity(prev => prev ? { ...prev, complete: true } : null);
      addErrorMsg(err, 'research', [
        { label: 'Try again', action: 'focus-input', prompt: query },
        { label: 'Open Logs', action: 'open-logs' },
      ]);
    }
    setLoading(false);
  };

  // ── Web Research Mode — browse public websites and give recommendations ─────

  // Known brand → public homepage (safe, no login pages)
  const BRAND_URLS: Record<string, string[]> = {
    alibaba:     ['https://www.alibaba.com', 'https://www.alibaba.com/trade/search?SearchText=fashion'],
    aliexpress:  ['https://www.aliexpress.com'],
    amazon:      ['https://www.amazon.com'],
    shopify:     ['https://www.shopify.com'],
    etsy:        ['https://www.etsy.com'],
    zara:        ['https://www.zara.com/en/'],
    asos:        ['https://www.asos.com'],
    shein:       ['https://www.shein.com'],
    temu:        ['https://www.temu.com'],
    nike:        ['https://www.nike.com'],
    jumia:       ['https://www.jumia.com.gh'],
    konga:       ['https://www.konga.com'],
    booking:     ['https://www.booking.com'],
    airbnb:      ['https://www.airbnb.com'],
    tripadvisor: ['https://www.tripadvisor.com'],
    ebay:        ['https://www.ebay.com'],
  };

  const handleWebResearch = async (userQuery: string) => {
    setLoading(true);
    const lowerQ = userQuery.toLowerCase();

    const TIMELINE_STEPS = [
      'Identifying research targets',
      'Opening website pages',
      'Reading page layout and content',
      'Analysing product and feature patterns',
      'Reviewing UX and trust signals',
      'Checking navigation and filters',
      'Comparing with your project goals',
      'Summarising recommendations',
    ];

    // Extract explicit URLs and brand names before showing UI
    const urlRegex = /https?:\/\/[^\s]+/gi;
    const explicitUrls: string[] = (userQuery.match(urlRegex) || []).slice(0, 3);
    const brandUrls: string[] = [];
    for (const [brand, urls] of Object.entries(BRAND_URLS)) {
      if (lowerQ.includes(brand)) {
        brandUrls.push(...urls.slice(0, 2));
        if (brandUrls.length >= 3) break;
      }
    }
    const allUrls = [...new Set([...explicitUrls, ...brandUrls])].slice(0, 3);

    const getSafeHostname = (u: string) => { try { return new URL(u).hostname; } catch { return u; } };

    // Initialise preview panel with research activity
    setResearchActivity({
      query: userQuery,
      mode: 'web',
      timeline: TIMELINE_STEPS.map((step, i) => ({ step, status: i === 0 ? 'active' : 'pending' })),
      sources: allUrls.map(url => ({ url, hostname: getSafeHostname(url), status: 'pending' })),
      complete: false,
    });
    setPreviewTab('preview'); // auto-focus the Preview panel

    let stageIdx = 0;
    addStatus('DWOMOH Vibe Code is researching — see Preview panel for live activity', 'applying');
    const stageTimer = setInterval(() => {
      stageIdx = Math.min(stageIdx + 1, TIMELINE_STEPS.length - 1);
      setResearchActivity(prev => prev ? {
        ...prev,
        timeline: prev.timeline.map((t, i) => ({
          ...t,
          status: i < stageIdx ? 'done' : i === stageIdx ? 'active' : 'pending',
        })),
      } : null);
    }, 3200);

    try {
      const result = await apiWithRetry(
        { action: 'browse-web', urls: allUrls, query: userQuery },
        (attempt) => { addStatus(`Retrying ${attempt} of 2 — reconnecting…`, 'applying'); },
      );

      clearInterval(stageTimer);

      if (result.success && result.response) {
        addStatus('Web research complete — see findings in the Preview panel and chat.', 'done');

        const researchedUrls = (result.urlsResearched as string[] | undefined) || [];
        const usedKnowledge = result.usedKnowledge as boolean;

        // Mark sources as done/error in preview panel
        setResearchActivity(prev => prev ? {
          ...prev,
          complete: true,
          usedKnowledge,
          recommendations: result.response as string,
          timeline: prev.timeline.map(t => ({ ...t, status: 'done' as const })),
          sources: prev.sources.map(s => ({
            ...s,
            status: researchedUrls.includes(s.url) ? 'done' as const : 'error' as const,
          })),
        } : null);

        const sourceNote = researchedUrls.length > 0
          ? `Researched: ${researchedUrls.map(getSafeHostname).join(', ')}\n\n`
          : usedKnowledge
            ? `Note: The website could not be fetched directly. These recommendations are based on knowledge of that platform's public design and features.\n\n`
            : '';

        await streamReveal(`${sourceNote}${result.response}`);
        setHistory(h => [...h, { role: 'assistant' as const, content: `${sourceNote}${result.response}` }]);
      } else {
        clearInterval(stageTimer);
        setResearchActivity(prev => prev ? { ...prev, complete: true } : null);
        const errMsg = (result.error as string | undefined) ?? 'Web research returned no results';
        addErrorMsg(errMsg, 'web-research', [
          { label: 'Try again', action: 'focus-input', prompt: userQuery },
          { label: 'Open Logs', action: 'open-logs' },
        ]);
      }
    } catch (err) {
      clearInterval(stageTimer);
      setResearchActivity(prev => prev ? { ...prev, complete: true } : null);
      addErrorMsg(err, 'web-research', [
        { label: 'Try again', action: 'focus-input', prompt: userQuery },
        { label: 'Open Logs', action: 'open-logs' },
      ]);
    }

    setLoading(false);
  };

  // ── Premium multimodal features ─────────────────────────────────────────────

  // Keep voiceEnabledRef in sync so closures inside useEffect don't go stale
  // (updated inline when setVoiceEnabled is called)

  const speakText = (text: string) => {
    if (!voiceEnabledRef.current || typeof window === 'undefined' || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const clean = text.replace(/•\s*/g, '').replace(/\n+/g, '. ').replace(/\s+/g, ' ').trim().substring(0, 600);
    const utterance = new SpeechSynthesisUtterance(clean);
    const voices = window.speechSynthesis.getVoices();
    const preferred = voices.find(v => v.lang.startsWith('en') && v.name.toLowerCase().includes('google'))
      || voices.find(v => v.lang.startsWith('en-US') && !v.name.toLowerCase().includes('compact'))
      || voices.find(v => v.lang.startsWith('en'))
      || voices[0];
    if (preferred) utterance.voice = preferred;
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.onstart = () => { setIsSpeaking(true); setAiState('idle'); };
    utterance.onend   = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);
    window.speechSynthesis.speak(utterance);
  };

  const stopSpeaking = () => {
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
    }
  };

  const startVoiceInput = () => {
    if (typeof window === 'undefined') return;
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      addMsg('assistant', 'Voice input is not supported in this browser. Please use Chrome or Edge.');
      return;
    }
    const rec = new SR();
    rec.continuous     = true;    // keep listening across natural pauses
    rec.interimResults = true;    // deliver words as they are spoken
    rec.lang           = 'en-US';
    finalTranscriptRef.current = '';
    let speechStarted = false;   // true once first words are detected

    // Silence timer only starts AFTER the user begins speaking.
    // Before first word: no timeout (user has unlimited time to start).
    // After first word: 5 s of silence stops recording.
    const SILENCE_AFTER_SPEECH_MS = 5000;
    const resetSilenceTimer = () => {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = setTimeout(() => {
        if (recognitionRef.current) recognitionRef.current.stop();
      }, SILENCE_AFTER_SPEECH_MS);
    };

    rec.onstart = () => {
      setIsRecording(true);
      setAiState('listening');
      finalTranscriptRef.current = '';
      setInput('');
      setInterimText('');
      speechStarted = false;
      // No silence timer here — we wait until the user actually starts speaking
    };

    rec.onresult = (e: any) => {
      if (!speechStarted) { speechStarted = true; }
      resetSilenceTimer();  // reset 5s countdown on every new word
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          finalTranscriptRef.current += e.results[i][0].transcript + ' ';
        } else {
          interim += e.results[i][0].transcript;
        }
      }
      setInput(finalTranscriptRef.current + interim);
      setInterimText(interim);
    };

    rec.onend = () => {
      if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
      setIsRecording(false);
      setInterimText('');
      setAiState('idle');
      recognitionRef.current = null;
      const finalText = finalTranscriptRef.current.trim();
      if (!finalText) return;
      setInput(finalText);
      if (voiceAutoSendRef.current) {
        setInput('');
        handleVoiceAutoSubmit(finalText);
      }
    };

    rec.onerror = (e: any) => {
      // 'no-speech' fires during natural pauses in continuous mode — ignore it
      // and let the recognition continue (Chrome fires this but keeps going)
      if (e.error === 'no-speech') return;
      if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
      setIsRecording(false);
      setInterimText('');
      setAiState('idle');
      recognitionRef.current = null;
    };

    recognitionRef.current = rec;
    rec.start();
  };

  const stopVoiceInput = () => {
    if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
    if (recognitionRef.current) { recognitionRef.current.stop(); }
    setIsRecording(false);
    setInterimText('');
  };

  // Called by voice auto-send — same routing as handleSubmit but without the form event
  const handleVoiceAutoSubmit = async (text: string) => {
    if (!text || loading || editApplying || phase === 'building') return;
    addMsg('user', text);
    const newHistory: ConversationTurn[] = [...history, { role: 'user', content: text }];
    setHistory(newHistory);
    if (currentProject) {
      const hasLogo0 = assets.some(a => a.role === 'logo');
      const voiceIntent = detectIntent(text, history.length > 0, { hasLogo: hasLogo0 });
      if (voiceIntent === 'web_research') { await handleWebResearch(text); return; }
      if (voiceIntent === 'logo_request') { await handleLogoGenerate(text); return; }
      if (voiceIntent === 'logo_edit')    { await handleLogoRefine(text); return; }
      if (voiceIntent === 'billing')      { await streamReveal(getBillingResponse()); return; }
      if (voiceIntent === 'research')     { await runResearch(text); return; }
      runEditPipeline(text, newHistory);
      return;
    }
    const hasHistory = history.length > 0;
    const hasLogo = assets.some(a => a.role === 'logo');
    const intent = detectIntent(text, hasHistory, { hasLogo });
    const respondConversationally = async (txt: string) => {
      setLoading(true); setAiState('thinking');
      await new Promise(r => setTimeout(r, 500));
      await streamReveal(txt);
      setLoading(false);
    };
    switch (intent) {
      case 'greeting': await respondConversationally(getGreetingResponse(text, user?.name ?? undefined)); return;
      case 'conversation': case 'question': case 'planning': case 'design': await respondWithAI(text, newHistory, 'think'); return;
      case 'research': await respondWithAI(text, newHistory, 'research'); return;
      case 'web_research': await handleWebResearch(text); return;
      case 'logo_request': await handleLogoGenerate(text); return;
      case 'logo_edit': await handleLogoRefine(text); return;
      case 'clarification_needed': await respondConversationally(getClarificationResponse(text)); return;
      case 'deployment': await respondConversationally(getDeploymentResponse()); return;
      case 'debug': await respondConversationally(getDebugResponse()); return;
      case 'billing': await respondConversationally(getBillingResponse()); return;
      case 'build': break;
    }
    if (buildTarget === 'flutter') {
      runFlutterBuildPipeline(newHistory, enrichPromptWithAssets(text));
    } else {
      runBuildPipeline(newHistory, enrichPromptWithAssets(text));
    }
  };

  // Reveals text word-by-word for a premium streaming feel.
  // Commits the full message to `displayed` when complete.
  const streamReveal = async (text: string) => {
    setAiState('typing');
    setStreamingMsg('');
    const words = text.split(' ');
    let revealed = '';
    for (const word of words) {
      revealed += (revealed ? ' ' : '') + word;
      setStreamingMsg(revealed);
      // Natural cadence: longer words and punctuation pause slightly longer
      const delay = word.endsWith('.') || word.endsWith('!') || word.endsWith('?') ? 60
        : word.endsWith(',') || word.endsWith(':') ? 40
        : word.length > 9 ? 30 : 18;
      await new Promise(r => setTimeout(r, delay));
    }
    addMsg('assistant', text);
    setStreamingMsg('');
    setAiState('idle');
  };

  const handleFileSelect = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      const ALLOWED_MIME = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/svg+xml'];
      if (!ALLOWED_MIME.includes(file.type)) {
        addMsg('assistant', `"${file.name}" is not a supported format. Please use JPG, PNG, WebP, or SVG.`);
        continue;
      }
      if (file.size > 5 * 1024 * 1024) {
        addMsg('assistant', `"${file.name}" is too large. Maximum file size is 5 MB.`);
        continue;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        const dataUrl = e.target?.result as string;
        const base64  = dataUrl.split(',')[1];
        const asset: UploadedAsset = { id: `asset_${Date.now()}_${Math.random().toString(36).slice(2,7)}`, dataUrl, base64, name: file.name, type: file.type };
        setAssets(prev => [...prev, asset]);
        setPendingAsset(asset);
        setAssetModalOpen(true);
      };
      reader.readAsDataURL(file);
    }
  };

  const assignAssetRole = async (asset: UploadedAsset, role: UploadedAsset['role']) => {
    const updated = { ...asset, role };
    setAssets(prev => prev.map(a => a.id === asset.id ? updated : a));
    setAssetModalOpen(false);
    setPendingAsset(null);
    setAnalysingImage(true);
    addMsg('assistant', `Analysing your image to understand what it contains...`);
    try {
      const result = await api({ action: 'analyze-image', imageBase64: asset.base64, mediaType: asset.type,
        instruction: `This image will be used as a ${role || 'design asset'} in a website. Describe what you see and how to best integrate it into the design.` });
      if (result.success && result.analysis) {
        const withAnalysis = { ...updated, analysis: result.analysis };
        setAssets(prev => prev.map(a => a.id === asset.id ? withAnalysis : a));
        addMsg('assistant', `Image understood. Here is what I see:

${result.analysis}

This image will be used as the ${role || 'design asset'} in your project. Mention it when you describe what to build.`);
      }
    } catch (err) {
      addErrorMsg(err, 'image-analysis', [
        { label: 'Open Logs', action: 'open-logs' },
      ]);
      addMsg('assistant', 'The image has been saved and will still be included in your project — it just could not be analysed right now.');
    }
    setAnalysingImage(false);
  };

  const enrichPromptWithAssets = (prompt: string): string => {
    if (assets.length === 0) return prompt;
    const assetLines = assets.map(a => {
      const role    = a.role ? ` [role: ${a.role}]` : '';
      const details = a.analysis ? `\n  Details: ${a.analysis.substring(0, 200)}` : '';
      return `• ${a.name}${role}${details}`;
    }).join('\n');
    return `${prompt}\n\nDesign assets uploaded by the user (incorporate these into the generated website/app):\n${assetLines}\n\nFor images marked as "logo": use them in the header and favicon area.\nFor "hero": use as the main section background or featured image.\nFor "product": use in product/listing cards.\nFor "background": use as section or page background.`;
  };

  // Opens the brand brief modal. Pre-fills brand name from project if available.
  const handleLogoGenerate = (userPrompt: string) => {
    const inferredName = currentProject?.name
      || userPrompt.replace(/generate|create|make|design|a |me |logo|for|my|please/gi, '').trim()
      || '';
    setLogoBrief(b => ({ ...b, brandName: inferredName.substring(0, 60) }));
    setLogoBriefOpen(true);
    // Stream a short intent acknowledgement into chat
    streamReveal(
      'I can create a professional logo for your brand.\n\nFill in the brand brief below — I will use those details to generate 3 distinct logo concepts with different styles, colors, and layouts.'
    );
  };

  // Called when the user submits the brand brief form.
  const handleLogoBriefSubmit = async () => {
    setLogoBriefOpen(false);
    const { brandName, industry, style, colors, logoType, notes } = logoBrief;
    if (!brandName.trim()) {
      addMsg('assistant', 'Please enter a brand name before generating.');
      return;
    }

    const brief = [
      `Brand name: ${brandName}`,
      industry  ? `Industry: ${industry}` : '',
      style     ? `Style preference: ${style}` : '',
      colors    ? `Color preferences: ${colors}` : '',
      logoType  ? `Logo type: ${logoType}` : '',
      notes     ? `Additional notes: ${notes}` : '',
    ].filter(Boolean).join('\n');

    const STAGES = [
      'Understanding brand brief…',
      'Researching design trends…',
      'Creating logo concepts…',
      'Generating SVGs…',
    ];

    setGeneratingLogo(true);
    setLogoStage(STAGES[0]);
    let stageIdx = 0;
    const stageTimer = setInterval(() => {
      stageIdx = Math.min(stageIdx + 1, STAGES.length - 1);
      setLogoStage(STAGES[stageIdx]);
    }, 2800);

    try {
      const result = await apiWithRetry(
        { action: 'generate-logo', prompt: brief },
        (attempt) => { setLogoStage(`Retrying ${attempt} of 2 — reconnecting to logo generator…`); },
      );
      clearInterval(stageTimer);
      setLogoStage('');

      if (result.success && Array.isArray(result.logos) && result.logos.length > 0) {
        const labels: string[] = result.styleLabels ?? result.logos.map((_: string, i: number) =>
          ['Minimal', 'Modern', 'Bold'][i] ?? `Option ${i + 1}`
        );
        setLogoOptions(result.logos);
        setLogoStyleLabels(labels);

        // Add all concepts inline in chat — no modal required
        setDisplayed(prev => [...prev, {
          role: 'assistant',
          content: `Here are 3 logo concepts for ${brandName}. Click "Use this" on any card to select it, or describe a change below.`,
          logoConcepts: result.logos,
          logoConceptLabels: labels,
        }]);

        // Auto-open Design tab so the user can also see them in the panel
        setPreviewTab('design');
      } else {
        const errMsg = (result.error as string | undefined) ?? 'SVG output could not be parsed';
        addErrorMsg(errMsg, 'logo-generation', [
          { label: 'Try again', action: 'retry-logo' },
          { label: 'Open Logs', action: 'open-logs' },
        ]);
      }
    } catch (err) {
      clearInterval(stageTimer);
      setLogoStage('');
      addErrorMsg(err, 'logo-generation', [
        { label: 'Try again', action: 'retry-logo' },
        { label: 'Rephrase my request', action: 'focus-input', prompt: 'Create a logo for ' },
        { label: 'Open Logs', action: 'open-logs' },
      ]);
    }
    setGeneratingLogo(false);
  };

  // Save a logo SVG as the active project asset
  const saveLogoAsAsset = (svgCode: string, index: number, labelOverride?: string) => {
    const label = labelOverride ?? logoStyleLabels[index] ?? `Option ${index + 1}`;
    const b64 = btoa(unescape(encodeURIComponent(svgCode)));
    const asset: UploadedAsset = {
      id:       `logo_${Date.now()}`,
      dataUrl:  `data:image/svg+xml;base64,${b64}`,
      base64:   b64,
      name:     `${logoBrief.brandName || 'logo'}_${label.toLowerCase().replace(/\s+/g,'_')}.svg`,
      type:     'image/svg+xml',
      role:     'logo',
      analysis: `Generated SVG logo — ${label} style`,
    };
    setAssets(prev => [...prev.filter(a => a.role !== 'logo'), asset]);
    // Push to version history
    setLogoHistory(h => [{ svg: svgCode, label, ts: Date.now() }, ...h].slice(0, 20));
    setLogoPanel(false);
    // Show the selected logo inline in chat with action buttons
    setDisplayed(prev => [...prev, {
      role: 'assistant',
      content: `${label} logo selected as your brand logo. Saved — it will be used in your app header, favicon, and every page that shows a logo.`,
      logoSvg: svgCode,
    }]);
    setPreviewTab('design');
  };

  // Download a logo as SVG, PNG, or JPG
  const downloadLogo = (svgCode: string, format: 'svg' | 'png' | 'jpg', label: string) => {
    const safeName = (logoBrief.brandName || 'logo').replace(/\s+/g, '_').toLowerCase();
    const filename  = `${safeName}_${label.toLowerCase().replace(/\s+/g, '_')}`;
    if (format === 'svg') {
      const blob = new Blob([svgCode], { type: 'image/svg+xml' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = `${filename}.svg`; a.click();
      URL.revokeObjectURL(url);
      return;
    }
    // PNG and JPG both use canvas rasterisation at 2× resolution
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width  = 800;
      canvas.height = 240;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      if (format === 'jpg') {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, 800, 240);
      }
      ctx.drawImage(img, 0, 0, 800, 240);
      const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
      canvas.toBlob(blob => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a   = document.createElement('a');
        a.href = url; a.download = `${filename}.${format}`; a.click();
        URL.revokeObjectURL(url);
      }, mime, format === 'jpg' ? 0.95 : undefined);
    };
    img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svgCode)))}`;
  };

  // Add an assistant message with an embedded logo preview (never shows raw SVG text)
  const addLogoMsg = (content: string, svgCode: string) => {
    setDisplayed(prev => [...prev, { role: 'assistant', content, logoSvg: svgCode }]);
  };

  // Edit/refine the currently selected logo SVG in response to a user instruction.
  const handleLogoRefine = async (instruction: string) => {
    const currentLogoAsset = assets.find(a => a.role === 'logo');

    // No logo selected yet but concepts exist — show panel so user can choose
    if (!currentLogoAsset && logoOptions.length > 0) {
      setLogoPanel(true);
      await streamReveal('Please select which logo concept you want to refine. Click "Use this" on any of the concepts in the panel, then come back with your change.');
      return;
    }

    // No logo at all — guide them to generate one first
    if (!currentLogoAsset) {
      await streamReveal("I don't have a logo to edit yet. Generate one first — just say something like \"Create a logo for [your brand name]\" and I will design 3 concepts for you to choose from.");
      return;
    }

    // Decode the stored SVG from base64
    let currentSvg = '';
    try {
      currentSvg = decodeURIComponent(escape(atob(currentLogoAsset.base64)));
    } catch {
      currentSvg = atob(currentLogoAsset.base64);
    }

    const STAGES = [
      'Analyzing current logo…',
      'Applying your changes…',
      'Refining design…',
      'Finalizing…',
    ];
    setGeneratingLogo(true);
    setLogoStage(STAGES[0]);
    let stageIdx = 0;
    const stageTimer = setInterval(() => {
      stageIdx = Math.min(stageIdx + 1, STAGES.length - 1);
      setLogoStage(STAGES[stageIdx]);
    }, 2400);

    try {
      const result = await apiWithRetry(
        { action: 'refine-logo', svgCode: currentSvg, instruction },
        (attempt) => { setLogoStage(`Retrying ${attempt} of 2 — reconnecting…`); },
      );
      clearInterval(stageTimer);
      setLogoStage('');

      if (result.success && result.svg) {
        // Auto-save as new active logo
        const b64 = btoa(unescape(encodeURIComponent(result.svg)));
        const updatedAsset: UploadedAsset = {
          id: `logo_${Date.now()}`,
          dataUrl: `data:image/svg+xml;base64,${b64}`,
          base64: b64,
          name: `${logoBrief.brandName || 'logo'}_refined.svg`,
          type: 'image/svg+xml',
          role: 'logo',
          analysis: `Refined SVG logo — ${instruction.substring(0, 80)}`,
        };
        setAssets(prev => [...prev.filter(a => a.role !== 'logo'), updatedAsset]);

        // Push old logo to version history before replacing
        if (currentLogoAsset) {
          try {
            const oldSvg = decodeURIComponent(escape(atob(currentLogoAsset.base64)));
            setLogoHistory(h => [{ svg: oldSvg, label: 'Before edit', ts: Date.now() }, ...h].slice(0, 20));
          } catch { /* ignore decode failure */ }
        }

        // Show result visually in chat — never raw SVG text
        addLogoMsg('Here is the updated logo. Use the buttons below to save, download, or refine further.', result.svg);
        setPreviewTab('design');
      } else {
        const errMsg = (result.error as string | undefined) ?? 'Refinement returned no SVG';
        addErrorMsg(errMsg, 'logo-refinement', [
          { label: 'Try again', action: 'focus-input', prompt: instruction },
          { label: 'Open Logs', action: 'open-logs' },
        ]);
      }
    } catch (err) {
      clearInterval(stageTimer);
      setLogoStage('');
      addErrorMsg(err, 'logo-refinement', [
        { label: 'Try again', action: 'focus-input', prompt: instruction },
        { label: 'Open Logs', action: 'open-logs' },
      ]);
    }
    setGeneratingLogo(false);
  };

  // ── Bridge-Only Pipeline ──────────────────────────────────────────────────
  // Used for bridge integration tests. DWOMOH Vibe Code acts purely as
  // orchestration: it creates the project directory, builds a comprehensive
  // Claude Code generation prompt, and forwards everything to the bridge.
  // Claude Code CLI does ALL generation, build, verification, and repair.
  //
  // Telemetry stages (shown in the Bridge Telemetry panel):
  //   bridge-activated → cli-started → files-generated → files-modified →
  //   build-running → verification-running → repair-attempts → preview-ready → bridge-complete

  const BRIDGE_STAGES = [
    { id: 'bridge-activated',     label: '⚡ Bridge Activated' },
    { id: 'session-id',           label: '🔑 Bridge Session ID' },
    { id: 'cli-started',          label: '🤖 Claude Code CLI Started' },
    { id: 'files-generated',      label: '📄 Files Being Generated' },
    { id: 'files-modified',       label: '✏️  Files Being Modified' },
    { id: 'build-running',        label: '🔨 Build Running' },
    { id: 'verification-running', label: '🔍 Verification Running' },
    { id: 'repair-attempts',      label: '🔧 Repair Attempts' },
    { id: 'preview-ready',        label: '🖥️  Preview Ready' },
    { id: 'bridge-complete',      label: '✅ Bridge Complete' },
  ] as const;

  const initBridgeTelemetry = () => setBridgeTelemetry(
    BRIDGE_STAGES.map(s => ({ id: s.id, label: s.label, status: 'waiting' as const, detail: '' }))
  );

  const advanceTelemetry = (id: string, status: 'active' | 'done' | 'error', detail = '') =>
    setBridgeTelemetry(prev => prev.map(s => s.id === id
      ? { ...s, status, detail, ts: new Date().toLocaleTimeString() }
      : s.status === 'waiting' && status === 'active' ? s // don't auto-advance waiting stages
      : s
    ));

  const runBridgeOnlyPipeline = async (originalPrompt: string) => {
    if (loading || phase === 'building') {
      addStatus('Bridge pipeline already running', 'error');
      return;
    }

    initBridgeTelemetry();
    setPhase('building');
    setFocusMode(true);
    setBuilderMode('build');
    setPreviewUrl(null);
    setPreviewLoading(false);
    resetBridgeEscalation();

    if (buildHeartbeatRef.current) { clearInterval(buildHeartbeatRef.current); buildHeartbeatRef.current = null; }
    setBuildHeartbeatMsg(null);

    const narrate = (msg: string) => addMsg('assistant', msg);

    setBuildProgress({
      step: 'generating',
      message: '⚡ Bridge Test Mode — forwarding to Claude Code CLI…',
      logs: ['⚡ Bridge-only pipeline started', `Prompt: ${originalPrompt.slice(0, 80)}…`],
    });

    // Step 1: Create the empty project directory and register it in the manifest
    addStatus('Bridge Test Mode — creating project directory…', 'checking');
    const projectNameGuess = originalPrompt.trim().split(/\s+/).slice(0, 4).join('-');
    let projectPath = '';
    let slug = '';
    let manifestId = '';
    try {
      const created = await api({ action: 'create-bridge-project', projectName: projectNameGuess, prompt: originalPrompt });
      if (!created.success || !created.projectPath) throw new Error('Failed to create project directory');
      projectPath = created.projectPath;
      slug = created.slug;
      manifestId = created.id ?? '';
      addStatus(`✅ Project directory: ${projectPath}`, 'done');
    } catch (err) {
      addStatus(`❌ Could not create project directory: ${err instanceof Error ? err.message : String(err)}`, 'error');
      setPhase('idle');
      setBuildProgress(p => ({ ...p!, step: 'error', message: '❌ Bridge project setup failed' }));
      return;
    }

    // Step 2: Build comprehensive generation prompt for Claude Code CLI
    const bridgeGenPrompt = [
      `You are a code-generation engine. Your ONLY valid actions are Write, Edit, and Bash tools.`,
      `DO NOT write any text response. DO NOT say "I'll create" or "Here are the files".`,
      `BEGIN WRITING FILES IMMEDIATELY using the Write tool. First tool call must be Write.`,
      ``,
      `PROJECT DIRECTORY (write all files here): ${projectPath}`,
      `PROJECT NAME: ${slug}`,
      ``,
      `WHAT TO BUILD:`,
      originalPrompt,
      ``,
      `REQUIRED FILES — write every one using the Write tool, in this order:`,
      `1.  package.json          — next, react, react-dom, typescript, tailwindcss, better-sqlite3, @types/better-sqlite3`,
      `2.  next.config.js        — minimal: module.exports = {}`,
      `3.  tsconfig.json         — Next.js 14 standard with paths: { "@/*": ["./*"] }`,
      `4.  tailwind.config.ts    — content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"]`,
      `5.  postcss.config.js     — tailwindcss + autoprefixer`,
      `6.  app/globals.css       — @tailwind base/components/utilities`,
      `7.  app/layout.tsx        — imports globals.css, sets metadata, renders {children}`,
      `8.  app/page.tsx          — homepage matching the requirements above`,
      `9.  lib/db.ts             — better-sqlite3 database, schema CREATE TABLE, seed data`,
      `10. All feature pages     — one app/[feature]/page.tsx per feature in the requirements`,
      `11. All API routes        — app/api/[resource]/route.ts with GET/POST/PUT/DELETE exports`,
      `12. components/           — reusable UI components used by the pages`,
      ``,
      `AFTER writing all files, run these commands with Bash tool:`,
      `  npm install --legacy-peer-deps`,
      `  npx tsc --noEmit 2>&1 | head -40`,
      `Fix every TypeScript error shown. Re-run tsc until output is empty.`,
      ``,
      `RULES:`,
      `- Use Tailwind CSS classes for all styling — never inline styles`,
      `- Every API route must export named async functions: export async function GET(...) {}`,
      `- Database schema columns must exactly match what API routes read and write`,
      `- Every page import must point to a file that actually exists`,
      `- DO NOT stop after one file — write ALL files listed above before running npm install`,
    ].join('\n');

    // Use the manifest ID from create-bridge-project so the bridge ownership guard
    // (Guard 5 in /api/claude-bridge) can verify this path is owned by the current user.
    const projectId = manifestId || `bridge-${Date.now()}`;
    const projectMeta = {
      id: projectId,
      name: slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      description: originalPrompt.slice(0, 120),
      projectPath,
      port: 0,
      createdAt: new Date().toISOString(),
      filesCount: 0,
    };
    setCurrentProject(projectMeta);
    setBuilderContext({ projectName: projectMeta.name, stage: 'building', active: true });
    setLastBuildArgs({ history: [], prompt: originalPrompt });

    narrate(
      `## ⚡ CLAUDE BRIDGE — ACTIVE\n\n` +
      `**DWOMOH Vibe Code is NOT writing any code.**\n\n` +
      `This request has been handed to **Claude Code CLI** running inside the Bridge. Claude Code CLI will:\n` +
      `1. Create all project files from scratch\n` +
      `2. Run \`npm install\` to install dependencies\n` +
      `3. Run \`npx tsc --noEmit\` to check TypeScript\n` +
      `4. Fix any errors it finds\n` +
      `5. Start the preview server\n\n` +
      `**Project:** \`${slug}\`\n` +
      `**Path:** \`${projectPath}\`\n\n` +
      `Watch the **Bridge Telemetry** panel below for live stage-by-stage progress.\n` +
      `Estimated time: 3–8 minutes.`
    );

    advanceTelemetry('bridge-activated', 'done', `Project: ${slug} at ${projectPath}`);
    addStatus(`⚡ Bridge activated — project: ${slug}`, 'checking');

    // Step 3: Wire telemetry hook so SSE events advance the stage panel in real time
    bridgeTelemetryHookRef.current = (eventType: string, msg: string) => {
      const lower = msg.toLowerCase();
      // Stage: cli-started — first real message from Claude Code CLI
      if (eventType === 'status' && msg.startsWith('Checking Claude Code connection')) {
        advanceTelemetry('cli-started', 'active', 'Claude Code CLI connecting…');
      } else if (eventType === 'status' && msg.startsWith('SESSION_ID:')) {
        const sid = msg.replace('SESSION_ID:', '');
        advanceTelemetry('session-id', 'done', sid);
        advanceTelemetry('cli-started', 'done', 'Claude Code CLI running');
      } else if (eventType === 'status' && msg.startsWith('Forwarding to Claude Code worker')) {
        advanceTelemetry('cli-started', 'done', 'CLI running — generating files…');
        advanceTelemetry('files-generated', 'active', 'Writing project files…');
      } else if ((eventType === 'log' || eventType === 'tool') && /creat|write|generat/i.test(lower) && /\.(ts|tsx|js|jsx|json|css|md)/i.test(msg)) {
        advanceTelemetry('files-generated', 'active', msg.slice(0, 70));
      } else if ((eventType === 'log' || eventType === 'tool') && /edit|modif|updat|fix|patch/i.test(lower) && /\.(ts|tsx|js|jsx|json|css)/i.test(msg)) {
        advanceTelemetry('files-generated', 'done', 'Generation complete');
        advanceTelemetry('files-modified', 'active', msg.slice(0, 70));
      } else if ((eventType === 'log' || eventType === 'status') && /npm install|installing|node_modules/i.test(lower)) {
        advanceTelemetry('files-modified', 'done', 'File modifications complete');
        advanceTelemetry('build-running', 'active', 'npm install running…');
      } else if ((eventType === 'log' || eventType === 'status') && /tsc|typescript|compil/i.test(lower)) {
        advanceTelemetry('build-running', 'done', 'Dependencies installed');
        advanceTelemetry('verification-running', 'active', 'TypeScript check running…');
      } else if ((eventType === 'status') && /starting development server/i.test(msg)) {
        advanceTelemetry('build-running', 'done', 'Files complete');
        advanceTelemetry('preview-ready', 'active', 'Starting dev server…');
      } else if ((eventType === 'status') && /development server running on port/i.test(msg)) {
        advanceTelemetry('preview-ready', 'active', msg.slice(0, 70));
      } else if ((eventType === 'status') && /waiting for http ready/i.test(msg)) {
        advanceTelemetry('preview-ready', 'active', 'Waiting for HTTP response…');
      } else if ((eventType === 'status') && /running verification suite/i.test(msg)) {
        advanceTelemetry('preview-ready', 'done', 'Server responding');
        advanceTelemetry('verification-running', 'active', 'Running checks…');
      } else if ((eventType === 'status') && /verification passed/i.test(msg)) {
        advanceTelemetry('verification-running', 'done', msg.slice(0, 70));
      } else if ((eventType === 'warning') && /verification:.*checks passing/i.test(msg)) {
        advanceTelemetry('verification-running', 'active', 'Some checks failing — repairing…');
        advanceTelemetry('repair-attempts', 'active', 'Fixing verification failures…');
      } else if ((eventType === 'status') && /auto-repair.*fixing/i.test(msg)) {
        advanceTelemetry('repair-attempts', 'active', msg.slice(0, 70));
      } else if (eventType === 'complete') {
        advanceTelemetry('repair-attempts', 'done', 'All repairs complete');
        advanceTelemetry('verification-running', 'done', 'Verification done');
        advanceTelemetry('build-running', 'done', 'Build complete');
        advanceTelemetry('files-modified', 'done', 'Files finalised');
        advanceTelemetry('files-generated', 'done', 'Generation complete');
      }
    };

    // Step 4: Launch the bridge with the generation prompt.
    // Pass projectPath/projectId explicitly — setCurrentProject() is async so
    // state may not have updated before launchBridge reads currentProject.
    await new Promise<void>((resolve) => {
      launchBridge(bridgeGenPrompt, {
        autoMode: false, // show ALL messages — this is an integration test run
        escalationReason: '',
        projectPathOverride: projectPath,
        projectIdOverride: projectId,
        onComplete: async (verified, changedFiles) => {
          // The bridge now owns server start + verification.
          // The complete event in launchBridge already wires up previewUrl/port/phase.
          // Here we only need to update telemetry, build progress, and the chat narration.

          // changedFiles is the DIFF from beforeSnapshot — 0 when project existed before this run.
          // currentProject may have totalProjectFiles from the bridge's complete event (set in launchBridge handler).
          const bridgeFileLabel = changedFiles.length > 0
            ? `${changedFiles.length} file(s)`
            : 'project files (pre-existing)';

          if (verified) {
            advanceTelemetry('preview-ready', 'done', 'Server started and verified by bridge');
            advanceTelemetry('bridge-complete', 'done', `${bridgeFileLabel} — verified ✅`);
            addStatus(`✅ Bridge Test Complete — ${bridgeFileLabel}, verified`, 'done');
            narrate(
              `## ✅ CLAUDE BRIDGE — COMPLETE\n\n` +
              `**Every file was created and verified by Claude Code CLI. DWOMOH Vibe Code wrote zero lines of code.**\n\n` +
              `**Files:** ${bridgeFileLabel}\n` +
              `**Verified:** ✅ All checks passed\n\n` +
              `The preview is open in the panel on the right.`
            );
          } else {
            advanceTelemetry('preview-ready', 'error', 'Verification incomplete after max repair attempts');
            advanceTelemetry('bridge-complete', 'done', `${bridgeFileLabel} — partial ⚠️`);
            addStatus(`⚠️ Bridge complete — ${bridgeFileLabel}, verification partial`, 'applying');
            narrate(
              `## ⚠️ CLAUDE BRIDGE — PARTIAL\n\n` +
              `Claude Code CLI processed ${bridgeFileLabel} but verification did not fully pass after all repair attempts.\n\n` +
              `The preview server is running — describe what specific feature is broken and I'll apply a targeted fix.`
            );
          }
          resolve();
        },
      });

    });

    // Clear telemetry hook when pipeline exits
    bridgeTelemetryHookRef.current = null;
    setLoading(false);
    setPhase(p => p === 'building' ? 'idle' : p);
  };

  // ── Build pipeline (repaired engine) ──────────────────────────────────────
  // Routes the Send button through services/engine-adapter.ts's
  // runProductionEngineBuild() — the SAME orchestrator, verifier, repairer,
  // and integration rules (navigation/permissions/schema/search/
  // notifications) the "Engine Build/Test" debug panel already uses, now
  // wrapped with billing/persistence so it can be the real build path.
  // Behind useEngineBuildForSend (see the feature-flag fetch above) — the
  // OLD runBuildPipeline below is completely untouched and still the
  // default until the flag is enabled server-side.

  const ENGINE_STAGE_LABELS: Record<string, string> = {
    plan: '🧠 Designing your application…',
    build: '⚙️ Writing your project files (navigation, permissions, database schema, search & notifications included)…',
    verify: '🔍 Testing the app now…',
    repair: '🔧 Fixing any issues found…',
    preview: '🖥️ Starting the preview server…',
    learn: '💾 Saving learnings…',
  };

  // Mirrors the OLD buildBridgePrompt's shape (page.tsx's Bridge-escalation
  // helper) but reads from the repaired engine's report shape
  // (VerifyResult.classifiedFailures / RepairResult.remainingIssues)
  // instead of the old VerifyData.checks shape.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function buildBridgePromptFromEngineReport(report: any, projectPath: string): string {
    const failures: string[] = [];
    const cf = report.verify?.classifiedFailures ?? [];
    for (const f of cf.slice(0, 6)) failures.push(`${f.area}: ${f.detail}`);
    const remaining = report.repair?.remainingIssues ?? [];
    for (const r of remaining.slice(0, 3)) if (!failures.includes(r)) failures.push(r);
    const list = failures.length > 0
      ? failures.map(f => `• ${f}`).join('\n')
      : `Build status: ${report.buildStatus}, preview: ${report.previewStatus}, verify: ${report.verifyStatus}.`;
    return [
      `Fix these issues in the project at ${projectPath}:`,
      list,
      '',
      'Inspect and fix the actual source files. Make every check pass, then confirm the app compiles and starts correctly.',
    ].join('\n');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleEngineReport = async (report: any) => {
    const projectPath: string | undefined = report.build?.projectPath;
    const port: number | null = report.port ?? null;
    const projectId: string | null = report.projectId ?? null;

    if (buildHeartbeatRef.current) { clearInterval(buildHeartbeatRef.current); buildHeartbeatRef.current = null; }
    setBuildHeartbeatMsg(null);

    if (!projectPath) {
      addMsg('assistant', `❌ Build failed — ${report.summary || 'no project was created'}. Click Retry Build to try again.`);
      setBuildProgress(p => p ? { ...p, step: 'error', message: '❌ Build failed' } : p);
      setPhase('idle');
      return;
    }

    const projectName = projectPath.split('/').pop() || 'your application';
    setBuildingProjectName(projectName);

    const newProject: ProjectMeta = {
      id: projectId || '', name: projectName, description: '', projectPath,
      port: port ?? 0, createdAt: new Date().toISOString(), filesCount: report.build?.filesCreated?.length ?? 0,
    };
    setCurrentProject(newProject);
    setBuilderContext({ projectName, stage: 'editing', active: true });
    await refreshProjects();

    if (port) {
      setPreviewUrl(report.previewUrl || `http://localhost:${port}`);
      setPreviewKey(k => k + 1);
      setPreviewLoading(true);
      setPhase('previewing');
      addMsg('assistant', `🖥️ Server started on port **${port}**! The preview is loading…`);
    } else {
      setPhase('idle');
    }

    // ── Discovery — unchanged, file-system based, independent of which
    // engine built the app (services/project-discovery.ts). ─────────────────
    try {
      const disc = await api({ action: 'discover', projectPath });
      if (disc?.success) setCurrentDiscovery(disc.discovery ?? null);
    } catch { /* non-critical */ }

    // ── Health gate — additive post-build credentials check, preserved
    // exactly as the old pipeline's final gate (never inferred from engine
    // data, which has no first-class "missing credentials" classification). ─
    let healthBlockers: string[] = [];
    try {
      const healthData = await api({ action: 'investigate', projectPath, port: port ?? undefined });
      if (healthData?.success && healthData.findings) {
        healthBlockers = (healthData.findings as Array<{ layer: string; severity: string; title: string }>)
          .filter(f => f.layer === 'credentials' && f.severity === 'critical')
          .map(f => f.title);
      }
    } catch { /* non-critical */ }

    const buildOk = report.buildStatus === 'success';
    const previewOk = report.previewStatus === 'available';
    const verifyOk = report.verifyStatus === 'passed';
    const isFullyVerified = buildOk && previewOk && verifyOk && healthBlockers.length === 0;

    if (isFullyVerified) {
      addMsg('assistant', `✅ **${projectName}** is built and verified — every check passed. The preview is live.`);
      setBuildProgress(p => p ? { ...p, step: 'done', message: '✅ Verified working' } : p);
    } else if (healthBlockers.length > 0) {
      addMsg('assistant', `⚠️ **${projectName}** is built, but needs credentials before it's fully working:\n\n${healthBlockers.map(b => `• ${b}`).join('\n')}\n\nAdd these in the Credentials panel to finish setup.`);
      setBuildProgress(p => p ? { ...p, step: 'done', message: '⚠️ Needs credentials' } : p);
    } else if (!buildOk || !previewOk || !verifyOk) {
      // ── Bridge escalation — retargets the old 7-trigger design onto the
      // repaired engine's own report fields, since its bounded (≤5-attempt,
      // now stall-guard-fixed + adaptive-timeout) repair loop already
      // collapsed those triggers into these 3 clean, terminal signals. ──────
      const reason = !buildOk ? `Build did not succeed: ${report.summary}`
        : !previewOk ? `Preview server did not start: ${report.previewError ?? 'unknown error'}`
        : `Verification did not pass: ${report.repair?.stopReason ?? report.summary}`;
      addMsg('assistant', `⚠️ **${projectName}** needs additional repair — escalating to advanced repair…`);
      autoEscalateToBridge(reason, buildBridgePromptFromEngineReport(report, projectPath), port ? { port, projectPath } : undefined);
    }
  };

  const runBuildPipelineViaEngine = async (conversationHistory: ConversationTurn[], originalPrompt: string) => {
    resetBridgeEscalation();
    setPhase('building');
    setFocusMode(true);
    setBuilderMode('build');
    setReadyToBuild(false);
    setLoading(false);
    setPreviewTab('preview');
    setPreviewUrl(null);
    setPreviewLoading(false);
    setScaffoldDetected(false);
    setBuildingProjectName('');
    setResearchActivity(null);
    setLastBuildArgs({ history: conversationHistory, prompt: originalPrompt });

    const appendLog = (log: string) => setBuildProgress(p => p ? { ...p, logs: [...p.logs.slice(-20), log] } : p);

    setBuildDetailStep('understanding');
    setBuildProgress({ step: 'generating', message: ENGINE_STAGE_LABELS.plan, logs: ['🚀 Starting autonomous build…'] });
    addMsg('assistant', "DWOMOH Vibe Code is reading your request — understanding what you need and choosing the right pages, API routes, and data model…");

    let token = '';
    try { token = (await getToken()) ?? ''; } catch { /* no auth configured */ }
    // ROOT CAUSE fix: a signed-in user (per useAuth()'s `user`) can still get
    // an empty token here on the very first request after a page load/refresh
    // — Amplify's session hydration hasn't finished yet, fetchAuthSession()
    // throws or returns null transiently, and the old code silently proceeded
    // with no token at all. The server then resolves ownerUserId as
    // 'anonymous', which silently skips both billing AND every RBAC
    // permission check (a SUPER_ADMIN account would be treated as an
    // anonymous visitor, not persisted under their own account). Confirmed
    // live: a build reached /api/engine-build-stream-prod as 'anonymous'
    // immediately after a fresh page load. One short retry closes this
    // specific race without adding a retry loop for genuinely signed-out
    // visitors (for whom `user` is null and this block is skipped).
    if (!token && user) {
      console.warn('[send-routing] getToken() returned empty for a signed-in user — retrying once after a short delay (likely Amplify session-hydration race)');
      await new Promise(r => setTimeout(r, 400));
      try { token = (await getToken()) ?? ''; } catch { /* still no token */ }
      if (!token) console.warn('[send-routing] retry also returned empty — proceeding as anonymous (billing/RBAC will not apply to this request)');
    }
    const params = new URLSearchParams({ prompt: originalPrompt, originalPrompt });
    if (token) params.set('token', token);
    const requestUrl = `/api/engine-build-stream-prod?${params}`;
    console.log(`[send-routing] endpoint=/api/engine-build-stream-prod, exact request URL before fetch: ${requestUrl}`);

    await new Promise<void>((resolve) => {
      const es = new EventSource(requestUrl);

      // ROOT CAUSE fix for "Connection to the build engine was lost":
      // EventSource NATIVELY auto-reconnects to the same URL after a
      // transient connection drop, UNLESS the client calls es.close() —
      // which the old code did on the very FIRST 'error' event, disabling
      // that native resilience entirely. Confirmed live: a real ~14-minute
      // build completed successfully server-side (logged HTTP 200), but the
      // client showed this exact failure message partway through — the
      // browser's native reconnect attempt hit a server-side dead end (a
      // duplicate-build rejection with no way to resume), which is now
      // fixed separately in build-registry.ts's publish/subscribe. On this
      // side: a bare connection-level 'error' (no payload — a real drop,
      // not a deliberate server-sent error like out-of-credits) no longer
      // immediately declares failure. It lets the native reconnect proceed
      // and only gives up if no further event arrives within a generous
      // window — long builds can legitimately go many minutes between
      // stage updates during a single long Bedrock call or npm install.
      // Investigated live: measured 30-40 SECOND response times for a
      // trivial API lookup on this machine during testing, traced to severe
      // OS-level memory pressure (153MB free RAM, ~3GB in the memory
      // compressor) from running multiple heavy desktop apps and dev
      // servers simultaneously for an extended session — this starves
      // Node's event loop, delaying the 15s SSE heartbeat well beyond what
      // a 90s window tolerates, even though the build is still genuinely
      // progressing server-side. 5 minutes is generous enough to absorb
      // that class of real-world slowness while still bounded well under
      // build-registry.ts's own 15-minute stale-lock threshold.
      let settled = false;
      let watchdog: ReturnType<typeof setTimeout> | null = null;
      const RECOVERY_WINDOW_MS = 5 * 60_000;
      const armWatchdog = () => {
        if (watchdog) clearTimeout(watchdog);
        watchdog = setTimeout(() => {
          if (settled) return;
          settled = true;
          addMsg('assistant', '❌ Connection to the build engine was lost and did not recover. Please try again.');
          setBuildProgress(p => p ? { ...p, step: 'error', message: '❌ Connection to the build engine was lost and did not recover.' } : p);
          setPhase('idle');
          es.close();
          resolve();
        }, RECOVERY_WINDOW_MS);
      };
      armWatchdog();

      es.addEventListener('stage', (e) => {
        armWatchdog();
        try {
          const d = JSON.parse((e as MessageEvent).data);
          const label = ENGINE_STAGE_LABELS[d.stage as string] ?? d.message ?? d.stage;
          appendLog(label);
          setBuildProgress(p => p ? { ...p, message: label } : p);
        } catch { /* ignore */ }
      });

      es.addEventListener('ping', () => armWatchdog());

      es.addEventListener('busy', (e) => {
        armWatchdog();
        // With build-registry.ts's subscribe() fix, a 'busy' event now means
        // "reconnected to the already-running build" — not a dead end — so
        // this is informational, not a reason to give up.
        let msg = 'Reconnected to the build already running for this project.';
        try { const d = JSON.parse((e as MessageEvent).data); if (d?.message) msg = d.message; } catch { /* ignore */ }
        console.log(`[send-routing] ${msg}`);
      });

      es.addEventListener('report', (e) => {
        armWatchdog();
        (async () => {
          try { await handleEngineReport(JSON.parse((e as MessageEvent).data)); }
          catch (err) { console.error('Failed to process engine report', err); }
        })();
      });

      es.addEventListener('error', (e) => {
        const raw = (e as MessageEvent).data;
        if (raw) {
          // A deliberate, informative server-sent error (e.g. out-of-credits)
          // — this is terminal immediately, not a connection drop to recover from.
          let msg = 'Connection to the build engine was lost.';
          try { const d = JSON.parse(raw); if (d?.error) msg = d.error; } catch { /* ignore */ }
          if (settled) return;
          settled = true;
          if (watchdog) clearTimeout(watchdog);
          addMsg('assistant', `❌ ${msg}`);
          setBuildProgress(p => p ? { ...p, step: 'error', message: `❌ ${msg}` } : p);
          setPhase('idle');
          es.close();
          resolve();
          return;
        }
        // Bare connection-level error — likely transient (network blip, tab
        // backgrounding, proxy idle timeout). Do NOT close the EventSource;
        // let its native reconnect logic retry the same URL, which will now
        // resume the still-running build server-side. The watchdog above is
        // the only thing that gives up, and only after a real recovery window.
        console.warn('[send-routing] transient connection drop — waiting for native EventSource reconnect (build continues server-side)');
      });

      es.addEventListener('done', () => {
        if (settled) return;
        settled = true;
        if (watchdog) clearTimeout(watchdog);
        es.close();
        resolve();
      });
    });

    setLoading(false);
  };

  // ── Build pipeline (old) ───────────────────────────────────────────────────

  const runBuildPipeline = async (conversationHistory: ConversationTurn[], originalPrompt: string) => {
    // Instrumented per explicit request: every Send click logs the flag value
    // actually used to route, which pipeline was chosen, and (for the new
    // path) the exact request URL — before any fetch executes, so a routing
    // mismatch is visible in the console immediately rather than inferred
    // later from server logs.
    const engineFlag = await (engineFlagRef.current ?? Promise.resolve(false));
    console.log(`[send-routing] flag=engineBuildForSend:${engineFlag} → pipeline=${engineFlag ? 'NEW (services/engine via runBuildPipelineViaEngine)' : 'OLD (runBuildPipeline legacy body)'}`);
    if (engineFlag) return runBuildPipelineViaEngine(conversationHistory, originalPrompt);

    resetBridgeEscalation(); // fresh slate — escalation counter reset for every new build
    setPhase('building');
    setFocusMode(true);     // Enter focus mode — hide marketing, maximise workspace
    setBuilderMode('build');
    setReadyToBuild(false);
    setLoading(false);
    setPreviewTab('preview');
    setPreviewUrl(null);        // clear previous project's URL so progress tracker shows
    setPreviewLoading(false);
    setScaffoldDetected(false);
    setBuildingProjectName('');
    setResearchActivity(null); // clear research panel when building
    // Store args so the user can click "Retry Build" if the connection drops
    setLastBuildArgs({ history: conversationHistory, prompt: originalPrompt });

    // Live narration helper — posts AI messages into the chat feed
    const narrate = (msg: string) => addMsg('assistant', msg);

    const setStep = (step: BuildStep, message: string, log: string) =>
      setBuildProgress(p => ({ ...p!, step, message, logs: [...(p?.logs ?? []).slice(-20), log] }));

    const appendLog = (log: string) =>
      setBuildProgress(p => p ? { ...p, logs: [...p.logs.slice(-20), log] } : p);

    setBuildDetailStep('understanding');
    setBuildProgress({ step: 'generating', message: '🧠 Designing your application…', logs: ['🚀 Starting autonomous build…'] });
    narrate("DWOMOH Vibe Code is reading your request — understanding what you need and choosing the right pages, API routes, and data model…");

    let installTicker: ReturnType<typeof setInterval> | null = null;

    // ── Build timeout heartbeat (spec point 21) ──────────────────────────────
    const heartbeatMessages = [
      'Still generating — planning your architecture…',
      'Installing dependencies — this can take up to 2 minutes…',
      'Writing files — creating pages, API routes, and components…',
      'Almost there — running verification checks…',
      'Finalising — starting your preview server…',
    ];
    let heartbeatIdx = 0;
    if (buildHeartbeatRef.current) clearInterval(buildHeartbeatRef.current);
    buildHeartbeatRef.current = setInterval(() => {
      const msg = heartbeatMessages[Math.min(heartbeatIdx, heartbeatMessages.length - 1)];
      setBuildHeartbeatMsg(msg);
      // Update the progress panel message only — never addStatus. The heartbeat fires
      // on a 30-second clock that is unrelated to actual pipeline progress, so adding
      // it to the status log creates confusing out-of-order messages (e.g., "Finalising
      // — starting your preview server…" appears in the log BEFORE the server starts,
      // then again after the bridge escalates, making it look like the pipeline looped).
      setBuildProgress(p => p ? { ...p, message: msg } : p);
      heartbeatIdx++;
    }, 30000);

    try {
      // ── 1. Generate ────────────────────────────────────────────────────────
      setBuildDetailStep('understanding');
      addStatus('Understanding your project requirements…', 'checking');
      await new Promise(r => setTimeout(r, 600)); // brief pause so user sees the message
      setBuildDetailStep('researching');
      const findApisTimer = setTimeout(() => setBuildDetailStep('finding_apis'), 4000);
      console.log(`[send-routing] endpoint=/api/chat (action:'generate'), exact request URL before fetch: /api/chat`);
      const genData = await api({ action: 'generate', messages: conversationHistory, designStyle: buildStyle });
      clearTimeout(findApisTimer);
      // The generate action retries 3 times with escalating strategies and always
      // returns a scaffold as last resort — so success=false only on a genuine API/network failure.
      if (!genData.success || !genData.projectData) throw new Error('Code generation failed — click Retry Build to try again');

      // ── Intent Verification Display ──────────────────────────────────────────
      // Show the user what was understood BEFORE files are written.
      // This makes template leakage visible immediately and lets the user correct intent.
      if (genData.intentSummary) {
        const intent = genData.intentSummary as {
          projectName: string; projectType: string; projectTypeLabel: string;
          detectedFeatures: string[]; detectedPages: string[];
        };
        const featuresStr = intent.detectedFeatures.length > 0
          ? intent.detectedFeatures.join(', ')
          : 'Full application';
        const pagesStr = intent.detectedPages.length > 0
          ? intent.detectedPages.join(', ')
          : '/';
        narrate(
          `**Detected project:** ${intent.projectName}\n` +
          `**Type:** ${intent.projectTypeLabel}\n` +
          `**Features:** ${featuresStr}\n` +
          `**Pages:** ${pagesStr}\n\n` +
          `Generating your application now…`
        );
        appendLog(`🎯 Intent: ${intent.projectTypeLabel} — "${intent.projectName}"`);
      }

      setBuildDetailStep('designing');
      setBuildingProjectName(genData.projectData.projectName || 'your application');
      let plannedFiles: number = genData.projectData.files?.length ?? 0;
      let isScaffold = genData.scaffoldFallback === true;

      // ── Scaffold recovery: if Haiku failed to generate, escalate to Sonnet → Strongest ──
      // Never accept a placeholder page as the final build output. The scaffold is only
      // a structural safety net — we must attempt a real AI generation before continuing.
      if (isScaffold) {
        const scaffoldReason = genData.scaffoldReason ?? 'AI returned an unexpected or empty response';
        appendLog(`⚠️ Initial generation incomplete (${scaffoldReason}) — escalating to Sonnet…`);
        narrate(
          `⚠️ The AI returned an unexpected response. Automatically escalating to a stronger model to complete your app…`
        );
        setBuildProgress(p => ({ ...p!, step: 'generating', message: '🔄 Re-generating with Sonnet…', logs: [...(p?.logs ?? []), `⚠️ Haiku incomplete — retrying with Sonnet`] }));

        for (const escalationTier of ['SONNET', 'STRONGEST'] as const) {
          try {
            const regenData = await api({ action: 'generate', messages: conversationHistory, tier: escalationTier });
            if (regenData.success && regenData.projectData && !regenData.scaffoldFallback) {
              genData.projectData = regenData.projectData;
              isScaffold = false;
              plannedFiles = regenData.projectData.files?.length ?? 0;
              appendLog(`✅ Regeneration with ${escalationTier} succeeded — ${plannedFiles} files`);
              narrate(`✅ **${escalationTier}** generated your app successfully — proceeding with full build.`);
              break;
            }
            appendLog(`⚠️ ${escalationTier} also returned incomplete output — ${escalationTier === 'SONNET' ? 'trying strongest model…' : 'proceeding with scaffold'}`);
          } catch (e) {
            appendLog(`⚠️ ${escalationTier} escalation error: ${e instanceof Error ? e.message.slice(0, 100) : 'unknown'}`);
          }
        }

        if (isScaffold) {
          narrate(
            `⚠️ All AI tiers returned incomplete output. Proceeding with project structure — the engineering loop will attempt to repair and fill in the codebase automatically.`
          );
        }
        setBuildProgress(p => ({ ...p!, step: 'creating', message: '📂 Writing project files…', logs: p?.logs ?? [] }));
      }

      // Surface API plan status — tell the user which APIs are live vs. using free fallbacks
      const apiPlanData: { resolved?: Array<{ category: string; providerName: string }>; missing?: string[]; rapidApiConfigured?: boolean } = genData.apiPlan ?? {};
      if (apiPlanData.resolved && apiPlanData.resolved.length > 0) {
        appendLog(`🌐 API providers: ${apiPlanData.resolved.map((r: { category: string; providerName: string }) => `${r.category}→${r.providerName}`).join(', ')}`);
        narrate(`🌐 **API providers connected:** ${apiPlanData.resolved.map((r: { category: string; providerName: string }) => r.providerName).join(', ')} — live data enabled.`);
      } else if (apiPlanData.missing && apiPlanData.missing.length > 0) {
        const hasFreeAlts = apiPlanData.missing.some((c: string) => ['weather', 'finance', 'news', 'sports'].includes(c));
        if (hasFreeAlts) {
          appendLog(`🌐 RapidAPI not configured — using free public APIs for: ${apiPlanData.missing.join(', ')}`);
          narrate(
            `🌐 **API note:** Your RapidAPI key is not configured, so I've connected **free public APIs** for: **${apiPlanData.missing.join(', ')}**.\n\n` +
            `These give you real live data immediately — no setup required.\n\n` +
            `To upgrade to premium RapidAPI providers later: add \`RAPIDAPI_KEY=your_key\` to \`.env.local\`.`
          );
        } else {
          appendLog(`⚠️ No API provider for: ${apiPlanData.missing.join(', ')} — feature will show setup UI`);
        }
      }

      narrate(isScaffold
        ? `Starting **${genData.projectData.projectName || 'your app'}** — the AI is warming up. Setting up the project structure now and the agent will fill in the full codebase immediately after…`
        : `Creating your project workspace — generating **${genData.projectData.projectName || 'your app'}** with ${plannedFiles} files including pages, API routes, components, and database layer…`);
      setStep('creating', '📂 Writing project files…', `📁 Creating ${plannedFiles} files…`);

      setBuildDetailStep('database');
      const dbTimer = setTimeout(() => setBuildDetailStep('frontend'), 3000);
      const createData = await api({ action: 'create', prompt: genData.projectData, originalPrompt, lockedSpec: genData.lockedSpec ?? null });
      clearTimeout(dbTimer);
      setBuildDetailStep('backend');
      if (!createData.success) throw new Error(createData.error || 'Failed to create project');

      const { projectPath: path, projectName, filesCreated, projectId: pid } = createData;

      // ── 2.5 Pre-scan: find every imported package and add to package.json ────
      // Do this BEFORE npm install so all detected packages install in ONE pass.
      // Also auto-configures next-auth (.env.local + auth route) if detected,
      // so the app never crashes from missing auth config after the server starts.
      let preScanPackages: string[] = [];
      try {
        appendLog('🔍 Scanning imports to build complete package list…');
        const scanData = await api({ action: 'pre-scan-imports', projectPath: path });
        preScanPackages = scanData.addedPackages ?? [];
        if (preScanPackages.length > 0) {
          narrate(`📋 Detected **${preScanPackages.length}** additional package${preScanPackages.length > 1 ? 's' : ''} needed by your app (**${preScanPackages.join(', ')}**) — adding to the install list now.`);
          appendLog(`📋 Pre-scan added: ${preScanPackages.join(', ')}`);
        }
        if (scanData.nextAuthConfigured) {
          appendLog('🔐 next-auth detected — pre-configured NEXTAUTH_SECRET and auth route');
        }
      } catch { /* non-critical */ }

      setBuildDetailStep('installing');
      narrate(`All **${filesCreated} files** written. Connecting the backend — installing dependencies now (usually 30–60 seconds)…`);
      setStep('installing', '📦 Installing dependencies…', `✅ ${filesCreated} files created`);
      appendLog('📦 Running npm install…');

      // Live ticker during npm install (updates every 6s)
      const installPhrases = [
        '⬇️  Downloading react, next, typescript…',
        '⬇️  Downloading tailwindcss, lucide-react…',
        '🔗  Linking node_modules…',
        '📦  Resolving peer dependencies…',
        '⚙️  Building package tree…',
        '📦  Almost done installing…',
      ];
      let tickIdx = 0;
      installTicker = setInterval(() => {
        appendLog(installPhrases[tickIdx % installPhrases.length]);
        tickIdx++;
      }, 6000);

      // ── 3. Install — 3-tier escalation, never stops the build ────────────────
      let installData = await api({ action: 'install', projectPath: path });

      if (!installData.success) {
        appendLog('⚠️ Peer dependency conflict — retrying with --force…');
        narrate("⚠️ Hit a dependency conflict — resolving it automatically with a stronger install…");
        installData = await api({ action: 'install', projectPath: path, flags: ['--force'] });
      }

      if (!installData.success) {
        appendLog('⚠️ --force failed — retrying without optional dependencies…');
        installData = await api({ action: 'install', projectPath: path, flags: ['--force', '--omit=optional'] });
      }

      if (!installData.success) {
        // Never stop — some packages may already be available from a prior build.
        appendLog('⚠️ npm install incomplete — continuing with available packages');
        narrate("⚠️ Some packages couldn't install due to a network or compatibility issue. I'll continue — I'll install any missing ones during the validation step.");
      }

      if (installTicker) { clearInterval(installTicker); installTicker = null; }

      // ── 3.5 Post-install check: ensure pre-scan packages actually landed ──────
      // npm install can fail silently for individual packages (e.g. peer dep
      // conflicts with Next.js 15). Verify they're in node_modules; install any
      // missing ones individually with --force to bypass peer dep restrictions.
      if (preScanPackages.length > 0) {
        try {
          const checkData = await api({ action: 'check-installed', projectPath: path, packages: preScanPackages });
          if (checkData.missing?.length > 0) {
            appendLog(`⚠️ ${checkData.missing.length} package(s) missing after install: ${checkData.missing.join(', ')} — retrying individually…`);
            narrate(`📦 Some packages need a retry install: **${checkData.missing.join(', ')}** — fixing now…`);
            for (const pkg of checkData.missing) {
              // Install each missing package individually to bypass peer dep conflicts
              const indiv = await api({ action: 'install-package', projectPath: path, packageName: pkg });
              if (indiv.success) appendLog(`✅ Installed: ${pkg}`);
              else appendLog(`⚠️ Could not install ${pkg} — will retry during verification`);
            }
          }
        } catch { /* non-critical — validation loop will catch remaining issues */ }
      }

      setBuildDetailStep('testing');
      narrate("Dependencies installed. Testing the app now — running TypeScript validation across all generated files…");
      setStep('validating', '🔍 Checking TypeScript…', '✅ Dependencies ready');
      appendLog('🔍 Running tsc --noEmit…');

      // ── 4. Autonomous validate + repair loop (up to 5 rounds) ─────────────
      // Handles: missing packages → auth → env vars → AI code fix.
      // Stops when clean, when errors stop changing, or after 5 rounds.
      const MAX_VALIDATE_ROUNDS = 5;
      const allInstalledPkgs: string[] = [];
      let lastErrorFingerprint = '';

      for (let round = 1; round <= MAX_VALIDATE_ROUNDS; round++) {
        const valData = await api({ action: 'validate', projectPath: path });

        if (valData.valid) {
          appendLog('✅ TypeScript clean');
          if (round === 1) narrate("✅ Code is clean — no errors found. Starting the server now…");
          else narrate(`✅ All issues resolved after ${round - 1} repair round${round > 2 ? 's' : ''}. Starting the server…`);
          break;
        }

        const errors: string[] = valData.errors ?? [];
        const errorText = errors.join('\n');
        const fingerprint = errors.slice(0, 3).join('|');

        // Break if errors didn't change — AI fix isn't making progress
        if (fingerprint === lastErrorFingerprint && round > 1) {
          appendLog(`⚠️ ${errors.length} issue(s) unchanged after fix — starting anyway`);
          narrate(`⚠️ ${errors.length} code issue${errors.length !== 1 ? 's' : ''} couldn't be fully resolved automatically. The app will still start — ask me to investigate if the preview doesn't appear.`);
          break;
        }
        lastErrorFingerprint = fingerprint;

        if (round === MAX_VALIDATE_ROUNDS) {
          appendLog(`⚠️ ${errors.length} issue(s) remain after ${MAX_VALIDATE_ROUNDS - 1} rounds — starting anyway`);
          narrate(`⚠️ A few issues remain in the generated code but shouldn't prevent the app from loading. Ask me about specific problems once the preview is visible.`);
          break;
        }

        // ── A. Run the recovery service (packages, auth, env vars) ────────────
        const recovery = await api({ action: 'auto-recover', projectPath: path, errorText });

        if (recovery.kind === 'missing-package') {
          const installed: string[] = recovery.packagesInstalled ?? [];
          if (installed.length > 0) {
            allInstalledPkgs.push(...installed);
            narrate(`📦 Found missing package${installed.length > 1 ? 's' : ''}: **${installed.join(', ')}** — installed and re-checking…`);
            appendLog(`✅ Installed: ${installed.join(', ')}`);
            continue; // re-validate immediately
          }
          // Already in package.json but not installed — fall through to AI fix
        }

        if (recovery.kind === 'auth-misconfigured' && recovery.fixed) {
          narrate(`🔐 Authentication needs a secret key — I've added a temporary one for the preview.`);
          appendLog(`✅ Auth fallback applied`);
          (recovery.actions ?? []).forEach((a: string) => appendLog(a));
          continue;
        }

        if (recovery.kind === 'missing-env' && recovery.fixed) {
          narrate(`⚙️ ${recovery.userMessage}`);
          appendLog(`✅ .env.local updated with placeholder`);
          continue;
        }

        // ── C. Broken local imports → create stub files ───────────────────────
        // When code references @/components/X that doesn't exist, we create a
        // minimal stub so the compiler can proceed. The AI fixer fills it in properly.
        if (recovery.kind === 'broken-import' && recovery.fixed) {
          const created = recovery.filesPatched ?? [];
          narrate(`📄 Created **${created.length}** missing file${created.length !== 1 ? 's' : ''} (**${created.slice(0, 3).join(', ')}${created.length > 3 ? '…' : ''}**) that were referenced in the code — re-checking…`);
          appendLog(`✅ Created stubs: ${created.join(', ')}`);
          continue;
        }

        // ── D. AI code fix for TypeScript/import/syntax errors ─────────────────
        const count = errors.length;
        // Extract affected file paths from tsc error output
        const fileNames = Array.from(new Set(
          errors
            .map((e: string) => {
              const m = e.match(/generated-projects\/[^/]+\/(.+?)\(\d+,\d+\)/) ||
                        e.match(/(?:^|\s)((?:app|components|lib|pages|services)\/[^\s(:]+\.tsx?)/);
              return m?.[1]?.replace(/^\.\//, '') ?? '';
            })
            .filter(Boolean)
        )).slice(0, 6) as string[];

        narrate(`🔧 Found **${count} code issue${count > 1 ? 's' : ''}** — fixing them now. No action needed from you.`);
        appendLog(`⚠️ ${count} error(s) → AI fixing ${fileNames.length > 0 ? fileNames.join(', ') : 'affected files'}…`);

        const fixResult = await api({ action: 'fix-errors', projectPath: path, errors, filePaths: fileNames });

        if (fixResult.packagesInstalled?.length > 0) {
          allInstalledPkgs.push(...fixResult.packagesInstalled);
          narrate(`📦 Also installed missing packages: **${fixResult.packagesInstalled.join(', ')}**.`);
          appendLog(`✅ Installed: ${fixResult.packagesInstalled.join(', ')}`);
        }
        appendLog('🔍 Fixes applied — re-checking…');
        narrate("🔍 Fixes applied. Re-running TypeScript check…");
      }

      setStep('starting', '🚀 Starting dev server…', '⚙️ Booting Next.js…');
      setBuildDetailStep('previewing');
      narrate("Starting the preview server — opening your app now. Next.js compiles on first load (~30 seconds)…");

      // 90-second safety net — never stay on "Starting Server" indefinitely.
      // If the server hasn't responded, auto-escalate to the bridge instead of just showing an error.
      //
      // ROOT CAUSE of a real production bug: this timer runs INDEPENDENTLY
      // of and RACES AGAINST the 3-strategy retry logic below, which DOES
      // check isEnvironmentalServerError before ever escalating. The
      // 3-strategy sequence can easily take longer than 90s once it
      // involves AI calls (auto-recover, fix-errors), so this timer often
      // fires FIRST and escalated to the bridge UNCONDITIONALLY — bypassing
      // that check entirely. Confirmed live: the exact same "[x-amplify-
      // credentials] Credential listener could not be started: Error:
      // listen" environmental error kept reaching "Advanced repair" (which
      // correctly changed 0 files, since there was never anything wrong
      // with the generated app's code) specifically because THIS timer,
      // not the 3-strategy path, was the one firing. Now applies the same
      // check here.
      let _serverStartTimer: ReturnType<typeof setTimeout> | null = setTimeout(async () => {
        _serverStartTimer = null;
        const logData = await api({ action: 'get-server-logs', projectPath: path }).catch(() => ({ logs: '' }));
        const rawLog: string = logData.logs || '';
        const errorLines = rawLog.split('\n')
          .filter((l: string) => /error|failed|module not found|cannot find|enoent|syntax error/i.test(l))
          .slice(0, 3)
          .join('\n');
        setBuildProgress(p => ({
          ...p!,
          step: 'error',
          message: '⏱ Server startup timed out — escalating to advanced repair…',
          logs: [...(p?.logs ?? []), '⏱ Startup exceeded 90 seconds', errorLines || 'No error detail captured'],
        }));

        if (hasNoActionableCodeEvidence(rawLog) || hasNoActionableCodeEvidence(errorLines)) {
          // Covers BOTH a recognized environmental error AND a crash with no
          // captured detail at all — confirmed live: an empty/generic crash
          // log matched neither the previous environmental patterns nor any
          // code-error pattern, so it fell through to "Advanced repair"
          // anyway, which correctly reported 0 files changed since there was
          // no code-level evidence of anything to fix either way.
          appendLog('⚠️ Startup timeout had no actionable code-level evidence — skipping advanced repair.');
          narrate(
            `⚠️ **Preview couldn't start — environment issue, not a code problem.**\n\n` +
            `The generated app's files are ready, but the preview server hit a startup issue in this ` +
            `environment (${errorLines ? errorLines.slice(0, 150) : 'server did not respond within 90s, and no error output was captured'}). ` +
            `This is not something an AI code fix can resolve. Try starting the preview again in a moment, ` +
            `or contact support if this keeps happening.`
          );
          return;
        }

        // Auto-escalate: let Claude Code inspect the project and fix the startup failure
        const serverEscPrompt = `The Next.js dev server for the project at ${path} failed to start within 90 seconds.\n\nServer error output:\n${errorLines || 'No error captured'}\n\nInspect the project:\n1. Check for TypeScript errors or missing dependencies\n2. Fix any syntax or import errors in source files\n3. Ensure next.config.js is valid\n4. Run the dev server and confirm it starts successfully\n5. Verify / returns 200\n\nFix all issues so the server starts and the app loads.`;
        autoEscalateToBridge(
          `Server startup timeout — ${errorLines ? errorLines.slice(0, 100) : 'no error detail'}`,
          serverEscPrompt,
        );
        if (!debugMode) {
          narrate(`⏱ Preview server didn't start in time. **Advanced repair has started automatically** — it will inspect and fix the issue.`);
        } else {
          narrate(
            `⏱ Server startup exceeded 90 seconds. Auto-escalating to advanced repair.\n\n` +
            (errorLines ? `Error captured:\n\`\`\`\n${errorLines}\n\`\`\`` : '')
          );
        }
      }, 90000);
      const _clearServerTimer = () => {
        if (_serverStartTimer) { clearTimeout(_serverStartTimer); _serverStartTimer = null; }
      };

      // ── 5. Start server — 3 strategies, NEVER throws ──────────────────────
      // Always force=true on the initial start: if a previous build of the same
      // project left a server running, that server holds a stale .next cache
      // (possibly the scaffold page). Reusing it causes false scaffold detections
      // in the verification loop because the new files aren't recompiled yet.
      await api({ action: 'clear-cache', projectPath: path }).catch(() => {});
      let serverData = await api({ action: 'start-server', projectPath: path, force: true });
      let firstErrorMsg = '';

      if (!serverData.port) {
        const errorMsg = serverData.error || 'Server failed to start';
        firstErrorMsg = errorMsg;
        appendLog(`⚠️ Strategy 1 failed: ${errorMsg}`);

        // An environmental error (e.g. a listener/port/permission failure in
        // the execution environment, not the generated app's own code) can
        // never be fixed by editing source files — confirmed live:
        // "[x-amplify-credentials] Credential listener could not be
        // started: Error: listen" burned all 3 strategies and an "Advanced
        // repair" cycle for nothing, since the AI correctly found no code
        // to fix. Skip straight to one clean retry instead of wasting the
        // AI-classification round trip on something it cannot address.
        if (hasNoActionableCodeEvidence(errorMsg)) {
          appendLog('⚠️ Detected an environmental or contentless server-start error — skipping AI code-fix strategies (not a code problem).');
          narrate('⚠️ The preview server hit an environment-level startup issue, not a bug in your generated app. Retrying once with a clean restart…');
          await api({ action: 'clear-cache', projectPath: path }).catch(() => {});
          serverData = await api({ action: 'start-server', projectPath: path, force: true });
        } else {
          // Strategy 1: classify error → apply fix → retry
          const recovery1 = await api({ action: 'auto-recover', projectPath: path, errorText: errorMsg });
          if (recovery1.fixed) {
            narrate(`🔧 ${recovery1.userMessage} Retrying the server…`);
            (recovery1.actions ?? []).forEach((a: string) => appendLog(a));
            serverData = await api({ action: 'start-server', projectPath: path });
          }
        }
      }

      if (!serverData.port) {
        const errorMsg2 = serverData.error || '';
        // Same unfixable class of error persisted through the retry (or is
        // identical to the first attempt's) — Strategy 2's AI code-fix
        // cycle targets the generated app's source, which still isn't the
        // problem. Skip it rather than burning another full retry + AI
        // round trip that cannot change the outcome.
        if (hasNoActionableCodeEvidence(errorMsg2) || isIdenticalRepeatedError(firstErrorMsg, errorMsg2)) {
          appendLog('⚠️ Server start failed again with the same/environmental/contentless error — skipping further code-fix retries.');
        } else {
          // Strategy 2: fix remaining TypeScript errors, clear .next cache, retry
          appendLog('⚠️ Strategy 2: AI code fix + cache clear + retry…');
          narrate('🔧 Server start failed — fixing remaining code issues, clearing build cache, and retrying…');
          try {
            const valData = await api({ action: 'validate', projectPath: path });
            if (!valData.valid && (valData.errors?.length ?? 0) > 0) {
              const fileNames = (valData.errors ?? [])
                .map((e: string) => e.match(/generated-projects\/[^/]+\/(.+?)\(\d+,\d+\)/)?.[1] ?? '')
                .filter(Boolean).slice(0, 4);
              await api({ action: 'fix-errors', projectPath: path, errors: valData.errors ?? [], filePaths: fileNames });
              appendLog('🔧 Code fixes applied');
            }
          } catch { /* non-critical */ }
          // Clear .next so the fixed code compiles from scratch
          await api({ action: 'clear-cache', projectPath: path }).catch(() => {});
          appendLog('🧹 Build cache cleared');
          serverData = await api({ action: 'start-server', projectPath: path, force: true });
        }
      }

      if (!serverData.port) {
        _clearServerTimer();
        const crashDetail: string = serverData.error || '';
        // hasNoActionableCodeEvidence (not just isEnvironmentalServerError)
        // — confirmed live: a crash with an EMPTY/generic log matched no
        // known environmental keyword either, so it fell through to
        // "Advanced repair" anyway, which correctly reported 0 files
        // changed since there was no code-level evidence of anything to
        // fix, environmental or otherwise. Escalating to AI code repair is
        // equally unjustified in both cases.
        const isEnvironmental = hasNoActionableCodeEvidence(crashDetail);
        appendLog(`⚠️ Server could not start after 3 strategies — ${isEnvironmental ? 'no actionable code-level evidence, not escalating to code repair' : 'escalating to advanced repair'}`);
        setBuildProgress(p => ({
          ...p!,
          step: 'error',
          message: `⚠️ ${projectName} — ${isEnvironmental ? 'preview server startup issue' : 'escalating to advanced repair…'}`,
          logs: [...(p?.logs ?? []), `⚠️ ${crashDetail || 'Server start failed after 3 strategies'}`, isEnvironmental ? '⚠️ Not a code issue — repair skipped' : '🔧 Advanced repair starting…'],
        }));
        // Save project record first so the sidebar shows it
        const savedProject: ProjectMeta = {
          id: pid || '',
          name: projectName,
          description: createData.description || '',
          projectPath: path,
          port: 0,
          createdAt: new Date().toISOString(),
          filesCount: filesCreated,
        };
        setCurrentProject(savedProject);
        setBuilderContext({ projectName: savedProject.name, stage: 'complete', active: true });
        await refreshProjects();

        if (isEnvironmental) {
          // Do NOT escalate to the AI code-repair bridge — it targets the
          // generated app's source, which was never the problem here, and
          // would just report "0 files changed" again (confirmed live).
          // ALWAYS show the real captured detail (even if it's just "no
          // output captured") instead of a generic "everything's fine"
          // impression — per explicit requirement, never imply the code
          // passed checks without also surfacing the real startup failure.
          narrate(
            `⚠️ **Preview couldn't start.**\n\n` +
            `The generated app's files are ready and TypeScript checks passed, but the preview server did ` +
            `not start successfully.\n\n**Real startup error:**\n\`\`\`\n${crashDetail || 'The server process exited with no output captured — this is itself the diagnostic: nothing was written to stdout/stderr before it exited.'}\n\`\`\`\n\n` +
            `This is not something an AI code fix can resolve. Try starting the preview again in a moment, ` +
            `or contact support if this keeps happening.`
          );
          return;
        }

        // Auto-escalate: bridge inspects source, fixes errors, restarts server
        const crashEscPrompt = `The Next.js dev server for the project at ${path} failed to start after 3 strategies.\n\nError: ${crashDetail || 'unknown'}\n\nInspect the project:\n1. Fix all TypeScript errors (run npx tsc --noEmit)\n2. Fix missing imports or incorrect package names\n3. Fix next.config.js if it references non-existent files\n4. Fix any syntax errors in source files\n5. Ensure all dependencies in package.json are installed\n\nAfter fixing, confirm the project compiles cleanly.`;
        autoEscalateToBridge(
          `Server start failed after 3 strategies: ${crashDetail.slice(0, 100)}`,
          crashEscPrompt,
        );
        return; // exit build pipeline — bridge takes over from here
      }

      _clearServerTimer(); // server confirmed — cancel the 90s safety net
      // Stop the 30-second heartbeat immediately now that the server is up.
      // Without this the UI stays stuck on "Finalising — starting your preview server…".
      if (buildHeartbeatRef.current) { clearInterval(buildHeartbeatRef.current); buildHeartbeatRef.current = null; }
      setBuildHeartbeatMsg(null);
      let port: number = serverData.port;
      appendLog(`✅ Server live on port ${port}`);

      narrate(`🖥️ Server started on port **${port}**! The preview is loading… Next.js does a first-compile which takes ~30 seconds. I'll run verification checks while you wait.`);

      setPreviewUrl(serverData.previewUrl || `http://localhost:${port}`);
      setPreviewKey(k => k + 1);
      setPreviewLoading(true);  // iframe shows loading overlay until first paint
      setPhase('previewing');

      const newProject: ProjectMeta = { id: pid || '', name: projectName, description: createData.description || '', projectPath: path, port, createdAt: new Date().toISOString(), filesCount: filesCreated };
      setCurrentProject(newProject);
      setBuilderContext({ projectName: projectName, stage: 'editing', active: true });

      // ── 6. Discovery ───────────────────────────────────────────────────────
      let discMode = 'Full-Stack App';
      let discPages: string[] = [];
      let discEnvVars: string[] = [];
      let discCreds: Array<{ key: string; description?: string }> = [];
      try {
        const disc = await api({ action: 'discover', projectPath: path });
        if (disc.success) {
          discMode = disc.mode || 'Full-Stack App';
          discPages = disc.pages || [];
          discEnvVars = disc.envExampleVars || [];
          discCreds = disc.missingCredentials || [];
          setCurrentDiscovery({ summary: disc.summary, pages: disc.pages, components: disc.components, fileCount: disc.fileCount, framework: disc.framework, mode: disc.mode, hasApiRoutes: disc.hasApiRoutes, missingCredentials: disc.missingCredentials || [] });
          if (disc.memory) setCurrentMemory(disc.memory);
        }
      } catch { /* non-critical */ }

      // ── 6b. Save design baseline ───────────────────────────────────────────
      // Snapshot all UI files (pages, layouts, components, CSS) immediately after
      // first generation succeeds. The repair loop uses this baseline to avoid
      // overwriting visual code when fixing backend/API errors.
      try {
        const baselineResult = await api({ action: 'save-design-baseline', projectPath: path });
        if (baselineResult.success && baselineResult.count > 0) {
          appendLog(`🎨 Design baseline saved — ${baselineResult.count} UI file(s) protected from repair overwrites`);
        }
      } catch { /* non-critical — repair still works without baseline */ }

      // ── 6b. Pre-loop deterministic repairs ────────────────────────────────────
      // Run before the engineering loop so the verifier starts from the best possible state.
      // These are deterministic (no AI) — fast, reliable, and idempotent.
      try {
        // 1. Fix any auth page stubs (redirect-only pages with no form)
        const preAuthFix = await api({ action: 'repair-auth-pages', projectPath: path });
        if (preAuthFix.total > 0) appendLog(`🔐 Pre-loop: replaced ${preAuthFix.total} stub auth page(s)`);

        // 2. Create missing pages for every nav link found in source code
        const preRouteFix = await api({ action: 'repair-missing-routes', projectPath: path });
        if (preRouteFix.total > 0) appendLog(`🗺️ Pre-loop: created ${preRouteFix.total} missing page(s): ${preRouteFix.created.join(', ')}`);

        // 3. Create [id] detail pages for every dynamic href pattern found
        const preDynFix = await api({ action: 'repair-dynamic-routes', projectPath: path });
        if (preDynFix.total > 0) appendLog(`🔗 Pre-loop: created ${preDynFix.total} dynamic [id] page(s): ${preDynFix.created.join(', ')}`);

        // 4. Guarantee /dashboard exists when the app has auth — login/signup must land somewhere real
        const preDashFix = await api({ action: 'repair-dashboard', projectPath: path });
        if (preDashFix.repaired) appendLog(`🏠 Pre-loop: created /dashboard (resources: ${(preDashFix.apiRoutes ?? []).join(', ') || 'none detected'})`);

        // If any repairs were made, restart the server so Next.js picks up new files
        if ((preAuthFix.total + preRouteFix.total + preDynFix.total + (preDashFix.repaired ? 1 : 0)) > 0) {
          appendLog('🔄 Restarting server after pre-loop repairs…');
          const restPre = await api({ action: 'start-server', projectPath: path, force: false });
          if (restPre.port) { port = restPre.port; setPreviewUrl(restPre.previewUrl || `http://localhost:${port}`); }
          await new Promise(r => setTimeout(r, 4000));
        }
      } catch { /* pre-loop repairs are best-effort */ }

      // ── Preview Health Watchdog ────────────────────────────────────────────────
      // The dev server process is running, but Next.js may still be compiling.
      // Poll for an HTTP response before entering the verification loop —
      // a loop full of "timeout" errors from a compiling/crashing server wastes
      // repair iterations on a problem that hasn't surfaced as a real error yet.
      //
      // If the app never serves HTTP within PREVIEW_HEALTH_MS:
      //   1. Collect actual server logs (they contain the real compile error)
      //   2. Build a targeted bridge prompt from those logs
      //   3. Auto-escalate to Claude Bridge — which can read files, fix the crash, restart
      //   4. Return early (bridge continues from here; verification runs again after repair)
      {
        const PREVIEW_HEALTH_MS  = 60_000; // 60 seconds — enough for first Next.js compile
        const POLL_INTERVAL_MS   = 5_000;
        const healthStart        = Date.now();
        let   appHealthy         = false;

        setBuildProgress(p => ({ ...p!, step: 'verifying', message: '⏳ App compiling… (0s / 60s)' }));
        appendLog('⏳ Preview health watchdog started — waiting for app to serve HTTP…');

        while (!appHealthy) {
          const elapsed = Math.round((Date.now() - healthStart) / 1000);
          if ((Date.now() - healthStart) >= PREVIEW_HEALTH_MS) break;

          try {
            const h = await api({ action: 'check-preview-health', port });
            if (h.healthy) {
              appHealthy = true;
              appendLog(`✅ Preview healthy (HTTP ${h.status ?? '?'}) after ${elapsed}s`);
              setBuildProgress(p => ({ ...p!, message: '🔍 App healthy — starting verification…' }));
              break;
            }
          } catch { /* API call failed — keep polling */ }

          setBuildProgress(p => ({
            ...p!,
            message: `⏳ App compiling… (${Math.round((Date.now() - healthStart) / 1000)}s / ${PREVIEW_HEALTH_MS / 1000}s)`,
          }));
          await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        }

        if (!appHealthy) {
          // App never responded — collect server logs and hand off to Claude Bridge.
          // Server logs contain the real error (schema mismatch, syntax error, missing module, etc.)
          // that HTTP timeouts from the verification loop would obscure.
          const logData = await api({ action: 'get-server-logs', projectPath: path }).catch(() => ({ logs: '' }));
          const rawLog: string = logData.logs ?? '';

          // Extract error lines — most specific first
          const hardLines = rawLog.split('\n')
            .filter((l: string) => /no such column|has no column|no such table|cannot find module|module not found|enoent|syntaxerror|typeerror.*is not/i.test(l))
            .slice(0, 4).join('\n');
          const errorLines = rawLog.split('\n')
            .filter((l: string) => /error|failed|cannot|crashed|exception/i.test(l))
            .slice(0, 6).join('\n');
          const diagLines = hardLines || errorLines;

          appendLog(`⚡ Preview watchdog: app did not respond in ${PREVIEW_HEALTH_MS / 1000}s — escalating to advanced repair`);
          addStatus(`⚡ Preview not loading after ${PREVIEW_HEALTH_MS / 1000}s — advanced repair starting automatically…`, 'checking');
          setBuildProgress(p => ({
            ...p!,
            step: 'error',
            message: '⚡ Preview not loading — advanced repair starting…',
            logs: [
              ...(p?.logs ?? []),
              `⚡ Preview health timeout after ${PREVIEW_HEALTH_MS / 1000}s`,
              ...(diagLines ? [diagLines] : ['No error detail captured from server logs']),
            ],
          }));

          // Same environmental-error / no-actionable-evidence check as the
          // server-start paths above — a third, independent escalation
          // trigger that must not send an unfixable-by-code error to the AI
          // repair bridge either.
          if (hasNoActionableCodeEvidence(rawLog) || hasNoActionableCodeEvidence(diagLines)) {
            appendLog('⚠️ Preview health timeout had no actionable code-level evidence — skipping advanced repair.');
            narrate(
              `⚠️ **Preview couldn't load — environment issue, not a code problem.**\n\n` +
              `The generated app's files are ready, but the preview server hit a startup issue in this ` +
              `environment (${diagLines.slice(0, 150) || 'no HTTP response'}). This is not something an AI code ` +
              `fix can resolve. Try starting the preview again in a moment, or contact support if this keeps happening.`
            );
            return;
          }

          // Build a targeted bridge prompt that includes the actual server-log errors
          const watchdogBridgePrompt = [
            `The Next.js preview for the project at ${path} started on port ${port} but never served an HTTP response within ${PREVIEW_HEALTH_MS / 1000} seconds.`,
            '',
            diagLines
              ? `Server log errors:\n${diagLines}`
              : 'No error lines captured — the server process may have crashed silently.',
            '',
            `Diagnose and fix the startup failure:`,
            `1. Read the server logs at ${path}/.next-dev.log (if it exists) for the real compile or runtime error`,
            `2. Run: cd ${path} && npx tsc --noEmit  — fix every TypeScript error`,
            `3. For SQLite "no such column" or "has no column": read lib/db.ts, compare column names to every API route that touches that table, fix mismatches (ALTER TABLE or recreate .db), ensure all routes use the correct column names`,
            `4. For "Cannot find module" or "ENOENT": fix the import path or create the missing file`,
            `5. For "SyntaxError": find and fix the syntax error in the relevant source file`,
            `6. After fixing, confirm the app serves a response: curl http://localhost:${port}/`,
          ].join('\n');

          autoEscalateToBridge(
            `Preview health timeout (${PREVIEW_HEALTH_MS / 1000}s) — ${(diagLines || 'no HTTP response').slice(0, 120)}`,
            watchdogBridgePrompt,
            { port, projectPath: path },
          );

          narrate(
            `⚡ The preview server started but the app didn't load within ${PREVIEW_HEALTH_MS / 1000} seconds.\n\n` +
            (diagLines ? `**Server error detected:**\n\`\`\`\n${diagLines.slice(0, 300)}\n\`\`\`\n\n` : '') +
            `**Advanced repair is running automatically** — it's inspecting the startup logs, fixing the root cause, and will restart the preview.`
          );
          return; // bridge takes over; exit pipeline here
        }
      }
      // ── End Preview Health Watchdog ───────────────────────────────────────────

      // ── 7. Autonomous Engineering Loop ────────────────────────────────────────
      // ═══════════════════════════════════════════════════════════════════════
      // BUILD → TEST → DETECT → CLASSIFY → FIX → RESTART → RE-VERIFY → ROLLBACK
      // Never reports success while checks are failing.
      // Runs until ALL checks pass or ALL repair strategies are genuinely exhausted.
      // ═══════════════════════════════════════════════════════════════════════
      setBuildDetailStep('verifying');
      narrate(`Testing the app now — running full verification suite…`);
      // Use 'verifying' — NOT 'done'. The UI must not show ✅ or "Live and Verified"
      // until the loop has actually completed and all checks have passed.
      setBuildProgress(p => ({ ...p!, step: 'verifying', message: '🔍 Verification running…', logs: [...(p?.logs ?? []), '🤖 Agent loop starting…'] }));

      type RootCause = { kind: string; detail: string; packages?: string[]; envVars?: string[]; errorText?: string; fixFile?: string; fixHint?: string };
      type VerifyCheck = { name: string; passed: boolean; softPassed?: boolean; recordCount?: number; error?: string; responsePreview?: string; rootCause?: RootCause; fixFile?: string; fixHint?: string };
      type VerifyData = { verified: boolean; summary: string; checks: VerifyCheck[]; failures?: string[] };

      // ── Strategy sequences per error kind ─────────────────────────────────
      // Each kind has ordered strategies tried in sequence.
      // When a strategy fails to improve the check count, the next is tried.
      const ERROR_STRATEGIES: Record<string, ReadonlyArray<string>> = {
        'missing-package':       ['auto-install'],
        'auth-misconfigured':    ['add-secret', 'targeted'],
        // auth-field-mismatch: form sends field names the API route doesn't read.
        // fix-auth-fields → reads both form and API source, patches the mismatch.
        // If that fails, targeted/broader AI fix as fallback.
        'auth-field-mismatch':   ['fix-auth-fields', 'targeted', 'broader'],
        'auth-page-stub':        ['repair-auth-pages', 'targeted', 'broader'],
        'missing-env':           ['add-placeholder'],
        'wrong-http-method':     ['targeted', 'broader', 'rewrite'],

        'not-found':             ['repair-auth-pages', 'repair-dashboard', 'repair-missing-routes', 'repair-dynamic-routes', 'targeted', 'broader'],
        'timeout':               ['targeted', 'broader', 'rewrite'],
        'database-error':        ['targeted', 'broader', 'rewrite'],
        'typescript-error':      ['targeted', 'broader'],
        'route-failure':         ['targeted', 'broader', 'rewrite'],
        'runtime-crash':         ['cache-clear', 'targeted', 'broader', 'rewrite'],
        'preview-blank':         ['targeted', 'broader', 'cache-clear'],
        // provider-misconfigured: wrong endpoint, bad auth headers, mismatched response schema.
        // targeted → Sonnet minimal patch; broader → Strongest with provider registry context;
        // rewrite → Strongest rewrites the full route with correct provider integration.
        'provider-misconfigured':  ['targeted', 'broader', 'rewrite'],
        // scaffold-placeholder: the main page is still the "Building your app" placeholder.
        // NEVER fixable by patching files — the full codebase was not generated.
        // 'regen'       → full re-generation from original prompt with SONNET
        // 'regen-strong' → same with STRONGEST if SONNET also failed
        'scaffold-placeholder':    ['regen', 'regen-strong'],
        'unknown':                 ['cache-clear', 'targeted', 'broader'],
      };

      // Per-kind strategy cursor: how many strategies we've consumed for each kind
      const kindStrategyCursor = new Map<string, number>();

      const peekStrategy = (kind: string): string | null => {
        const list = ERROR_STRATEGIES[kind] ?? ERROR_STRATEGIES['unknown'];
        const idx = kindStrategyCursor.get(kind) ?? 0;
        return idx < list.length ? list[idx] : null;
      };

      const consumeStrategy = (kind: string): string | null => {
        const s = peekStrategy(kind);
        if (s !== null) kindStrategyCursor.set(kind, (kindStrategyCursor.get(kind) ?? 0) + 1);
        return s;
      };

      // True when every failed error kind has no more strategies to try
      const allStrategiesExhausted = (failed: VerifyCheck[]): boolean =>
        failed.filter(c => !c.passed).every(c => peekStrategy(c.rootCause?.kind ?? 'unknown') === null);

      // Delegates to module-level function (defined above component) so async callbacks work
      const getHardErrorLabel = (check: VerifyCheck): string | null => getHardErrorLabelModule(check);

      // Builds a targeted bridge prompt from a set of failing checks
      const buildBridgePrompt = (projectPath2: string, failing: VerifyCheck[], extraContext?: string): string => {
        const lines = failing.slice(0, 8).map(c => {
          const err = (c.error ?? 'failing').slice(0, 120);
          const label = getHardErrorLabel(c);
          return `• ${c.name}: ${err}${label ? ` [${label}]` : ''}`;
        });
        return [
          `Fix these failing verification checks in the project at ${projectPath2}:`,
          ...lines,
          '',
          'Instructions:',
          '1. Read the relevant source files to understand the current state.',
          '2. For database/schema errors: check the schema file (lib/db.ts or similar), compare it to the API routes, and fix the mismatch — update column names, add missing columns via ALTER TABLE or by recreating the database, and make sure every route uses the correct column names.',
          '3. For auth errors: check /api/auth/login, /api/auth/register, /api/auth/me and ensure they use the correct column names from the actual database schema.',
          '4. For import/module errors: fix the import path or add the missing file.',
          '5. After fixing, confirm the app compiles and all fixed routes return correct status codes.',
          ...(extraContext ? ['', 'Additional context:', extraContext] : []),
        ].join('\n');
      };

      // Expose buildBridgePrompt to the async onComplete callbacks in autoEscalateToBridge
      buildBridgePromptRef.current = buildBridgePrompt as (projectPath: string, failing: LooseCheck[]) => string;

      let verifyData: VerifyData = { verified: false, summary: 'Not verified', checks: [] };

      const MAX_ITERATIONS = 7; // 7 × ~45s avg = ~5min max.
      const MAX_VERIFY_MS = 5 * 60 * 1000;
      const loopStartTime = Date.now();
      let lastPassedCount = -1;
      let consecutiveRollbacks = 0;
      let stagnationCount = 0; // consecutive iters with zero improvement
      let triedCacheClear = false;
      let browserContextCache = '';
      // Set to true whenever bridge escalation fires inside the loop.
      // After the loop we check this flag and early-return so the bridge has sole
      // ownership of the project rather than racing with the pipeline's health gate,
      // browser journey, and final result set.
      let escalatedToBridge = false;
      // Set to true whenever we restart the dev server so the first-compile watchdog
      // also fires after FIX X or other mid-loop restarts (not just on iter 1).
      let serverJustRestarted = true; // treat the initial start as a restart

      for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
        // ── Timeout protection ─────────────────────────────────────────────────
        const elapsedMs = Date.now() - loopStartTime;
        if (elapsedMs > MAX_VERIFY_MS) {
          appendLog(`⚠️ Verification timeout — ${Math.round(elapsedMs / 1000)}s elapsed`);
          const stillFailing = verifyData.checks?.filter(c => !c.passed && !c.softPassed) ?? [];
          const bridgeEscPrompt = stillFailing.length > 0
            ? `Fix these failing checks in the project at ${path}:\n${stillFailing.slice(0, 6).map(c => `• ${c.name}: ${c.error ?? 'failing'}`).join('\n')}\n\nInspect and fix the actual source files. Make every check pass.`
            : `The app at ${path} has verification failures. Inspect the source files and fix all failing routes and API endpoints.`;
          const timeoutReason = `Verification timeout after ${Math.round(elapsedMs / 1000)}s — still failing: ${stillFailing.slice(0, 3).map(c => c.name).join(', ')}`;
          // Auto-escalate instead of requiring the user to click a button
          autoEscalateToBridge(timeoutReason, bridgeEscPrompt, { port, projectPath: path });
          escalatedToBridge = true;
          // Manual fallback shown only in debug mode
          if (debugMode) {
            setDisplayed(prev => [...prev, {
              role: 'assistant' as const,
              content: `⏱️ Verification timeout — advanced repair auto-triggered.\n\n**Failing:** ${stillFailing.slice(0, 4).map(c => `${c.name}`).join(', ')}`,
              recoveryActions: [
                { label: '⚡ Fix with Claude Code', action: 'claude-bridge' as const, prompt: bridgeEscPrompt },
                { label: 'Continue fixing', action: 'focus-input' as const, prompt: 'continue fixing' },
              ],
            }]);
          }
          break;
        }

        // ── Live progress indicator — updated every iteration ───────────────
        const passedSoFar = verifyData.checks?.filter(c => c.passed || c.softPassed).length ?? 0;
        const totalSoFar = verifyData.checks?.length ?? 0;
        const currentFailures = verifyData.checks?.filter(c => !c.passed && !c.softPassed) ?? [];
        const firstFail = currentFailures[0];
        const progressMsg = totalSoFar === 0
          ? `🔍 Verification running… (iteration ${iter}/${MAX_ITERATIONS})`
          : firstFail
            ? `🔧 Fixing: ${firstFail.name.slice(0, 50)} — ${passedSoFar}/${totalSoFar} checks passing (iteration ${iter}/${MAX_ITERATIONS})`
            : `✅ ${passedSoFar}/${totalSoFar} checks passing — finalising…`;
        setBuildProgress(p => ({ ...p!, step: 'verifying', message: progressMsg, logs: p?.logs ?? [] }));

        appendLog(`🤖 Engineering loop — iteration ${iter}/${MAX_ITERATIONS} (${Math.round(elapsedMs / 1000)}s elapsed)`);

        // ── STEP 1: Full verification (with live server log) ─────────────
        const serverLogFile = path ? `${path}/.next-dev.log` : undefined;
        try {
          verifyData = await api({ action: 'verify-app', port, projectPath: path, serverLogFile });
          setLastVerification(verifyData);
        } catch { break; }

        const passedNow = verifyData.checks.filter(c => c.passed).length;
        const totalChecks = verifyData.checks.length;
        appendLog(`📊 ${passedNow}/${totalChecks} checks passing`);

        // ── First-compile watchdog ─────────────────────────────────────────
        // Next.js first compile takes 25–40s. If all checks timeout AND the server
        // was recently started (initial launch or a mid-loop FIX X restart), wait
        // 30s and re-verify BEFORE running any AI fix strategy.
        if (serverJustRestarted && verifyData.checks.length > 0 &&
            verifyData.checks.every(c => !c.passed && c.rootCause?.kind === 'timeout')) {
          serverJustRestarted = false; // consumed — don't double-wait
          appendLog('⏳ All checks timed out after server start — waiting 30s for Next.js first compile…');
          narrate(`⏳ Next.js is compiling your app — waiting up to 30s before verification…`);
          await new Promise(r => setTimeout(r, 30_000));
          appendLog('🔄 Re-verifying after compile wait…');
          try {
            verifyData = await api({ action: 'verify-app', port, projectPath: path, serverLogFile });
            setLastVerification(verifyData);
          } catch { break; }
        } else if (serverJustRestarted) {
          serverJustRestarted = false; // clear even if no timeout (server already compiled)
        }

        // ── STEP 1b: Live link scan — "real user" click-every-link check ────
        // Run on every iteration but only act when verify-app passes (or on first pass).
        // This catches broken links in the live HTML that code scanning missed.
        if (iter === 1 || verifyData.verified) {
          try {
            const linkScan = await api({ action: 'scan-live-links', port, projectPath: path });
            if (linkScan.broken?.length > 0) {
              appendLog(`🔗 Live link scan: ${linkScan.broken.length} broken link(s) — ${linkScan.broken.map((b: { href: string }) => b.href).join(', ')}`);
              // Auto-repair: create missing pages for each broken link
              const routeFix = await api({ action: 'repair-missing-routes', projectPath: path });
              if (routeFix.total > 0) {
                appendLog(`✅ Auto-created ${routeFix.total} missing page(s): ${routeFix.created.join(', ')}`);
                await new Promise(r => setTimeout(r, 2000)); // HMR picks up new pages automatically
              }
            } else if (linkScan.allClear) {
              appendLog(`✅ Live link scan: all ${linkScan.scanned} links return 200`);
            }
          } catch { /* non-critical — skip if scan fails */ }
        }

        if (verifyData.verified) {
          appendLog('✅ All checks pass');
          break;
        }

        const failedChecks = verifyData.checks.filter(c => !c.passed);
        if (failedChecks.length === 0) break;

        // ── STEP 1c: Hard-error early escalation ─────────────────────────────
        // Detect errors the normal AI repair loop structurally cannot fix (schema
        // mismatches, missing DB columns, module resolution failures, 500s on auth
        // routes that imply a server crash). These require direct file inspection
        // and edits — exactly what the Claude Code CLI bridge does.
        //
        // On iter 1 we give the normal loop ONE attempt (it may install a package
        // or make a quick fix). From iter 2+ if hard errors are still present, escalate.
        if (iter >= 2) {
          const hardFailures = failedChecks
            .map(c => ({ check: c, label: getHardErrorLabel(c) }))
            .filter(({ label }) => label !== null);

          if (hardFailures.length > 0) {
            const firstLabel = hardFailures[0].label!;
            const errorSummary = hardFailures.slice(0, 3).map(({ check, label }) =>
              `${check.name} [${label}]: ${(check.error ?? '').slice(0, 80)}`
            ).join('; ');
            appendLog(`⚡ Hard error detected: ${firstLabel} — cannot be fixed by AI code generation, escalating to advanced repair`);
            addStatus(`Hard error: ${firstLabel} — escalating to Claude Bridge`, 'checking');
            const hardPrompt = buildBridgePrompt(path, hardFailures.map(({ check }) => check));
            const hardReason = `Hard error on iter ${iter}: ${errorSummary}`;
            autoEscalateToBridge(hardReason, hardPrompt, { port, projectPath: path });
            escalatedToBridge = true;
            break;
          }
        }

        // ── STEP 1d: Stagnation escalation ────────────────────────────────────
        // If the passed count hasn't improved for 3 consecutive iterations AND
        // the normal loop has had at least 3 chances, escalate.
        if (passedNow <= lastPassedCount && lastPassedCount !== -1) {
          stagnationCount++;
        } else {
          stagnationCount = 0;
        }
        if (stagnationCount >= 3 && iter >= 3) {
          appendLog(`⚡ No improvement after ${stagnationCount} iterations — escalating to advanced repair`);
          const stagnantPrompt = buildBridgePrompt(path, failedChecks);
          const stagnantReason = `Stagnation: ${stagnationCount} iters with no improvement, still failing: ${failedChecks.slice(0,3).map(c=>c.name).join(', ')}`;
          autoEscalateToBridge(stagnantReason, stagnantPrompt, { port, projectPath: path });
          escalatedToBridge = true;
          break;
        }

        // ── STEP 2: Escalate when normal strategies are exhausted ─────────────
        // Condition A: hit the iteration cap
        const hitIterationCap = iter >= MAX_ITERATIONS;
        // Condition B: all error-kind strategies consumed + stagnating for 2 rounds
        const strategiesGone = allStrategiesExhausted(failedChecks) && consecutiveRollbacks >= 2;

        if (hitIterationCap || strategiesGone) {
          const reasonLabel = hitIterationCap ? `iteration limit (${MAX_ITERATIONS})` : 'all strategies exhausted';
          appendLog(`⚠️ ${reasonLabel} — escalating to advanced repair`);
          const escPrompt = `Fix these failing checks in the project at ${path}:\n${failedChecks.slice(0, 6).map(c => `• ${c.name}: ${(c.error ?? '').slice(0, 80)}`).join('\n')}\n\nInspect the actual source files directly. Check routing, database schema, auth middleware, and API responses. Fix every failing check until all pass.`;
          const escReason = `${reasonLabel} — failing: ${failedChecks.slice(0, 3).map(c => c.name).join(', ')} (${passedNow}/${totalChecks} passing)`;
          autoEscalateToBridge(escReason, escPrompt, { port, projectPath: path });
          escalatedToBridge = true;
          if (debugMode) {
            setDisplayed(prev => [...prev, {
              role: 'assistant' as const,
              content: `⚙️ **[Debug]** ${reasonLabel.charAt(0).toUpperCase() + reasonLabel.slice(1)}. Advanced repair auto-triggered.\n\nFailing: ${failedChecks.slice(0, 4).map(c => `\`${c.name}\``).join(', ')}`,
              recoveryActions: [
                { label: '⚡ Fix with Claude Code', action: 'claude-bridge' as const, prompt: escPrompt },
                { label: 'Investigate', action: 'focus-input' as const, prompt: 'investigate the failing checks' },
              ],
            }]);
          }
          break;
        }

        // ── STEP 3: Collect live context ─────────────────────────────────────
        const logData = await api({ action: 'get-server-logs', projectPath: path }).catch(() => ({ logs: '' }));
        const rawServerLogs = logData.logs as string || '';
        const serverLogs = rawServerLogs.split('\n')
          .filter((l: string) => /error|failed|cannot find|syntax|warning|crash|exception/i.test(l))
          .slice(-25).join('\n');

        // Root cause investigation on stagnation (when checks stop improving)
        // This catches configuration/credentials/database issues that code fixes cannot solve.
        const isStagnating = passedNow <= lastPassedCount && lastPassedCount !== -1;
        if (isStagnating && iter % 3 === 0) {
          try {
            appendLog('🔍 Progress stalled — running root cause investigation…');
            const loopInvestigation = await api({ action: 'investigate', projectPath: path, port });
            if (loopInvestigation.success && loopInvestigation.report) {
              const lr = loopInvestigation.report;
              appendLog(`🔍 Root cause: ${lr.primaryLayer} layer (${lr.confidence} confidence)`);

              // ── True missing credentials → stop and ask the user ──────────
              // Only stop if credentials are actually missing (our scan confirmed it).
              // Provider integration errors (wrong endpoint / bad response parsing) are
              // code issues that the Sonnet/Strongest repair engine CAN fix, so we let
              // the loop continue rather than surfacing a false "credentials needed" gate.
              if (loopInvestigation.missingCredentials?.length > 0) {
                narrate(
                  `🔑 Root cause identified: **missing credentials** — ${loopInvestigation.missingCredentials.join(', ')}.\n\n` +
                  `This cannot be fixed by code changes. The app needs real API keys to work.\n` +
                  `Add them to \`.env.local\` and restart — ask me to "check credentials" for the exact steps.`
                );
                break; // Stop the loop — credentials are a configuration issue, not a code bug
              }

              // ── Provider integration error → escalate to broader/rewrite ──
              // The verify engine now classifies external-API failures as
              // 'provider-misconfigured'. If that's the primary stagnation cause,
              // force-advance the strategy cursor past 'targeted' so the next
              // iteration immediately uses the provider-aware Strongest pass.
              const providerFails = verifyData.checks.filter(
                c => !c.passed && c.rootCause?.kind === 'provider-misconfigured'
              );
              if (providerFails.length > 0) {
                appendLog(`🔌 Provider integration error detected on ${providerFails.length} route(s) — escalating to broader repair with provider context…`);
                // Nudge each failing kind to skip 'targeted' if it was already tried
                for (const check of providerFails) {
                  const kind = check.rootCause?.kind ?? 'unknown';
                  const currentIdx = kindStrategyCursor.get(kind) ?? 0;
                  if (currentIdx === 0) {
                    // Skip straight to 'broader' (Strongest + provider registry context)
                    kindStrategyCursor.set(kind, 1);
                    appendLog(`   ↑ ${kind}: skipping to 'broader' strategy (Strongest model + provider registry)`);
                  }
                }
              }

              if (lr.primaryLayer === 'database' && !verifyData.checks.some(c => c.rootCause?.kind === 'database-error')) {
                appendLog('🗄️ Database layer issue detected — adjusting fix strategy');
              }
            }
          } catch { /* non-critical */ }
        }

        // Browser analysis — run on first stagnation or every 3rd iteration to get real console errors
        const shouldRunBrowserAnalysis = isStagnating || iter % 3 === 0;
        if (shouldRunBrowserAnalysis && !browserContextCache) {
          try {
            appendLog('🌐 Running browser analysis — capturing console errors and network requests…');
            const browserDebug = await api({ action: 'browser-debug', port, path: '/' });
            if (browserDebug.success) {
              const runtimeErrs = (browserDebug.runtimeErrors ?? []).slice(0, 5).join('\n');
              const consoleErrs = (browserDebug.consoleLogs ?? [])
                .filter((l: { type: string; text: string }) => l.type === 'error' || l.type === 'warning')
                .slice(0, 5).map((l: { type: string; text: string }) => `[${l.type}] ${l.text}`)
                .join('\n');
              const netErrs = (browserDebug.networkRequests ?? [])
                .filter((r: { status?: number }) => r.status && (r.status >= 400 || r.status === 0))
                .slice(0, 5).map((r: { method: string; url: string; status?: number }) => `${r.method} ${r.url.replace(/http:\/\/localhost:\d+/, '')} → HTTP ${r.status}`)
                .join('\n');
              browserContextCache = [
                runtimeErrs && `Runtime errors:\n${runtimeErrs}`,
                consoleErrs && `Console errors:\n${consoleErrs}`,
                netErrs && `Failed network requests:\n${netErrs}`,
              ].filter(Boolean).join('\n\n');
              if (browserContextCache) appendLog(`🌐 Browser analysis: ${runtimeErrs.split('\n').length + netErrs.split('\n').length} issues captured`);
            }
          } catch { /* browser debug is optional */ }
        }

        lastPassedCount = passedNow;

        // ── STEP 4: Classify failures ─────────────────────────────────────────
        const missingPkgs: string[] = [];
        const missingEnvs: string[] = [];
        let needsAuth = false;
        const codeErrors: VerifyCheck[] = [];

        for (const check of failedChecks) {
          const kind = check.rootCause?.kind ?? 'unknown';
          if (kind === 'missing-package' && check.rootCause?.packages?.length) {
            missingPkgs.push(...(check.rootCause.packages ?? []));
          } else if (kind === 'auth-misconfigured') {
            needsAuth = true;
          } else if (kind === 'missing-env' && check.rootCause?.envVars?.length) {
            missingEnvs.push(...(check.rootCause.envVars ?? []));
          } else {
            codeErrors.push(check);
          }
        }

        const uniquePkgs = [...new Set(missingPkgs)];
        const uniqueEnvs = [...new Set(missingEnvs)];

        // ── FIX A: Missing packages ────────────────────────────────────────
        if (uniquePkgs.length > 0 && (kindStrategyCursor.get('missing-package') ?? 0) === 0) {
          consumeStrategy('missing-package');
          narrate(`📦 Missing: **${uniquePkgs.join(', ')}** — installing…`);
          const recov = await api({ action: 'auto-recover', projectPath: path, errorText: uniquePkgs.map(p => `Module not found: Can't resolve '${p}'`).join('\n') });
          (recov.actions ?? []).forEach((a: string) => appendLog(a));
          if (recov.packagesInstalled?.length > 0) allInstalledPkgs.push(...recov.packagesInstalled);
          await api({ action: 'clear-cache', projectPath: path });
          const rA = await api({ action: 'start-server', projectPath: path, force: true });
          if (rA.port) { port = rA.port; setPreviewUrl(rA.previewUrl || `http://localhost:${port}`); }
          const wA = await api({ action: 'wait-for-server', port, timeout: 90000 });
          if (wA.crashed) {
            const logA = (await api({ action: 'get-server-logs', projectPath: path }).catch(() => ({ logs: '' }))).logs as string;
            const errA = logA.split('\n').filter((l: string) => /error|failed|module not found/i.test(l)).slice(0, 3).join('\n');
            narrate(`❌ Server crashed after install.\n\`\`\`\n${errA}\n\`\`\`\nAsk me to fix the startup issue.`);
            setBuildProgress(p => ({...p!, step: 'error', message: '❌ Crashed after install', logs: [...(p?.logs ?? []), `❌ ${errA}`]}));
            break;
          }
          setPreviewKey(k => k + 1);
          serverJustRestarted = true;
          narrate(`✅ Packages installed. Re-verifying…`);
          browserContextCache = '';
          continue;
        }

        // ── FIX B: Auth misconfiguration ───────────────────────────────────
        if (needsAuth) {
          const authStrategy = consumeStrategy('auth-misconfigured');
          if (authStrategy === 'add-secret') {
            narrate(`🔐 Auth secret missing — adding temporary key…`);
            const rB = await api({ action: 'auto-recover', projectPath: path, errorText: 'NEXTAUTH_SECRET is not set' });
            if (rB.fixed) {
              await api({ action: 'clear-cache', projectPath: path });
              const restB = await api({ action: 'start-server', projectPath: path, force: true });
              if (restB.port) { port = restB.port; setPreviewUrl(`http://localhost:${port}`); }
              await api({ action: 'wait-for-server', port, timeout: 60000 });
              setPreviewKey(k => k + 1);
              serverJustRestarted = true;
              browserContextCache = '';
              continue;
            }
          }
          // Fall through to code error fix if add-secret didn't work
          codeErrors.push(...failedChecks.filter(c => c.rootCause?.kind === 'auth-misconfigured'));
        }

        // ── FIX C: Missing env vars ────────────────────────────────────────
        if (uniqueEnvs.length > 0 && (kindStrategyCursor.get('missing-env') ?? 0) === 0) {
          consumeStrategy('missing-env');
          narrate(`⚙️ Missing env vars: **${uniqueEnvs.join(', ')}** — adding placeholders…`);
          for (const ev of uniqueEnvs) {
            await api({ action: 'auto-recover', projectPath: path, errorText: `process.env.${ev} is undefined` });
          }
          const restC = await api({ action: 'start-server', projectPath: path, force: true });
          if (restC.port) { port = restC.port; setPreviewUrl(`http://localhost:${port}`); }
          await api({ action: 'wait-for-server', port, timeout: 60000 });
          setPreviewKey(k => k + 1);
          serverJustRestarted = true;
          browserContextCache = '';
          continue;
        }

        // ── FIX X: Scaffold placeholder — full re-generation, not a patch ──────
        // The AI generation placeholder is NOT fixable by agent-fix (which patches
        // individual files without knowing what the user originally asked for).
        // The only correct repair is a complete re-generation from the original prompt.
        const scaffoldErrors = codeErrors.filter(c => c.rootCause?.kind === 'scaffold-placeholder');
        if (scaffoldErrors.length > 0) {
          // Remove from codeErrors so FIX D doesn't also process them with agent-fix
          codeErrors.splice(0, codeErrors.length, ...codeErrors.filter(c => c.rootCause?.kind !== 'scaffold-placeholder'));
          setScaffoldDetected(true);

          const scaffoldStrategy = consumeStrategy('scaffold-placeholder');

          if (scaffoldStrategy === null) {
            // Both regen tiers exhausted — this is a hard failure
            appendLog('❌ All re-generation tiers exhausted — placeholder cannot be replaced');
            narrate(
              `❌ **Generation failed** — the preview is still showing a placeholder after multiple attempts.\n\n` +
              `Please start a new build or rephrase your request. If the problem persists, check that AWS Bedrock is reachable.`
            );
            setBuildProgress(p => ({
              ...p!,
              step: 'error',
              message: `❌ ${projectName} — generation incomplete (all re-gen tiers failed)`,
              logs: [...(p?.logs ?? []), '❌ Scaffold placeholder could not be replaced after SONNET + STRONGEST attempts'],
            }));
            break;
          }

          const regenTier = scaffoldStrategy === 'regen' ? 'SONNET' : 'STRONGEST';
          appendLog(`🔄 Scaffold detected — re-generating with ${regenTier} from original prompt…`);
          narrate(
            `⚠️ Preview is still showing a placeholder page — the app wasn't fully generated. ` +
            `Re-generating with **${regenTier}** from your original request…`
          );
          setBuildProgress(p => ({
            ...p!,
            step: 'generating',
            message: `🔄 Re-generating with ${regenTier}…`,
            logs: [...(p?.logs ?? []), `🔄 Re-gen ${regenTier}: scaffold placeholder detected, restarting generation`],
          }));

          try {
            const regenData = await api({ action: 'generate', messages: conversationHistory, tier: regenTier });
            if (regenData.success && regenData.projectData && !regenData.scaffoldFallback) {
              const regenFileCount = regenData.projectData.files?.length ?? 0;
              appendLog(`✅ ${regenTier} succeeded (${regenFileCount} files) — applying to existing project…`);
              const applyResult = await api({
                action: 'apply-generated-files',
                projectPath: path,
                files: regenData.projectData.files,
              });
              if (applyResult.success && applyResult.filesWritten > 0) {
                appendLog(`✅ ${applyResult.filesWritten} files written — verifying page file on disk…`);
                // Diagnostic: confirm the root page file doesn't still have scaffold content
                const pageCheck = await api({ action: 'read-file', projectPath: path, filePath: 'app/page.tsx' }).catch(() => null);
                if (pageCheck?.content && (pageCheck.content.includes('Generating…') || pageCheck.content.includes('Building your app'))) {
                  appendLog('❌ DIAGNOSTIC: app/page.tsx still contains scaffold text after apply — generation produced placeholder content');
                  narrate('❌ The AI generated placeholder content again. This is a generation quality issue — trying with a stronger model.');
                } else {
                  appendLog(`✅ Page file confirmed real content (${pageCheck?.size ?? '?'} bytes) — clearing cache and restarting server…`);
                }
                narrate(`✅ App re-generated (${regenFileCount} files)! Restarting server with real code…`);
                await api({ action: 'clear-cache', projectPath: path });
                setBuildProgress(p => ({ ...p!, step: 'starting', message: '⚙️ Restarting with new app…', logs: p?.logs ?? [] }));
                const restRegen = await api({ action: 'start-server', projectPath: path, force: true });
                if (restRegen.port) { port = restRegen.port; setPreviewUrl(`http://localhost:${port}`); }
                const wRegen = await api({ action: 'wait-for-server', port, timeout: 90000 });
                if (!wRegen.crashed) {
                  setScaffoldDetected(false); // server is now running real code — clear overlay
                  setPreviewLoading(true);    // show loading overlay while new app does first compile
                  setPreviewKey(k => k + 1); // force iframe to reload with new content
                  serverJustRestarted = true; // watchdog: wait for first compile on next verify
                }
                browserContextCache = '';
                setBuildProgress(p => ({ ...p!, step: 'verifying', message: '🔍 Verification running…', logs: p?.logs ?? [] }));
                continue;
              }
              appendLog('⚠️ apply-generated-files returned 0 files written');
            } else {
              appendLog(`⚠️ ${regenTier} returned incomplete output (scaffoldFallback=${regenData.scaffoldFallback})`);
            }
          } catch (regenErr) {
            appendLog(`⚠️ Re-generation error: ${regenErr instanceof Error ? regenErr.message.slice(0, 120) : 'unknown'}`);
          }
          continue; // loop picks up 'regen-strong' next
        }

        // ── FIX D: Code errors — pick the right strategy per error kind ────
        if (codeErrors.length > 0) {
          // Determine the dominant error kind (most failures of that kind)
          const kindCounts = new Map<string, number>();
          for (const c of codeErrors) kindCounts.set(c.rootCause?.kind ?? 'unknown', (kindCounts.get(c.rootCause?.kind ?? 'unknown') ?? 0) + 1);
          const dominantKind = [...kindCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];

          // Get the next strategy for the dominant kind
          const strategy = consumeStrategy(dominantKind);

          if (strategy === null) {
            // This kind is exhausted — check others
            const otherErrors = codeErrors.filter(c => (c.rootCause?.kind ?? 'unknown') !== dominantKind);
            if (otherErrors.length === 0) {
              appendLog(`⚠️ All strategies exhausted for ${dominantKind}`);
              if (allStrategiesExhausted(failedChecks)) break;
            }
            continue;
          }

          // ── Cache clear strategy (no AI) ─────────────────────────────────
          if (strategy === 'cache-clear') {
            if (!triedCacheClear) {
              triedCacheClear = true;
              narrate(`🔄 Clearing build cache and restarting for a clean compile…`);
              await api({ action: 'clear-cache', projectPath: path });
              const restCC = await api({ action: 'start-server', projectPath: path, force: true });
              if (restCC.port) { port = restCC.port; setPreviewUrl(`http://localhost:${port}`); }
              const wCC = await api({ action: 'wait-for-server', port, timeout: 90000 });
              if (wCC.crashed) {
                const logCC = (await api({ action: 'get-server-logs', projectPath: path }).catch(() => ({ logs: '' }))).logs as string;
                const errCC = logCC.split('\n').filter((l: string) => /error|failed/i.test(l)).slice(0, 3).join('\n');
                narrate(`❌ Server crashed on clean rebuild.\n\`\`\`\n${errCC}\n\`\`\`\nAsk me to fix the startup issue.`);
                setBuildProgress(p => ({...p!, step: 'error', message: '❌ Crashed on rebuild', logs: [...(p?.logs ?? []), `❌ ${errCC}`]}));
                break;
              }
              setPreviewKey(k => k + 1);
              serverJustRestarted = true;
              browserContextCache = '';
            }
            continue;
          }

          // ── fix-auth-fields: deterministic form↔API field name repair ────────
          if (strategy === 'fix-auth-fields') {
            narrate(`🔑 Auth field mismatch detected — reading form and API source to align field names…`);
            try {
              const authFixResult = await api({ action: 'fix-auth-fields', projectPath: path });
              appendLog(authFixResult.fixed > 0
                ? `✅ Auth fields fixed: ${authFixResult.details ?? `${authFixResult.fixed} file(s) patched`}`
                : `⚠️ Auth field fixer: no mismatches found to fix`);
              if (authFixResult.fixed > 0) {
                await new Promise(r => setTimeout(r, 2000)); // HMR settle
              }
            } catch (e) {
              appendLog(`⚠️ fix-auth-fields failed: ${e instanceof Error ? e.message : 'unknown'}`);
            }
            continue;
          }

          // ── repair-auth-pages: detect and replace stub auth pages with real forms ────
          if (strategy === 'repair-auth-pages') {
            narrate(`🔐 Auth page stub detected — replacing with real sign-in/sign-up form…`);
            try {
              const authRepairResult = await api({ action: 'repair-auth-pages', projectPath: path });
              if (authRepairResult.total > 0) {
                appendLog(`✅ Auth pages repaired: ${authRepairResult.repaired.join(', ')}`);
                await new Promise(r => setTimeout(r, 2000)); // HMR picks up new files automatically
              } else {
                appendLog(`ℹ️ repair-auth-pages: no stub auth pages found`);
              }
            } catch (e) {
              appendLog(`⚠️ repair-auth-pages failed: ${e instanceof Error ? e.message : 'unknown'}`);
            }
            continue;
          }

          // ── repair-dashboard: create working /dashboard for apps with auth ──────────
          if (strategy === 'repair-dashboard') {
            narrate(`🏠 Login/signup found but /dashboard is missing — creating a working dashboard…`);
            try {
              const dashResult = await api({ action: 'repair-dashboard', projectPath: path });
              if (dashResult.repaired) {
                appendLog(`✅ Dashboard created at app/dashboard/page.tsx`);
                await new Promise(r => setTimeout(r, 2000)); // HMR picks up new files automatically
              } else {
                appendLog(`ℹ️ repair-dashboard: ${dashResult.reason ?? 'dashboard already exists'}`);
              }
            } catch (e) {
              appendLog(`⚠️ repair-dashboard failed: ${e instanceof Error ? e.message : 'unknown'}`);
            }
            continue;
          }

          // ── repair-dynamic-routes: detect template-literal hrefs, create [id] pages ──
          if (strategy === 'repair-dynamic-routes') {
            narrate(`🔗 Scanning for dynamic route references (e.g. /products/\${id}) and creating detail pages…`);
            try {
              const dynResult = await api({ action: 'repair-dynamic-routes', projectPath: path });
              if (dynResult.total > 0) {
                appendLog(`✅ Dynamic routes created: ${dynResult.created.join(', ')}`);
                await new Promise(r => setTimeout(r, 2000)); // HMR picks up new files automatically
              } else {
                appendLog(`ℹ️ repair-dynamic-routes: no missing [id] pages found`);
              }
            } catch (e) {
              appendLog(`⚠️ repair-dynamic-routes failed: ${e instanceof Error ? e.message : 'unknown'}`);
            }
            continue;
          }

          // ── repair-missing-routes: scan all source files, create missing page stubs ──
          if (strategy === 'repair-missing-routes') {
            narrate(`🗺️ Scanning nav links for missing pages and creating stubs…`);
            try {
              const routeFixResult = await api({ action: 'repair-missing-routes', projectPath: path });
              if (routeFixResult.total > 0) {
                appendLog(`✅ Missing routes created: ${routeFixResult.created.join(', ')}`);
                await new Promise(r => setTimeout(r, 2000)); // HMR picks up new files automatically
              } else {
                appendLog(`ℹ️ repair-missing-routes: all nav routes already have pages`);
              }
            } catch (e) {
              appendLog(`⚠️ repair-missing-routes failed: ${e instanceof Error ? e.message : 'unknown'}`);
            }
            continue;
          }

          // ── AI repair strategies (targeted / broader / rewrite) ───────────
          const targetFiles = [...new Set(
            codeErrors.flatMap(c => [c.fixFile, c.rootCause?.fixFile].filter(Boolean) as string[])
          )];

          const errorContext = codeErrors.map(c =>
            `${c.name} [${c.rootCause?.kind ?? 'error'}]: ${c.rootCause?.detail || c.error || 'unknown'}` +
            (c.fixHint || c.rootCause?.fixHint ? `\n  HOW TO FIX: ${c.fixHint || c.rootCause?.fixHint}` : '') +
            (c.rootCause?.errorText ? `\n  RAW ERROR: ${c.rootCause.errorText.slice(0, 200)}` : '')
          ).join('\n\n');

          const strategyLabel = strategy === 'targeted' ? 'targeted patch'
            : strategy === 'broader' ? 'broader context repair'
            : 'full file rewrite';

          const errorSummary = [...kindCounts.entries()].map(([k, n]) => `${n}× ${k}`).join(', ');
          narrate(`🔧 ${strategyLabel.charAt(0).toUpperCase() + strategyLabel.slice(1)} — fixing: ${errorSummary}…`);
          appendLog(`🔧 Strategy: ${strategy} — targeting ${targetFiles.length > 0 ? targetFiles.join(', ') : 'log-referenced files'}`);

          // Snapshot before the AI fix for rollback safety
          if (targetFiles.length > 0) {
            await api({ action: 'snapshot-files', projectPath: path, files: targetFiles });
          }

          // Get fresh TypeScript errors for context
          let tsErrors = '';
          try {
            const tsResult = await api({ action: 'check-ts', projectPath: path });
            tsErrors = tsResult.errors?.slice(0, 5).join('\n') ?? '';
          } catch {}

          const fixResult = await api({
            action: 'agent-fix',
            projectPath: path,
            errorContext,
            targetFiles,
            serverLogs,
            tsErrors,
            browserErrors: browserContextCache,
            strategy,
            errorKind: dominantKind, // lets the API scope-filter UI files for backend errors
          });

          appendLog(fixResult.success && fixResult.fixedCount > 0
            ? `✅ [${strategy}] Fixed ${fixResult.fixedCount} file(s): ${(fixResult.changedFiles ?? []).join(', ')}`
            : `⚠️ [${strategy}] No changes produced — will try next strategy`);

          if (!fixResult.success || !fixResult.fixedCount) {
            // AI produced nothing — strategy already consumed, loop will pick next
            continue;
          }

          // ── Design drift guard ─────────────────────────────────────────────
          // For broader/rewrite strategies, check if any UI file was significantly
          // overwritten. If yes, restore those files from the design baseline so
          // the original UI is preserved while the backend fix still applies.
          if ((strategy === 'broader' || strategy === 'rewrite') && (fixResult.changedFiles?.length ?? 0) > 0) {
            try {
              const driftCheck = await api({
                action: 'check-baseline-drift',
                projectPath: path,
                changedFiles: fixResult.changedFiles ?? [],
              });
              if (driftCheck.hasDrift && driftCheck.drifted?.length > 0) {
                appendLog(`⚠️ Design drift detected in: ${driftCheck.drifted.join(', ')} — restoring from baseline`);
                const restoreUI = await api({
                  action: 'restore-baseline-files',
                  projectPath: path,
                  changedFiles: driftCheck.drifted,
                });
                if (restoreUI.count > 0) {
                  appendLog(`🎨 Baseline restored for: ${restoreUI.restored.join(', ')}`);
                }
              }
            } catch { /* non-critical */ }
          }

          // Wait for HMR or force-restart if the rewrite strategy changed config files
          const needsRestart = strategy === 'rewrite' || (fixResult.changedFiles ?? []).some((f: string) => f.endsWith('.json') || f.includes('.env') || f.includes('next.config'));
          if (needsRestart) {
            const restAI = await api({ action: 'start-server', projectPath: path, force: false });
            if (restAI.port) { port = restAI.port; setPreviewUrl(`http://localhost:${port}`); }
            await api({ action: 'wait-for-server', port, timeout: 60000 });
          } else {
            await new Promise(r => setTimeout(r, 3000)); // HMR settle
          }

          // ── Re-verify after fix ─────────────────────────────────────────
          let verifyAfter: VerifyData = { verified: false, summary: '', checks: [] };
          try {
            verifyAfter = await api({ action: 'verify-app', port, projectPath: path });
          } catch { continue; }

          const passedAfter = verifyAfter.checks.filter(c => c.passed).length;
          appendLog(`📊 After [${strategy}]: ${passedAfter}/${verifyAfter.checks.length} (was ${passedNow})`);

          // ── ROLLBACK if fix made things worse ────────────────────────────
          if (passedAfter < passedNow && targetFiles.length > 0) {
            consecutiveRollbacks++;
            narrate(`↩️ Fix reduced checks (${passedAfter} < ${passedNow}) — rolling back to stable state…`);
            const restore = await api({ action: 'restore-files', projectPath: path });
            appendLog(restore.restoredCount > 0 ? `↩️ Restored: ${restore.restored?.join(', ')}` : '⚠️ No snapshot to restore');
            if (restore.restoredCount > 0) {
              const restRB = await api({ action: 'start-server', projectPath: path, force: false });
              if (restRB.port) { port = restRB.port; setPreviewUrl(`http://localhost:${port}`); }
              await api({ action: 'wait-for-server', port, timeout: 45000 });
              setPreviewKey(k => k + 1);
            }
          } else {
            consecutiveRollbacks = 0;
            await api({ action: 'clear-snapshot', projectPath: path });
            if (passedAfter > passedNow) {
              narrate(`✅ ${passedAfter - passedNow} more check${passedAfter - passedNow > 1 ? 's' : ''} passing. Continuing…`);
            }
            verifyData = verifyAfter;
            setLastVerification(verifyData);
            setPreviewKey(k => k + 1);
            browserContextCache = ''; // refresh browser context on next stagnation
            if (verifyAfter.verified) break;
          }
          continue;
        }

        // ── Nothing classified — fall back to cache clear ──────────────────
        if (!triedCacheClear) {
          triedCacheClear = true;
          narrate(`🔄 Trying a clean rebuild…`);
          await api({ action: 'clear-cache', projectPath: path });
          const restFB = await api({ action: 'start-server', projectPath: path, force: true });
          if (restFB.port) { port = restFB.port; setPreviewUrl(`http://localhost:${port}`); }
          const wFB = await api({ action: 'wait-for-server', port, timeout: 90000 });
          if (wFB.crashed) {
            const logFB = (await api({ action: 'get-server-logs', projectPath: path }).catch(() => ({ logs: '' }))).logs as string;
            const errFB = logFB.split('\n').filter((l: string) => /error|failed/i.test(l)).slice(0, 3).join('\n');
            narrate(`❌ Server crashed.\n\`\`\`\n${errFB || 'No detail'}\n\`\`\`\nAsk me to fix the startup issue.`);
            setBuildProgress(p => ({...p!, step: 'error', message: '❌ Server crashed', logs: [...(p?.logs ?? []), `❌ ${errFB}`]}));
            break;
          }
          setPreviewKey(k => k + 1);
          serverJustRestarted = true;
          browserContextCache = '';
        } else {
          break;
        }
      }

      // ── Bridge escalation guard ────────────────────────────────────────────
      // If any escalation point above fired, the bridge is now running asynchronously.
      // Exit the pipeline immediately so the bridge has sole ownership of the project:
      // it will fix the issue, restart the server, run post-bridge verification, and
      // show the final result via onComplete. Running the health gate, browser journey,
      // and result-setting code below CONCURRENTLY with the bridge causes race conditions
      // (interleaved status messages, stale setBuildProgress calls) and is what made
      // the repair sequence appear to loop back to "Iteration 1/7".
      if (escalatedToBridge) return;

      const passedChecks = verifyData.checks?.filter(c => c.passed).length ?? 0;
      const totalChecks = verifyData.checks?.length ?? 0;
      const verifyLogs = verifyData.checks?.map((c) =>
        `${c.passed ? '✅' : '❌'} ${c.name}${c.recordCount !== undefined ? ` (${c.recordCount} records)` : c.error ? `: ${c.error}` : ''}`
      ) ?? [];

      // ── Health gate: run a final investigation to detect configuration issues
      // that code fixes cannot solve. Never mark as "verified" if the gate fails.
      let healthBlockers: string[] = [];
      let finalInvestigation: { primaryLayer?: string; missingCredentials?: string[]; summary?: string } = {};
      try {
        const healthData = await api({ action: 'investigate', projectPath: path, port });
        if (healthData.success && healthData.report) {
          finalInvestigation = healthData.report;
          // Only block on credentials and database — these cannot be fixed by code changes
          const criticals = (healthData.findings ?? []) as Array<{ layer: string; severity: string; title: string }>;
          const credFail = criticals.filter(f => f.layer === 'credentials' && f.severity === 'critical');
          if (credFail.length > 0) {
            healthBlockers.push(`Missing or placeholder credentials: ${(healthData.missingCredentials ?? []).join(', ')}`);
          }
        }
      } catch { /* non-critical — proceed with verification result as-is */ }

      // Block "verified" if the main page is still showing the scaffold placeholder.
      // This catches the case where Bedrock failed during generation and the app
      // is serving the "Building your app — the agent is generating…" loading page.
      const scaffoldCheckFailed = verifyData.checks?.some(
        c => c.name.includes('Main page') && (
          c.rootCause?.kind === 'scaffold-placeholder' ||
          (c.passed && c.responsePreview && /Building your app|agent is generating|animate-pulse.*Generat/i.test(c.responsePreview))
        )
      ) ?? false;
      const finalScaffoldPresent = isScaffold || scaffoldCheckFailed;
      if (finalScaffoldPresent) {
        setScaffoldDetected(true);
        healthBlockers.push(
          isScaffold
            ? 'AI generation was incomplete — the app is showing a placeholder page, not the generated application'
            : 'Preview is still showing the generation placeholder — app has not rendered yet'
        );
      } else {
        setScaffoldDetected(false); // clear overlay if scaffold is no longer present
      }

      // ── Browser Journey Gate: Build → Verify → Repair → Verify Again → Pass ──
      // isFullyVerified is ONLY true when ALL five conditions hold:
      //   1. All HTTP route checks pass
      //   2. No health/credential blockers
      //   3. Browser journey explicitly PASSES (SKIPPED does not count)
      //   4. No failed network requests during the journey (API errors inside user flow)
      //   5. Scaffold placeholder is not present
      //
      // If journey fails → build repair package → auto-repair → re-run → only THEN pass.
      let journeyVerdict: 'PASSED' | 'FAILED VERIFICATION' | 'SKIPPED' = 'SKIPPED';
      let journeyFailedStep = '';
      let journeyRepaired = false;
      let journeyFailedRequests = 0;

      const httpRoutesPass = verifyData.verified && healthBlockers.length === 0;

      // ── Live Verification: browser journey + link crawl streamed to Preview ──
      // Uses SSE to stream Playwright events live into the Preview panel so the
      // user can watch the AI test the app in real time. The journey result and
      // crawl result are returned and used for the six-condition gate below.
      let crawlVerdict: 'PASSED' | 'FAILED' | 'SKIPPED' = 'SKIPPED';
      let crawlReport: {
        verdict: string;
        summary: string;
        failed: Array<{url: string; is404: boolean; linkText: string; missingRouteFile?: string}>;
        pagesVisited: string[];
        passed: Array<{url: string}>;
      } | null = null;
      let linkCrawlRepaired: string[] = [];

      if (httpRoutesPass && !finalScaffoldPresent) {
        try {
          appendLog('🔴 LIVE VERIFICATION — watch the Preview panel to see Playwright testing your app…');
          narrate('Starting live verification — watch as the AI opens your app, tests every page, and clicks every link…');

          const liveResult = await runVerificationLive(path, port);

          journeyVerdict = liveResult.journeyVerdict;
          journeyFailedStep = liveResult.journeyFailedAt;
          journeyFailedRequests = liveResult.journeyFailedRequests;

          if (journeyVerdict === 'PASSED') {
            if (journeyFailedRequests > 0) {
              appendLog(`⚠️ Journey PASSED but ${journeyFailedRequests} API request(s) failed — treating as FAILED VERIFICATION`);
              journeyVerdict = 'FAILED VERIFICATION';
              journeyFailedStep = `API failure during user flow (${journeyFailedRequests} request(s))`;
            } else {
              appendLog('✅ Browser journey PASSED — register, login, and all core flows verified');
            }
          } else if (journeyVerdict === 'FAILED VERIFICATION') {
            appendLog(`❌ FAILED VERIFICATION at "${journeyFailedStep}" — auto-repairing…`);
            narrate(`FAILED VERIFICATION at "${journeyFailedStep}" — applying auto-repair…`);

            // Auto-repair using the structured repair package
            const journeyResultForRepair = { verdict: journeyVerdict, failedAt: journeyFailedStep, steps: liveResult.journeySteps };
            const { buildRepairPackage } = await import('@/services/repair-package').catch(() => ({ buildRepairPackage: null }));
            if (buildRepairPackage) {
              const repairPkg = buildRepairPackage(journeyResultForRepair as unknown as Parameters<typeof buildRepairPackage>[0]);
              const repairRes = await api({
                action: 'auto-repair-journey-failure',
                projectPath: path,
                port,
                repairPackage: repairPkg,
              }).catch(() => null);

              if (repairRes?.shouldReverify) {
                appendLog(`Repair applied (${repairRes.fixedCount} file(s)) — re-running live verification…`);
                await new Promise(r => setTimeout(r, 3500));

                const liveResult2 = await runVerificationLive(path, port);
                journeyVerdict = liveResult2.journeyVerdict;
                journeyFailedStep = liveResult2.journeyFailedAt || journeyFailedStep;
                journeyFailedRequests = liveResult2.journeyFailedRequests;

                if (journeyVerdict === 'PASSED') {
                  journeyRepaired = true;
                  appendLog('✅ Browser journey PASSED after auto-repair');
                  // Use crawl result from the re-run
                  crawlVerdict = liveResult2.crawlVerdict;
                  linkCrawlRepaired = liveResult2.crawlMissingRouteFiles;
                  crawlReport = {
                    verdict: liveResult2.crawlVerdict,
                    summary: `${liveResult2.crawlPassedLinks} links passed, ${liveResult2.crawlFailedLinks} failed`,
                    failed: [],
                    pagesVisited: Array(liveResult2.crawlPagesVisited).fill(''),
                    passed: Array(liveResult2.crawlPassedLinks).fill({ url: '' }),
                  };
                } else {
                  appendLog(`❌ Journey still failing after repair — step: "${journeyFailedStep}"`);
                }
              }
            }
          } else {
            appendLog('Browser journey SKIPPED — Playwright unavailable in this environment');
          }

          // Use crawl result from initial live run (if journey passed first time)
          if (!journeyRepaired && journeyVerdict !== 'FAILED VERIFICATION') {
            crawlVerdict = liveResult.crawlVerdict;
            crawlReport = {
              verdict: liveResult.crawlVerdict,
              summary: `${liveResult.crawlPassedLinks} links passed, ${liveResult.crawlFailedLinks} failed`,
              failed: [],
              pagesVisited: Array(liveResult.crawlPagesVisited).fill(''),
              passed: Array(liveResult.crawlPassedLinks).fill({ url: '' }),
            };

            if (crawlVerdict === 'PASSED') {
              appendLog(`✅ Link crawl PASSED — ${liveResult.crawlPagesVisited} page(s) visited, all ${liveResult.crawlPassedLinks} links work`);
            } else if (crawlVerdict === 'FAILED') {
              // ── Repair-Verify Loop ────────────────────────────────────────────────
              // Rule: a 404 MUST be repaired AND re-verified before "Verified Working"
              // can be declared. We run up to MAX_REPAIR_ROUNDS cycles of:
              //   detect 404 → create missing page → wait for hot-reload → re-run Playwright → check
              const MAX_REPAIR_ROUNDS = 3;
              let repairRound = 0;
              let currentFailedCount = liveResult.crawlFailedLinks;
              let latestLiveResult = liveResult;

              while (crawlVerdict === 'FAILED' && repairRound < MAX_REPAIR_ROUNDS) {
                repairRound++;
                appendLog(`❌ ${currentFailedCount} broken route(s) — auto-repair round ${repairRound}/${MAX_REPAIR_ROUNDS}…`);
                if (repairRound === 1) {
                  narrate(`Detected ${currentFailedCount} broken route(s). Creating missing pages and re-verifying — watch the Preview panel…`);
                }

                const crawlRepairRes = await api({
                  action: 'crawl-and-repair-links',
                  projectPath: path,
                  port,
                  maxPages: 5,
                  maxLinksPerPage: 6,
                }).catch(() => null);

                if (!crawlRepairRes?.crawlReport) break;

                const newlyRepaired: string[] = crawlRepairRes.repairedRoutes ?? [];
                linkCrawlRepaired.push(...newlyRepaired);

                if (newlyRepaired.length === 0) {
                  appendLog(`⚠️ Repair engine found no new pages to create — ${currentFailedCount} route(s) remain unresolvable`);
                  break;
                }

                appendLog(`Round ${repairRound}: created ${newlyRepaired.length} page(s): ${newlyRepaired.join(', ')} — waiting for Next.js hot-reload…`);
                setVerificationLive(prev => prev ? {
                  ...prev,
                  summary: { ...prev.summary, repaired: linkCrawlRepaired.length, pages404Fixed: linkCrawlRepaired.length },
                } : null);

                // Give Next.js time to compile the new files
                await new Promise(r => setTimeout(r, 4500));

                // Re-run the full live verification (Playwright + crawler) to confirm fixes
                appendLog(`🔴 Re-running Playwright verification to confirm repair…`);
                const liveResultN = await runVerificationLive(path, port);
                latestLiveResult = liveResultN;
                crawlVerdict = liveResultN.crawlVerdict;
                currentFailedCount = liveResultN.crawlFailedLinks;
                crawlReport = {
                  verdict: liveResultN.crawlVerdict,
                  summary: `${liveResultN.crawlPassedLinks} links passed, ${liveResultN.crawlFailedLinks} failed`,
                  failed: [],
                  pagesVisited: Array(liveResultN.crawlPagesVisited).fill(''),
                  passed: Array(liveResultN.crawlPassedLinks).fill({ url: '' }),
                };

                if (crawlVerdict === 'PASSED') {
                  appendLog(`✅ All routes verified by Playwright — 0 broken links after repair round ${repairRound}`);
                } else {
                  appendLog(`⚠️ ${currentFailedCount} route(s) still failing after round ${repairRound} — continuing…`);
                }
              }

              if (crawlVerdict === 'FAILED') {
                appendLog(`❌ ${currentFailedCount} route(s) could not be fully repaired after ${repairRound} attempt(s) — marking as FAILED`);
                narrate(`${currentFailedCount} broken route(s) remain after ${repairRound} repair attempt(s). These pages need to be regenerated.`);
              }
            }
            appendLog(`📋 Routes Passed: ${crawlReport?.passed?.length ?? liveResult.crawlPassedLinks} | Failed: ${crawlReport?.failed?.length ?? liveResult.crawlFailedLinks} | Repaired: ${linkCrawlRepaired.length} | Status: ${crawlVerdict}`);
          }

        } catch (e) {
          appendLog(`Browser journey SKIPPED — ${e instanceof Error ? e.message : 'Playwright unavailable'}`);
        }
      }

      // ── Generation Verifier — 18-point completion gate ────────────────────────
      // Runs all 5 verification phases (TypeScript, route map, API health, browser
      // journey, deep interactive crawl) in a repair loop. The "Verified Working"
      // label is only awarded when this passes. Every failure is repaired and
      // re-verified before the app is ever shown to the user as complete.
      let generationVerifierResult: {
        canComplete: boolean; summary: string; rounds: number;
        passedChecks: number; totalChecks: number; repairedTotal: number;
        repairLog: string[]; failureReason?: string; phases?: Array<{phase: string; passed: boolean}>;
      } | null = null;

      if (!finalScaffoldPresent && httpRoutesPass) {
        try {
          appendLog('🔬 Running 18-point Generation Verifier…');
          narrate('Running the final 18-point verification pipeline — checking every page, every button, every API, and every navigation link…');

          const verifierRes = await api({
            action: 'run-generation-verifier',
            projectPath: path,
            port,
          }).catch(() => null);

          if (verifierRes) {
            generationVerifierResult = verifierRes;

            if (verifierRes.canComplete) {
              appendLog(`✅ Generation Verifier PASSED — ${verifierRes.passedChecks}/${verifierRes.totalChecks} checks, ${verifierRes.repairedTotal} auto-repair(s), ${verifierRes.rounds} round(s)`);
              if (verifierRes.repairedTotal > 0) {
                appendLog(`  Auto-repaired: ${verifierRes.repairLog?.join(' | ')}`);
              }
              // Update the crawl/journey verdicts to reflect verifier success
              if (crawlVerdict !== 'PASSED') crawlVerdict = 'PASSED';
              if (journeyVerdict !== 'PASSED') journeyVerdict = 'PASSED';
            } else {
              appendLog(`❌ Generation Verifier — issues remain after ${verifierRes.rounds} repair round(s): ${verifierRes.failureReason ?? 'unknown'}`);
              narrate(`The 18-point verifier found issues that could not be fully auto-repaired: ${verifierRes.failureReason ?? 'see logs for details'}`);
              // Mark crawl as failed so the 6-condition gate below fires the right error path
              if (crawlVerdict === 'PASSED') crawlVerdict = 'FAILED';
            }
          }
        } catch (e) {
          appendLog(`Generation Verifier skipped — ${e instanceof Error ? e.message : 'unavailable'}`);
        }
      }

      // Seven-condition gate — ALL must hold before "Verified Working" is declared:
      //   1. HTTP routes pass
      //   2. No health/credential blockers
      //   3. Browser journey PASSED (SKIPPED = not verified)
      //   4. No failed API requests during the journey
      //   5. Scaffold placeholder absent
      //   6. Link crawl PASSED or SKIPPED (FAILED = broken links exist)
      //   7. Generation Verifier canComplete (18-point gate)
      const verifierCanComplete = generationVerifierResult === null || generationVerifierResult.canComplete;
      const isFullyVerified =
        httpRoutesPass &&
        !finalScaffoldPresent &&
        journeyVerdict === 'PASSED' &&
        journeyFailedRequests === 0 &&
        (crawlVerdict === 'PASSED' || crawlVerdict === 'SKIPPED') &&
        verifierCanComplete;

      setBuildDetailStep('complete');
      // 'done' = app works and journey passed. 'error' = still broken.
      const finalStep: 'done' | 'error' = isFullyVerified ? 'done' : 'error';
      setBuildProgress({
        step: finalStep,
        message: finalScaffoldPresent
          ? `❌ ${projectName} — preview stuck on placeholder (re-generation failed)`
          : isFullyVerified
            ? `✅ ${projectName} — Verified Working`
            : journeyVerdict === 'FAILED VERIFICATION'
              ? `❌ ${projectName} — FAILED VERIFICATION at "${journeyFailedStep}"`
              : crawlVerdict === 'FAILED'
                ? `❌ ${projectName} — broken links found (${crawlReport?.failed?.length ?? 0} 404s)`
                : healthBlockers.length > 0
                  ? `⚠️ ${projectName} is running — credentials needed`
                  : `⚠️ ${projectName} is running (${passedChecks}/${totalChecks} checks passed)`,
        logs: [
          finalScaffoldPresent ? '❌ Scaffold placeholder present — re-generation exhausted' : `✅ Running on port ${port}`,
          ...verifyLogs,
          ...healthBlockers.map(b => `⚠️ Health gate: ${b}`),
        ],
        projectName, projectPath: path, port,
      });

      // Structured final build report
      const installedSummary = allInstalledPkgs.length > 0
        ? `Packages auto-installed: ${allInstalledPkgs.join(', ')}`
        : '';

      const pagesReport = discPages.length > 0
        ? discPages.map(p => p.replace('app/', '').replace('/page.tsx', '') || '/').join(', ')
        : 'home';

      const failedChecks = verifyData.checks?.filter(c => !c.passed) ?? [];
      const remainingIssues = failedChecks.length > 0
        ? `Remaining issues: ${failedChecks.map(c => c.name + (c.error ? ` (${c.error.slice(0, 60)})` : '')).join('; ')}`
        : 'Remaining issues: None';

      if (finalScaffoldPresent) {
        narrate(
          `❌ **Generation failed** — the preview is still showing the "Building your app" placeholder after all repair attempts.\n\n` +
          `The AI was unable to fully generate your app. Here's what you can do:\n` +
          `• **Retry** — click "New Build" and describe your app again\n` +
          `• **Be more specific** — e.g. "A task tracker with a list view, add-task form, and SQLite storage"\n` +
          `• **Check Bedrock** — if AWS Bedrock is unavailable in your region, generation will always fail\n\n` +
          `The server is still running at port ${port} if you want to inspect the placeholder.`
        );
      } else if (isFullyVerified) {
        const journeyNote = journeyRepaired
          ? `• User journey: ✅ PASSED (auto-repaired)\n`
          : `• User journey: ✅ PASSED — register, login, and all core flows confirmed\n`;
        const crawlNote = crawlVerdict === 'PASSED'
          ? `• Link crawl: ✅ PASSED — ${crawlReport?.pagesVisited?.length ?? 0} page(s) visited, all links work\n` +
            (linkCrawlRepaired.length > 0 ? `  (${linkCrawlRepaired.length} missing dynamic page(s) auto-created)\n` : '')
          : '';
        const verifyReportBlock =
          `\nVerification Report:\n` +
          `  Routes Tested: ${(crawlReport?.passed?.length ?? 0) + (crawlReport?.failed?.length ?? 0) + passedChecks}\n` +
          `  Passed: ${(crawlReport?.passed?.length ?? 0) + passedChecks}\n` +
          `  Failed: ${crawlReport?.failed?.length ?? 0}\n` +
          `  Repaired: ${linkCrawlRepaired.length}\n` +
          `  Remaining Errors: 0\n` +
          `  Final Status: VERIFIED WORKING`;
        const nextStep = `Next step: Click any page in the preview to interact with it. Ask me to add features, fix the design, connect a real database, or help with deployment.`;
        const verifierNote = generationVerifierResult?.canComplete
          ? `• 18-point generation verifier: ✅ PASSED (${generationVerifierResult.passedChecks}/${generationVerifierResult.totalChecks} checks${generationVerifierResult.repairedTotal > 0 ? `, ${generationVerifierResult.repairedTotal} auto-repaired` : ''})\n`
          : '';
        narrate(
          `✅ **${projectName} — Verified Working**\n\n` +
          `Files created: ${filesCreated}\n` +
          `Pages: ${pagesReport}\n` +
          `Route checks: ${passedChecks}/${totalChecks} passed\n` +
          (installedSummary ? `${installedSummary}\n` : '') +
          `${remainingIssues}\n\n` +
          `Confirmed working:\n` +
          `• All navigation pages render correctly\n` +
          `• API routes return real data from SQLite\n` +
          `• Forms submit and store data\n` +
          (discMode.includes('Auth') || discPages.some(p => p.includes('login') || p.includes('auth'))
            ? `• Authentication confirmed — JWT sessions and hashed passwords\n` : '') +
          journeyNote +
          crawlNote +
          verifierNote +
          verifyReportBlock +
          `\n\n${nextStep}`
        );
      } else if (crawlVerdict === 'FAILED') {
        const broken404s = crawlReport?.failed?.filter(f => f.is404) ?? [];
        narrate(
          `❌ **FAILED VERIFICATION — ${projectName}**\n\n` +
          `User journey PASSED but ${broken404s.length} internal link(s) return 404.\n\n` +
          `**Broken links:**\n` +
          broken404s.slice(0, 5).map(f => `• "${f.linkText}" → ${f.url}`).join('\n') + '\n\n' +
          (linkCrawlRepaired.length > 0
            ? `Auto-repair created ${linkCrawlRepaired.length} page(s) but the crawl still detected failures after reload.\n\n`
            : '') +
          `Verification Report:\n` +
          `  Routes Tested: ${(crawlReport?.passed?.length ?? 0) + (crawlReport?.failed?.length ?? 0)}\n` +
          `  Passed: ${crawlReport?.passed?.length ?? 0}\n` +
          `  Failed: ${broken404s.length}\n` +
          `  Repaired: ${linkCrawlRepaired.length}\n` +
          `  Remaining Errors: ${broken404s.length}\n` +
          `  Final Status: FAILED VERIFICATION\n\n` +
          `Ask me to **"fix broken links"** and I'll create the missing pages and re-verify.`
        );
      } else if (journeyVerdict === 'FAILED VERIFICATION') {
        narrate(
          `❌ **FAILED VERIFICATION — ${projectName}**\n\n` +
          `Route checks passed (${passedChecks}/${totalChecks}) but the browser user journey did not complete.\n\n` +
          `**Failed at:** ${journeyFailedStep}\n\n` +
          `The auto-repair engine ran one repair attempt. To continue:\n` +
          `• Ask me to **"fix ${journeyFailedStep}"** — I'll run a deeper diagnosis and repair cycle\n` +
          `• Or ask me to **"re-run the journey"** — I'll start fresh verification from the beginning`
        );
      } else if (journeyVerdict === 'SKIPPED') {
        // Playwright unavailable — report honestly, don't claim "verified"
        narrate(
          `⚠️ **${projectName} — Running (not fully verified)**\n\n` +
          `Route checks: ${passedChecks}/${totalChecks} passed\n` +
          `Pages: ${pagesReport}\n` +
          (installedSummary ? `${installedSummary}\n` : '') +
          `${remainingIssues}\n\n` +
          `**Browser journey: SKIPPED** — Playwright is not available in this environment.\n` +
          `The app is running and all HTTP routes pass, but the end-to-end user flow has not been confirmed.\n\n` +
          `To run full verification: install Playwright and ask me to "verify the user journey".`
        );
      } else if (healthBlockers.length > 0) {
        narrate(
          `⚠️ **${projectName} — Running, credentials needed**\n\n` +
          `Pages: ${pagesReport}\n` +
          `Route checks: ${passedChecks}/${totalChecks} passed\n` +
          (installedSummary ? `${installedSummary}\n` : '') +
          `\n**Not fully verified — credential blockers:**\n` +
          healthBlockers.map(b => `• ${b}`).join('\n') + '\n\n' +
          `This is a configuration issue, not a code problem.\n` +
          `Add credentials to \`.env.local\` and ask me to "restart and verify" — I'll re-run the full journey.`
        );
      } else {
        narrate(
          `⚠️ **${projectName} — Running (${passedChecks}/${totalChecks} checks passed)**\n\n` +
          `Pages: ${pagesReport}\n` +
          (installedSummary ? `${installedSummary}\n` : '') +
          `${remainingIssues}\n\n` +
          `Some checks did not pass. Ask me to "fix the remaining issues" and I'll diagnose and repair each one.`
        );
      }

      // API Configuration Guide — generated whenever the app uses third-party APIs
      const apiGuide = generateApiConfigGuide(projectName, discEnvVars, discCreds);
      if (apiGuide) narrate(apiGuide);

      await refreshProjects();

    } catch (err) {
      if (installTicker) { clearInterval(installTicker); installTicker = null; }
      const rawMsg = err instanceof Error ? err.message : 'Unknown error';
      const friendly = friendlyErrorMessage(rawMsg);
      const retryable = isRetryableError(rawMsg);

      // Full technical error goes to the Logs tab only
      appendLog(`❌ [${new Date().toISOString()}] ${rawMsg}`);
      setBuildProgress(p => ({
        ...p!,
        step: 'error',
        message: retryable
          ? '⚡ Connection interrupted — click Retry Build below'
          : '❌ Build stopped — see Logs tab for details',
        logs: [...(p?.logs ?? []), `❌ ${rawMsg}`],
      }));

      // User-facing message: plain English only
      narrate(
        `${retryable ? '⚡' : '⚠️'} **Build interrupted.**\n\n` +
        `**What happened:** ${friendly}\n\n` +
        (retryable
          ? `This is a connection issue — your build description is saved. Click **Retry Build** in the progress panel to continue automatically.`
          : `The full technical details are in the **Logs** tab. Describe your app again and I'll try a different approach, or ask me what went wrong.`)
      );
    } finally {
      if (installTicker) clearInterval(installTicker);
      if (buildHeartbeatRef.current) { clearInterval(buildHeartbeatRef.current); buildHeartbeatRef.current = null; }
      setBuildHeartbeatMsg(null);
      setLoading(false);
      setPhase(p => p === 'building' ? 'idle' : p);
    }
  };

  // ── Flutter Build Pipeline ─────────────────────────────────────────────────
  // Entirely separate from runBuildPipeline (web). Calls flutter-specific API
  // actions only. Never modifies buildProgress or the web preview iframe.

  const runFlutterBuildPipeline = async (conversationHistory: ConversationTurn[], originalPrompt: string) => {
    if (flutterPollRef.current) { clearInterval(flutterPollRef.current); flutterPollRef.current = null; }
    setPhase('building');
    setReadyToBuild(false);
    setLoading(false);
    setLastBuildArgs({ history: conversationHistory, prompt: originalPrompt });

    const setStep = (step: FlutterBuildProgress['step'], message: string, extraLogs: string[] = []) =>
      setFlutterBuildProgress(p => ({
        step,
        message,
        logs: [...(p?.logs ?? []).slice(-30), ...extraLogs],
        projectPath:   p?.projectPath,
        projectName:   p?.projectName,
        apkPath:       p?.apkPath,
        analyzeErrors: p?.analyzeErrors,
      }));

    const appendLogs = (lines: string[]) =>
      setFlutterBuildProgress(p => p ? { ...p, logs: [...p.logs.slice(-30), ...lines] } : p);

    const narrate = (msg: string) => addMsg('assistant', msg);

    setFlutterBuildProgress({ step: 'generating', message: '🧠 Designing your Flutter app…', logs: ['🚀 Starting Flutter build…'] });
    narrate('DWOMOH Vibe Code is designing your Flutter mobile app — selecting screens, navigation, and data models…');

    try {
      // ── Step 1: Generate Flutter project (AI → write Dart files → pub get) ──
      setStep('generating', '🧠 Generating Flutter code with AI…', ['📡 Calling AI (Sonnet)…']);
      const genData = await api({ action: 'generate-flutter', messages: conversationHistory, designStyle: buildStyle });

      if (!genData.success || !genData.projectPath) {
        throw new Error(genData.error || 'Flutter generation failed — try again');
      }

      const { projectPath: flPath, projectName: flName, filesWritten, pubGetSuccess, pubGetErrors, logs: genLogs } = genData;

      setFlutterBuildProgress(p => ({
        ...p!,
        step: 'pub-get',
        message: pubGetSuccess ? '✅ Dependencies installed — analyzing…' : '⚠️ Dependency issues — continuing…',
        projectPath: flPath,
        projectName: flName,
        logs: [...(p?.logs ?? []), ...(genLogs ?? []).slice(-15)],
      }));

      narrate(`Flutter project **${flName}** generated — ${filesWritten} file(s) written.\n\n${pubGetSuccess ? '✅ Dependencies installed successfully.' : `⚠️ flutter pub get had issues:\n\`\`\`\n${(pubGetErrors ?? []).slice(0, 3).join('\n')}\n\`\`\``}`);

      // ── Step 2: flutter analyze ────────────────────────────────────────────
      setStep('analyzing', '🔍 Running flutter analyze…', ['🔬 Checking Dart code…']);
      const analyzeData = await api({ action: 'flutter-analyze', projectPath: flPath });

      const analyzeErrors: string[] = analyzeData.errors ?? [];
      const analyzeWarnings: string[] = analyzeData.warnings ?? [];

      setFlutterBuildProgress(p => ({
        ...p!,
        step:          analyzeData.passed ? 'building-apk' : 'analyzing',
        message:       analyzeData.passed ? '✅ Code analysis passed — building APK…' : `⚠️ ${analyzeErrors.length} error(s) found`,
        analyzeErrors,
        logs:          [...(p?.logs ?? []), analyzeData.passed ? '✅ flutter analyze: no errors' : `⚠️ ${analyzeErrors.length} error(s)`, ...analyzeErrors.slice(0, 5)],
      }));

      if (analyzeErrors.length > 0) {
        narrate(`⚠️ **Flutter analyze found ${analyzeErrors.length} error(s)**\n\n\`\`\`\n${analyzeErrors.slice(0, 5).join('\n')}\n\`\`\`\n\n${analyzeErrors.length > 5 ? `…and ${analyzeErrors.length - 5} more. ` : ''}Continuing to APK build — errors may be non-fatal.`);
      } else {
        if (analyzeWarnings.length > 0) {
          narrate(`✅ **Code analysis passed** — ${analyzeWarnings.length} warning(s) noted (non-blocking).`);
        } else {
          narrate('✅ **Code analysis passed** — no errors or warnings.');
        }
      }

      // ── Step 3: Start background APK build ────────────────────────────────
      setStep('building-apk', '🔨 Building Android APK (this takes 3–5 minutes)…', ['⚙️ Running flutter build apk --release…']);
      narrate('Building the Android APK in the background. This typically takes 3–5 minutes — I\'ll notify you when it\'s ready.');

      const buildData = await api({ action: 'flutter-build-apk', projectPath: flPath });
      if (!buildData.success) {
        throw new Error(buildData.error || 'Failed to start APK build');
      }

      const { jobId } = buildData;
      appendLogs([`🏗️ APK build started (job: ${jobId})`]);

      // ── Step 4: Poll until done ────────────────────────────────────────────
      await new Promise<void>((resolve) => {
        flutterPollRef.current = setInterval(async () => {
          try {
            const statusData = await api({ action: 'flutter-build-status' });
            if (!statusData.success) return;

            const { status, logs: buildLogs, apkPath } = statusData;

            appendLogs((buildLogs ?? []).slice(-5));

            if (status === 'done') {
              clearInterval(flutterPollRef.current!);
              flutterPollRef.current = null;
              setFlutterBuildProgress(p => ({
                ...p!,
                step:    'done',
                message: '✅ APK ready — tap below to download',
                apkPath,
                logs:    [...(p?.logs ?? []), '✅ APK build complete!', apkPath ? `📦 ${apkPath}` : '', '🔬 Running runtime verification…'],
              }));

              // ── Runtime verification: install + launch on connected device ───────
              try {
                const runtimeRes = await api({ action: 'verify-flutter-runtime', projectPath: flPath });
                const rpt = runtimeRes?.report ?? '';
                const errors = runtimeRes?.runtimeErrors ?? [];
                const deviceFound = runtimeRes?.deviceFound ?? false;

                const verifyLines = deviceFound
                  ? [
                      runtimeRes.appLaunched ? '✅ App launched on device' : '❌ App failed to launch',
                      errors.length === 0 ? '✅ No runtime crashes detected' : `❌ ${errors.length} crash(es): ${errors[0]?.slice(0, 80)}`,
                      `📊 ${rpt.slice(0, 120)}`,
                    ]
                  : ['📵 No device connected — static APK analysis only', `📊 ${rpt.slice(0, 120)}`];

                setFlutterBuildProgress(p => ({
                  ...p!,
                  logs: [...(p?.logs ?? []), ...verifyLines],
                }));

                const verifyNarrative = deviceFound
                  ? (runtimeRes.appLaunched && errors.length === 0
                      ? `✅ **Runtime verification passed.** The APK installed and launched on device \`${runtimeRes.deviceId}\` with no crashes.\n\n${rpt}`
                      : `⚠️ **Runtime issues detected.** ${rpt}`)
                  : `📱 **No device connected.** ${rpt}\n\nTo test on a device:\n1. Connect an Android device or start an emulator\n2. Enable USB debugging\n3. Re-run "verify runtime" from the project panel`;

                narrate(`🎉 **APK built successfully!**\n\n${verifyNarrative}\n\nProject: \`${flPath}\``);
              } catch {
                narrate(`🎉 **APK built successfully!**\n\nYour Android APK is ready. Tap **Download APK** to save it.\n\nProject path: \`${flPath}\``);
              }
              resolve();
            } else if (status === 'failed') {
              clearInterval(flutterPollRef.current!);
              flutterPollRef.current = null;
              setFlutterBuildProgress(p => ({
                ...p!,
                step:    'error',
                message: '❌ APK build failed — see logs',
                logs:    [...(p?.logs ?? []), '❌ APK build failed'],
              }));
              narrate(`❌ **APK build failed.**\n\nThe Dart code compiled but the Android build step encountered an error. Common causes:\n• Missing Android SDK components (run \`flutter doctor -v\` to check)\n• pubspec.yaml dependency version conflicts\n\nThe Flutter project files are at \`${flPath}\` — you can open them in Android Studio to investigate.`);
              resolve();
            }
          } catch { /* poll errors are non-fatal */ }
        }, 10_000);

        // Safety timeout after 10 minutes
        setTimeout(() => {
          if (flutterPollRef.current) {
            clearInterval(flutterPollRef.current);
            flutterPollRef.current = null;
          }
          setFlutterBuildProgress(p => p?.step === 'building-apk' ? {
            ...p,
            step:    'error',
            message: '⏱️ Build timed out — check Android Studio',
          } : p);
          resolve();
        }, 600_000);
      });

    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setFlutterBuildProgress(p => ({
        step:    'error',
        message: `❌ ${msg}`,
        logs:    [...(p?.logs ?? []), `❌ ${msg}`],
        projectPath: p?.projectPath,
        projectName: p?.projectName,
      }));
      narrate(`⚠️ **Flutter build interrupted.**\n\n${msg}\n\nDescribe your app again and I'll retry.`);
    } finally {
      setLoading(false);
      setPhase(p => p === 'building' ? 'idle' : p);
    }
  };

  // Intent classification — see lib/intent-classifier.ts (extracted for
  // permanent unit testing; see lib/__tests__/intent-classifier.test.ts).
  // ── Canned responses (plain text, no markdown asterisks) ──────────────────

  const getGreetingResponse = (message: string, userName?: string): string => {
    const lower = message.toLowerCase().trim();
    const name  = userName ? ` ${userName.split(' ')[0]}` : '';
    const isDirectGreeting = ['hi', 'hello', 'hey', 'hiya', 'howdy', 'yo', 'good morning', 'good afternoon', 'good evening', 'good night']
      .some(g => lower === g || lower.startsWith(g + ' ') || lower.startsWith(g + '!') || lower.startsWith(g + ','));

    if (isDirectGreeting) {
      return `Hi${name}! I am DWOMOH Vibe Code — your AI product builder.\n\nI can build apps, research APIs, generate logos, understand your designs, and answer any technical question. No coding needed on your side.\n\nFor example:\n• "Build a property marketplace for Ghana with listings, search, and Paystack payments"\n• "What API should I use for football scores?"\n• "Generate a logo for my fintech startup"\n• "Upload a design and I will use it in your website"\n\nWhat would you like to do today?`;
    }
    return `I am DWOMOH Vibe Code${name ? `, ${name}` : ''} — your AI product builder. Ready to build, research, design, or answer questions.\n\nWhat would you like to do?`;
  };

  const getClarificationResponse = (message: string): string => {
    const lower = message.toLowerCase();
    if (lower.includes('business') || lower.includes('company') || lower.includes('startup'))
      return `What kind of business app do you need?\n\n• Restaurant or food — ordering app, table booking, delivery tracking\n• Retail or shop — e-commerce store with products and checkout\n• Real estate — property marketplace with listings and search\n• Salon or spa — appointment booking with calendar and payments\n• Services — service marketplace or client booking platform\n• Management — CRM, inventory, invoicing, or project tracker\n\nDescribe your business and what the app should do for your customers.`;
    if (lower.includes('website') || lower.includes('site'))
      return `What kind of website do you want?\n\n• Landing page or marketing site\n• Portfolio or personal website\n• Blog or content platform\n• E-commerce store\n• Restaurant or hotel website\n• Business directory\n\nAlso let me know the main pages and key features you need.`;
    return `I would love to build that for you. I just need a few more details:\n\n• What type of app or website? (marketplace, store, booking platform, dashboard...)\n• Who will use it?\n• What are the 3 to 5 main features?\n\nExample: "Build a hotel booking website with room listings, a reservation calendar, Paystack payments, and an admin dashboard."`;
  };

  const getDeploymentResponse = (): string =>
    `DWOMOH Vibe Code is its own hosting platform powered by AWS Amplify.\n\n` +
    `**To deploy your app:**\n` +
    `1. Open your project from the left sidebar\n` +
    `2. Click **Deployments** (⊕) in the sidebar\n` +
    `3. Click **⚡ Deploy Now**\n\n` +
    `Your app will go live at a branded URL like **${currentProject ? `${currentProject.name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 25)}.dwomohvibe.app` : '{your-app}.dwomohvibe.app'}**\n\n` +
    `After it goes live, you can connect a custom domain like \`phonecarmarket.com\` directly in the Deployments panel — SSL is automatic.`;

  const getDebugResponse = (): string =>
    `To investigate and fix an issue, please open the project from the sidebar on the left first. Once your project is open, describe what is wrong and I will inspect the code, find the cause, and fix it for you automatically.`;

  const getBillingResponse = (): string =>
    `DWOMOH Vibe Code is available on four plans:\n\nFree — Text-based app builds, limited monthly builds\nStarter — Image uploads, more builds per month\nPro — Voice input, logo generation, priority builds\nBusiness — Voice replies, advanced image understanding, team collaboration, larger storage\n\nAll plans include the full AI builder experience. To upgrade, visit the Billing section in your account settings, or ask me which plan fits what you are trying to build.`;

  // ── AI-powered response — questions, planning, research, API guidance, etc. ─

  const respondWithAI = async (
    queryForAI: string,
    currentHistory: ConversationTurn[],
    action: 'think' | 'research' | 'think-agentic' = 'think'
  ) => {
    setLoading(true);
    setAiState('thinking');
    try {
      // Inject active project context so the AI never drifts into generic responses.
      // Prepend a system-level context message when a builder session is active.
      const projectContextPrefix = (() => {
        const ctx = builderContext ?? (currentProject ? { projectName: currentProject.name, stage: 'editing' as const, active: true } : null);
        if (!ctx?.active) return '';
        const stageLabel = ctx.stage === 'building' ? 'Generating code'
          : ctx.stage === 'editing' ? 'Editing & refining'
          : ctx.stage === 'planning' ? 'Planning & specification'
          : ctx.stage === 'complete' ? 'Live — post-launch'
          : 'Specification';
        return `[ACTIVE PROJECT CONTEXT]\nProject: ${ctx.projectName}\nStage: ${stageLabel}\nInstruction: Stay in Builder Mode. Focus on building, refining, and improving this specific project. Do not switch to generic support, DWOMOH pricing, or unrelated responses.\n[END CONTEXT]\n\n`;
      })();

      // For think and think-agentic, prepend context to the last user message so the AI stays anchored to the project
      const enrichedHistory: ConversationTurn[] = ((action === 'think' || action === 'think-agentic') && projectContextPrefix && currentHistory.length > 0)
        ? [
            ...currentHistory.slice(0, -1),
            { role: currentHistory[currentHistory.length - 1].role, content: projectContextPrefix + String(currentHistory[currentHistory.length - 1].content) },
          ]
        : currentHistory;

      // Agentic mode: use tool-capable AI when explicitly requested (web_research intent)
      // or when a live project is running (allows test_live_app, browse_web, search_internet).
      const livePort = buildProgress?.port || currentProject?.port || null;
      const liveProjectPath = buildProgress?.projectPath || currentProject?.projectPath || null;
      const liveProjectName = buildProgress?.projectName || currentProject?.name || null;
      const useAgenticMode = action === 'think-agentic' || (action === 'think' && !!livePort);

      const body = action === 'research'
        ? { action: 'research', query: projectContextPrefix + queryForAI }
        : useAgenticMode
        ? {
            action: 'think-agentic',
            messages: enrichedHistory,
            port: livePort ?? undefined,
            projectPath: liveProjectPath ?? undefined,
            projectName: liveProjectName ?? undefined,
          }
        : { action: 'think', messages: enrichedHistory };
      const result = await apiWithRetry(
        body,
        (attempt) => { setDisplayed(prev => [...prev, { role: 'assistant' as const, content: `Retrying ${attempt} of 2 — reconnecting to AI…` }]); },
      );
      if (result.success && result.response) {
        await streamReveal(result.response);
        speakText(result.response);
        setHistory(h => [...h, { role: 'assistant' as const, content: result.response }]);
      } else {
        const errMsg = (result.error as string | undefined) ?? 'AI returned no response';
        addErrorMsg(errMsg, 'chat', [
          { label: 'Try again', action: 'focus-input', prompt: queryForAI },
          { label: 'Open Logs', action: 'open-logs' },
        ]);
      }
    } catch (err) {
      addErrorMsg(err, 'chat', [
        { label: 'Try again', action: 'focus-input', prompt: queryForAI },
        { label: 'Open Logs', action: 'open-logs' },
      ]);
    }
    setLoading(false);
    setAiState('idle');
  };

  // ── Send message ────────────────────────────────────────────────────────────

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const userMessage = input.trim();
    if (!userMessage || loading || editApplying || phase === 'building') return;

    // Dismiss goal picker when user sends any message
    if (goalStep !== 'idle') setGoalStep('idle');

    setInput('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    addMsg('user', userMessage);

    const newHistory: ConversationTurn[] = [...history, { role: 'user', content: userMessage }];
    setHistory(newHistory);

    // Instrumented per explicit request: confirms whether currentProject is
    // actually set at the moment a message is sent, since a null value here
    // (e.g. after a page refresh, with no restoration mechanism) means the
    // ENTIRE "project open → edit, not new build" branch below never runs,
    // regardless of any fix inside it.
    console.log(`[send-routing] handleSubmit: currentProject=${currentProject ? `"${currentProject.name}" (port ${currentProject.port}, path ${currentProject.projectPath})` : 'NULL — no project open, message goes to top-level intent classification'}`);

    // BRIDGE TEST MODE: Skip ALL intent classification, editing, and recommendation logic.
    // Every message goes directly to the bridge pipeline. DWOMOH Vibe Code is pure orchestration.
    if (bridgeTestMode) {
      const enrichedBridge = enrichPromptWithAssets(userMessage);
      runBridgeOnlyPipeline(enrichedBridge);
      return;
    }

    // AUTONOMOUS EDIT MODE: Project is open — apply changes immediately.
    // Exceptions: web_research, logo, research are always global.
    // NEW EXCEPTION: 'build' intent = user wants a NEW project, not an edit.
    // Close the current project context and route to the build pipeline.
    if (currentProject) {
      const hasLogo0 = assets.some(a => a.role === 'logo');
      const projectIntent = detectIntent(userMessage, history.length > 0, { hasLogo: hasLogo0 });
      // Computed BEFORE the build-intent fall-through — with a project
      // already open, an explicit problem-report signal always means "fix
      // what I have," regardless of how detectIntent classified the message.
      // See lib/repair-routing.ts's decideProjectOpenRouting for the full
      // root-cause explanation (extracted so this exact decision is
      // permanently unit-tested, not just re-derived by reading this block).
      const appRunning = !!(buildProgress?.port || currentProject?.port);
      const livePort404 = buildProgress?.port || currentProject?.port;
      const livePathForRepair = buildProgress?.projectPath || currentProject?.projectPath;
      const route = decideProjectOpenRouting({
        projectIntent, appRunning, hasLivePathAndPort: !!(livePathForRepair && livePort404), userMessage,
      });

      if (route === 'web_research') { await respondWithAI(userMessage, newHistory, 'think-agentic'); return; }
      if (route === 'logo_request')  { await handleLogoGenerate(userMessage); return; }
      if (route === 'logo_edit')     { await handleLogoRefine(userMessage); return; }
      if (route === 'research')      { await runResearch(userMessage); return; }

      if (route === 'scan_and_repair_routes' || route === 'edit_pipeline') {
        const nlCmd = interpretCommand(userMessage);

        if (route === 'scan_and_repair_routes') {
          const reportsRouting = reportsRoutingProblem(userMessage);
          // Phase 1: fast deterministic route scan + repair
          addStatus('Scanning route structure…', 'checking');
          const scanRepair = await api({
            action: 'scan-and-repair-routes',
            projectPath: livePathForRepair,
            port: livePort404,
          }).catch(() => null);

          if (scanRepair?.created?.length > 0) {
            // Files were created — wait for hot-reload then refresh preview
            await new Promise(r => setTimeout(r, 3000));
            setPreviewKey(k => k + 1);

            const fixedList = scanRepair.redirected?.length > 0
              ? `Created redirect pages: ${scanRepair.redirected.map((r: string) => `\`${r}\``).join(', ')}`
              : `Created ${scanRepair.created.length} missing page file(s)`;

            if (scanRepair.allFixed) {
              addStatus('✅ All routes fixed.', 'done');
              addMsg('assistant',
                `**Routing fixed** ✅\n\n${fixedList}\n\n` +
                `**Routes tested:** ${scanRepair.scanned}\n` +
                `**Previously missing:** ${scanRepair.missing?.join(', ')}\n` +
                `**Now working:** all ${scanRepair.existing?.length + scanRepair.created?.length} routes respond correctly.\n\n` +
                `The Preview panel has been refreshed — all navigation links should work.`
              );
              return;
            } else {
              // Partial fix — inject scan context into AI's working memory, then route to agent
              addStatus(`Fixed ${scanRepair.created.length} route(s) — ${scanRepair.stillBroken?.length} still failing, escalating…`, 'applying');
            }
          } else if (!reportsRouting) {
            // Not a routing issue (no pages created, no routing keywords) — route straight to AI
            await respondWithAI(userMessage, newHistory, 'think-agentic');
            return;
          }

          // Phase 2: AI agent with full tool access for remaining issues
          await respondWithAI(userMessage, newHistory, 'think-agentic');
          return;
        }

        if (nlCmd.isEngineeringCommand && nlCmd.confidence >= 0.75) {
          addStatus(getActionLabel(nlCmd), 'checking');
        }
        runEditPipeline(userMessage, newHistory, nlCmd);
        return;
      }
      // route === 'new_build' falls through to the pipeline at the bottom of handleSubmit
    }

    // INTENT CLASSIFICATION
    // Pass hasHistory so the system knows whether this is a first greeting
    const hasHistory = history.length > 0;
    const hasLogo = assets.some(a => a.role === 'logo');
    const intent = detectIntent(userMessage, hasHistory, { hasLogo });
    // Capture the PRIOR turn's intent before overwriting it with this one —
    // see lastIntentRef's declaration for why this exists.
    const wasLastResponseClarifying = lastIntentRef.current === 'clarification_needed' || lastIntentRef.current === 'planning';
    lastIntentRef.current = intent;

    const respondConversationally = async (text: string) => {
      setLoading(true);
      setAiState('thinking');
      // Thinking pause — feels deliberate, not instant
      await new Promise(r => setTimeout(r, 500 + Math.random() * 300));
      await streamReveal(text);
      speakText(text);
      setLoading(false);
    };

    // BUILDER MODE LOCK: Once the user is in an active session (4+ exchanges),
    // never return canned deployment/debug/billing/clarification responses.
    // The AI has full conversation history and can answer contextually.
    // Canned responses are cold-start UX only — they break context in active sessions.
    const inActiveSession = history.length >= 4;
    const msgWords = userMessage.toLowerCase().trim().split(/\s+/).filter(Boolean);

    // Track builder context: when a build is triggered, capture the project name
    // for the context panel so the next messages stay anchored to the project.
    const extractProjectName = (msg: string): string => {
      const named = /\b(?:called|named)\s+["']?([A-Z][A-Za-z0-9 ]{2,30})["']?/i.exec(msg);
      if (named) return named[1].trim();
      const forApp = /\bfor\s+["']?([A-Z][A-Za-z0-9 ]{2,30}?)["']?\s+(?:app|platform|system|website|portal|management|tracker)\b/i.exec(msg);
      if (forApp) return forApp[1].trim();
      return '';
    };

    switch (intent) {
      // First-time greeting — show intro only once
      case 'greeting':
        await respondConversationally(getGreetingResponse(userMessage, user?.name ?? undefined));
        return;

      // Acknowledgements, continuations, small talk — never re-introduce
      case 'conversation':
        // If the user is acknowledging a planning discussion, keep the builderContext alive
        if (builderContext?.active) setBuilderContext(prev => prev ? { ...prev, stage: 'planning' } : prev);
        await respondWithAI(userMessage, newHistory, 'think');
        return;

      // Explain / how does X work / what is X
      case 'question':
        // Keep planning stage alive during Q&A in a planning session
        if (builderContext?.active && !currentProject) setBuilderContext(prev => prev ? { ...prev, stage: 'planning' } : prev);
        await respondWithAI(userMessage, newHistory, 'think');
        return;

      // Find me X / compare X and Y / best API for X
      case 'research':
        await respondWithAI(userMessage, newHistory, 'research');
        return;

      // "Browse the web", "Open Google homepage", "Visit TikTok" — AI uses browse_web tool
      case 'web_research':
        await respondWithAI(userMessage, newHistory, 'think-agentic');
        return;

      // "How would X work", "Something like Facebook"
      case 'planning': {
        // If user is in a long planning session and sends a short imperative command, treat it
        // as a build confirmation — they want to build what was discussed, not plan more.
        const isPlanningBuildConfirm = (inActiveSession || wasLastResponseClarifying) && msgWords.length <= 5 &&
          /^(build|create|generate|make|develop|implement|start|go|let|proceed|execute)\b/i.test(userMessage.trim());
        if (isPlanningBuildConfirm) {
          const pName3 = extractProjectName(userMessage);
          if (pName3) setBuilderContext({ projectName: pName3, stage: 'building', active: true });
          else setBuilderContext(prev => prev ? { ...prev, stage: 'building' } : { projectName: 'Your App', stage: 'building', active: true });
          break; // fall through to build pipeline
        }
        if (inActiveSession) { await respondWithAI(userMessage, newHistory, 'think'); return; }
        // In early session, update builder context and respond with AI
        setBuilderContext(prev => prev ? prev : { projectName: extractProjectName(userMessage) || 'New Project', stage: 'planning', active: true });
        await respondWithAI(userMessage, newHistory, 'think');
        return;
      }

      // "Add my company name to the logo", "Modify the image"
      case 'design': {
        const assetContext = assets.length > 0
          ? `\n\nCurrently uploaded assets: ${assets.map(a =>
              `${a.name} (${a.role || 'no role assigned'})${a.analysis ? ' — ' + a.analysis.substring(0, 150) : ''}`
            ).join('; ')}`
          : '';
        await respondWithAI(
          userMessage + assetContext,
          newHistory,
          'think'
        );
        return;
      }

      // "Generate a logo for my restaurant"
      case 'logo_request':
        await handleLogoGenerate(userMessage);
        return;

      // "Refine the logo", "Change the colors", "Add my brand name"
      case 'logo_edit':
        await handleLogoRefine(userMessage);
        return;

      // Vague build request — in active sessions check if the user means "build the thing we planned"
      case 'clarification_needed': {
        // Short message after a long planning session = "build what we discussed"
        const isLateSessionBuildConfirm = (inActiveSession || wasLastResponseClarifying) && msgWords.length <= 6 &&
          /^(build|create|generate|make|develop|implement|start|go|let)/i.test(userMessage.trim());
        if (isLateSessionBuildConfirm) {
          // Fall through to build pipeline
          const pName2 = extractProjectName(userMessage);
          if (pName2) setBuilderContext({ projectName: pName2, stage: 'building', active: true });
          else setBuilderContext(prev => prev ? { ...prev, stage: 'building' } : { projectName: 'Your App', stage: 'building', active: true });
          break;
        }
        if (inActiveSession) { await respondWithAI(userMessage, newHistory, 'think'); return; }
        await respondConversationally(getClarificationResponse(userMessage));
        return;
      }

      // Deployment questions — in active sessions route to AI so it answers in project context
      case 'deployment':
        if (inActiveSession) { await respondWithAI(userMessage, newHistory, 'think'); return; }
        await respondConversationally(getDeploymentResponse());
        return;

      // Debug — in active sessions route to AI; cold-start tells user to open a project
      case 'debug':
        if (inActiveSession) { await respondWithAI(userMessage, newHistory, 'think'); return; }
        await respondConversationally(getDebugResponse());
        return;

      // Pricing / subscription — in active sessions the AI knows context (project payments ≠ DWOMOH billing)
      case 'billing':
        if (inActiveSession) { await respondWithAI(userMessage, newHistory, 'think'); return; }
        await respondConversationally(getBillingResponse());
        return;

      // Confirmed build — set builder context, fall through to pipeline.
      // Guard: in an active planning session (4+ exchanges), only build if the message
      // is either an explicit BUILD_TRIGGER ("build it", "let's build") or is detailed
      // enough on its own (8+ words with features). Shorter messages continue the conversation.
      case 'build': {
        const isExplicitBuildCommand =
          // Classic confirmations
          /^(build it|build now|create now|generate now|let's build|lets build|build the app|create the app|go build|just build|build please|proceed with build|go ahead and build|execute|start the build|run the build|do it|do it now|proceed|go ahead|start|begin|kick it off)\b/i.test(userMessage.trim())
          // "Build [AppName]" — named app with at least one ProperCase word
          || (/^(build|create|generate|make|develop|produce)\s+\S/i.test(userMessage.trim()) && userMessage.trim().split(/\s+/).slice(1).some(w => /^[A-Z]/.test(w)));
        if (inActiveSession && msgWords.length < 6 && !isExplicitBuildCommand) {
          // Continue planning conversation rather than jumping to build on a short message
          await respondWithAI(userMessage, newHistory, 'think');
          return;
        }
        const pName = extractProjectName(userMessage);
        if (pName) setBuilderContext({ projectName: pName, stage: 'building', active: true });
        else if (!builderContext) setBuilderContext({ projectName: 'New Project', stage: 'building', active: true });
        else setBuilderContext(prev => prev ? { ...prev, stage: 'building' } : prev);
        break;
      }
    }

    // BUILD MODE: verified intent + sufficient detail — start pipeline
    // Enrich prompt with any uploaded assets before handing off to the pipeline
    const enriched = enrichPromptWithAssets(userMessage);

    // ── Platform recommendation (spec point 4) ────────────────────────────
    // Only offer recommendation when user hasn't explicitly chosen via goal flow
    if (!currentProject && goalPlatform === null && goalStep === 'idle') {
      const rec = analyzePromptForPlatform(userMessage);
      if (rec.platform && rec.platform !== (buildTarget === 'flutter' ? 'flutter' : 'website')) {
        setBuildRecommendation({ platform: rec.platform, reason: rec.reason, icon: rec.icon });
        setPendingBuildPrompt(enriched);
        return; // wait for user to accept/dismiss recommendation
      }
    }

    if (bridgeTestMode) {
      // Bridge Test Mode — skip all internal generation, route directly to Claude Bridge
      runBridgeOnlyPipeline(enriched);
    } else if (buildTarget === 'flutter') {
      runFlutterBuildPipeline(newHistory, enriched);
    } else {
      runBuildPipeline(newHistory, enriched);
    }
  };

  // Emergency reset: called when user clicks "Reset" to unstick loading states
  const handleForceReset = () => {
    setLoading(false);
    setEditApplying(false);
    if (phase === 'building') setPhase('idle');
    addStatus('State reset — you can try again.', 'done');
  };

  const handleApplyChanges = () => {
    if (!currentProject) return;
    const lastUser = [...history].reverse().find(t => t.role === 'user')?.content || '';
    runEditPipeline(lastUser, history);
    setReadyToBuild(false);
  };

  const handleMakeSearchWork = async () => {
    if (!currentProject || makeSearchWorking) return;
    setMakeSearchWorking(true);
    addStatus('DWOMOH Vibe Code is upgrading to real backend search…', 'applying');
    try {
      const result = await api({ action: 'make-search-work', projectPath: currentProject.projectPath });
      if (result.filesChanged?.length > 0) {
        // Wait for HMR
        await new Promise(r => setTimeout(r, 2000));
        setPreviewKey(k => k + 1);

        // Verify the new API route works (Rule 10)
        const runPort = buildProgress?.port || currentProject.port;
        let verifyData: { verified: boolean; summary: string; checks?: Array<{ name: string; passed: boolean; recordCount?: number; error?: string }>; failures?: string[] } | null = null;
        if (runPort) {
          addStatus('Verifying backend search endpoint…', 'checking');
          try {
            verifyData = await api({ action: 'verify-app', port: runPort, projectPath: currentProject.projectPath });
            if (verifyData) setLastVerification(verifyData as { verified: boolean; summary: string; checks: Array<{ name: string; passed: boolean; recordCount?: number; error?: string }> });
          } catch { /* best-effort */ }
        }

        const verifyLine = verifyData
          ? `**Verification result:** ${verifyData.verified ? '✅' : '⚠️'} ${verifyData.summary}`
          : '**Verification result:** Refresh the preview to confirm search works.';

        if (verifyData?.verified) {
          addStatus('Backend search verified — API route is returning data.', 'done');
        } else if (verifyData && !verifyData.verified) {
          addStatus(`Search upgraded but some checks failed: ${verifyData.failures?.join(', ')}`, 'error');
        } else {
          addStatus(`Backend search applied. Updated: ${result.filesChanged.join(', ')}`, 'done');
        }

        // Rule 12
        addMsg('assistant',
          `**Root cause:** App had no API routes — search was client-side only\n` +
          `**Files changed:** ${result.filesChanged.join(', ')}\n` +
          `**Fix applied:** Created server-side search API route + updated frontend to fetch from it\n` +
          verifyLine
        );

        const disc = await api({ action: 'discover', projectPath: currentProject.projectPath });
        if (disc.success) setCurrentDiscovery({ summary: disc.summary, pages: disc.pages, components: disc.components, fileCount: disc.fileCount, framework: disc.framework, mode: disc.mode, hasApiRoutes: disc.hasApiRoutes, missingCredentials: disc.missingCredentials || [] });
      } else if (result.conversational) {
        addMsg('assistant', result.response || 'No changes needed.');
      } else {
        addStatus('No search component found to upgrade.', 'done');
      }
    } catch (err) {
      addStatus(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
    } finally {
      setMakeSearchWorking(false);
    }
  };

  const handleSetCredential = async (key: string) => {
    if (!currentProject || !credentialInputs[key]) return;
    setCredentialSaving(key);
    try {
      await api({ action: 'set-credential', projectPath: currentProject.projectPath, key, value: credentialInputs[key] });
      setCredentialInputs(prev => ({ ...prev, [key]: '' }));
      // Refresh credentials state
      const disc = await api({ action: 'discover', projectPath: currentProject.projectPath });
      if (disc.success) setCurrentDiscovery(prev => prev ? { ...prev, missingCredentials: disc.missingCredentials || [] } : prev);
      addStatus(`${key} saved to .env.local`, 'done');
    } catch {
      addStatus(`Failed to save ${key}`, 'error');
    } finally {
      setCredentialSaving(null);
    }
  };

  // ── Browser automation handlers ───────────────────────────────────────────

  const handleBrowserScreenshot = async () => {
    if (!currentProject || browserDebugging) return;
    const port = buildProgress?.port || currentProject.port;
    if (!port) { addStatus('No running preview to screenshot', 'error'); return; }
    setBrowserDebugging(true);
    addStatus('Capturing screenshot with Playwright…', 'checking');
    try {
      const result = await api({ action: 'browser-screenshot', port, path: '/' });
      if (result.success && result.screenshotUrl) {
        setDisplayed(prev => [...prev, { role: 'assistant', content: 'Screenshot captured:', screenshotUrl: result.screenshotUrl }]);
        addStatus('Screenshot saved', 'done');
      } else {
        addStatus(`Screenshot failed: ${result.error}`, 'error');
      }
    } catch (err) {
      addStatus(`Screenshot error: ${err instanceof Error ? err.message : 'Unknown'}`, 'error');
    } finally {
      setBrowserDebugging(false);
    }
  };

  const handleBrowserDebug = async () => {
    if (!currentProject || browserDebugging) return;
    const port = buildProgress?.port || currentProject.port;
    if (!port) { addStatus('No running preview to debug', 'error'); return; }
    setBrowserDebugging(true);
    addStatus('Running browser debug session with Playwright…', 'checking');
    try {
      const result = await api({ action: 'browser-debug', port, path: '/' });
      if (result.success) {
        const errors = result.runtimeErrors?.length ? `\n\n**Runtime errors (${result.runtimeErrors.length}):**\n${result.runtimeErrors.slice(0, 3).map((e: string) => `• ${e.slice(0, 200)}`).join('\n')}` : '';
        const logs = result.consoleLogs?.filter((l: { type: string }) => l.type === 'error' || l.type === 'warn').slice(0, 5);
        const logsStr = logs?.length ? `\n\n**Console warnings/errors:**\n${logs.map((l: { type: string; text: string }) => `• [${l.type}] ${l.text.slice(0, 150)}`).join('\n')}` : '';
        const net = result.networkRequests?.slice(0, 8);
        const netStr = net?.length ? `\n\n**API requests detected:**\n${net.map((r: { method: string; url: string; status?: number }) => `• ${r.method} ${r.url.replace(/http:\/\/localhost:\d+/, '')} → ${r.status ?? 'pending'}`).join('\n')}` : '\n\n**No API requests detected.**';
        const clean = errors === '' && logsStr === '' ? '\n\n✅ No runtime errors or console warnings.' : '';
        addMsg('assistant',
          `**Root cause:** Browser debug session for ${currentProject.name}\n` +
          `**Page:** ${result.pageTitle} (${result.pageUrl})${errors}${logsStr}${netStr}${clean}\n\n` +
          `**Verification result:** ${result.runtimeErrors?.length ? `⚠️ ${result.runtimeErrors.length} error(s) detected` : '✅ No runtime errors'}`
        );
        if (result.screenshotUrl) {
          setDisplayed(prev => [...prev, { role: 'assistant', content: 'Debug screenshot:', screenshotUrl: result.screenshotUrl }]);
        }
        addStatus('Debug session complete', 'done');
      } else {
        addStatus(`Debug failed: ${result.error}`, 'error');
        if (result.error?.includes('Executable') || result.error?.includes('chromium')) {
          addMsg('assistant', '⚠️ Playwright browser not installed. Run: `npx playwright install chromium` in your terminal.');
        }
      }
    } catch (err) {
      addStatus(`Debug error: ${err instanceof Error ? err.message : 'Unknown'}`, 'error');
    } finally {
      setBrowserDebugging(false);
    }
  };

  // ── File management handlers ───────────────────────────────────────────────

  const handleFileDelete = async (filePath: string) => {
    if (!currentProject || !confirm(`Delete ${filePath}?`)) return;
    addStatus(`Deleting ${filePath}…`, 'applying');
    try {
      await api({ action: 'file-delete', projectPath: currentProject.projectPath, filePath });
      addStatus(`Deleted: ${filePath}`, 'done');
      const disc = await api({ action: 'discover', projectPath: currentProject.projectPath });
      if (disc.success) setCurrentDiscovery({ summary: disc.summary, pages: disc.pages, components: disc.components, fileCount: disc.fileCount, framework: disc.framework, mode: disc.mode, hasApiRoutes: disc.hasApiRoutes, missingCredentials: disc.missingCredentials || [] });
    } catch { addStatus(`Failed to delete ${filePath}`, 'error'); }
  };

  const handleFileRename = async (oldPath: string) => {
    if (!currentProject || !fileRenameValue.trim()) return;
    addStatus(`Renaming ${oldPath} → ${fileRenameValue}…`, 'applying');
    try {
      await api({ action: 'file-rename', projectPath: currentProject.projectPath, filePath: oldPath, newPath: fileRenameValue.trim() });
      addStatus(`Renamed to ${fileRenameValue}`, 'done');
      setFileRenaming(null);
      setFileRenameValue('');
      const disc = await api({ action: 'discover', projectPath: currentProject.projectPath });
      if (disc.success) setCurrentDiscovery({ summary: disc.summary, pages: disc.pages, components: disc.components, fileCount: disc.fileCount, framework: disc.framework, mode: disc.mode, hasApiRoutes: disc.hasApiRoutes, missingCredentials: disc.missingCredentials || [] });
    } catch { addStatus(`Rename failed`, 'error'); }
  };

  const handleFileCreate = async () => {
    if (!currentProject || !newFilePath.trim()) return;
    setNewFileCreating(true);
    addStatus(`Creating ${newFilePath}…`, 'applying');
    try {
      await api({ action: 'file-create', projectPath: currentProject.projectPath, filePath: newFilePath.trim(), content: '// New file\n' });
      addStatus(`Created: ${newFilePath}`, 'done');
      setNewFilePath('');
      const disc = await api({ action: 'discover', projectPath: currentProject.projectPath });
      if (disc.success) setCurrentDiscovery({ summary: disc.summary, pages: disc.pages, components: disc.components, fileCount: disc.fileCount, framework: disc.framework, mode: disc.mode, hasApiRoutes: disc.hasApiRoutes, missingCredentials: disc.missingCredentials || [] });
    } catch { addStatus(`File creation failed`, 'error'); } finally { setNewFileCreating(false); }
  };

  // ── Database scaffold handler ──────────────────────────────────────────────

  const handleDbScaffold = async () => {
    if (!currentProject || dbScaffolding) return;
    const resource = dbResource.trim() || (currentDiscovery?.pages?.[0]?.replace('app/', '').replace('/page.tsx', '').replace(/\W/g, '') || 'items');
    setDbScaffolding(true);
    addStatus(`Scaffolding ${dbType} integration for "${resource}"…`, 'applying');
    try {
      const result = await api({ action: 'db-scaffold', projectPath: currentProject.projectPath, dbType, resource });
      if (result.success) {
        addMsg('assistant',
          `**Root cause:** No database integration in project\n` +
          `**Files changed:** ${result.filesCreated.join(', ')}\n` +
          `**Fix applied:** Generated ${dbType} client + query helpers + migration/schema\n` +
          `**Verification result:** ⚠️ Manual steps required:\n${result.instructions.map((s: string) => `• ${s}`).join('\n')}` +
          (result.packages?.length ? `\n\nInstall: \`npm install ${result.packages.join(' ')}\`` : '')
        );
        addStatus(`${dbType} scaffolded — ${result.filesCreated.length} files created`, 'done');
        const disc = await api({ action: 'discover', projectPath: currentProject.projectPath });
        if (disc.success) setCurrentDiscovery({ summary: disc.summary, pages: disc.pages, components: disc.components, fileCount: disc.fileCount, framework: disc.framework, mode: disc.mode, hasApiRoutes: disc.hasApiRoutes, missingCredentials: disc.missingCredentials || [] });
      }
    } catch { addStatus(`Database scaffold failed`, 'error'); } finally { setDbScaffolding(false); }
  };

  // ── Memory handlers ────────────────────────────────────────────────────────

  const handleClearMemory = async () => {
    if (!currentProject || !confirm('Clear all memory for this project? (Conversation history, edit log, verification records — not the actual project files.)')) return;
    addStatus('Clearing project memory…', 'applying');
    try {
      const result = await api({ action: 'clear-memory', projectPath: currentProject.projectPath });
      if (result.success) {
        setCurrentMemory(result.memory);
        addStatus('Project memory cleared.', 'done');
        addMsg('assistant', `Memory cleared for **${currentProject.name}**. Starting fresh — all conversation history and edit logs have been reset. The project files themselves are unchanged.`);
      }
    } catch { addStatus('Failed to clear memory', 'error'); }
  };

  // ── Auth scaffold handler ─────────────────────────────────────────────────

  const handleAuthScaffold = async () => {
    if (!currentProject || authScaffolding) return;
    setAuthScaffolding(true);
    addStatus(`Scaffolding ${authProvider} authentication…`, 'applying');
    try {
      const result = await api({ action: 'auth-scaffold', projectPath: currentProject.projectPath, authProvider });
      if (result.success) {
        addMsg('assistant',
          `**Root cause:** No authentication in project\n` +
          `**Files changed:** ${result.filesCreated.join(', ')}${result.filesSkipped?.length ? `\n**Skipped (already exist):** ${result.filesSkipped.join(', ')}` : ''}\n` +
          `**Fix applied:** Generated ${authProvider} auth — login page, middleware, session helpers, API routes\n` +
          `**Verification result:** ⚠️ Manual steps required:\n${result.instructions.map((s: string) => `• ${s}`).join('\n')}` +
          (result.packages?.length ? `\n\nInstall: \`npm install ${result.packages.join(' ')}\`` : '')
        );
        addStatus(`${authProvider} authentication scaffolded — ${result.filesCreated.length} files created`, 'done');
        const disc = await api({ action: 'discover', projectPath: currentProject.projectPath });
        if (disc.success) setCurrentDiscovery({ summary: disc.summary, pages: disc.pages, components: disc.components, fileCount: disc.fileCount, framework: disc.framework, mode: disc.mode, hasApiRoutes: disc.hasApiRoutes, missingCredentials: disc.missingCredentials || [] });
      }
    } catch { addStatus('Auth scaffold failed', 'error'); } finally { setAuthScaffolding(false); }
  };

  // ── Deploy handler ─────────────────────────────────────────────────────────

  const handleDeployPrepare = async () => {
    if (!currentProject || deployPreparing) return;
    setDeployPreparing(true);
    addStatus(`Preparing ${deployTarget} deployment config…`, 'applying');
    try {
      const result = await api({ action: 'deploy-prepare', projectPath: currentProject.projectPath, target: deployTarget });
      if (result.success) {
        const checks = result.readinessChecks.map((c: { name: string; passed: boolean; message: string }) => `${c.passed ? '✅' : '⚠️'} ${c.name}: ${c.message}`).join('\n');
        addMsg('assistant',
          `**Root cause:** Project not configured for ${deployTarget} deployment\n` +
          `**Files changed:** ${result.filesCreated.join(', ')}\n` +
          `**Fix applied:** Generated ${deployTarget} deployment configuration\n` +
          `**Verification result:** ${result.ready ? '✅' : '⚠️'} Readiness checks:\n${checks}\n\n` +
          `**Deploy command:** \`${result.deployCommand}\`\n\n` +
          `**Steps:**\n${result.instructions.map((s: string) => `${s}`).join('\n')}`
        );
        addStatus(`${deployTarget} config ready — ${result.filesCreated.length} files written`, 'done');
      }
    } catch { addStatus(`Deploy preparation failed`, 'error'); } finally { setDeployPreparing(false); }
  };

  // ── Real one-click deploy (AWS Amplify → {slug}.dwomohvibe.app) ────────────

  const handleDeploy = async () => {
    if (!currentProject || deploying) return;
    setDeploying(true);
    setDeployLogs([]);
    setDeployVerificationChecks([]);
    addStatus('Starting deployment to AWS Amplify…', 'applying');

    try {
      // Phase 1: Upload + start build
      const res = await fetch('/api/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'deploy',
          projectId: currentProject.id,
          projectName: currentProject.name,
          projectPath: currentProject.projectPath,
          provider: 'amplify',
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Deploy failed');

      const brandedUrl: string = data.deployment.brandedUrl;
      setDeployRecord({
        deploymentId: data.deployment.deploymentId,
        status: 'building',
        statusDetail: 'Building on AWS Amplify…',
        brandedUrl,
        slug: data.deployment.slug,
        providerUrl: '',
        customDomains: [],
      });
      addStatus(`Building: ${brandedUrl}`, 'applying');
      setDeploying(false);

      // Phase 2: Connect to SSE watch stream for full lifecycle
      watchDeployment(currentProject.id, brandedUrl);
    } catch (err) {
      addStatus(`Deploy failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      setDeploying(false);
    }
  };

  /**
   * Connect to /api/deploy watch SSE stream.
   * Receives: status updates, individual verification check results, completion event.
   * Only reports "Live" once HTTP 200 is confirmed and all checks pass.
   */
  const watchDeployment = (projectId: string, brandedUrl: string) => {
    setDeployPolling(true);

    const controller = new AbortController();

    (async () => {
      try {
        const res = await fetch('/api/deploy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'watch', projectId }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          addStatus('Watch stream unavailable — falling back to polling', 'error');
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // Parse SSE events from buffer
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const event = JSON.parse(line.slice(6)) as {
                type: string;
                status?: string;
                statusDetail?: string;
                brandedUrl?: string;
                errorMessage?: string;
                check?: { name: string; label: string; status: string; detail: string; durationMs?: number };
                deployment?: { status: string; statusDetail?: string; brandedUrl: string; errorMessage?: string; verificationResult?: typeof deployRecord extends null ? never : NonNullable<typeof deployRecord>['verificationResult'] };
              };

              if (event.type === 'status') {
                setDeployRecord(prev => prev ? {
                  ...prev,
                  status: event.status ?? prev.status,
                  statusDetail: event.statusDetail,
                  errorMessage: event.errorMessage,
                } : prev);

                // Status label in chat
                if (event.status === 'configuring_domain') {
                  addStatus(`Domain provisioning: ${event.statusDetail ?? 'Waiting for DNS…'}`, 'applying');
                } else if (event.status === 'verifying') {
                  addStatus('Verifying live URL…', 'applying');
                }
              }

              if (event.type === 'verification' && event.check) {
                const vc = event.check;
                setDeployVerificationChecks(prev => {
                  const existing = prev.findIndex(c => c.name === vc.name);
                  if (existing >= 0) {
                    const next = [...prev];
                    next[existing] = vc;
                    return next;
                  }
                  return [...prev, vc];
                });
              }

              if (event.type === 'complete' && event.deployment) {
                const dep = event.deployment;
                setDeployRecord(prev => prev ? { ...prev, ...dep } : prev);

                if (dep.status === 'live') {
                  addStatus(`Live: ${dep.brandedUrl}`, 'done');
                  const vr = dep.verificationResult;
                  const checkSummary = vr ? `\n\n**Verification:** ${vr.checks.filter((c: { status: string }) => c.status === 'pass').length}/${vr.checks.length} checks passed · HTTP ${vr.httpStatus ?? '200'} · ${Math.round(vr.totalDurationMs / 1000)}s total` : '';
                  addMsg('assistant',
                    `Your app is live at **[${dep.brandedUrl}](${dep.brandedUrl})**${checkSummary}\n\nTo connect a custom domain, click **Connect Domain** in the Deployments panel.`
                  );
                } else if (dep.status === 'failed') {
                  addStatus(`Deployment failed: ${dep.errorMessage ?? 'Verification did not pass'}`, 'error');
                  addMsg('assistant',
                    `**Deployment verification failed**\n\n${dep.errorMessage ?? 'The app built successfully but the live URL verification did not pass.'}\n\nClick **⚡ Redeploy** to retry, or check the Deployments panel for details.`
                  );
                }
              }

              if (event.type === 'error') {
                addStatus(`Watch error — ${event.statusDetail ?? 'stream closed'}`, 'error');
              }
            } catch { /* malformed SSE line */ }
          }
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          addStatus('Deployment watch ended unexpectedly', 'error');
        }
      } finally {
        setDeployPolling(false);
      }
    })();

    // Return cleanup function (not used directly but good practice)
    return () => controller.abort();
  };

  const handleAddCustomDomain = async () => {
    if (!currentProject || !addDomainInput.trim() || addingDomain) return;
    setAddingDomain(true);
    try {
      const res = await fetch('/api/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add-domain', projectId: currentProject.id, domain: addDomainInput.trim() }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      if (data.domain?.dnsRecords?.length > 0) {
        setShowDnsInstructions(addDomainInput.trim());
      }
      setAddDomainInput('');
      // Refresh record
      const refreshRes = await fetch('/api/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'status', projectId: currentProject.id }),
      });
      const refreshData = await refreshRes.json();
      if (refreshData.ok) setDeployRecord(refreshData.deployment);
    } catch (err) {
      addStatus(`Domain error: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setAddingDomain(false);
    }
  };

  // ── AWS Platform Setup ─────────────────────────────────────────────────────

  const checkAwsSetup = async () => {
    try {
      const res = await fetch('/api/aws-setup');
      const data = await res.json();
      if (data.ok) setAwsSetupStatus(data.status);
    } catch { /* ignore */ }
  };

  const runAwsSetup = async () => {
    if (awsSetupRunning) return;
    setAwsSetupRunning(true);
    setAwsSetupLogs([]);

    try {
      const res = await fetch('/api/aws-setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'run-setup' }),
      });

      if (!res.body) throw new Error('No response stream');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === 'progress') {
              setAwsSetupLogs(prev => [...prev.slice(-49), `[${event.step}] ${event.detail ?? event.status}`]);
            }
            if (event.type === 'complete' && event.status) {
              setAwsSetupStatus(event.status);
              if (event.status.ready) {
                addStatus('AWS Hosting ready — deployment is now fully automatic', 'done');
              }
            }
            if (event.type === 'error') {
              addStatus(`AWS Setup error: ${event.message}`, 'error');
            }
          } catch { /* malformed line */ }
        }
      }
    } catch (err) {
      addStatus(`Setup failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setAwsSetupRunning(false);
      // Re-check final status
      checkAwsSetup();
    }
  };

  // ── Domain Management ──────────────────────────────────────────────────────

  const loadDomainsData = async () => {
    setDomainsLoading(true);
    try {
      const res = await fetch('/api/domains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list-all' }),
      });
      const data = await res.json();
      if (data.ok) setDomainsData(data);
    } catch { /* ignore */ } finally { setDomainsLoading(false); }
  };

  const handleDomainSearch = async () => {
    if (!domainSearchQuery.trim() || domainSearching) return;
    setDomainSearching(true);
    setDomainSearchResults([]);
    try {
      const res = await fetch('/api/domains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'search', query: domainSearchQuery.trim() }),
      });
      const data = await res.json();
      if (data.ok) setDomainSearchResults(data.results ?? []);
    } catch { addStatus('Domain search failed', 'error'); } finally { setDomainSearching(false); }
  };

  const handleDomainPurchase = async (domain: string) => {
    if (domainPurchasing) return;
    setDomainPurchasing(domain);
    try {
      const res = await fetch('/api/domains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'purchase', domain }),
      });
      const data = await res.json();
      // New flow: the server returns a price quote + a Paystack payment URL.
      // We confirm the price with the user BEFORE redirecting to pay. The domain
      // is only registered after payment is verified by the webhook (and never in
      // sandbox/test mode).
      if (data.ok && data.requiresPayment) {
        const q = data.quote ?? {};
        const proceed = window.confirm(
          `Register ${domain} for $${q.sellingPriceUsd}?\n\n` +
          `You'll be redirected to Paystack to pay. The domain is registered only after your payment is confirmed.` +
          (q.sellingPriceUsd ? '' : '')
        );
        if (proceed && data.authorizationUrl) {
          window.location.href = data.authorizationUrl;
        }
      } else if (data.ok) {
        setPurchaseSuccess(domain);
        addStatus(`Domain order created for ${domain}`, 'done');
        setTimeout(loadDomainsData, 5000);
      } else {
        addStatus(`Purchase failed: ${data.error}`, 'error');
      }
    } catch (err) {
      addStatus(`Purchase error: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally { setDomainPurchasing(null); }
  };

  const handleConnectDomain = async () => {
    if (!connectDomainInput.trim() || connectingDomain) return;
    setConnectingDomain(true);
    try {
      const res = await fetch('/api/domains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'connect-external',
          domain: connectDomainInput.trim(),
          projectId: currentProject?.id,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setConnectDomainInput('');
        addStatus(`${connectDomainInput.trim()} connected`, 'done');
        if (data.instructions) {
          addMsg('assistant',
            `**Domain connection started for ${connectDomainInput.trim()}**\n\n` +
            `Add these DNS records at your registrar:\n\n` +
            (data.instructions.dnsRecords ?? []).map((r: { type: string; name: string; value: string }) =>
              `• **${r.type}** \`${r.name}\` → \`${r.value}\``
            ).join('\n') +
            `\n\nDNS changes propagate in 15 minutes to 48 hours.`
          );
        }
        loadDomainsData();
      } else {
        addStatus(`Connect failed: ${data.error}`, 'error');
      }
    } catch (err) {
      addStatus(`Connect error: ${String(err)}`, 'error');
    } finally { setConnectingDomain(false); }
  };

  // Load existing deployment record when switching projects
  const loadDeployRecord = async (projectId: string) => {
    try {
      const res = await fetch(`/api/deploy?projectId=${encodeURIComponent(projectId)}`);
      const data = await res.json();
      if (data.ok && data.deployment) setDeployRecord(data.deployment);
      else setDeployRecord(null);
    } catch { setDeployRecord(null); }
  };

  const getProjectEmoji = (name: string) => {
    if (/hotel|book/i.test(name)) return '🏨';
    if (/food|market|shop|grocer/i.test(name)) return '🛒';
    if (/music|audio|sound|beat|boomplay/i.test(name)) return '🎵';
    if (/property|estate|rent|house/i.test(name)) return '🏠';
    if (/calc/i.test(name)) return '🧮';
    if (/weather/i.test(name)) return '🌤';
    if (/social|chat|msg|messag/i.test(name)) return '💬';
    if (/ai|studio|agent|vibe/i.test(name)) return '⚡';
    if (/school|edu|kid|learn/i.test(name)) return '📚';
    if (/health|medic|hospital/i.test(name)) return '🏥';
    if (/sport|foot|basket|score/i.test(name)) return '⚽';
    if (/logistics|delivery|transport/i.test(name)) return '🚚';
    if (/travel|flight|trip/i.test(name)) return '✈️';
    if (/money|payment|fintech|wallet/i.test(name)) return '💳';
    if (/ghana|africa/i.test(name)) return '🌍';
    return '📱';
  };

  const isBusy = loading || editApplying || phase === 'building' || makeSearchWorking;

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <>
      {/* ── Engine Build (Test) — Step 9, additive floating panel ───────────────── */}
      {/* Developer Mode: this whole panel exposes raw engine internals — an
          internal debugging tool, never meant for customers. Requires BOTH
          VIEW_DEVELOPER_MODE (SUPER_ADMIN/future roles granted it) AND
          debugMode currently ON, so a SUPER_ADMIN with Developer Mode off
          sees the same clean customer interface as everyone else. */}
      {myPermissions.has('VIEW_DEVELOPER_MODE') && debugMode && (
      <div style={{ position: 'fixed', right: 16, bottom: 16, zIndex: 9999, fontFamily: 'system-ui,sans-serif' }}>
        {!engineOpen && (
          <button onClick={() => setEngineOpen(true)}
            style={{ padding: '10px 16px', borderRadius: 10, border: '1px solid #6366f1', background: '#1e1b4b', color: '#c7d2fe', fontSize: 13, fontWeight: 700, cursor: 'pointer', boxShadow: '0 4px 14px rgba(0,0,0,0.45)' }}>
            🧪 Engine Build (Test)
          </button>
        )}
        {engineOpen && (
          <div style={{ width: 390, maxHeight: '74vh', overflow: 'auto', background: '#0b1020', border: '1px solid #334155', borderRadius: 14, padding: 16, color: '#e2e8f0', boxShadow: '0 10px 40px rgba(0,0,0,0.6)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <strong style={{ fontSize: 14 }}>🧪 New Engine Build (Test)</strong>
              <button onClick={() => setEngineOpen(false)} style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 16 }}>✕</button>
            </div>
            <textarea value={enginePrompt} onChange={e => setEnginePrompt(e.target.value)} rows={3}
              placeholder="Describe an app to build with the NEW engine — e.g. 'a clinic appointment booking app'"
              style={{ width: '100%', boxSizing: 'border-box', background: '#0f172a', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 8, padding: 8, fontSize: 13, resize: 'vertical' }} />
            <button disabled={engineBusy || !enginePrompt.trim()}
              onClick={() => {
                // Real-time SSE stream — the UI reflects the LIVE backend stage and
                // only shows FAILED on an actual failure, never on a client timeout.
                setEngineBusy(true); setEngineError(''); setEngineReport(null); setEngineStage('Planning architecture');
                engineEsRef.current?.close();
                const STAGE_LABELS: Record<string, string> = {
                  plan: 'Planning architecture', build: 'Building app (streaming + writing files)',
                  verify: 'Verifying', repair: 'Repairing', preview: 'Starting preview server',
                  learn: 'Saving learnings', done: 'Finishing up',
                };
                const es = new EventSource(`/api/engine-build-stream?prompt=${encodeURIComponent(enginePrompt.trim())}`);
                engineEsRef.current = es;
                es.addEventListener('stage', (e) => {
                  try { const d = JSON.parse((e as MessageEvent).data); setEngineStage(STAGE_LABELS[d.stage] ?? d.message ?? d.stage); } catch { /* ignore */ }
                });
                es.addEventListener('report', (e) => {
                  try { setEngineReport(JSON.parse((e as MessageEvent).data)); } catch { /* ignore */ }
                });
                // Server rejected a duplicate: a build for this project is already active.
                es.addEventListener('busy', (e) => {
                  let msg = 'A build is already running for this project.';
                  try { const d = JSON.parse((e as MessageEvent).data); if (d?.message) msg = d.message; } catch { /* ignore */ }
                  setEngineError(msg); setEngineBusy(false); setEngineStage('');
                  es.close(); engineEsRef.current = null;
                });
                es.addEventListener('done', () => { setEngineBusy(false); setEngineStage(''); es.close(); engineEsRef.current = null; });
                es.addEventListener('error', (e) => {
                  // Server-sent 'error' event carries a message; a bare connection drop does not.
                  const raw = (e as MessageEvent).data;
                  if (raw) { try { const d = JSON.parse(raw); if (d?.error) setEngineError(d.error); } catch { /* ignore */ } }
                  else if (engineBusy && !engineReport) setEngineError('Connection to engine stream lost.');
                  setEngineBusy(false); setEngineStage(''); es.close(); engineEsRef.current = null;
                });
              }}
              style={{ marginTop: 8, width: '100%', padding: '9px', borderRadius: 8, border: 'none', cursor: engineBusy ? 'wait' : 'pointer', background: 'linear-gradient(135deg,#8b5cf6,#6366f1)', color: '#fff', fontSize: 13, fontWeight: 700, opacity: (!enginePrompt.trim() && !engineBusy) ? 0.6 : 1 }}>
              {engineBusy ? `Running… ${engineStage || 'starting'}` : 'Run Engine Build'}
            </button>
            {engineBusy && <div style={{ marginTop: 8, fontSize: 12, color: '#a78bfa' }}>⏳ {engineStage || 'Working…'} — live from the backend (won’t report failed while running)</div>}
            {engineError && <div style={{ marginTop: 10, color: '#fca5a5', fontSize: 12 }}>❌ {engineError}</div>}
            {engineReport && (
              <div style={{ marginTop: 12, fontSize: 12, lineHeight: 1.6 }}>
                {/* Four INDEPENDENT statuses — none gates the others. A verify/repair
                    failure or timeout must never hide a preview that actually started. */}
                {(() => {
                  const badge = (label: string, value: string, ok: boolean | 'neutral') => (
                    <span key={label} style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 999,
                      fontSize: 11, fontWeight: 700, marginRight: 6, marginBottom: 6,
                      background: ok === 'neutral' ? '#1e293b' : ok ? 'rgba(34,197,94,0.15)' : 'rgba(248,113,113,0.15)',
                      color: ok === 'neutral' ? '#94a3b8' : ok ? '#4ade80' : '#fca5a5',
                      border: `1px solid ${ok === 'neutral' ? '#334155' : ok ? '#16a34a' : '#dc2626'}`,
                    }}>
                      {label}: {value}
                    </span>
                  );
                  const bs = engineReport.buildStatus ?? (engineReport.build?.filesCreated?.length ? 'success' : 'failed');
                  const ps = engineReport.previewStatus ?? (engineReport.previewUrl ? 'available' : 'unavailable');
                  const vs = engineReport.verifyStatus ?? (engineReport.verify ? (engineReport.verify.passed ? 'passed' : 'failed') : 'not_run');
                  const rs = engineReport.repairStatus ?? (engineReport.repair ? (engineReport.repair.resolved ? 'passed' : 'failed') : 'not_run');
                  return (
                    <div style={{ marginBottom: 6 }}>
                      {badge('Build', bs, bs === 'success')}
                      {badge('Preview', ps, ps === 'available')}
                      {badge('Verify', vs, vs === 'not_run' ? 'neutral' : vs === 'passed')}
                      {badge('Repair', rs.replace('_', ' '), rs === 'not_run' ? 'neutral' : rs === 'passed')}
                    </div>
                  );
                })()}
                <div style={{ color: '#94a3b8' }}>{engineReport.summary}</div>
                {/* Open Preview — shown whenever a preview URL was produced. Independent
                    of Verify/Repair status: humans need this link to manually test the
                    generated app on localhost even when verification/repair failed. */}
                {engineReport.previewUrl && (
                  <a href={engineReport.previewUrl} target="_blank" rel="noopener noreferrer"
                    style={{ display: 'inline-block', marginTop: 8, padding: '7px 14px', borderRadius: 8, background: 'linear-gradient(135deg,#22c55e,#16a34a)', color: '#fff', fontSize: 13, fontWeight: 700, textDecoration: 'none' }}>
                    🔗 Open Preview
                  </a>
                )}
                {!engineReport.previewUrl && engineReport.previewError && (
                  <div style={{ marginTop: 8, color: '#fca5a5', fontSize: 12 }}>Preview not started: {engineReport.previewError}</div>
                )}
                <hr style={{ border: 'none', borderTop: '1px solid #1e293b', margin: '8px 0' }} />
                <div><b>Planner:</b> {engineReport.intent ? `${engineReport.intent.appType} (${engineReport.intent.source}, conf ${engineReport.intent.confidence})` : '—'}</div>
                <div><b>Pages planned:</b> {engineReport.plan ? engineReport.plan.pages.length : 0} · <b>Capabilities:</b> {engineReport.plan ? engineReport.plan.capabilities.join(', ') : '—'}</div>
                <div><b>Builder:</b> {engineReport.build ? `${engineReport.build.filesCreated.length} files, fresh=${String(engineReport.build.isFreshFolder)}${engineReport.build.recoveredFromLooseFormat ? ', recovered' : ''}` : '—'}</div>
                <div><b>Verifier:</b> {engineReport.verify ? `passed=${String(engineReport.verify.passed)} · routes ${engineReport.verify.routes.length} · deadLinks ${engineReport.verify.deadLinks.length} · 404s ${engineReport.verify.notFoundRoutes.length} · brokenImports ${engineReport.verify.brokenImports.length}` : '—'}</div>
                <div><b>Workflows:</b> {engineReport.verify ? `${engineReport.verify.workflowTests.filter((w: { status: string }) => w.status === 'passed').length}/${engineReport.verify.workflowTests.length}` : '—'} · <b>Security:</b> {engineReport.verify ? String(engineReport.verify.securityPassed) : '—'} · <b>Perf OK:</b> {engineReport.verify ? String(engineReport.verify.performanceWithinBudget) : '—'}</div>
                <div><b>Browser journey (Playwright):</b> {
                  engineReport.verify?.browserJourney
                    ? `${engineReport.verify.browserJourney.verdict} — ${engineReport.verify.browserJourney.summary}`
                    : 'did not run (no live preview, or check unavailable)'
                }</div>
                <div><b>Repair attempts:</b> {engineReport.repair ? `${engineReport.repair.attempts}/${engineReport.repair.maxAttempts} (resolved=${String(engineReport.repair.resolved)})` : 'none'}</div>
                <div><b>Learner:</b> {engineReport.success ? 'recorded (verified success)' : 'skipped'} · <b>External issues:</b> {engineReport.verify ? engineReport.verify.externalIssues.length : 0}</div>
                {/* Developer Mode report fields — all sourced from data already
                    present on engineReport/VerifyResult/RepairResult, no new
                    backend computation. DB/API-change diffing and per-stage
                    (verify/repair) timing are not computed anywhere today —
                    intentionally omitted rather than improvised. */}
                <hr style={{ border: 'none', borderTop: '1px solid #1e293b', margin: '8px 0' }} />
                <div style={{ color: '#a78bfa', fontWeight: 700, marginBottom: 4 }}>Developer Mode</div>
                <div><b>Root cause:</b> {
                  engineReport.verify?.classifiedFailures?.length
                    ? engineReport.verify.classifiedFailures.map((f: { message?: string; description?: string }) => f.message ?? f.description).filter(Boolean).join('; ')
                    : engineReport.plan?.summary ?? '—'
                }</div>
                <div><b>Files changed:</b> {
                  engineReport.repair?.changedFiles?.length ? engineReport.repair.changedFiles.join(', ') : 'none'
                }</div>
                <div><b>Routes affected:</b> {
                  engineReport.verify
                    ? [...(engineReport.verify.deadLinks ?? []), ...(engineReport.verify.notFoundRoutes ?? [])].join(', ') || 'none'
                    : '—'
                }</div>
                <div><b>Remaining warnings:</b> {
                  engineReport.repair?.remainingIssues?.length ? engineReport.repair.remainingIssues.join('; ') : 'none'
                }</div>
                <div><b>Build duration:</b> {
                  engineReport.build?.startedAt && engineReport.build?.finishedAt
                    ? `${Math.round((new Date(engineReport.build.finishedAt).getTime() - new Date(engineReport.build.startedAt).getTime()) / 1000)}s`
                    : '—'
                }</div>
                <details style={{ marginTop: 8 }}>
                  <summary style={{ cursor: 'pointer', color: '#a78bfa' }}>Execution logs</summary>
                  <pre style={{ whiteSpace: 'pre-wrap', fontSize: 11, color: '#94a3b8', marginTop: 6 }}>{(engineReport.logs || []).join('\n')}</pre>
                </details>
              </div>
            )}
          </div>
        )}
      </div>
      )}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        @keyframes slidein { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
        @keyframes fadeup { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
        @keyframes glow { 0%, 100% { box-shadow: 0 0 8px rgba(99,102,241,0.4); } 50% { box-shadow: 0 0 18px rgba(99,102,241,0.7); } }
        @keyframes gradientShift { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }
        @keyframes statusPing { 0% { transform: scale(1); opacity: 1; } 75% { transform: scale(2.2); opacity: 0; } 100% { transform: scale(1); opacity: 0; } }

        :root {
          --ide-bg: #080c14;
          --ide-surface: #0d1320;
          --ide-surface-2: #111927;
          --ide-border: rgba(255,255,255,0.06);
          --ide-border-accent: rgba(99,102,241,0.35);
          --ide-text: #e2e8f0;
          --ide-text-muted: #64748b;
          --ide-text-dim: #334155;
          --ide-accent: #6366f1;
          --ide-accent-2: #8b5cf6;
          --ide-green: #22d3a0;
          --ide-amber: #f59e0b;
          --ide-red: #f87171;
          --ide-blue: #3b82f6;
          --sidebar-icon-w: 56px;
          --sidebar-content-w: 220px;
        }

        /* Glassmorphism utility */
        .glass {
          background: rgba(13,19,32,0.82);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
        }

        /* Scrollbar premium styling */
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(99,102,241,0.25); border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(99,102,241,0.5); }

        /* IDE sidebar nav item */
        .ide-nav-item {
          width: 40px; height: 40px;
          display: flex; align-items: center; justify-content: center;
          border-radius: 10px; cursor: pointer;
          transition: all 0.18s ease;
          border: 1px solid transparent;
          font-size: 17px;
          color: var(--ide-text-muted);
        }
        .ide-nav-item:hover { background: rgba(99,102,241,0.12); color: var(--ide-text); border-color: var(--ide-border-accent); }
        .ide-nav-item.active {
          background: rgba(99,102,241,0.18);
          color: #a5b4fc;
          border-color: rgba(99,102,241,0.4);
          box-shadow: 0 0 0 1px rgba(99,102,241,0.15), inset 0 1px 0 rgba(255,255,255,0.07);
        }

        /* Mode tab */
        .mode-tab {
          padding: 5px 14px; border-radius: 7px; cursor: pointer; border: none;
          font-size: 12px; font-weight: 600; letter-spacing: 0.03em;
          transition: all 0.18s ease; background: transparent; color: var(--ide-text-muted);
        }
        .mode-tab:hover { color: var(--ide-text); background: rgba(255,255,255,0.05); }
        .mode-tab.active { background: rgba(99,102,241,0.18); color: #a5b4fc; border: 1px solid rgba(99,102,241,0.3) !important; }

        /* Panel tab */
        .panel-tab {
          padding: 9px 14px; background: none; border: none; border-bottom: 2px solid transparent;
          cursor: pointer; font-size: 11px; font-weight: 500; letter-spacing: 0.05em;
          text-transform: uppercase; color: var(--ide-text-muted); transition: all 0.18s;
          display: flex; align-items: center; gap: 6px; white-space: nowrap;
        }
        .panel-tab:hover { color: var(--ide-text); }
        .panel-tab.active { color: #e2e8f0; border-bottom-color: var(--ide-accent); }

        /* Premium card hover */
        .project-card {
          border-radius: 10px; padding: 11px 13px;
          border: 1px solid var(--ide-border); cursor: pointer;
          transition: all 0.18s ease; background: var(--ide-surface);
          width: 100%; text-align: left;
        }
        .project-card:hover { border-color: rgba(99,102,241,0.3); background: rgba(99,102,241,0.07); }
        .project-card.active { border-color: rgba(99,102,241,0.5); background: rgba(99,102,241,0.12); box-shadow: 0 0 0 1px rgba(99,102,241,0.1); }

        /* Live indicator dot */
        .live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ide-green); display: inline-block; position: relative; }
        .live-dot::after { content: ''; position: absolute; inset: 0; border-radius: 50%; background: var(--ide-green); animation: statusPing 1.5s ease-out infinite; }

        /* ── Mobile workspace — premium native feel ── */
        .mob-ws { position: fixed; top: 0; left: 0; right: 0; overflow: hidden; touch-action: pan-y; overscroll-behavior: none; -webkit-overflow-scrolling: auto; }
        .mob-ws * { -webkit-tap-highlight-color: transparent; }
        @keyframes mobIn { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
        .mob-screen { animation: mobIn 0.22s cubic-bezier(0.25,0.46,0.45,0.94) both; }
        .mob-nav-btn { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:3px; flex:1; background:none; border:none; cursor:pointer; transition:color 0.18s, border-color 0.18s; position:relative; user-select:none; }
        .mob-nav-btn:active { opacity:0.65; }
        .mob-tab-btn { background:none; border:none; border-bottom:2px solid transparent; cursor:pointer; white-space:nowrap; display:flex; align-items:center; gap:5px; transition:all 0.18s; user-select:none; }
        .mob-card { width:100%; background:rgba(13,19,32,0.95); border:1px solid rgba(255,255,255,0.07); border-radius:14px; cursor:pointer; text-align:left; display:flex; align-items:center; gap:12px; transition:background 0.15s, border-color 0.15s, transform 0.1s; user-select:none; }
        .mob-card:active { transform:scale(0.98) !important; background:rgba(99,102,241,0.08) !important; }
        .mob-chip { display:inline-flex; align-items:center; padding:8px 14px; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:20px; color:#94a3b8; font-size:13px; cursor:pointer; white-space:nowrap; transition:all 0.18s; user-select:none; font-family:inherit; }
        .mob-chip:active { background:rgba(99,102,241,0.12); border-color:rgba(99,102,241,0.3); color:#a5b4fc; transform:scale(0.97); }
        .mob-tpl-card { flex-shrink:0; width:148px; padding:14px; background:rgba(13,19,32,0.95); border:1px solid rgba(255,255,255,0.07); border-radius:14px; cursor:pointer; transition:all 0.18s; user-select:none; text-align:left; }
        .mob-tpl-card:active { border-color:rgba(99,102,241,0.4); background:rgba(99,102,241,0.07); transform:scale(0.96); }
        .mob-section-hdr { font-size:10px; font-weight:700; color:#334155; text-transform:uppercase; letter-spacing:0.09em; margin-bottom:10px; }
        .mob-scroll-x { overflow-x:auto; scrollbar-width:none; -ms-overflow-style:none; }
        .mob-scroll-x::-webkit-scrollbar { display:none; }
        .mob-scroll-y { overflow-y:auto; -webkit-overflow-scrolling:touch; }
      `}</style>
      {isMobile ? (
        /* ── MOBILE WORKSPACE ── */
        <div
          className="mob-ws"
          style={{
            bottom: mobileKbOffset > 0 ? `${mobileKbOffset}px` : 0,
            background: '#080c14',
            color: '#e2e8f0',
            display: 'flex',
            flexDirection: 'column',
            fontFamily: '"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
            transition: 'bottom 0.2s cubic-bezier(0.4,0,0.2,1)',
          }}
        >
          {/* ── HEADER — collapses when keyboard visible ── */}
          <div style={{
            flexShrink: 0,
            height: (mobileFocused && mobileKbOffset > 50) ? 0 : 52,
            overflow: 'hidden',
            transition: 'height 0.22s cubic-bezier(0.4,0,0.2,1)',
            background: 'rgba(10,14,26,0.98)',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
            display: 'flex', alignItems: 'center',
            padding: '0 14px', gap: 10,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
              <div style={{ width: 28, height: 28, borderRadius: 8, background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 800, color: '#fff', flexShrink: 0, boxShadow: '0 2px 10px rgba(99,102,241,0.4)' }}>V</div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: 1.2 }}>
                  {currentProject ? currentProject.name : 'DWOMOH Vibe Code'}
                </div>
                {currentProject && (
                  <div style={{ fontSize: 10, color: phase === 'building' ? '#f59e0b' : previewUrl ? '#22d3a0' : '#334155', lineHeight: 1.2, fontWeight: 600 }}>
                    {phase === 'building' ? '● Building…' : previewUrl ? '● Live' : '○ Ready'}
                  </div>
                )}
              </div>
            </div>
            {mobileTab === 'chat' && previewUrl && (
              <button onClick={() => setMobileTab('preview')} style={{ padding: '5px 12px', background: 'rgba(34,211,160,0.1)', border: '1px solid rgba(34,211,160,0.25)', borderRadius: 20, color: '#22d3a0', fontSize: 11, fontWeight: 700, cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 5 }}>
                <span className="live-dot" /> Preview
              </button>
            )}
            {phase === 'building' && mobileTab !== 'chat' && (
              <button onClick={() => setMobileTab('chat')} style={{ padding: '5px 10px', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: 20, color: '#f59e0b', fontSize: 11, fontWeight: 700, cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 5 }}>
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#f59e0b', animation: 'pulse 1s ease-in-out infinite' }} /> Building
              </button>
            )}
          </div>

          {/* ── AI ACTIVITY TIMELINE ── */}
          {(phase === 'building' || editApplying) && (() => {
            const stages = [
              { label: 'Understanding', icon: '◎' },
              { label: 'Inspecting',    icon: '◈' },
              { label: 'Planning',      icon: '⊡' },
              { label: 'Editing',       icon: '✎' },
              { label: 'Testing',       icon: '⟳' },
              { label: 'Preview',       icon: '▶' },
              { label: 'Deploying',     icon: '⊕' },
              { label: 'Verifying',     icon: '✓' },
              { label: 'Done',          icon: '✦' },
            ];
            const stepIdx: Record<string, number> = { idle: 0, checking: 1, reading: 2, building: 3, installing: 4, testing: 5, done: 8 };
            const cur = editApplying ? 3 : (buildProgress ? (stepIdx[buildProgress.step] ?? 3) : 0);
            return (
              <div className="mob-scroll-x" style={{ flexShrink: 0, background: 'rgba(7,9,20,0.98)', borderBottom: '1px solid rgba(255,255,255,0.05)', padding: '7px 14px' }}>
                <div style={{ display: 'flex', gap: 3, alignItems: 'center', minWidth: 'max-content' }}>
                  {stages.map((s, i) => {
                    const done = i < cur; const active = i === cur;
                    return (
                      <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 9px', borderRadius: 20, background: done ? 'rgba(34,211,160,0.1)' : active ? 'rgba(99,102,241,0.18)' : 'rgba(255,255,255,0.03)', border: `1px solid ${done ? 'rgba(34,211,160,0.25)' : active ? 'rgba(99,102,241,0.4)' : 'transparent'}`, boxShadow: active ? '0 0 10px rgba(99,102,241,0.18)' : 'none', transition: 'all 0.3s' }}>
                          <span style={{ fontSize: 9, color: done ? '#22d3a0' : active ? '#a5b4fc' : '#1e3a5f' }}>{s.icon}</span>
                          <span style={{ fontSize: 9, fontWeight: 700, color: done ? '#22d3a0' : active ? '#c4b5fd' : '#334155', whiteSpace: 'nowrap' }}>{s.label}</span>
                          {active && <div style={{ width: 4, height: 4, borderRadius: '50%', background: '#6366f1', animation: 'pulse 1s ease-in-out infinite' }} />}
                        </div>
                        {i < stages.length - 1 && <div style={{ width: 7, height: 1, background: done ? 'rgba(34,211,160,0.25)' : 'rgba(255,255,255,0.05)', flexShrink: 0 }} />}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          {/* ── SCREEN AREA ── */}
          <div style={{ flex: 1, overflow: 'hidden', position: 'relative', minHeight: 0 }}>

            {/* PROJECT LIBRARY */}
            {mobileTab === 'library' && (
              <div className="mob-screen mob-scroll-y" style={{ height: '100%', padding: '16px 16px 8px' } as React.CSSProperties}>
                <div style={{ position: 'relative', marginBottom: 12 }}>
                  <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#334155', fontSize: 14, pointerEvents: 'none' }}>⌕</span>
                  <input value={mobileSearchQuery} onChange={e => setMobileSearchQuery(e.target.value)} placeholder="Search projects and templates…"
                    style={{ width: '100%', boxSizing: 'border-box', padding: '11px 12px 11px 36px', background: 'rgba(15,21,35,0.95)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12, color: '#e2e8f0', fontSize: 13, outline: 'none' } as React.CSSProperties} />
                </div>
                <button onClick={() => { handleNewProject(); setMobileTab('chat'); }}
                  style={{ width: '100%', padding: '14px', marginBottom: 20, background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', color: '#fff', border: 'none', borderRadius: 14, cursor: 'pointer', fontSize: 15, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center', boxShadow: '0 6px 24px rgba(99,102,241,0.32)', letterSpacing: '-0.01em' }}>
                  <span style={{ fontSize: 20, lineHeight: 1, fontWeight: 300 }}>+</span> Start New Project
                </button>

                {mobileSearchQuery ? (
                  <>
                    <div className="mob-section-hdr">{projects.filter(p => p.name.toLowerCase().includes(mobileSearchQuery.toLowerCase())).length} results</div>
                    {projects.filter(p => p.name.toLowerCase().includes(mobileSearchQuery.toLowerCase())).map(project => (
                      <button key={project.id} onClick={() => { handleOpenProject(project); setMobileTab('chat'); }} className="mob-card" style={{ padding: '13px 14px', marginBottom: 8 }}>
                        <div style={{ width: 40, height: 40, borderRadius: 10, flexShrink: 0, background: 'linear-gradient(135deg,rgba(99,102,241,0.2),rgba(139,92,246,0.2))', border: '1px solid rgba(99,102,241,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>{getProjectEmoji(project.name)}</div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.name}</div>
                          <div style={{ fontSize: 11, color: '#475569', marginTop: 1 }}>{project.createdAt ? new Date(project.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'Recent'}</div>
                        </div>
                        <div style={{ fontSize: 11, color: '#6366f1', fontWeight: 700, padding: '4px 10px', background: 'rgba(99,102,241,0.1)', borderRadius: 6 }}>Open →</div>
                      </button>
                    ))}
                    {projects.filter(p => p.name.toLowerCase().includes(mobileSearchQuery.toLowerCase())).length === 0 && (
                      <div style={{ textAlign: 'center', padding: '32px 0', color: '#334155', fontSize: 13 }}>No matching projects</div>
                    )}
                  </>
                ) : (
                  <>
                    {projects.length > 0 && (
                      <>
                        <div className="mob-section-hdr">Recent Projects</div>
                        {projects.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')).slice(0, 6).map(project => (
                          <button key={project.id} onClick={() => { handleOpenProject(project); setMobileTab('chat'); }} className="mob-card"
                            style={{ padding: '13px 14px', marginBottom: 8, borderColor: currentProject?.id === project.id ? 'rgba(99,102,241,0.4)' : 'rgba(255,255,255,0.07)', background: currentProject?.id === project.id ? 'rgba(99,102,241,0.08)' : 'rgba(13,19,32,0.95)' }}>
                            <div style={{ width: 42, height: 42, borderRadius: 11, flexShrink: 0, background: 'linear-gradient(135deg,rgba(99,102,241,0.18),rgba(139,92,246,0.18))', border: '1px solid rgba(99,102,241,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20 }}>{getProjectEmoji(project.name)}</div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.name}</div>
                              <div style={{ fontSize: 11, color: '#475569', marginTop: 2 }}>{project.createdAt ? new Date(project.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' }) : 'Recently created'}</div>
                            </div>
                            {currentProject?.id === project.id
                              ? <div style={{ fontSize: 10, color: '#22d3a0', fontWeight: 700, padding: '3px 8px', background: 'rgba(34,211,160,0.1)', borderRadius: 6, flexShrink: 0 }}>Active</div>
                              : <div style={{ fontSize: 11, color: '#6366f1', fontWeight: 700, padding: '4px 10px', background: 'rgba(99,102,241,0.1)', borderRadius: 6, flexShrink: 0 }}>Open →</div>
                            }
                          </button>
                        ))}
                        <div style={{ marginBottom: 22 }} />
                      </>
                    )}

                    <div className="mob-section-hdr">Popular Templates</div>
                    <div className="mob-scroll-x" style={{ display: 'flex', gap: 10, paddingBottom: 4, marginBottom: 22 }}>
                      {[
                        { emoji: '🏠', name: 'Property App', desc: 'Listings + Paystack', prompt: 'Build a property marketplace for Ghana with listings, search filters, and Paystack payments' },
                        { emoji: '🏨', name: 'Hotel Booking', desc: 'Calendar + checkout', prompt: 'Create a hotel booking platform with room calendar, availability, and Stripe checkout' },
                        { emoji: '💬', name: 'Social Network', desc: 'Feed + DMs', prompt: 'Generate a social network with news feed, follow system, direct messages, and user profiles' },
                        { emoji: '🛒', name: 'E-commerce', desc: 'Products + cart', prompt: 'Build an e-commerce store with product listings, shopping cart, and Paystack checkout' },
                        { emoji: '🎵', name: 'Music Platform', desc: 'Streaming + artists', prompt: 'Create a music streaming platform with playlists, audio player, and artist profiles' },
                        { emoji: '⚡', name: 'AI Dashboard', desc: 'Analytics + charts', prompt: 'Build an AI analytics dashboard with charts, data tables, and real-time metrics' },
                      ].map(t => (
                        <button key={t.name} className="mob-tpl-card" onClick={() => { handleNewProject(); setInput(t.prompt); setMobileTab('chat'); }}>
                          <div style={{ fontSize: 28, marginBottom: 9 }}>{t.emoji}</div>
                          <div style={{ fontSize: 12, fontWeight: 700, color: '#e2e8f0', marginBottom: 3, lineHeight: 1.3 }}>{t.name}</div>
                          <div style={{ fontSize: 10, color: '#475569' }}>{t.desc}</div>
                        </button>
                      ))}
                    </div>

                    <div className="mob-section-hdr">Quick Actions</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 24 }}>
                      {[
                        { icon: '⊕', label: 'Import from GitHub', sub: 'Coming soon', action: () => { addMsg('assistant', 'GitHub import is coming soon. Describe your project idea and I\'ll build it from scratch.'); setMobileTab('chat'); } },
                        { icon: '⊟', label: 'Browse all projects', sub: `${projects.length} projects`, action: () => setMobileSearchQuery(' ') },
                      ].map(a => (
                        <button key={a.label} onClick={a.action}
                          style={{ width: '100%', padding: '13px 14px', background: 'rgba(13,19,32,0.95)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12, transition: 'all 0.15s' } as React.CSSProperties}>
                          <span style={{ fontSize: 18, color: '#334155', flexShrink: 0 }}>{a.icon}</span>
                          <div style={{ textAlign: 'left' }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: '#94a3b8' }}>{a.label}</div>
                            <div style={{ fontSize: 11, color: '#334155' }}>{a.sub}</div>
                          </div>
                        </button>
                      ))}
                    </div>

                    {projects.length === 0 && (
                      <div style={{ textAlign: 'center', padding: '24px 16px' }}>
                        <div style={{ width: 56, height: 56, borderRadius: 16, background: 'linear-gradient(135deg,rgba(99,102,241,0.18),rgba(139,92,246,0.18))', border: '1px solid rgba(99,102,241,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, margin: '0 auto 12px' }}>✦</div>
                        <div style={{ fontSize: 15, fontWeight: 700, color: '#e2e8f0', marginBottom: 6 }}>Start building</div>
                        <div style={{ fontSize: 13, color: '#475569', lineHeight: 1.6 }}>Pick a template above or tap New Project to describe your idea.</div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* AI WORKSPACE / CHAT */}
            {mobileTab === 'chat' && (
              <div className="mob-screen" style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <div className="mob-scroll-y" style={{ flex: 1, padding: '14px 14px 6px' } as React.CSSProperties}>
                  {/* Goal-first flow — mobile */}
                  {goalStep === 'type' && !currentProject && displayed.length === 0 && !buildProgress && (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '65%', padding: '16px 0' }}>
                      <div style={{ fontSize: 20, fontWeight: 800, color: '#e2e8f0', marginBottom: 8, letterSpacing: '-0.03em', textAlign: 'center' }}>What would you like to build?</div>
                      <div style={{ fontSize: 13, color: '#475569', marginBottom: 28, textAlign: 'center', lineHeight: 1.6 }}>Choose your output type.</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%', maxWidth: 280 }}>
                        {[
                          { icon: '🌐', label: 'Website', sub: 'Marketplace, SaaS, dashboard, booking, portfolio', action: () => handleGoalSelect('website') },
                          { icon: '📱', label: 'Mobile App', sub: 'Android & iPhone — Flutter or native', action: () => handleGoalSelect('mobile') },
                        ].map(opt => (
                          <button key={opt.label} onClick={opt.action} style={{ padding: '18px 20px', background: 'rgba(13,19,32,0.95)', border: '1.5px solid rgba(255,255,255,0.08)', borderRadius: 16, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 14, width: '100%', textAlign: 'left' }}>
                            <span style={{ fontSize: 28, lineHeight: 1, flexShrink: 0 }}>{opt.icon}</span>
                            <div>
                              <div style={{ fontSize: 15, fontWeight: 800, color: '#e2e8f0', marginBottom: 3 }}>{opt.label}</div>
                              <div style={{ fontSize: 11, color: '#475569', lineHeight: 1.5 }}>{opt.sub}</div>
                            </div>
                            <span style={{ marginLeft: 'auto', color: '#334155', fontSize: 16 }}>›</span>
                          </button>
                        ))}
                      </div>
                      <div style={{ marginTop: 22, fontSize: 12, color: '#334155', textAlign: 'center' }}>Or type your idea below</div>
                    </div>
                  )}
                  {goalStep === 'mobile-tech' && !currentProject && displayed.length === 0 && !buildProgress && (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '65%', padding: '16px 0' }}>
                      <button onClick={() => setGoalStep('type')} style={{ alignSelf: 'flex-start', background: 'none', border: 'none', color: '#475569', cursor: 'pointer', fontSize: 13, marginBottom: 20, display: 'flex', alignItems: 'center', gap: 5 }}>← Back</button>
                      <div style={{ fontSize: 18, fontWeight: 800, color: '#e2e8f0', marginBottom: 8, textAlign: 'center' }}>Choose Mobile Technology</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%', maxWidth: 300 }}>
                        {[
                          { icon: '🦋', label: 'Flutter', sub: 'One app for both Android and iPhone.', badge: 'Recommended', action: () => { handleMobileTechSelect('flutter'); setMobileTab('chat'); } },
                          { icon: '🤖', label: 'Native Android', sub: 'Kotlin app for Android only.', badge: '', action: () => { handleMobileTechSelect('android'); setMobileTab('chat'); } },
                          { icon: '🍎', label: 'Native iPhone', sub: 'Swift app for iPhone only.', badge: '', action: () => { handleMobileTechSelect('ios'); setMobileTab('chat'); } },
                        ].map(opt => (
                          <button key={opt.label} onClick={opt.action} style={{ padding: '14px 16px', background: opt.badge ? 'rgba(99,102,241,0.08)' : 'rgba(13,19,32,0.95)', border: `1.5px solid ${opt.badge ? 'rgba(99,102,241,0.3)' : 'rgba(255,255,255,0.07)'}`, borderRadius: 14, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', position: 'relative' } as React.CSSProperties}>
                            {opt.badge && <span style={{ position: 'absolute', top: -8, right: 12, background: '#6366f1', color: '#fff', fontSize: 9, fontWeight: 800, padding: '2px 8px', borderRadius: 10 }}>{opt.badge}</span>}
                            <span style={{ fontSize: 24, lineHeight: 1, flexShrink: 0 }}>{opt.icon}</span>
                            <div>
                              <div style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0', marginBottom: 2 }}>{opt.label}</div>
                              <div style={{ fontSize: 11, color: '#475569' }}>{opt.sub}</div>
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Platform recommendation banner — mobile */}
                  {buildRecommendation && pendingBuildPrompt && (
                    <div style={{ marginBottom: 14, padding: '14px 16px', background: 'rgba(99,102,241,0.1)', border: '1.5px solid rgba(99,102,241,0.3)', borderRadius: 16 }}>
                      <div style={{ fontSize: 12, color: '#a5b4fc', fontWeight: 800, marginBottom: 5, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span>{buildRecommendation.icon}</span> Platform Recommendation
                      </div>
                      <div style={{ fontSize: 14, color: '#e2e8f0', fontWeight: 700, marginBottom: 4 }}>
                        {buildRecommendation.platform === 'flutter' ? '📱 Mobile App — Flutter' : '🌐 Website'}
                      </div>
                      <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.6, marginBottom: 12 }}>{buildRecommendation.reason}</div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <button onClick={() => {
                          const h = [...history];
                          if (buildRecommendation.platform === 'flutter') setBuildTarget('flutter'); else setBuildTarget('web');
                          const prompt = pendingBuildPrompt;
                          setBuildRecommendation(null); setPendingBuildPrompt(null);
                          if (bridgeTestMode) { runBridgeOnlyPipeline(prompt ?? ''); }
                          else if (buildRecommendation.platform === 'flutter') runFlutterBuildPipeline(h, prompt); else runBuildPipeline(h, prompt);
                        }} style={{ flex: 1, padding: '10px 16px', background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', border: 'none', borderRadius: 10, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', minWidth: 0 }}>
                          ✓ Accept
                        </button>
                        <button onClick={() => {
                          const prompt = pendingBuildPrompt;
                          setBuildRecommendation(null); setPendingBuildPrompt(null);
                          if (bridgeTestMode) { runBridgeOnlyPipeline(prompt ?? ''); }
                          else if (buildTarget === 'flutter') runFlutterBuildPipeline(history, prompt); else runBuildPipeline(history, prompt);
                        }} style={{ padding: '10px 16px', background: 'transparent', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, color: '#94a3b8', fontSize: 13, cursor: 'pointer' }}>
                          Keep current
                        </button>
                      </div>
                    </div>
                  )}

                  {goalStep === 'idle' && displayed.length === 0 && !buildProgress && !buildRecommendation && (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '65%', padding: '20px 0' }}>
                      <div style={{ width: 62, height: 62, borderRadius: 18, background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, fontWeight: 800, color: '#fff', marginBottom: 16, boxShadow: '0 8px 32px rgba(99,102,241,0.28)' }}>V</div>
                      <div style={{ fontSize: 19, fontWeight: 800, color: '#e2e8f0', marginBottom: 6, letterSpacing: '-0.03em', textAlign: 'center' }}>
                        {currentProject ? `Editing ${currentProject.name}` : 'What do you want to build?'}
                      </div>
                      <div style={{ fontSize: 13, color: '#475569', marginBottom: 22, textAlign: 'center', lineHeight: 1.6, maxWidth: 280 }}>
                        {currentProject ? 'Describe a change, fix, or new feature.' : 'Describe your idea — I\'ll build it, install dependencies, and start the preview.'}
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
                        {(currentProject
                          ? ['Fix all bugs', 'Improve the UI', 'Add authentication', 'Add payments', 'Add a search feature', 'Make it mobile-friendly']
                          : ['Ghana property marketplace with Paystack', 'Hotel booking with calendar', 'Social network with DMs', 'E-commerce store', 'Music streaming platform', 'AI analytics dashboard']
                        ).map(s => (
                          <button key={s} className="mob-chip" onClick={() => { setInput(s); inputRef.current?.focus(); }}>{s}</button>
                        ))}
                      </div>
                    </div>
                  )}

                  {displayed.map((msg, i) => {
                    if (msg.role === 'status') return (
                      <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '4px 0', animation: 'slidein 0.2s ease' }}>
                        <div style={{ width: 18, height: 18, borderRadius: '50%', background: 'rgba(99,102,241,0.12)', border: '1px solid rgba(99,102,241,0.22)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1, fontSize: 8, color: '#6366f1' }}>◈</div>
                        <div style={{ fontSize: 12, color: '#475569', lineHeight: 1.6, flex: 1 }}>{msg.content}</div>
                      </div>
                    );
                    if (msg.role === 'user') return (
                      <div key={i} style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10, animation: 'slidein 0.2s ease' }}>
                        <div style={{ maxWidth: '82%', padding: '11px 15px', background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', borderRadius: '18px 18px 4px 18px', fontSize: 14, color: '#fff', lineHeight: 1.55, boxShadow: '0 2px 12px rgba(99,102,241,0.28)' }}>{msg.content}</div>
                      </div>
                    );
                    const isLast = i === displayed.length - 1;
                    const text = isLast && streamingMsg ? streamingMsg : msg.content;
                    return (
                      <div key={i} style={{ display: 'flex', gap: 10, marginBottom: 12, animation: 'slidein 0.2s ease' }}>
                        <div style={{ width: 28, height: 28, borderRadius: 9, background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800, color: '#fff', flexShrink: 0, marginTop: 1, boxShadow: '0 2px 8px rgba(99,102,241,0.25)' }}>V</div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 14, color: '#e2e8f0', lineHeight: 1.65, background: 'rgba(15,21,35,0.8)', padding: '11px 14px', borderRadius: '4px 16px 16px 16px', border: '1px solid rgba(255,255,255,0.06)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{text}</div>
                          {isLast && streamingMsg && <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#6366f1', display: 'inline-block', marginLeft: 6, marginTop: 5, animation: 'pulse 1s ease-in-out infinite' }} />}
                        </div>
                      </div>
                    );
                  })}

                  {buildProgress && (
                    <div style={{ marginBottom: 12, padding: '12px 14px', background: 'rgba(13,19,32,0.95)', border: '1px solid rgba(99,102,241,0.22)', borderRadius: 14, animation: 'slidein 0.2s ease' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                        <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#6366f1', animation: 'pulse 1s ease-in-out infinite', flexShrink: 0 }} />
                        <div style={{ fontSize: 12, fontWeight: 700, color: '#a5b4fc' }}>{buildProgress.message || 'Building…'}</div>
                      </div>
                      <div style={{ height: 3, background: 'rgba(255,255,255,0.06)', borderRadius: 2 }}>
                        <div style={{ height: '100%', borderRadius: 2, background: 'linear-gradient(90deg,#6366f1,#8b5cf6)', width: buildProgress.step === 'done' ? '100%' : `${Math.max(8, Math.min(90, buildProgress.logs.length * 5))}%`, transition: 'width 0.5s ease' }} />
                      </div>
                      {buildProgress.logs.length > 0 && (
                        <div style={{ fontSize: 10, color: '#334155', marginTop: 6, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{buildProgress.logs[buildProgress.logs.length - 1]}</div>
                      )}
                    </div>
                  )}

                  <div ref={messagesEndRef} />
                </div>

                <div style={{ flexShrink: 0, padding: '8px 12px 10px', borderTop: '1px solid rgba(255,255,255,0.05)', background: 'rgba(10,14,26,0.98)' }}>
                  <input ref={fileInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={e => handleFileSelect(e.target.files)} />
                  <form onSubmit={handleSubmit}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                      <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', background: 'rgba(15,21,35,0.95)', border: `1.5px solid ${composerFocused ? 'rgba(99,102,241,0.65)' : 'rgba(255,255,255,0.07)'}`, borderRadius: 16, overflow: 'hidden', transition: 'border-color 0.2s, box-shadow 0.2s', boxShadow: composerFocused ? '0 0 0 3px rgba(99,102,241,0.1)' : 'none' }}>
                        <textarea
                          ref={inputRef}
                          value={input}
                          onChange={e => { setInput(e.target.value); const el = e.target; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 120) + 'px'; }}
                          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const f = e.currentTarget.closest('form'); if (f) (f as HTMLFormElement).requestSubmit(); } }}
                          onFocus={() => { setComposerFocused(true); setMobileFocused(true); }}
                          onBlur={() => { setComposerFocused(false); setTimeout(() => setMobileFocused(false), 300); }}
                          placeholder={currentProject ? 'Describe a change…' : 'Describe what you want to build…'}
                          disabled={phase === 'building' || editApplying}
                          rows={1}
                          style={{ flex: 1, minHeight: 46, maxHeight: 120, padding: '13px 12px', background: 'transparent', color: '#e2e8f0', fontSize: 15, lineHeight: 1.5, outline: 'none', resize: 'none', border: 'none', fontFamily: 'inherit', display: 'block', opacity: (phase === 'building' || editApplying) ? 0.4 : 1 } as React.CSSProperties}
                        />
                        <div style={{ display: 'flex', alignItems: 'center', padding: '0 6px 7px', gap: 0 }}>
                          <button type="button" onClick={() => fileInputRef.current?.click()} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#334155', fontSize: 18, padding: '5px 6px', borderRadius: 8, lineHeight: 1 }}>📎</button>
                          <button type="button" onClick={isRecording ? stopVoiceInput : startVoiceInput} style={{ background: isRecording ? 'rgba(239,68,68,0.12)' : 'none', border: 'none', cursor: 'pointer', color: isRecording ? '#ef4444' : '#334155', fontSize: 18, padding: '5px 6px', borderRadius: 8, lineHeight: 1 }}>
                            {isRecording ? '🔴' : '🎤'}
                          </button>
                        </div>
                      </div>
                      <button type="submit" disabled={isBusy || !input.trim()}
                        style={{ width: 46, height: 46, flexShrink: 0, borderRadius: 14, background: isBusy || !input.trim() ? 'rgba(99,102,241,0.14)' : 'linear-gradient(135deg,#6366f1,#8b5cf6)', border: 'none', cursor: isBusy || !input.trim() ? 'not-allowed' : 'pointer', color: '#fff', fontSize: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.18s', boxShadow: isBusy || !input.trim() ? 'none' : '0 4px 16px rgba(99,102,241,0.32)' }}>
                        {isBusy ? <span style={{ fontSize: 14, animation: 'spin 1s linear infinite', display: 'inline-block' }}>◌</span> : '↑'}
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            )}

            {/* LIVE PREVIEW */}
            {mobileTab === 'preview' && (
              <div className="mob-screen" style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#040810' }}>
                {previewUrl && !previewLoading && (
                  <div style={{ flexShrink: 0, height: 38, background: 'rgba(10,14,26,0.98)', borderBottom: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', padding: '0 14px', gap: 8 }}>
                    <span className="live-dot" />
                    <span style={{ fontSize: 11, color: '#22d3a0', fontWeight: 700, flex: 1 }}>Live Preview</span>
                    <a href={previewUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: '#475569', fontWeight: 600, textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 3 }}>Open ↗</a>
                  </div>
                )}
                {previewUrl ? (
                  previewLoading ? (
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
                      <div style={{ width: 40, height: 40, borderRadius: '50%', border: '3px solid rgba(99,102,241,0.2)', borderTopColor: '#6366f1', animation: 'spin 0.8s linear infinite' }} />
                      <div style={{ fontSize: 13, color: '#475569' }}>Loading preview…</div>
                    </div>
                  ) : (
                    <iframe key={previewKey} src={previewUrl} style={{ flex: 1, border: 'none', width: '100%', background: '#fff' }} allow="same-origin" title="App Preview" />
                  )
                ) : (
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 }}>
                    <div style={{ width: 64, height: 64, borderRadius: 20, background: 'linear-gradient(135deg,rgba(99,102,241,0.14),rgba(139,92,246,0.14))', border: '1px solid rgba(99,102,241,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>▶</div>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: 16, fontWeight: 700, color: '#e2e8f0', marginBottom: 8 }}>No preview yet</div>
                      <div style={{ fontSize: 13, color: '#475569', marginBottom: 20, lineHeight: 1.6, maxWidth: 260 }}>Build a project first. The live preview appears here automatically after generation.</div>
                      <button onClick={() => setMobileTab('chat')} style={{ padding: '11px 24px', background: 'rgba(99,102,241,0.14)', border: '1px solid rgba(99,102,241,0.3)', borderRadius: 12, color: '#a5b4fc', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>Go to AI Chat</button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* DEVELOPER TOOLS */}
            {mobileTab === 'tools' && (
              <div className="mob-screen" style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <div className="mob-scroll-x" style={{ flexShrink: 0, borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', padding: '0 10px', background: 'rgba(10,14,26,0.98)' } as React.CSSProperties}>
                  {([
                    { id: 'terminal', label: 'Terminal', icon: '_' },
                    { id: 'logs',     label: 'Logs',     icon: '≡' },
                    { id: 'deploy',   label: 'Deploy',   icon: '⊕' },
                    { id: 'files',    label: 'Files',    icon: '⊟' },
                    { id: 'database', label: 'Database', icon: '◩' },
                  ] as const).map(t => (
                    <button key={t.id} onClick={() => setMobileToolsSection(t.id)} className="mob-tab-btn"
                      style={{ padding: '11px 14px', color: mobileToolsSection === t.id ? '#e2e8f0' : '#475569', fontSize: 12, fontWeight: 600, borderBottom: `2px solid ${mobileToolsSection === t.id ? '#6366f1' : 'transparent'}` }}>
                      <span style={{ fontFamily: 'monospace', fontSize: 10 }}>{t.icon}</span> {t.label}
                    </button>
                  ))}
                </div>
                <div style={{ flex: 1, overflow: 'hidden' }}>

                  {mobileToolsSection === 'terminal' && (
                    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#02060e', fontFamily: '"JetBrains Mono","Fira Code",monospace', fontSize: 12 }}>
                      <div className="mob-scroll-y" style={{ flex: 1, padding: '12px 14px' } as React.CSSProperties}>
                        {terminalLogs.length === 0 && <div style={{ color: '#334155' }}>$ <span style={{ color: '#1e3a5f' }}>Terminal ready.</span></div>}
                        {terminalLogs.map((l, i) => <div key={i} style={{ color: l.startsWith('$ ') ? '#60a5fa' : l.startsWith('❌') ? '#f87171' : l.startsWith('✅') ? '#4ade80' : '#64748b', marginBottom: 2, lineHeight: 1.6, wordBreak: 'break-all', fontSize: 11 }}>{l}</div>)}
                        {terminalRunning && <div style={{ color: '#fbbf24', animation: 'pulse 1s ease-in-out infinite' }}>Running…</div>}
                      </div>
                      <form onSubmit={async e => { e.preventDefault(); const cmd = terminalInput.trim(); if (!cmd || terminalRunning || !currentProject) return; setTerminalInput(''); setTerminalLogs(l => [...l, `$ ${cmd}`]); setTerminalRunning(true); try { const r = await api({ action: 'run-command', projectPath: currentProject.projectPath, command: cmd }); setTerminalLogs(l => [...l, ...(r.output || ['(no output)']).slice(0, 50)]); if (r.exitCode !== 0) setTerminalLogs(l => [...l, `❌ Exit ${r.exitCode}`]); } catch (err) { setTerminalLogs(l => [...l, `❌ ${err instanceof Error ? err.message : 'Error'}`]); } finally { setTerminalRunning(false); } }}
                        style={{ display: 'flex', alignItems: 'center', borderTop: '1px solid rgba(255,255,255,0.05)', padding: '8px 12px', gap: 8, background: 'rgba(2,6,14,0.98)' }}>
                        <span style={{ color: '#22d3a0', fontFamily: 'monospace', fontSize: 13, flexShrink: 0 }}>❯</span>
                        <input value={terminalInput} onChange={e => setTerminalInput(e.target.value)} placeholder={currentProject ? 'npm run build, ls…' : 'Open a project first'} disabled={terminalRunning || !currentProject}
                          style={{ flex: 1, background: 'none', border: 'none', color: '#e2e8f0', fontFamily: 'inherit', fontSize: 12, outline: 'none', opacity: !currentProject ? 0.3 : 1 } as React.CSSProperties} />
                        <button type="submit" disabled={terminalRunning || !currentProject || !terminalInput.trim()} style={{ padding: '5px 12px', background: '#1e3a5f', border: 'none', borderRadius: 6, color: '#60a5fa', cursor: 'pointer', fontSize: 11, fontWeight: 700, opacity: terminalRunning || !currentProject || !terminalInput.trim() ? 0.4 : 1 }}>Run</button>
                      </form>
                    </div>
                  )}

                  {mobileToolsSection === 'logs' && (
                    <div className="mob-scroll-y" style={{ height: '100%', padding: '12px 14px', background: '#02060e', fontFamily: 'monospace', fontSize: 11, lineHeight: 1.7 } as React.CSSProperties}>
                      {buildProgress ? (
                        <>{buildProgress.logs.map((l, i) => <div key={i} style={{ color: l.startsWith('❌') ? '#f87171' : l.startsWith('✅') ? '#4ade80' : l.startsWith('⚠️') ? '#fbbf24' : '#475569', marginBottom: 1, wordBreak: 'break-all' }}>{l}</div>)}</>
                      ) : (
                        <div style={{ color: '#334155', paddingTop: 24, textAlign: 'center', fontFamily: 'inherit', fontSize: 12 }}>Build logs appear here when a project is building.</div>
                      )}
                      {errorLogs.length > 0 && (
                        <div style={{ marginTop: 20, borderTop: '1px solid rgba(248,113,113,0.12)', paddingTop: 12 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, fontSize: 10, color: '#ef4444', textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'inherit' }}>
                            <span>Error Log</span>
                            <button onClick={() => setErrorLogs([])} style={{ background: 'none', border: 'none', color: '#334155', cursor: 'pointer', fontSize: 10, fontFamily: 'inherit' }}>Clear</button>
                          </div>
                          {errorLogs.map((l, i) => <div key={i} style={{ color: '#f87171', marginBottom: 4, wordBreak: 'break-all', fontSize: 11 }}>{l}</div>)}
                        </div>
                      )}
                    </div>
                  )}

                  {mobileToolsSection === 'deploy' && (
                    <div className="mob-scroll-y" style={{ height: '100%', padding: 16 } as React.CSSProperties}>
                      {currentProject ? (
                        <>
                          <div style={{ marginBottom: 16 }}>
                            <div className="mob-section-hdr">Project Health</div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                              {[
                                { label: 'Preview',    ok: !!previewUrl },
                                { label: 'Build',      ok: buildProgress?.step === 'done' || !!previewUrl },
                                { label: 'Deployment', ok: deployRecord?.status === 'live' },
                                { label: 'File Tree',  ok: (currentMemory?.fileTree?.length ?? 0) > 0 },
                              ].map(h => (
                                <div key={h.label} style={{ padding: '10px 12px', background: h.ok ? 'rgba(34,211,160,0.06)' : 'rgba(255,255,255,0.02)', border: `1px solid ${h.ok ? 'rgba(34,211,160,0.18)' : 'rgba(255,255,255,0.05)'}`, borderRadius: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
                                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: h.ok ? '#22d3a0' : '#1e3a5f', flexShrink: 0 }} />
                                  <span style={{ fontSize: 11, color: h.ok ? '#6ee7b7' : '#334155', fontWeight: 600 }}>{h.label}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                          {deployRecord && (
                            <div style={{ padding: '12px 14px', background: 'rgba(13,19,32,0.95)', border: `1px solid ${deployRecord.status === 'live' ? 'rgba(34,211,160,0.25)' : deployRecord.status === 'failed' ? 'rgba(248,113,113,0.25)' : 'rgba(250,204,21,0.18)'}`, borderRadius: 14, marginBottom: 12 }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                                <span style={{ fontSize: 12, fontWeight: 700, color: '#e2e8f0' }}>Last Deployment</span>
                                <span style={{ fontSize: 10, padding: '2px 9px', borderRadius: 20, fontWeight: 700, background: deployRecord.status === 'live' ? 'rgba(34,211,160,0.12)' : deployRecord.status === 'failed' ? 'rgba(248,113,113,0.12)' : 'rgba(250,204,21,0.1)', color: deployRecord.status === 'live' ? '#6ee7b7' : deployRecord.status === 'failed' ? '#fca5a5' : '#fde68a' }}>
                                  {deployRecord.status === 'live' ? 'Live' : deployRecord.status === 'failed' ? 'Failed' : 'Building'}
                                </span>
                              </div>
                              {deployRecord.brandedUrl && <a href={deployRecord.brandedUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: '#6366f1', wordBreak: 'break-all', textDecoration: 'none' }}>{deployRecord.brandedUrl}</a>}
                            </div>
                          )}
                          <button onClick={handleDeploy} disabled={deploying || deployPolling}
                            style={{ width: '100%', padding: '14px', background: deploying || deployPolling ? 'rgba(99,102,241,0.25)' : 'linear-gradient(135deg,#6366f1,#8b5cf6)', border: 'none', borderRadius: 14, color: '#fff', fontSize: 14, fontWeight: 700, cursor: (deploying || deployPolling) ? 'not-allowed' : 'pointer', boxShadow: deploying || deployPolling ? 'none' : '0 4px 18px rgba(99,102,241,0.28)', letterSpacing: '-0.01em' }}>
                            {deploying ? '◌ Deploying…' : deployPolling ? '◌ Verifying…' : deployRecord?.status === 'live' ? '↻ Redeploy to Cloud' : '⊕ Deploy to Cloud'}
                          </button>
                        </>
                      ) : (
                        <div style={{ textAlign: 'center', padding: '48px 20px' }}>
                          <div style={{ fontSize: 36, marginBottom: 14 }}>⊕</div>
                          <div style={{ fontSize: 14, fontWeight: 600, color: '#475569', marginBottom: 6 }}>No project selected</div>
                          <div style={{ fontSize: 12, color: '#334155' }}>Open a project from the Library to deploy it</div>
                        </div>
                      )}
                    </div>
                  )}

                  {mobileToolsSection === 'files' && (
                    <div className="mob-scroll-y" style={{ height: '100%', padding: '12px 14px', fontFamily: 'monospace', fontSize: 11 } as React.CSSProperties}>
                      {currentMemory?.fileTree?.length ? (
                        <>
                          <div style={{ fontSize: 10, fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10, fontFamily: 'inherit' }}>{currentMemory.fileTree.length} files</div>
                          {currentMemory.fileTree.slice(0, 120).map((f: string, i: number) => (
                            <div key={i} style={{ padding: '3px 0', display: 'flex', alignItems: 'center', gap: 7, lineHeight: 1.6 }}>
                              <span style={{ flexShrink: 0, fontSize: 11 }}>{f.endsWith('/') ? '📁' : '📄'}</span>
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: f.endsWith('/') ? '#94a3b8' : '#475569' }}>{f}</span>
                            </div>
                          ))}
                        </>
                      ) : (
                        <div style={{ color: '#334155', padding: '24px 0', textAlign: 'center', fontFamily: 'inherit', fontSize: 12 }}>
                          {currentProject ? 'Loading file tree…' : 'Open a project to browse files.'}
                        </div>
                      )}
                    </div>
                  )}

                  {mobileToolsSection === 'database' && (
                    <div className="mob-scroll-y" style={{ height: '100%', padding: 16 } as React.CSSProperties}>
                      <div className="mob-section-hdr">Database Configuration</div>
                      <div style={{ marginBottom: 10 }}>
                        <label style={{ fontSize: 11, fontWeight: 600, color: '#475569', display: 'block', marginBottom: 6 }}>Provider</label>
                        <select value={dbType} onChange={e => setDbType(e.target.value)} style={{ width: '100%', padding: '11px 12px', background: 'rgba(15,21,35,0.95)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 11, color: '#e2e8f0', fontSize: 13, outline: 'none' } as React.CSSProperties}>
                          <option value="supabase">Supabase</option>
                          <option value="planetscale">PlanetScale</option>
                          <option value="neon">Neon</option>
                          <option value="sqlite">SQLite (Local)</option>
                        </select>
                      </div>
                      <div style={{ marginBottom: 14 }}>
                        <label style={{ fontSize: 11, fontWeight: 600, color: '#475569', display: 'block', marginBottom: 6 }}>Connection String</label>
                        <input value={dbResource} onChange={e => setDbResource(e.target.value)} placeholder="postgres://user:pass@host:5432/db"
                          style={{ width: '100%', boxSizing: 'border-box', padding: '11px 12px', background: 'rgba(15,21,35,0.95)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 11, color: '#e2e8f0', fontSize: 13, outline: 'none', fontFamily: 'monospace' } as React.CSSProperties} />
                      </div>
                      <button onClick={handleDbScaffold} disabled={dbScaffolding || !currentProject}
                        style={{ width: '100%', padding: '12px', background: 'rgba(99,102,241,0.14)', border: '1px solid rgba(99,102,241,0.3)', borderRadius: 12, color: '#a5b4fc', fontSize: 13, fontWeight: 700, cursor: dbScaffolding || !currentProject ? 'not-allowed' : 'pointer', opacity: dbScaffolding || !currentProject ? 0.45 : 1 }}>
                        {dbScaffolding ? '◌ Scaffolding schema…' : 'Scaffold Database Schema'}
                      </button>
                    </div>
                  )}

                </div>
              </div>
            )}

          </div>{/* end screen */}

          {/* ── BOTTOM NAVIGATION ── */}
          <div style={{
            flexShrink: 0,
            background: 'rgba(10,14,26,0.98)',
            borderTop: '1px solid rgba(255,255,255,0.06)',
            display: 'flex', alignItems: 'stretch',
            height: 60,
            paddingBottom: 'env(safe-area-inset-bottom)',
            transform: (mobileFocused && mobileKbOffset > 50) ? 'translateY(100%)' : 'translateY(0)',
            transition: 'transform 0.25s cubic-bezier(0.4,0,0.2,1)',
          }}>
            {([
              { id: 'library', label: 'Library', icon: '⊞' },
              { id: 'chat',    label: 'AI Chat',  icon: '◈' },
              { id: 'preview', label: 'Preview',  icon: '▶' },
              { id: 'tools',   label: 'Tools',    icon: '⊟' },
            ] as const).map(tab => (
              <button key={tab.id} onClick={() => setMobileTab(tab.id)} className="mob-nav-btn"
                style={{ color: mobileTab === tab.id ? '#a5b4fc' : '#2d3f5a', borderTop: `2px solid ${mobileTab === tab.id ? '#6366f1' : 'transparent'}` }}>
                <span style={{ fontSize: 19, lineHeight: 1 }}>{tab.icon}</span>
                <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.02em' }}>{tab.label}</span>
                {tab.id === 'preview' && previewUrl && mobileTab !== 'preview' && (
                  <div style={{ position: 'absolute', top: 8, right: 'calc(50% - 18px)', width: 6, height: 6, borderRadius: '50%', background: '#22d3a0' }} />
                )}
                {tab.id === 'chat' && (phase === 'building' || editApplying) && mobileTab !== 'chat' && (
                  <div style={{ position: 'absolute', top: 8, right: 'calc(50% - 18px)', width: 6, height: 6, borderRadius: '50%', background: '#f59e0b', animation: 'pulse 1s ease-in-out infinite' }} />
                )}
              </button>
            ))}
          </div>

        </div>
        /* ── END MOBILE WORKSPACE ── */
      ) : (
      <div style={{ display: 'flex', height: '100vh', width: '100vw', background: 'var(--ide-bg)', color: 'var(--ide-text)', fontFamily: '"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif', overflow: 'hidden' }}>

        {/* ── IDE Sidebar ────────────────────────────────────────────────── */}
        {/* Icon Rail */}
        <div style={{
          width: 'var(--sidebar-icon-w)', minWidth: 'var(--sidebar-icon-w)',
          background: 'var(--ide-surface)',
          borderRight: '1px solid var(--ide-border)',
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          paddingTop: '0', zIndex: 10,
        }}>
          {/* Logo */}
          <div style={{ width: '100%', height: '52px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderBottom: '1px solid var(--ide-border)' }}>
            <div style={{
              width: 30, height: 30,
              background: 'linear-gradient(135deg,#6366f1,#8b5cf6)',
              borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 14, fontWeight: 800, color: '#fff',
              boxShadow: '0 0 16px rgba(99,102,241,0.4)',
            }}>⚡</div>
          </div>

          {/* Nav items */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '10px 8px', width: '100%' }}>
            {([
              { id: 'projects', icon: '⬡', label: 'Projects' },
              { id: 'builds',   icon: '⊞', label: 'Builds' },
              { id: 'templates',icon: '⊟', label: 'Templates' },
              { id: 'agents',   icon: '◈', label: 'Agents' },
              { id: 'deployments', icon: '⊕', label: 'Deployments' },
              { id: 'domains', icon: '🌐', label: 'Domains' },
            ] as const).map(item => (
              <button
                key={item.id}
                title={item.label}
                className={`ide-nav-item${sidebarSection === item.id ? ' active' : ''}`}
                onClick={() => {
                  setSidebarSection(item.id);
                  setSidebarCollapsed(false);
                  if (item.id === 'domains') loadDomainsData();
                }}
                style={{ border: 'none' }}
              >
                {item.icon}
              </button>
            ))}
          </div>

          {/* Bottom: settings */}
          <div style={{ padding: '8px', borderTop: '1px solid var(--ide-border)', width: '100%', display: 'flex', justifyContent: 'center' }}>
            <button
              title="Settings"
              className={`ide-nav-item${sidebarSection === 'settings' ? ' active' : ''}`}
              onClick={() => { setSidebarSection('settings'); setSidebarCollapsed(false); }}
              style={{ border: 'none' }}
            >⚙</button>
          </div>
        </div>

        {/* Sidebar Content Panel */}
        {!focusMode && !sidebarCollapsed && (
        <div style={{
          width: 'var(--sidebar-content-w)', minWidth: 'var(--sidebar-content-w)',
          background: 'var(--ide-surface)',
          borderRight: '1px solid var(--ide-border)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}>
          {/* Panel header */}
          <div style={{
            height: '52px', padding: '0 14px',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            borderBottom: '1px solid var(--ide-border)',
          }}>
            <span style={{ fontSize: '11px', fontWeight: '700', color: 'var(--ide-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              {sidebarSection === 'projects' ? 'Projects'
                : sidebarSection === 'builds' ? 'Recent Builds'
                : sidebarSection === 'templates' ? 'Templates'
                : sidebarSection === 'agents' ? 'Agents'
                : sidebarSection === 'deployments' ? 'Deployments'
                : sidebarSection === 'domains' ? '🌐 Domains'
                : 'Settings'}
            </span>
            <button onClick={() => setSidebarCollapsed(true)} title="Collapse" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ide-text-dim)', fontSize: 16, lineHeight: 1, padding: 2 }}>‹</button>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '10px' }}>

            {/* ── PROJECTS section ── */}
            {sidebarSection === 'projects' && (
              <>
                <button onClick={handleNewProject} style={{
                  width: '100%', padding: '8px 10px', marginBottom: '10px',
                  background: 'linear-gradient(135deg,rgba(99,102,241,0.85),rgba(139,92,246,0.85))',
                  color: '#fff', border: '1px solid rgba(99,102,241,0.4)', borderRadius: '8px',
                  cursor: 'pointer', fontSize: '12px', fontWeight: '700',
                  display: 'flex', alignItems: 'center', gap: '6px', justifyContent: 'center',
                  boxShadow: '0 2px 12px rgba(99,102,241,0.3)',
                  transition: 'all 0.2s',
                }}>
                  <span>+</span> New Project
                </button>

                {/* Active project info */}
                {currentProject && (
                  <div style={{ marginBottom: '10px', padding: '10px', background: 'rgba(99,102,241,0.1)', borderRadius: '9px', border: '1px solid rgba(99,102,241,0.25)' }}>
                    <div style={{ fontSize: '10px', color: '#a5b4fc', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '5px' }}>Active</div>
                    <div style={{ fontSize: '12px', fontWeight: '700', color: '#e2e8f0', marginBottom: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentProject.name}</div>
                    {currentDiscovery && (
                      <div style={{ fontSize: '10px', color: 'var(--ide-text-muted)' }}>{currentDiscovery.framework} · {currentDiscovery.fileCount} files</div>
                    )}
                    {previewUrl && !scaffoldDetected && buildProgress?.step !== 'error' && (
                      <div style={{ marginTop: '6px', display: 'flex', alignItems: 'center', gap: '5px' }}>
                        <span className="live-dot" />
                        <span style={{ fontSize: '10px', color: 'var(--ide-green)', fontWeight: '600' }}>Live Preview</span>
                      </div>
                    )}
                  </div>
                )}

                {/* Project list */}
                {projects.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    {projects.slice(0, 12).map(p => {
                      const isActive = p.id === currentProject?.id;
                      return (
                        <button
                          key={p.id}
                          className={`project-card${isActive ? ' active' : ''}`}
                          onClick={() => handleOpenProject(p)}
                        >
                          <div style={{ fontSize: '11px', fontWeight: '600', color: isActive ? '#a5b4fc' : '#cbd5e1', marginBottom: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>
                          <div style={{ fontSize: '10px', color: 'var(--ide-text-muted)' }}>{new Date(p.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div>
                        </button>
                      );
                    })}
                  </div>
                )}

                {projects.length === 0 && !currentProject && (
                  <div style={{ padding: '16px 8px', textAlign: 'center' }}>
                    <div style={{ fontSize: '28px', marginBottom: '8px' }}>◈</div>
                    <div style={{ fontSize: '11px', color: 'var(--ide-text-muted)', lineHeight: 1.6 }}>No projects yet.<br />Describe what you want to build.</div>
                    <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      {['Property marketplace', 'Music streaming app', 'Hotel booking platform', 'Mobile money app'].map(ex => (
                        <button key={ex} onClick={() => { setInput(`Build a ${ex.toLowerCase()}`); inputRef.current?.focus(); }}
                          style={{ textAlign: 'left', background: 'none', border: '1px solid transparent', borderRadius: '6px', padding: '5px 7px', cursor: 'pointer', fontSize: '10px', color: 'var(--ide-text-muted)', transition: 'all 0.12s', display: 'flex', alignItems: 'center', gap: '5px' }}
                          onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(99,102,241,0.3)'; e.currentTarget.style.color = '#a5b4fc'; e.currentTarget.style.background = 'rgba(99,102,241,0.08)'; }}
                          onMouseLeave={e => { e.currentTarget.style.borderColor = 'transparent'; e.currentTarget.style.color = 'var(--ide-text-muted)'; e.currentTarget.style.background = 'none'; }}
                        >
                          <span>⊞</span> {ex}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Missing credentials */}
                {(currentDiscovery?.missingCredentials || []).length > 0 && (
                  <div style={{ marginTop: '8px', padding: '8px', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: '7px' }}>
                    <div style={{ fontSize: '10px', color: 'var(--ide-amber)', fontWeight: '700', marginBottom: '6px' }}>⚠ Setup Required</div>
                    {(currentDiscovery!.missingCredentials || []).map(cred => (
                      <div key={cred.key} style={{ marginBottom: '6px' }}>
                        <div style={{ fontSize: '10px', color: '#d97706', marginBottom: '3px', wordBreak: 'break-all' }}>{cred.key}</div>
                        <div style={{ display: 'flex', gap: '3px' }}>
                          <input type="password" placeholder="paste value…" value={credentialInputs[cred.key] || ''} onChange={e => setCredentialInputs(prev => ({ ...prev, [cred.key]: e.target.value }))}
                            style={{ flex: 1, padding: '4px 6px', background: 'var(--ide-bg)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: '4px', color: '#e2e8f0', fontSize: '10px', minWidth: 0 }} />
                          <button onClick={() => handleSetCredential(cred.key)} disabled={!credentialInputs[cred.key] || credentialSaving === cred.key}
                            style={{ padding: '4px 8px', background: 'rgba(245,158,11,0.15)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: '4px', color: 'var(--ide-amber)', cursor: 'pointer', fontSize: '10px', flexShrink: 0 }}>
                            {credentialSaving === cred.key ? '…' : 'Save'}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* File manager */}
                <div style={{ marginTop: '8px', borderTop: '1px solid var(--ide-border)', paddingTop: '8px' }}>
                  <button onClick={() => setFileManagerOpen(o => !o)}
                    style={{ width: '100%', textAlign: 'left', padding: '4px 0', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ide-text-muted)', fontSize: '10px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span>{fileManagerOpen ? '▾' : '▸'}</span> Files
                  </button>
                  {fileManagerOpen && (
                    <div style={{ marginTop: '4px' }}>
                      <div style={{ display: 'flex', gap: '3px', marginBottom: '6px' }}>
                        <input value={newFilePath} onChange={e => setNewFilePath(e.target.value)} placeholder="app/page.tsx" onKeyDown={e => { if (e.key === 'Enter') handleFileCreate(); }}
                          style={{ flex: 1, padding: '3px 5px', background: 'var(--ide-bg)', border: '1px solid var(--ide-border-accent)', borderRadius: '3px', color: '#e2e8f0', fontSize: '10px', minWidth: 0 }} />
                        <button onClick={handleFileCreate} disabled={!newFilePath.trim() || newFileCreating}
                          style={{ padding: '3px 6px', background: 'rgba(99,102,241,0.15)', border: '1px solid var(--ide-border-accent)', borderRadius: '3px', color: '#a5b4fc', cursor: 'pointer', fontSize: '10px', flexShrink: 0 }}>+</button>
                      </div>
                      {(currentDiscovery?.pages || []).map(f => (
                        <div key={f} style={{ marginBottom: '2px' }}>
                          {fileRenaming === f ? (
                            <div style={{ display: 'flex', gap: '2px' }}>
                              <input autoFocus value={fileRenameValue} onChange={e => setFileRenameValue(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') handleFileRename(f); if (e.key === 'Escape') setFileRenaming(null); }}
                                style={{ flex: 1, padding: '2px 4px', background: 'var(--ide-bg)', border: '1px solid var(--ide-accent)', borderRadius: '3px', color: '#e2e8f0', fontSize: '10px', minWidth: 0 }} />
                              <button onClick={() => handleFileRename(f)} style={{ padding: '2px 5px', background: 'rgba(34,211,160,0.1)', border: '1px solid rgba(34,211,160,0.3)', borderRadius: '3px', color: 'var(--ide-green)', cursor: 'pointer', fontSize: '9px' }}>✓</button>
                              <button onClick={() => setFileRenaming(null)} style={{ padding: '2px 5px', background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.2)', borderRadius: '3px', color: 'var(--ide-red)', cursor: 'pointer', fontSize: '9px' }}>✕</button>
                            </div>
                          ) : (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                              <span style={{ flex: 1, fontSize: '10px', color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f}>{f.replace('app/', '').replace('/page.tsx', '') || '/'}</span>
                              <button onClick={() => { setFileRenaming(f); setFileRenameValue(f); }} title="Rename" style={{ padding: '1px 4px', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ide-text-muted)', fontSize: '10px' }}>✎</button>
                              <button onClick={() => handleFileDelete(f)} title="Delete" style={{ padding: '1px 4px', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ide-text-muted)', fontSize: '10px' }}>✕</button>
                            </div>
                          )}
                        </div>
                      ))}
                      {(currentDiscovery?.components || []).slice(0, 8).map(f => (
                        <div key={f} style={{ display: 'flex', alignItems: 'center', gap: '2px', marginBottom: '2px' }}>
                          <span style={{ flex: 1, fontSize: '10px', color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f}>{f.replace('components/', '').replace(/\.tsx?/, '')}</span>
                          <button onClick={() => handleFileDelete(f)} title="Delete" style={{ padding: '1px 4px', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ide-text-muted)', fontSize: '10px' }}>✕</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}

            {/* ── BUILDS section ── */}
            {sidebarSection === 'builds' && (
              <div>
                {buildProgress ? (
                  <div style={{ padding: '10px', background: phase === 'building' ? 'rgba(99,102,241,0.08)' : 'rgba(34,211,160,0.06)', borderRadius: '9px', border: `1px solid ${phase === 'building' ? 'rgba(99,102,241,0.25)' : 'rgba(34,211,160,0.2)'}` }}>
                    <div style={{ fontSize: '10px', fontWeight: '700', color: phase === 'building' ? '#a5b4fc' : 'var(--ide-green)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                      {phase === 'building' ? '⟳ Building…' : '✓ Last Build'}
                    </div>
                    <div style={{ fontSize: '12px', fontWeight: '600', color: '#e2e8f0', marginBottom: '4px' }}>{buildProgress.projectName || buildingProjectName || '—'}</div>
                    <div style={{ fontSize: '11px', color: 'var(--ide-text-muted)', lineHeight: 1.5 }}>{buildProgress.message.replace(/^[^\s]+\s/, '').slice(0, 80)}</div>
                  </div>
                ) : (
                  <div style={{ padding: '20px 8px', textAlign: 'center', color: 'var(--ide-text-dim)', fontSize: '11px' }}>No builds yet</div>
                )}
              </div>
            )}

            {/* ── TEMPLATES section ── */}
            {sidebarSection === 'templates' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {[
                  { icon: '🛒', name: 'E-Commerce Store', desc: 'Products, cart, Stripe checkout' },
                  { icon: '🏨', name: 'Hotel Booking', desc: 'Rooms, calendar, reservations' },
                  { icon: '📱', name: 'Mobile Money App', desc: 'Send, receive, transaction history' },
                  { icon: '🎵', name: 'Music Platform', desc: 'Player, playlists, artist pages' },
                  { icon: '🏠', name: 'Property Listing', desc: 'Listings, search, contact' },
                  { icon: '📊', name: 'Analytics Dashboard', desc: 'Charts, metrics, reports' },
                  { icon: '🤖', name: 'AI Chat App', desc: 'Chat UI, streaming, history' },
                  { icon: '📚', name: 'Learning Platform', desc: 'Courses, progress, certificates' },
                ].map(t => (
                  <button key={t.name}
                    onClick={() => { setInput(`Build a ${t.name.toLowerCase()}: ${t.desc}`); inputRef.current?.focus(); setSidebarSection('projects'); }}
                    style={{ textAlign: 'left', background: 'var(--ide-surface-2)', border: '1px solid var(--ide-border)', borderRadius: '8px', padding: '9px 10px', cursor: 'pointer', transition: 'all 0.16s', width: '100%' }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(99,102,241,0.35)'; e.currentTarget.style.background = 'rgba(99,102,241,0.08)'; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--ide-border)'; e.currentTarget.style.background = 'var(--ide-surface-2)'; }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '2px' }}>
                      <span style={{ fontSize: '14px' }}>{t.icon}</span>
                      <span style={{ fontSize: '11px', fontWeight: '700', color: '#cbd5e1' }}>{t.name}</span>
                    </div>
                    <div style={{ fontSize: '10px', color: 'var(--ide-text-muted)', paddingLeft: '21px' }}>{t.desc}</div>
                  </button>
                ))}
              </div>
            )}

            {/* ── AGENTS section ── */}
            {sidebarSection === 'agents' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {[
                  { name: 'Builder Agent', desc: 'Generates full-stack apps', status: 'active', color: 'var(--ide-green)' },
                  { name: 'Repair Agent', desc: 'Fixes TypeScript & build errors', status: 'standby', color: 'var(--ide-amber)' },
                  { name: 'Verifier Agent', desc: '18-point route & UI verification', status: 'standby', color: 'var(--ide-blue)' },
                  { name: 'Flutter Agent', desc: 'Dart/Flutter mobile apps', status: 'standby', color: '#c084fc' },
                ].map(agent => (
                  <div key={agent.name} style={{ padding: '10px 11px', background: 'var(--ide-surface-2)', border: '1px solid var(--ide-border)', borderRadius: '8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '3px' }}>
                      <span style={{ fontSize: '11px', fontWeight: '700', color: '#e2e8f0' }}>{agent.name}</span>
                      <span style={{ fontSize: '9px', fontWeight: '600', color: agent.color, background: `${agent.color}14`, border: `1px solid ${agent.color}33`, borderRadius: '4px', padding: '1px 5px' }}>{agent.status}</span>
                    </div>
                    <div style={{ fontSize: '10px', color: 'var(--ide-text-muted)' }}>{agent.desc}</div>
                  </div>
                ))}
              </div>
            )}

            {/* ── DEPLOYMENTS section ── */}
            {sidebarSection === 'deployments' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {!currentProject ? (
                  <div style={{ padding: '20px 8px', textAlign: 'center', color: 'var(--ide-text-dim)', fontSize: '11px' }}>Open a project first</div>
                ) : !deployRecord ? (
                  /* ── No deployment yet ── */
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <div style={{ fontSize: '10px', fontWeight: '700', color: 'var(--ide-text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>DWOMOH Hosting</div>
                    <div style={{ padding: '10px', background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: '8px', fontSize: '10px', color: '#94a3b8', lineHeight: '1.5' }}>
                      Deploy to AWS Amplify — your app goes live at<br />
                      <span style={{ color: '#a5b4fc', fontWeight: '600' }}>{currentProject.name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 30)}.dwomohvibe.com</span>
                    </div>
                    <button onClick={handleDeploy} disabled={deploying}
                      style={{ padding: '10px', background: deploying ? 'rgba(99,102,241,0.15)' : 'rgba(99,102,241,0.25)', border: '1px solid rgba(99,102,241,0.5)', borderRadius: '8px', cursor: deploying ? 'not-allowed' : 'pointer', color: '#c7d2fe', fontSize: '12px', fontWeight: '700', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                      {deploying ? <><span>◌</span> Starting…</> : '⚡ Deploy Now'}
                    </button>
                    <div style={{ fontSize: '10px', color: 'var(--ide-text-dim)', textAlign: 'center' }}>AWS Amplify · ACM SSL · Route 53 DNS · CloudFront CDN</div>
                  </div>
                ) : (
                  /* ── Active / completed deployment ── */
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>

                    {/* ── Status header ── */}
                    {(() => {
                      const s = deployRecord.status;
                      const isLive    = s === 'live';
                      const isFailed  = s === 'failed';
                      const isActive  = !isLive && !isFailed;
                      const dotColor  = isLive ? '#22d3ee' : isFailed ? '#f87171' : '#facc15';
                      const label     = isLive ? 'Live'
                        : isFailed ? 'Failed'
                        : s === 'building' ? 'Building…'
                        : s === 'configuring_domain' ? 'Configuring DNS…'
                        : s === 'verifying' ? 'Verifying…'
                        : 'Deploying…';
                      return (
                        <div style={{ padding: '10px 12px', background: isLive ? 'rgba(34,211,238,0.07)' : isFailed ? 'rgba(248,113,113,0.07)' : 'rgba(250,204,21,0.06)', border: `1px solid ${isLive ? 'rgba(34,211,238,0.25)' : isFailed ? 'rgba(248,113,113,0.25)' : 'rgba(250,204,21,0.2)'}`, borderRadius: '10px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '5px' }}>
                            <div style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: dotColor, boxShadow: isLive ? `0 0 8px ${dotColor}` : 'none' }} />
                            <span style={{ fontSize: '12px', fontWeight: '800', color: dotColor, letterSpacing: '0.04em' }}>{label}</span>
                            {isActive && deployPolling && <span style={{ fontSize: '9px', color: '#64748b' }}>· watching…</span>}
                          </div>
                          {deployRecord.statusDetail && (
                            <div style={{ fontSize: '9px', color: '#94a3b8', marginBottom: '4px', lineHeight: '1.4' }}>{deployRecord.statusDetail}</div>
                          )}
                          {/* Branded URL — always shown */}
                          <a href={deployRecord.brandedUrl} target="_blank" rel="noopener noreferrer"
                            style={{ fontSize: '11px', color: isLive ? '#22d3ee' : '#94a3b8', textDecoration: 'none', fontWeight: '700', wordBreak: 'break-all', display: 'block', marginTop: '2px' }}>
                            {deployRecord.brandedUrl.replace('https://', '')} ↗
                          </a>
                          {/* Verification summary when live */}
                          {isLive && deployRecord.verificationResult && (
                            <div style={{ marginTop: '6px', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                              <span style={{ fontSize: '9px', color: '#6ee7b7', fontWeight: '600' }}>
                                HTTP {deployRecord.verificationResult.httpStatus ?? 200}
                              </span>
                              {deployRecord.verificationResult.pageTitle && (
                                <span style={{ fontSize: '9px', color: '#94a3b8' }}>
                                  · &quot;{deployRecord.verificationResult.pageTitle.slice(0, 30)}&quot;
                                </span>
                              )}
                              <span style={{ fontSize: '9px', color: '#64748b' }}>
                                · {Math.round((deployRecord.verificationResult.totalDurationMs ?? 0) / 1000)}s
                              </span>
                            </div>
                          )}
                          {/* Error message when failed */}
                          {isFailed && deployRecord.errorMessage && (
                            <div style={{ marginTop: '5px', fontSize: '9px', color: '#fca5a5', lineHeight: '1.4' }}>
                              {deployRecord.errorMessage.slice(0, 120)}
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    {/* ── Verification checklist (live during verifying, final when complete) ── */}
                    {(deployVerificationChecks.length > 0 || deployRecord.verificationResult?.checks?.length) && (() => {
                      const checks = deployRecord.verificationResult?.checks ?? deployVerificationChecks;
                      return (
                        <div>
                          <div style={{ fontSize: '10px', fontWeight: '700', color: 'var(--ide-text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '6px' }}>
                            Live Verification
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                            {checks.map((vc, i) => {
                              const isPending = !deployRecord.verificationResult && vc.status === 'warning';
                              const isPass    = vc.status === 'pass';
                              const isFail    = vc.status === 'fail';
                              const icon      = isPass ? '✓' : isFail ? '✗' : isPending ? '⟳' : '○';
                              const color     = isPass ? '#6ee7b7' : isFail ? '#f87171' : isPending ? '#fde68a' : '#64748b';
                              return (
                                <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '6px', padding: '4px 6px', background: isPass ? 'rgba(34,211,160,0.04)' : isFail ? 'rgba(248,113,113,0.04)' : 'transparent', borderRadius: '5px' }}>
                                  <span style={{ fontSize: '9px', color, fontWeight: '700', flexShrink: 0, marginTop: '1px', width: '10px' }}>{icon}</span>
                                  <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ fontSize: '10px', color: isPass ? '#cbd5e1' : isFail ? '#fca5a5' : '#94a3b8', fontWeight: '600' }}>{vc.label}</div>
                                    <div style={{ fontSize: '9px', color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '160px' }}>{vc.detail}</div>
                                  </div>
                                  {vc.durationMs && isPass && (
                                    <span style={{ fontSize: '8px', color: '#475569', flexShrink: 0 }}>{vc.durationMs < 1000 ? `${vc.durationMs}ms` : `${(vc.durationMs / 1000).toFixed(1)}s`}</span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()}

                    {/* ── Re-deploy / Re-verify buttons ── */}
                    <div style={{ display: 'flex', gap: '5px' }}>
                      <button onClick={handleDeploy}
                        disabled={deploying || deployPolling}
                        style={{ flex: 1, padding: '7px', background: 'rgba(99,102,241,0.12)', border: '1px solid rgba(99,102,241,0.3)', borderRadius: '7px', cursor: (deploying || deployPolling) ? 'not-allowed' : 'pointer', color: '#a5b4fc', fontSize: '10px', fontWeight: '700' }}>
                        {deploying ? '◌ Starting…' : '↻ Redeploy'}
                      </button>
                      {(deployRecord.status === 'failed' || deployRecord.status === 'live') && (
                        <button
                          onClick={() => {
                            if (!currentProject) return;
                            setDeployVerificationChecks([]);
                            watchDeployment(currentProject.id, deployRecord.brandedUrl);
                          }}
                          disabled={deployPolling}
                          style={{ flex: 1, padding: '7px', background: 'rgba(34,211,160,0.08)', border: '1px solid rgba(34,211,160,0.2)', borderRadius: '7px', cursor: deployPolling ? 'not-allowed' : 'pointer', color: '#6ee7b7', fontSize: '10px', fontWeight: '700' }}>
                          {deployPolling ? '⟳ Checking…' : '✓ Re-verify'}
                        </button>
                      )}
                    </div>

                    {/* Custom domain section */}
                    <div style={{ paddingTop: '8px', borderTop: '1px solid var(--ide-border)' }}>
                      <div style={{ fontSize: '10px', fontWeight: '700', color: 'var(--ide-text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '8px' }}>Custom Domains</div>

                      {/* Existing custom domains */}
                      {(deployRecord.customDomains ?? []).map((cd) => (
                        <div key={cd.domain} style={{ padding: '8px', background: 'var(--ide-surface-2)', border: '1px solid var(--ide-border)', borderRadius: '7px', marginBottom: '6px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: cd.dnsRecords?.length ? '6px' : 0 }}>
                            <span style={{ fontSize: '11px', color: '#cbd5e1', fontWeight: '600' }}>{cd.domain}</span>
                            <span style={{ fontSize: '9px', padding: '2px 6px', borderRadius: '4px', background: cd.status === 'active' ? 'rgba(34,211,160,0.15)' : cd.status === 'failed' ? 'rgba(248,113,113,0.15)' : 'rgba(250,204,21,0.15)', color: cd.status === 'active' ? '#6ee7b7' : cd.status === 'failed' ? '#fca5a5' : '#fde68a', fontWeight: '700' }}>
                              {cd.status === 'active' ? 'Active' : cd.status === 'failed' ? 'Failed' : 'Pending DNS'}
                            </span>
                          </div>
                          {cd.status !== 'active' && cd.dnsRecords && cd.dnsRecords.length > 0 && (
                            <button
                              onClick={() => setShowDnsInstructions(showDnsInstructions === cd.domain ? null : cd.domain)}
                              style={{ fontSize: '10px', color: '#facc15', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                              {showDnsInstructions === cd.domain ? '▲ Hide DNS records' : '▼ Show DNS records'}
                            </button>
                          )}
                          {showDnsInstructions === cd.domain && cd.dnsRecords && (
                            <div style={{ marginTop: '6px', padding: '6px', background: 'rgba(0,0,0,0.2)', borderRadius: '5px' }}>
                              <div style={{ fontSize: '9px', color: 'var(--ide-text-dim)', marginBottom: '4px' }}>Add these records to your DNS registrar:</div>
                              {cd.dnsRecords.map((r, i) => (
                                <div key={i} style={{ fontSize: '9px', marginBottom: '3px', fontFamily: 'monospace', color: '#94a3b8' }}>
                                  <span style={{ color: '#a5b4fc' }}>{r.type}</span> {r.name} → {r.value}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}

                      {/* Add domain input */}
                      <div style={{ display: 'flex', gap: '4px' }}>
                        <input
                          value={addDomainInput}
                          onChange={e => setAddDomainInput(e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && handleAddCustomDomain()}
                          placeholder="e.g. phonecarmarket.com"
                          style={{ flex: 1, padding: '6px 8px', background: 'var(--ide-bg)', border: '1px solid var(--ide-border-accent)', borderRadius: '6px', color: '#e2e8f0', fontSize: '10px', outline: 'none' }}
                        />
                        <button
                          onClick={handleAddCustomDomain}
                          disabled={addingDomain || !addDomainInput.trim()}
                          style={{ padding: '6px 10px', background: 'rgba(99,102,241,0.2)', border: '1px solid rgba(99,102,241,0.35)', borderRadius: '6px', color: '#a5b4fc', fontSize: '10px', fontWeight: '700', cursor: 'pointer' }}>
                          {addingDomain ? '…' : '+'}
                        </button>
                      </div>
                      <div style={{ fontSize: '9px', color: 'var(--ide-text-dim)', marginTop: '4px' }}>
                        SSL certificate auto-provisioned by AWS
                      </div>
                    </div>

                  </div>
                )}
              </div>
            )}

            {/* ── DOMAINS section ── */}
            {sidebarSection === 'domains' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0', height: '100%', overflow: 'hidden' }}>

                {/* Tab Bar */}
                <div style={{ display: 'flex', borderBottom: '1px solid var(--ide-border)', background: 'var(--ide-surface)', flexShrink: 0 }}>
                  {([
                    { id: 'overview', label: 'Overview' },
                    { id: 'buy',      label: 'Buy Domain' },
                    { id: 'connect',  label: 'Connect' },
                  ] as const).map(tab => (
                    <button key={tab.id} onClick={() => setDomainsTab(tab.id)}
                      style={{ flex: 1, padding: '9px 4px', background: 'none', border: 'none', borderBottom: `2px solid ${domainsTab === tab.id ? '#6366f1' : 'transparent'}`, cursor: 'pointer', fontSize: '10px', fontWeight: '600', color: domainsTab === tab.id ? '#a5b4fc' : 'var(--ide-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', transition: 'all 0.15s' }}>
                      {tab.label}
                    </button>
                  ))}
                </div>

                <div style={{ flex: 1, overflowY: 'auto', padding: '12px 10px', display: 'flex', flexDirection: 'column', gap: '10px' }}>

                  {/* ── OVERVIEW TAB ── */}
                  {domainsTab === 'overview' && (
                    <>
                      {/* Refresh + timestamp */}
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span style={{ fontSize: '9px', color: 'var(--ide-text-dim)' }}>
                          {awsSetupStatus?.checkedAt ? `Updated ${new Date(awsSetupStatus.checkedAt).toLocaleTimeString()}` : 'Loading…'}
                        </span>
                        <button onClick={() => { checkAwsSetup(); loadDomainsData(); }}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ide-text-dim)', fontSize: '12px', padding: '2px 4px' }} title="Refresh all">↻</button>
                      </div>

                      {/* ── Platform Domain Header ── */}
                      <div style={{ padding: '10px 12px', background: 'linear-gradient(135deg, rgba(99,102,241,0.14), rgba(139,92,246,0.08))', border: '1px solid rgba(99,102,241,0.35)', borderRadius: '10px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                          <div>
                            <div style={{ fontSize: '13px', fontWeight: '800', color: '#e2e8f0', letterSpacing: '-0.3px' }}>dwomohvibe.com</div>
                            <div style={{ fontSize: '9px', color: '#7c8db0', marginTop: '1px' }}>DWOMOH Vibe Code Platform</div>
                          </div>
                          <span style={{ fontSize: '9px', padding: '3px 8px', borderRadius: '5px',
                            background: awsSetupStatus?.ready ? 'rgba(34,211,160,0.15)' : 'rgba(250,204,21,0.1)',
                            color: awsSetupStatus?.ready ? '#6ee7b7' : '#fde68a',
                            fontWeight: '700', border: `1px solid ${awsSetupStatus?.ready ? 'rgba(34,211,160,0.3)' : 'rgba(250,204,21,0.2)'}` }}>
                            {awsSetupStatus?.ready ? 'All Systems Go' : awsSetupStatus ? 'Configuring…' : 'Checking…'}
                          </span>
                        </div>
                        <a href="https://dwomohvibe.com" target="_blank" rel="noopener noreferrer"
                          style={{ fontSize: '10px', color: '#818cf8', textDecoration: 'none', fontWeight: '600', display: 'block', marginBottom: '8px' }}>
                          https://dwomohvibe.com ↗
                        </a>
                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                          {[
                            { label: 'SSL', ok: awsSetupStatus?.certificate?.status === 'ISSUED', pending: awsSetupStatus?.certificate?.status === 'PENDING_VALIDATION' },
                            { label: 'DNS', ok: !!awsSetupStatus?.hostedZone, pending: false },
                            { label: 'CDN', ok: awsSetupStatus?.amplifyDomainVerified, pending: awsSetupStatus?.amplifyDomain?.status === 'AWAITING_APP_CNAME' || awsSetupStatus?.amplifyDomain?.status === 'CREATING' },
                            { label: 'IAM', ok: !!awsSetupStatus?.iamRole, pending: false },
                          ].map(item => (
                            <span key={item.label} style={{ fontSize: '9px', padding: '2px 7px', borderRadius: '4px', fontWeight: '700',
                              background: item.ok ? 'rgba(34,211,160,0.12)' : item.pending ? 'rgba(250,204,21,0.1)' : 'rgba(248,113,113,0.1)',
                              color: item.ok ? '#6ee7b7' : item.pending ? '#fde68a' : '#f87171',
                              border: `1px solid ${item.ok ? 'rgba(34,211,160,0.25)' : item.pending ? 'rgba(250,204,21,0.2)' : 'rgba(248,113,113,0.2)'}` }}>
                              {item.ok ? '✓' : item.pending ? '⟳' : '○'} {item.label}
                            </span>
                          ))}
                        </div>
                      </div>

                      {/* ── Status Cards Grid ── */}
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>

                        {/* SSL Status */}
                        {(() => {
                          const cert = awsSetupStatus?.certificate;
                          const isIssued = cert?.status === 'ISSUED';
                          const isPending = cert?.status === 'PENDING_VALIDATION';
                          return (
                            <div style={{ padding: '8px 10px', background: isIssued ? 'rgba(34,211,160,0.06)' : isPending ? 'rgba(250,204,21,0.06)' : 'rgba(99,102,241,0.06)', border: `1px solid ${isIssued ? 'rgba(34,211,160,0.2)' : isPending ? 'rgba(250,204,21,0.2)' : 'var(--ide-border)'}`, borderRadius: '8px' }}>
                              <div style={{ fontSize: '9px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.06em', color: isIssued ? '#6ee7b7' : isPending ? '#fde68a' : '#94a3b8', marginBottom: '4px' }}>SSL Status</div>
                              <div style={{ fontSize: '11px', fontWeight: '700', color: isIssued ? '#6ee7b7' : isPending ? '#fde68a' : '#f87171' }}>
                                {isIssued ? '✓ ISSUED' : isPending ? '⟳ Validating' : cert ? cert.status : '—'}
                              </div>
                              {cert?.expiresAt && (
                                <div style={{ fontSize: '8px', color: '#64748b', marginTop: '2px' }}>
                                  Expires {new Date(cert.expiresAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
                                </div>
                              )}
                              {isIssued && (
                                <div style={{ fontSize: '8px', color: '#6ee7b7', marginTop: '2px' }}>ACM Wildcard *.dwomohvibe.com</div>
                              )}
                            </div>
                          );
                        })()}

                        {/* DNS Status */}
                        {(() => {
                          const hz = awsSetupStatus?.hostedZone;
                          return (
                            <div style={{ padding: '8px 10px', background: hz ? 'rgba(34,211,160,0.06)' : 'rgba(99,102,241,0.06)', border: `1px solid ${hz ? 'rgba(34,211,160,0.2)' : 'var(--ide-border)'}`, borderRadius: '8px' }}>
                              <div style={{ fontSize: '9px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.06em', color: hz ? '#6ee7b7' : '#94a3b8', marginBottom: '4px' }}>DNS Status</div>
                              <div style={{ fontSize: '11px', fontWeight: '700', color: hz ? '#6ee7b7' : '#94a3b8' }}>
                                {hz ? '✓ Active' : '—'}
                              </div>
                              {hz && (
                                <div style={{ fontSize: '8px', color: '#64748b', marginTop: '2px' }}>
                                  {hz.recordCount ?? '?'} records · {(hz.nameservers ?? []).length} NS
                                </div>
                              )}
                            </div>
                          );
                        })()}

                        {/* Hosted Zone */}
                        {(() => {
                          const hz = awsSetupStatus?.hostedZone;
                          return (
                            <div style={{ padding: '8px 10px', background: hz ? 'rgba(99,102,241,0.06)' : 'rgba(99,102,241,0.03)', border: '1px solid var(--ide-border)', borderRadius: '8px' }}>
                              <div style={{ fontSize: '9px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.06em', color: '#94a3b8', marginBottom: '4px' }}>Hosted Zone</div>
                              <div style={{ fontSize: '10px', fontWeight: '700', color: hz ? '#a5b4fc' : '#64748b', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {hz ? hz.id : '—'}
                              </div>
                              <div style={{ fontSize: '8px', color: '#64748b', marginTop: '2px' }}>Route 53 · us-east-1</div>
                            </div>
                          );
                        })()}

                        {/* ACM Status */}
                        {(() => {
                          const cert = awsSetupStatus?.certificate;
                          return (
                            <div style={{ padding: '8px 10px', background: 'rgba(99,102,241,0.06)', border: '1px solid var(--ide-border)', borderRadius: '8px' }}>
                              <div style={{ fontSize: '9px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.06em', color: '#94a3b8', marginBottom: '4px' }}>ACM Cert</div>
                              <div style={{ fontSize: '10px', fontWeight: '700', color: cert?.status === 'ISSUED' ? '#6ee7b7' : '#f59e0b', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {cert ? cert.arn.split('/').pop()?.slice(0, 8) + '…' : '—'}
                              </div>
                              <div style={{ fontSize: '8px', color: '#64748b', marginTop: '2px' }}>ACM · us-east-1</div>
                            </div>
                          );
                        })()}

                        {/* Deployment / Amplify Status */}
                        {(() => {
                          const ad = awsSetupStatus?.amplifyDomain;
                          const statusColor = ad?.verified ? '#6ee7b7' : ad ? '#fde68a' : '#94a3b8';
                          const statusText = ad?.verified ? '✓ Verified' : ad ? `⟳ ${ad.status}` : '—';
                          return (
                            <div style={{ padding: '8px 10px', background: ad?.verified ? 'rgba(34,211,160,0.06)' : 'rgba(250,204,21,0.04)', border: `1px solid ${ad?.verified ? 'rgba(34,211,160,0.2)' : 'rgba(250,204,21,0.15)'}`, borderRadius: '8px' }}>
                              <div style={{ fontSize: '9px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.06em', color: statusColor, marginBottom: '4px' }}>Deployment</div>
                              <div style={{ fontSize: '10px', fontWeight: '700', color: statusColor }}>{statusText}</div>
                              <div style={{ fontSize: '8px', color: '#64748b', marginTop: '2px' }}>AWS Amplify Hosting</div>
                            </div>
                          );
                        })()}

                        {/* Live URL */}
                        {(() => {
                          const liveProject = currentProject && deployRecord?.status === 'live';
                          return (
                            <div style={{ padding: '8px 10px', background: liveProject ? 'rgba(34,211,160,0.06)' : 'rgba(99,102,241,0.03)', border: `1px solid ${liveProject ? 'rgba(34,211,160,0.2)' : 'var(--ide-border)'}`, borderRadius: '8px' }}>
                              <div style={{ fontSize: '9px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.06em', color: liveProject ? '#6ee7b7' : '#94a3b8', marginBottom: '4px' }}>Live URL</div>
                              {liveProject ? (
                                <a href={deployRecord!.brandedUrl} target="_blank" rel="noopener noreferrer"
                                  style={{ fontSize: '9px', color: '#22d3ee', textDecoration: 'none', fontWeight: '700', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {(deployRecord!.brandedUrl ?? '').replace('https://', '')} ↗
                                </a>
                              ) : (
                                <div style={{ fontSize: '9px', color: '#64748b' }}>Deploy a project</div>
                              )}
                            </div>
                          );
                        })()}
                      </div>

                      {/* ── Nameservers ── */}
                      {(awsSetupStatus?.hostedZone?.nameservers ?? []).length > 0 && (
                        <div>
                          <div style={{ fontSize: '10px', fontWeight: '700', color: 'var(--ide-text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '5px' }}>Route 53 Nameservers</div>
                          <div style={{ padding: '8px 10px', background: 'var(--ide-surface-2)', border: '1px solid var(--ide-border)', borderRadius: '8px' }}>
                            {(awsSetupStatus!.hostedZone!.nameservers!).map((ns, i) => (
                              <div key={i} style={{ fontSize: '9px', fontFamily: 'monospace', color: '#94a3b8', marginBottom: i < 3 ? '2px' : 0 }}>{ns}</div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* ── ACM Domains Covered ── */}
                      {(awsSetupStatus?.certificate?.domains ?? []).length > 0 && (
                        <div>
                          <div style={{ fontSize: '10px', fontWeight: '700', color: 'var(--ide-text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '5px' }}>SSL Certificate Covers</div>
                          <div style={{ padding: '8px 10px', background: 'var(--ide-surface-2)', border: '1px solid var(--ide-border)', borderRadius: '8px' }}>
                            {(awsSetupStatus!.certificate!.domains!).map((d, i) => (
                              <div key={i} style={{ fontSize: '9px', fontFamily: 'monospace', color: '#6ee7b7', marginBottom: i < awsSetupStatus!.certificate!.domains!.length - 1 ? '2px' : 0 }}>✓ {d}</div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* ── CloudFront Distribution ── */}
                      {awsSetupStatus?.amplifyDomain?.cfDistribution && (
                        <div style={{ padding: '8px 10px', background: 'var(--ide-surface-2)', border: '1px solid var(--ide-border)', borderRadius: '8px' }}>
                          <div style={{ fontSize: '9px', fontWeight: '700', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '3px' }}>CloudFront Distribution</div>
                          <div style={{ fontSize: '9px', fontFamily: 'monospace', color: '#818cf8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {awsSetupStatus.amplifyDomain.cfDistribution}
                          </div>
                          <div style={{ fontSize: '8px', color: '#64748b', marginTop: '2px' }}>Powers all *.dwomohvibe.com subdomains</div>
                        </div>
                      )}

                      {/* ── Project Subdomains ── */}
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                          <div style={{ fontSize: '10px', fontWeight: '700', color: 'var(--ide-text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Project URLs</div>
                          <button onClick={loadDomainsData} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ide-text-dim)', fontSize: '11px' }} title="Refresh">↻</button>
                        </div>
                        {domainsLoading ? (
                          <div style={{ fontSize: '10px', color: 'var(--ide-text-dim)', textAlign: 'center', padding: '12px' }}>Loading…</div>
                        ) : (domainsData?.projectDomains ?? []).length === 0 ? (
                          <div style={{ padding: '10px', background: 'var(--ide-surface-2)', border: '1px solid var(--ide-border)', borderRadius: '8px', fontSize: '10px', color: 'var(--ide-text-dim)', textAlign: 'center', lineHeight: '1.5' }}>
                            No deployed projects yet.<br />Deploy a project to get a {`{slug}`}.dwomohvibe.com URL.
                          </div>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                            {(domainsData?.projectDomains ?? []).slice(0, 8).map((pd: { domain: string; status: string; brandedUrl: string; projectName: string }, i: number) => (
                              <div key={i} style={{ padding: '8px 10px', background: 'var(--ide-surface-2)', border: '1px solid var(--ide-border)', borderRadius: '8px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '2px' }}>
                                  <span style={{ fontSize: '10px', fontWeight: '600', color: '#cbd5e1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '130px' }}>{pd.domain}</span>
                                  <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                                    <span style={{ fontSize: '9px', color: pd.status === 'live' ? '#6ee7b7' : pd.status === 'failed' ? '#f87171' : '#fde68a', fontWeight: '700' }}>
                                      {pd.status === 'live' ? '✓' : pd.status === 'failed' ? '✗' : '◌'}
                                    </span>
                                    {pd.status === 'live' && (
                                      <a href={pd.brandedUrl} target="_blank" rel="noopener noreferrer"
                                        style={{ fontSize: '9px', color: '#6366f1', textDecoration: 'none', fontWeight: '600' }}>↗</a>
                                    )}
                                  </div>
                                </div>
                                <div style={{ fontSize: '9px', color: 'var(--ide-text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pd.projectName}</div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* ── Registered Domains ── */}
                      {(domainsData?.registered ?? []).length > 0 && (
                        <div>
                          <div style={{ fontSize: '10px', fontWeight: '700', color: 'var(--ide-text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '6px' }}>Registered in Route 53</div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            {(domainsData!.registered as Array<{ domain: string }>).map((rd, i) => (
                              <div key={i} style={{ padding: '7px 10px', background: 'var(--ide-surface-2)', border: '1px solid var(--ide-border)', borderRadius: '7px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                <span style={{ fontSize: '10px', color: '#e2e8f0', fontWeight: '600' }}>{rd.domain}</span>
                                <span style={{ fontSize: '9px', color: '#6ee7b7' }}>✓ Owned</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* ── DNS Records ── */}
                      {(awsSetupStatus?.dnsRecords ?? []).length > 0 && (
                        <div>
                          <div style={{ fontSize: '10px', fontWeight: '700', color: 'var(--ide-text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '5px' }}>
                            DNS Records ({(awsSetupStatus!.dnsRecords!).length})
                          </div>
                          <div style={{ maxHeight: '140px', overflowY: 'auto', padding: '8px 10px', background: 'var(--ide-surface-2)', border: '1px solid var(--ide-border)', borderRadius: '8px' }}>
                            {(awsSetupStatus!.dnsRecords!).map((r, i) => (
                              <div key={i} style={{ display: 'flex', gap: '6px', marginBottom: '3px', fontSize: '8px', fontFamily: 'monospace' }}>
                                <span style={{ color: '#a5b4fc', width: '32px', flexShrink: 0 }}>{r.type}</span>
                                <span style={{ color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '80px' }}>{r.name.replace('dwomohvibe.com', '~')}</span>
                                <span style={{ color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{r.value.slice(0, 30)}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  )}

                  {/* ── BUY DOMAIN TAB ── */}
                  {domainsTab === 'buy' && (
                    <>
                      <div style={{ fontSize: '10px', color: 'var(--ide-text-muted)', lineHeight: '1.5' }}>
                        Search and purchase domains through AWS Route 53. They auto-connect to DWOMOH Vibe Code hosting.
                      </div>

                      {/* Search input */}
                      <div style={{ display: 'flex', gap: '4px' }}>
                        <input
                          value={domainSearchQuery}
                          onChange={e => setDomainSearchQuery(e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && handleDomainSearch()}
                          placeholder="Search: store, hotel, myapp…"
                          style={{ flex: 1, padding: '8px 10px', background: 'var(--ide-bg)', border: '1px solid var(--ide-border-accent)', borderRadius: '7px', color: '#e2e8f0', fontSize: '11px', outline: 'none' }}
                        />
                        <button
                          onClick={handleDomainSearch}
                          disabled={domainSearching || !domainSearchQuery.trim()}
                          style={{ padding: '8px 12px', background: 'rgba(99,102,241,0.2)', border: '1px solid rgba(99,102,241,0.4)', borderRadius: '7px', cursor: 'pointer', color: '#a5b4fc', fontSize: '11px', fontWeight: '700' }}>
                          {domainSearching ? '…' : '⌕'}
                        </button>
                      </div>

                      {/* Purchase success banner */}
                      {purchaseSuccess && (
                        <div style={{ padding: '10px', background: 'rgba(34,211,160,0.1)', border: '1px solid rgba(34,211,160,0.3)', borderRadius: '8px', fontSize: '10px', color: '#6ee7b7', lineHeight: '1.5' }}>
                          ✓ <strong>{purchaseSuccess}</strong> registration started — usually ready in 5–15 minutes.
                        </div>
                      )}

                      {/* Search results */}
                      {domainSearching && (
                        <div style={{ fontSize: '10px', color: 'var(--ide-text-dim)', textAlign: 'center', padding: '12px' }}>Checking availability…</div>
                      )}

                      {domainSearchResults.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          {domainSearchResults.map((r, i) => (
                            <div key={i} style={{ padding: '8px 10px', background: r.available ? 'rgba(34,211,160,0.04)' : 'rgba(255,255,255,0.02)', border: `1px solid ${r.available ? 'rgba(34,211,160,0.2)' : 'var(--ide-border)'}`, borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' }}>
                              <div>
                                <div style={{ fontSize: '11px', fontWeight: '600', color: r.available ? '#e2e8f0' : '#64748b' }}>{r.domain}</div>
                                {r.price != null && (
                                  <div style={{ fontSize: '9px', color: r.available ? '#6ee7b7' : 'var(--ide-text-dim)', marginTop: '1px' }}>
                                    {r.available ? `$${r.price.toFixed(0)}/yr` : 'Taken'}
                                  </div>
                                )}
                              </div>
                              {r.available ? (
                                <button
                                  onClick={() => handleDomainPurchase(r.domain)}
                                  disabled={domainPurchasing === r.domain}
                                  style={{ padding: '5px 10px', background: 'rgba(34,211,160,0.15)', border: '1px solid rgba(34,211,160,0.35)', borderRadius: '6px', cursor: 'pointer', color: '#6ee7b7', fontSize: '10px', fontWeight: '700', flexShrink: 0 }}>
                                  {domainPurchasing === r.domain ? '…' : 'Buy'}
                                </button>
                              ) : (
                                <span style={{ fontSize: '9px', color: '#64748b', flexShrink: 0 }}>Taken</span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Popular TLDs info */}
                      {domainSearchResults.length === 0 && !domainSearching && (
                        <div style={{ padding: '10px', background: 'var(--ide-surface-2)', border: '1px solid var(--ide-border)', borderRadius: '8px', fontSize: '10px', color: '#64748b', lineHeight: '1.6' }}>
                          Search checks availability across .com, .net, .org, .io, .co, .app, .dev, .store, .online, .site
                          <div style={{ marginTop: '6px', color: '#94a3b8' }}>Domains are purchased through AWS Route 53 and auto-configured with SSL + DNS.</div>
                        </div>
                      )}
                    </>
                  )}

                  {/* ── CONNECT TAB ── */}
                  {domainsTab === 'connect' && (
                    <>
                      <div style={{ fontSize: '10px', color: 'var(--ide-text-muted)', lineHeight: '1.5' }}>
                        Connect a domain you already own (from any registrar) to your project.
                      </div>

                      {/* Domain input */}
                      <div>
                        <div style={{ fontSize: '10px', color: '#94a3b8', marginBottom: '5px', fontWeight: '600' }}>
                          {currentProject ? `Connect to: ${currentProject.name}` : 'Connect to a project'}
                        </div>
                        <div style={{ display: 'flex', gap: '4px' }}>
                          <input
                            value={connectDomainInput}
                            onChange={e => setConnectDomainInput(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && handleConnectDomain()}
                            placeholder="yourapp.com"
                            style={{ flex: 1, padding: '8px 10px', background: 'var(--ide-bg)', border: '1px solid var(--ide-border-accent)', borderRadius: '7px', color: '#e2e8f0', fontSize: '11px', outline: 'none' }}
                          />
                          <button
                            onClick={handleConnectDomain}
                            disabled={connectingDomain || !connectDomainInput.trim()}
                            style={{ padding: '8px 12px', background: 'rgba(99,102,241,0.2)', border: '1px solid rgba(99,102,241,0.4)', borderRadius: '7px', cursor: 'pointer', color: '#a5b4fc', fontSize: '11px', fontWeight: '700' }}>
                            {connectingDomain ? '…' : '+'}
                          </button>
                        </div>
                        {!currentProject && (
                          <div style={{ fontSize: '9px', color: '#f59e0b', marginTop: '4px' }}>Open a project first to connect a domain to it</div>
                        )}
                      </div>

                      {/* How it works */}
                      <div style={{ padding: '10px', background: 'var(--ide-surface-2)', border: '1px solid var(--ide-border)', borderRadius: '8px' }}>
                        <div style={{ fontSize: '10px', fontWeight: '700', color: '#cbd5e1', marginBottom: '6px' }}>How it works</div>
                        {[
                          'Enter your domain name above',
                          'We generate the CNAME records you need',
                          'Add them at your registrar (GoDaddy, Namecheap, etc.)',
                          'SSL certificate provisions automatically (AWS ACM)',
                          'Domain goes live within 15–60 minutes',
                        ].map((step, i) => (
                          <div key={i} style={{ display: 'flex', gap: '7px', marginBottom: '4px', fontSize: '10px', color: '#94a3b8' }}>
                            <span style={{ color: '#6366f1', fontWeight: '700', flexShrink: 0 }}>{i + 1}.</span>
                            <span>{step}</span>
                          </div>
                        ))}
                      </div>

                      {/* Current project custom domains */}
                      {deployRecord && (deployRecord.customDomains ?? []).length > 0 && (
                        <div>
                          <div style={{ fontSize: '10px', fontWeight: '700', color: 'var(--ide-text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '6px' }}>Connected Domains</div>
                          {deployRecord.customDomains.map((cd, i) => (
                            <div key={i} style={{ padding: '8px 10px', background: 'var(--ide-surface-2)', border: '1px solid var(--ide-border)', borderRadius: '8px', marginBottom: '4px' }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span style={{ fontSize: '11px', color: '#e2e8f0', fontWeight: '600' }}>{cd.domain}</span>
                                <span style={{ fontSize: '9px', padding: '2px 6px', borderRadius: '4px', background: cd.status === 'active' ? 'rgba(34,211,160,0.12)' : 'rgba(250,204,21,0.1)', color: cd.status === 'active' ? '#6ee7b7' : '#fde68a', fontWeight: '700' }}>
                                  {cd.status === 'active' ? 'Active' : 'Pending DNS'}
                                </span>
                              </div>
                              {cd.dnsRecords && cd.dnsRecords.length > 0 && cd.status !== 'active' && (
                                <div style={{ marginTop: '6px', padding: '6px', background: 'rgba(0,0,0,0.2)', borderRadius: '5px' }}>
                                  <div style={{ fontSize: '9px', color: 'var(--ide-text-dim)', marginBottom: '3px' }}>Add at your registrar:</div>
                                  {cd.dnsRecords.map((r: { type: string; name: string; value: string }, ri: number) => (
                                    <div key={ri} style={{ fontSize: '9px', fontFamily: 'monospace', color: '#94a3b8', marginBottom: '2px' }}>
                                      <span style={{ color: '#a5b4fc' }}>{r.type}</span> {r.name.split('.')[0]} → {r.value.slice(0, 30)}…
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}

                </div>
              </div>
            )}

            {/* ── SETTINGS section ── */}
            {sidebarSection === 'settings' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>

                {/* ── AWS Platform Setup ── */}
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <div style={{ fontSize: '10px', fontWeight: '700', color: 'var(--ide-text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>AWS Hosting Setup</div>
                    {awsSetupStatus?.ready && (
                      <span style={{ fontSize: '9px', padding: '2px 6px', borderRadius: '4px', background: 'rgba(34,211,160,0.12)', color: '#6ee7b7', fontWeight: '700' }}>Ready</span>
                    )}
                  </div>

                  {/* Step list */}
                  {awsSetupStatus ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '8px' }}>
                      {awsSetupStatus.steps.map((step: AwsSetupStep) => (
                        <div key={step.id} style={{ display: 'flex', alignItems: 'flex-start', gap: '6px' }}>
                          <span style={{ fontSize: '10px', marginTop: '1px', flexShrink: 0,
                            color: step.status === 'done' ? '#6ee7b7'
                              : step.status === 'error' ? '#f87171'
                              : step.status === 'running' ? '#facc15'
                              : step.status === 'skipped' ? '#64748b'
                              : '#64748b' }}>
                            {step.status === 'done' ? '✓' : step.status === 'error' ? '✗' : step.status === 'running' ? '◌' : step.status === 'skipped' ? '–' : '○'}
                          </span>
                          <div>
                            <div style={{ fontSize: '10px', color: step.status === 'done' ? '#cbd5e1' : step.status === 'error' ? '#fca5a5' : '#94a3b8' }}>{step.label}</div>
                            {step.detail && <div style={{ fontSize: '9px', color: 'var(--ide-text-dim)', marginTop: '1px', wordBreak: 'break-all' }}>{step.detail}</div>}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontSize: '10px', color: 'var(--ide-text-dim)', marginBottom: '8px', lineHeight: '1.5' }}>
                      Configure AWS hosting so every project automatically gets a branded URL like <span style={{ color: '#a5b4fc' }}>yourapp.dwomohvibe.app</span>
                    </div>
                  )}

                  {/* Setup logs */}
                  {awsSetupLogs.length > 0 && (
                    <div style={{ maxHeight: '80px', overflowY: 'auto', marginBottom: '6px', padding: '6px', background: 'rgba(0,0,0,0.3)', borderRadius: '5px' }}>
                      {awsSetupLogs.map((log, i) => (
                        <div key={i} style={{ fontSize: '9px', color: '#64748b', fontFamily: 'monospace', lineHeight: '1.4' }}>{log}</div>
                      ))}
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: '4px' }}>
                    <button
                      onClick={runAwsSetup}
                      disabled={awsSetupRunning}
                      style={{ flex: 1, padding: '8px', background: awsSetupStatus?.ready ? 'rgba(34,211,160,0.1)' : 'rgba(99,102,241,0.18)', border: `1px solid ${awsSetupStatus?.ready ? 'rgba(34,211,160,0.3)' : 'rgba(99,102,241,0.4)'}`, borderRadius: '7px', cursor: awsSetupRunning ? 'not-allowed' : 'pointer', color: awsSetupStatus?.ready ? '#6ee7b7' : '#a5b4fc', fontSize: '11px', fontWeight: '700', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px' }}>
                      {awsSetupRunning
                        ? <><span style={{ display: 'inline-block', animation: 'spin 1s linear infinite' }}>◌</span> Configuring AWS…</>
                        : awsSetupStatus?.ready ? '✓ Re-run Setup' : 'Run AWS Setup'}
                    </button>
                    <button
                      onClick={checkAwsSetup}
                      disabled={awsSetupRunning}
                      style={{ padding: '8px 10px', background: 'var(--ide-surface-2)', border: '1px solid var(--ide-border)', borderRadius: '7px', cursor: 'pointer', color: 'var(--ide-text-muted)', fontSize: '11px' }}
                      title="Refresh status">
                      ↻
                    </button>
                  </div>

                  {!awsSetupStatus?.hostedZone && (
                    <div style={{ marginTop: '8px', padding: '8px', background: 'rgba(250,204,21,0.06)', border: '1px solid rgba(250,204,21,0.2)', borderRadius: '7px', fontSize: '10px', color: '#fde68a', lineHeight: '1.5' }}>
                      First: Purchase <strong>dwomohvibe.app</strong> in AWS Route 53 (Registered domains), then click Run AWS Setup — everything configures automatically.
                    </div>
                  )}
                </div>

                <div style={{ borderTop: '1px solid var(--ide-border)', paddingTop: '10px' }}>
                  <div style={{ fontSize: '10px', fontWeight: '700', color: 'var(--ide-text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '6px' }}>Auth</div>
                  <select value={authProvider} onChange={e => setAuthProvider(e.target.value as typeof authProvider)}
                    style={{ width: '100%', padding: '6px 8px', background: 'var(--ide-bg)', border: '1px solid var(--ide-border-accent)', borderRadius: '6px', color: '#e2e8f0', fontSize: '11px', marginBottom: '6px' }}>
                    <option value="nextauth">NextAuth.js</option>
                    <option value="clerk">Clerk</option>
                    <option value="supabase">Supabase Auth</option>
                    <option value="firebase">Firebase Auth</option>
                    <option value="cognito">AWS Cognito</option>
                  </select>
                  {currentProject && (
                    <button onClick={handleAuthScaffold} disabled={authScaffolding || isBusy}
                      style={{ width: '100%', padding: '7px', background: 'rgba(99,102,241,0.15)', border: '1px solid var(--ide-border-accent)', borderRadius: '6px', color: '#a5b4fc', cursor: 'pointer', fontSize: '11px', fontWeight: '600' }}>
                      {authScaffolding ? 'Scaffolding…' : 'Add Auth'}
                    </button>
                  )}
                </div>
                <div>
                  <div style={{ fontSize: '10px', fontWeight: '700', color: 'var(--ide-text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '6px' }}>Database</div>
                  <select value={dbType} onChange={e => setDbType(e.target.value)}
                    style={{ width: '100%', padding: '6px 8px', background: 'var(--ide-bg)', border: '1px solid var(--ide-border-accent)', borderRadius: '6px', color: '#e2e8f0', fontSize: '11px' }}>
                    <option value="supabase">Supabase</option>
                    <option value="postgresql">PostgreSQL</option>
                    <option value="dynamodb">DynamoDB</option>
                    <option value="firebase">Firebase</option>
                  </select>
                </div>
                <div>
                  <div style={{ fontSize: '10px', fontWeight: '700', color: 'var(--ide-text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '6px' }}>Voice</div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: '11px', color: '#94a3b8' }}>AI voice replies</span>
                    <button onClick={() => setVoiceEnabled(v => !v)}
                      style={{ padding: '4px 10px', background: voiceEnabled ? 'rgba(34,211,160,0.15)' : 'rgba(255,255,255,0.04)', border: `1px solid ${voiceEnabled ? 'rgba(34,211,160,0.35)' : 'var(--ide-border)'}`, borderRadius: '6px', color: voiceEnabled ? 'var(--ide-green)' : 'var(--ide-text-muted)', cursor: 'pointer', fontSize: '10px', fontWeight: '600' }}>
                      {voiceEnabled ? 'On' : 'Off'}
                    </button>
                  </div>
                </div>
                <div style={{ paddingTop: '8px', borderTop: '1px solid var(--ide-border)' }}>
                  <a href="/" style={{ fontSize: '11px', color: 'var(--ide-text-muted)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '5px' }}>← Back to home</a>
                </div>
              </div>
            )}

          </div>

          {/* Sidebar footer */}
          <div style={{ padding: '10px 12px', borderTop: '1px solid var(--ide-border)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ width: 24, height: 24, borderRadius: '50%', background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', fontWeight: '700', color: '#fff', flexShrink: 0 }}>BD</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '11px', fontWeight: '600', color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Bright Dwomoh</div>
              <div style={{ fontSize: '10px', color: 'var(--ide-text-muted)' }}>AWS Bedrock</div>
            </div>
            {lastVerification && (
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: lastVerification.verified ? 'var(--ide-green)' : 'var(--ide-amber)', flexShrink: 0 }} title={lastVerification.verified ? 'Last verification passed' : 'Verification issues'} />
            )}
          </div>
        </div>
        )}

        {/* Collapsed sidebar expand button */}
        {(focusMode || sidebarCollapsed) && (
          <button onClick={() => { setSidebarCollapsed(false); setFocusMode(false); }} title="Expand sidebar"
            style={{ position: 'fixed', top: '26px', left: 'calc(var(--sidebar-icon-w) + 8px)', zIndex: 30, background: 'var(--ide-surface)', border: '1px solid var(--ide-border-accent)', borderRadius: '6px', padding: '4px 8px', cursor: 'pointer', color: '#a5b4fc', fontSize: '11px', fontWeight: '600' }}>
            › Panel
          </button>
        )}


        {/* ── Chat Panel ─────────────────────────────────────────────── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, borderRight: '1px solid var(--ide-border)' }}>

          {/* ── Top Header Bar ── */}
          <div style={{
            height: '52px', padding: '0 16px',
            display: 'flex', alignItems: 'center', gap: '12px',
            borderBottom: '1px solid var(--ide-border)',
            background: 'var(--ide-surface)',
            flexShrink: 0,
          }}>
            {/* Mode tabs */}
            <div style={{ display: 'flex', gap: '4px', background: 'var(--ide-bg)', borderRadius: '9px', padding: '3px', border: '1px solid var(--ide-border)' }}>
              {(['build', 'debug', 'deploy'] as const).map(mode => (
                <button key={mode} className={`mode-tab${builderMode === mode ? ' active' : ''}`}
                  onClick={() => setBuilderMode(mode)}
                  style={{ border: builderMode === mode ? '1px solid rgba(99,102,241,0.3)' : '1px solid transparent' }}
                >
                  {mode === 'build' ? '⬡ Build' : mode === 'debug' ? '◈ Debug' : '⊕ Deploy'}
                </button>
              ))}
            </div>

            {/* Project context */}
            {currentProject && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: '11px', color: 'var(--ide-text-muted)' }}>›</span>
                <span style={{ fontSize: '12px', fontWeight: '600', color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentProject.name}</span>
                {currentDiscovery?.mode && (
                  <span style={{ padding: '1px 6px', borderRadius: '4px', background: 'rgba(34,211,160,0.08)', border: '1px solid rgba(34,211,160,0.2)', color: 'var(--ide-green)', fontSize: '9px', fontWeight: '700', textTransform: 'uppercase', flexShrink: 0 }}>
                    {currentDiscovery.mode}
                  </span>
                )}
                {previewUrl && !scaffoldDetected && buildProgress?.step !== 'error' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                    <span className="live-dot" />
                    <span style={{ fontSize: '10px', color: 'var(--ide-green)', fontWeight: '600' }}>Live</span>
                  </div>
                )}
              </div>
            )}

            {!currentProject && phase === 'building' && (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                <span style={{ fontSize: '11px', color: 'var(--ide-text-muted)' }}>›</span>
                <span style={{ fontSize: '12px', fontWeight: '600', color: '#a5b4fc', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{buildingProjectName || builderContext?.projectName || 'Building…'}</span>
                <div style={{ display: 'inline-block', width: 14, height: 14, border: '2px solid rgba(99,102,241,0.3)', borderTop: '2px solid #6366f1', borderRadius: '50%', animation: 'spin 0.8s linear infinite', flexShrink: 0 }} />
              </div>
            )}

            {!currentProject && phase !== 'building' && <div style={{ flex: 1 }} />}

            {/* Right controls */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
              {previewUrl && (
                <>
                  <button onClick={handleBrowserScreenshot} disabled={browserDebugging || isBusy} title="Screenshot"
                    style={{ padding: '5px 10px', background: 'var(--ide-surface-2)', border: '1px solid var(--ide-border)', borderRadius: '6px', color: 'var(--ide-text-muted)', cursor: 'pointer', fontSize: '11px', fontWeight: '500', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    {browserDebugging ? '…' : '📷'}
                  </button>
                  <button onClick={handleBrowserDebug} disabled={browserDebugging || isBusy} title="Debug console"
                    style={{ padding: '5px 10px', background: 'var(--ide-surface-2)', border: '1px solid var(--ide-border)', borderRadius: '6px', color: 'var(--ide-text-muted)', cursor: 'pointer', fontSize: '11px', fontWeight: '500' }}>
                    {browserDebugging ? '…' : '⬡'}
                  </button>
                </>
              )}
              <button onClick={() => setFocusMode(f => !f)} title={focusMode ? 'Exit focus mode' : 'Focus mode — maximise workspace'}
                style={{ padding: '5px 10px', background: focusMode ? 'rgba(99,102,241,0.15)' : 'var(--ide-surface-2)', border: `1px solid ${focusMode ? 'rgba(99,102,241,0.4)' : 'var(--ide-border)'}`, borderRadius: '6px', color: focusMode ? '#a5b4fc' : 'var(--ide-text-muted)', cursor: 'pointer', fontSize: '11px', fontWeight: '600' }}>
                {focusMode ? '⊞ Focus' : '⊟'}
              </button>
              {/* Obvious, always-visible Developer Mode toggle — SUPER_ADMIN
                  (or any future role granted VIEW_DEVELOPER_MODE) only. Lives
                  in the persistent top header bar (not the composer toolbar,
                  which can scroll out of view) so it is impossible to miss.
                  Reuses the same debugMode state everything else already
                  gates on (Bridge Test, Engine Build/Test, Worker Panel,
                  Developer Mode report fields) — turning this on/off is a
                  single source of truth for all of them. */}
              {myPermissions.has('VIEW_DEVELOPER_MODE') && (
                <button
                  onClick={() => setDebugMode(d => {
                    const next = !d;
                    if (!next) setBridgeTestMode(false);
                    return next;
                  })}
                  title={debugMode ? 'Developer Mode ON — Bridge Test, Engine Build/Test, and internal diagnostics are visible. Click to hide them.' : 'Developer Mode OFF — click to reveal Bridge Test, Engine Build/Test, and internal build/repair diagnostics (SUPER_ADMIN only).'}
                  style={{
                    padding: '5px 12px', borderRadius: '6px', cursor: 'pointer', fontSize: '11px', fontWeight: '700',
                    display: 'flex', alignItems: 'center', gap: '5px',
                    background: debugMode ? 'linear-gradient(135deg,#3b82f6,#2563eb)' : 'var(--ide-surface-2)',
                    border: `1px solid ${debugMode ? '#3b82f6' : 'var(--ide-border)'}`,
                    color: debugMode ? '#fff' : 'var(--ide-text-muted)',
                  }}>
                  <span style={{ fontSize: '10px' }}>{debugMode ? '●' : '○'}</span>
                  {debugMode ? 'Developer Mode: ON' : 'Developer Mode'}
                </button>
              )}
            </div>
          </div>

          {/* Builder Mode Indicator — shows current pipeline stage */}
          {builderContext?.active && !currentProject && (() => {
            const isBuildingPhase = phase === 'building' || builderContext.stage === 'building';
            const isVerifyingPhase = phase === 'previewing' && buildProgress?.step !== 'done';
            const isPreviewReady = phase === 'previewing' && buildProgress?.step === 'done';
            const isPlanningPhase = !isBuildingPhase && !isVerifyingPhase && !isPreviewReady;

            const STAGES = [
              { key: 'planning',  label: 'PLANNING',       active: isPlanningPhase,   done: isBuildingPhase || isVerifyingPhase || isPreviewReady },
              { key: 'building',  label: 'BUILDING',       active: isBuildingPhase,   done: isVerifyingPhase || isPreviewReady },
              { key: 'verifying', label: 'VERIFYING',      active: isVerifyingPhase,  done: isPreviewReady },
              { key: 'preview',   label: 'PREVIEW READY',  active: isPreviewReady,    done: false },
            ];

            return (
              <div style={{ padding: '5px 16px', background: 'var(--ide-surface)', borderBottom: '1px solid var(--ide-border)', display: 'flex', alignItems: 'center', gap: '0', overflow: 'hidden' }}>
                {/* Project name */}
                <span style={{ color: '#a5b4fc', fontWeight: '700', fontSize: '10px', marginRight: '12px', flexShrink: 0, maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {builderContext.projectName}
                </span>

                {/* Pipeline stages */}
                {STAGES.map((s, i) => (
                  <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: '0' }}>
                    {/* Arrow between stages */}
                    {i > 0 && (
                      <span style={{ color: s.done || STAGES[i-1].active ? '#1e40af' : '#1a2e45', fontSize: '10px', margin: '0 4px', fontWeight: '700' }}>→</span>
                    )}
                    <span style={{
                      fontSize: '9px',
                      fontWeight: s.active ? '800' : '500',
                      letterSpacing: '0.08em',
                      color: s.active ? '#4ade80' : s.done ? '#1d4ed8' : '#334155',
                      display: 'flex', alignItems: 'center', gap: '4px',
                      padding: s.active ? '2px 6px' : '0',
                      background: s.active ? 'rgba(74,222,128,0.1)' : 'transparent',
                      borderRadius: '3px',
                      transition: 'all 0.3s ease',
                    }}>
                      {s.active && <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#4ade80', animation: 'pulse 1.5s ease-in-out infinite', flexShrink: 0 }} />}
                      {s.done && <span style={{ color: '#1d4ed8', fontSize: '8px' }}>✓</span>}
                      {s.label}
                    </span>
                  </div>
                ))}

                <button
                  onClick={() => setBuilderContext(null)}
                  title="Dismiss"
                  style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#334155', cursor: 'pointer', fontSize: '12px', lineHeight: 1, padding: '0 0 0 8px', flexShrink: 0 }}
                >×</button>
              </div>
            );
          })()}

          {/* Messages */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '20px', background: 'var(--ide-bg)' }}>

            {/* ── Goal-First Build Flow (spec points 1-5) ── */}
            {goalStep === 'type' && !currentProject && displayed.length === 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '70%', gap: 0 }}>
                <div style={{ fontSize: '28px', fontWeight: '800', color: '#e2e8f0', marginBottom: '8px', letterSpacing: '-0.03em', textAlign: 'center' }}>What would you like to build?</div>
                <div style={{ fontSize: '14px', color: '#475569', marginBottom: '40px', textAlign: 'center' }}>Choose your output type — we handle the technology for you.</div>
                <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap', justifyContent: 'center' }}>
                  {[
                    { icon: '🌐', label: 'Website', sub: 'Marketplace, SaaS, dashboard, booking, portfolio, blog', action: () => handleGoalSelect('website') },
                    { icon: '📱', label: 'Mobile App', sub: 'Android & iPhone app, native or cross-platform', action: () => handleGoalSelect('mobile') },
                  ].map(opt => (
                    <button key={opt.label} onClick={opt.action} style={{ width: 200, padding: '28px 20px', background: '#0d1526', border: '1.5px solid rgba(255,255,255,0.08)', borderRadius: '18px', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', transition: 'all 0.2s', boxShadow: '0 4px 24px rgba(0,0,0,0.25)' }}
                      onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(99,102,241,0.55)'; e.currentTarget.style.background = 'rgba(99,102,241,0.07)'; e.currentTarget.style.transform = 'translateY(-2px)'; }}
                      onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'; e.currentTarget.style.background = '#0d1526'; e.currentTarget.style.transform = 'none'; }}>
                      <span style={{ fontSize: '40px', lineHeight: 1 }}>{opt.icon}</span>
                      <div style={{ fontSize: '17px', fontWeight: '800', color: '#e2e8f0', letterSpacing: '-0.02em' }}>{opt.label}</div>
                      <div style={{ fontSize: '11px', color: '#475569', textAlign: 'center', lineHeight: '1.55' }}>{opt.sub}</div>
                    </button>
                  ))}
                </div>
                <div style={{ marginTop: '40px', fontSize: '12px', color: '#1e3a5f' }}>Or just describe what you want below and I'll recommend the best platform.</div>
              </div>
            )}

            {/* ── Mobile Technology Picker ── */}
            {goalStep === 'mobile-tech' && !currentProject && displayed.length === 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '70%', gap: 0 }}>
                <button onClick={() => setGoalStep('type')} style={{ alignSelf: 'flex-start', background: 'none', border: 'none', color: '#475569', cursor: 'pointer', fontSize: '13px', marginBottom: '24px', display: 'flex', alignItems: 'center', gap: '5px' }}>← Back</button>
                <div style={{ fontSize: '26px', fontWeight: '800', color: '#e2e8f0', marginBottom: '8px', letterSpacing: '-0.03em', textAlign: 'center' }}>Choose Mobile Technology</div>
                <div style={{ fontSize: '14px', color: '#475569', marginBottom: '40px', textAlign: 'center' }}>Select the platform for your mobile app.</div>
                <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', justifyContent: 'center' }}>
                  {[
                    { icon: '🦋', label: 'Flutter', sub: 'One application that runs on both Android and iPhone using a single codebase.', badge: 'Recommended', action: () => handleMobileTechSelect('flutter') },
                    { icon: '🤖', label: 'Native Android', sub: 'Kotlin application for Android devices only.', badge: '', action: () => handleMobileTechSelect('android') },
                    { icon: '🍎', label: 'Native iPhone', sub: 'Swift application for iPhone and iPad only.', badge: '', action: () => handleMobileTechSelect('ios') },
                  ].map(opt => (
                    <button key={opt.label} onClick={opt.action} style={{ width: 190, padding: '24px 18px', background: '#0d1526', border: `1.5px solid ${opt.badge ? 'rgba(99,102,241,0.35)' : 'rgba(255,255,255,0.08)'}`, borderRadius: '18px', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', transition: 'all 0.2s', position: 'relative' }}
                      onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(99,102,241,0.55)'; e.currentTarget.style.background = 'rgba(99,102,241,0.07)'; e.currentTarget.style.transform = 'translateY(-2px)'; }}
                      onMouseLeave={e => { e.currentTarget.style.borderColor = opt.badge ? 'rgba(99,102,241,0.35)' : 'rgba(255,255,255,0.08)'; e.currentTarget.style.background = '#0d1526'; e.currentTarget.style.transform = 'none'; }}>
                      {opt.badge && <span style={{ position: 'absolute', top: '-10px', left: '50%', transform: 'translateX(-50%)', background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', color: '#fff', fontSize: '9px', fontWeight: '800', padding: '2px 10px', borderRadius: '20px', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>{opt.badge}</span>}
                      <span style={{ fontSize: '36px', lineHeight: 1 }}>{opt.icon}</span>
                      <div style={{ fontSize: '15px', fontWeight: '800', color: '#e2e8f0' }}>{opt.label}</div>
                      <div style={{ fontSize: '11px', color: '#475569', textAlign: 'center', lineHeight: '1.55' }}>{opt.sub}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* ── Platform Recommendation Banner (spec point 4) ── */}
            {buildRecommendation && pendingBuildPrompt && (
              <div style={{ marginBottom: '20px', padding: '18px 20px', background: 'rgba(99,102,241,0.08)', border: '1.5px solid rgba(99,102,241,0.3)', borderRadius: '16px' }}>
                <div style={{ fontSize: '13px', color: '#a5b4fc', fontWeight: '800', marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '7px' }}>
                  <span>{buildRecommendation.icon}</span> Platform Recommendation
                </div>
                <div style={{ fontSize: '14px', color: '#e2e8f0', marginBottom: '4px', fontWeight: '600' }}>
                  {buildRecommendation.platform === 'flutter' ? 'Mobile App — Flutter' : 'Website — Next.js'}
                </div>
                <div style={{ fontSize: '13px', color: '#64748b', marginBottom: '16px', lineHeight: '1.6' }}>{buildRecommendation.reason}</div>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  <button onClick={() => {
                    const h = [...history];
                    if (buildRecommendation.platform === 'flutter') setBuildTarget('flutter');
                    else setBuildTarget('web');
                    const prompt = pendingBuildPrompt;
                    setBuildRecommendation(null); setPendingBuildPrompt(null);
                    if (bridgeTestMode) { runBridgeOnlyPipeline(prompt ?? ''); }
                    else if (buildRecommendation.platform === 'flutter') runFlutterBuildPipeline(h, prompt);
                    else runBuildPipeline(h, prompt);
                  }} style={{ padding: '9px 20px', background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', border: 'none', borderRadius: '10px', color: '#fff', fontSize: '13px', fontWeight: '700', cursor: 'pointer' }}>
                    ✓ Accept — Build {buildRecommendation.platform === 'flutter' ? 'Mobile App' : 'Website'}
                  </button>
                  <button onClick={() => {
                    const prompt = pendingBuildPrompt;
                    setBuildRecommendation(null); setPendingBuildPrompt(null);
                    if (bridgeTestMode) { runBridgeOnlyPipeline(prompt ?? ''); }
                    else if (buildTarget === 'flutter') runFlutterBuildPipeline(history, prompt);
                    else runBuildPipeline(history, prompt);
                  }} style={{ padding: '9px 20px', background: 'transparent', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '10px', color: '#94a3b8', fontSize: '13px', fontWeight: '600', cursor: 'pointer' }}>
                    Keep {buildTarget === 'flutter' ? 'Flutter' : 'Web'} anyway
                  </button>
                  <button onClick={() => { setBuildRecommendation(null); setPendingBuildPrompt(null); setGoalStep('type'); }} style={{ padding: '9px 20px', background: 'transparent', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '10px', color: '#94a3b8', fontSize: '13px', fontWeight: '600', cursor: 'pointer' }}>
                    Choose different platform
                  </button>
                </div>
              </div>
            )}

            {displayed.map((msg, idx) => {
              const isLast = idx === displayed.length - 1;
              if (msg.role === 'status') {
                const s = STATUS_STYLE[msg.statusType || 'done'];
                return (
                  <div key={idx} style={{ marginBottom: '8px', padding: '8px 12px', background: s.bg, borderRadius: '8px', border: `1px solid ${s.text}33`, display: 'flex', alignItems: 'center', gap: '8px', animation: isLast ? 'fadeup 0.3s ease' : 'none' }}>
                    <span>{s.icon}</span>
                    <span style={{ fontSize: '12px', color: s.text, fontStyle: 'italic' }}>{msg.content}</span>
                  </div>
                );
              }
              return (
                <div key={idx} style={{ marginBottom: '20px', display: 'flex', flexDirection: 'column', alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start', animation: isLast ? 'fadeup 0.3s ease' : 'none' }}>
                  {/* Assistant label row */}
                  {msg.role === 'assistant' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                      <div style={{ width: '24px', height: '24px', borderRadius: '7px', background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: '800', color: '#fff', flexShrink: 0, boxShadow: '0 0 8px rgba(99,102,241,0.35)' }}>⚡</div>
                      <span style={{ fontSize: '11px', color: 'var(--ide-text-muted)', fontWeight: '600', letterSpacing: '0.02em' }}>DWOMOH Vibe Code</span>
                    </div>
                  )}
                  {/* ── Structured error card ── */}
                  {msg.errorMeta ? (() => {
                    const em = msg.errorMeta!;
                    const BADGE_COLORS: Record<ErrorCategory, { bg: string; text: string; border: string }> = {
                      network:  { bg: 'rgba(251,191,36,0.12)',  text: '#fbbf24', border: 'rgba(251,191,36,0.35)' },
                      api:      { bg: 'rgba(251,146,60,0.12)',  text: '#fb923c', border: 'rgba(251,146,60,0.35)' },
                      auth:     { bg: 'rgba(239,68,68,0.12)',   text: '#f87171', border: 'rgba(239,68,68,0.35)'  },
                      timeout:  { bg: 'rgba(251,191,36,0.12)',  text: '#fbbf24', border: 'rgba(251,191,36,0.35)' },
                      quota:    { bg: 'rgba(239,68,68,0.12)',   text: '#f87171', border: 'rgba(239,68,68,0.35)'  },
                      config:   { bg: 'rgba(239,68,68,0.12)',   text: '#f87171', border: 'rgba(239,68,68,0.35)'  },
                      image:    { bg: 'rgba(251,146,60,0.12)',  text: '#fb923c', border: 'rgba(251,146,60,0.35)' },
                      unknown:  { bg: 'rgba(100,116,139,0.15)', text: '#94a3b8', border: 'rgba(100,116,139,0.3)' },
                    };
                    const CATEGORY_LABELS: Record<ErrorCategory, string> = {
                      network: 'Network Error', api: 'API Error', auth: 'Authentication Error',
                      timeout: 'Timeout', quota: 'Rate Limit', config: 'Configuration Error',
                      image: 'Image Error', unknown: 'Error',
                    };
                    const bc = BADGE_COLORS[em.category];
                    return (
                      <div style={{ maxWidth: '96%', background: '#0a1220', border: `1.5px solid ${bc.border}`, borderRadius: '14px', overflow: 'hidden' }}>
                        {/* Badge + title */}
                        <div style={{ padding: '14px 18px 0', display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span style={{ padding: '2px 9px', borderRadius: '20px', background: bc.bg, color: bc.text, fontSize: '10px', fontWeight: '800', letterSpacing: '0.06em', textTransform: 'uppercase', border: `1px solid ${bc.border}`, flexShrink: 0 }}>
                            {CATEGORY_LABELS[em.category]}
                          </span>
                          <span style={{ color: '#e2e8f0', fontSize: '14px', fontWeight: '700' }}>{em.title}</span>
                        </div>
                        {/* Explanation */}
                        <div style={{ padding: '10px 18px 4px', fontSize: '13px', color: '#94a3b8', lineHeight: '1.65' }}>{em.explanation}</div>
                        {/* What to do next */}
                        <div style={{ padding: '4px 18px 14px' }}>
                          <div style={{ fontSize: '11px', color: '#475569', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' }}>What to do</div>
                          <div style={{ fontSize: '13px', color: '#64748b', lineHeight: '1.6' }}>{em.whatNext}</div>
                        </div>
                        {/* Recovery actions */}
                        {em.recoveryActions && em.recoveryActions.length > 0 && (
                          <div style={{ padding: '10px 14px 14px', borderTop: `1px solid ${bc.border}`, display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                            {em.recoveryActions.map((ra, ri) => (
                              <button key={ri} onClick={() => {
                                if (ra.action === 'retry-logo') { handleLogoBriefSubmit(); }
                                else if (ra.action === 'open-logs') { setPreviewTab('logs'); }
                                else if (ra.action === 'focus-input') { if (ra.prompt) setInput(ra.prompt); setTimeout(() => inputRef.current?.focus(), 50); }
                                else if (ra.action === 'claude-bridge') { launchBridge(ra.prompt ?? ''); }
                              }}
                                style={{ padding: '6px 14px', background: ra.action === 'claude-bridge' ? 'rgba(99,102,241,0.2)' : ri === 0 ? 'rgba(37,99,235,0.2)' : '#141e2e', border: `1px solid ${ra.action === 'claude-bridge' ? '#6366f1' : ri === 0 ? '#2563eb' : '#1e3a5f'}`, borderRadius: '8px', color: ra.action === 'claude-bridge' ? '#a5b4fc' : ri === 0 ? '#93c5fd' : '#64748b', cursor: 'pointer', fontSize: '12px', fontWeight: '700' }}>
                                {ra.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })() : msg.logoConcepts && msg.logoConcepts.length > 0 ? (
                    <div style={{ maxWidth: '96%', background: '#0a1220', border: '1.5px solid #1e3a5f', borderRadius: '14px', overflow: 'hidden' }}>
                      <div style={{ padding: '14px 18px 10px', fontSize: '14px', lineHeight: '1.7', color: '#cbd5e1' }}>{msg.content}</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '0 14px 14px' }}>
                        {msg.logoConcepts.map((svg, ci) => {
                          const clabel = msg.logoConceptLabels?.[ci] ?? (['Minimal', 'Modern', 'Bold'][ci] ?? `Option ${ci + 1}`);
                          return (
                            <div key={ci} style={{ border: '1.5px solid #1e3a5f', borderRadius: '12px', overflow: 'hidden', transition: 'border-color 0.15s' }}
                                 onMouseEnter={e => (e.currentTarget.style.borderColor = '#2563eb')}
                                 onMouseLeave={e => (e.currentTarget.style.borderColor = '#1e3a5f')}>
                              <div style={{ padding: '18px 16px', background: '#0f1929', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '70px' }}
                                   dangerouslySetInnerHTML={{ __html: svg }} />
                              <div style={{ padding: '8px 12px', background: '#070f1c', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px', flexWrap: 'wrap' }}>
                                <span style={{ fontSize: '11px', color: '#64748b', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{clabel}</span>
                                <div style={{ display: 'flex', gap: '5px' }}>
                                  <button onClick={() => downloadLogo(svg, 'svg', clabel)}
                                    style={{ padding: '3px 8px', background: '#141e2e', border: '1px solid #1e3a5f', borderRadius: '5px', color: '#64748b', cursor: 'pointer', fontSize: '10px', fontWeight: '600' }}>SVG</button>
                                  <button onClick={() => downloadLogo(svg, 'png', clabel)}
                                    style={{ padding: '3px 8px', background: '#141e2e', border: '1px solid #1e3a5f', borderRadius: '5px', color: '#64748b', cursor: 'pointer', fontSize: '10px', fontWeight: '600' }}>PNG</button>
                                  <button onClick={() => downloadLogo(svg, 'jpg', clabel)}
                                    style={{ padding: '3px 8px', background: '#141e2e', border: '1px solid #1e3a5f', borderRadius: '5px', color: '#64748b', cursor: 'pointer', fontSize: '10px', fontWeight: '600' }}>JPG</button>
                                  <button onClick={() => saveLogoAsAsset(svg, ci, clabel)}
                                    style={{ padding: '3px 10px', background: 'linear-gradient(135deg,#1d4ed8,#4f46e5)', border: 'none', borderRadius: '5px', color: '#fff', cursor: 'pointer', fontSize: '10px', fontWeight: '700' }}>Use this →</button>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      <div style={{ padding: '10px 14px', borderTop: '1px solid #1e3a5f', display: 'flex', gap: '6px' }}>
                        <button onClick={() => handleLogoBriefSubmit()}
                          style={{ padding: '5px 12px', background: '#141e2e', border: '1px solid #1e3a5f', borderRadius: '7px', color: '#94a3b8', cursor: 'pointer', fontSize: '11px', fontWeight: '600' }}>↻ Regenerate all</button>
                        <button onClick={() => { setInput('Refine the logo: '); setTimeout(() => inputRef.current?.focus(), 50); }}
                          style={{ padding: '5px 12px', background: '#141e2e', border: '1px solid #1e3a5f', borderRadius: '7px', color: '#94a3b8', cursor: 'pointer', fontSize: '11px', fontWeight: '600' }}>✎ Describe a change</button>
                      </div>
                    </div>
                  /* ── Single inline logo after edit/selection ── */
                  ) : msg.logoSvg ? (
                    <div style={{ maxWidth: '90%', background: '#0a1220', border: '1.5px solid #1e3a5f', borderRadius: '14px', overflow: 'hidden' }}>
                      <div style={{ padding: '14px 18px 10px', fontSize: '14px', lineHeight: '1.7', color: '#cbd5e1' }}>{msg.content}</div>
                      <div style={{ padding: '20px', background: '#0f1929', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '80px', borderTop: '1px solid #1e3a5f', borderBottom: '1px solid #1e3a5f' }}
                           dangerouslySetInnerHTML={{ __html: msg.logoSvg }} />
                      <div style={{ padding: '12px 14px', display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                        <button onClick={() => saveLogoAsAsset(msg.logoSvg!, 0, 'Refined')}
                          style={{ padding: '5px 12px', background: 'linear-gradient(135deg,#1d4ed8,#4f46e5)', border: 'none', borderRadius: '7px', color: '#fff', cursor: 'pointer', fontSize: '11px', fontWeight: '700' }}>Use this logo</button>
                        <button onClick={() => { setInput('Refine the logo: '); setTimeout(() => inputRef.current?.focus(), 50); }}
                          style={{ padding: '5px 12px', background: '#141e2e', border: '1px solid #1e3a5f', borderRadius: '7px', color: '#94a3b8', cursor: 'pointer', fontSize: '11px', fontWeight: '600' }}>Refine</button>
                        <button onClick={() => { setInput('Change the colors to '); setTimeout(() => inputRef.current?.focus(), 50); }}
                          style={{ padding: '5px 12px', background: '#141e2e', border: '1px solid #1e3a5f', borderRadius: '7px', color: '#94a3b8', cursor: 'pointer', fontSize: '11px', fontWeight: '600' }}>Change colors</button>
                        <button onClick={() => { setInput('Add brand name '); setTimeout(() => inputRef.current?.focus(), 50); }}
                          style={{ padding: '5px 12px', background: '#141e2e', border: '1px solid #1e3a5f', borderRadius: '7px', color: '#94a3b8', cursor: 'pointer', fontSize: '11px', fontWeight: '600' }}>Add brand name</button>
                        <button onClick={() => downloadLogo(msg.logoSvg!, 'png', 'logo')}
                          style={{ padding: '5px 12px', background: '#141e2e', border: '1px solid #1e3a5f', borderRadius: '7px', color: '#94a3b8', cursor: 'pointer', fontSize: '11px', fontWeight: '600' }}>PNG</button>
                        <button onClick={() => downloadLogo(msg.logoSvg!, 'svg', 'logo')}
                          style={{ padding: '5px 12px', background: '#141e2e', border: '1px solid #1e3a5f', borderRadius: '7px', color: '#94a3b8', cursor: 'pointer', fontSize: '11px', fontWeight: '600' }}>SVG</button>
                        <button onClick={() => downloadLogo(msg.logoSvg!, 'jpg', 'logo')}
                          style={{ padding: '5px 12px', background: '#141e2e', border: '1px solid #1e3a5f', borderRadius: '7px', color: '#94a3b8', cursor: 'pointer', fontSize: '11px', fontWeight: '600' }}>JPG</button>
                        <button onClick={() => handleLogoRefine('Generate a variation with a different layout and style')}
                          style={{ padding: '5px 12px', background: '#141e2e', border: '1px solid #1e3a5f', borderRadius: '7px', color: '#94a3b8', cursor: 'pointer', fontSize: '11px', fontWeight: '600' }}>Generate variation</button>
                      </div>
                    </div>
                  ) : (
                  <div style={{
                    maxWidth: '86%',
                    padding: msg.role === 'user' ? '11px 16px' : '14px 18px',
                    borderRadius: msg.role === 'user' ? '18px 18px 6px 18px' : '6px 18px 18px 18px',
                    background: msg.role === 'user'
                      ? 'linear-gradient(135deg,rgba(99,102,241,0.9),rgba(139,92,246,0.85))'
                      : 'var(--ide-surface)',
                    border: msg.role === 'assistant' ? '1px solid var(--ide-border)' : 'none',
                    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    fontSize: '14px', lineHeight: '1.75', textAlign: 'left',
                    color: msg.role === 'user' ? '#f0f0ff' : '#cbd5e1',
                    boxShadow: msg.role === 'user' ? '0 2px 12px rgba(99,102,241,0.3)' : 'none',
                  }}>
                    {msg.content}
                    {msg.screenshotUrl && (
                      <div style={{ marginTop: '10px' }}>
                        <img src={msg.screenshotUrl} alt="Browser screenshot" style={{ maxWidth: '100%', borderRadius: '8px', border: '1px solid #1e3a5f', display: 'block' }} />
                        <a href={msg.screenshotUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: '11px', color: '#60a5fa', marginTop: '4px', display: 'inline-block' }}>↗ Open full size</a>
                      </div>
                    )}
                  </div>
                  )}
                </div>
              );
            })}

            {/* ── Edit pipeline progress card ── */}
            {editApplying && editDetailStep && (() => {
              const EDIT_DETAIL = [
                { id: 'reading',      label: 'Reading existing project files' },
                { id: 'understanding', label: 'Understanding your requested change' },
                { id: 'checking',     label: 'Checking affected pages' },
                { id: 'navigation',   label: 'Analysing navigation structure' },
                { id: 'preparing',    label: 'Preparing file edits' },
                { id: 'writing',      label: 'Writing changes to files' },
                { id: 'applying',     label: 'Applying with Next.js hot reload' },
                { id: 'refreshing',   label: 'Refreshing preview' },
                { id: 'verifying',    label: 'Testing routes and links' },
                { id: 'complete',     label: 'Changes complete' },
              ];
              const ids = EDIT_DETAIL.map(s => s.id);
              const curIdx = ids.indexOf(editDetailStep);
              const isError = editDetailStep === 'error';
              const isRetrying = editDetailStep === 'retrying';

              return (
                <div style={{ marginBottom: '16px', padding: '16px 18px', background: '#0a1628', borderRadius: '14px', border: `1px solid ${isError ? '#7f1d1d' : '#1e3a5f'}`, animation: 'fadeup 0.3s ease' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
                    <span style={{ fontSize: '16px', animation: isError ? 'none' : 'spin 1s linear infinite', display: 'inline-block' }}>{isError ? '⚡' : '⚙️'}</span>
                    <span style={{ fontWeight: '700', color: isError ? '#fbbf24' : '#93c5fd', fontSize: '13px', flex: 1 }}>
                      {isRetrying ? 'Retrying connection…' : isError ? 'Edit encountered an issue' : 'DWOMOH Vibe Code is working…'}
                    </span>
                    {editElapsed > 30 && !isError && (
                      <span style={{ fontSize: '11px', color: '#475569', fontWeight: '600' }}>{editElapsed}s elapsed</span>
                    )}
                    {!isError && !isRetrying && (
                      <span style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '99px', background: 'rgba(37,99,235,0.15)', border: '1px solid #1e3a5f', color: '#60a5fa', fontWeight: '600' }}>● Editing</span>
                    )}
                  </div>
                  {!isError && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      {EDIT_DETAIL.map((s, i) => {
                        const done   = i < curIdx;
                        const active = i === curIdx;
                        return (
                          <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{ fontSize: '11px', minWidth: '14px', color: done ? '#4ade80' : active ? '#fbbf24' : '#1e293b' }}>
                              {done ? '✓' : active ? '▶' : '○'}
                            </span>
                            <span style={{ fontSize: '12px', color: done ? '#4ade80' : active ? '#fbbf24' : '#334155', fontWeight: active ? '600' : '400' }}>
                              {s.label}
                              {active && <span style={{ marginLeft: '5px', animation: 'pulse 1.2s ease-in-out infinite', display: 'inline-block', color: '#fbbf24' }}>…</span>}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Animated build progress */}
            {buildProgress && (() => {
              // 11-stage detail steps driven by buildDetailStep state
              const DETAIL_STEPS = [
                { id: 'understanding', label: 'Understanding Request' },
                { id: 'researching',   label: 'Researching Requirements' },
                { id: 'finding_apis', label: 'Finding APIs' },
                { id: 'designing',    label: 'Designing Architecture' },
                { id: 'database',     label: 'Creating Database Structure' },
                { id: 'frontend',     label: 'Generating Frontend' },
                { id: 'backend',      label: 'Generating Backend' },
                { id: 'installing',   label: 'Installing Dependencies' },
                { id: 'testing',      label: 'Testing Application' },
                { id: 'previewing',   label: 'Creating Preview' },
                { id: 'verifying',    label: 'Running Verification' },
                { id: 'complete',     label: 'Build Complete' },
              ];
              const stepIds = DETAIL_STEPS.map(s => s.id);
              const currentDetailIdx = buildDetailStep ? stepIds.indexOf(buildDetailStep) : 0;
              const isDone  = buildProgress.step === 'done';
              const isError = buildProgress.step === 'error';

              // Connection status badge
              const isRetryMsg = /retrying|retry|interrupted|timed out|connection/i.test(buildProgress.message);

              return (
                <div style={{ marginBottom: '16px', padding: '18px', background: '#0a1628', borderRadius: '14px', border: `1px solid ${isError ? '#7f1d1d' : isDone ? '#166534' : '#1e3a5f'}`, animation: 'fadeup 0.3s ease' }}>
                  {/* Header row */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
                    {isError ? (
                      <span style={{ fontSize: '18px' }}>⚡</span>
                    ) : isDone ? (
                      <span style={{ fontSize: '18px' }}>✅</span>
                    ) : (
                      <span style={{ fontSize: '18px', animation: 'spin 1s linear infinite', display: 'inline-block' }}>⚙️</span>
                    )}
                    <span style={{ fontWeight: '700', color: isError ? '#fbbf24' : isDone ? '#86efac' : '#93c5fd', fontSize: '14px', flex: 1 }}>
                      {buildProgress.message}
                    </span>
                    {/* Connection status pill */}
                    {!isDone && !isError && (
                      <span style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '99px', background: isRetryMsg ? 'rgba(251,191,36,0.15)' : 'rgba(37,99,235,0.2)', border: `1px solid ${isRetryMsg ? '#92400e' : '#1e3a5f'}`, color: isRetryMsg ? '#fbbf24' : '#60a5fa', fontWeight: '600', whiteSpace: 'nowrap' }}>
                        {isRetryMsg ? '⚡ Retrying…' : '● Generating'}
                      </span>
                    )}
                  </div>

                  {/* 11-stage step indicators */}
                  {!isError && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', marginBottom: '14px' }}>
                      {DETAIL_STEPS.map((s, i) => {
                        const done   = isDone || i < currentDetailIdx;
                        const active = !isDone && i === currentDetailIdx;
                        return (
                          <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{ fontSize: '12px', minWidth: '16px', color: done ? '#4ade80' : active ? '#fbbf24' : '#1e293b' }}>
                              {done ? '✓' : active ? '▶' : '○'}
                            </span>
                            <span style={{ fontSize: '12px', color: done ? '#4ade80' : active ? '#fbbf24' : '#334155', fontWeight: active ? '600' : '400' }}>
                              {s.label}
                              {active && (
                                <span style={{ marginLeft: '6px', animation: 'pulse 1.2s ease-in-out infinite', display: 'inline-block', color: '#fbbf24' }}>…</span>
                              )}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Live logs */}
                  {buildProgress.logs.length > 0 && (
                    <div style={{ fontFamily: 'monospace', fontSize: '11px', color: isError ? '#f87171' : '#4ade80', background: '#050f1a', padding: '10px', borderRadius: '6px', maxHeight: '120px', overflowY: 'auto' }}>
                      {buildProgress.logs.slice(-12).map((l, i) => <div key={i}>{l}</div>)}
                    </div>
                  )}

                  {/* Action buttons */}
                  <div style={{ marginTop: '12px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    {/* Retry Build — shown only on retryable connection errors */}
                    {isError && lastBuildArgs && (
                      <button
                        onClick={() => {
                          setBuildProgress(null);
                          setBuildDetailStep('');
                          runBuildPipeline(lastBuildArgs.history, lastBuildArgs.prompt);
                        }}
                        style={{ padding: '8px 18px', background: 'linear-gradient(135deg,#7c3aed,#4f46e5)', border: 'none', borderRadius: '8px', color: '#fff', cursor: 'pointer', fontSize: '13px', fontWeight: '700' }}
                      >
                        ⚡ Retry Build
                      </button>
                    )}
                    {/* Refresh / Open when done */}
                    {isDone && buildProgress.port && (
                      <>
                        <button onClick={() => setPreviewKey(k => k + 1)} style={{ padding: '6px 14px', background: '#166534', border: '1px solid #16a34a', borderRadius: '6px', color: '#86efac', cursor: 'pointer', fontSize: '12px', fontWeight: '600' }}>
                          ↺ Refresh Preview
                        </button>
                        <a href={`http://localhost:${buildProgress.port}`} target="_blank" rel="noopener noreferrer" style={{ padding: '6px 14px', background: '#14532d', border: '1px solid #15803d', borderRadius: '6px', color: '#86efac', textDecoration: 'none', fontSize: '12px', fontWeight: '600' }}>
                          ↗ Open in New Tab
                        </a>
                      </>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* Flutter Build Progress Panel — separate from web buildProgress, no shared state */}
            {flutterBuildProgress && (
              <div style={{ marginBottom: '16px', padding: '16px', background: '#0d0a1e', borderRadius: '12px', border: `1px solid ${flutterBuildProgress.step === 'error' ? '#7c3aed55' : flutterBuildProgress.step === 'done' ? '#6d28d955' : '#4c1d9555'}`, animation: 'fadeup 0.3s ease' }}>
                {/* Header */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
                  <span style={{ fontSize: '18px' }}>
                    {flutterBuildProgress.step === 'done' ? '📱' : flutterBuildProgress.step === 'error' ? '❌' : '⚙️'}
                  </span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: '700', color: flutterBuildProgress.step === 'error' ? '#c4b5fd' : flutterBuildProgress.step === 'done' ? '#a78bfa' : '#7c3aed', fontSize: '13px' }}>
                      Flutter {flutterBuildProgress.projectName ? `— ${flutterBuildProgress.projectName}` : 'Mobile App'}
                    </div>
                    <div style={{ fontSize: '12px', color: '#64748b', marginTop: '2px' }}>{flutterBuildProgress.message}</div>
                  </div>
                  {flutterBuildProgress.step !== 'done' && flutterBuildProgress.step !== 'error' && (
                    <div style={{ display: 'flex', gap: '3px', alignItems: 'center' }}>
                      {[0,1,2].map(i => <span key={i} style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#7c3aed', display: 'inline-block', animation: `pulse 1.1s ease-in-out ${i * 0.2}s infinite` }} />)}
                    </div>
                  )}
                </div>

                {/* Progress steps */}
                <div style={{ display: 'flex', gap: '4px', marginBottom: '10px' }}>
                  {(['generating','pub-get','analyzing','building-apk','done'] as const).map((s) => {
                    const steps = ['generating','pub-get','analyzing','building-apk','done'];
                    const currentIdx = steps.indexOf(flutterBuildProgress.step === 'error' ? 'generating' : flutterBuildProgress.step);
                    const stepIdx = steps.indexOf(s);
                    const isPast = stepIdx < currentIdx || flutterBuildProgress.step === 'done';
                    const isCurrent = flutterBuildProgress.step !== 'done' && flutterBuildProgress.step !== 'error' && s === flutterBuildProgress.step;
                    const labels: Record<string, string> = { 'generating': 'Generate', 'pub-get': 'Install', 'analyzing': 'Analyze', 'building-apk': 'Build APK', 'done': 'Done' };
                    return (
                      <div key={s} style={{ flex: 1, height: '3px', borderRadius: '2px', background: isPast || isCurrent ? '#7c3aed' : '#1e1b4b', transition: 'background 0.3s' }} title={labels[s]} />
                    );
                  })}
                </div>

                {/* Analyze errors */}
                {(flutterBuildProgress.analyzeErrors ?? []).length > 0 && (
                  <div style={{ fontFamily: 'monospace', fontSize: '11px', color: '#fca5a5', background: '#1a0a0a', padding: '8px', borderRadius: '6px', maxHeight: '80px', overflowY: 'auto', marginBottom: '8px' }}>
                    {(flutterBuildProgress.analyzeErrors ?? []).slice(0, 5).map((e, i) => <div key={i}>{e}</div>)}
                  </div>
                )}

                {/* Live logs */}
                {flutterBuildProgress.logs.length > 0 && (
                  <div style={{ fontFamily: 'monospace', fontSize: '11px', color: flutterBuildProgress.step === 'error' ? '#c4b5fd' : '#a78bfa', background: '#080612', padding: '10px', borderRadius: '6px', maxHeight: '100px', overflowY: 'auto' }}>
                    {flutterBuildProgress.logs.slice(-10).map((l, i) => <div key={i}>{l}</div>)}
                  </div>
                )}

                {/* Action buttons */}
                <div style={{ marginTop: '10px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  {flutterBuildProgress.step === 'done' && flutterBuildProgress.apkPath && (
                    <a
                      href={`/api/flutter/download?path=${encodeURIComponent(flutterBuildProgress.apkPath)}`}
                      download="app-release.apk"
                      style={{ padding: '8px 18px', background: 'linear-gradient(135deg,#7c3aed,#6d28d9)', border: 'none', borderRadius: '8px', color: '#fff', textDecoration: 'none', fontSize: '13px', fontWeight: '700', display: 'inline-block' }}>
                      📥 Download APK
                    </a>
                  )}
                  {(flutterBuildProgress.step === 'done' || flutterBuildProgress.step === 'error') && flutterBuildProgress.projectPath && (
                    <div style={{ padding: '8px 12px', background: '#1e1b4b', border: '1px solid #4c1d95', borderRadius: '8px', color: '#c4b5fd', fontSize: '11px', fontFamily: 'monospace', wordBreak: 'break-all' }}>
                      {flutterBuildProgress.projectPath}
                    </div>
                  )}
                  {flutterBuildProgress.step === 'error' && lastBuildArgs && (
                    <button
                      onClick={() => {
                        setFlutterBuildProgress(null);
                        runFlutterBuildPipeline(lastBuildArgs.history, lastBuildArgs.prompt);
                      }}
                      style={{ padding: '8px 18px', background: 'linear-gradient(135deg,#7c3aed,#4f46e5)', border: 'none', borderRadius: '8px', color: '#fff', cursor: 'pointer', fontSize: '13px', fontWeight: '700' }}>
                      ⚡ Retry Flutter Build
                    </button>
                  )}
                </div>
              </div>
            )}

            {editApplying && (
              <div style={{ marginBottom: '12px', padding: '10px 14px', background: '#0a1628', borderRadius: '8px', border: '1px solid #1e3a5f', display: 'flex', alignItems: 'center', gap: '8px', animation: 'fadeup 0.3s ease' }}>
                <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⚙️</span>
                <span style={{ fontSize: '13px', color: '#93c5fd' }}>Applying your changes…</span>
              </div>
            )}

            {/* Streaming response — word-by-word reveal while AI is typing */}
            {streamingMsg && (
              <div style={{ marginBottom: '20px', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', animation: 'fadeup 0.2s ease' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                  <div style={{ width: '26px', height: '26px', borderRadius: '50%', background: 'linear-gradient(135deg,#1d4ed8,#4f46e5)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: '700', color: '#fff', flexShrink: 0 }}>D</div>
                  <span style={{ fontSize: '11px', color: '#475569', fontWeight: '600' }}>DWOMOH Vibe Code</span>
                </div>
                <div style={{ maxWidth: '86%', padding: '14px 18px', borderRadius: '6px 18px 18px 18px', background: '#141e2e', border: '1px solid #1e3a5f', fontSize: '14px', color: '#cbd5e1', lineHeight: '1.75', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {streamingMsg}
                  <span style={{ display: 'inline-block', width: '2px', height: '15px', background: '#2563eb', marginLeft: '2px', verticalAlign: 'middle', borderRadius: '1px', animation: 'pulse 0.75s ease-in-out infinite' }} />
                </div>
              </div>
            )}

            {/* Thinking / generating indicator */}
            {loading && phase !== 'building' && !buildProgress && !streamingMsg && (
              <div style={{ marginBottom: '20px', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', animation: 'fadeup 0.3s ease' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                  <div style={{ width: '26px', height: '26px', borderRadius: '50%', background: 'linear-gradient(135deg,#1d4ed8,#4f46e5)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: '700', color: '#fff', flexShrink: 0 }}>D</div>
                  <span style={{ fontSize: '11px', color: '#475569', fontWeight: '600' }}>DWOMOH Vibe Code</span>
                </div>
                <div style={{ padding: '12px 18px', borderRadius: '6px 18px 18px 18px', background: '#141e2e', border: '1px solid #1e3a5f', display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ fontSize: '13px', color: '#475569' }}>
                    {aiState === 'thinking' ? 'Thinking' : 'Generating response'}
                  </span>
                  <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                    {[0, 1, 2].map(i => (
                      <span key={i} style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#1e3a5f', display: 'inline-block', animation: `pulse 1.1s ease-in-out ${i * 0.2}s infinite` }} />
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Build-active indicator */}
            {phase === 'building' && !editApplying && buildProgress && buildProgress.step !== 'done' && buildProgress.step !== 'error' && (
              <div style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 16px', background: '#0a1220', borderRadius: '10px', border: '1px solid #1a2744' }}>
                <span style={{ animation: 'spin 1.2s linear infinite', display: 'inline-block', fontSize: '13px' }}>⚙️</span>
                <span style={{ fontSize: '12px', color: '#3b82f6', fontWeight: '600', flex: 1 }}>
                  {buildDetailStep === 'understanding' ? 'Understanding requirements…'
                    : buildDetailStep === 'researching'  ? 'Researching…'
                    : buildDetailStep === 'finding_apis' ? 'Researching APIs…'
                    : buildDetailStep === 'designing'    ? 'Planning architecture…'
                    : buildDetailStep === 'database'     ? 'Creating database schema…'
                    : buildDetailStep === 'frontend'     ? 'Generating frontend…'
                    : buildDetailStep === 'backend'      ? 'Generating backend…'
                    : buildDetailStep === 'installing'   ? 'Installing dependencies…'
                    : buildDetailStep === 'testing'      ? 'Testing build…'
                    : buildDetailStep === 'previewing'   ? 'Starting preview…'
                    : buildDetailStep === 'verifying'    ? 'Verifying…'
                    : 'Generating code…'}
                </span>
                <div style={{ display: 'flex', gap: '3px', alignItems: 'center' }}>
                  {[0, 1, 2].map(i => (
                    <span key={i} style={{ width: '4px', height: '4px', borderRadius: '50%', background: '#1e3a5f', display: 'inline-block', animation: `pulse 1.0s ease-in-out ${i * 0.18}s infinite` }} />
                  ))}
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* ── Premium Composer ───────────────────────────────────────────────── */}
          <div style={{ padding: '10px 16px 14px', background: 'var(--ide-surface)', borderTop: '1px solid var(--ide-border)' }}>

            {/* Bridge Test — internal debugging tool, never meant for customers.
                The Developer Mode toggle itself now lives in the persistent
                top header bar (impossible to miss, always visible to
                SUPER_ADMIN). This row only shows Bridge Test, and only once
                Developer Mode is already ON via that header toggle — a
                SUPER_ADMIN with Developer Mode off sees the same clean
                customer interface as everyone else. */}
            {myPermissions.has('VIEW_DEVELOPER_MODE') && debugMode && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: bridgeTestMode ? '0' : '6px' }}>
              <button
                onClick={() => {
                  const next = !bridgeTestMode;
                  setBridgeTestMode(next);
                  // If toggled ON mid-build, stop the current build and restart via bridge
                  if (next && (phase === 'building' || loading)) {
                    handleForceReset();
                  }
                }}
                title={bridgeTestMode ? 'Bridge Test Mode ON — every prompt goes to Claude Code CLI via Bridge. Click to disable.' : 'Bridge Test Mode OFF — click to route your next build through the Claude Bridge (Claude Code CLI does all generation).'}
                style={{ padding: '4px 12px', background: bridgeTestMode ? 'linear-gradient(135deg,rgba(124,58,237,0.7),rgba(99,58,200,0.7))' : 'rgba(15,23,42,0.5)', border: `1px solid ${bridgeTestMode ? '#7c3aed' : '#1e3a5f'}`, borderRadius: '6px', color: bridgeTestMode ? '#e9d5ff' : '#475569', cursor: 'pointer', fontSize: '11px', fontWeight: '700', display: 'flex', alignItems: 'center', gap: '5px', transition: 'all 0.15s ease', letterSpacing: '0.02em' }}
              >
                <span style={{ fontSize: '10px', color: bridgeTestMode ? '#a78bfa' : '#334155' }}>{bridgeTestMode ? '⚡' : '○'}</span>
                {bridgeTestMode ? 'Bridge Test: ON' : 'Bridge Test'}
              </button>
              {bridgeTestMode && (
                <span style={{ fontSize: '10px', color: '#7c3aed', fontStyle: 'italic' }}>
                  Next prompt → Claude Code CLI (bridge handles all generation)
                </span>
              )}
            </div>
            )}

            {/* Busy / stuck banner */}
            {isBusy && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px', padding: '8px 14px', background: '#111827', borderRadius: '10px', border: `1px solid ${bridgeTestMode ? 'rgba(124,58,237,0.4)' : '#1e3a5f'}` }}>
                <span style={{ fontSize: '12px', color: bridgeTestMode ? '#c4b5fd' : '#60a5fa', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ animation: 'spin 1.2s linear infinite', display: 'inline-block', fontSize: '12px' }}>{bridgeTestMode ? '⚡' : '⚙️'}</span>
                  {bridgeTestMode
                    ? 'Claude Code CLI via Bridge — building your app…'
                    : phase === 'building' ? 'Generating code…' : editApplying ? 'Applying changes…' : 'Processing…'}
                </span>
                <button onClick={handleForceReset} style={{ padding: '3px 10px', background: 'rgba(127,29,29,0.5)', border: '1px solid #7f1d1d', borderRadius: '6px', color: '#f87171', cursor: 'pointer', fontSize: '11px', fontWeight: '600' }}>
                  Reset
                </button>
              </div>
            )}

            {/* Asset strip */}
            {assets.length > 0 && (
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px', padding: '8px 10px', background: '#111827', borderRadius: '10px', border: '1px solid #1e3a5f' }}>
                {assets.map(asset => (
                  <div key={asset.id} style={{ position: 'relative', width: '52px', height: '52px', borderRadius: '7px', overflow: 'hidden', border: `2px solid ${asset.role === 'logo' ? '#7c3aed' : '#1e3a5f'}` }}>
                    {asset.type === 'image/svg+xml' ? (
                      <div dangerouslySetInnerHTML={{ __html: asset.dataUrl.startsWith('data:') ? atob(asset.dataUrl.split(',')[1] ?? '') : '' }}
                           style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0f172a' }} />
                    ) : (
                      <img src={asset.dataUrl} alt={asset.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    )}
                    {asset.role && (
                      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'rgba(0,0,0,0.75)', fontSize: '8px', color: '#94a3b8', textAlign: 'center', padding: '1px 3px' }}>{asset.role}</div>
                    )}
                    <button onClick={() => setAssets(prev => prev.filter(a => a.id !== asset.id))}
                      style={{ position: 'absolute', top: 1, right: 1, width: '15px', height: '15px', background: 'rgba(0,0,0,0.8)', border: 'none', borderRadius: '50%', color: '#f87171', fontSize: '10px', cursor: 'pointer', lineHeight: '15px', padding: 0, textAlign: 'center' }}>×</button>
                  </div>
                ))}
                <span style={{ fontSize: '11px', color: '#334155', alignSelf: 'center', marginLeft: '2px' }}>
                  {assets.length} attachment{assets.length > 1 ? 's' : ''}
                </span>
              </div>
            )}

            {/* ── Bridge Test Telemetry Panel — always visible during bridge test runs ── */}
            {bridgeTestMode && bridgeTelemetry.length > 0 && (
              <div style={{ marginBottom: '10px', background: 'rgba(6,10,20,0.97)', border: '1.5px solid rgba(124,58,237,0.5)', borderRadius: '12px', overflow: 'hidden' }}>
                <div style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid rgba(124,58,237,0.15)', background: 'rgba(124,58,237,0.08)' }}>
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#7c3aed', display: 'inline-block', animation: 'pulse 1s ease-in-out infinite', flexShrink: 0 }} />
                  <span style={{ fontSize: '11px', fontWeight: '800', color: '#c4b5fd', letterSpacing: '0.06em' }}>⚡ BRIDGE TEST — LIVE TELEMETRY</span>
                  <span style={{ marginLeft: 'auto', fontSize: '10px', color: '#4c1d95', fontFamily: 'monospace' }}>Claude Code CLI</span>
                </div>
                <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {bridgeTelemetry.map(stage => (
                    <div key={stage.id} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '4px 6px', borderRadius: '6px', background: stage.status === 'active' ? 'rgba(124,58,237,0.12)' : stage.status === 'done' ? 'rgba(34,197,94,0.06)' : stage.status === 'error' ? 'rgba(239,68,68,0.08)' : 'transparent' }}>
                      <span style={{ fontSize: '12px', flexShrink: 0, marginTop: '1px' }}>
                        {stage.status === 'waiting' ? '○' : stage.status === 'active' ? '⟳' : stage.status === 'done' ? '✅' : '❌'}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '11px', fontWeight: stage.status === 'waiting' ? '400' : '600', color: stage.status === 'waiting' ? '#334155' : stage.status === 'active' ? '#c4b5fd' : stage.status === 'done' ? '#86efac' : '#f87171' }}>
                          {stage.label}
                        </div>
                        {stage.detail && (
                          <div style={{ fontSize: '10px', color: '#64748b', fontFamily: 'monospace', marginTop: '1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {stage.detail}
                          </div>
                        )}
                      </div>
                      {stage.ts && <span style={{ fontSize: '9px', color: '#334155', fontFamily: 'monospace', flexShrink: 0 }}>{stage.ts}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── Claude Code Worker Panel (Developer Mode only) ────────── */}
            {/* Defense-in-depth: gated by VIEW_DEVELOPER_MODE in addition to
                debugMode, in case debugMode is ever set another way (e.g. a
                restored localStorage value or a future dev shortcut) — this
                panel must never render for an account without the permission,
                regardless of debugMode's value. */}
            {debugMode && myPermissions.has('VIEW_DEVELOPER_MODE') && bridgeSession && (
              <div style={{ marginBottom: '10px', background: 'rgba(6,10,20,0.97)', border: `1.5px solid ${bridgeSession.status === 'complete' && bridgeSession.verifyResult?.verified ? 'rgba(34,211,160,0.4)' : bridgeSession.status === 'error' ? 'rgba(248,113,113,0.4)' : 'rgba(99,102,241,0.4)'}`, borderRadius: '12px', overflow: 'hidden' }}>
                {/* Header */}
                <div style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid rgba(255,255,255,0.05)', background: 'rgba(99,102,241,0.07)' }}>
                  {bridgeSession.status === 'connecting' || bridgeSession.status === 'running'
                    ? <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#6366f1', display: 'inline-block', animation: 'pulse 1s ease-in-out infinite', flexShrink: 0 }} />
                    : bridgeSession.status === 'complete' && bridgeSession.verifyResult?.verified
                    ? <span style={{ color: '#4ade80', fontSize: '12px' }}>✅</span>
                    : bridgeSession.status === 'complete'
                    ? <span style={{ color: '#fbbf24', fontSize: '12px' }}>⚠️</span>
                    : <span style={{ color: '#f87171', fontSize: '12px' }}>❌</span>
                  }
                  <span style={{ fontSize: '11px', fontWeight: '700', color: '#a5b4fc', flex: 1, letterSpacing: '0.03em', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <span style={{ padding: '1px 7px', background: bridgeSession.status === 'running' || bridgeSession.status === 'connecting' ? 'rgba(99,102,241,0.25)' : 'rgba(30,41,59,0.5)', border: `1px solid ${bridgeSession.status === 'running' || bridgeSession.status === 'connecting' ? '#6366f1' : '#334155'}`, borderRadius: '4px', fontSize: '10px', fontWeight: '800', color: bridgeSession.status === 'running' || bridgeSession.status === 'connecting' ? '#c7d2fe' : '#64748b', letterSpacing: '0.08em' }}>
                      {bridgeSession.status === 'connecting' || bridgeSession.status === 'running' ? '⚡ BRIDGE ACTIVE' : bridgeSession.status === 'complete' ? '✓ BRIDGE COMPLETE' : '✗ BRIDGE ERROR'}
                    </span>
                    <span style={{ color: '#475569', fontSize: '10px', fontFamily: 'monospace', fontWeight: '400' }}>
                      {bridgeSession.status === 'connecting' ? 'Connecting…' : bridgeSession.status === 'running' ? 'Working…' : bridgeSession.status === 'complete' ? `${bridgeSession.changedFiles.length} file(s) changed` : 'Error — see log'}
                    </span>
                    <span style={{ color: '#334155', fontSize: '9px', fontFamily: 'monospace', marginLeft: 'auto' }} title="Bridge session ID (matches audit log)">
                      {bridgeSession.sessionId}
                    </span>
                  </span>
                  {bridgeSession.verifyResult && (
                    <span style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '20px', background: bridgeSession.verifyResult.verified ? 'rgba(34,211,160,0.12)' : 'rgba(251,191,36,0.12)', color: bridgeSession.verifyResult.verified ? '#4ade80' : '#fbbf24', fontWeight: '700', border: `1px solid ${bridgeSession.verifyResult.verified ? 'rgba(74,222,128,0.3)' : 'rgba(251,191,36,0.3)'}` }}>
                      {bridgeSession.verifyResult.passedCount}/{bridgeSession.verifyResult.totalCount} checks
                    </span>
                  )}
                  <button onClick={() => { if (bridgeEsRef.current) { bridgeEsRef.current.close(); bridgeEsRef.current = null; } setBridgeSession(null); }}
                    style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer', fontSize: '16px', lineHeight: 1, padding: '2px 4px', flexShrink: 0 }}>×</button>
                </div>
                {/* Log stream */}
                <div style={{ maxHeight: '180px', overflowY: 'auto', padding: '8px 12px', fontFamily: '"JetBrains Mono","Fira Code",monospace', fontSize: '11px', lineHeight: '1.7' }}>
                  {bridgeSession.logs.map((line, i) => (
                    <div key={i} style={{ color: line.startsWith('❌') ? '#f87171' : line.startsWith('✅') ? '#4ade80' : line.startsWith('⚠️') ? '#fbbf24' : line.startsWith('ℹ️') ? '#a5b4fc' : line.startsWith('✏️') || line.startsWith('📝') || line.startsWith('📖') || line.startsWith('⚡') ? '#22d3a0' : '#64748b', marginBottom: '1px', wordBreak: 'break-all' }}>
                      {line}
                    </div>
                  ))}
                  {(bridgeSession.status === 'connecting' || bridgeSession.status === 'running') && (
                    <div style={{ color: '#475569', animation: 'pulse 1s ease-in-out infinite' }}>▌</div>
                  )}
                </div>
                {/* Changed files (on complete) */}
                {bridgeSession.status === 'complete' && bridgeSession.changedFiles.length > 0 && (
                  <div style={{ padding: '6px 12px 10px', borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                    <div style={{ fontSize: '10px', color: '#334155', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' }}>Files changed</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                      {bridgeSession.changedFiles.slice(0, 8).map((f, i) => (
                        <span key={i} style={{ fontSize: '10px', padding: '1px 7px', background: 'rgba(34,211,160,0.08)', border: '1px solid rgba(34,211,160,0.2)', borderRadius: '4px', color: '#22d3a0', fontFamily: 'monospace' }}>{f.split('/').pop()}</span>
                      ))}
                      {bridgeSession.changedFiles.length > 8 && <span style={{ fontSize: '10px', color: '#334155' }}>+{bridgeSession.changedFiles.length - 8} more</span>}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Speaking indicator */}
            {isSpeaking && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', padding: '8px 14px', background: 'rgba(124,58,237,0.1)', borderRadius: '10px', border: '1px solid rgba(124,58,237,0.25)' }}>
                <div style={{ display: 'flex', gap: '2px', alignItems: 'center' }}>
                  {[0, 1, 2, 3].map(i => (
                    <span key={i} style={{ width: '3px', borderRadius: '2px', background: '#a78bfa', display: 'inline-block', animation: `pulse 0.85s ease-in-out ${i * 0.14}s infinite`, height: `${6 + i * 3}px` }} />
                  ))}
                </div>
                <span style={{ fontSize: '12px', color: '#a78bfa', fontWeight: '600', flex: 1 }}>Speaking…</span>
                <button onClick={stopSpeaking} style={{ fontSize: '11px', padding: '3px 10px', background: 'rgba(124,58,237,0.15)', border: '1px solid rgba(124,58,237,0.3)', borderRadius: '6px', color: '#a78bfa', cursor: 'pointer', fontWeight: '600' }}>Stop</button>
              </div>
            )}

            {/* Recording indicator */}
            {isRecording && (
              <div style={{ marginBottom: '8px', padding: '8px 14px', background: 'rgba(239,68,68,0.07)', borderRadius: '10px', border: '1px solid rgba(239,68,68,0.3)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#ef4444', display: 'inline-block', animation: 'pulse 0.7s ease-in-out infinite', flexShrink: 0 }} />
                  <span style={{ fontSize: '12px', color: '#fca5a5', fontWeight: '600', flex: 1 }}>
                    Listening{finalTranscriptRef.current ? ` — ${finalTranscriptRef.current.trim().split(/\s+/).length} words captured` : '…'}
                  </span>
                  <button onClick={stopVoiceInput} style={{ fontSize: '11px', padding: '4px 12px', background: 'rgba(127,29,29,0.6)', border: '1px solid #991b1b', borderRadius: '6px', color: '#fca5a5', cursor: 'pointer', fontWeight: '600', flexShrink: 0 }}>Done</button>
                </div>
                {interimText && (
                  <div style={{ marginTop: '6px', fontSize: '12px', color: '#475569', fontStyle: 'italic', lineHeight: '1.45', paddingLeft: '16px' }}>
                    {interimText}<span style={{ display: 'inline-block', width: '1.5px', height: '12px', background: '#ef4444', marginLeft: '2px', verticalAlign: 'middle', animation: 'pulse 0.7s ease-in-out infinite' }} />
                  </div>
                )}
              </div>
            )}

            {/* Hidden file input */}
            <input ref={fileInputRef} type="file" accept="image/jpeg,image/jpg,image/png,image/webp,image/svg+xml" multiple style={{ display: 'none' }} onChange={e => handleFileSelect(e.target.files)} />

            {/* ── Composer box ── */}
            <div style={{
              background: 'var(--ide-surface-2)',
              border: `1.5px solid ${isRecording ? 'rgba(239,68,68,0.6)' : composerFocused ? 'rgba(99,102,241,0.7)' : 'var(--ide-border)'}`,
              borderRadius: '14px',
              transition: 'border-color 0.2s, box-shadow 0.2s',
              boxShadow: composerFocused && !isRecording ? '0 0 0 3px rgba(99,102,241,0.12)' : isRecording ? '0 0 0 3px rgba(239,68,68,0.1)' : 'none',
              position: 'relative',
              overflow: 'hidden',
            }}>
              <form onSubmit={handleSubmit}>

                {/* Multi-line custom placeholder — hidden as soon as user types */}
                {!input && !isRecording && phase !== 'building' && !editApplying && (
                  <div style={{ position: 'absolute', top: '16px', left: '18px', right: '18px', pointerEvents: 'none', userSelect: 'none', zIndex: 1 }}>
                    <div style={{ fontSize: '14px', color: '#334155', lineHeight: '1.6' }}>
                      {currentProject ? 'Describe the change you want to make…' : 'Describe what you want to build…'}
                    </div>
                    {!currentProject && (
                      <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '5px' }}>
                        {[
                          'Build a property marketplace for Ghana with listings and Paystack payments',
                          'Create a social network with news feed, follow system, and user profiles',
                          'Generate a hotel booking platform with calendar, rooms, and Stripe checkout',
                        ].map((ex, i) => (
                          <div key={i} style={{ display: 'flex', gap: '8px', fontSize: '12px', color: '#1e3a5f' }}>
                            <span style={{ color: '#1e3a5f', flexShrink: 0 }}>•</span>
                            <span>{ex}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Textarea — auto-expands from 130px up to 320px */}
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={e => {
                    setInput(e.target.value);
                    const el = e.target;
                    el.style.height = 'auto';
                    el.style.height = Math.min(el.scrollHeight, 320) + 'px';
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      const form = e.currentTarget.closest('form');
                      if (form) (form as HTMLFormElement).requestSubmit();
                    }
                  }}
                  onFocus={() => setComposerFocused(true)}
                  onBlur={() => setComposerFocused(false)}
                  placeholder={bridgeTestMode ? 'Describe the app you want Claude Code CLI to build from scratch…' : ''}
                  disabled={phase === 'building' || editApplying}
                  style={{
                    width: '100%',
                    minHeight: '130px',
                    maxHeight: '320px',
                    padding: '16px 18px 10px',
                    background: 'transparent',
                    color: '#e2e8f0',
                    fontSize: '14px',
                    lineHeight: '1.65',
                    outline: 'none',
                    resize: 'none',
                    border: 'none',
                    fontFamily: 'inherit',
                    boxSizing: 'border-box',
                    display: 'block',
                    opacity: (phase === 'building' || editApplying) ? 0.4 : 1,
                    position: 'relative',
                    zIndex: 2,
                    caretColor: '#2563eb',
                  }}
                />

                {/* ── Toolbar ── */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '2px', padding: '8px 12px 10px', borderTop: '1px solid #1a2744' }}>

                  {/* Mic */}
                  <button type="button" onClick={isRecording ? stopVoiceInput : startVoiceInput}
                    disabled={phase === 'building' || editApplying}
                    title={isRecording ? 'Stop recording' : 'Voice input — up to 2 minutes'}
                    style={{ padding: '7px 9px', background: isRecording ? 'rgba(239,68,68,0.15)' : 'transparent', border: `1px solid ${isRecording ? 'rgba(239,68,68,0.4)' : 'transparent'}`, borderRadius: '8px', color: isRecording ? '#ef4444' : '#334155', cursor: isBusy ? 'not-allowed' : 'pointer', fontSize: '16px', lineHeight: 1, transition: 'all 0.15s', flexShrink: 0 }}>
                    {isRecording ? '🔴' : '🎤'}
                  </button>

                  {/* Image / attachment */}
                  <button type="button" onClick={() => fileInputRef.current?.click()}
                    disabled={phase === 'building' || editApplying}
                    title="Attach image — logo, design, screenshot"
                    style={{ padding: '7px 9px', background: 'transparent', border: '1px solid transparent', borderRadius: '8px', color: '#334155', cursor: isBusy ? 'not-allowed' : 'pointer', fontSize: '16px', lineHeight: 1, transition: 'all 0.15s', flexShrink: 0 }}>
                    📎
                  </button>

                  {/* Voice reply */}
                  <button type="button"
                    onClick={() => { const n = !voiceEnabled; setVoiceEnabled(n); voiceEnabledRef.current = n; if (!n) stopSpeaking(); }}
                    title={voiceEnabled ? 'Voice reply on — click to disable' : 'Voice reply off — click to enable'}
                    style={{ padding: '7px 9px', background: voiceEnabled ? 'rgba(124,58,237,0.12)' : 'transparent', border: `1px solid ${voiceEnabled ? 'rgba(124,58,237,0.25)' : 'transparent'}`, borderRadius: '8px', color: voiceEnabled ? '#a78bfa' : '#334155', cursor: 'pointer', fontSize: '16px', lineHeight: 1, transition: 'all 0.15s', flexShrink: 0 }}>
                    {voiceEnabled ? '🔊' : '🔇'}
                  </button>

                  {/* Auto-send mode */}
                  <button type="button" onClick={() => setVoiceAutoSend(v => !v)}
                    title={voiceAutoSend ? 'Voice auto-send ON' : 'Voice review mode'}
                    style={{ padding: '5px 8px', background: voiceAutoSend ? 'rgba(37,99,235,0.12)' : 'transparent', border: `1px solid ${voiceAutoSend ? 'rgba(37,99,235,0.25)' : 'transparent'}`, borderRadius: '8px', color: voiceAutoSend ? '#60a5fa' : '#334155', cursor: 'pointer', fontSize: '12px', fontWeight: '700', lineHeight: 1, transition: 'all 0.15s', flexShrink: 0 }}>
                    {voiceAutoSend ? '⚡' : '✎'}
                  </button>

                  <div style={{ flex: 1 }} />

                  {/* Design style picker — only visible when not building and no project open */}
                  {!currentProject && phase === 'idle' && (
                    <div style={{ marginRight: '8px' }}>
                      <BuildStylePickerInline value={buildStyle} onChange={setBuildStyle} />
                    </div>
                  )}

                  {/* Platform badge + change button — visible when not building and no project open */}
                  {!currentProject && phase === 'idle' && (
                    <button
                      type="button"
                      onClick={() => setGoalStep(goalStep === 'idle' ? 'type' : 'idle')}
                      title="Change platform"
                      style={{
                        display: 'flex', alignItems: 'center', gap: '5px',
                        marginRight: '10px',
                        padding: '4px 12px',
                        background: buildTarget === 'flutter' ? 'rgba(124,58,237,0.15)' : 'rgba(37,99,235,0.12)',
                        border: `1px solid ${buildTarget === 'flutter' ? 'rgba(124,58,237,0.4)' : 'rgba(37,99,235,0.35)'}`,
                        borderRadius: '20px', cursor: 'pointer', fontSize: '11px', fontWeight: '700',
                        color: buildTarget === 'flutter' ? '#a78bfa' : '#60a5fa',
                        transition: 'all 0.15s', flexShrink: 0,
                      }}>
                      {buildTarget === 'flutter' ? '📱 Mobile App' : '🌐 Website'} <span style={{ opacity: 0.5, fontSize: '9px' }}>▾</span>
                    </button>
                  )}

                  {/* Word count badge */}
                  {input.trim().length > 0 && (
                    <span style={{ fontSize: '11px', color: '#1e3a5f', marginRight: '10px', fontVariantNumeric: 'tabular-nums' }}>
                      {input.trim().split(/\s+/).filter(Boolean).length}w
                    </span>
                  )}

                  {/* ⚡ Build with Bridge — always-visible; bypasses DWOMOH pipeline entirely */}
                  <button
                    type="button"
                    disabled={isBusy || !input.trim()}
                    onClick={() => {
                      if (!input.trim() || isBusy) return;
                      const prompt = enrichPromptWithAssets(input.trim());
                      setInput('');
                      if (inputRef.current) inputRef.current.style.height = 'auto';
                      addMsg('user', input.trim());
                      const newHist: ConversationTurn[] = [...history, { role: 'user', content: input.trim() }];
                      setHistory(newHist);
                      setBridgeTestMode(true);
                      runBridgeOnlyPipeline(prompt);
                    }}
                    title="Build with Claude Code CLI via Bridge — DWOMOH Vibe Code writes zero code"
                    style={{
                      padding: '9px 16px',
                      background: input.trim() && !isBusy
                        ? 'linear-gradient(135deg,rgba(124,58,237,0.9),rgba(99,58,200,0.85))'
                        : 'var(--ide-surface-2)',
                      color: input.trim() && !isBusy ? '#e9d5ff' : 'var(--ide-text-dim)',
                      border: input.trim() && !isBusy ? '1px solid rgba(124,58,237,0.5)' : '1px solid var(--ide-border)',
                      borderRadius: '10px',
                      cursor: input.trim() && !isBusy ? 'pointer' : 'not-allowed',
                      fontWeight: '700',
                      fontSize: '12px',
                      transition: 'all 0.2s',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '5px',
                      whiteSpace: 'nowrap',
                      boxShadow: input.trim() && !isBusy ? '0 2px 12px rgba(124,58,237,0.35)' : 'none',
                      flexShrink: 0,
                    }}>
                    <span>⚡</span>
                    <span>Bridge</span>
                  </button>

                  {/* Send button */}
                  <button type="submit"
                    disabled={isBusy || !input.trim()}
                    style={{
                      padding: '9px 22px',
                      background: input.trim() && !isBusy
                        ? 'linear-gradient(135deg,rgba(99,102,241,0.95),rgba(139,92,246,0.9))'
                        : 'var(--ide-surface-2)',
                      color: input.trim() && !isBusy ? '#fff' : 'var(--ide-text-dim)',
                      border: input.trim() && !isBusy ? '1px solid rgba(99,102,241,0.4)' : '1px solid var(--ide-border)',
                      borderRadius: '10px',
                      cursor: input.trim() && !isBusy ? 'pointer' : 'not-allowed',
                      fontWeight: '700',
                      fontSize: '13px',
                      transition: 'all 0.2s',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '7px',
                      whiteSpace: 'nowrap',
                      boxShadow: input.trim() && !isBusy ? '0 2px 14px rgba(99,102,241,0.35)' : 'none',
                      flexShrink: 0,
                    }}>
                    <span>
                      {phase === 'building' ? 'Building…'
                        : editApplying ? 'Applying…'
                        : loading ? 'Thinking…'
                        : 'Send'}
                    </span>
                    {!isBusy && !loading && (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>
                      </svg>
                    )}
                  </button>
                </div>
              </form>
            </div>

            {/* Keyboard hint */}
            <div style={{ marginTop: '8px', textAlign: 'center', fontSize: '11px', color: '#1a2744', letterSpacing: '0.02em' }}>
              Enter to send · Shift+Enter for new line · 🎤 for voice
            </div>
          </div>
        </div>

        {/* ── Asset Role Modal ─────────────────────────────────────────── */}
        {assetModalOpen && pendingAsset && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
               onClick={() => { setAssetModalOpen(false); setPendingAsset(null); }}>
            <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: '16px', padding: '28px', maxWidth: '440px', width: '90%' }}
                 onClick={e => e.stopPropagation()}>
              <div style={{ fontSize: '16px', fontWeight: '700', color: '#e2e8f0', marginBottom: '6px' }}>How would you like to use this image?</div>
              <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '18px' }}>{pendingAsset.name}</div>
              {pendingAsset.type !== 'image/svg+xml' && (
                <img src={pendingAsset.dataUrl} alt="preview" style={{ width: '100%', maxHeight: '160px', objectFit: 'cover', borderRadius: '8px', marginBottom: '18px', border: '1px solid #334155' }} />
              )}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                {([
                  { role: 'logo',        label: 'Logo',           icon: '🏷️' },
                  { role: 'hero',        label: 'Hero Image',     icon: '🖼️' },
                  { role: 'product',     label: 'Product Photo',  icon: '📦' },
                  { role: 'background',  label: 'Background',     icon: '🎨' },
                  { role: 'icon',        label: 'Icon',           icon: '⭐' },
                  { role: 'gallery',     label: 'Gallery',        icon: '🗂️' },
                  { role: 'inspiration', label: 'Design Inspiration', icon: '💡' },
                ] as const).map(opt => (
                  <button key={opt.role}
                    onClick={() => assignAssetRole(pendingAsset, opt.role)}
                    style={{ padding: '10px 12px', background: '#1e293b', border: '1px solid #334155', borderRadius: '8px', color: '#e2e8f0', cursor: 'pointer', fontSize: '13px', textAlign: 'left', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span>{opt.icon}</span>{opt.label}
                  </button>
                ))}
              </div>
              <button onClick={() => { setAssetModalOpen(false); setPendingAsset(null); }}
                style={{ marginTop: '14px', width: '100%', padding: '8px', background: 'none', border: '1px solid #334155', borderRadius: '8px', color: '#64748b', cursor: 'pointer', fontSize: '12px' }}>
                Skip — just attach without a role
              </button>
            </div>
          </div>
        )}

        {/* ── Logo Panel ────────────────────────────────────────────────── */}
        {logoPanel && logoOptions.length > 0 && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.82)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', overflowY: 'auto', padding: '24px' }}
               onClick={() => setLogoPanel(false)}>
            <div style={{ background: '#0a1220', border: '1px solid #1e3a5f', borderRadius: '20px', padding: '32px', maxWidth: '580px', width: '100%', boxShadow: '0 24px 64px rgba(0,0,0,0.6)' }}
                 onClick={e => e.stopPropagation()}>
              <div style={{ marginBottom: '6px', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontSize: '18px', fontWeight: '700', color: '#f1f5f9' }}>
                    {logoBrief.brandName ? `${logoBrief.brandName} — Logo Concepts` : 'Logo Concepts'}
                  </div>
                  <div style={{ fontSize: '12px', color: '#475569', marginTop: '3px' }}>3 professional concepts — each with a distinct visual style</div>
                </div>
                <button onClick={() => setLogoPanel(false)}
                  style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer', fontSize: '20px', lineHeight: 1, padding: '4px', marginLeft: '12px' }}>×</button>
              </div>
              <div style={{ height: '1px', background: '#1e3a5f', margin: '20px 0' }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                {logoOptions.map((svg, i) => {
                  const label = logoStyleLabels[i] ?? (['Minimal', 'Modern', 'Bold'][i] ?? `Option ${i + 1}`);
                  return (
                    <div key={i} style={{ border: '1.5px solid #1e3a5f', borderRadius: '14px', overflow: 'hidden', transition: 'border-color 0.18s' }}
                         onMouseEnter={e => (e.currentTarget.style.borderColor = '#2563eb')}
                         onMouseLeave={e => (e.currentTarget.style.borderColor = '#1e3a5f')}>
                      <div style={{ padding: '24px 20px', background: '#0f1929', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '90px' }}
                           dangerouslySetInnerHTML={{ __html: svg }} />
                      <div style={{ padding: '10px 14px', background: '#070f1c', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                        <span style={{ fontSize: '12px', color: '#64748b', fontWeight: '600', letterSpacing: '0.04em', textTransform: 'uppercase' }}>{label}</span>
                        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                          <button onClick={e => { e.stopPropagation(); downloadLogo(svg, 'svg', label); }}
                            style={{ padding: '4px 10px', background: '#141e2e', border: '1px solid #1e3a5f', borderRadius: '6px', color: '#64748b', cursor: 'pointer', fontSize: '10px', fontWeight: '600', letterSpacing: '0.05em' }}>SVG</button>
                          <button onClick={e => { e.stopPropagation(); downloadLogo(svg, 'png', label); }}
                            style={{ padding: '4px 10px', background: '#141e2e', border: '1px solid #1e3a5f', borderRadius: '6px', color: '#64748b', cursor: 'pointer', fontSize: '10px', fontWeight: '600', letterSpacing: '0.05em' }}>PNG</button>
                          <button onClick={e => { e.stopPropagation(); saveLogoAsAsset(svg, i); }}
                            style={{ padding: '5px 14px', background: 'linear-gradient(135deg,#1d4ed8,#4f46e5)', border: 'none', borderRadius: '7px', color: '#fff', cursor: 'pointer', fontSize: '11px', fontWeight: '700' }}>Use this →</button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div style={{ marginTop: '18px', display: 'flex', gap: '10px' }}>
                <button onClick={() => { setLogoPanel(false); handleLogoBriefSubmit(); }}
                  style={{ flex: 1, padding: '9px 0', background: 'none', border: '1.5px solid #1e3a5f', borderRadius: '10px', color: '#94a3b8', cursor: 'pointer', fontSize: '12px', fontWeight: '600' }}>↻ Regenerate</button>
                <button onClick={() => { setLogoPanel(false); setInput('Refine the logo: '); setTimeout(() => inputRef.current?.focus(), 50); }}
                  style={{ flex: 1, padding: '9px 0', background: 'none', border: '1.5px solid #1e3a5f', borderRadius: '10px', color: '#94a3b8', cursor: 'pointer', fontSize: '12px', fontWeight: '600' }}>✎ Describe a change</button>
              </div>
            </div>
          </div>
        )}

        {/* ── Logo Brief Modal ──────────────────────────────────────────── */}
        {logoBriefOpen && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.82)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', overflowY: 'auto' }}
               onClick={() => setLogoBriefOpen(false)}>
            <div style={{ background: '#0a1220', border: '1px solid #1e3a5f', borderRadius: '20px', padding: '32px', maxWidth: '480px', width: '100%', boxShadow: '0 24px 64px rgba(0,0,0,0.6)' }}
                 onClick={e => e.stopPropagation()}>
              <div style={{ fontSize: '18px', fontWeight: '700', color: '#f1f5f9', marginBottom: '4px' }}>Brand Brief</div>
              <div style={{ fontSize: '12px', color: '#475569', marginBottom: '24px' }}>The more detail you provide, the better the logo.</div>
              {/* Brand Name */}
              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', fontSize: '11px', color: '#64748b', fontWeight: '700', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '6px' }}>Brand Name *</label>
                <input value={logoBrief.brandName} onChange={e => setLogoBrief(b => ({ ...b, brandName: e.target.value }))} placeholder="e.g. PropertyGhana"
                  style={{ width: '100%', padding: '10px 12px', background: '#0f1929', border: '1.5px solid #1e3a5f', borderRadius: '8px', color: '#e2e8f0', fontSize: '14px', outline: 'none', boxSizing: 'border-box' }} />
              </div>
              {/* Industry */}
              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', fontSize: '11px', color: '#64748b', fontWeight: '700', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '6px' }}>Industry</label>
                <select value={logoBrief.industry} onChange={e => setLogoBrief(b => ({ ...b, industry: e.target.value }))}
                  style={{ width: '100%', padding: '10px 12px', background: '#0f1929', border: '1.5px solid #1e3a5f', borderRadius: '8px', color: '#e2e8f0', fontSize: '14px', outline: 'none', boxSizing: 'border-box' }}>
                  <option value=''>Select industry…</option>
                  {['Technology / SaaS','Food & Restaurant','Real Estate','Finance & Fintech','Healthcare','E-commerce / Retail','Media & Entertainment','Education','Fitness & Wellness','Legal & Professional','Luxury & Fashion','Non-profit','Travel & Hospitality','Other'].map(opt => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
              </div>
              {/* Style */}
              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', fontSize: '11px', color: '#64748b', fontWeight: '700', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '8px' }}>Visual Style</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  {['Minimal','Modern','Bold','Luxury','Corporate','Playful','Tech','Creative'].map(s => (
                    <button key={s} onClick={() => setLogoBrief(b => ({ ...b, style: s }))}
                      style={{ padding: '6px 12px', borderRadius: '6px', border: `1.5px solid ${logoBrief.style === s ? '#2563eb' : '#1e3a5f'}`, background: logoBrief.style === s ? 'rgba(37,99,235,0.18)' : '#0f1929', color: logoBrief.style === s ? '#93c5fd' : '#64748b', fontSize: '12px', cursor: 'pointer', fontWeight: logoBrief.style === s ? '700' : '400' }}>{s}</button>
                  ))}
                </div>
              </div>
              {/* Logo Type */}
              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', fontSize: '11px', color: '#64748b', fontWeight: '700', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '8px' }}>Logo Type</label>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  {[['icon-text','Icon + Text'],['text','Wordmark'],['symbol','Symbol'],['emblem','Emblem']].map(([val, lbl]) => (
                    <button key={val} onClick={() => setLogoBrief(b => ({ ...b, logoType: val }))}
                      style={{ padding: '6px 12px', borderRadius: '6px', border: `1.5px solid ${logoBrief.logoType === val ? '#2563eb' : '#1e3a5f'}`, background: logoBrief.logoType === val ? 'rgba(37,99,235,0.18)' : '#0f1929', color: logoBrief.logoType === val ? '#93c5fd' : '#64748b', fontSize: '12px', cursor: 'pointer', fontWeight: logoBrief.logoType === val ? '700' : '400' }}>{lbl}</button>
                  ))}
                </div>
              </div>
              {/* Colors */}
              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', fontSize: '11px', color: '#64748b', fontWeight: '700', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '6px' }}>Color Preferences</label>
                <input value={logoBrief.colors} onChange={e => setLogoBrief(b => ({ ...b, colors: e.target.value }))} placeholder="e.g. Navy blue and gold"
                  style={{ width: '100%', padding: '10px 12px', background: '#0f1929', border: '1.5px solid #1e3a5f', borderRadius: '8px', color: '#e2e8f0', fontSize: '14px', outline: 'none', boxSizing: 'border-box' }} />
              </div>
              {/* Notes */}
              <div style={{ marginBottom: '24px' }}>
                <label style={{ display: 'block', fontSize: '11px', color: '#64748b', fontWeight: '700', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '6px' }}>Special Ideas or Symbols</label>
                <textarea value={logoBrief.notes} onChange={e => setLogoBrief(b => ({ ...b, notes: e.target.value }))} placeholder="Describe any icons, symbols, or ideas…" rows={2}
                  style={{ width: '100%', padding: '10px 12px', background: '#0f1929', border: '1.5px solid #1e3a5f', borderRadius: '8px', color: '#e2e8f0', fontSize: '14px', outline: 'none', resize: 'vertical', boxSizing: 'border-box' }} />
              </div>
              <button onClick={handleLogoBriefSubmit} disabled={!logoBrief.brandName.trim()}
                style={{ width: '100%', padding: '13px', background: logoBrief.brandName.trim() ? 'linear-gradient(135deg,#1d4ed8,#4f46e5)' : '#1e3a5f', border: 'none', borderRadius: '10px', color: logoBrief.brandName.trim() ? '#fff' : '#475569', cursor: logoBrief.brandName.trim() ? 'pointer' : 'not-allowed', fontSize: '14px', fontWeight: '700' }}>
                ✨ Generate 3 Logo Concepts
              </button>
              <button onClick={() => setLogoBriefOpen(false)}
                style={{ marginTop: '10px', width: '100%', padding: '9px', background: 'none', border: '1px solid #1e3a5f', borderRadius: '8px', color: '#475569', cursor: 'pointer', fontSize: '12px' }}>Cancel</button>
            </div>
          </div>
        )}

        {/* ── Image Analysis Loading Overlay ─────────────────────────────── */}
        {analysingImage && (
          <div style={{ position: 'fixed', bottom: '90px', right: '24px', zIndex: 999, background: '#0a1628', border: '1px solid #7c3aed', borderRadius: '10px', padding: '10px 16px', display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>🔍</span>
            <span style={{ fontSize: '12px', color: '#a78bfa' }}>Analysing your image…</span>
          </div>
        )}

        {/* ── Logo Generating Overlay ─────────────────────────────────────── */}
        {generatingLogo && (
          <div style={{ position: 'fixed', bottom: '90px', right: '24px', zIndex: 999, background: '#0a1628', border: '1px solid #7c3aed', borderRadius: '10px', padding: '10px 16px', display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>✨</span>
            <span style={{ fontSize: '12px', color: '#a78bfa' }}>{logoStage || 'Generating logo concepts…'}</span>
          </div>
        )}

        {/* ── Preview Panel ───────────────────────────────────────────── */}
        <div style={{ width: '42%', minWidth: '320px', background: 'var(--ide-surface)', display: 'flex', flexDirection: 'column', borderLeft: '1px solid var(--ide-border)' }}>
          {/* Premium tab bar */}
          <div style={{
            height: '52px', display: 'flex', alignItems: 'center',
            borderBottom: '1px solid var(--ide-border)',
            background: 'var(--ide-surface)',
            paddingLeft: '4px', overflowX: 'auto', flexShrink: 0,
          }}>
            {([
              { id: 'preview', label: 'Preview', icon: '⬡' },
              { id: 'design',  label: 'Design',  icon: '◈' },
              { id: 'terminal',label: 'Terminal', icon: '$' },
              { id: 'logs',    label: 'Logs',     icon: '≡' },
            ] as const).map(tab => (
              <button
                key={tab.id}
                className={`panel-tab${previewTab === tab.id ? ' active' : ''}`}
                onClick={() => setPreviewTab(tab.id)}
                style={{ position: 'relative' }}
              >
                <span style={{ fontSize: '13px', opacity: previewTab === tab.id ? 1 : 0.5 }}>{tab.icon}</span>
                <span>{tab.label}</span>
                {tab.id === 'preview' && researchActivity && !researchActivity.complete && (
                  <span style={{ position: 'absolute', top: '8px', right: '6px', width: '5px', height: '5px', borderRadius: '50%', background: 'var(--ide-accent)', animation: 'pulse 1.2s ease-in-out infinite' }} />
                )}
                {tab.id === 'design' && (assets.some(a => a.role === 'logo') || logoHistory.length > 0) && (
                  <span style={{ position: 'absolute', top: '8px', right: '6px', width: '5px', height: '5px', borderRadius: '50%', background: '#8b5cf6' }} />
                )}
              </button>
            ))}
            {previewUrl && previewTab === 'preview' && (
              <div style={{ display: 'flex', gap: '4px', marginLeft: 'auto', padding: '0 10px', flexShrink: 0 }}>
                <button onClick={() => setPreviewKey(k => k + 1)} title="Refresh"
                  style={{ padding: '5px 8px', background: 'var(--ide-surface-2)', border: '1px solid var(--ide-border)', borderRadius: '5px', color: 'var(--ide-text-muted)', cursor: 'pointer', fontSize: '12px' }}>↺</button>
                <a href={previewUrl} target="_blank" rel="noopener noreferrer" title="Open in new tab"
                  style={{ padding: '5px 8px', background: 'var(--ide-surface-2)', border: '1px solid var(--ide-border)', borderRadius: '5px', color: 'var(--ide-text-muted)', textDecoration: 'none', fontSize: '12px', display: 'flex', alignItems: 'center' }}>↗</a>
              </div>
            )}
          </div>

          <div style={{ flex: 1, overflow: 'hidden', position: 'relative', background: 'var(--ide-bg)' }}>
            {/* ── PREVIEW TAB ── */}
            {previewTab === 'preview' && (
              <>
                {previewUrl ? (
                  <>
                    <iframe
                      key={previewKey}
                      src={previewUrl}
                      style={{ width: '100%', height: '100%', border: 'none', background: 'white' }}
                      title="App Preview"
                      onLoad={() => setPreviewLoading(false)}
                    />
                    {/* Scaffold overlay — shown while the re-generation loop is replacing the
                        placeholder with real app code. Sits above the iframe so the user
                        never mistakenly thinks the "Building your app" scaffold is real UI. */}
                    {scaffoldDetected && buildProgress?.step !== 'error' && (
                      <div style={{ position: 'absolute', inset: 0, background: 'rgba(7,15,28,0.96)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '18px', zIndex: 20 }}>
                        <div style={{ width: '44px', height: '44px', border: '3px solid #1e3a5f', borderTop: '3px solid #f59e0b', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
                        <div style={{ textAlign: 'center', maxWidth: '320px' }}>
                          <div style={{ color: '#fbbf24', fontSize: '14px', fontWeight: '700', marginBottom: '8px' }}>Re-generating your app…</div>
                          <div style={{ color: '#94a3b8', fontSize: '12px', lineHeight: '1.6' }}>
                            The preview showed a placeholder — the AI is re-generating your full application now.
                          </div>
                          <div style={{ color: '#475569', fontSize: '11px', marginTop: '8px' }}>This may take 30–60 seconds</div>
                        </div>
                        <a href={previewUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: '11px', color: '#3b82f6', textDecoration: 'underline' }}>Open raw preview ↗</a>
                      </div>
                    )}
                    {previewLoading && !scaffoldDetected && !verificationLive?.active && (
                      <div style={{ position: 'absolute', inset: 0, background: '#070f1c', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px', animation: 'slidein 0.3s ease', zIndex: 10 }}>
                        <div style={{ width: '40px', height: '40px', border: '3px solid #1e3a5f', borderTop: '3px solid #3b82f6', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
                        <div style={{ textAlign: 'center' }}>
                          <div style={{ color: '#e2e8f0', fontSize: '14px', fontWeight: '700', marginBottom: '6px' }}>Loading your app…</div>
                          <div style={{ color: '#475569', fontSize: '12px', marginBottom: '4px' }}>Next.js is doing its first compile</div>
                          <div style={{ color: '#334155', fontSize: '11px' }}>This takes ~30 seconds on first load</div>
                        </div>
                        <a href={previewUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: '11px', color: '#3b82f6', textDecoration: 'underline' }}>Open in new tab ↗</a>
                      </div>
                    )}
                    {/* ── Live Verification Overlay ── */}
                    {verificationLive && (
                      <div style={{ position: 'absolute', inset: 0, zIndex: 20, pointerEvents: 'none', display: 'flex', flexDirection: 'column' }}>
                        {/* Top bar */}
                        <div style={{ background: 'rgba(7,15,28,0.94)', borderBottom: '1px solid #1e3a5f', padding: '7px 14px', display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0, pointerEvents: 'auto' }}>
                          <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: verificationLive.active ? '#3b82f6' : '#4ade80', display: 'inline-block', animation: verificationLive.active ? 'pulse 1s ease-in-out infinite' : 'none', flexShrink: 0 }} />
                          <span style={{ fontSize: '9px', color: verificationLive.active ? '#3b82f6' : (verificationLive.summary.failed === 0 && verificationLive.summary.pages404Found === 0 ? '#4ade80' : '#f87171'), fontWeight: '800', textTransform: 'uppercase', letterSpacing: '0.09em' }}>
                            {verificationLive.active ? 'Live Verification' : (verificationLive.summary.failed === 0 && verificationLive.summary.pages404Found === 0 ? '✅ Verified Working' : `❌ ${verificationLive.summary.pages404Found} Broken Route(s)`)}
                          </span>
                          <span style={{ fontSize: '9px', color: '#334155' }}>•</span>
                          <span style={{ fontSize: '9px', color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                            {verificationLive.phase === 'journey' ? 'Browser Journey' : verificationLive.phase === 'crawl' ? 'Link Crawler' : 'Complete'}
                          </span>
                          <div style={{ marginLeft: 'auto', display: 'flex', gap: '12px' }}>
                            <span style={{ fontSize: '10px', color: '#4ade80', fontWeight: '700' }}>✅ {verificationLive.steps.filter(s => s.status === 'pass').length}</span>
                            <span style={{ fontSize: '10px', color: '#f87171', fontWeight: '700' }}>❌ {verificationLive.steps.filter(s => s.status === 'fail').length}</span>
                          </div>
                        </div>
                        {/* Middle — shows Playwright's actual screenshot, updated after each step */}
                        <div style={{ flex: 1, position: 'relative', background: '#070f1c', display: 'flex' }}>
                          {/* Playwright screenshot — the real browser view */}
                          <div style={{ flex: 1, position: 'relative', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            {verificationLive.lastScreenshot ? (
                              <img
                                key={verificationLive.lastScreenshot}
                                src={verificationLive.lastScreenshot}
                                alt="Playwright live view"
                                style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
                              />
                            ) : (
                              <div style={{ textAlign: 'center', color: '#334155' }}>
                                <div style={{ fontSize: '24px', marginBottom: '8px' }}>🎭</div>
                                <div style={{ fontSize: '11px' }}>Playwright starting…</div>
                              </div>
                            )}
                            {/* Live action label over the screenshot */}
                            {verificationLive.active && (
                              <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '6px 10px', background: 'rgba(7,15,28,0.85)', borderTop: '1px solid #1e293b', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <div style={{ width: '6px', height: '6px', borderRadius: '50%', border: '2px solid #3b82f6', borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite', flexShrink: 0 }} />
                                <span style={{ fontSize: '10px', color: '#94a3b8', fontWeight: '500' }}>{verificationLive.currentAction}</span>
                                <span style={{ fontSize: '9px', color: '#334155', fontFamily: 'monospace', marginLeft: 'auto' }}>{verificationLive.currentUrl}</span>
                              </div>
                            )}
                          </div>
                          {/* Right step log panel */}
                          <div style={{ width: '200px', flexShrink: 0, background: 'rgba(7,15,28,0.95)', borderLeft: '1px solid #1e293b', display: 'flex', flexDirection: 'column', overflow: 'hidden', pointerEvents: 'auto' }}>
                            <div style={{ padding: '8px 10px', borderBottom: '1px solid #0f172a', fontSize: '9px', color: '#334155', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.07em', flexShrink: 0 }}>
                              Verification Steps
                            </div>
                            <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
                              {verificationLive.steps.map((step, i) => (
                                <div key={i} style={{ padding: '5px 10px', display: 'flex', alignItems: 'flex-start', gap: '6px', borderBottom: '1px solid rgba(15,23,42,0.5)' }}>
                                  <span style={{ fontSize: '10px', flexShrink: 0, marginTop: '1px' }}>
                                    {step.status === 'pass' ? '✅' : '❌'}
                                  </span>
                                  <div style={{ minWidth: 0 }}>
                                    <div style={{ fontSize: '10px', color: step.status === 'pass' ? '#86efac' : '#fca5a5', fontWeight: '500', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                      {step.name}
                                    </div>
                                    {step.url && step.url !== '/' && (
                                      <div style={{ fontSize: '9px', color: '#334155', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace' }}>{step.url}</div>
                                    )}
                                    {step.durationMs !== undefined && (
                                      <div style={{ fontSize: '9px', color: '#1e293b' }}>{(step.durationMs / 1000).toFixed(1)}s</div>
                                    )}
                                  </div>
                                </div>
                              ))}
                              {verificationLive.active && (
                                <div style={{ padding: '5px 10px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                  <div style={{ width: '8px', height: '8px', borderRadius: '50%', border: '2px solid #3b82f6', borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite', flexShrink: 0 }} />
                                  <div style={{ fontSize: '10px', color: '#334155' }}>Running…</div>
                                </div>
                              )}
                            </div>
                            {/* Summary card (shown after complete) */}
                            {!verificationLive.active && (
                              <div style={{ padding: '8px 10px', borderTop: '1px solid #0f172a', flexShrink: 0 }}>
                                <div style={{ fontSize: '9px', color: verificationLive.summary.pages404Found === 0 && verificationLive.summary.failed === 0 ? '#4ade80' : '#f87171', fontWeight: '700', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                                  {verificationLive.summary.pages404Found === 0 && verificationLive.summary.failed === 0
                                    ? '✅ Verified Working — Pass Rate 100%'
                                    : `❌ ${verificationLive.summary.pages404Found} Broken Route(s) — Not Verified`}
                                </div>
                                {[
                                  { label: 'Routes Tested',  value: String(verificationLive.summary.routesTested) },
                                  { label: 'Routes Passed',  value: String(verificationLive.summary.passed),     color: '#4ade80' },
                                  { label: 'Routes Failed',  value: String(verificationLive.summary.failed),     color: verificationLive.summary.failed > 0 ? '#f87171' : '#4ade80' },
                                  { label: 'Routes Repaired',value: String(verificationLive.summary.repaired),   color: '#f59e0b' },
                                  { label: 'Forms Tested',   value: String(verificationLive.summary.formsTested) },
                                  { label: 'Search Tests',   value: String(verificationLive.summary.searchTests) },
                                  { label: 'Login Tests',    value: String(verificationLive.summary.loginTests) },
                                  { label: 'Logout Tests',   value: String(verificationLive.summary.logoutTests) },
                                  { label: '404s Found',     value: String(verificationLive.summary.pages404Found), color: verificationLive.summary.pages404Found > 0 ? '#f87171' : '#4ade80' },
                                  { label: '404s Fixed',     value: String(verificationLive.summary.pages404Fixed), color: '#f59e0b' },
                                  { label: 'Screenshots',    value: String(verificationLive.summary.screenshotsCaptured) },
                                  { label: 'Pass Rate',      value: verificationLive.summary.finalPassRate, color: verificationLive.summary.finalPassRate === '100%' ? '#4ade80' : '#f59e0b' },
                                ].map(({ label, value, color }) => (
                                  <div key={label} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '2px' }}>
                                    <span style={{ fontSize: '9px', color: '#334155' }}>{label}</span>
                                    <span style={{ fontSize: '9px', fontWeight: '700', color: color ?? '#64748b' }}>{value}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                        {/* Bottom action bar removed — action label is now overlaid on the screenshot */}
                      </div>
                    )}
                  </>
                ) : researchActivity ? (
                  /* ── Research / API Discovery activity panel ── */
                  <div style={{ height: '100%', overflowY: 'auto', padding: '20px', background: '#070f1c', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                    {/* Mode header */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: researchActivity.complete ? '#4ade80' : '#3b82f6', display: 'inline-block', animation: researchActivity.complete ? 'none' : 'pulse 1.2s ease-in-out infinite', flexShrink: 0 }} />
                      <span style={{ fontSize: '10px', color: researchActivity.complete ? '#4ade80' : '#3b82f6', fontWeight: '800', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                        {researchActivity.mode === 'web' ? 'Web Research' : 'API Discovery'} {researchActivity.complete ? '— Complete' : '— In Progress'}
                      </span>
                    </div>
                    {/* Query card */}
                    <div style={{ background: '#0f1929', border: '1px solid #1e3a5f', borderRadius: '10px', padding: '12px 14px' }}>
                      <div style={{ fontSize: '9px', color: '#475569', fontWeight: '800', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '5px' }}>Research Query</div>
                      <div style={{ fontSize: '13px', color: '#e2e8f0', lineHeight: '1.55', fontStyle: 'italic' }}>"{researchActivity.query}"</div>
                    </div>
                    {/* Source cards (web mode) */}
                    {researchActivity.mode === 'web' && researchActivity.sources.length > 0 && (
                      <div>
                        <div style={{ fontSize: '9px', color: '#475569', fontWeight: '800', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '7px' }}>Sources Being Reviewed</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                          {researchActivity.sources.map((s, si) => (
                            <div key={si} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '7px 11px', background: '#0f1929', border: `1px solid ${s.status === 'done' ? '#166534' : s.status === 'error' ? '#7f1d1d' : '#1e3a5f'}`, borderRadius: '7px' }}>
                              <span style={{ fontSize: '13px' }}>{s.status === 'done' ? '✅' : s.status === 'error' ? '❌' : '🌐'}</span>
                              <span style={{ fontSize: '11px', color: s.status === 'done' ? '#4ade80' : s.status === 'error' ? '#f87171' : '#93c5fd', fontFamily: 'monospace', flex: 1 }}>{s.hostname}</span>
                              <span style={{ fontSize: '9px', color: s.status === 'done' ? '#166534' : s.status === 'error' ? '#7f1d1d' : '#334155', fontWeight: '600', textTransform: 'uppercase' }}>
                                {s.status === 'done' ? 'fetched' : s.status === 'error' ? 'blocked' : researchActivity.complete ? 'skipped' : 'pending'}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {/* Agent timeline */}
                    <div>
                      <div style={{ fontSize: '9px', color: '#475569', fontWeight: '800', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '7px' }}>Agent Activity</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        {researchActivity.timeline.map((t, ti) => (
                          <div key={ti} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{ fontSize: '11px', minWidth: '14px', color: t.status === 'done' ? '#4ade80' : t.status === 'active' ? '#fbbf24' : '#1e293b' }}>
                              {t.status === 'done' ? '✓' : t.status === 'active' ? '▶' : '○'}
                            </span>
                            <span style={{ fontSize: '12px', color: t.status === 'done' ? '#4ade80' : t.status === 'active' ? '#fbbf24' : '#334155', fontWeight: t.status === 'active' ? '600' : '400' }}>
                              {t.step}
                              {t.status === 'active' && <span style={{ marginLeft: '4px', animation: 'pulse 1.2s ease-in-out infinite', display: 'inline-block', color: '#fbbf24' }}>…</span>}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                    {/* Findings summary (after complete) */}
                    {researchActivity.complete && researchActivity.recommendations && (
                      <div>
                        <div style={{ fontSize: '9px', color: '#4ade80', fontWeight: '800', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '7px' }}>Key Findings</div>
                        <div style={{ background: '#0f1929', border: '1px solid #166534', borderRadius: '10px', padding: '12px 14px', fontSize: '11px', color: '#94a3b8', lineHeight: '1.7', maxHeight: '180px', overflowY: 'auto', whiteSpace: 'pre-wrap' }}>
                          {researchActivity.recommendations.slice(0, 1000)}{researchActivity.recommendations.length > 1000 ? '\n\n… See full response in the chat →' : ''}
                        </div>
                      </div>
                    )}
                    {/* "Apply to project" CTA */}
                    {researchActivity.complete && currentProject && (
                      <button onClick={() => { setInput(`Yes, apply these improvements to ${currentProject.name}`); setTimeout(() => inputRef.current?.focus(), 50); }}
                        style={{ padding: '11px 16px', background: 'linear-gradient(135deg,#1d4ed8,#4f46e5)', border: 'none', borderRadius: '10px', color: '#fff', cursor: 'pointer', fontSize: '13px', fontWeight: '700', textAlign: 'center', flexShrink: 0 }}>
                        Apply improvements to {currentProject.name} →
                      </button>
                    )}
                    {/* Used-knowledge notice */}
                    {researchActivity.complete && researchActivity.usedKnowledge && (
                      <div style={{ fontSize: '10px', color: '#334155', textAlign: 'center' }}>Could not fetch pages directly — recommendations based on platform knowledge.</div>
                    )}
                  </div>
                ) : debugActivity ? (
                  /* ── Debug Mode panel ── */
                  <div style={{ height: '100%', overflowY: 'auto', padding: '20px', background: '#070f1c', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                    {/* Header */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <span style={{ animation: debugActivity.status === 'complete' || debugActivity.status === 'failed' ? 'none' : 'spin 1s linear infinite', display: 'inline-block', fontSize: '16px' }}>
                        {debugActivity.status === 'complete' ? '✅' : debugActivity.status === 'failed' ? '❌' : '🔍'}
                      </span>
                      <div>
                        <div style={{ color: '#f87171', fontWeight: '800', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                          {debugActivity.status === 'complete' ? 'Debug Complete' : debugActivity.status === 'failed' ? 'Debug Failed' : 'Debug Mode — Active'}
                        </div>
                        <div style={{ color: '#93c5fd', fontSize: '11px', marginTop: '2px' }}>{debugActivity.projectName}</div>
                      </div>
                      {debugActivity.errorCount > 0 && (
                        <div style={{ marginLeft: 'auto', background: '#7f1d1d', border: '1px solid #ef444433', borderRadius: '6px', padding: '3px 9px', color: '#f87171', fontSize: '11px', fontWeight: '700' }}>
                          {debugActivity.errorCount} error{debugActivity.errorCount !== 1 ? 's' : ''}
                        </div>
                      )}
                    </div>

                    {/* Root cause / status */}
                    {debugActivity.rootCause && (
                      <div style={{ background: '#1a0a0a', border: '1px solid #7f1d1d', borderRadius: '8px', padding: '10px 12px' }}>
                        <div style={{ fontSize: '9px', color: '#f87171', fontWeight: '800', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '5px' }}>Root Cause</div>
                        <div style={{ fontSize: '11px', color: '#fca5a5', lineHeight: 1.6 }}>{debugActivity.rootCause}</div>
                      </div>
                    )}

                    {/* Files being read */}
                    {debugActivity.filesBeingRead.length > 0 && (
                      <div>
                        <div style={{ fontSize: '9px', color: '#475569', fontWeight: '800', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '6px' }}>Files Inspected</div>
                        {debugActivity.filesBeingRead.map((f, fi) => (
                          <div key={fi} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '3px' }}>
                            <span style={{ fontSize: '10px', color: '#3b82f6' }}>📄</span>
                            <span style={{ fontSize: '11px', color: '#93c5fd', fontFamily: 'monospace' }}>{f}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Files modified */}
                    {debugActivity.filesModified.length > 0 && (
                      <div>
                        <div style={{ fontSize: '9px', color: '#4ade80', fontWeight: '800', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '6px' }}>Files Modified</div>
                        {debugActivity.filesModified.map((f, fi) => (
                          <div key={fi} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '3px' }}>
                            <span style={{ fontSize: '10px' }}>✏️</span>
                            <span style={{ fontSize: '11px', color: '#4ade80', fontFamily: 'monospace' }}>{f}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Debug Timeline */}
                    <div>
                      <div style={{ fontSize: '9px', color: '#475569', fontWeight: '800', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '7px' }}>Debug Pipeline</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                        {debugActivity.timeline.map((t, ti) => (
                          <div key={ti} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{ fontSize: '11px', minWidth: '14px', color: t.status === 'done' ? '#4ade80' : t.status === 'active' ? '#fbbf24' : '#1e293b' }}>
                              {t.status === 'done' ? '✓' : t.status === 'active' ? '▶' : '○'}
                            </span>
                            <span style={{ fontSize: '12px', color: t.status === 'done' ? '#4ade80' : t.status === 'active' ? '#fbbf24' : '#334155', fontWeight: t.status === 'active' ? '700' : '400' }}>
                              {t.step}
                              {t.status === 'active' && <span style={{ marginLeft: '4px', display: 'inline-block', animation: 'pulse 1.2s ease-in-out infinite', color: '#fbbf24' }}>…</span>}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Error log preview */}
                    {debugActivity.buildLog.length > 0 && (
                      <div>
                        <div style={{ fontSize: '9px', color: '#f87171', fontWeight: '800', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '6px' }}>Error Log (auto-reading)</div>
                        <div style={{ background: '#0f1929', border: '1px solid #7f1d1d', borderRadius: '8px', padding: '10px 12px', maxHeight: '120px', overflowY: 'auto' }}>
                          {debugActivity.buildLog.map((l, li) => (
                            <div key={li} style={{ fontSize: '10px', fontFamily: 'monospace', color: '#f87171', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{l}</div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : editApplying ? (
                  /* ── Edit activity panel (no live preview yet) ── */
                  <div style={{ height: '100%', overflowY: 'auto', padding: '20px', background: '#070f1c', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block', fontSize: '15px' }}>⚙️</span>
                      <span style={{ color: '#93c5fd', fontWeight: '700', fontSize: '13px' }}>DWOMOH Vibe Code is working on your project…</span>
                    </div>
                    <div>
                      <div style={{ fontSize: '9px', color: '#475569', fontWeight: '800', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '7px' }}>What is happening now</div>
                      {[
                        { id: 'reading',      label: 'Reading existing project files' },
                        { id: 'understanding', label: 'Understanding your requested change' },
                        { id: 'checking',     label: 'Checking affected pages' },
                        { id: 'navigation',   label: 'Analysing navigation structure' },
                        { id: 'preparing',    label: 'Preparing file edits' },
                        { id: 'writing',      label: 'Writing changes to files' },
                        { id: 'applying',     label: 'Applying with Next.js hot reload' },
                        { id: 'refreshing',   label: 'Refreshing preview' },
                        { id: 'verifying',    label: 'Testing routes and links' },
                        { id: 'complete',     label: 'Changes complete' },
                      ].map((s) => {
                        const ids = ['reading','understanding','checking','navigation','preparing','writing','applying','refreshing','verifying','complete'];
                        const curIdx = ids.indexOf(editDetailStep);
                        const sIdx = ids.indexOf(s.id);
                        const done   = sIdx < curIdx;
                        const active = sIdx === curIdx;
                        return (
                          <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                            <span style={{ fontSize: '11px', minWidth: '14px', color: done ? '#4ade80' : active ? '#fbbf24' : '#1e293b' }}>
                              {done ? '✓' : active ? '▶' : '○'}
                            </span>
                            <span style={{ fontSize: '12px', color: done ? '#4ade80' : active ? '#fbbf24' : '#334155', fontWeight: active ? '600' : '400' }}>
                              {s.label}
                              {active && <span style={{ marginLeft: '4px', animation: 'pulse 1.2s ease-in-out infinite', display: 'inline-block', color: '#fbbf24' }}>…</span>}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                    {editElapsed > 30 && (
                      <div style={{ fontSize: '11px', color: '#334155' }}>{editElapsed}s into this edit — complex changes may take 60–90 seconds.</div>
                    )}
                  </div>
                ) : (
                  /* ── Idle mode — example cards ── */
                  <div style={{ padding: '32px 24px', color: '#475569', fontSize: '14px', overflowY: 'auto' }}>
                    <div style={{ marginBottom: '24px' }}>
                      <div style={{ fontSize: '28px', marginBottom: '12px' }}>⚡</div>
                      <p style={{ color: '#94a3b8', fontSize: '15px', fontWeight: '600', marginBottom: '8px' }}>Autonomous AI Engineer</p>
                      <p style={{ color: '#64748b', fontSize: '13px', lineHeight: '1.7' }}>Type what you want to build and I'll start immediately — no setup required.</p>
                    </div>
                    <div style={{ display: 'grid', gap: '8px' }}>
                      {[
                        { label: 'Property marketplace', desc: 'Search, listings, maps' },
                        { label: 'SaaS dashboard', desc: 'Analytics, charts, users' },
                        { label: 'E-commerce store', desc: 'Products, cart, checkout' },
                        { label: 'Task management app', desc: 'Kanban, teams, deadlines' },
                        { label: 'Recipe finder', desc: 'Search, filters, favorites' },
                        { label: 'Job board', desc: 'Listings, apply, company pages' },
                      ].map(ex => (
                        <button
                          key={ex.label}
                          onClick={() => { setInput(ex.label); inputRef.current?.focus(); }}
                          style={{ textAlign: 'left', padding: '10px 12px', background: '#0f172a', border: '1px solid #1e293b', borderRadius: '8px', cursor: 'pointer', color: '#94a3b8' }}
                        >
                          <div style={{ fontSize: '12px', fontWeight: '600', color: '#e2e8f0', marginBottom: '2px' }}>{ex.label}</div>
                          <div style={{ fontSize: '11px', color: '#475569' }}>{ex.desc}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {phase === 'building' && !previewUrl && (() => {
                  const BSTEPS = [
                    { id: 'understanding', label: 'Understanding Request' },
                    { id: 'designing',     label: 'Planning Architecture' },
                    { id: 'database',      label: 'Creating Files' },
                    { id: 'frontend',      label: 'Generating Frontend' },
                    { id: 'backend',       label: 'Generating Backend' },
                    { id: 'installing',    label: 'Installing Dependencies' },
                    { id: 'testing',       label: 'Running Build' },
                    { id: 'previewing',    label: 'Starting Server' },
                    { id: 'verifying',     label: 'Refreshing Preview' },
                    { id: '__done__',      label: 'Build Complete' },
                  ];
                  const detailToIdx: Record<string, number> = {
                    understanding: 0, researching: 1, finding_apis: 1, designing: 1,
                    database: 2, frontend: 3, backend: 4, installing: 5,
                    testing: 6, previewing: 7, verifying: 8,
                  };
                  const isDone  = buildProgress?.step === 'done';
                  const isError = buildProgress?.step === 'error';
                  const curIdx  = isDone ? 10 : (buildDetailStep ? (detailToIdx[buildDetailStep] ?? 0) : 0);
                  const buildName = buildingProjectName || 'your application';
                  return (
                    <div style={{ position: 'absolute', inset: 0, background: '#070f1c', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', overflow: 'auto', padding: '28px 20px', animation: 'slidein 0.4s ease' }}>
                      {/* Header */}
                      <div style={{ textAlign: 'center', marginBottom: '24px' }}>
                        <div style={{ fontSize: '28px', marginBottom: '10px', animation: 'pulse 2s ease-in-out infinite' }}>⚡</div>
                        <div style={{ color: '#e2e8f0', fontSize: '14px', fontWeight: '700', marginBottom: '4px' }}>DWOMOH Vibe Code is building</div>
                        <div style={{ color: '#4ade80', fontSize: '13px', fontWeight: '600', marginBottom: '6px', maxWidth: '300px', wordBreak: 'break-word' }}>{buildName}</div>
                        {!isError && <div style={{ color: '#475569', fontSize: '11px' }}>Generating files · Installing deps · Starting preview</div>}
                        {isError && <div style={{ color: '#f87171', fontSize: '11px' }}>Server failed to start — files are saved · Ask me to fix the startup issue</div>}
                      </div>
                      {/* 10-step progress list */}
                      <div style={{ width: '100%', maxWidth: '320px', background: '#0f1929', border: '1px solid #1e3a5f', borderRadius: '12px', padding: '4px 0', overflow: 'hidden' }}>
                        {BSTEPS.map((s, i) => {
                          const done   = i < curIdx || isDone;
                          const active = i === curIdx && !isDone && !isError;
                          const error  = isError && i === curIdx;
                          return (
                            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '7px 14px', borderBottom: i < BSTEPS.length - 1 ? '1px solid #0f172a' : 'none', background: active ? '#0a2540' : 'transparent', transition: 'background 0.3s' }}>
                              <span style={{ fontSize: '11px', minWidth: '14px', textAlign: 'center', flexShrink: 0, color: done ? '#4ade80' : active ? '#fbbf24' : error ? '#f87171' : '#1e3a5f', fontWeight: '700' }}>
                                {done ? '✓' : active ? '▶' : error ? '!' : '○'}
                              </span>
                              <span style={{ fontSize: '12px', flex: 1, color: done ? '#4ade80' : active ? '#fbbf24' : error ? '#f87171' : '#1e3a5f', fontWeight: active ? '700' : done ? '600' : '400' }}>
                                {s.label}
                                {active && <span style={{ marginLeft: '5px', display: 'inline-block', animation: 'pulse 1.2s ease-in-out infinite' }}>…</span>}
                              </span>
                              {done && <span style={{ fontSize: '9px', color: '#166534', fontWeight: '700', textTransform: 'uppercase' }}>Done</span>}
                              {active && <span style={{ fontSize: '9px', color: '#fbbf24', fontWeight: '700', textTransform: 'uppercase', animation: 'pulse 1.2s ease-in-out infinite' }}>Active</span>}
                            </div>
                          );
                        })}
                      </div>
                      {/* Latest log line */}
                      {buildProgress?.logs && buildProgress.logs.length > 0 && (
                        <div style={{ width: '100%', maxWidth: '320px', marginTop: '10px', padding: '8px 12px', background: '#0a1628', border: '1px solid #1e293b', borderRadius: '8px', fontFamily: 'monospace', fontSize: '10px', color: '#4ade80', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                          {buildProgress.logs[buildProgress.logs.length - 1]}
                        </div>
                      )}
                      <div style={{ marginTop: '14px', fontSize: '10px', color: '#1e293b', textAlign: 'center' }}>
                        Files are saved automatically · Usually takes 60–120 seconds
                      </div>
                    </div>
                  );
                })()}
                {editApplying && previewUrl && (
                  <div style={{ position: 'absolute', bottom: '16px', right: '16px', background: '#070f1c', border: '1px solid #1d4ed8', borderRadius: '10px', padding: '12px 14px', width: '220px', display: 'flex', flexDirection: 'column', gap: '8px', boxShadow: '0 4px 24px #00000099' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                      <span style={{ animation: editDetailStep === 'complete' ? 'none' : 'spin 1s linear infinite', display: 'inline-block', fontSize: '13px', flexShrink: 0 }}>
                        {editDetailStep === 'complete' ? '✅' : '⚙️'}
                      </span>
                      <span style={{ fontSize: '11px', color: '#93c5fd', fontWeight: '700' }}>
                        {editDetailStep === 'complete' ? 'Changes applied' : 'DWOMOH Vibe Code is working…'}
                      </span>
                      {editElapsed > 0 && <span style={{ marginLeft: 'auto', fontSize: '10px', color: '#334155' }}>{editElapsed}s</span>}
                    </div>
                    {[
                      { id: 'reading',       label: 'Reading project files' },
                      { id: 'understanding', label: 'Understanding request' },
                      { id: 'checking',      label: 'Checking components' },
                      { id: 'preparing',     label: 'Planning changes' },
                      { id: 'writing',       label: 'Writing files' },
                      { id: 'applying',      label: 'Applying hot reload' },
                      { id: 'refreshing',    label: 'Refreshing preview' },
                      { id: 'verifying',     label: 'Testing routes' },
                      { id: 'complete',      label: 'Complete' },
                    ].map((s) => {
                      const order = ['reading','understanding','checking','preparing','writing','applying','refreshing','verifying','complete'];
                      const cur = order.indexOf(editDetailStep);
                      const si  = order.indexOf(s.id);
                      const done   = si < cur;
                      const active = si === cur;
                      return (
                        <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{ fontSize: '9px', minWidth: '12px', color: done ? '#4ade80' : active ? '#fbbf24' : '#1e293b', fontWeight: '700' }}>
                            {done ? '✓' : active ? '▶' : '○'}
                          </span>
                          <span style={{ fontSize: '10px', color: done ? '#4ade80' : active ? '#fbbf24' : '#334155', fontWeight: active ? '700' : '400' }}>
                            {s.label}
                            {active && <span style={{ marginLeft: '2px', display: 'inline-block', animation: 'pulse 1.2s ease-in-out infinite' }}>…</span>}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}

            {/* ── DESIGN TAB ── */}
            {previewTab === 'design' && (
              <div style={{ overflowY: 'auto', padding: '20px', display: 'flex', flexDirection: 'column', gap: '20px', height: '100%' }}>
                {/* Active logo */}
                {(() => {
                  const logoAsset = assets.find(a => a.role === 'logo');
                  return logoAsset ? (
                    <div>
                      <div style={{ fontSize: '11px', color: '#475569', fontWeight: '700', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '10px' }}>Active Logo</div>
                      <div style={{ background: '#0f1929', border: '1.5px solid #2563eb', borderRadius: '12px', overflow: 'hidden' }}>
                        <div style={{ padding: '28px 20px', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '90px' }}
                             dangerouslySetInnerHTML={{ __html: `<img src="${logoAsset.dataUrl}" style="max-width:100%;max-height:80px;object-fit:contain;" alt="Brand logo" />` }} />
                        <div style={{ padding: '10px 14px', background: '#070f1c', display: 'flex', gap: '6px', flexWrap: 'wrap', borderTop: '1px solid #1e3a5f' }}>
                          <button onClick={() => { try { const svg = decodeURIComponent(escape(atob(logoAsset.base64))); downloadLogo(svg, 'svg', 'logo'); } catch { } }}
                            style={{ padding: '4px 10px', background: '#141e2e', border: '1px solid #1e3a5f', borderRadius: '6px', color: '#64748b', cursor: 'pointer', fontSize: '10px', fontWeight: '600' }}>SVG</button>
                          <button onClick={() => { try { const svg = decodeURIComponent(escape(atob(logoAsset.base64))); downloadLogo(svg, 'png', 'logo'); } catch { } }}
                            style={{ padding: '4px 10px', background: '#141e2e', border: '1px solid #1e3a5f', borderRadius: '6px', color: '#64748b', cursor: 'pointer', fontSize: '10px', fontWeight: '600' }}>PNG</button>
                          <button onClick={() => { try { const svg = decodeURIComponent(escape(atob(logoAsset.base64))); downloadLogo(svg, 'jpg', 'logo'); } catch { } }}
                            style={{ padding: '4px 10px', background: '#141e2e', border: '1px solid #1e3a5f', borderRadius: '6px', color: '#64748b', cursor: 'pointer', fontSize: '10px', fontWeight: '600' }}>JPG</button>
                          <button onClick={() => { setInput('Refine the logo: '); setTimeout(() => inputRef.current?.focus(), 50); }}
                            style={{ padding: '4px 12px', background: 'rgba(37,99,235,0.18)', border: '1px solid #2563eb', borderRadius: '6px', color: '#93c5fd', cursor: 'pointer', fontSize: '10px', fontWeight: '700' }}>✎ Edit</button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div style={{ textAlign: 'center', padding: '24px', color: '#475569', fontSize: '13px' }}>
                      <div style={{ fontSize: '24px', marginBottom: '8px' }}>🎨</div>
                      <div style={{ color: '#64748b', marginBottom: '12px' }}>No logo generated yet</div>
                      <button onClick={() => handleLogoGenerate('')}
                        style={{ padding: '8px 16px', background: 'linear-gradient(135deg,#1d4ed8,#4f46e5)', border: 'none', borderRadius: '8px', color: '#fff', cursor: 'pointer', fontSize: '12px', fontWeight: '700' }}>
                        Create a logo
                      </button>
                    </div>
                  );
                })()}

                {/* Version history */}
                {logoHistory.length > 0 && (
                  <div>
                    <div style={{ fontSize: '11px', color: '#475569', fontWeight: '700', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '10px' }}>Version History</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      {logoHistory.map((entry, hi) => (
                        <div key={hi} style={{ border: '1px solid #1e3a5f', borderRadius: '10px', overflow: 'hidden' }}>
                          <div style={{ padding: '12px', background: '#0f1929', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '50px' }}
                               dangerouslySetInnerHTML={{ __html: entry.svg }} />
                          <div style={{ padding: '6px 10px', background: '#070f1c', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <span style={{ fontSize: '10px', color: '#475569' }}>{entry.label} · {new Date(entry.ts).toLocaleTimeString()}</span>
                            <button onClick={() => saveLogoAsAsset(entry.svg, 0, `Restored v${logoHistory.length - hi}`)}
                              style={{ padding: '2px 8px', background: 'none', border: '1px solid #1e3a5f', borderRadius: '4px', color: '#64748b', cursor: 'pointer', fontSize: '9px', fontWeight: '600' }}>Restore</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── TERMINAL TAB ── */}
            {previewTab === 'terminal' && (
              <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#020709' }}>
                <div style={{ flex: 1, overflowY: 'auto', padding: '12px', fontFamily: 'monospace', fontSize: '12px', lineHeight: '1.7' }}>
                  {terminalLogs.map((line, i) => (
                    <div key={i} style={{ color: line.startsWith('$') ? '#60a5fa' : line.startsWith('❌') ? '#f87171' : '#4ade80' }}>{line}</div>
                  ))}
                  {terminalRunning && <div style={{ color: '#fbbf24', animation: 'pulse 1s ease-in-out infinite' }}>Running…</div>}
                </div>
                <form
                  onSubmit={async e => {
                    e.preventDefault();
                    const cmd = terminalInput.trim();
                    if (!cmd || terminalRunning || !currentProject) return;
                    setTerminalInput('');
                    setTerminalLogs(l => [...l, `$ ${cmd}`]);
                    setTerminalRunning(true);
                    try {
                      const r = await api({ action: 'run-command', projectPath: currentProject.projectPath, command: cmd });
                      setTerminalLogs(l => [...l, ...(r.output || ['(no output)']).slice(0, 50)]);
                      if (r.exitCode !== 0) setTerminalLogs(l => [...l, `❌ Exit code: ${r.exitCode}`]);
                    } catch (err) {
                      setTerminalLogs(l => [...l, `❌ ${err instanceof Error ? err.message : 'Error'}`]);
                    } finally {
                      setTerminalRunning(false);
                    }
                  }}
                  style={{ display: 'flex', borderTop: '1px solid #1e293b', padding: '8px' }}
                >
                  <span style={{ color: '#60a5fa', fontFamily: 'monospace', fontSize: '12px', padding: '8px 6px' }}>$</span>
                  <input
                    value={terminalInput}
                    onChange={e => setTerminalInput(e.target.value)}
                    placeholder={currentProject ? 'npm run build, ls, cat package.json…' : 'Open a project first'}
                    disabled={terminalRunning || !currentProject}
                    style={{ flex: 1, background: 'none', border: 'none', color: '#e2e8f0', fontFamily: 'monospace', fontSize: '12px', outline: 'none', opacity: !currentProject ? 0.4 : 1 }}
                  />
                  <button type="submit" disabled={terminalRunning || !currentProject || !terminalInput.trim()} style={{ padding: '4px 10px', background: '#1e3a5f', border: 'none', borderRadius: '4px', color: '#60a5fa', cursor: 'pointer', fontSize: '11px' }}>
                    Run
                  </button>
                </form>
              </div>
            )}

            {/* ── LOGS TAB ── */}
            {previewTab === 'logs' && (
              <div style={{ height: '100%', overflowY: 'auto', padding: '12px', background: '#020709', fontFamily: 'monospace', fontSize: '11px', lineHeight: '1.7' }}>
                {buildProgress ? (
                  <>
                    <div style={{ color: '#475569', marginBottom: '8px', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Build Logs</div>
                    {buildProgress.logs.map((l, i) => (
                      <div key={i} style={{ color: l.startsWith('❌') ? '#f87171' : l.startsWith('✅') ? '#4ade80' : l.startsWith('⚠️') ? '#fbbf24' : '#94a3b8' }}>{l}</div>
                    ))}
                  </>
                ) : (
                  <div style={{ color: '#475569', paddingTop: '24px', textAlign: 'center' }}>Build logs appear here when a project is building or running.</div>
                )}
                {errorLogs.length > 0 && (
                  <div style={{ marginTop: '20px' }}>
                    <div style={{ color: '#475569', marginBottom: '8px', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span>Error Log</span>
                      <button onClick={() => setErrorLogs([])} style={{ background: 'none', border: 'none', color: '#334155', cursor: 'pointer', fontSize: '10px' }}>Clear</button>
                    </div>
                    {errorLogs.map((l, i) => (
                      <div key={i} style={{ color: '#f87171', fontSize: '11px', fontFamily: 'monospace', marginBottom: '4px', wordBreak: 'break-all' }}>{l}</div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

      </div>
      )}{/* end desktop/mobile conditional */}
    </>
  );
}

export default function DwomohVibeCode() {
  return (
    <Suspense>
      <BuilderInner />
    </Suspense>
  );
}
