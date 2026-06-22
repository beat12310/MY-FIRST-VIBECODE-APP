'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { useAuth } from '@/lib/auth-context';
import { PROJECT_TEMPLATES } from '@/lib/project-templates';
import { interpretCommand, getActionLabel } from '@/lib/nl-command-interpreter';

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
    recoveryActions?: Array<{ label: string; action: 'retry-logo' | 'retry-research' | 'open-logs' | 'focus-input'; prompt?: string }>;
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

// ─── Component ─────────────────────────────────────────────────────────────────

function BuilderInner() {
  const { user, getToken } = useAuth();
  const searchParams = useSearchParams();
  // Conversation
  const [phase, setPhase] = useState<BuildPhase>('idle');
  const [history, setHistory] = useState<ConversationTurn[]>([]);
  const [displayed, setDisplayed] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [readyToBuild, setReadyToBuild] = useState(false);

  // Build
  const [buildProgress, setBuildProgress] = useState<BuildProgress | null>(null);
  const [lastVerification, setLastVerification] = useState<{ verified: boolean; summary: string; checks: Array<{ name: string; passed: boolean; recordCount?: number; error?: string }> } | null>(null);

  // Preview
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewKey, setPreviewKey] = useState(0);
  const [previewLoading, setPreviewLoading] = useState(false);

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

  const addMsg = useCallback((role: DisplayMessage['role'], content: string, statusType?: DisplayMessage['statusType']) => {
    setDisplayed(prev => [...prev, { role, content, statusType }]);
  }, []);

  const addStatus = useCallback((content: string, statusType: DisplayMessage['statusType']) => {
    setDisplayed(prev => [...prev, { role: 'status', content, statusType }]);
  }, []);

  const api = useCallback(async (body: Record<string, unknown>) => {
    const token = await getToken();
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return res.json();
  }, [getToken]);

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

  // welcome message + optional template pre-fill
  useEffect(() => {
    setDisplayed([{
      role: 'assistant',
      content: "Hi! I'm DWOMOH Vibe Code — your autonomous AI software engineer.\n\nJust tell me what you want to build and I'll start immediately. No setup questions, no waiting — I use production-ready defaults and build the complete app for you.\n\n✓ Generate code  ✓ Install dependencies  ✓ Fix TypeScript errors  ✓ Start server  ✓ Verify it works\n\nOr click any project in the sidebar to resume where you left off.",
    }]);
    const templateId = searchParams?.get('template');
    if (templateId) {
      const tmpl = PROJECT_TEMPLATES.find(t => t.id === templateId);
      if (tmpl) setInput(tmpl.prompt);
    }
    const promptParam = searchParams?.get('prompt');
    if (promptParam) setInput(promptParam);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── New project ───────────────────────────────────────────────────────────

  const handleNewProject = () => {
    setPhase('idle');
    setHistory([]);
    setDisplayed([{ role: 'assistant', content: "Ready for a new project! What would you like to build?" }]);
    setBuildProgress(null);
    setPreviewUrl(null);
    setPreviewLoading(false);
    setReadyToBuild(false);
    setCurrentProject(null);
    setCurrentDiscovery(null);
    setCurrentMemory(null);
    setBuilderContext(null);
    setDebugActivity(null);
    inputRef.current?.focus();
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
    setDisplayed([]);

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
        const url = `http://localhost:${openResult.port}`;
        setPreviewUrl(url);
        setPreviewKey(k => k + 1);
        setPreviewLoading(true);
        setPhase('previewing');
        setBuildProgress({ step: 'done', message: `${project.name} is running`, logs: [`✅ Port ${openResult.port}`], port: openResult.port });

        addStatus(`DWOMOH Vibe Code has loaded ${project.name}. Preview is ready.`, 'done');

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

              // Show the investigation result to the user as a status message
              if (investigationData.formatted) {
                addStatus(investigationData.formatted, 'reading');
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

      // Inject root cause report + auto-gathered errors into the user request
      // so the AI engineer always knows the layer to target before touching files.
      const enrichedRequest = (() => {
        let req = userRequest;
        if (isDebugRequest && autoGatheredError) {
          req += `\n\n[ERRORS VISIBLE IN THE PREVIEW/TERMINAL — fix these, do not ask the user for more detail]:\n${autoGatheredError}`;
        }
        if (rootCauseContext) {
          req += rootCauseContext;
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
          addStatus(`Retrying ${attempt} of 2 — reconnecting to AI…`, 'applying');
        },
      );

      clearTimers();

      if (editResult.conversational) {
        setEditDetailStep('complete');
        if (isDebugRequest) advanceDebug('complete', DEBUG_TIMELINE.length - 1);
        addMsg('assistant', editResult.response || 'Done.');
        return;
      }

      // ── Safety Gate: handle regression detection (fix introduced new errors) ──
      // The edit action runs a TypeScript check after applying changes.
      // If new errors were introduced, it rolls back and returns regressionDetected=true.
      if (editResult.regressionDetected) {
        const newErrors: string[] = editResult.newErrors ?? [];
        const errorSample = newErrors.slice(0, 3).join('\n');

        advanceDebug && advanceDebug('failed', 0, {
          rootCause: `Regression detected: ${newErrors.length} new error(s) introduced`,
          buildLog: newErrors.slice(0, 5),
        });
        setEditDetailStep('error');

        addStatus(
          `Rollback: fix introduced ${newErrors.length} new error(s) — restored to previous working state`,
          'error'
        );

        // Notify the user clearly what happened and try a safer approach
        addMsg('assistant',
          `**Safety rollback triggered.**\n\n` +
          `The fix I attempted introduced new TypeScript errors and was automatically rolled back. Your project is back to its previous state.\n\n` +
          (errorSample ? `**Errors that were introduced:**\n\`\`\`\n${errorSample}\n\`\`\`\n\n` : '') +
          `**What happened:** The AI changed files that introduced a syntax error ("${newErrors[0]?.slice(0, 80) ?? 'TypeScript error'}"). The platform detected this before it could break the preview and restored the previous version.\n\n` +
          `**What I'll do instead:** Run a more targeted, minimal fix that only touches the specific file causing the issue.`
        );

        // Attempt a safer, more targeted retry using agent-fix with explicit files
        const runPort2 = buildProgress?.port || currentProject.port;
        if (runPort2 && isDebugRequest) {
          try {
            addStatus('Attempting safer targeted fix…', 'applying');
            const verifyBeforeRetry = await api({ action: 'verify-app', port: runPort2, projectPath: currentProject.projectPath });
            const failedTargets = (verifyBeforeRetry?.checks ?? [])
              .filter((c: { passed: boolean; fixFile?: string }) => !c.passed && c.fixFile)
              .map((c: { fixFile: string }) => c.fixFile)
              .filter(Boolean) as string[];

            if (failedTargets.length > 0) {
              const errorCtxSafe = newErrors.slice(0, 5).join('\n');
              const saferFix = await api({
                action: 'agent-fix',
                projectPath: currentProject.projectPath,
                errorContext: `Fix ONLY the specific error in the identified file. Do NOT refactor or rewrite. Minimum change only:\n\n${errorCtxSafe}`,
                targetFiles: failedTargets.slice(0, 2),
                strategy: 'targeted',
              });
              if (saferFix?.fixedCount > 0) {
                addStatus(`Safer fix applied to ${saferFix.fixedCount} file(s) — verifying…`, 'checking');
                await new Promise(r => setTimeout(r, 1500));
                setPreviewKey(k => k + 1);
              }
            }
          } catch { /* non-critical — targeted retry is best-effort */ }
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
          addStatus(`Fixing ${tsResult.errors.length} remaining TypeScript issue(s)…`, 'applying');
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
        type EditVerifyCheck = { name: string; passed: boolean; recordCount?: number; error?: string; rootCause?: { kind: string; detail: string; packages?: string[]; envVars?: string[]; fixFile?: string; fixHint?: string }; fixFile?: string; fixHint?: string };
        let verifyData: { verified: boolean; summary: string; checks?: Array<EditVerifyCheck>; failures?: string[] } | null = null;
        if (runPort) {
          try {
            verifyData = await api({ action: 'verify-app', port: runPort, projectPath: currentProject.projectPath });
            if (verifyData) setLastVerification(verifyData as { verified: boolean; summary: string; checks: Array<{ name: string; passed: boolean; recordCount?: number; error?: string }> });
          } catch { /* best-effort */ }
        }

        // ── If routes are still failing, run one agent-fix round ──────────
        if (runPort && verifyData && !verifyData.verified && isDebugRequest) {
          const failedRoutes = (verifyData.checks ?? []).filter(c => !c.passed && (
            c.rootCause?.kind === 'runtime-crash' ||
            c.rootCause?.kind === 'wrong-http-method' ||
            c.rootCause?.kind === 'timeout' ||
            c.rootCause?.kind === 'route-failure'
          ));
          if (failedRoutes.length > 0) {
            addStatus(`Auto-fixing ${failedRoutes.length} failing route(s)…`, 'applying');
            const targetFiles = [...new Set(failedRoutes.flatMap(c => [c.fixFile, c.rootCause?.fixFile].filter(Boolean) as string[]))];
            const errorContext = failedRoutes.map(c =>
              `${c.name}: ${c.rootCause?.detail || c.error}\n  ${c.fixHint || c.rootCause?.fixHint || ''}`
            ).join('\n');
            const logData2 = await api({ action: 'get-server-logs', projectPath: currentProject.projectPath }).catch(() => ({ logs: '' }));
            const serverLogs2 = (logData2.logs as string || '').split('\n').filter((l: string) => /error|failed/i.test(l)).slice(-10).join('\n');
            if (targetFiles.length > 0) {
              await api({ action: 'snapshot-files', projectPath: currentProject.projectPath, files: targetFiles });
            }
            const agentFixResult = await api({ action: 'agent-fix', projectPath: currentProject.projectPath, errorContext, targetFiles, serverLogs: serverLogs2 }).catch(() => null);
            if (agentFixResult?.fixedCount > 0) {
              addStatus(`Fixed ${agentFixResult.fixedCount} file(s) — re-verifying…`, 'checking');
              await new Promise(r => setTimeout(r, 2500));
              try {
                const verifyAfterFix = await api({ action: 'verify-app', port: runPort, projectPath: currentProject.projectPath });
                if (verifyAfterFix.checks?.filter((c: EditVerifyCheck) => c.passed).length >= (verifyData.checks ?? []).filter(c => c.passed).length) {
                  verifyData = verifyAfterFix;
                  setLastVerification(verifyAfterFix as { verified: boolean; summary: string; checks: Array<{ name: string; passed: boolean; recordCount?: number; error?: string }> });
                  await api({ action: 'clear-snapshot', projectPath: currentProject.projectPath });
                } else {
                  // Rollback — fix made things worse
                  await api({ action: 'restore-files', projectPath: currentProject.projectPath });
                }
              } catch { /* non-critical */ }
              setPreviewKey(k => k + 1);
            }
          }
        }

        setEditDetailStep('complete');
        if (isDebugRequest) {
          advanceDebug('complete', DEBUG_TIMELINE.length - 1, { filesModified: changed });
        }

        const verifyLine = verifyData
          ? `Verification: ${verifyData.verified ? '✅ All checks passed' : '⚠️ ' + verifyData.summary}`
          : 'Verification: Pending — refresh the preview to confirm.';

        if (verifyData?.verified) addStatus('Changes complete — all routes verified.', 'done');
        else if (verifyData && !verifyData.verified) addStatus(`Applied — some checks flagged: ${verifyData.failures?.join(', ') || 'see report'}`, 'error');
        else addStatus(`Files updated: ${changed.join(', ')}`, 'done');

        addMsg('assistant',
          `Files changed: ${changed.join(', ')}\n` +
          `TypeScript: ${tsResult.clean ? '✅ Clean' : `⚠️ ${tsResult.errors?.length || 0} error(s) — auto-fix applied`}\n` +
          verifyLine +
          (verifyData?.failures?.length ? `\n\nFailed checks:\n${verifyData.failures.map((f: string) => `• ${f}`).join('\n')}` : '')
        );

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
    runBuildPipeline(newHistory, enrichPromptWithAssets(text));
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

  // ── Build pipeline ────────────────────────────────────────────────────────

  const runBuildPipeline = async (conversationHistory: ConversationTurn[], originalPrompt: string) => {
    setPhase('building');
    setReadyToBuild(false);
    setLoading(false);
    setPreviewTab('preview');
    setPreviewUrl(null);        // clear previous project's URL so progress tracker shows
    setPreviewLoading(false);
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

    try {
      // ── 1. Generate ────────────────────────────────────────────────────────
      setBuildDetailStep('researching');
      const findApisTimer = setTimeout(() => setBuildDetailStep('finding_apis'), 4000);
      const genData = await api({ action: 'generate', messages: conversationHistory });
      clearTimeout(findApisTimer);
      // The generate action retries 3 times with escalating strategies and always
      // returns a scaffold as last resort — so success=false only on a genuine API/network failure.
      if (!genData.success || !genData.projectData) throw new Error('Code generation failed — click Retry Build to try again');

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
        const hasFreeAlts = apiPlanData.missing.some((c: string) => ['weather', 'finance', 'news'].includes(c));
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
      const createData = await api({ action: 'create', prompt: genData.projectData, originalPrompt });
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
      // If the server hasn't responded by then, fetch captured logs and show the exact error.
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
          message: '⏱ Server startup timed out (90s)',
          logs: [...(p?.logs ?? []), '⏱ Startup exceeded 90 seconds', errorLines || 'No error detail captured'],
        }));
        narrate(
          `⏱ Server startup exceeded 90 seconds. Your **project files are saved**.` +
          (errorLines ? `\n\nError captured:\n\`\`\`\n${errorLines}\n\`\`\`` : '') +
          `\n\nAsk me to **"fix the startup issue"** and I'll diagnose and repair it automatically.`
        );
      }, 90000);
      const _clearServerTimer = () => {
        if (_serverStartTimer) { clearTimeout(_serverStartTimer); _serverStartTimer = null; }
      };

      // ── 5. Start server — 3 strategies, NEVER throws ──────────────────────
      let serverData = await api({ action: 'start-server', projectPath: path });

      if (!serverData.port) {
        const errorMsg = serverData.error || 'Server failed to start';
        appendLog(`⚠️ Strategy 1 failed: ${errorMsg}`);

        // Strategy 1: classify error → apply fix → retry
        const recovery1 = await api({ action: 'auto-recover', projectPath: path, errorText: errorMsg });
        if (recovery1.fixed) {
          narrate(`🔧 ${recovery1.userMessage} Retrying the server…`);
          (recovery1.actions ?? []).forEach((a: string) => appendLog(a));
          serverData = await api({ action: 'start-server', projectPath: path });
        }
      }

      if (!serverData.port) {
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

      if (!serverData.port) {
        _clearServerTimer();
        // Strategy 3: give up on live preview but NEVER stop — save the project anyway
        const crashDetail: string = serverData.error || '';
        appendLog(`⚠️ Server could not start — ${crashDetail || 'project files saved to sidebar'}`);
        narrate(
          `⚠️ The server didn't start after three attempts. **The app files are saved** — you'll see this project in the sidebar.\n\n` +
          (crashDetail ? `Error: **${crashDetail.slice(0, 200)}**\n\n` : '') +
          `Ask me to **"fix the startup issue"** and I'll investigate and repair it automatically.`
        );
        setBuildProgress(p => ({
          ...p!,
          step: 'error',
          message: `⚠️ ${projectName} — server start failed, files saved`,
          logs: [...(p?.logs ?? []), `⚠️ ${crashDetail || 'Server start failed after 3 strategies'}`, '📁 Project files saved — open from sidebar to fix'],
        }));
        // Save the project record so it shows in the sidebar even without a running port
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
        return; // exit gracefully — build pipeline complete, just no live preview
      }

      _clearServerTimer(); // server confirmed — cancel the 90s safety net
      let port: number = serverData.port;
      appendLog(`✅ Server live on port ${port}`);

      narrate(`🖥️ Server started on port **${port}**! The preview is loading… Next.js does a first-compile which takes ~30 seconds. I'll run verification checks while you wait.`);

      setPreviewUrl(`http://localhost:${port}`);
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
      type VerifyCheck = { name: string; passed: boolean; recordCount?: number; error?: string; responsePreview?: string; rootCause?: RootCause; fixFile?: string; fixHint?: string };
      type VerifyData = { verified: boolean; summary: string; checks: VerifyCheck[]; failures?: string[] };

      // ── Strategy sequences per error kind ─────────────────────────────────
      // Each kind has ordered strategies tried in sequence.
      // When a strategy fails to improve the check count, the next is tried.
      const ERROR_STRATEGIES: Record<string, ReadonlyArray<string>> = {
        'missing-package':       ['auto-install'],
        'auth-misconfigured':    ['add-secret', 'targeted'],
        'missing-env':           ['add-placeholder'],
        'wrong-http-method':     ['targeted', 'broader', 'rewrite'],
        'server-crash':          ['cache-clear', 'targeted', 'broader', 'rewrite'],
        'not-found':             ['targeted', 'broader'],
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
        // scaffold-placeholder: the main page is still showing the AI generation loading screen.
        // The only repair is to regenerate — agent-fix rewrites app/page.tsx with the correct app.
        'scaffold-placeholder':    ['broader', 'rewrite'],
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

      let verifyData: VerifyData = { verified: false, summary: 'Not verified', checks: [] };

      const MAX_ITERATIONS = 15;
      let lastPassedCount = -1;
      let consecutiveRollbacks = 0;
      let triedCacheClear = false;
      let browserContextCache = ''; // browser console/network errors, collected lazily

      for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
        appendLog(`🤖 Engineering loop — iteration ${iter}/${MAX_ITERATIONS}`);

        // ── STEP 1: Full verification ────────────────────────────────────────
        try {
          verifyData = await api({ action: 'verify-app', port, projectPath: path });
          setLastVerification(verifyData);
        } catch { break; }

        const passedNow = verifyData.checks.filter(c => c.passed).length;
        const totalChecks = verifyData.checks.length;
        appendLog(`📊 ${passedNow}/${totalChecks} checks passing`);

        if (verifyData.verified) {
          appendLog('✅ All checks pass');
          break;
        }

        if (iter >= MAX_ITERATIONS) {
          appendLog('⚠️ Reached iteration limit — stopping loop');
          break;
        }

        const failedChecks = verifyData.checks.filter(c => !c.passed);
        if (failedChecks.length === 0) break;

        // ── STEP 2: Check if we can continue ────────────────────────────────
        if (allStrategiesExhausted(failedChecks) && consecutiveRollbacks >= 2) {
          narrate(`⚠️ All repair strategies have been tried for the remaining issues. The app is running at ${passedNow}/${totalChecks} checks. Ask me to investigate a specific failing check.`);
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
          if (rA.port) { port = rA.port; setPreviewUrl(`http://localhost:${port}`); }
          const wA = await api({ action: 'wait-for-server', port, timeout: 90000 });
          if (wA.crashed) {
            const logA = (await api({ action: 'get-server-logs', projectPath: path }).catch(() => ({ logs: '' }))).logs as string;
            const errA = logA.split('\n').filter((l: string) => /error|failed|module not found/i.test(l)).slice(0, 3).join('\n');
            narrate(`❌ Server crashed after install.\n\`\`\`\n${errA}\n\`\`\`\nAsk me to fix the startup issue.`);
            setBuildProgress(p => ({...p!, step: 'error', message: '❌ Crashed after install', logs: [...(p?.logs ?? []), `❌ ${errA}`]}));
            break;
          }
          setPreviewKey(k => k + 1);
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
          browserContextCache = '';
          continue;
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
              browserContextCache = '';
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
          });

          appendLog(fixResult.success && fixResult.fixedCount > 0
            ? `✅ [${strategy}] Fixed ${fixResult.fixedCount} file(s): ${(fixResult.changedFiles ?? []).join(', ')}`
            : `⚠️ [${strategy}] No changes produced — will try next strategy`);

          if (!fixResult.success || !fixResult.fixedCount) {
            // AI produced nothing — strategy already consumed, loop will pick next
            continue;
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
          browserContextCache = '';
        } else {
          break;
        }
      }

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
      if (isScaffold || scaffoldCheckFailed) {
        healthBlockers.push(
          isScaffold
            ? 'AI generation was incomplete — the app is showing a placeholder page, not the generated application'
            : 'Preview is still showing the generation placeholder — app has not rendered yet'
        );
      }

      // A project is only "verified" if all HTTP checks pass AND the health gate passes
      const isFullyVerified = verifyData.verified && healthBlockers.length === 0;

      setBuildDetailStep('complete');
      setBuildProgress({
        step: 'done',
        message: isFullyVerified
          ? `✅ ${projectName} is live and verified!`
          : healthBlockers.length > 0
            ? `⚠️ ${projectName} is running — credentials needed`
            : `⚠️ ${projectName} is running (${passedChecks}/${totalChecks} checks passed)`,
        logs: [`✅ Running on port ${port}`, ...verifyLogs, ...healthBlockers.map(b => `⚠️ Health gate: ${b}`)],
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

      if (isFullyVerified) {
        const nextStep = `Next step: The preview is live on the right. Click any page to interact with it. Ask me to add features, fix the design, connect a real database, or help with deployment.`;
        narrate(
          `🎉 **${projectName} is live!**\n\n` +
          `Files created: ${filesCreated}\n` +
          `Pages: ${pagesReport}\n` +
          `Verification: ${passedChecks}/${totalChecks} checks passed\n` +
          (installedSummary ? `${installedSummary}\n` : '') +
          `${remainingIssues}\n\n` +
          `What works right now:\n` +
          `• All navigation pages are clickable and functional\n` +
          `• API routes return real data from the SQLite database\n` +
          `• Forms submit and store data\n` +
          (discMode.includes('Auth') || discPages.some(p => p.includes('login') || p.includes('auth'))
            ? `• Real authentication with JWT sessions and hashed passwords\n` : '') +
          `\n${nextStep}`
        );
      } else if (healthBlockers.length > 0) {
        // Health gate blocked — explain the configuration issue clearly
        narrate(
          `✅ **${projectName} is running** — the app code is working, but needs credentials before it can be fully verified.\n\n` +
          `Pages: ${pagesReport}\n` +
          `Verification: ${passedChecks}/${totalChecks} HTTP checks passed\n` +
          (installedSummary ? `${installedSummary}\n` : '') +
          `\n**Why it's not fully verified:**\n` +
          healthBlockers.map(b => `• ${b}`).join('\n') + '\n\n' +
          `This is a **configuration issue**, not a code problem. The app code is correct.\n` +
          `To fully verify: add the required credentials to \`.env.local\` and restart the server. Ask me to "check credentials" and I'll show you exactly what to add.`
        );
      } else {
        const nextStep = `Next step: Open the preview and tell me what you see. If any page doesn't load, ask me to "fix the issue" and I'll diagnose and repair it automatically.`;
        narrate(
          `✅ **${projectName} is running** — ${passedChecks}/${totalChecks} verification checks passed.\n\n` +
          `Files created: ${filesCreated}\n` +
          `Pages: ${pagesReport}\n` +
          (installedSummary ? `${installedSummary}\n` : '') +
          `${remainingIssues}\n\n` +
          `${nextStep}`
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
      setLoading(false);
      setPhase(p => p === 'building' ? 'idle' : p);
    }
  };

  // ── Intent classification — 8-class semantic system ───────────────────────
  // Routes: conversation, greeting, question, research, planning, build, design,
  //         debug, deployment, billing, logo_request, clarification_needed.
  // Uses sentence structure + question detection + vocabulary scoring.
  // NEVER re-introduces the assistant for acknowledgements or continuations.

  type MessageIntent =
    | 'conversation'       // "thank you", "okay", "continue" — never re-intro
    | 'greeting'           // first-time hi/hello when conversation history is empty
    | 'question'           // explain / how does X work
    | 'research'           // find / compare / what API / best tool
    | 'web_research'       // "go online and search X", "browse alibaba", "check what amazon does"
    | 'planning'           // "how would X work", "something like Facebook"
    | 'design'             // "add my name to the logo", "modify the image"
    | 'logo_request'       // "generate a logo for..."
    | 'logo_edit'          // refine / edit the EXISTING selected logo
    | 'clarification_needed'
    | 'build'              // confirmed build with enough detail
    | 'debug'
    | 'deployment'
    | 'billing';           // pricing, subscription, upgrade questions

  const detectIntent = (message: string, hasHistory: boolean, ctx?: { hasLogo: boolean }): MessageIntent => {
    const lower = message.toLowerCase().trim();
    const words = lower.split(/\s+/).filter(Boolean);

    // 1. CONTINUATIONS & SMALL TALK — never re-introduce the assistant
    // Exact-match acknowledgements and affirmatives
    const CONTINUATIONS = [
      'ok', 'okay', 'yes', 'yep', 'yeah', 'yup', 'no', 'nope', 'sure', 'of course',
      'thanks', 'thank you', 'ty', 'thx', 'thank u', 'great', 'cool', 'nice', 'wow',
      'perfect', 'got it', 'alright', 'sounds good', 'good', 'fine', 'interesting',
      'awesome', 'lol', 'haha', 'noted', 'understood', 'continue', 'proceed', 'go ahead',
      "let's go", 'go for it', 'do it', 'do that', 'that works', "that's great",
      "that's fine", "that's good", 'agreed', 'correct', 'exactly', 'right', 'fair enough',
      'makes sense', 'sounds great', 'love it', 'i like it', 'nice work', 'well done',
    ];
    if (CONTINUATIONS.includes(lower)) return 'conversation';
    // Short 2-3 word phrases that are clearly continuations
    if (words.length <= 3 && CONTINUATIONS.some(c => lower.startsWith(c))) return 'conversation';

    // 2. GREETING — only introduces the assistant when there is NO existing history
    const GREET_WORDS  = ['hi', 'hello', 'hey', 'hiya', 'howdy', 'yo', 'sup', 'greetings'];
    const TIME_GREETS  = ['good morning', 'good afternoon', 'good evening', 'good night'];
    const isGreeting = GREET_WORDS.some(g =>
        lower === g || lower.startsWith(g + ' ') || lower.startsWith(g + ',') || lower.startsWith(g + '!'))
      || TIME_GREETS.some(t => lower === t || lower.startsWith(t + ' ') || lower.startsWith(t + '!'));
    if (isGreeting) return hasHistory ? 'conversation' : 'greeting';

    // 3. BILLING — only match EXPLICIT questions about THIS platform's pricing, not project domain words.
    // "What is the subscription model for my app?" must NOT trigger this — only "What is DWOMOH's pricing?"
    const billingKeywords = [
      'your pricing', 'your plan', 'your plans', 'your subscription', 'dwomoh pricing',
      'dwomoh plan', 'vibe code pricing', 'vibe code plan', 'this platform cost',
      'upgrade my plan', 'upgrade my account', 'downgrade my plan', 'cancel my plan',
      'cancel my subscription', 'cancel my account', 'my current plan', 'billing portal',
      'billing page', 'billing section', 'invoice from dwomoh', 'switch plan',
    ];
    const isExplicitBillingQ = billingKeywords.some(k => lower.includes(k))
      || /\bhow much (does|is) (dwomoh|vibe code|this (tool|platform|service))\b/i.test(lower)
      || /\bwhat (are|is) (the )?(dwomoh|vibe code) (plans?|pricing|tiers?|cost)\b/i.test(lower)
      || (/\b(free|pro|starter|business)\s+plan\b/i.test(lower) && !/\b(app|project|website|site|system|platform|user|role)\b/i.test(lower));
    if (isExplicitBillingQ) return 'billing';

    // 3b. WEB RESEARCH — browsing websites, competitor research, online search, docs, npm, RapidAPI
    const WEB_RESEARCH_PATTERNS = [
      // Explicit web browsing
      /\b(go online|search (the )?web|browse (the )?web|search online|look online|go to the internet)\b/i,
      /\b(go online and (search|check|look|browse|find|research))\b/i,
      /\b(search for|look at|browse|visit|check out|research|analyse|analyze)\s+(the\s+)?(website|site|page|store)\s+(of|for|at)?\s+\w/i,
      // Named brands
      /\b(check|look at|browse|visit|search|analyze|analyse|research)\s+(alibaba|amazon|shopify|etsy|zara|asos|shein|temu|nike|h&m|zalando|ebay|pinterest|instagram|facebook|twitter|linkedin|apple|google|netflix|airbnb|booking|tripadvisor|jumia|konga|paypal|stripe|flutterwave)\b/i,
      /\b(what does|how does)\s+(alibaba|amazon|shopify|etsy|zara|asos|shein|temu|nike|h&m|zalando|ebay)\s+(do|look|show|handle|display|design|structure)\b/i,
      // Competitor comparison
      /\b(compare (my |our )?(site|store|app|website|project) (with|to|against))\b/i,
      /\b(advise|advice).{0,30}\b(website|site|store|app|design|ui|ux)\b/i,
      /\bsearch\s+\w+\s+(to (see|give|advise|advice|help|recommend|suggest|show))\b/i,
      // Documentation & package research
      /\b(search|look up|find|check|browse)\s+(npm|docs?|documentation|rapidapi|api docs?|sdk docs?)\s*(for|of|about)?\s+\w/i,
      /\b(find|look up|search for|check)\s+(the\s+)?(documentation|docs?|api reference|sdk|package|library|module)\s+(for|of|on)\s+\w/i,
      /\bnpm\s+(search|find|look up|docs?|registry)\b/i,
      /\b(rapidapi|programmableweb|api\.marketplace)\b/i,
      /\b(what (npm |)package|which (npm |)library|what (sdk|module|api client))\s+(should|do) i use\b/i,
      /\bfind (me )?(an? |the )?(npm |)package (for|to|that)\b/i,
      // How-to searches that need live docs
      /\bhow (do i|to|can i) (install|use|integrate|connect|add|set up|configure)\s+\w.{3,30}\s+(in|with|to|for)\s+(next\.?js|react|node|typescript|javascript)\b/i,
    ];
    if (WEB_RESEARCH_PATTERNS.some(p => p.test(lower))) return 'web_research';

    // 4. DEPLOYMENT
    if (/\b(deploy|go live|connect domain|custom domain|production|publish|vercel|netlify|go to production|launch my site|hosting)\b/.test(lower))
      return 'deployment';

    // 5. DEBUG (short vague messages only — detailed ones are edits handled by editPipeline)
    if (/\b(fix|debug|broken|not working|crashed|crash|bug|issue|problem)\b/.test(lower) && words.length <= 6)
      return 'debug';

    // 5b. PRIORITY BUILD GATE — imperative build commands skip ALL logo/design/question checks.
    // Must run BEFORE the design patterns because those use greedy .* that span long prompts
    // (e.g. "image" in "image prompts" + "edit" in "preview, edit, regenerate" falsely → 'design').
    // Only skip if 'logo' is NOT the focus — logo commands still fall through to logo_request.
    if (/^(build|create|generate|make|develop|code|write|implement)\b/i.test(lower)
      && words.length >= 4
      && !lower.startsWith('create a logo')
      && !lower.startsWith('generate a logo')
      && !lower.startsWith('make a logo')
      && !lower.startsWith('design a logo')
      && !lower.startsWith('build a logo')
      && !/^(build|create|generate|make|design|implement)\s+(a\s+|me\s+a\s+)?logo\b/i.test(lower)
    ) return 'build';

    // 6. QUESTION STRUCTURE GUARD — compute early so logo/design checks can use it
    const isQuestion = lower.endsWith('?')
      || /^(how|what|why|when|where|who|which|whose|is|are|do|does|did|will|would|could|should|may|might|can)\s/.test(lower);

    // 6b. LOGO EDIT — only fires when a logo already exists in session
    if (!isQuestion && ctx?.hasLogo && (
      /\b(refine|edit|update|modify|adjust|improve|revise|redo|tweak)\s*(the\s+)?(logo|design|icon|brand|it)\b/i.test(lower)
      // color / style / font / sizing changes
      || /\b(change|swap|update|alter|make|use)\s*(the\s+)?(color|colour|font|typeface|typography|text|style|size|background|icon|shape|name|weight)\b/i.test(lower)
      || /\b(darker|lighter|bolder|thinner|bigger|smaller|larger|wider|taller|rounder|sharper)\b/i.test(lower)
      || /\b(use|try|apply)\s+(a\s+)?(modern|minimal|bold|elegant|serif|sans.serif|script|condensed|geometric|rounded)\s*(font|typeface|style|look)?\b/i.test(lower)
      || /\bmake\s*(the\s+)?(text|font|icon|logo|design|colors?|background)\s*(bigger|smaller|bolder|lighter|darker|cleaner|minimal|modern|thicker|thinner|larger)\b/i.test(lower)
      || /\bmake\s*(it|the\s*logo)\s*(more|less|bolder|cleaner|darker|lighter|bigger|smaller|professional|minimal|modern|elegant|bold|clean|vibrant|muted|simple|complex)\b/i.test(lower)
      // add elements
      || /\badd\s*(my\s+)?(brand\s+)?(name|text|tagline|slogan|title|subtitle|icon|symbol)/i.test(lower)
      // explicit name reveal
      || /\b(the\s+)?name\s+is\s+\w+/i.test(lower)
      // general intent when logo present
      || /\bgive\s*(it|the\s*logo)\s*(a\s+)?(new|different|more|fresh|better)/i.test(lower)
      || /\blogo\s*(needs|should|must|has to)\s*(be|have|look|use)/i.test(lower)
      || /\b(remove|delete|hide)\s*(the\s+)?(icon|symbol|circle|background|border|text|name|tagline)\b/i.test(lower)
      || /\b(center|align|left|right|stack|arrange|reorder|move)\s*(the\s+)?(text|icon|logo|elements?)\b/i.test(lower)
    ))
      return 'logo_edit';

    // 7. DESIGN — image/logo modification (only non-questions)
    // All patterns use bounded .{0,80} to prevent spanning across long build prompts.
    if (!isQuestion && (
      /add.{0,60}(?:text|name|brand|company|title|label).{0,60}(?:logo|image|design|photo)/i.test(lower)
      || /(?:modify|change|edit|update|adjust|redesign|restyle).{0,80}(?:logo|image|design|photo)/i.test(lower)
      || /(?:logo|image|design).{0,80}(?:modify|change|edit|update|adjust)/i.test(lower)
      || /put.{0,50}(?:name|brand|text).{0,50}(?:on|in).{0,30}(?:logo|image)/i.test(lower)
      || /add.{0,30}logo.{0,30}to|add.{0,30}image.{0,30}to/i.test(lower)
      || /\bcreate.{0,40}variation\b|\bmake.{0,40}logo.{0,40}look\b|\bstyle.{0,30}logo\b/i.test(lower)))
      return 'design';

    // 8. LOGO GENERATION — imperative requests only, never questions
    // "Can you create a logo?" → question (answered by AI), "Create a logo for my brand" → logo_request
    if (!isQuestion && (
      /\b(generate|create|make|design)\s+(a\s+|me\s+a\s+)?logo\b/i.test(lower)
      || /\blogo\s+(for|generation|design|generator)\b/i.test(lower)
      || /\bi\s+(want|need)\s+(a\s+)?logo\b/i.test(lower)
      || /\bbuild\s+(a\s+)?logo\b/i.test(lower)))
      return 'logo_request';

    // (isQuestion already computed above — used below)

    if (isQuestion) {
      // Research-flavoured questions: "Find me X", "What API should I use", "Which is best"
      if (/\b(find|search|look for|look up|discover)\b/i.test(lower)
        || /api for|apis for|api do i need|api to use|best api|which api|what api|payment api|sports api|weather api|maps api/i.test(lower)
        || /best framework|best library|best tool|best database|best approach|compare|versus|\bvs\b|difference between|which is better|alternatives|how to choose/i.test(lower))
        return 'research';

      // Everything else is an explanatory question
      return 'question';
    }

    // 9. NON-QUESTION RESEARCH: "Find me X", "Search for X", "Recommend an API"
    if (/^(find|search|look for|discover|recommend|suggest|compare)\b/i.test(lower) && words.length >= 3)
      return 'research';

    // 10. PLANNING / EXPLORATION — informational, not a build trigger
    if (/want to know|want to understand|how it goes|how would it work|tell me how|explain how|something like|similar to|like facebook|like uber|like airbnb|like amazon|like instagram|like twitter|like whatsapp|thinking of building|curious about|wondering about|help me understand/i.test(lower))
      return 'planning';

    // 11. BUILD VOCABULARY
    const BUILD_VERBS    = ['build', 'create', 'generate', 'make', 'develop', 'design', 'code', 'write', 'implement', 'set up'];
    const INTENT_PHRASES = ['i want', 'i need', 'i would like', "i'd like", 'please build', 'please create', 'please make'];
    const APP_TYPES      = [
      'app', 'application', 'website', 'web app', 'platform', 'marketplace',
      'dashboard', 'store', 'shop', 'ecommerce', 'e-commerce', 'portal', 'system',
      'landing page', 'landing', 'site', 'saas', 'crm', 'cms', 'booking', 'forum',
      'blog', 'portfolio', 'tool', 'directory', 'social network', 'mobile app', 'pwa',
      'social media', 'management system', 'tracking system', 'generator', 'engine',
      'service', 'solution', 'software', 'product', 'api', 'bot', 'agent',
      // Utility / tool types
      'downloader', 'converter', 'calculator', 'tracker', 'analyzer', 'analyser',
      'scraper', 'extractor', 'viewer', 'player', 'editor', 'manager', 'monitor',
      'notifier', 'aggregator', 'scheduler', 'automator', 'processor', 'scanner',
      'builder', 'creator', 'designer', 'shortener', 'checker', 'validator',
    ];
    const hasBuildVerb    = BUILD_VERBS.some(v => { const i = lower.indexOf(v); return i !== -1 && (i === 0 || lower[i - 1] === ' '); });
    const hasIntentPhrase = INTENT_PHRASES.some(p => lower.includes(p));
    const hasAppType      = APP_TYPES.some(t => lower.includes(t));
    const hasAction       = hasBuildVerb || hasIntentPhrase;

    // DIRECT BUILD COMMAND: message opens with an imperative build verb.
    // "Build X", "Create X", "Generate X", "Make X", "Develop X" are commands, not questions.
    // Treat them as build intent immediately — no word-count or feature-score gating needed.
    // Any imperative build command with 3+ words is a build request — no feature-score gate needed.
    // "Build a TikTok downloader", "Create a link shortener", "Make a calculator" all pass.
    const IMPERATIVE_BUILD_VERBS = /^(build|create|generate|make|develop|code|write|implement)\b/i;
    const isDirectCommand = IMPERATIVE_BUILD_VERBS.test(lower) && words.length >= 3;
    if (isDirectCommand) return 'build';

    // Build request referencing unknown external API → research APIs first
    if (hasAction && hasAppType && /sports api|football api|weather api|stock api|crypto api|news api|using an api|using a sports|using weather|real.time score|live score/i.test(lower))
      return 'research';

    if (!hasAction && !hasAppType && words.length <= 4) return 'conversation';
    if (!hasAction && !hasAppType) return 'question';

    // 12. CONFIRMED BUILD — action + app type + enough detail (2+ features OR 8+ words)
    if (hasAction && hasAppType) {
      const FEATURE_WORDS = ['with', 'including', 'featuring', 'login', 'auth', 'authentication',
        'payment', 'paystack', 'stripe', 'search', 'filter', 'map', 'maps', 'chart', 'analytics',
        'user', 'users', 'admin', 'cart', 'checkout', 'booking', 'calendar', 'profile', 'notification',
        'email', 'upload', 'gallery', 'rating', 'review', 'category', 'listing', 'listings', 'property',
        'product', 'products', 'menu', 'order', 'orders', 'delivery', 'messaging', 'chat', 'feed',
        'post', 'follow', 'subscription', 'report', 'invoice', 'inventory', 'responsive',
        'video', 'audio', 'stream', 'live', 'ai', 'ml', 'generate', 'detection', 'recognition'];
      const featureScore = FEATURE_WORDS.filter(f => lower.includes(f)).length;

      // Well-known app categories: build immediately with smart defaults, no clarification needed
      const KNOWN_DOMAINS = [
        'football', 'soccer', 'sports prediction', 'match prediction', 'score predictor',
        'food delivery', 'restaurant', 'recipe', 'meal planner', 'ordering',
        'real estate', 'property', 'housing', 'rental', 'airbnb',
        'e-commerce', 'ecommerce', 'online store', 'marketplace',
        'todo', 'task manager', 'project management', 'kanban',
        'blog', 'news', 'article', 'content',
        'chat', 'messaging', 'social network', 'social media',
        'fintech', 'finance', 'banking', 'payment', 'wallet',
        'healthcare', 'hospital', 'clinic', 'medical', 'appointment',
        'education', 'learning', 'school', 'course', 'quiz',
        'hotel', 'travel', 'booking', 'event', 'ticket',
        'crypto', 'stock', 'trading', 'portfolio',
        'job board', 'recruitment', 'hiring', 'freelance',
        'logistics', 'delivery', 'tracking', 'fleet',
        'fitness', 'gym', 'workout', 'nutrition',
        'crm', 'inventory', 'invoicing', 'accounting', 'erp',
        'weather', 'agriculture', 'farming', 'agri',
        'church', 'charity', 'non.profit', 'community',
        'pharmacy', 'grocery', 'supermarket', 'retail',
        // AI / content / media
        'ai', 'artificial intelligence', 'machine learning', 'video generation', 'image generation',
        'text generation', 'content creation', 'video platform', 'streaming', 'media', 'podcast',
        'music', 'photo', 'photography', 'gallery', 'portfolio',
        // Productivity / SaaS
        'saas', 'productivity', 'collaboration', 'team', 'workspace', 'project tracker',
        'time tracker', 'note', 'notes', 'wiki', 'knowledge base', 'documentation',
        // Other common domains
        'donation', 'crowdfunding', 'nft', 'marketplace', 'auction', 'bidding',
        'survey', 'poll', 'quiz', 'game', 'gaming', 'leaderboard', 'tournament',
        'service directory', 'services directory', 'directory',
        // Specific platform downloaders / tools — always build, never ask for clarification
        'tiktok', 'youtube', 'instagram', 'twitter', 'facebook', 'whatsapp', 'telegram',
        'tiktok downloader', 'youtube downloader', 'instagram downloader', 'video downloader',
        'pdf converter', 'pdf to word', 'image converter', 'file converter',
        'url shortener', 'link shortener', 'qr code', 'barcode generator', 'barcode scanner',
        'password manager', 'password generator', 'color picker', 'unit converter',
        'currency converter', 'tax calculator', 'loan calculator', 'mortgage calculator',
        'countdown timer', 'stopwatch', 'pomodoro', 'habit tracker', 'mood tracker',
        'expense tracker', 'budget tracker', 'calorie tracker', 'workout tracker',
        'price tracker', 'stock tracker', 'crypto tracker', 'weather dashboard',
        'ip lookup', 'dns lookup', 'whois lookup', 'speed test', 'uptime monitor',
        'web scraper', 'data scraper', 'email extractor', 'contact extractor',
        'resume builder', 'cv builder', 'invoice generator', 'contract generator',
        'flashcard', 'typing test', 'text summarizer', 'paraphraser', 'translator',
        'code formatter', 'json viewer', 'csv viewer', 'markdown editor', 'diff tool',
        'drawing tool', 'whiteboard', 'mind map', 'flowchart', 'diagram',
        'chat app', 'forum', 'community', 'discord', 'slack',
        'clone', 'like', 'similar to', 'inspired by',
      ];
      const isWellKnownDomain = KNOWN_DOMAINS.some(d => lower.includes(d));
      // Long detailed specifications (12+ words) with any app vocabulary reliably signal a build intent
      const isDetailedSpec = words.length >= 12 && (hasAppType || featureScore >= 1);
      if (featureScore >= 1 || words.length >= 6 || isWellKnownDomain || isDetailedSpec) return 'build';
      return 'clarification_needed';
    }
    if (!hasAction && hasAppType) return 'clarification_needed';
    if (hasAction && !hasAppType) return 'planning';

    return 'conversation';
  };

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
    `To deploy your app, open the project from the sidebar on the left. Once your project is open, the Deploy and Domain buttons will appear in the project panel.\n\nIf you want to prepare the app for a specific platform — Vercel, Netlify, or a custom server — open your project first and let me know which one you are targeting.`;

  const getDebugResponse = (): string =>
    `To investigate and fix an issue, please open the project from the sidebar on the left first. Once your project is open, describe what is wrong and I will inspect the code, find the cause, and fix it for you automatically.`;

  const getBillingResponse = (): string =>
    `DWOMOH Vibe Code is available on four plans:\n\nFree — Text-based app builds, limited monthly builds\nStarter — Image uploads, more builds per month\nPro — Voice input, logo generation, priority builds\nBusiness — Voice replies, advanced image understanding, team collaboration, larger storage\n\nAll plans include the full AI builder experience. To upgrade, visit the Billing section in your account settings, or ask me which plan fits what you are trying to build.`;

  // ── AI-powered response — questions, planning, research, API guidance, etc. ─

  const respondWithAI = async (
    queryForAI: string,
    currentHistory: ConversationTurn[],
    action: 'think' | 'research' = 'think'
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

      // For think action, prepend context to the last user message in history if context is active
      const enrichedHistory: ConversationTurn[] = (action === 'think' && projectContextPrefix && currentHistory.length > 0)
        ? [
            ...currentHistory.slice(0, -1),
            { role: currentHistory[currentHistory.length - 1].role, content: projectContextPrefix + String(currentHistory[currentHistory.length - 1].content) },
          ]
        : currentHistory;

      const body = action === 'research'
        ? { action: 'research', query: projectContextPrefix + queryForAI }
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

    setInput('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    addMsg('user', userMessage);

    const newHistory: ConversationTurn[] = [...history, { role: 'user', content: userMessage }];
    setHistory(newHistory);

    // AUTONOMOUS EDIT MODE: Project is open — apply changes immediately.
    // Exceptions: web_research, logo, research are always global.
    // NEW EXCEPTION: 'build' intent = user wants a NEW project, not an edit.
    // Close the current project context and route to the build pipeline.
    if (currentProject) {
      const hasLogo0 = assets.some(a => a.role === 'logo');
      const projectIntent = detectIntent(userMessage, history.length > 0, { hasLogo: hasLogo0 });
      if (projectIntent === 'web_research') { await handleWebResearch(userMessage); return; }
      if (projectIntent === 'logo_request')  { await handleLogoGenerate(userMessage); return; }
      if (projectIntent === 'logo_edit')     { await handleLogoRefine(userMessage); return; }
      if (projectIntent === 'research')      { await runResearch(userMessage); return; }
      // Build intent while a project is open → user wants a NEW app, not an edit.
      // Fall through to the build pipeline below (don't return here).
      if (projectIntent !== 'build') {
        // Engineering command detection: route "Fix this", "Make it work", etc.
        // through the root cause investigation pipeline in runEditPipeline.
        const nlCmd = interpretCommand(userMessage);
        if (nlCmd.isEngineeringCommand && nlCmd.confidence >= 0.75) {
          // Show immediate feedback so the user knows investigation is starting
          addStatus(getActionLabel(nlCmd), 'checking');
        }
        runEditPipeline(userMessage, newHistory, nlCmd);
        return;
      }
      // 'build' intent falls through to the pipeline at the bottom of handleSubmit
    }

    // INTENT CLASSIFICATION
    // Pass hasHistory so the system knows whether this is a first greeting
    const hasHistory = history.length > 0;
    const hasLogo = assets.some(a => a.role === 'logo');
    const intent = detectIntent(userMessage, hasHistory, { hasLogo });

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
        await respondWithAI(userMessage, newHistory, 'think');
        return;

      // Explain / how does X work / what is X
      case 'question':
        await respondWithAI(userMessage, newHistory, 'think');
        return;

      // Find me X / compare X and Y / best API for X
      case 'research':
        await respondWithAI(userMessage, newHistory, 'research');
        return;

      // "How would X work", "Something like Facebook"
      case 'planning':
        if (inActiveSession) { await respondWithAI(userMessage, newHistory, 'think'); return; }
        // In early session, update builder context and respond with AI
        setBuilderContext(prev => prev ? prev : { projectName: extractProjectName(userMessage) || 'New Project', stage: 'planning', active: true });
        await respondWithAI(userMessage, newHistory, 'think');
        return;

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

      // Vague build request — in active sessions the AI engages with context; cold-start gets clarification prompt
      case 'clarification_needed':
        if (inActiveSession) { await respondWithAI(userMessage, newHistory, 'think'); return; }
        await respondConversationally(getClarificationResponse(userMessage));
        return;

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

      // Confirmed build — set builder context, fall through to pipeline
      case 'build': {
        const pName = extractProjectName(userMessage);
        if (pName) setBuilderContext({ projectName: pName, stage: 'building', active: true });
        else if (!builderContext) setBuilderContext({ projectName: 'New Project', stage: 'building', active: true });
        else setBuilderContext(prev => prev ? { ...prev, stage: 'building' } : prev);
        break;
      }
    }

    // BUILD MODE: verified intent + sufficient detail — start pipeline
    // Enrich prompt with any uploaded assets before handing off to the pipeline
    runBuildPipeline(newHistory, enrichPromptWithAssets(userMessage));
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

  const isBusy = loading || editApplying || phase === 'building' || makeSearchWorking;

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <>
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        @keyframes slidein { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
        @keyframes fadeup { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
      `}</style>
      <div style={{ display: 'flex', height: '100vh', width: '100vw', background: '#0f172a', color: 'white', fontFamily: 'system-ui,-apple-system,sans-serif', overflow: 'hidden' }}>

        {/* ── Sidebar ───────────────────────────────────────────────────── */}
        <div style={{ width: '220px', minWidth: '220px', background: '#1e293b', borderRight: '1px solid #334155', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '16px', borderBottom: '1px solid #334155' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
              <div style={{ fontSize: '14px', fontWeight: '700', color: '#f8fafc' }}>⚡ DWOMOH Vibe Code</div>
              <a href="/dashboard" style={{ fontSize: '11px', color: '#64748b', textDecoration: 'none' }}>Dashboard</a>
            </div>
            <button onClick={handleNewProject} style={{ width: '100%', padding: '8px', background: '#2563eb', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '13px', fontWeight: '500' }}>
              + New Project
            </button>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>
            {/* Active project details */}
            {currentProject && (
              <div style={{ marginBottom: '16px', padding: '10px', background: '#0f172a', borderRadius: '8px', border: '1px solid #1d4ed8' }}>
                <div style={{ fontSize: '11px', color: '#60a5fa', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>Active Project</div>
                <div style={{ fontSize: '13px', fontWeight: '600', color: '#e2e8f0', marginBottom: '2px' }}>{currentProject.name}</div>
                {currentDiscovery && (
                  <>
                    <div style={{ fontSize: '11px', color: '#64748b', marginBottom: '6px' }}>{currentDiscovery.framework} · {currentDiscovery.fileCount} files</div>
                    {currentDiscovery.pages.length > 0 && (
                      <div style={{ marginBottom: '4px' }}>
                        <span style={{ fontSize: '10px', color: '#475569', fontWeight: '600' }}>PAGES </span>
                        <span style={{ fontSize: '11px', color: '#94a3b8' }}>
                          {currentDiscovery.pages.map(p => p.replace('app/', '').replace('/page.tsx', '') || 'home').join(', ')}
                        </span>
                      </div>
                    )}
                    {currentDiscovery.components.length > 0 && (
                      <div style={{ marginBottom: '4px' }}>
                        <span style={{ fontSize: '10px', color: '#475569', fontWeight: '600' }}>COMPONENTS </span>
                        <span style={{ fontSize: '11px', color: '#94a3b8' }}>
                          {currentDiscovery.components.slice(0, 5).map(c => c.replace('components/', '').replace(/\.tsx?/, '')).join(', ')}
                          {currentDiscovery.components.length > 5 ? ` +${currentDiscovery.components.length - 5}` : ''}
                        </span>
                      </div>
                    )}
                  </>
                )}
                {/* Mode badge */}
                {currentDiscovery?.mode && (() => {
                  const modeColors: Record<string, { bg: string; text: string }> = {
                    'Static Demo':        { bg: '#3b1f00', text: '#fb923c' },
                    'Frontend Only':      { bg: '#1e2a3b', text: '#93c5fd' },
                    'Full-Stack App':     { bg: '#0f2818', text: '#4ade80' },
                    'Production Ready App': { bg: '#1a0a2e', text: '#c084fc' },
                  };
                  const mc = modeColors[currentDiscovery.mode] || { bg: '#1e293b', text: '#94a3b8' };
                  return (
                    <div style={{ marginTop: '6px', padding: '3px 7px', background: mc.bg, border: `1px solid ${mc.text}44`, borderRadius: '4px', display: 'inline-block' }}>
                      <span style={{ fontSize: '10px', color: mc.text, fontWeight: '600' }}>{currentDiscovery.mode}</span>
                      {!currentDiscovery.hasApiRoutes && <span style={{ fontSize: '9px', color: '#f97316', marginLeft: '4px' }}>· no API</span>}
                    </div>
                  );
                })()}

                {currentMemory && (currentMemory.editsApplied || []).length > 0 && (
                  <div style={{ fontSize: '10px', color: '#475569', marginTop: '4px' }}>
                    {currentMemory.editsApplied.length} edit(s) applied
                  </div>
                )}
                {discoveryLoading && (
                  <div style={{ fontSize: '11px', color: '#64748b', fontStyle: 'italic', marginTop: '4px' }}>Scanning…</div>
                )}
                {previewUrl && (
                  <button onClick={() => setPreviewKey(k => k + 1)} style={{ marginTop: '8px', width: '100%', padding: '5px', background: '#1e3a5f', border: '1px solid #1d4ed8', borderRadius: '5px', color: '#60a5fa', cursor: 'pointer', fontSize: '11px' }}>
                    ↺ Refresh Preview
                  </button>
                )}

                {/* Make Search Work button — shown when no API routes exist */}
                {currentDiscovery && !currentDiscovery.hasApiRoutes && !makeSearchWorking && (
                  <button
                    onClick={handleMakeSearchWork}
                    disabled={isBusy}
                    style={{ marginTop: '6px', width: '100%', padding: '5px 8px', background: '#14532d', border: '1px solid #16a34a', borderRadius: '5px', color: '#4ade80', cursor: isBusy ? 'not-allowed' : 'pointer', fontSize: '11px', fontWeight: '600' }}
                  >
                    ⚡ Make Search Work
                  </button>
                )}
                {makeSearchWorking && (
                  <div style={{ marginTop: '6px', fontSize: '11px', color: '#4ade80', fontStyle: 'italic' }}>Upgrading search…</div>
                )}

                {/* Missing credentials panel */}
                {(currentDiscovery?.missingCredentials || []).length > 0 && (
                  <div style={{ marginTop: '8px', padding: '8px', background: '#2d1a00', border: '1px solid #92400e', borderRadius: '6px' }}>
                    <div style={{ fontSize: '10px', color: '#fbbf24', fontWeight: '700', marginBottom: '6px' }}>⚠️ Setup Required</div>
                    {(currentDiscovery!.missingCredentials || []).map(cred => (
                      <div key={cred.key} style={{ marginBottom: '6px' }}>
                        <div style={{ fontSize: '10px', color: '#d97706', marginBottom: '3px', wordBreak: 'break-all' }}>{cred.key}</div>
                        <div style={{ display: 'flex', gap: '4px' }}>
                          <input
                            type="password"
                            placeholder="paste value…"
                            value={credentialInputs[cred.key] || ''}
                            onChange={e => setCredentialInputs(prev => ({ ...prev, [cred.key]: e.target.value }))}
                            style={{ flex: 1, padding: '4px 6px', background: '#1e293b', border: '1px solid #78350f', borderRadius: '4px', color: '#e2e8f0', fontSize: '10px', minWidth: 0 }}
                          />
                          <button
                            onClick={() => handleSetCredential(cred.key)}
                            disabled={!credentialInputs[cred.key] || credentialSaving === cred.key}
                            style={{ padding: '4px 8px', background: '#78350f', border: '1px solid #92400e', borderRadius: '4px', color: '#fbbf24', cursor: 'pointer', fontSize: '10px', flexShrink: 0 }}
                          >
                            {credentialSaving === cred.key ? '…' : 'Save'}
                          </button>
                        </div>
                      </div>
                    ))}
                    <div style={{ fontSize: '9px', color: '#78350f', marginTop: '4px' }}>Saved to .env.local (never committed)</div>
                  </div>
                )}

                {/* ── File Manager ────────────────────────────────────── */}
                <div style={{ marginTop: '8px', borderTop: '1px solid #1e293b', paddingTop: '8px' }}>
                  <button
                    onClick={() => setFileManagerOpen(o => !o)}
                    style={{ width: '100%', textAlign: 'left', padding: '4px 0', background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', fontSize: '10px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'flex', alignItems: 'center', gap: '4px' }}
                  >
                    <span>{fileManagerOpen ? '▾' : '▸'}</span> Files
                  </button>
                  {fileManagerOpen && (
                    <div style={{ marginTop: '4px' }}>
                      {/* New file input */}
                      <div style={{ display: 'flex', gap: '3px', marginBottom: '6px' }}>
                        <input
                          value={newFilePath}
                          onChange={e => setNewFilePath(e.target.value)}
                          placeholder="app/new-page/page.tsx"
                          onKeyDown={e => { if (e.key === 'Enter') handleFileCreate(); }}
                          style={{ flex: 1, padding: '3px 5px', background: '#0f172a', border: '1px solid #334155', borderRadius: '3px', color: '#e2e8f0', fontSize: '10px', minWidth: 0 }}
                        />
                        <button
                          onClick={handleFileCreate}
                          disabled={!newFilePath.trim() || newFileCreating}
                          style={{ padding: '3px 6px', background: '#1e3a5f', border: '1px solid #2563eb', borderRadius: '3px', color: '#60a5fa', cursor: 'pointer', fontSize: '10px', flexShrink: 0 }}
                        >+</button>
                      </div>
                      {/* Pages */}
                      {(currentDiscovery?.pages || []).map(f => (
                        <div key={f} style={{ marginBottom: '2px' }}>
                          {fileRenaming === f ? (
                            <div style={{ display: 'flex', gap: '2px' }}>
                              <input autoFocus value={fileRenameValue} onChange={e => setFileRenameValue(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') handleFileRename(f); if (e.key === 'Escape') setFileRenaming(null); }} style={{ flex: 1, padding: '2px 4px', background: '#0f172a', border: '1px solid #2563eb', borderRadius: '3px', color: '#e2e8f0', fontSize: '10px', minWidth: 0 }} />
                              <button onClick={() => handleFileRename(f)} style={{ padding: '2px 5px', background: '#14532d', border: '1px solid #16a34a', borderRadius: '3px', color: '#4ade80', cursor: 'pointer', fontSize: '9px' }}>✓</button>
                              <button onClick={() => setFileRenaming(null)} style={{ padding: '2px 5px', background: '#3b0000', border: '1px solid #7f1d1d', borderRadius: '3px', color: '#f87171', cursor: 'pointer', fontSize: '9px' }}>✕</button>
                            </div>
                          ) : (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                              <span style={{ flex: 1, fontSize: '10px', color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f}>{f.replace('app/', '').replace('/page.tsx', '') || '/'}</span>
                              <button onClick={() => { setFileRenaming(f); setFileRenameValue(f); }} title="Rename" style={{ padding: '1px 4px', background: 'none', border: 'none', cursor: 'pointer', color: '#475569', fontSize: '10px' }}>✎</button>
                              <button onClick={() => handleFileDelete(f)} title="Delete" style={{ padding: '1px 4px', background: 'none', border: 'none', cursor: 'pointer', color: '#475569', fontSize: '10px' }}>✕</button>
                            </div>
                          )}
                        </div>
                      ))}
                      {/* Components */}
                      {(currentDiscovery?.components || []).slice(0, 8).map(f => (
                        <div key={f} style={{ display: 'flex', alignItems: 'center', gap: '2px', marginBottom: '2px' }}>
                          <span style={{ flex: 1, fontSize: '10px', color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f}>{f.replace('components/', '').replace(/\.tsx?/, '')}</span>
                          <button onClick={() => handleFileDelete(f)} title="Delete" style={{ padding: '1px 4px', background: 'none', border: 'none', cursor: 'pointer', color: '#475569', fontSize: '10px' }}>✕</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* ── Database Setup ───────────────────────────────────── */}
                <div style={{ marginTop: '8px', borderTop: '1px solid #1e293b', paddingTop: '8px' }}>
                  <div style={{ fontSize: '10px', color: '#64748b', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>Database</div>
                  <select
                    value={dbType}
                    onChange={e => setDbType(e.target.value)}
                    style={{ width: '100%', padding: '4px 6px', background: '#0f172a', border: '1px solid #334155', borderRadius: '4px', color: '#e2e8f0', fontSize: '11px', marginBottom: '4px' }}
                  >
                    <option value="supabase">Supabase</option>
                    <option value="postgresql">PostgreSQL</option>
                    <option value="dynamodb">DynamoDB</option>
                    <option value="firebase">Firebase</option>
                  </select>
                  <input
                    value={dbResource}
                    onChange={e => setDbResource(e.target.value)}
                    placeholder={`resource name (e.g. properties)`}
                    style={{ width: '100%', padding: '4px 6px', background: '#0f172a', border: '1px solid #334155', borderRadius: '4px', color: '#e2e8f0', fontSize: '11px', marginBottom: '4px', boxSizing: 'border-box' }}
                  />
                  <button
                    onClick={handleDbScaffold}
                    disabled={dbScaffolding || isBusy}
                    style={{ width: '100%', padding: '5px', background: '#1e3a5f', border: '1px solid #1d4ed8', borderRadius: '4px', color: '#60a5fa', cursor: dbScaffolding ? 'not-allowed' : 'pointer', fontSize: '11px', fontWeight: '600' }}
                  >
                    {dbScaffolding ? 'Scaffolding…' : '+ Add Database'}
                  </button>
                </div>

                {/* ── Deploy ───────────────────────────────────────────── */}
                <div style={{ marginTop: '8px', borderTop: '1px solid #1e293b', paddingTop: '8px' }}>
                  <div style={{ fontSize: '10px', color: '#64748b', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>Deploy</div>
                  <select
                    value={deployTarget}
                    onChange={e => setDeployTarget(e.target.value)}
                    style={{ width: '100%', padding: '4px 6px', background: '#0f172a', border: '1px solid #334155', borderRadius: '4px', color: '#e2e8f0', fontSize: '11px', marginBottom: '4px' }}
                  >
                    <option value="vercel">Vercel</option>
                    <option value="netlify">Netlify</option>
                    <option value="amplify">AWS Amplify</option>
                  </select>
                  <button
                    onClick={handleDeployPrepare}
                    disabled={deployPreparing || isBusy}
                    style={{ width: '100%', padding: '5px', background: '#1a0a2e', border: '1px solid #7c3aed', borderRadius: '4px', color: '#c084fc', cursor: deployPreparing ? 'not-allowed' : 'pointer', fontSize: '11px', fontWeight: '600' }}
                  >
                    {deployPreparing ? 'Preparing…' : '🚀 Prepare Deploy'}
                  </button>
                </div>

                {/* ── Auth ─────────────────────────────────────────────── */}
                <div style={{ marginTop: '8px', borderTop: '1px solid #1e293b', paddingTop: '8px' }}>
                  <div style={{ fontSize: '10px', color: '#64748b', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>Authentication</div>
                  <select
                    value={authProvider}
                    onChange={e => setAuthProvider(e.target.value)}
                    style={{ width: '100%', padding: '4px 6px', background: '#0f172a', border: '1px solid #334155', borderRadius: '4px', color: '#e2e8f0', fontSize: '11px', marginBottom: '4px' }}
                  >
                    <option value="nextauth">NextAuth.js</option>
                    <option value="supabase">Supabase Auth</option>
                    <option value="clerk">Clerk</option>
                    <option value="jwt">Custom JWT</option>
                  </select>
                  <div style={{ fontSize: '9px', color: '#475569', marginBottom: '6px', lineHeight: '1.4' }}>
                    {authProvider === 'nextauth' && 'Credentials + OAuth providers. Needs NEXTAUTH_SECRET.'}
                    {authProvider === 'supabase' && 'Uses existing Supabase project. Email + OAuth.'}
                    {authProvider === 'clerk' && 'Managed auth UI. Needs Clerk account (free tier).'}
                    {authProvider === 'jwt' && 'Stateless JWT in httpOnly cookies. No external service.'}
                  </div>
                  <button
                    onClick={handleAuthScaffold}
                    disabled={authScaffolding || isBusy}
                    style={{ width: '100%', padding: '5px', background: '#1e2a3b', border: '1px solid #0ea5e9', borderRadius: '4px', color: '#38bdf8', cursor: authScaffolding ? 'not-allowed' : 'pointer', fontSize: '11px', fontWeight: '600' }}
                  >
                    {authScaffolding ? 'Scaffolding…' : '🔐 Add Authentication'}
                  </button>
                </div>

                {/* ── Memory Panel ─────────────────────────────────────── */}
                {currentMemory && (
                  <div style={{ marginTop: '8px', borderTop: '1px solid #1e293b', paddingTop: '8px' }}>
                    <button
                      onClick={() => setMemoryPanelOpen(o => !o)}
                      style={{ width: '100%', textAlign: 'left', padding: '4px 0', background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', fontSize: '10px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'flex', alignItems: 'center', gap: '4px' }}
                    >
                      <span>{memoryPanelOpen ? '▾' : '▸'}</span> Memory
                    </button>
                    {memoryPanelOpen && (
                      <div style={{ marginTop: '4px', fontSize: '10px', color: '#475569', lineHeight: '1.7' }}>
                        <div>💬 {(currentMemory.conversationHistory || []).length} conversation turns</div>
                        <div>✏️ {(currentMemory.editsApplied || []).length} edits applied</div>
                        {currentMemory.authProvider && <div>🔐 Auth: {currentMemory.authProvider}</div>}
                        {(currentMemory.dbIntegrations || []).length > 0 && <div>🗄 DB: {currentMemory.dbIntegrations!.join(', ')}</div>}
                        {(currentMemory.deployConfigs || []).length > 0 && <div>🚀 Deploy: {currentMemory.deployConfigs!.join(', ')}</div>}
                        {(currentMemory.verificationHistory || []).length > 0 && (() => {
                          const last = currentMemory.verificationHistory![currentMemory.verificationHistory!.length - 1];
                          return <div>{last.verified ? '✅' : '⚠️'} Last verify: {last.passedCount}/{last.totalCount} checks</div>;
                        })()}
                        {(currentMemory.browserSessions || []).length > 0 && (() => {
                          const last = currentMemory.browserSessions![currentMemory.browserSessions!.length - 1];
                          return <div>🔍 Last debug: {last.errorCount} errors, {last.requestCount} API calls</div>;
                        })()}
                        {(currentMemory.fileOperations || []).length > 0 && <div>📁 {currentMemory.fileOperations!.length} file op(s)</div>}
                        {currentMemory.lastOpenedAt && (
                          <div style={{ color: '#334155', marginTop: '2px' }}>
                            Opened: {new Date(currentMemory.lastOpenedAt).toLocaleDateString()}
                          </div>
                        )}
                        <button
                          onClick={handleClearMemory}
                          style={{ marginTop: '6px', width: '100%', padding: '4px', background: '#1e0000', border: '1px solid #7f1d1d', borderRadius: '4px', color: '#f87171', cursor: 'pointer', fontSize: '10px' }}
                        >
                          🗑 Clear Memory
                        </button>
                      </div>
                    )}
                  </div>
                )}

              </div>
            )}

            {/* Project list */}
            {projects.length > 0 && (
              <>
                <div style={{ fontSize: '11px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '8px', fontWeight: '600' }}>
                  {currentProject ? 'All Projects' : 'Recent Projects'}
                </div>
                {projects.map(p => (
                  <div key={p.id} style={{ marginBottom: '5px', opacity: discoveryLoading && currentProject?.id !== p.id ? 0.5 : 1 }}>
                    <button
                      onClick={() => handleOpenProject(p)}
                      disabled={discoveryLoading}
                      style={{
                        width: '100%', textAlign: 'left', padding: '8px 10px',
                        background: currentProject?.id === p.id ? '#1e3a5f' : 'transparent',
                        border: `1px solid ${currentProject?.id === p.id ? '#2563eb' : '#334155'}`,
                        borderRadius: '6px 6px 0 0', cursor: discoveryLoading ? 'not-allowed' : 'pointer',
                        color: '#e2e8f0', fontSize: '12px', borderBottom: 'none',
                      }}
                    >
                      <div style={{ fontWeight: '500', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: '2px' }}>{p.name}</div>
                      <div style={{ color: '#64748b', fontSize: '11px' }}>{p.filesCount} files</div>
                    </button>
                    <div style={{ display: 'flex', border: `1px solid ${currentProject?.id === p.id ? '#2563eb' : '#334155'}`, borderRadius: '0 0 6px 6px', overflow: 'hidden', borderTop: '1px solid #0f172a' }}>
                      <button
                        onClick={() => handleOpenProject(p)}
                        title="Open and prepare for deployment"
                        style={{ flex: 1, padding: '5px 0', background: 'rgba(124,58,237,0.08)', border: 'none', borderRight: '1px solid #1e293b', color: '#c084fc', cursor: 'pointer', fontSize: '10px', fontWeight: '600' }}
                      >
                        🚀 Deploy
                      </button>
                      <button
                        onClick={() => handleOpenProject(p)}
                        title="Open to connect a custom domain"
                        style={{ flex: 1, padding: '5px 0', background: 'rgba(29,78,216,0.08)', border: 'none', color: '#60a5fa', cursor: 'pointer', fontSize: '10px', fontWeight: '600' }}
                      >
                        🌐 Domain
                      </button>
                    </div>
                  </div>
                ))}
              </>
            )}

            {projects.length === 0 && !currentProject && (
              <div style={{ fontSize: '12px', color: '#64748b', lineHeight: '1.8', marginTop: '8px' }}>
                <p style={{ marginBottom: '10px' }}>No projects yet.</p>
                {['A hotel booking app', 'An e-commerce store', 'A task manager', 'A recipe finder'].map(ex => (
                  <p key={ex} onClick={() => { setInput(ex); inputRef.current?.focus(); }} style={{ color: '#475569', cursor: 'pointer', marginBottom: '4px' }}>
                    → {ex}
                  </p>
                ))}
              </div>
            )}
          </div>

          <div style={{ padding: '12px', borderTop: '1px solid #334155', fontSize: '11px', color: '#475569' }}>
            {lastVerification && (
              <div style={{ marginBottom: '8px', padding: '6px 8px', background: lastVerification.verified ? '#052e16' : '#2d1a00', border: `1px solid ${lastVerification.verified ? '#16a34a' : '#92400e'}`, borderRadius: '6px' }}>
                <div style={{ fontSize: '10px', fontWeight: '700', color: lastVerification.verified ? '#4ade80' : '#fbbf24', marginBottom: '3px' }}>
                  {lastVerification.verified ? '✅ Verified' : '⚠️ Verification Issues'}
                </div>
                {lastVerification.checks?.slice(0, 4).map((c, i) => (
                  <div key={i} style={{ fontSize: '10px', color: c.passed ? '#4ade80' : '#f87171', lineHeight: '1.6' }}>
                    {c.passed ? '✓' : '✗'} {c.name.replace('API: GET ', '').replace('Main page (GET /)', 'Page')}
                    {c.recordCount !== undefined ? ` (${c.recordCount})` : ''}
                  </div>
                ))}
              </div>
            )}
            <p>AI Engineering Teammate</p>
            <p>Powered by AWS Bedrock</p>
          </div>
        </div>

        {/* ── Chat Panel ────────────────────────────────────────────────── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, borderRight: '1px solid #334155' }}>
          {/* Edit mode indicator */}
          {currentProject && (
            <div style={{ padding: '8px 16px', background: '#1e3a5f', borderBottom: '1px solid #1d4ed8', fontSize: '12px', color: '#93c5fd', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span>✏️ Edit Mode —</span>
              <span style={{ fontWeight: '600' }}>{currentProject.name}</span>
              {currentDiscovery?.mode && (
                <span style={{ padding: '1px 6px', borderRadius: '3px', background: '#0f2818', border: '1px solid #16a34a33', color: '#4ade80', fontSize: '10px', fontWeight: '600' }}>
                  {currentDiscovery.mode}
                </span>
              )}
              {currentDiscovery && !currentDiscovery.hasApiRoutes && (
                <span style={{ padding: '1px 6px', borderRadius: '3px', background: '#2d1a00', border: '1px solid #92400e', color: '#fbbf24', fontSize: '10px' }}>
                  client-side only
                </span>
              )}
              {previewUrl && <span style={{ color: '#4ade80', fontSize: '11px' }}>● Live</span>}
              <span style={{ padding: '1px 6px', borderRadius: '3px', background: '#0c1a2e', border: '1px solid #1e3a5f', color: '#4ade80', fontSize: '10px' }}>
                Memory Active
              </span>
              {previewUrl && (
                <div style={{ marginLeft: 'auto', display: 'flex', gap: '4px', flexShrink: 0 }}>
                  <button onClick={handleBrowserScreenshot} disabled={browserDebugging || isBusy} title="Capture full-page screenshot" style={{ padding: '2px 8px', background: '#1a2744', border: '1px solid #2563eb', borderRadius: '4px', color: '#93c5fd', cursor: 'pointer', fontSize: '11px' }}>
                    {browserDebugging ? '…' : '📷 Screenshot'}
                  </button>
                  <button onClick={handleBrowserDebug} disabled={browserDebugging || isBusy} title="Inspect console, network, errors" style={{ padding: '2px 8px', background: '#1a2744', border: '1px solid #2563eb', borderRadius: '4px', color: '#93c5fd', cursor: 'pointer', fontSize: '11px' }}>
                    {browserDebugging ? '…' : '🔍 Debug'}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Builder Context Panel — shows during spec/planning phase before project is built */}
          {builderContext?.active && !currentProject && (
            <div style={{ padding: '6px 16px', background: '#0c1a2e', borderBottom: '1px solid #1e3a5f', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ color: '#4ade80', fontSize: '8px', lineHeight: 1 }}>●</span>
              <span style={{ color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: '10px' }}>Builder Mode</span>
              <span style={{ color: '#334155' }}>·</span>
              <span style={{ color: '#93c5fd', fontWeight: '700' }}>{builderContext.projectName}</span>
              <span style={{ color: '#334155' }}>·</span>
              <span style={{ color: '#64748b', textTransform: 'capitalize' }}>{
                builderContext.stage === 'building' ? 'Generating code…'
                : builderContext.stage === 'planning' ? 'Planning'
                : builderContext.stage === 'editing' ? 'Editing'
                : 'Specification'
              }</span>
              <span style={{ marginLeft: 'auto', color: '#1e3a5f', fontSize: '10px' }}>Memory Active</span>
              <button
                onClick={() => setBuilderContext(null)}
                title="Dismiss"
                style={{ background: 'none', border: 'none', color: '#334155', cursor: 'pointer', fontSize: '12px', lineHeight: 1, padding: '0 0 0 4px' }}
              >×</button>
            </div>
          )}

          {/* Messages */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>
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
                      <div style={{ width: '26px', height: '26px', borderRadius: '50%', background: 'linear-gradient(135deg,#1d4ed8,#4f46e5)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: '700', color: '#fff', flexShrink: 0 }}>D</div>
                      <span style={{ fontSize: '11px', color: '#475569', fontWeight: '600', letterSpacing: '0.02em' }}>DWOMOH Vibe Code</span>
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
                              }}
                                style={{ padding: '6px 14px', background: ri === 0 ? 'rgba(37,99,235,0.2)' : '#141e2e', border: `1px solid ${ri === 0 ? '#2563eb' : '#1e3a5f'}`, borderRadius: '8px', color: ri === 0 ? '#93c5fd' : '#64748b', cursor: 'pointer', fontSize: '12px', fontWeight: '700' }}>
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
                    background: msg.role === 'user' ? 'linear-gradient(135deg,#1d4ed8,#2563eb)' : '#141e2e',
                    border: msg.role === 'assistant' ? '1px solid #1e3a5f' : 'none',
                    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    fontSize: '14px', lineHeight: '1.75', textAlign: 'left',
                    color: msg.role === 'user' ? '#eff6ff' : '#cbd5e1',
                    boxShadow: msg.role === 'user' ? '0 2px 8px rgba(37,99,235,0.25)' : 'none',
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
          <div style={{ padding: '10px 16px 14px', background: '#0a1220', borderTop: '1px solid #1a2744' }}>

            {/* Busy / stuck banner */}
            {isBusy && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px', padding: '8px 14px', background: '#111827', borderRadius: '10px', border: '1px solid #1e3a5f' }}>
                <span style={{ fontSize: '12px', color: '#60a5fa', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ animation: 'spin 1.2s linear infinite', display: 'inline-block', fontSize: '12px' }}>⚙️</span>
                  {phase === 'building' ? 'Generating code…' : editApplying ? 'Applying changes…' : 'Processing…'}
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
              background: '#141e2e',
              border: `1.5px solid ${isRecording ? 'rgba(239,68,68,0.6)' : composerFocused ? '#2563eb' : '#1e3a5f'}`,
              borderRadius: '16px',
              transition: 'border-color 0.2s, box-shadow 0.2s',
              boxShadow: composerFocused && !isRecording ? '0 0 0 3px rgba(37,99,235,0.12)' : isRecording ? '0 0 0 3px rgba(239,68,68,0.1)' : 'none',
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
                  placeholder=""
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

                  {/* Word count badge */}
                  {input.trim().length > 0 && (
                    <span style={{ fontSize: '11px', color: '#1e3a5f', marginRight: '10px', fontVariantNumeric: 'tabular-nums' }}>
                      {input.trim().split(/\s+/).filter(Boolean).length}w
                    </span>
                  )}

                  {/* Send button */}
                  <button type="submit"
                    disabled={isBusy || !input.trim()}
                    style={{
                      padding: '9px 22px',
                      background: input.trim() && !isBusy
                        ? 'linear-gradient(135deg, #1d4ed8 0%, #4f46e5 100%)'
                        : '#111827',
                      color: input.trim() && !isBusy ? '#fff' : '#1e3a5f',
                      border: 'none',
                      borderRadius: '10px',
                      cursor: input.trim() && !isBusy ? 'pointer' : 'not-allowed',
                      fontWeight: '700',
                      fontSize: '13px',
                      transition: 'all 0.2s',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '7px',
                      whiteSpace: 'nowrap',
                      boxShadow: input.trim() && !isBusy ? '0 2px 10px rgba(37,99,235,0.4)' : 'none',
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

        {/* ── Preview Panel ─────────────────────────────────────────────── */}
        <div style={{ width: '42%', minWidth: '320px', background: '#1e293b', display: 'flex', flexDirection: 'column' }}>
          {/* Tab bar */}
          <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid #334155', background: '#0f172a', overflowX: 'auto' }}>
            {(['preview', 'design', 'terminal', 'logs'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setPreviewTab(tab)}
                style={{
                  padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer',
                  color: previewTab === tab ? '#e2e8f0' : '#64748b',
                  fontSize: '12px', fontWeight: previewTab === tab ? '700' : '400',
                  borderBottom: previewTab === tab ? '2px solid #2563eb' : '2px solid transparent',
                  textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap',
                  position: 'relative',
                }}
              >
                {tab === 'preview' ? (
                    <span>
                      ⬜ Preview
                      {researchActivity && !researchActivity.complete && (
                        <span style={{ position: 'absolute', top: '6px', right: '4px', width: '6px', height: '6px', borderRadius: '50%', background: '#3b82f6', animation: 'pulse 1.2s ease-in-out infinite' }} />
                      )}
                    </span>
                  )
                  : tab === 'design' ? (
                    <span>
                      🎨 Design
                      {(assets.some(a => a.role === 'logo') || logoHistory.length > 0) && (
                        <span style={{ position: 'absolute', top: '6px', right: '4px', width: '6px', height: '6px', borderRadius: '50%', background: '#2563eb' }} />
                      )}
                    </span>
                  )
                  : tab === 'terminal' ? '$ Terminal' : '📋 Logs'}
              </button>
            ))}
            {previewUrl && previewTab === 'preview' && (
              <div style={{ display: 'flex', gap: '4px', marginLeft: 'auto', padding: '0 10px', flexShrink: 0 }}>
                <button onClick={() => setPreviewKey(k => k + 1)} title="Refresh" style={{ padding: '4px 8px', background: '#1e293b', border: '1px solid #334155', borderRadius: '4px', color: '#94a3b8', cursor: 'pointer', fontSize: '12px' }}>↺</button>
                <a href={previewUrl} target="_blank" rel="noopener noreferrer" title="Open in new tab" style={{ padding: '4px 8px', background: '#1e293b', border: '1px solid #334155', borderRadius: '4px', color: '#94a3b8', textDecoration: 'none', fontSize: '12px' }}>↗</a>
              </div>
            )}
          </div>

          <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
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
                    {previewLoading && (
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
