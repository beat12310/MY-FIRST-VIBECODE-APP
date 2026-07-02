export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { parseProjectFormat, parseLooseProjectFiles } from '@/lib/json-parser';
import { converseWithEngineer, buildWithAI, fixErrorsWithAI, editWithAI, analyzeImageWithAI, generateLogoWithAI, converseAgentically, ConversationTurn } from '@/services/bedrock';
import { handleError } from '@/lib/error-handler';
import { generateProject } from '@/services/project-generator';
import { installDependencies, startDevServer, validateProject, clearBuildCache, readServerState, getServerLogs } from '@/services/project-runner';
import { listProjects, saveProject, updateProjectPort, getProject } from '@/services/project-store';
import { readFile, writeFile, access, stat } from 'fs/promises';
import { join, dirname } from 'path';
import {
  ENGINEER_SYSTEM_PROMPT,
  BUILD_SYSTEM_PROMPT,
  EDITOR_SYSTEM_PROMPT,
  RESEARCH_SYSTEM_PROMPT,
  INTELLIGENT_SYSTEM_PROMPT,
  VISION_SYSTEM_PROMPT,
  LOGO_SYSTEM_PROMPT,
  LOGO_REFINE_SYSTEM_PROMPT,
  buildProjectAwareSystemPrompt,
  generateBuildPromptFromConversation,
  generateErrorFixPrompt,
} from '@/lib/prompt-engineer';
import {
  getProjectMemory,
  initProjectMemory,
  updateProjectMemory,
  appendConversationTurn,
  recordEditApplied,
  recordBuild,
  recordVerification,
  recordBrowserSession,
  recordScaffold,
  recordFileOp,
} from '@/services/memory-store';
import {
  discoverProject,
  discoverAndPersist,
  buildChatContext,
  buildEditContext,
} from '@/services/project-discovery';
import { parseEditFormat, applyEditsToProject } from '@/services/file-editor';
import { verifyRunningApp } from '@/services/verification-engine';
import { captureScreenshot, clickElement, fillForm, debugPage } from '@/services/browser-automation';
import { generateDatabaseScaffold } from '@/services/database-integrator';
import type { DatabaseType } from '@/services/database-integrator';
import { prepareDeployment } from '@/services/deployment-engine';
import type { DeployTarget } from '@/services/deployment-engine';
import { generateAuthScaffold } from '@/services/auth-scaffolder';
import type { AuthProvider } from '@/services/auth-scaffolder';
import { rename, mkdir } from 'fs/promises';
import { applyAuthFallback } from '@/services/error-recovery';
import { attemptRecovery, classifyError, extractAllMissingPackages, identifyAffectedFiles } from '@/services/error-recovery';
import { captureSnapshot, restoreSnapshot, clearSnapshot } from '@/services/project-snapshot';
import { getAuthUser } from '@/lib/server-auth';
import { investigateRootCause, formatRootCauseReport } from '@/services/root-cause-engine';

// ─── helpers ──────────────────────────────────────────────────────────────────

async function readProjectFiles(projectPath: string, paths: string[]): Promise<Array<{ path: string; content: string }>> {
  const results = [];
  for (const p of paths) {
    try {
      const content = await readFile(join(projectPath, p), 'utf-8');
      results.push({ path: p, content });
    } catch { /* skip */ }
  }
  return results;
}

// ─── route handler ─────────────────────────────────────────────────────────────

// Public preview URL for a running dev server. On the worker PREVIEW_DOMAIN is set
// (e.g. dwomohvibe.com) → returns the ALB-routed HTTPS host. On localhost it's
// unset → returns the same http://localhost:<port> the client already used.
function publicPreviewUrl(port?: number): string | undefined {
  const domain = process.env.PREVIEW_DOMAIN?.trim();
  if (domain) return `https://preview.${domain}`;
  return port ? `http://localhost:${port}` : undefined;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    const { action, messages, prompt, projectPath, projectId } = body;

    // ── Worker inbound guard ─────────────────────────────────────────────────
    // When this process IS the worker (WORKER_ROLE=worker), every /api/chat call
    // must carry the shared secret set by the Amplify shim. Blocks the public ALB
    // endpoint from being driven by anyone but our frontend.
    if (process.env.WORKER_ROLE === 'worker') {
      const provided = request.headers.get('x-worker-secret') ?? '';
      const expected = process.env.WORKER_SECRET ?? '';
      if (!expected || provided !== expected) {
        return NextResponse.json({ success: false, error: 'Unauthorized worker request' }, { status: 401 });
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // AMPLIFY → BUILD-WORKER PROXY SHIM
    // ════════════════════════════════════════════════════════════════════════
    // On AWS Amplify (Lambda SSR) the filesystem is read-only and we cannot run
    // npm or a dev server. Any action that needs the project on disk or spawns a
    // process is forwarded over HTTPS to the Fargate build worker, which runs
    // this exact same code with WORKER_URL unset (so it executes locally there).
    //
    // LOCALHOST: WORKER_URL is unset → this block is skipped entirely → behavior
    // is identical to today. On Amplify we forward the ENTIRE /api/chat surface to
    // the worker (deny-by-default): the worker runs this exact code, has Bedrock via
    // its task role, and a writable disk — so both AI and disk actions work there,
    // and no action can be accidentally mis-routed to the read-only Lambda.
    const WORKER_URL = process.env.WORKER_URL?.trim();
    if (WORKER_URL && process.env.WORKER_ROLE !== 'worker') {
      try {
        const auth = request.headers.get('authorization') ?? '';
        const workerRes = await fetch(`${WORKER_URL.replace(/\/$/, '')}/api/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(auth ? { authorization: auth } : {}),
            'x-worker-secret': process.env.WORKER_SECRET ?? '',
          },
          body: JSON.stringify(body),
          // Generation/install/build can take minutes — never time out at the shim.
          signal: AbortSignal.timeout(15 * 60 * 1000),
        });
        const text = await workerRes.text();
        return new NextResponse(text, {
          status: workerRes.status,
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (proxyErr) {
        const msg = proxyErr instanceof Error ? proxyErr.message : String(proxyErr);
        return NextResponse.json(
          { success: false, error: `Build worker unreachable: ${msg}. Check WORKER_URL and that the Fargate service is healthy.` },
          { status: 502 },
        );
      }
    }

    // ── claude-bridge-status: check if Claude Code CLI is available + auth'd ──
    if (action === 'claude-bridge-status') {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFile);
      const { claudeCliInfo } = await import('@/lib/claude-cli');
      const cli = claudeCliInfo();
      if (!cli.path) {
        return NextResponse.json({
          available: false, loggedIn: false, cliPath: null, cliSource: cli.source,
          error: 'Claude Code CLI not found. Install it, or set CLAUDE_CLI_PATH to the executable. Searched PATH and common install locations.',
        });
      }
      try {
        const { stdout } = await execFileAsync(cli.path, ['auth', 'status'], { timeout: 8000 });
        const auth = JSON.parse(stdout.trim());
        return NextResponse.json({ available: true, loggedIn: auth.loggedIn ?? false, email: auth.email, version: auth.claudeCodeVersion, cliPath: cli.path, cliSource: cli.source });
      } catch (e) {
        return NextResponse.json({ available: true, loggedIn: false, cliPath: cli.path, cliSource: cli.source, error: String(e) });
      }
    }

    // ── analyze-image: Claude vision analysis of an uploaded image ────────────
    if (action === 'analyze-image') {
      const { imageBase64, mediaType, instruction } = body as { imageBase64?: string; mediaType?: string; instruction?: string };
      if (!imageBase64 || !mediaType) {
        return NextResponse.json({ success: false, error: 'Missing imageBase64 or mediaType' }, { status: 400 });
      }
      const prompt = instruction || 'Analyze this image. Describe what it contains and how it could best be used in a website or app design.';
      const analysis = await analyzeImageWithAI(imageBase64, mediaType, prompt, VISION_SYSTEM_PROMPT);
      return NextResponse.json({ success: true, analysis });
    }

    // ── generate-logo: SVG logo generation via Claude ─────────────────────────
    if (action === 'generate-logo') {
      const { prompt: logoPrompt } = body as { prompt?: string };
      if (!logoPrompt) {
        return NextResponse.json({ success: false, error: 'Missing logo prompt' }, { status: 400 });
      }
      const raw = await generateLogoWithAI(logoPrompt, LOGO_SYSTEM_PROMPT);

      // Parse the three SVG blocks and their style labels out of the response
      const logos: string[] = [];
      const styleLabels: string[] = [];
      const pattern = /\[LOGO_OPTION_\d+:\s*([^\]]+)\]\s*([\s\S]*?)(?=\[LOGO_OPTION_|\s*$)/g;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(raw)) !== null && logos.length < 3) {
        const label = match[1].trim();
        const svg   = match[2].trim();
        if (svg.startsWith('<svg')) { logos.push(svg); styleLabels.push(label); }
      }
      // Fallback: try splitting on <svg tags
      if (logos.length === 0) {
        const svgMatches = raw.match(/<svg[\s\S]*?<\/svg>/gi);
        if (svgMatches) logos.push(...svgMatches.slice(0, 3));
      }

      return NextResponse.json({ success: true, logos, styleLabels, raw });
    }

    // ── refine-logo: targeted edit of an existing SVG logo ────────────────────
    if (action === 'refine-logo') {
      const { svgCode, instruction } = body as { svgCode?: string; instruction?: string };
      if (!svgCode || !instruction) {
        return NextResponse.json({ success: false, error: 'Missing svgCode or instruction' }, { status: 400 });
      }
      const prompt = `Current SVG logo:\n${svgCode}\n\nUser's change request: ${instruction}`;
      const raw = await generateLogoWithAI(prompt, LOGO_REFINE_SYSTEM_PROMPT);
      // Extract the single SVG returned by Claude
      const svgMatch = raw.match(/<svg[\s\S]*?<\/svg>/i);
      const svg = svgMatch ? svgMatch[0].trim() : null;
      return NextResponse.json({ success: !!svg, svg, raw });
    }

    // ── think: AI-powered conversational intelligence ─────────────────────────
    // Used for questions, planning, technical explanations, and API guidance
    // before a build starts. Uses INTELLIGENT_SYSTEM_PROMPT (no build triggers).
    if (action === 'think') {
      const turns: ConversationTurn[] = Array.isArray(messages) ? messages : [];
      if (turns.length === 0 || turns[turns.length - 1].role !== 'user') {
        return NextResponse.json({ success: false, error: 'No user message provided' }, { status: 400 });
      }
      const response = await converseWithEngineer(turns, INTELLIGENT_SYSTEM_PROMPT);
      return NextResponse.json({ success: true, response });
    }

    // ── think-agentic: conversation with live tool use (browse, test, search) ──
    // When the AI decides to use a tool, it calls it live and feeds the result back.
    // Supports: browse_web, test_live_app, search_internet.
    if (action === 'think-agentic') {
      const turns: ConversationTurn[] = Array.isArray(messages) ? messages : [];
      if (turns.length === 0 || turns[turns.length - 1].role !== 'user') {
        return NextResponse.json({ success: false, error: 'No user message provided' }, { status: 400 });
      }
      const agentPort    = body.port        as number | undefined;
      const agentPath    = body.projectPath as string | undefined;
      const agentProject = body.projectName as string | undefined;

      // Discover the project's file structure server-side so the AI can see
      // exactly which pages and routes exist — without the user providing anything.
      let fileStructureBlock = '';
      let discoveredPages: string[] = [];
      let discoveredApiRoutes: string[] = [];
      if (agentPath) {
        try {
          const { discoverProject } = await import('@/services/project-discovery');
          const disc = await discoverProject(agentPath);
          discoveredPages     = disc.pages ?? [];
          discoveredApiRoutes = disc.apiRoutes ?? [];
          const pageList = discoveredPages.length     > 0 ? discoveredPages.join(', ')                              : 'none discovered';
          const apiList  = discoveredApiRoutes.length > 0 ? discoveredApiRoutes.join(', ')                         : 'none discovered';
          const compList = (disc.components ?? []).slice(0, 12).join(', ') + ((disc.components ?? []).length > 12 ? ', …' : '');
          fileStructureBlock = `
Pages     : ${pageList}
API routes: ${apiList}
Components: ${compList || 'none discovered'}`;
        } catch { /* non-critical */ }
      }

      // Active-project context block injected verbatim into the agent system prompt.
      // The AI MUST use these values — never ask the user for port, path, or project name.
      const activeProjectBlock = (agentPort || agentPath) ? `

╔══════════════════════════════════════════════════════════════╗
║  ACTIVE PROJECT  —  DO NOT ask the user for any of this     ║
╚══════════════════════════════════════════════════════════════╝
Project : ${agentProject ?? '(unnamed)'}
Port    : ${agentPort ?? 'not running'}   ← pass this exact value as "port" to test_live_app
Path    : ${agentPath  ?? 'unknown'}
${fileStructureBlock}

MANDATORY BEHAVIOUR — follow these in order:
1. If the user mentions "404", "broken", "not working", "error", "preview shows", "page not found",
   "blank", "won't load", or any indication the app is misbehaving:
   → Call test_live_app(port=${agentPort}) IMMEDIATELY as your very first action.
   → NEVER ask "what is the port?" — it is ${agentPort} (shown above).
   → NEVER ask "can you share your files?" — the file structure is shown above.

2. After test_live_app returns results:
   → Read every ❌ line. Each one identifies a broken route or failed step.
   → Name the exact file that needs to be created or fixed (use the Pages list above to cross-check).
   → Explain the problem clearly before describing the fix.

3. If a fix is applied, call test_live_app again to confirm the repair worked.
   Never declare a page "fixed" without a passing re-test.

4. If the user asks to test or verify the app for any reason, call test_live_app first.
   Do not ask for confirmation — just run it.
` : '';

      const toolExecutor = async (toolName: string, toolInput: Record<string, unknown>): Promise<string> => {
        if (toolName === 'browse_web') {
          const url = toolInput.url as string;
          if (!url?.startsWith('http')) return 'Invalid URL — must start with https://';
          try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 12000);
            const res = await fetch(url, {
              headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DWOMOHVibe-Research/1.0)' },
              signal: controller.signal,
            });
            clearTimeout(timer);
            if (!res.ok) return `HTTP ${res.status} — page unavailable`;
            const html = await res.text();
            const text = html
              .replace(/<script[\s\S]*?<\/script>/gi, '')
              .replace(/<style[\s\S]*?<\/style>/gi, '')
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s+/g, ' ').trim().slice(0, 5000);
            const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
            return `Page: ${titleMatch?.[1] ?? url}\nURL: ${url}\n\n${text || 'No readable content extracted'}`;
          } catch (err) {
            return `Browse error: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        if (toolName === 'test_live_app') {
          const port = (toolInput.port as number) ?? agentPort;
          if (!port) return 'No port provided — the app must be running. Check buildProgress.port in the builder.';
          const testType = (toolInput.test_type as string) ?? 'generic';
          const baseUrl  = `http://localhost:${port}`;

          // Step 1: HTTP-level route check — catches 404s in under 1 second
          const httpLines: string[] = [];
          try {
            const { verifyRunningApp } = await import('@/services/verification-engine');
            const routeCheck = await verifyRunningApp(port, discoveredApiRoutes, agentPath, discoveredPages);
            for (const c of routeCheck.checks) {
              httpLines.push(`${c.passed ? '✅' : '❌'} HTTP ${c.name}: ${c.statusCode ?? 'no status'} ${c.error ? `— ${c.error}` : ''}`);
            }
          } catch { /* non-critical — continue to Playwright */ }

          // Step 2: Playwright browser test — clicks, forms, navigation
          let playwrightSection = '';
          try {
            const { runBrowserJourney } = await import('@/services/browser-journey-runner');
            const result = await runBrowserJourney(baseUrl, testType as 'generic' | 'marketplace' | 'booking' | 'social');
            const passed = result.steps.filter(s => s.passed).length;
            const total  = result.steps.length;
            const lines  = result.steps.map(s => `${s.passed ? '✅' : '❌'} ${s.step}${s.error ? ` — ${s.error}` : ''}`);
            playwrightSection = `\nPlaywright (${passed}/${total} steps passed — verdict: ${result.verdict}):\n${lines.join('\n')}${result.failureScreenshotPath ? `\nFailure screenshot: ${result.failureScreenshotPath}` : ''}`;
          } catch (err) {
            playwrightSection = `\nPlaywright: ${err instanceof Error ? err.message : String(err)}`;
          }

          const httpSection = httpLines.length > 0 ? `\nRoute HTTP checks:\n${httpLines.join('\n')}` : '';
          return `Live test results for ${baseUrl}:${httpSection}${playwrightSection}`;
        }

        if (toolName === 'search_internet') {
          const query = toolInput.query as string;
          if (!query) return 'No search query provided';
          try {
            const { searchWeb, formatSearchResultsForPrompt } = await import('@/services/web-search');
            const response = await searchWeb(query);
            return response.results.length > 0 ? formatSearchResultsForPrompt(response) : 'No results found';
          } catch (err) {
            return `Search error: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        return `Unknown tool: ${toolName}`;
      };

      const agentSystemPrompt = `${INTELLIGENT_SYSTEM_PROMPT}${activeProjectBlock}

═══════════════════════════════════════════════
YOUR TOOLS — call them immediately; never describe them instead of using them
═══════════════════════════════════════════════
1. browse_web(url, purpose) — fetch and read any public webpage right now.
2. test_live_app(port, test_type?) — open a real Playwright browser, click through every page, form, and route. Returns HTTP status for every route AND Playwright step-by-step results. Use port=${agentPort ?? 'from ACTIVE PROJECT block above'}.
3. search_internet(query) — search Google/Bing for APIs, errors, documentation.

RULE: A tool invocation is always better than an apology or a question. When in doubt, call the tool.`;

      const response = await converseAgentically(turns, agentSystemPrompt, toolExecutor);
      return NextResponse.json({ success: true, response });
    }

    // ── research: AI-powered API and technology research ──────────────────────
    if (action === 'research') {
      const { query } = body;
      if (!query || typeof query !== 'string') {
        return NextResponse.json({ success: false, error: 'Missing research query' }, { status: 400 });
      }
      const researchPrompt = `Research request: ${query}\n\nProvide a comprehensive, structured response. Include specific API names, official website URLs, pricing tiers, rate limits, required environment variable names, documentation links, pros/cons, and a clear recommendation. If asking about a specific domain (football, weather, payments, maps, etc.) list the top 3-5 real options available today.`;
      const response = await buildWithAI(researchPrompt, RESEARCH_SYSTEM_PROMPT);
      return NextResponse.json({ success: true, response });
    }

    // ── browse-web: fetch public URLs and analyse content with AI ─────────────
    if (action === 'browse-web') {
      const { urls, query } = body as { urls?: string[]; query: string };
      if (!query) return NextResponse.json({ success: false, error: 'Missing query' }, { status: 400 });

      // Safety: block private/authenticated paths
      const BLOCKED = ['/login', '/signin', '/admin', '/checkout', '/payment', '/account', '/private', '/secure', '/dashboard', '/settings', '/profile'];

      const fetched: Array<{ url: string; content?: string; error?: string }> = [];

      for (const rawUrl of (urls || []).slice(0, 3)) {
        const urlLower = rawUrl.toLowerCase();
        if (BLOCKED.some(b => urlLower.includes(b))) {
          fetched.push({ url: rawUrl, error: 'Blocked — only public pages are accessible' });
          continue;
        }
        // Ensure absolute URL
        const fullUrl = rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`;
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 12000);
          const res = await fetch(fullUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DWOMOHVibe-Research/1.0; +https://dwomohvibecode.com/bot)' },
            signal: controller.signal,
          });
          clearTimeout(timer);
          if (!res.ok) { fetched.push({ url: fullUrl, error: `HTTP ${res.status}` }); continue; }
          const html = await res.text();
          // Strip scripts, styles, HTML tags; decode common entities
          const text = html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#?\w+;/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 7000);
          fetched.push({ url: fullUrl, content: text || undefined });
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown';
          fetched.push({ url: fullUrl, error: msg.includes('abort') ? 'Timed out after 12s' : msg });
        }
      }

      const hasContent = fetched.some(f => f.content);
      const researchContext = fetched.map(f =>
        `SOURCE: ${f.url}\n${f.content ? f.content.slice(0, 4000) : `ERROR: ${f.error}`}`
      ).join('\n\n---\n\n');

      const analysisPrompt = hasContent
        ? `Web Research Task: "${query}"\n\nYou have been given content from the following public web pages. Analyse what you observe and provide specific, actionable recommendations.\n\n${researchContext}\n\nProvide:\n1. What you observed on these pages (layout, features, design patterns, trust signals, UX patterns)\n2. Specific recommendations for the user's project based on these observations\n3. A prioritised list of improvements to implement, numbered by impact\n4. End with: "Shall I apply these improvements to your current project?"\n\nBe specific and reference what you actually saw. Do not make things up.`
        : `Web Research Task (no pages fetched successfully): "${query}"\n\nBased on your knowledge of the mentioned websites/companies, provide detailed recommendations about design patterns, features, and UX elements that are worth implementing. Be specific and actionable.`;

      const response = await buildWithAI(analysisPrompt, RESEARCH_SYSTEM_PROMPT);
      return NextResponse.json({
        success: true,
        response,
        urlsResearched: fetched.filter(f => f.content).map(f => f.url),
        urlsErrored: fetched.filter(f => f.error).map(f => ({ url: f.url, error: f.error })),
        usedKnowledge: !hasContent,
      });
    }

    // ── converse: multi-turn conversation ──────────────────────────────────────
    if (action === 'converse') {
      const turns: ConversationTurn[] = Array.isArray(messages) ? messages : [];
      if (turns.length === 0 || turns[turns.length - 1].role !== 'user') {
        return NextResponse.json({ success: false, error: 'No user message provided' }, { status: 400 });
      }

      // If a project is selected, inject its full context into the system prompt
      let systemPrompt = ENGINEER_SYSTEM_PROMPT;
      if (projectPath) {
        try {
          // Run discovery (or use cached results)
          const discovery = await discoverProject(projectPath);
          const mem = await getProjectMemory(projectPath);
          const projectContext = buildChatContext(discovery, mem, mem?.runningPort);
          systemPrompt = buildProjectAwareSystemPrompt(projectContext);

          // Save user message to project conversation history
          const lastTurnContent = turns[turns.length - 1].content;
          const lastUserMsg = typeof lastTurnContent === 'string' ? lastTurnContent : '[multimodal message]';
          await appendConversationTurn(projectPath, 'user', lastUserMsg);
        } catch { /* proceed without project context if discovery fails */ }
      }

      const response = await converseWithEngineer(turns, systemPrompt);
      const readyToBuild = response.includes('[READY_TO_BUILD]');
      const displayText = response.replace('[READY_TO_BUILD]', '').trim();

      // Save assistant response to project history
      if (projectPath) {
        try { await appendConversationTurn(projectPath, 'assistant', displayText); } catch { /* ignore */ }
      }

      return NextResponse.json({ success: true, response: displayText, readyToBuild });
    }

    // ── discover: scan an existing project, update its memory ─────────────────
    if (action === 'discover') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });

      // Auto-init memory for projects that predate the memory system
      let mem = await getProjectMemory(projectPath);
      if (!mem) {
        const projectName = projectPath.split('/').pop() || 'unknown';
        const id = `proj_${Buffer.from(projectName).toString('hex').slice(0, 8)}`;
        await initProjectMemory({ projectId: id, name: projectName, originalPrompt: projectName, projectPath });
      }

      const discovery = await discoverAndPersist(projectPath);
      mem = await getProjectMemory(projectPath);

      return NextResponse.json({
        success: true,
        summary: discovery.summary,
        pages: discovery.pages,
        components: discovery.components,
        apiRoutes: discovery.apiRoutes,
        fileCount: discovery.allFiles.length,
        framework: discovery.framework,
        dependencies: Object.keys(discovery.dependencies),
        mode: discovery.mode,
        hasApiRoutes: discovery.hasApiRoutes,
        hasDatabase: discovery.hasDatabase,
        hasDataFiles: discovery.hasDataFiles,
        missingCredentials: discovery.missingCredentials,
        envExampleVars: discovery.envExampleVars,
        memory: mem,
      });
    }

    // ── get-project-memory: return memory for a project ───────────────────────
    if (action === 'get-project-memory') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const mem = await getProjectMemory(projectPath);
      return NextResponse.json({ success: true, memory: mem });
    }

    // ── init-project-memory: create memory for an existing project ────────────
    if (action === 'init-project-memory') {
      const { name, originalPrompt, purpose } = body;
      if (!projectPath || !name) return NextResponse.json({ success: false, error: 'Missing projectPath or name' }, { status: 400 });

      const existing = await getProjectMemory(projectPath);
      if (existing) {
        return NextResponse.json({ success: true, memory: existing, existed: true });
      }

      const id = `proj_${Date.now().toString(36)}`;
      const mem = await initProjectMemory({ projectId: id, name, originalPrompt: originalPrompt || name, projectPath, purpose });
      return NextResponse.json({ success: true, memory: mem, existed: false });
    }

    // ── update-project-memory: patch fields in project memory ─────────────────
    if (action === 'update-project-memory') {
      const { updates } = body;
      if (!projectPath || !updates) return NextResponse.json({ success: false, error: 'Missing projectPath or updates' }, { status: 400 });
      await updateProjectMemory(projectPath, updates);
      return NextResponse.json({ success: true });
    }

    // ── edit: apply AI-driven page edits to an existing project ───────────────
    if (action === 'edit') {
      const { userRequest } = body;
      if (!projectPath || !userRequest) {
        return NextResponse.json({ success: false, error: 'Missing projectPath or userRequest' }, { status: 400 });
      }

      // Safety gate options
      const safeApply: boolean = body.safeApply ?? true;  // default ON
      // Scope constraint: layer-specific file restrictions
      // e.g. { layer: 'api', allowedPrefixes: ['app/api/'], blockedPrefixes: ['app/page.tsx'] }
      // Caller-supplied constraints are honored as-is; when the caller doesn't
      // set one (the default chat "edit" action never did), it is now derived
      // automatically below from services/engine/edit-scope.ts's import-graph
      // analysis — scope enforcement stops being opt-in and becomes a
      // guaranteed property of every edit, not just requests that happen to
      // arrive through the surgical/repair code paths that already set it.
      let scopeConstraint: { layer?: string; allowedPrefixes?: string[]; blockedPrefixes?: string[] } =
        body.scopeConstraint ?? {};

      // Auto-init memory if needed (for projects predating the memory system)
      let mem = await getProjectMemory(projectPath);
      if (!mem) {
        const projectName = projectPath.split('/').pop() || 'unknown';
        const id = `proj_${Buffer.from(projectName).toString('hex').slice(0, 8)}`;
        await initProjectMemory({ projectId: id, name: projectName, originalPrompt: projectName, projectPath });
      }

      // Fresh discovery to get current file contents
      const discovery = await discoverProject(projectPath);
      mem = await getProjectMemory(projectPath);

      // ── Engine edit-scope: precise, import-graph-based file targeting ─────────
      // buildEditContext's own file selection (below) is pure keyword matching
      // against the request text — it has no notion of what actually imports
      // or is imported by the file being discussed. computeEditScope walks
      // project-map.ts's import graph one hop from the matched target(s), so
      // e.g. a page and the ONE component it renders are both in scope while
      // an unrelated page, or the API/database layer, structurally are not.
      let editScopeFiles: string[] = [];
      let editProjectMap: Awaited<ReturnType<typeof import('@/services/project-map').getProjectMap>> | null = null;
      // Set only when scope was AUTO-computed (not caller-supplied) — carries
      // the full EditScope (with targetFiles) so the filter below can apply
      // the stricter isEditAllowed() check instead of prefix-only matching.
      let autoComputedScope: Awaited<ReturnType<typeof import('@/services/engine/edit-scope').computeEditScope>> | null = null;
      try {
        const { getProjectMap } = await import('@/services/project-map');
        const { computeEditScope } = await import('@/services/engine/edit-scope');
        const map = await getProjectMap(projectPath);
        editProjectMap = map;
        const scope = computeEditScope(map, userRequest);
        editScopeFiles = scope.targetFiles;
        if (!body.scopeConstraint) {
          scopeConstraint = {
            layer: scope.layers[0],
            allowedPrefixes: scope.allowedPrefixes,
            blockedPrefixes: scope.blockedPrefixes,
          };
          autoComputedScope = scope;
        }
      } catch { /* non-fatal — falls back to buildEditContext's own matching + no auto scope */ }

      // ── Baseline TypeScript error count (before any changes) ──────────────────
      // Used for regression detection: if errors increase after the fix, roll back.
      let tsBaselineErrors: string[] = [];
      let tsBaselineCount = 0;
      if (safeApply) {
        try {
          const baseline = await validateProject(projectPath);
          tsBaselineErrors = baseline.errors ?? [];
          tsBaselineCount = tsBaselineErrors.length;
        } catch { /* proceed without baseline */ }
      }

      // ── Auto-detect build/server errors and inject them ──────────────────────
      let autoErrorBlock = '';
      const autoErrorFiles: string[] = [];

      try {
        const devLog = await readFile(join(projectPath, '.next-dev.log'), 'utf-8');
        const errorLines = devLog.split('\n')
          .filter(l => /error|syntaxerror|failed|module not found|cannot find|unexpected token|enoent/i.test(l))
          .slice(-12)
          .join('\n')
          .trim();
        if (errorLines) {
          autoErrorBlock += `Server/Build output errors:\n${errorLines}`;
          for (const line of errorLines.split('\n')) {
            const m = line.match(/(?:\.\/|\/[\w-]+\/)*?([\w.-]+\.(?:js|ts|tsx|jsx|json|css|mjs|cjs))/);
            if (m && m[1] && !m[1].startsWith('node_modules')) {
              autoErrorFiles.push(m[1]);
            }
          }
        }
      } catch { /* log not present */ }

      try {
        const errJson = JSON.parse(await readFile(join(projectPath, '.next/error.json'), 'utf-8'));
        if (errJson.message) {
          autoErrorBlock += (autoErrorBlock ? '\n\n' : '') + `Next.js build error:\n${errJson.message}`;
          const m = errJson.message.match(/([\w/.-]+\.(?:js|ts|tsx|jsx|json|css))/);
          if (m) autoErrorFiles.push(m[1]);
        }
      } catch { /* no error.json */ }

      const enrichedRequest = autoErrorBlock
        ? `${userRequest}\n\n[ERRORS CURRENTLY VISIBLE IN THE PREVIEW PANEL — fix these without asking the user for more detail]:\n${autoErrorBlock}\n[END AUTO-DETECTED ERRORS]`
        : userRequest;

      // ── Spec recovery — prepend project spec to the edit request ─────────────
      // Ensures repair requests know WHAT they are repairing. Without this, a TS
      // error fix can re-generate a page as a generic weather dashboard if the AI
      // loses context of the original project.
      let specPrefixForEdit = '';
      try {
        const { loadSpec, formatSpecAnchor } = await import('@/services/project-spec');
        const editSpec = await loadSpec(projectPath);
        if (editSpec) {
          specPrefixForEdit = `${formatSpecAnchor(editSpec)}\n\n⚠️ You are editing THIS project (above). Fix errors without changing the project type or replacing existing pages.\n\n`;
        }
      } catch { /* non-fatal */ }

      // Build full edit context, including files mentioned in the auto-detected errors
      const specEnrichedRequest = specPrefixForEdit ? `${specPrefixForEdit}${enrichedRequest}` : enrichedRequest;
      const contextMessage = await buildEditContext({ discovery, userRequest: specEnrichedRequest, mem, extraFiles: [...autoErrorFiles, ...editScopeFiles], projectMap: editProjectMap });

      // ── Scope constraint injection into the system prompt ─────────────────────
      // When a specific issue layer is identified (api/frontend/backend/auth/database),
      // restrict the AI to only modify files in the relevant scope.
      let effectiveSystemPrompt = EDITOR_SYSTEM_PROMPT;
      if (scopeConstraint.layer && scopeConstraint.allowedPrefixes?.length) {
        const scopeBlock = [
          '',
          '═══════════════════════════════════════════════',
          'SCOPE CONSTRAINT — MANDATORY',
          '═══════════════════════════════════════════════',
          `Root cause layer: ${scopeConstraint.layer.toUpperCase()}`,
          `ONLY modify files in: ${scopeConstraint.allowedPrefixes.join(', ')}`,
          scopeConstraint.blockedPrefixes?.length
            ? `DO NOT modify: ${scopeConstraint.blockedPrefixes.join(', ')}`
            : '',
          'If the fix requires files outside the listed scope, include them anyway — do NOT explain or ask.',
          'NEVER touch unrelated files to fix a scoped issue.',
          'CRITICAL: even with scope constraints, ALWAYS output [EDIT_START]...[EDIT_END] blocks — NEVER respond with explanation only.',
        ].filter(Boolean).join('\n');
        effectiveSystemPrompt = EDITOR_SYSTEM_PROMPT + scopeBlock;
      }

      // Call AI in edit mode
      const aiResponse = await editWithAI(contextMessage, effectiveSystemPrompt);

      // Parse the [EDIT_START]...[EDIT_END] format
      let editedFiles = parseEditFormat(aiResponse);

      // ── Conversational-response guard ──────────────────────────────────────────
      // If the AI returned text with no edit blocks, check whether the request was
      // actually an edit command. If it was, retry ONCE with an explicit demand for
      // [EDIT_START]...[EDIT_END] output. Only allow conversational pass-through
      // for pure information questions.
      if (editedFiles.length === 0) {
        const EDIT_VERBS = /\b(remove|delete|hide|add|change|update|fix|rename|move|reorder|replace|modify|disable|enable|make|turn|set|show|adjust|include|exclude|implement|create|refactor|clean|clear|reset|toggle|switch|insert|append|prepend|strip|drop|convert)\b/i;
        const isEditRequest = EDIT_VERBS.test(userRequest);

        if (isEditRequest) {
          // The AI explained instead of editing. Retry with an explicit demand.
          const retryPrompt = contextMessage +
            `\n\n═══════════════════════════════════════════════` +
            `\nFORCE EDIT — CRITICAL` +
            `\n═══════════════════════════════════════════════` +
            `\nYour previous response was CONVERSATIONAL TEXT with no file changes.` +
            `\nThis is NOT acceptable for an edit request.` +
            `\nThe user asked: "${userRequest}"` +
            `\nThis is an EDIT command — you MUST output [EDIT_START]...[EDIT_END] blocks RIGHT NOW.` +
            `\nFind the file that renders the element mentioned. Output its FULL content with the change applied.` +
            `\nDo NOT explain. Do NOT describe. Output ONLY the [EDIT_START]...[EDIT_END] block.`;

          const retryResponse = await editWithAI(retryPrompt, effectiveSystemPrompt);
          editedFiles = parseEditFormat(retryResponse);

          if (editedFiles.length === 0) {
            // Retry also returned no edits — allow conversational pass-through so
            // the user at least sees what blocked the edit.
            return NextResponse.json({
              success: true,
              filesChanged: [],
              response: retryResponse || aiResponse,
              conversational: true,
              _retried: true,
            });
          }
        } else {
          // Pure information question — conversational response is correct.
          return NextResponse.json({ success: true, filesChanged: [], response: aiResponse, conversational: true });
        }
      }

      // ── Scope filter: drop any AI-generated changes that violate scope ─────────
      // blockedPrefixes is actually ENFORCED here, not just mentioned in the
      // prompt text — previously only allowedPrefixes was checked, so a broad
      // allow-prefix like "app/" (needed to permit creating new pages) gave no
      // real protection against the model also touching "app/api/**", since
      // that path legitimately starts with "app/" too.
      //
      // When scope was auto-computed, isEditAllowed() applies a STRICTER rule
      // than prefix matching alone: an EXISTING file may only be touched if it
      // was actually shown to the model (exact membership in targetFiles) — a
      // broad allow-prefix should only ever permit CREATING a genuinely new
      // file, never blindly overwriting one the model never saw. Confirmed
      // live: without this, a request to add a new page also silently
      // rewrote two completely unrelated, pre-existing API routes that were
      // never part of the conversation — both matched the broad "app/api/"
      // prefix needed to let the genuinely new route be created.
      if (autoComputedScope && editProjectMap) {
        const existingPaths = new Set(editProjectMap.files.map(f => f.path));
        const before = editedFiles.length;
        const { isEditAllowed } = await import('@/services/engine/edit-scope');
        editedFiles = editedFiles.filter(f => isEditAllowed(autoComputedScope!, f.path, existingPaths));
        if (editedFiles.length < before) {
          const blocked = before - editedFiles.length;
          autoErrorBlock = (autoErrorBlock ? autoErrorBlock + '\n' : '') +
            `[SCOPE GATE] Blocked ${blocked} out-of-scope file change(s) — only ${scopeConstraint.layer} files were applied.`;
        }
      } else if (scopeConstraint.allowedPrefixes?.length) {
        const before = editedFiles.length;
        editedFiles = editedFiles.filter(f => {
          const allowed = scopeConstraint.allowedPrefixes!.some(prefix => f.path.startsWith(prefix));
          const blocked = (scopeConstraint.blockedPrefixes ?? []).some(prefix => f.path.startsWith(prefix));
          return allowed && !blocked;
        });
        if (editedFiles.length < before) {
          // Some files were blocked by scope — log but don't error
          const blocked = before - editedFiles.length;
          autoErrorBlock = (autoErrorBlock ? autoErrorBlock + '\n' : '') +
            `[SCOPE GATE] Blocked ${blocked} out-of-scope file change(s) — only ${scopeConstraint.layer} files were applied.`;
        }
      }

      // ── Pre-apply snapshot for regression rollback ────────────────────────────
      if (safeApply && editedFiles.length > 0) {
        const relPaths = editedFiles.map(f => f.path);
        await captureSnapshot(projectPath, relPaths);
      }

      // Apply files to the existing project path
      const result = await applyEditsToProject(projectPath, editedFiles);

      // ── Post-apply TypeScript safety check ────────────────────────────────────
      // If the fix introduced new TypeScript errors, roll back immediately.
      let regressionDetected = false;
      let newErrors: string[] = [];

      if (safeApply && result.filesChanged.length > 0) {
        try {
          const tsAfter = await validateProject(projectPath);
          const errorsAfter = tsAfter.errors ?? [];
          const countAfter = errorsAfter.length;

          // Regression: error count increased AND the new errors are genuinely new
          // (not pre-existing errors that appear in a different form)
          if (countAfter > tsBaselineCount) {
            // Identify new errors not present in the baseline
            const baselineSet = new Set(tsBaselineErrors.map(e => e.slice(0, 80)));
            newErrors = errorsAfter.filter(e => !baselineSet.has(e.slice(0, 80)));

            if (newErrors.length > 0) {
              // ROLLBACK — restore the snapshot
              await restoreSnapshot(projectPath);
              regressionDetected = true;

              return NextResponse.json({
                success: false,
                regressionDetected: true,
                filesChanged: result.filesChanged,
                tsBaselineCount,
                tsAfterCount: countAfter,
                newErrors: newErrors.slice(0, 10),
                restoredFiles: result.filesChanged,
                message: `Fix rolled back: introduced ${newErrors.length} new TypeScript error(s). The project has been restored to its pre-fix state.`,
                aiResponse,
              });
            }
          }
          // No regression — clear the snapshot
          await clearSnapshot(projectPath);
        } catch {
          // TypeScript check failed (may not be installed) — skip rollback
          await clearSnapshot(projectPath).catch(() => {});
        }
      }

      // ── Deterministic middleware auto-wiring for newly protected pages ───────
      // Confirmed live: creating a new page with auth-implying language
      // ("a /billing page where signed-in users can view and manage...")
      // correctly created the page but never updated middleware.ts — the new
      // page shipped completely unprotected. Rather than hoping the edit
      // model remembers to keep a generated array in sync (the SAME
      // unreliable pattern the deterministic auth-template.ts routes replaced
      // for register/login), patch middleware.ts deterministically whenever a
      // genuinely NEW page was just created and the request implies it needs
      // a session.
      if (!regressionDetected && editProjectMap) {
        try {
          const AUTH_IMPLIES_RE = /\bsigned.?in\b|\blogged.?in\b|\bauthenticated\b|members?.?only|requires?\s+(a\s+)?login|only\s+(for\s+)?(logged.?in|signed.?in|authenticated)\s+users?|only\s+users?\s+who/i;
          if (AUTH_IMPLIES_RE.test(userRequest)) {
            const existingPaths = new Set(editProjectMap.files.map(f => f.path));
            const newPage = result.filesChanged.find(p => /\/page\.(tsx|jsx)$/.test(p) && !existingPaths.has(p));
            if (newPage) {
              const { fileToRoute } = await import('@/services/engine/verifier');
              const route = fileToRoute(newPage);
              const mwPath = join(projectPath, 'middleware.ts');
              const mwContent = await readFile(mwPath, 'utf-8').catch(() => null);
              if (route && mwContent) {
                const { addProtectedRoute } = await import('@/services/engine/auth-template');
                const { patched, changed } = addProtectedRoute(mwContent, route);
                if (changed) {
                  await writeFile(mwPath, patched, 'utf-8');
                  result.filesChanged.push('middleware.ts');
                }
              }
            }
          }
        } catch { /* non-fatal — middleware auto-wiring is a best-effort addition, never blocks the edit */ }
      }

      // Record the edit in memory
      if (result.filesChanged.length > 0 && !regressionDetected) {
        await recordEditApplied(projectPath, userRequest, result.filesChanged);
      }

      return NextResponse.json({
        success: result.success,
        filesChanged: result.filesChanged,
        errors: result.errors,
        aiResponse,
        tsBaselineCount,
        scopeApplied: !!scopeConstraint.layer,
      });
    }

    // ── generate: build app from approved conversation ─────────────────────────
    if (action === 'generate') {
      const turns: ConversationTurn[] = Array.isArray(messages) ? messages : [];
      const stringTurns = turns.map(t => ({
        role: t.role,
        content: typeof t.content === 'string' ? t.content : '[image attached]',
      }));
      // Design style selected by user in the builder UI
      const designStyle = typeof body.designStyle === 'string' ? body.designStyle : 'modern';

      // ── Step 0: Extract and lock the project specification ────────────────────
      // This happens BEFORE building the prompt so the spec anchor can be prepended
      // to ALL three strategy prompts (including the MVP fallback).
      // Deterministic — no AI call, <5ms.
      const { extractSpecFromConversation, formatSpecAnchor, saveSpec } = await import('@/services/project-spec');
      const { getArchitectureHints } = await import('@/services/build-templates');
      const lockedSpec = extractSpecFromConversation(stringTurns);
      const specAnchor = formatSpecAnchor(lockedSpec);
      const archHints = getArchitectureHints(lockedSpec.type);
      console.log(`[generate] Spec locked — name: "${lockedSpec.name}", type: "${lockedSpec.type}"`);

      // ── Intent Verification Stage ─────────────────────────────────────────────
      // Return this to the builder UI before generation starts so the user can
      // see what was understood. The builder displays it as a "Detected intent"
      // card. If the intent is wrong, the user can correct before code is written.
      const INTENT_LABELS: Record<string, string> = {
        marketplace:    'Marketplace (listings, sellers, buyers)',
        booking:        'Booking & Reservations',
        saas:           'SaaS / Dashboard',
        social:         'Social Network / Community',
        ecommerce:      'E-Commerce Store',
        management:     'Management / CRM',
        'real-estate':  'Real Estate / Property',
        education:      'Education / Learning Platform',
        health:         'Health / Medical',
        'food-delivery':'Food Delivery',
        travel:         'Travel / Tourism',
        finance:        'Finance / Fintech',
        custom:         'Custom Application',
      };
      const intentSummary = {
        projectName: lockedSpec.name,
        projectType: lockedSpec.type,
        projectTypeLabel: INTENT_LABELS[lockedSpec.type] ?? 'Custom Application',
        detectedFeatures: lockedSpec.features.slice(0, 6),
        detectedPages: lockedSpec.pages.slice(0, 8),
      };
      // The generate action returns intentSummary alongside the generated project.
      // The builder pipeline reads this and shows it before the first file is written.

      const buildUserMessage = stringTurns.length >= 1
        ? generateBuildPromptFromConversation(stringTurns)
        : (typeof prompt === 'string' ? `Generate a complete Next.js application for: ${prompt}` : '');

      if (!buildUserMessage) {
        return NextResponse.json({ success: false, error: 'No prompt or conversation provided' }, { status: 400 });
      }

      // ── RapidAPI registry sync — pick up newly subscribed APIs before planning ──
      // Runs a lightweight background refresh (uses in-process cache if < 30 min old).
      // This means every new generate call automatically sees the latest subscriptions
      // without any manual intervention. The scan is non-blocking and non-fatal.
      try {
        const { getRegistry } = await import('@/services/dynamic-registry');
        await getRegistry(); // warm the cache; triggers a real scan only if stale
      } catch { /* non-fatal — API Manager will fall back to cached registry */ }

      // ── API Manager — detect + plan APIs before AI generation ──────────────────
      // Routes in plan.routes are injected directly into the generated project below
      // (they are not left to the AI to guess from text instructions alone).
      //
      // IMPORTANT: scan USER MESSAGES ONLY for API category detection.
      // Scanning the full conversation (including AI responses) causes false positives:
      // a Ghana tourism app discussion naturally triggers weather/finance/sports keywords
      // from AI planning language ("check the weather", "exchange rates for tourists",
      // "sports activities") even though the user never asked for those features.
      const userOnlyText = stringTurns
        .filter(t => t.role === 'user')
        .map(t => t.content.replace('[READY_TO_BUILD]', '').trim())
        .filter(c => c && c.length > 3 && !/^(create now|build now|start building|generate now|build it|make it|go build|proceed|execute|yes|ok|okay|sure|let's go|yep|yeah)$/i.test(c))
        .join('\n');
      let apiPromptInstructions = '';
      let apiPlanRoutes: import('@/services/api-manager/generator').GeneratedRoute[] = [];
      let apiPlanMissingCategories: string[] = [];
      let apiPlanResolved: Array<{ category: string; host: string; providerName: string; providerId: string }> = [];
      const projectId = buildUserMessage.slice(0, 40).replace(/\W+/g, '-').toLowerCase() + `-${Date.now()}`;
      try {
        const { apiManager } = await import('@/services/api-manager/index');
        const plan = await apiManager.planForPrompt(userOnlyText || buildUserMessage, projectId);
        apiPromptInstructions = plan.promptInstructions;
        apiPlanRoutes = plan.routes;            // written into the project after AI generation
        apiPlanMissingCategories = plan.missing;
        apiPlanResolved = plan.resolved;
        if (plan.resolved.length > 0) {
          console.log('[generate] APIs resolved:', plan.resolved.map(r => `${r.category}→${r.providerName}`).join(', '));
        }
        if (plan.missing.length > 0) {
          console.warn('[generate] No working provider for:', plan.missing.join(', '));
        }
      } catch (err) {
        console.warn('[generate] API Manager skipped:', err instanceof Error ? err.message : err);
      }

      // Accept if the response has at minimum a main page file (package.json can be inferred / scaffold-patched).
      const hasRequiredFiles = (data: { files: Array<{ path: string }> }) => {
        const REQUIRED = new Set([
          'app/page.tsx', 'app/page.ts', 'app/page.jsx', 'app/page.js',
          'src/app/page.tsx', 'src/app/page.ts', 'src/app/page.jsx', 'src/app/page.js',
          'pages/index.tsx', 'pages/index.ts', 'pages/index.jsx', 'pages/index.js',
        ]);
        return data.files.some(f => REQUIRED.has(f.path));
      };

      // Extract a short app description for fallback strategies
      const shortDesc = buildUserMessage.slice(0, 400).replace(/\n/g, ' ');

      // Three strategies tried in order:
      // 1. Normal — full build prompt + any detected API provider instructions
      // 2. Explicit format — same but with a hard reminder to output the required block format
      // 3. MVP skeleton — minimal working version only
      const apiSuffix = apiPromptInstructions ? `\n${apiPromptInstructions}` : '';

      // Inject design style system prompt based on user's selection
      const DESIGN_STYLE_TOKENS: Record<string, string> = {
        classic:       '\n[DESIGN_STYLE: Classic Professional]\nColor palette: Blue (#2563eb), white backgrounds, gray-100 surfaces. Subtle fade-in animations (Framer Motion, 150ms). Traditional header+sidebar grid. rounded-lg, subtle shadow-sm.\n',
        modern:        '\n[DESIGN_STYLE: Modern Bold]\nColor palette: Purple-to-blue gradient (#7c3aed→#2563eb), dark bg (#0f172a). Spring physics animations, staggered reveals (Framer Motion staggerChildren 0.06s). Pill buttons, gradient borders.\n',
        'premium-3d':  '\n[DESIGN_STYLE: Premium 3D Glassmorphism]\nColor palette: Deep navy (#050b18), gold (#d4a017), glass cards (backdrop-blur-xl, bg-white/5, border-white/10). 3D tilt on hover (perspective-1000), shimmer effects, floating ambient glow. Gold gradient on hero text.\n',
        'mobile-first':'\n[DESIGN_STYLE: Mobile First Native App]\nColor palette: White bg, teal (#0ea5e9) accent. 44px+ touch targets, bottom nav bar, full-width CTAs. Bounce tap feedback (Framer Motion whileTap scale 0.97), slide-up modals.\n',
        minimal:       '\n[DESIGN_STYLE: Minimal Content First]\nColor palette: Pure white bg, #0a0a0a text, ONE accent color used sparingly. No box-shadows, hairline borders, system-ui font, generous whitespace (py-16). Minimal animation (opacity only).\n',
      };
      const styleToken = DESIGN_STYLE_TOKENS[designStyle] ?? DESIGN_STYLE_TOKENS.modern;

      const buildStrategies: Array<() => string> = [
        // Strategy 1: Full build prompt with spec anchor at top
        () => `${specAnchor}
${archHints}
${styleToken}
${buildUserMessage}${apiSuffix}`,

        // Strategy 2: Same + hard format reminder
        () => `${specAnchor}
${archHints}

${buildUserMessage}${apiSuffix}

⚠️ REQUIRED OUTPUT FORMAT — DO NOT SKIP:
Your response MUST begin with [START_PROJECT] on its own line and end with [END_PROJECT].
Include AT MINIMUM: package.json and app/page.tsx.
Do NOT reply conversationally. Output the project files IMMEDIATELY.`,

        // Strategy 3: MVP fallback — spec anchor REPLACES shortDesc so project intent survives
        () => `${specAnchor}
${archHints}
${apiSuffix}

Build a minimal but fully working MVP for the project described in the SPECIFICATION above.
Keep it simple — 5 to 8 files total. Required files:
1. package.json
2. next.config.ts
3. app/layout.tsx
4. app/page.tsx  ← main homepage matching the project spec above — NOT a weather/finance dashboard
5. app/globals.css
6. At least one API route matching the project type

Start with [START_PROJECT] immediately. No explanation, no preamble.`,
      ];

      // The caller (builder escalation) may request a specific tier when retrying after
      // a scaffold fallback — e.g. tier='SONNET' or tier='STRONGEST'.
      const generateTier: import('@/lib/constants').BedrockTier =
        body.tier === 'STRONGEST' ? 'STRONGEST'
        : body.tier === 'SONNET' ? 'SONNET'
        : 'SONNET'; // default for generation — Haiku is too weak for full app codegen

      let projectData = null;
      let lastRawError = '';
      let winningRaw = ''; // raw AI text of the accepted strategy — holds the [ROUTE_MANIFEST]
      let lastRaw = '';    // raw AI text of the last attempt (for loose recovery)

      for (let attempt = 0; attempt < buildStrategies.length; attempt++) {
        try {
          const strategyPrompt = buildStrategies[attempt]();
          // buildWithAI now uses BEDROCK_FALLBACK_CHAINS internally — if the primary
          // model for generateTier is unavailable it automatically tries the next one
          // in the chain (e.g. Sonnet 4.6 → Sonnet 4.5 → Haiku) without any manual retry.
          const aiResponse = await buildWithAI(strategyPrompt, BUILD_SYSTEM_PROMPT, generateTier);
          lastRaw = aiResponse;
          const parsed = parseProjectFormat(aiResponse);

          if (parsed && parsed.files.length > 0 && hasRequiredFiles(parsed)) {
            projectData = parsed;
            winningRaw = aiResponse;
            break;
          }

          lastRawError = parsed
            ? `Strategy ${attempt + 1}: Missing app/page.tsx in generated files`
            : `Strategy ${attempt + 1}: No [START_PROJECT] block in AI response`;
          console.error(`[generate] ${lastRawError}`);
        } catch (err) {
          lastRawError = err instanceof Error ? err.message : `Strategy ${attempt + 1} threw`;
          console.error('[generate] Strategy', attempt + 1, 'threw:', lastRawError);
        }

        if (attempt < buildStrategies.length - 1) {
          await new Promise(r => setTimeout(r, (attempt + 1) * 1500));
        }
      }

      // ── Loose recovery: the model returned a "spec" with code blocks instead of ──
      // the strict [START_PROJECT] format. Extract real files from <file> tags or
      // labelled fenced code blocks so we build a REAL app instead of a placeholder.
      if (!projectData && lastRaw) {
        try {
          const recovered = parseLooseProjectFiles(lastRaw);
          if (recovered.length > 0 && hasRequiredFiles({ files: recovered })) {
            projectData = {
              projectName: lockedSpec.name || 'generated-app',
              description: shortDesc.slice(0, 200),
              mode: 'Full-Stack App',
              files: recovered,
            };
            winningRaw = lastRaw;
            console.log(`[generate] Strict parse failed — recovered ${recovered.length} real file(s) via loose parser`);
          } else {
            console.warn(`[generate] Loose parser recovered ${recovered.length} file(s) but no usable root page`);
          }
        } catch (e) {
          console.warn('[generate] Loose recovery error:', e instanceof Error ? e.message : e);
        }
      }

      // ── Scaffold fallback: if all AI strategies fail, return a working placeholder ──
      // The user always gets SOMETHING. The autonomous loop will fix the real content.
      if (!projectData) {
        console.error('[generate] All strategies failed — using scaffold fallback. Last error:', lastRawError);

        // Extract app name from the prompt
        const appNameMatch = shortDesc.match(/(?:build|create|make|generate)\s+(?:a\s+|an\s+|me\s+a\s+)?(.{3,60}?)(?:\s+with|\s+that|\s+for|\s+using|$)/i);
        const appTitle = appNameMatch ? appNameMatch[1].trim() : 'My App';
        const safeName = appTitle.replace(/[^a-zA-Z0-9\s-]/g, '').trim().slice(0, 40) || 'my-app';
        const projectName = safeName.split(/\s+/).map((w: string, i: number) => i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w).join(' ');

        projectData = {
          projectName,
          description: shortDesc.slice(0, 200),
          files: [
            {
              path: 'package.json',
              content: JSON.stringify({
                name: safeName.toLowerCase().replace(/\s+/g, '-'),
                version: '0.1.0',
                private: true,
                scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
                dependencies: {
                  next: '^15.0.0',
                  react: '^18.0.0',
                  'react-dom': '^18.0.0',
                  typescript: '^5.0.0',
                  '@types/node': '^20.0.0',
                  '@types/react': '^18.0.0',
                  tailwindcss: '^3.4.0',
                  '@tailwindcss/forms': '^0.5.0',
                  autoprefixer: '^10.4.0',
                  postcss: '^8.4.0',
                },
              }, null, 2),
            },
            {
              path: 'next.config.ts',
              content: `import type { NextConfig } from 'next';\nconst config: NextConfig = {};\nexport default config;\n`,
            },
            {
              path: 'tsconfig.json',
              content: JSON.stringify({
                compilerOptions: {
                  target: 'ES2017', lib: ['dom', 'dom.iterable', 'esnext'], allowJs: true,
                  skipLibCheck: true, strict: true, noEmit: true, esModuleInterop: true,
                  module: 'esnext', moduleResolution: 'bundler', resolveJsonModule: true,
                  isolatedModules: true, jsx: 'preserve', incremental: true,
                  plugins: [{ name: 'next' }],
                  paths: { '@/*': ['./*'] },
                },
                include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
                exclude: ['node_modules'],
              }, null, 2),
            },
            {
              path: 'tailwind.config.ts',
              content: `import type { Config } from 'tailwindcss';\nconst config: Config = { content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'], theme: { extend: {} }, plugins: [] };\nexport default config;\n`,
            },
            {
              path: 'postcss.config.js',
              content: `module.exports = { plugins: { tailwindcss: {}, autoprefixer: {} } };\n`,
            },
            {
              path: 'app/globals.css',
              content: `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n`,
            },
            {
              path: 'app/layout.tsx',
              content: `import type { Metadata } from 'next';\nimport './globals.css';\nexport const metadata: Metadata = { title: '${projectName}', description: '${shortDesc.slice(0, 100)}' };\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (<html lang="en"><body className="bg-gray-50 text-gray-900">{children}</body></html>);\n}\n`,
            },
            {
              path: 'app/page.tsx',
              content: `'use client';\nexport default function HomePage() {\n  return (\n    <main className="min-h-screen flex flex-col items-center justify-center p-8">\n      <div className="max-w-2xl w-full text-center">\n        <h1 className="text-4xl font-bold text-gray-900 mb-4">${projectName}</h1>\n        <p className="text-lg text-gray-600 mb-8">Building your app — the agent is generating the full codebase now.</p>\n        <div className="animate-pulse bg-blue-600 text-white px-6 py-3 rounded-lg inline-block">Generating…</div>\n      </div>\n    </main>\n  );\n}\n`,
            },
          ],
        };
      }

      // ── Inject API Manager route files into the generated project ────────────
      // plan.routes contains pre-built integration route files (e.g. app/api/integrations/weather/route.ts).
      // These are injected directly so the AI doesn't need to guess the proxy pattern from text alone.
      // Rule: never overwrite a file the AI already generated — only add missing integration routes.
      if (apiPlanRoutes.length > 0 && projectData) {
        const existingPaths = new Set(projectData.files.map((f: { path: string }) => f.path));
        let injectedCount = 0;
        for (const route of apiPlanRoutes) {
          if (!existingPaths.has(route.path)) {
            projectData.files.push({ path: route.path, content: route.content });
            injectedCount++;
          }
        }
        if (injectedCount > 0) {
          console.log(`[generate] Injected ${injectedCount} API Manager route file(s) into project`);
        }
      }

      // ── Route Manifest Reconciliation — fix the #1 cause of broken apps ───────
      // The build prompt asks the model to declare a [ROUTE_MANIFEST] and create a
      // page for every route it links to. On large single-pass generations the model
      // routinely DECLARES pages it never writes — leaving <Link href="/x"> with no
      // app/x/page.tsx (a 404 / "broken, incomplete app"). Until now the manifest was
      // never read back, so those gaps survived to the user as dead links or hollow
      // "coming soon" stubs.
      //
      // Here we read the manifest back, diff it against the files actually generated,
      // and ask the model to emit REAL pages for the gap — merged in before the
      // project is ever written to disk. Deterministic: no running server / Playwright.
      if (projectData && winningRaw) {
        try {
          const { parseRouteManifest, findMissingManifestPages } = await import('@/services/route-reconciler');
          const declaredPages = parseRouteManifest(winningRaw);
          const missingPages = findMissingManifestPages(declaredPages, projectData.files);

          if (missingPages.length > 0) {
            console.warn(`[generate] Route reconciliation — ${missingPages.length} declared page(s) missing: ${missingPages.join(', ')}`);
            const { buildMissingPagesPrompt } = await import('@/services/route-reconciler');
            const fillPrompt = buildMissingPagesPrompt(missingPages, projectData.files, specAnchor);
            // Use the same generation tier so quality matches the rest of the app.
            const fillRaw = await buildWithAI(fillPrompt, BUILD_SYSTEM_PROMPT, generateTier);
            const fillFiles = parseEditFormat(fillRaw);

            const existingPaths = new Set(projectData.files.map((f: { path: string }) => f.path));
            let filledCount = 0;
            for (const f of fillFiles) {
              // Only accept page files for routes we actually flagged as missing.
              if (!/\/page\.[jt]sx?$/.test(f.path)) continue;
              if (existingPaths.has(f.path)) continue;
              projectData.files.push({ path: f.path, content: f.content });
              existingPaths.add(f.path);
              filledCount++;
            }
            console.log(`[generate] Route reconciliation — generated ${filledCount} real page(s) for missing routes`);
          } else if (declaredPages.length > 0) {
            console.log('[generate] Route reconciliation — manifest complete, all declared pages present');
          }
        } catch (err) {
          // Non-fatal: the generation-time auditAndRepairRoutes stub net still runs.
          console.warn('[generate] Route reconciliation skipped:', err instanceof Error ? err.message : err);
        }
      }

      // True only when NO root-page file has real content.
      // Must match the same path variants as hasRequiredFiles() to avoid false positives
      // (e.g. AI generates src/app/page.tsx or app/page.jsx → real project, not scaffold).
      const ROOT_PAGE_PATHS = new Set([
        'app/page.tsx', 'app/page.ts', 'app/page.jsx', 'app/page.js',
        'src/app/page.tsx', 'src/app/page.ts', 'src/app/page.jsx', 'src/app/page.js',
        'pages/index.tsx', 'pages/index.ts', 'pages/index.jsx', 'pages/index.js',
      ]);
      const SCAFFOLD_TEXT = ['Generating…', 'Building your app', 'the agent is generating'];
      const isScaffoldResponse = !projectData.files.some(
        (f: { path: string; content: string }) =>
          ROOT_PAGE_PATHS.has(f.path) &&
          !SCAFFOLD_TEXT.some(t => f.content.includes(t))
      );
      // Diagnostic: log which root page file was found (or none)
      const foundPageFile = projectData.files.find((f: { path: string }) => ROOT_PAGE_PATHS.has(f.path));
      console.log(`[generate] scaffoldFallback=${isScaffoldResponse} rootPage=${foundPageFile?.path ?? 'NONE'} tier=${generateTier} files=${projectData.files.length}`);
      return NextResponse.json({
        success: true,
        projectData,
        scaffoldFallback: isScaffoldResponse,
        scaffoldReason: isScaffoldResponse ? (lastRawError || 'AI generation returned empty or unparseable output') : undefined,
        modelTier: generateTier,
        // ── Locked spec — passed back to client so it can be forwarded to the
        //    create action and saved to disk alongside the project files.
        lockedSpec,
        // ── Intent summary — builder displays this before files are written so
        //    user can confirm the correct app is being generated.
        intentSummary,
        // Surface API plan status to the builder for user messaging
        apiPlan: {
          resolved: apiPlanResolved,
          missing: apiPlanMissingCategories,
          rapidApiConfigured: apiPlanResolved.length > 0 || apiPlanMissingCategories.length === 0,
        },
      });
    }

    // ── create: write generated files to disk ──────────────────────────────────
    // ── engine-build: NEW Generation Engine (Planner→Builder→Verifier→Repairer→Learner) ──
    // SAFE, ADDITIVE EXPOSURE ONLY. Does not replace the existing generate/create
    // flow and does not change the UI. Returns the full EngineReport. Static
    // verification (no localhost probe) for now.
    if (action === 'engine-build') {
      const enginePrompt = typeof prompt === 'string'
        ? prompt
        : (Array.isArray(messages)
            ? messages.filter((m: ConversationTurn) => m.role === 'user').map((m: ConversationTurn) => (typeof m.content === 'string' ? m.content : '')).join('\n').trim()
            : '');
      if (!enginePrompt) {
        return NextResponse.json({ success: false, error: 'No prompt provided for engine-build' }, { status: 400 });
      }
      try {
        console.log('[engine-build] pipeline starting — Planner → Builder → Verifier → Repairer → Learner');
        const { runEngineBuild } = await import('@/services/engine/orchestrator');
        const report = await runEngineBuild(enginePrompt);
        for (const line of report.logs) console.log('[engine-build]', line);
        console.log(`[engine-build] FINAL: status=${report.status} success=${report.success} — ${report.summary}`);
        return NextResponse.json({ success: report.success, report });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[engine-build] pipeline error:', msg);
        return NextResponse.json({ success: false, error: msg }, { status: 500 });
      }
    }

    if (action === 'create') {
      const projectData = prompt;
      if (!projectData?.projectName || !Array.isArray(projectData.files)) {
        return NextResponse.json({ success: false, error: 'Invalid project data' }, { status: 400 });
      }

      const createAuthUser = await getAuthUser(request);
      const ownerUserId = createAuthUser?.sub ?? 'anonymous';

      // ── CREDIT GATE: AI generation costs credits ──────────────────────────────
      // New users get an initial free-plan grant. If a signed-in user has run out,
      // block with a clear top-up message. Fail-open on store errors so a billing
      // outage never bricks the builder. Disable enforcement with ENFORCE_CREDITS=0.
      if (ownerUserId !== 'anonymous') {
        try {
          const { ensureInitialGrant, getBalance } = await import('@/services/credit-wallet');
          const { getOrCreateSubscription } = await import('@/services/subscription-manager');
          const { getPlan, CREDIT_CONFIG } = await import('@/lib/billing-config');
          const sub = await getOrCreateSubscription(ownerUserId, createAuthUser?.email ?? '');
          await ensureInitialGrant(ownerUserId, getPlan('free').limits.monthlyCredits);
          const balance = await getBalance(ownerUserId);
          if (process.env.ENFORCE_CREDITS !== '0' && balance < CREDIT_CONFIG.generationCostCredits) {
            return NextResponse.json(
              { success: false, error: 'You are out of credits. Please top up to keep generating.', code: 'NO_CREDITS', balance },
              { status: 402 },
            );
          }
        } catch (e) {
          console.warn('[create] credit pre-check skipped (fail-open):', e instanceof Error ? e.message : e);
        }
      }

      const result = await generateProject(projectData.projectName, projectData.files);

      // Deduct one generation credit now that the project was created successfully.
      if (ownerUserId !== 'anonymous') {
        try {
          const { deduct } = await import('@/services/credit-wallet');
          await deduct(ownerUserId, `generation: ${result.projectName}`);
        } catch (e) {
          console.warn('[create] credit deduct skipped:', e instanceof Error ? e.message : e);
        }
      }

      // Force-write a known-good Next.js tsconfig immediately after file creation.
      // AI models hallucinate non-existent compiler options (e.g. useDefineForEnumMembers)
      // that cause TS5023 and crash `next dev` before the first page loads.
      // We preserve any extra `paths` the AI added so module aliases still work.
      {
        const tsconfigPath = join(result.projectPath, 'tsconfig.json');
        const SAFE_TSCONFIG = {
          compilerOptions: {
            lib: ['dom', 'dom.iterable', 'esnext'],
            allowJs: true,
            skipLibCheck: true,
            strict: true,
            noEmit: true,
            esModuleInterop: true,
            module: 'esnext',
            moduleResolution: 'bundler',
            resolveJsonModule: true,
            isolatedModules: true,
            jsx: 'preserve',
            incremental: true,
            plugins: [{ name: 'next' }],
            paths: { '@/*': ['./*'] } as Record<string, string[]>,
          },
          include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
          exclude: ['node_modules'],
        };
        try {
          const existing = JSON.parse(await readFile(tsconfigPath, 'utf-8').catch(() => '{}'));
          if (existing.compilerOptions?.paths) {
            Object.assign(SAFE_TSCONFIG.compilerOptions.paths, existing.compilerOptions.paths);
          }
        } catch { /* ignore parse errors */ }
        await writeFile(tsconfigPath, JSON.stringify(SAFE_TSCONFIG, null, 2) + '\n', 'utf-8').catch(() => {});
      }

      // Save to project manifest — stamped with ownerUserId for per-user isolation
      const saved = await saveProject({
        ownerUserId,
        name: result.projectName,
        description: projectData.description || '',
        projectPath: result.projectPath,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        filesCount: result.filesCreated,
      });

      // Init per-project memory
      // Extract a purpose from the conversation if available
      const originalPrompt = body.originalPrompt || projectData.description || result.projectName;
      await initProjectMemory({
        projectId: saved.id,
        name: result.projectName,
        originalPrompt,
        projectPath: result.projectPath,
      });

      // Record in global memory
      await recordBuild(result.projectName, originalPrompt, true);

      // ── Save locked spec to disk for repair context recovery ─────────────────
      // If the caller forwarded the lockedSpec from the generate response, save it
      // so future repair/edit cycles can reload it without re-reading history.
      if (body.lockedSpec) {
        try {
          const { saveSpec } = await import('@/services/project-spec');
          await saveSpec(result.projectPath, body.lockedSpec);
          console.log(`[create] Spec saved to ${result.projectPath}/.dwomoh/spec.json`);
        } catch { /* non-fatal */ }
      }


      return NextResponse.json({
        success: true,
        projectName: result.projectName,
        projectPath: result.projectPath,
        foldersCreated: result.foldersCreated,
        filesCreated: result.filesCreated,
        description: projectData.description || '',
        logs: result.logs,
        projectId: saved.id,
      });
    }

    // ── build-report: structured proof of what THIS build actually created ──────
    // Scans the project on disk: file count, pages/routes, api routes, components,
    // and referenced-but-missing routes (dead links / 404 risk). Real files only.
    if (action === 'build-report') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      try {
        const { buildReport } = await import('@/services/build-report');
        const report = await buildReport(projectPath as string);
        return NextResponse.json({ success: true, report });
      } catch (e) {
        return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
      }
    }

    // ── install: npm install ──────────────────────────────────────────────────
    if (action === 'install') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const extraFlags: string[] = Array.isArray(body.flags) ? body.flags : [];
      const result = await installDependencies(projectPath, extraFlags);
      return NextResponse.json({ ...result, projectPath });
    }

    // ── install-package: npm install <pkg> --force (bypass peer dep conflicts) ──
    if (action === 'install-package') {
      if (!projectPath || !body.packageName) return NextResponse.json({ success: false, error: 'Missing projectPath or packageName' });
      const result = await installDependencies(projectPath, ['--force', body.packageName as string]);
      return NextResponse.json({ ...result, projectPath, packageName: body.packageName });
    }

    // ── validate: run tsc --noEmit ────────────────────────────────────────────
    if (action === 'validate') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const result = await validateProject(projectPath);
      return NextResponse.json(result);
    }

    // ── fix-errors: classify → missing packages first, then AI code fix ────────
    if (action === 'fix-errors') {
      const { errors, filePaths, tier: fixTier } = body;
      if (!projectPath || !errors?.length) {
        return NextResponse.json({ success: false, error: 'Missing projectPath or errors' }, { status: 400 });
      }

      // Haiku handles trivial TS fixes; Sonnet is the default for non-trivial errors;
      // callers may pass tier='STRONGEST' to escalate on repeated failures.
      const fixErrorsTier: import('@/lib/constants').BedrockTier =
        fixTier === 'STRONGEST' ? 'STRONGEST'
        : fixTier === 'HAIKU' ? 'HAIKU'
        : 'SONNET'; // default — TypeScript + code fixes need Sonnet's reasoning

      const errorText = Array.isArray(errors) ? errors.join('\n') : String(errors);

      // Step 1: Check for missing packages — install them before AI fix
      const missingPkgs = extractAllMissingPackages(errorText);
      const installedPkgs: string[] = [];
      if (missingPkgs.length > 0) {
        // Add to package.json
        const { readFile: rf, writeFile: wf } = await import('fs/promises');
        const pkgPath = join(projectPath, 'package.json');
        try {
          const pkgJson = JSON.parse(await rf(pkgPath, 'utf-8'));
          if (!pkgJson.dependencies) pkgJson.dependencies = {};
          for (const pkg of missingPkgs) {
            if (!pkgJson.dependencies[pkg] && !pkgJson.devDependencies?.[pkg]) {
              pkgJson.dependencies[pkg] = 'latest';
              installedPkgs.push(pkg);
            }
          }
          if (installedPkgs.length > 0) {
            await wf(pkgPath, JSON.stringify(pkgJson, null, 2) + '\n', 'utf-8');
            await installDependencies(projectPath, ['--legacy-peer-deps']);
          }
        } catch { /* ignore if package.json missing */ }
      }

      // Step 2: Check for auth misconfiguration — apply fallback
      const hasAuthError = errorText.toLowerCase().includes('nextauth') ||
        errorText.toLowerCase().includes('auth_secret') ||
        errorText.toLowerCase().includes('[next-auth]');
      if (hasAuthError) {
        const recovery = await attemptRecovery(projectPath, errorText);
        if (recovery.fixed) {
          return NextResponse.json({
            success: true,
            filesFixed: recovery.filesPatched.length,
            packagesInstalled: recovery.packagesInstalled,
            kind: recovery.classified.kind,
            userMessage: recovery.classified.userMessage,
            errors: [],
          });
        }
      }

      // Step 3: AI-based code fix for remaining TypeScript/syntax errors
      // identifyAffectedFiles extracts real paths from tsc output; fall back to common files.
      const resolvedPaths = filePaths?.length ? filePaths : identifyAffectedFiles(errors);
      const affected = resolvedPaths.length > 0 ? resolvedPaths : ['app/page.tsx', 'app/layout.tsx'];
      const sourceFiles = await readProjectFiles(projectPath, affected);
      const fixPrompt = generateErrorFixPrompt(errors, sourceFiles);
      const aiResponse = await fixErrorsWithAI(fixPrompt, BUILD_SYSTEM_PROMPT, fixErrorsTier);

      let fixedFiles = parseEditFormat(aiResponse);
      if (fixedFiles.length === 0) {
        const parsed = parseProjectFormat(aiResponse);
        if (parsed?.files?.length) {
          fixedFiles = parsed.files.map(f => ({ path: f.path, content: f.content }));
        }
      }

      if (fixedFiles.length === 0 && installedPkgs.length === 0) {
        return NextResponse.json({ success: false, error: 'Could not produce fixes', raw: aiResponse.slice(0, 500) });
      }

      const result = fixedFiles.length > 0
        ? await applyEditsToProject(projectPath, fixedFiles)
        : { success: true, filesChanged: [], errors: [] };

      return NextResponse.json({
        success: result.success,
        filesFixed: result.filesChanged.length,
        packagesInstalled: installedPkgs,
        errors: result.errors,
      });
    }

    // ── clear-cache: delete .next and .turbo so the next start recompiles fresh ─
    if (action === 'clear-cache') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      await clearBuildCache(projectPath);
      return NextResponse.json({ success: true, message: 'Build cache cleared' });
    }

    // ── wait-for-server: poll until the generated app responds (or timeout) ─────
    // Use this after a forced restart with package installs — Next.js cold compile
    // can take 30-90s, so a flat sleep is never enough.
    if (action === 'wait-for-server') {
      const targetPort = body.port as number;
      const maxMs = (body.timeout as number) ?? 90000;
      if (!targetPort) return NextResponse.json({ ready: false, error: 'Missing port' });

      // Read the server state so we can detect if the process has died
      const srvState = await readServerState();
      const serverPid = srvState?.port === targetPort ? srvState.pid : null;

      function isPidAlive(pid: number): boolean {
        try { process.kill(pid, 0); return true; } catch { return false; }
      }

      const start = Date.now();
      let lastStatus = 0;
      while (Date.now() - start < maxMs) {
        // If we know the PID and it's no longer alive, stop waiting immediately
        if (serverPid && !isPidAlive(serverPid)) {
          const logContent = srvState ? await getServerLogs(srvState.projectPath).catch(() => '') : '';
          const errorLines = logContent.split('\n')
            .filter((l: string) => /error|failed|module not found|cannot find|enoent/i.test(l))
            .slice(0, 5)
            .join('\n');
          return NextResponse.json({ ready: false, crashed: true, ms: Date.now() - start, lastStatus, errorLines });
        }

        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 3000);
          const res = await fetch(`http://localhost:${targetPort}/`, { signal: ctrl.signal });
          clearTimeout(t);
          lastStatus = res.status;
          if (res.status !== 503) {
            return NextResponse.json({ ready: true, ms: Date.now() - start, statusCode: res.status });
          }
        } catch { /* not ready */ }
        await new Promise(r => setTimeout(r, 3000));
      }
      return NextResponse.json({ ready: false, ms: maxMs, lastStatus });
    }

    // ── check-installed: verify packages are actually in node_modules ─────────
    if (action === 'check-installed') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' });
      const pkgsToCheck: string[] = Array.isArray(body.packages) ? body.packages : [];
      const missing: string[] = [];
      for (const pkg of pkgsToCheck) {
        const pkgDir = join(projectPath, 'node_modules', ...pkg.split('/'));
        try { await stat(pkgDir); } catch { missing.push(pkg); }
      }
      return NextResponse.json({ allInstalled: missing.length === 0, missing });
    }

    // ── pre-scan-imports: find packages used in source but missing from pkg.json ─
    // Run this BEFORE npm install so every imported package gets installed on the
    // first attempt rather than being caught by the validation loop.
    if (action === 'pre-scan-imports') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });

      const { readdir: rd, readFile: rf, writeFile: wf } = await import('fs/promises');
      const { join: j } = await import('path');

      // Packages bundled with Next.js / Node.js — don't need separate installation
      const SKIP_PKGS = new Set([
        'react', 'react-dom', 'next', 'typescript', '@types/react', '@types/node',
        'path', 'fs', 'os', 'crypto', 'stream', 'util', 'events', 'buffer',
        'url', 'querystring', 'http', 'https', 'net', 'dns', 'child_process',
        'worker_threads', 'perf_hooks', 'assert', 'module', 'process',
      ]);

      const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', '.turbo']);
      const scanDir = async (dir: string): Promise<string[]> => {
        const out: string[] = [];
        try {
          for (const e of await rd(dir, { withFileTypes: true })) {
            if (e.isDirectory() && !SKIP_DIRS.has(e.name)) out.push(...await scanDir(j(dir, e.name)));
            else if (e.isFile() && /\.(ts|tsx)$/.test(e.name)) out.push(j(dir, e.name));
          }
        } catch { /* unreadable dir */ }
        return out;
      };

      const files = await scanDir(projectPath);
      const pkgPath = j(projectPath, 'package.json');
      let pkgJson: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
      try { pkgJson = JSON.parse(await rf(pkgPath, 'utf-8')); } catch { return NextResponse.json({ success: false, error: 'No package.json' }); }

      const existing = { ...pkgJson.dependencies, ...pkgJson.devDependencies };
      const toAdd: Record<string, string> = {};

      // Regex to detect AI-pinned future versions that may not exist on npm yet
      const BAD_VERSION_RE = /\^[5-9]\.\d+\.\d+/;

      for (const file of files) {
        try {
          const src = await rf(file, 'utf-8');
          const re = /import\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
          let m;
          while ((m = re.exec(src)) !== null) {
            const imp = m[1];
            if (imp.startsWith('.') || imp.startsWith('@/')) continue;
            const pkg = imp.startsWith('@') ? imp.split('/').slice(0, 2).join('/') : imp.split('/')[0];
            if (!pkg || SKIP_PKGS.has(pkg)) continue;
            if (!existing[pkg]) {
              // Package missing from package.json — add it
              toAdd[pkg] = 'latest';
            } else if (BAD_VERSION_RE.test(existing[pkg])) {
              // Package has an AI-hallucinated version that may not exist — reset to latest
              toAdd[pkg] = 'latest';
            }
          }
        } catch { /* skip */ }
      }

      const addedPackages = Object.keys(toAdd);
      if (addedPackages.length > 0) {
        if (!pkgJson.dependencies) pkgJson.dependencies = {};
        Object.assign(pkgJson.dependencies, toAdd);
        await wf(pkgPath, JSON.stringify(pkgJson, null, 2) + '\n', 'utf-8');
      }

      // Sanitize tsconfig.json: remove hallucinated or Next.js-incompatible options
      // so `next dev` does not crash with TS5023 "Unknown compiler option".
      const INVALID_TSCONFIG_OPTIONS = new Set([
        'useDefineForEnumMembers',  // Not a real TypeScript option (AI hallucination)
      ]);
      try {
        const tsconfigPath = j(projectPath, 'tsconfig.json');
        const tsconfig = JSON.parse(await rf(tsconfigPath, 'utf-8'));
        let tsconfigPatched = false;
        for (const badKey of INVALID_TSCONFIG_OPTIONS) {
          if (tsconfig.compilerOptions?.[badKey] !== undefined) {
            delete tsconfig.compilerOptions[badKey];
            tsconfigPatched = true;
          }
        }
        if (tsconfigPatched) {
          await wf(tsconfigPath, JSON.stringify(tsconfig, null, 2) + '\n', 'utf-8');
        }
      } catch { /* tsconfig may not exist yet */ }

      // Auto-configure next-auth: write NEXTAUTH_SECRET + create auth route BEFORE
      // npm install runs, so the server never crashes from missing auth config.
      let nextAuthConfigured = false;
      const needsAuth = addedPackages.includes('next-auth') || Object.keys(existing).includes('next-auth');
      if (needsAuth) {
        const configured = await applyAuthFallback(projectPath).catch(() => []);
        nextAuthConfigured = configured.length > 0;
      }

      return NextResponse.json({ success: true, addedPackages, totalFiles: files.length, nextAuthConfigured });
    }

    // ── start-server: spin up next dev ────────────────────────────────────────
    if (action === 'start-server') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const force = body.force === true;
      const result = await startDevServer(projectPath, force);
      if (result.port) {
        await updateProjectPort(projectPath, result.port);
        await updateProjectMemory(projectPath, {
          runningPort: result.port,
          previewUrl: `http://localhost:${result.port}`,
          buildStatus: 'success',
        });

        // Post-start home page probe: verify the root returns a real application
        // (not Next.js 404 or scaffold placeholder) before reporting server-ready.
        try {
          const probeCtrl = new AbortController();
          setTimeout(() => probeCtrl.abort(), 20_000);
          const probeRes = await fetch(`http://localhost:${result.port}/`, {
            signal: probeCtrl.signal,
            headers: { Accept: 'text/html' },
          });
          const probeBody = await probeRes.text().catch(() => '');
          const is404 = /This page could not be found|<title[^>]*>404/i.test(probeBody);
          const isScaffold = /the agent is generating the full codebase/i.test(probeBody);
          if (probeRes.ok && !is404 && !isScaffold) {
            result.homePageVerified = true;
            result.homePageStatus = probeRes.status;
          } else {
            result.homePageVerified = false;
            result.homePageStatus = probeRes.status;
            result.homePageError = is404 ? 'Home page shows Next.js 404 — app/page.tsx is missing or crashing'
              : isScaffold ? 'Home page is still showing generation placeholder — build was incomplete'
              : `Home page returned HTTP ${probeRes.status}`;
          }
        } catch { /* non-critical probe failure — server may still be starting */ }
      }
      return NextResponse.json({ ...result, projectPath, previewUrl: publicPreviewUrl(result.port) });
    }

    // ── get-server-logs: return captured Next.js dev output ───────────────────
    if (action === 'get-server-logs') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const logs = await getServerLogs(projectPath);
      return NextResponse.json({ success: true, logs: logs.slice(-4000) });
    }

    // ── check-preview-health: server-side ping of the generated app's dev server ──
    // Called by the preview health watchdog every 5 seconds.
    // Running the check server-side avoids CORS errors that browser fetch would hit.
    if (action === 'check-preview-health') {
      const { port: healthPort } = body;
      if (!healthPort) return NextResponse.json({ healthy: false, error: 'Missing port' });
      try {
        const r = await fetch(`http://localhost:${healthPort}/`, {
          signal: AbortSignal.timeout(4000),
          redirect: 'follow',
          headers: { 'Accept': 'text/html,application/json' },
        });
        return NextResponse.json({ healthy: true, status: r.status });
      } catch (e) {
        return NextResponse.json({ healthy: false, error: e instanceof Error ? e.message : String(e) });
      }
    }

    // ── create-bridge-project: scaffold an empty project and register it so the bridge
    // ownership guard accepts it. Bridge test mode skips all Bedrock generation.
    if (action === 'create-bridge-project') {
      const { projectName, prompt: userPrompt } = body;
      const raw = (projectName || userPrompt || 'bridge-project').slice(0, 60);
      const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'bridge-project';
      const projectPath = join(process.cwd(), 'generated-projects', slug);
      await mkdir(projectPath, { recursive: true });

      // Minimal package.json so Claude Code CLI can resolve the project root
      const pkgPath = join(projectPath, 'package.json');
      try { await access(pkgPath); } catch {
        await writeFile(pkgPath, JSON.stringify({
          name: slug, version: '0.1.0', private: true,
          scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
          dependencies: { next: '^14.2.15', react: '^18.3.1', 'react-dom': '^18.3.1', 'better-sqlite3': '^9.6.0' },
          devDependencies: { typescript: '^5.4.5', '@types/node': '^20.14.0', '@types/react': '^18.3.3', '@types/react-dom': '^18.3.0', '@types/better-sqlite3': '^7.6.10', tailwindcss: '^3.4.4', autoprefixer: '^10.4.19', postcss: '^8.4.39' },
        }, null, 2), 'utf-8');
      }

      // Register in the manifest so the bridge ownership guard (Guard 5) accepts this path.
      const bridgeAuthUser = await getAuthUser(request);
      const saved = await saveProject({
        ownerUserId: bridgeAuthUser?.sub ?? 'anonymous',
        name: slug.replace(/-/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
        description: (userPrompt || projectName || '').slice(0, 200),
        projectPath,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        filesCount: 0,
      });

      return NextResponse.json({ success: true, projectPath, slug, id: saved.id });
    }

    // ── list-projects: return projects owned by the authenticated user (or disk-scanned anonymous) ──
    if (action === 'list-projects') {
      const authUser = await getAuthUser(request);
      // Allow unauthenticated access — returns anonymous projects + disk-discovered projects
      const ownerId = authUser?.sub ?? 'anonymous';
      const projects = await listProjects(ownerId);
      return NextResponse.json({ success: true, projects });
    }

    // ── verify-app: make real HTTP requests to confirm the app works ───────────
    // ── debug-project: autonomously scan project for TypeScript / build errors ──
    if (action === 'debug-project') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });

      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      const tsErrors: string[] = [];
      const affectedFiles: string[] = [];
      let errorCount = 0;

      try {
        await execAsync('npx tsc --noEmit 2>&1', { cwd: projectPath, timeout: 45000 });
      } catch (err: unknown) {
        const out = ((err as { stdout?: string; stderr?: string }).stdout ?? '') + ((err as { stdout?: string; stderr?: string }).stderr ?? '');
        const lines = out.split('\n').filter((l: string) => l.includes('error TS')).slice(0, 25);
        tsErrors.push(...lines);
        errorCount = lines.length;
        const seen = new Set<string>();
        for (const l of lines) {
          const m = /^([^(]+)\(/.exec(l);
          if (m) {
            const rel = m[1].replace(projectPath + '/', '').replace(projectPath, '').trim();
            if (rel && !seen.has(rel)) { seen.add(rel); affectedFiles.push(rel); }
          }
        }
      }

      // Also read .next/error.json if present
      let buildError = '';
      try {
        const errJson = await readFile(join(projectPath, '.next/error.json'), 'utf-8');
        const parsed = JSON.parse(errJson);
        buildError = parsed.message || JSON.stringify(parsed).slice(0, 500);
      } catch { /* no .next error file */ }

      return NextResponse.json({ success: true, tsErrors, affectedFiles, errorCount, buildError });
    }

    // ── check-ts: quick TypeScript validation after edits ─────────────────────
    if (action === 'check-ts') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });

      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      try {
        await execAsync('npx tsc --noEmit 2>&1', { cwd: projectPath, timeout: 40000 });
        return NextResponse.json({ success: true, clean: true, errors: [] });
      } catch (err: unknown) {
        const out = ((err as { stdout?: string; stderr?: string }).stdout ?? '') + ((err as { stdout?: string; stderr?: string }).stderr ?? '');
        const errors = out.split('\n').filter((l: string) => l.includes('error TS')).slice(0, 20);
        return NextResponse.json({ success: true, clean: false, errors });
      }
    }

    if (action === 'verify-app') {
      const { port, serverLogFile } = body;
      if (!port) return NextResponse.json({ success: false, error: 'Missing port' }, { status: 400 });

      let apiRoutes: string[] = [];
      let pageRoutes: string[] = [];
      if (projectPath) {
        try {
          const disc = await discoverProject(projectPath);
          apiRoutes = disc.apiRoutes;
          pageRoutes = disc.pages ?? [];
        } catch { /* non-critical — verify main page even without discovery */ }
      }

      const result = await verifyRunningApp(port as number, apiRoutes, projectPath as string | undefined, pageRoutes);

      // Live log scan — catch MODULE_NOT_FOUND, chunk 404s, runtime exceptions that
      // HTTP checks alone cannot detect (they return 200 even for crashed pages in some cases).
      if (serverLogFile && typeof serverLogFile === 'string') {
        try {
          const { healthGateWithLiveLogs, scanServerLogs } = await import('@/services/verification-engine');
          const logScan = await scanServerLogs(serverLogFile);
          if (!logScan.clean) {
            result.verified = false;
            result.failures = [...(result.failures ?? []), ...logScan.criticalErrors.slice(0, 5)];
            result.summary = `Live log shows ${logScan.criticalErrors.length} critical error(s). ${result.summary}`;
          }
          if (logScan.warnings.length > 0) {
            result.summary = `${result.summary} Warnings: ${logScan.warnings.slice(0, 2).join('; ')}.`;
          }
        } catch { /* non-fatal */ }
      }

      // TypeScript safety gate: only run tsc when HTTP checks all pass.
      // Running tsc on every loop iteration (15 × ~30s) would add 7+ minutes of overhead.
      // We only need the TS gate at the final step — when the app appears verified.
      let tsErrorsExist = false;
      if (projectPath && result.verified) {
        try {
          const tsCheck = await validateProject(projectPath);
          tsErrorsExist = (tsCheck.errors?.length ?? 0) > 0;
          if (tsErrorsExist) {
            result.verified = false;
            result.summary = `TypeScript errors exist (${tsCheck.errors?.length} error(s)) — cannot mark as verified until resolved.`;
            result.failures = [...(result.failures ?? []), `TypeScript: ${tsCheck.errors?.slice(0, 2).join('; ')}`];
          }
        } catch { /* tsc not available — skip gate */ }
      }

      if (projectPath && result.checks) {
        try { await recordVerification(projectPath, result); } catch { /* non-critical */ }
      }
      return NextResponse.json({ success: true, ...result, tsErrorsExist });
    }

    // ── check-credentials: read .env.local.example, compare with .env.local ──
    if (action === 'check-credentials') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });

      const parseEnv = (content: string) => {
        const vars: Record<string, string> = {};
        for (const line of content.split('\n')) {
          const stripped = line.trim();
          if (!stripped || stripped.startsWith('#')) continue;
          const eqIdx = stripped.indexOf('=');
          if (eqIdx > 0) {
            const k = stripped.slice(0, eqIdx).trim();
            const v = stripped.slice(eqIdx + 1).trim();
            vars[k] = v;
          }
        }
        return vars;
      };

      const examplePath = join(projectPath, '.env.local.example');
      const localPath = join(projectPath, '.env.local');
      const exampleContent = await readFile(examplePath, 'utf-8').catch(() => '');
      const localContent = await readFile(localPath, 'utf-8').catch(() => '');

      if (!exampleContent) return NextResponse.json({ success: true, hasEnvExample: false, missing: [], set: [] });

      const exVars = parseEnv(exampleContent);
      const localVars = parseEnv(localContent);

      const missing: Array<{ key: string; description: string }> = [];
      const set: string[] = [];

      // Parse example with comments to get descriptions
      let lastComment = '';
      for (const line of exampleContent.split('\n')) {
        const t = line.trim();
        if (t.startsWith('#')) { lastComment = t.replace(/^#+\s*/, ''); continue; }
        const eqIdx = t.indexOf('=');
        if (eqIdx > 0) {
          const key = t.slice(0, eqIdx).trim();
          const lv = localVars[key];
          if (!lv || lv === '' || lv.startsWith('your_') || lv.startsWith('https://your-')) {
            missing.push({ key, description: lastComment || key });
          } else {
            set.push(key);
          }
          lastComment = '';
        }
      }

      return NextResponse.json({ success: true, hasEnvExample: true, hasEnvLocal: !!localContent, missing, set, exampleContent });
    }

    // ── set-credential: write a variable to the project's .env.local ──────────
    if (action === 'set-credential') {
      const { key, value } = body;
      if (!projectPath || !key || value === undefined) {
        return NextResponse.json({ success: false, error: 'Missing projectPath, key, or value' }, { status: 400 });
      }

      const localPath = join(projectPath, '.env.local');
      let content = await readFile(localPath, 'utf-8').catch(() => '');

      const keyRegex = new RegExp(`^${key}\\s*=.*$`, 'm');
      if (keyRegex.test(content)) {
        content = content.replace(keyRegex, `${key}=${value}`);
      } else {
        content = (content.trimEnd() || '') + `\n${key}=${value}\n`;
      }

      await writeFile(localPath, content, 'utf-8');
      return NextResponse.json({ success: true, key });
    }

    // ── make-search-work: upgrade existing app to real backend search ─────────
    if (action === 'make-search-work') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });

      const discovery = await discoverProject(projectPath);
      const mem = await getProjectMemory(projectPath);

      // Build a rich context explaining what the app currently has and what's missing
      const fileTree = discovery.allFiles.map(f => f.path).sort().join('\n');
      const keyFilesStr = Object.entries(discovery.keyContents)
        .slice(0, 8)
        .map(([p, c]) => `[FILE: ${p}]\n${c.slice(0, 3000)}`)
        .join('\n\n');

      const upgradePrompt = `PROJECT: ${mem?.name || projectPath.split('/').pop()}
CURRENT MODE: ${discovery.mode}
HAS API ROUTES: ${discovery.hasApiRoutes ? 'yes — ' + discovery.apiRoutes.join(', ') : 'NO — search is currently client-side'}
HAS DATA FILES: ${discovery.hasDataFiles ? 'yes' : 'NO — data may be hardcoded in components'}

CURRENT FILE TREE:
${fileTree}

KEY FILE CONTENTS:
${keyFilesStr}

TASK: Upgrade this app to have REAL backend search.

1. If there are no API routes, create app/api/{resource}/route.ts with:
   - GET handler that accepts query params: q, location, type, status, minPrice, maxPrice, etc.
   - Server-side filtering of the sample data
   - Proper NextResponse.json() response

2. If sample data is hardcoded in a component or page, move it to lib/data/{resource}.ts
   and import it in the API route.

3. Update the frontend search component/page to:
   - Call the API endpoint using fetch('/api/{resource}?param=value')
   - Use useState for results + loading state
   - Show real filtered results from the API response
   - Handle the async nature properly (useEffect or form submit handler)

4. If lib/types/{resource}.ts doesn't exist, create it with proper TypeScript types.

Return ALL changed and new files in [EDIT_START]...[EDIT_END] format.
Complete, working, production-quality code. No placeholders.`;

      const aiResponse = await editWithAI(upgradePrompt, EDITOR_SYSTEM_PROMPT);
      const editedFiles = parseEditFormat(aiResponse);

      if (editedFiles.length === 0) {
        return NextResponse.json({ success: true, filesChanged: [], response: aiResponse, conversational: true });
      }

      const result = await applyEditsToProject(projectPath, editedFiles);
      if (result.filesChanged.length > 0) {
        await recordEditApplied(projectPath, 'make-search-work upgrade', result.filesChanged);
      }

      return NextResponse.json({ success: result.success, filesChanged: result.filesChanged, errors: result.errors });
    }

    // ── browser-screenshot: capture full-page screenshot of running app ────────
    if (action === 'browser-screenshot') {
      const { port, path: urlPath = '/' } = body;
      if (!port) return NextResponse.json({ success: false, error: 'Missing port' }, { status: 400 });
      const url = `http://localhost:${port}${urlPath}`;
      const result = await captureScreenshot(url);
      return NextResponse.json({ success: result.success, screenshotUrl: result.screenshotUrl, error: result.error });
    }

    // ── browser-click: click element and screenshot result ──────────────────
    if (action === 'browser-click') {
      const { port, path: urlPath = '/', selector } = body;
      if (!port || !selector) return NextResponse.json({ success: false, error: 'Missing port or selector' }, { status: 400 });
      const url = `http://localhost:${port}${urlPath}`;
      const result = await clickElement(url, selector);
      return NextResponse.json({ success: result.success, screenshotUrl: result.screenshotUrl, error: result.error });
    }

    // ── browser-fill: fill form fields and screenshot result ────────────────
    if (action === 'browser-fill') {
      const { port, path: urlPath = '/', fields, submitSelector } = body;
      if (!port || !fields) return NextResponse.json({ success: false, error: 'Missing port or fields' }, { status: 400 });
      const url = `http://localhost:${port}${urlPath}`;
      const result = await fillForm(url, fields, submitSelector);
      return NextResponse.json({ success: result.success, screenshotUrl: result.screenshotUrl, error: result.error });
    }

    // ── browser-debug: collect console logs, network requests, runtime errors ─
    if (action === 'browser-debug') {
      const { port, path: urlPath = '/' } = body;
      if (!port) return NextResponse.json({ success: false, error: 'Missing port' }, { status: 400 });
      const url = `http://localhost:${port}${urlPath}`;
      const result = await debugPage(url);
      if (projectPath && result.success) {
        try {
          await recordBrowserSession(projectPath, {
            pageTitle: result.pageTitle,
            pageUrl: result.pageUrl,
            errorCount: result.runtimeErrors?.length ?? 0,
            requestCount: result.networkRequests?.length ?? 0,
            screenshotUrl: result.screenshotUrl,
          });
        } catch { /* non-critical */ }
      }
      return NextResponse.json({
        success: result.success,
        pageTitle: result.pageTitle,
        pageUrl: result.pageUrl,
        consoleLogs: result.consoleLogs,
        networkRequests: result.networkRequests,
        runtimeErrors: result.runtimeErrors,
        screenshotUrl: result.screenshotUrl,
        error: result.error,
      });
    }

    // ── apply-generated-files: overwrite files in an existing project path ─────
    // Used by the scaffold re-generation path when the engineering loop detects
    // that the preview is still showing the "Building your app" placeholder and
    // needs to apply a freshly generated full codebase to the running project.
    // Skips lib/managed/* (always correct) and returns count of written files.
    if (action === 'apply-generated-files') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const genFiles: Array<{ path: string; content: string }> = body.files || [];
      if (!Array.isArray(genFiles) || genFiles.length === 0) {
        return NextResponse.json({ success: false, error: 'No files provided' }, { status: 400 });
      }
      // Load baseline so we never overwrite UI files during scaffold re-gen
      let baselineFileSet: Set<string> = new Set();
      try {
        const { getBaselineFileSet } = await import('@/services/design-baseline');
        baselineFileSet = await getBaselineFileSet(projectPath);
      } catch { /* non-critical */ }

      let filesWritten = 0;
      const written: string[] = [];
      const skipped: string[] = [];
      const errors: string[] = [];
      for (const f of genFiles) {
        if (!f.path || f.content === undefined) continue;
        if (f.path.startsWith('lib/managed/')) continue; // never overwrite managed services
        // Never overwrite baseline UI files during scaffold re-generation
        if (baselineFileSet.has(f.path)) { skipped.push(f.path); continue; }
        try {
          const abs = join(projectPath, f.path);
          await mkdir(dirname(abs), { recursive: true });
          await writeFile(abs, f.content, 'utf-8');
          filesWritten++;
          written.push(f.path);
        } catch (e) {
          errors.push(`${f.path}: ${e instanceof Error ? e.message : 'unknown'}`);
        }
      }
      return NextResponse.json({ success: true, filesWritten, written, skipped, errors });
    }

    // ── save-design-baseline: snapshot all UI files after first generation ────────
    if (action === 'save-design-baseline') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const { saveDesignBaseline } = await import('@/services/design-baseline');
      const savedFiles = await saveDesignBaseline(projectPath);
      return NextResponse.json({ success: true, savedFiles, count: savedFiles.length });
    }

    // ── restore-baseline-files: undo UI drift from a repair ──────────────────────
    if (action === 'restore-baseline-files') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const changedFiles: string[] = body.changedFiles || [];
      const { restoreBaselineFiles } = await import('@/services/design-baseline');
      const restored = await restoreBaselineFiles(projectPath, changedFiles);
      return NextResponse.json({ success: true, restored, count: restored.length });
    }

    // ── check-baseline-drift: detect which changed files have drifted from baseline
    if (action === 'check-baseline-drift') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const changedFiles: string[] = body.changedFiles || [];
      const { loadDesignBaseline, hasSignificantDrift, isUIFile } = await import('@/services/design-baseline');
      const baseline = await loadDesignBaseline(projectPath);
      const drifted: string[] = [];
      for (const f of changedFiles) {
        if (!isUIFile(f)) continue;
        if (await hasSignificantDrift(projectPath, f, baseline)) drifted.push(f);
      }
      return NextResponse.json({ success: true, drifted, hasDrift: drifted.length > 0 });
    }

    // ── verify-auth-flow: run the full register→login→session auth loop ──────────
    if (action === 'verify-auth-flow') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const port: number = body.port;
      if (!port) return NextResponse.json({ success: false, error: 'Missing port' }, { status: 400 });
      const { verifyAuthFlow } = await import('@/services/auth-flow-verifier');
      const result = await verifyAuthFlow(port, projectPath);
      return NextResponse.json({ success: true, ...result });
    }

    // ── fix-auth-fields: deterministic form↔API field name mismatch repair ───────
    if (action === 'fix-auth-fields') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });

      const AUTH_ROUTE_PATTERNS: Array<{ role: string; pattern: RegExp }> = [
        { role: 'login',    pattern: /^app\/api\/auth\/(login|signin|sign-in)\/route\.(ts|tsx)$/ },
        { role: 'register', pattern: /^app\/api\/auth\/(register|signup|sign-up)\/route\.(ts|tsx)$/ },
      ];
      const AUTH_PAGE_PATTERNS: Array<{ role: string; pattern: RegExp }> = [
        { role: 'login',    pattern: /^app\/(auth\/)?(login|signin|sign-in)\/page\.(tsx|jsx)$/ },
        { role: 'register', pattern: /^app\/(auth\/)?(register|signup|sign-up)\/page\.(tsx|jsx)$/ },
      ];

      function extractFieldNames(src: string): Set<string> {
        const names = new Set<string>();
        const dm = src.match(/\{\s*([^}]+)\s*\}\s*=\s*(?:await\s+)?(?:body|req|request)(?:\.json\(\))?/);
        if (dm) dm[1].split(',').forEach(f => { const n = f.trim().split(/\s*[:=]\s*/)[0].trim(); if (n && /^\w+$/.test(n)) names.add(n); });
        for (const m of src.matchAll(/(?:body|json|data)\.(\w+)/g)) names.add(m[1]);
        return names;
      }
      function extractFormFields(src: string): Set<string> {
        const names = new Set<string>();
        for (const m of src.matchAll(/\.append\s*\(\s*['"](\w+)['"]/g)) names.add(m[1]);
        for (const m of src.matchAll(/body\s*:\s*JSON\.stringify\s*\(\s*\{\s*([^}]+)\s*\}/g)) {
          m[1].split(',').forEach(p => { const k = p.trim().split(':')[0].trim().replace(/['"]/g, ''); if (/^\w+$/.test(k)) names.add(k); });
        }
        for (const m of src.matchAll(/JSON\.stringify\s*\(\s*\{\s*([^}]+)\s*\}/g)) {
          m[1].split(',').forEach(p => { const k = p.trim().split(':')[0].trim().replace(/['"]/g, ''); if (/^\w+$/.test(k)) names.add(k); });
        }
        return names;
      }

      let fixed = 0;
      const details: string[] = [];

      // Walk actual files on disk (not the in-memory list)
      const { readdir: _rd } = await import('fs/promises');
      async function findFiles(dir: string, pat: RegExp): Promise<string[]> {
        const results: string[] = [];
        try {
          const entries = await _rd(dir, { withFileTypes: true });
          for (const e of entries) {
            const rel = join(dir, e.name).replace(projectPath + '/', '');
            if (e.isDirectory()) results.push(...await findFiles(join(dir, e.name), pat));
            else if (pat.test(rel)) results.push(rel);
          }
        } catch {}
        return results;
      }

      const ROLE_PAIRS = [
        [/^email|username$/i, /^email|username$/i],
        [/^pass(?:word)?|pwd$/i, /^pass(?:word)?|pwd$/i],
        [/^name|fullname$/i, /^name|fullname|full_name$/i],
      ];

      for (const { role, pattern: apiPat } of AUTH_ROUTE_PATTERNS) {
        const apiFiles = await findFiles(projectPath, apiPat);
        const pagePat = AUTH_PAGE_PATTERNS.find(p => p.role === role)?.pattern;
        if (!pagePat) continue;
        const pageFiles = await findFiles(projectPath, pagePat);
        if (apiFiles.length === 0 || pageFiles.length === 0) continue;

        const apiSrc = await readFile(join(projectPath, apiFiles[0]), 'utf-8').catch(() => '');
        const pageSrc = await readFile(join(projectPath, pageFiles[0]), 'utf-8').catch(() => '');
        if (!apiSrc || !pageSrc) continue;

        const apiFields = extractFieldNames(apiSrc);
        const formFields = extractFormFields(pageSrc);
        if (apiFields.size === 0 || formFields.size === 0) continue;

        let patched = apiSrc;
        let changed = false;
        for (const apiField of apiFields) {
          for (const [apiRole, formRole] of ROLE_PAIRS) {
            if ((apiRole as RegExp).test(apiField)) {
              const formField = [...formFields].find(f => (formRole as RegExp).test(f));
              if (formField && formField !== apiField) {
                patched = patched.replace(new RegExp(`\\b${apiField}\\b`, 'g'), formField);
                changed = true;
                details.push(`${role} API: ${apiField} → ${formField}`);
              }
            }
          }
        }
        if (changed) {
          await writeFile(join(projectPath, apiFiles[0]), patched, 'utf-8');
          fixed++;
        }
      }

      return NextResponse.json({ success: true, fixed, details: details.join(', ') || 'no mismatches' });
    }

    // ── repair-dynamic-routes: detect template-literal hrefs, create [id] pages ──────
    if (action === 'repair-dynamic-routes') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const { readdir: rdDir2, readFile: rdFile2 } = await import('fs/promises');
      const path2 = await import('path');

      async function walkSrc(dir: string, results: string[] = []): Promise<string[]> {
        try {
          const entries = await rdDir2(dir, { withFileTypes: true });
          for (const e of entries) {
            if (e.name === 'node_modules' || e.name === '.next' || e.name === 'lib') continue;
            const full = path2.join(dir, e.name);
            if (e.isDirectory()) await walkSrc(full, results);
            else if (/\.[jt]sx?$/.test(e.name)) results.push(full);
          }
        } catch {}
        return results;
      }

      const srcFiles = await walkSrc(projectPath);
      const dynamicBases = new Set<string>();
      const tplPat = /["'`](\/[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*)\/?\$\{[^}]+\}/g;
      const concatPat = /["'`](\/[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*)\/['"]\s*\+/g;

      for (const sf of srcFiles) {
        const src = await rdFile2(sf, 'utf-8').catch(() => '');
        let m;
        while ((m = tplPat.exec(src)) !== null) {
          const base = m[1].replace(/\/$/, '');
          if (base && base !== '/' && !base.includes('[') && !base.startsWith('/api')) dynamicBases.add(base);
        }
        while ((m = concatPat.exec(src)) !== null) {
          const base = m[1].replace(/\/$/, '');
          if (base && base !== '/' && !base.includes('[')) dynamicBases.add(base);
        }
      }

      const created: string[] = [];
      const appDir = path2.join(projectPath, 'app');

      for (const base of dynamicBases) {
        const pageFile = path2.join(appDir, base.slice(1), '[id]', 'page.tsx');
        try { await rdFile2(pageFile, 'utf-8'); continue; } catch {} // exists — skip

        const resourceName = base.split('/').filter(Boolean).pop() ?? 'item';
        const componentName = base.split('/').filter(Boolean).map((s: string) =>
          s.charAt(0).toUpperCase() + s.slice(1).replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase())
        ).join('').replace(/[^a-zA-Z0-9]/g, '');
        const displayName = resourceName.charAt(0).toUpperCase() + resourceName.slice(1).replace(/-/g, ' ');

        const page = `'use client';
import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';

export default function ${componentName}DetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;
  const [item, setItem] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    fetch(\`/api${base}/\${id}\`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(d => { setItem(d.${resourceName} ?? d.item ?? d.data ?? d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [id]);

  if (loading) return <div className="min-h-screen flex items-center justify-center"><div className="animate-spin w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full"/></div>;
  if (!item) return <main className="min-h-screen flex items-center justify-center p-8"><div className="text-center"><p className="text-slate-500 mb-4">${displayName} not found</p><Link href="${base}" className="text-blue-600 hover:underline text-sm">← Back</Link></div></main>;

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="max-w-3xl mx-auto px-4 py-10">
        <Link href="${base}" className="text-sm text-slate-400 hover:text-slate-600 mb-6 inline-block">← Back to ${displayName}s</Link>
        <div className="bg-white rounded-2xl border border-slate-200 p-8">
          <h1 className="text-2xl font-bold text-slate-900 mb-6">{(item.title ?? item.name ?? item.label ?? '${displayName}') as string}</h1>
          {item.description != null && <p className="text-slate-600 mb-6">{String(item.description)}</p>}
          <dl className="grid grid-cols-2 gap-4">
            {Object.entries(item).filter(([k]) => !['id','_id','description','title','name','created_at'].includes(k)).slice(0,8).map(([k,v]) => (
              <div key={k}><dt className="text-xs font-medium text-slate-400 uppercase">{k.replace(/_/g,' ')}</dt><dd className="mt-1 text-sm text-slate-900">{String(v??'—')}</dd></div>
            ))}
          </dl>
          <button onClick={() => router.back()} className="mt-8 px-4 py-2 text-sm border border-slate-200 rounded-lg hover:bg-slate-50">← Back</button>
        </div>
      </div>
    </main>
  );
}
`;
        await mkdir(path2.dirname(pageFile), { recursive: true });
        await writeFile(pageFile, page, 'utf-8');
        created.push(`app${base}/[id]/page.tsx`);
      }

      return NextResponse.json({ success: true, created, total: created.length, message: created.length > 0 ? `Created ${created.length} dynamic page(s)` : 'No missing dynamic routes found' });
    }

    // ── scan-live-links: fetch homepage HTML and check every href for 404s ──────────
    if (action === 'scan-live-links') {
      const { port: scanPort } = body;
      if (!scanPort) return NextResponse.json({ success: false, error: 'Missing port' }, { status: 400 });

      const base = `http://localhost:${scanPort}`;

      // Pages to scan (not just home — also nav-level pages)
      const pagesToScan = ['/', '/products', '/menu', '/courses', '/listings', '/jobs', '/services', '/blog', '/shop'];

      const allLinks = new Set<string>();
      for (const startPath of pagesToScan) {
        try {
          const ctrl = new AbortController();
          setTimeout(() => ctrl.abort(), 8000);
          const res = await fetch(`${base}${startPath}`, { signal: ctrl.signal, headers: { Accept: 'text/html' } });
          if (!res.ok) continue;
          const html = await res.text();

          // Extract all internal href links from the HTML
          const hrefRe = /href=["'](\/?[^"'#?][^"'#?]*?)(?:[?#][^"']*)?["']/g;
          let m;
          while ((m = hrefRe.exec(html)) !== null) {
            const href = m[1].trim();
            if (!href || href.startsWith('http') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue;
            if (href.startsWith('/_next') || href.startsWith('/api/') || href.startsWith('/static/')) continue;
            const path = href.startsWith('/') ? href : `/${href}`;
            // Strip dynamic segments — /products/abc123 → /products/abc123 (check as-is, let 200 from [id] route count)
            allLinks.add(path);
          }
        } catch { /* page unavailable — skip */ }
      }

      // Check each unique link
      const broken: Array<{ href: string; status: number }> = [];
      const working: string[] = [];

      for (const href of allLinks) {
        try {
          const ctrl = new AbortController();
          setTimeout(() => ctrl.abort(), 6000);
          const res = await fetch(`${base}${href}`, { signal: ctrl.signal, redirect: 'follow' });
          if (res.status === 404) {
            broken.push({ href, status: 404 });
          } else if (res.status < 400) {
            working.push(href);
          }
        } catch { broken.push({ href, status: 0 }); }
      }

      return NextResponse.json({
        success: true,
        scanned: allLinks.size,
        working: working.length,
        broken,
        allClear: broken.length === 0,
        summary: broken.length === 0
          ? `All ${allLinks.size} links checked — none return 404`
          : `${broken.length} broken link(s): ${broken.map(b => b.href).join(', ')}`,
      });
    }

    // ── repair-dashboard: create/replace the dashboard page for apps with auth ─────────
    if (action === 'repair-dashboard') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const { readdir: rdDir3, readFile: rdFile3 } = await import('fs/promises');
      const path3 = await import('path');

      // Check if app has auth pages
      const hasAuth = await (async () => {
        const authPaths = ['app/auth/page.tsx','app/login/page.tsx','app/signin/page.tsx','app/(auth)/login/page.tsx'];
        for (const p of authPaths) {
          try { await rdFile3(path3.join(projectPath, p), 'utf-8'); return true; } catch {}
        }
        return false;
      })();
      if (!hasAuth) return NextResponse.json({ success: false, repaired: false, reason: 'No auth pages found — dashboard not needed' });

      const dashPath = path3.join(projectPath, 'app', 'dashboard', 'page.tsx');

      // Detect if existing dashboard is stub or missing
      let isStub = true;
      try {
        const src = await rdFile3(dashPath, 'utf-8');
        isStub = src.length < 100 ||
          /router\.(replace|push)\s*\(\s*['"]\/['"]\s*\)/.test(src) ||
          !/fetch|<main|<div|dashboard|Dashboard/.test(src);
      } catch { /* file missing — treat as stub */ }

      if (!isStub) return NextResponse.json({ success: true, repaired: false, reason: 'Dashboard already exists and has real content' });

      // Discover API resources
      const apiRoutes: string[] = [];
      async function walkForApi(dir: string): Promise<void> {
        try {
          const entries = await rdDir3(dir, { withFileTypes: true });
          for (const e of entries) {
            if (e.name === 'node_modules' || e.name === '.next') continue;
            const full = path3.join(dir, e.name);
            if (e.isDirectory()) await walkForApi(full);
            else if (/route\.(ts|js)$/.test(e.name)) {
              const rel = path3.relative(path3.join(projectPath, 'app', 'api'), path3.dirname(full));
              if (rel && !rel.startsWith('auth') && !rel.includes('[') && !rel.includes('..')) {
                apiRoutes.push(rel.split(path3.sep)[0]);
              }
            }
          }
        } catch {}
      }
      await walkForApi(path3.join(projectPath, 'app', 'api'));
      const uniqueApiRoutes = [...new Set(apiRoutes)].slice(0, 4);

      const appName = path3.basename(projectPath)
        .replace(/-/g, ' ')
        .replace(/\b\w/g, (c: string) => c.toUpperCase());

      const resourceList = uniqueApiRoutes.map(r => {
        const label = r.charAt(0).toUpperCase() + r.slice(1).replace(/-/g, ' ');
        return `{ key: '${r}', label: '${label}', href: '/${r}', apiPath: '/api/${r}' }`;
      }).join(',\n  ');

      const navItems = uniqueApiRoutes.map(r => {
        const label = r.charAt(0).toUpperCase() + r.slice(1).replace(/-/g, ' ');
        const emoji = r.includes('pay') || r.includes('bill') ? '💳'
          : r.includes('order') ? '📦'
          : r.includes('course') || r.includes('lesson') ? '📚'
          : r.includes('product') || r.includes('item') ? '🛍️'
          : '📋';
        return `{ href: '/${r}', label: '${label}', emoji: '${emoji}' }`;
      }).join(',\n  ');

      const dashContent = `'use client';
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

interface User { id: string; name?: string; email: string; }
interface Stat { key: string; label: string; href: string; count: number | string; }

const NAV_ITEMS = [
  { href: '/', label: 'Home', emoji: '🏠' },
  ${navItems}
];

const RESOURCES = [${resourceList ? `\n  ${resourceList}\n` : ''}];

export default function DashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [stats, setStats] = useState<Stat[]>([]);
  const [authState, setAuthState] = useState<'loading' | 'authenticated' | 'unauthenticated'>('loading');

  const loadDashboard = useCallback(async () => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch('/api/auth/me');
        if (res.ok) {
          const d = await res.json();
          const userObj = d.user ?? d;
          if (userObj?.email) {
            setUser(userObj);
            setAuthState('authenticated');
            if (RESOURCES.length > 0) {
              const results = await Promise.allSettled(
                RESOURCES.map(res2 =>
                  fetch(res2.apiPath)
                    .then(r => r.json())
                    .then(d2 => {
                      const arr = d2[res2.key] ?? d2.data ?? d2.items ?? d2.results ?? (Array.isArray(d2) ? d2 : null);
                      return { key: res2.key, label: res2.label, href: res2.href, count: Array.isArray(arr) ? arr.length : '—' };
                    })
                    .catch(() => ({ key: res2.key, label: res2.label, href: res2.href, count: '—' }))
                )
              );
              setStats(results.filter(r => r.status === 'fulfilled').map(r => (r as PromiseFulfilledResult<Stat>).value));
            }
            return;
          }
        }
        if (res.status === 401 || res.status === 403) {
          setAuthState('unauthenticated');
          router.replace('/auth');
          return;
        }
        lastError = \`HTTP \${res.status}\`;
        if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 1500));
      } catch (e) {
        lastError = e;
        if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 1500));
      }
    }
    console.warn('Dashboard auth failed after 3 attempts:', lastError);
    setAuthState('unauthenticated');
    router.replace('/auth');
  }, [router]);

  useEffect(() => { loadDashboard(); }, [loadDashboard]);

  async function handleLogout() {
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
    router.replace('/auth');
  }

  if (authState === 'loading') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 gap-3">
        <div className="animate-spin w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full" />
        <p className="text-sm text-slate-400">Loading your dashboard…</p>
      </div>
    );
  }

  if (authState === 'unauthenticated') return null;

  return (
    <main className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-lg font-bold text-slate-900">${appName}</Link>
          <span className="text-slate-300">/</span>
          <span className="text-sm font-medium text-slate-600">Dashboard</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-slate-500">{user?.name ?? user?.email}</span>
          <button onClick={handleLogout} className="text-sm px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors">Sign out</button>
        </div>
      </header>
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-slate-900">Welcome back{user?.name ? \`, \${user.name}\` : ''}!</h1>
          <p className="mt-1 text-sm text-slate-500">Here is what is happening with your account.</p>
        </div>
        {stats.length > 0 ? (
          <div className={\`grid gap-4 mb-8 \${stats.length === 1 ? 'grid-cols-1 max-w-xs' : stats.length === 2 ? 'grid-cols-2' : stats.length === 3 ? 'grid-cols-3' : 'grid-cols-2 lg:grid-cols-4'}\`}>
            {stats.map(s => (
              <Link key={s.key} href={s.href} className="block bg-white rounded-2xl border border-slate-200 p-5 hover:border-blue-200 transition-colors">
                <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">{s.label}</p>
                <p className="mt-2 text-3xl font-bold text-slate-900">{String(s.count)}</p>
                {(s.count === 0 || s.count === '0') && <p className="mt-1 text-xs text-slate-400">No {s.label.toLowerCase()} yet</p>}
              </Link>
            ))}
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-slate-200 p-8 mb-8 text-center">
            <p className="text-slate-400 text-sm">Your activity summary will appear here as you use the app.</p>
          </div>
        )}
        <div className="bg-white rounded-2xl border border-slate-200 p-6">
          <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide mb-4">Quick access</h2>
          <nav className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {NAV_ITEMS.map(item => (
              <Link key={item.href} href={item.href} className="flex items-center gap-2 px-4 py-3 rounded-xl bg-slate-50 hover:bg-slate-100 transition-colors text-sm font-medium text-slate-700">
                <span>{item.emoji}</span><span>{item.label}</span>
              </Link>
            ))}
          </nav>
        </div>
      </div>
    </main>
  );
}
`;

      await mkdir(path3.dirname(dashPath), { recursive: true });
      await writeFile(dashPath, dashContent, 'utf-8');
      return NextResponse.json({ success: true, repaired: true, file: 'app/dashboard/page.tsx', apiRoutes: uniqueApiRoutes });
    }

    // ── repair-auth-pages: detect and replace stub auth pages with real forms ────────
    if (action === 'repair-auth-pages') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const { readdir: raDir, readFile: raFile } = await import('fs/promises');
      const raMod = await import('path');

      const AUTH_PAGE_GLOBS = [
        'app/auth/page.tsx',
        'app/auth/page.jsx',
        'app/login/page.tsx',
        'app/signin/page.tsx',
        'app/(auth)/login/page.tsx',
        'app/(auth)/signin/page.tsx',
      ];

      const isStub = (src: string) => {
        const hasRedirectToRoot = /router\.(replace|push)\s*\(\s*['"]\/['"]\s*\)/.test(src);
        const hasNoForm = !/<form|<input|onSubmit|handleSubmit/.test(src);
        const hasReturnNull = /return\s+null\s*[;}]/.test(src) && src.length < 400;
        return hasRedirectToRoot || hasNoForm || hasReturnNull;
      };

      const combinedAuthPage = `'use client';
import { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';

function AuthForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [mode, setMode] = useState<'signin' | 'signup'>(params.get('mode') === 'signup' ? 'signup' : 'signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      const url = mode === 'signup' ? '/api/auth/register' : '/api/auth/login';
      const body = mode === 'signup' ? { name, email, password } : { email, password };
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Authentication failed'); return; }
      router.push('/dashboard');
      router.refresh();
    } catch { setError('Network error'); }
    finally { setLoading(false); }
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <Link href="/" className="text-2xl font-bold text-slate-900">Welcome</Link>
          <p className="mt-1 text-sm text-slate-500">{mode === 'signin' ? 'Sign in to your account' : 'Create a new account'}</p>
        </div>
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
          <div className="flex rounded-xl bg-slate-100 p-1 mb-6">
            <button type="button" onClick={() => { setMode('signin'); setError(''); }}
              className={\`flex-1 py-2 rounded-lg text-sm font-medium transition-colors \${mode === 'signin' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'}\`}>Sign In</button>
            <button type="button" onClick={() => { setMode('signup'); setError(''); }}
              className={\`flex-1 py-2 rounded-lg text-sm font-medium transition-colors \${mode === 'signup' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'}\`}>Sign Up</button>
          </div>
          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'signup' && (
              <input type="text" required value={name} onChange={e => setName(e.target.value)}
                placeholder="Full name" className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            )}
            <input type="email" required value={email} onChange={e => setEmail(e.target.value)}
              placeholder="Email address" className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            <input type="password" required minLength={6} value={password} onChange={e => setPassword(e.target.value)}
              placeholder="Password" className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            {error && <p className="text-red-600 text-sm rounded-lg bg-red-50 border border-red-200 px-3 py-2">{error}</p>}
            <button type="submit" disabled={loading}
              className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm transition-colors disabled:opacity-60">
              {loading ? 'Please wait…' : (mode === 'signin' ? 'Sign In' : 'Create Account')}
            </button>
          </form>
          <p className="mt-4 text-center text-sm text-slate-500">
            {mode === 'signin'
              ? <button type="button" onClick={() => { setMode('signup'); setError(''); }} className="text-blue-600 font-medium hover:underline">No account? Sign up free</button>
              : <button type="button" onClick={() => { setMode('signin'); setError(''); }} className="text-blue-600 font-medium hover:underline">Already have an account? Sign in</button>}
          </p>
        </div>
        <p className="mt-4 text-center"><Link href="/" className="text-xs text-slate-400 hover:text-slate-600">← Back to Home</Link></p>
      </div>
    </main>
  );
}

export default function AuthPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><div className="animate-spin w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full"/></div>}>
      <AuthForm />
    </Suspense>
  );
}
`;

      const repaired: string[] = [];
      for (const rel of AUTH_PAGE_GLOBS) {
        const abs = raMod.join(projectPath, rel);
        try {
          const src = await raFile(abs, 'utf-8');
          if (isStub(src)) {
            await writeFile(abs, combinedAuthPage, 'utf-8');
            repaired.push(rel);
          }
        } catch { /* file doesn't exist — skip */ }
      }

      return NextResponse.json({ success: true, repaired, total: repaired.length, message: repaired.length > 0 ? `Repaired ${repaired.length} stub auth page(s): ${repaired.join(', ')}` : 'No stub auth pages found' });
    }

    // ── repair-missing-routes: scan disk files, find broken nav links, create stubs ─
    if (action === 'repair-missing-routes') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });

      const { readdir: rdDir, readFile: rdFile } = await import('fs/promises');
      const pathMod = await import('path');

      async function walkDir(dir: string, ext: RegExp, results: string[] = []): Promise<string[]> {
        try {
          const entries = await rdDir(dir, { withFileTypes: true });
          for (const e of entries) {
            if (e.name === 'node_modules' || e.name === '.next') continue;
            const full = pathMod.join(dir, e.name);
            if (e.isDirectory()) await walkDir(full, ext, results);
            else if (ext.test(e.name)) results.push(full);
          }
        } catch { /* skip unreadable */ }
        return results;
      }

      // Build set of existing page routes
      const appDir = pathMod.join(projectPath, 'app');
      const existingPages = new Set<string>();
      const pageFiles = await walkDir(appDir, /^page\.[jt]sx?$/);
      for (const pf of pageFiles) {
        const rel = pf.replace(appDir, '').replace(/\/page\.[jt]sx?$/, '') || '/';
        // strip route groups like (auth)
        const clean = rel.replace(/\/\([^)]+\)/g, '') || '/';
        existingPages.add(clean);
      }

      // Scan all source files for href references (including object-literal patterns)
      const srcFiles = await walkDir(projectPath, /\.[jt]sx?$/);
      const routePatterns = [
        /\bhref\s*=\s*["'`](\/[^"'`[\]{}$]*?)(?:[?#][^"'`]*)?["'`]/g,
        /\bhref\s*=\s*\{\s*["'`](\/[^"'`[\]{}$]*?)(?:[?#][^"'`]*)?["'`]\s*\}/g,
        /\bhref\s*:\s*["'`](\/[^"'`[\]{}$]*?)(?:[?#][^"'`]*)?["'`]/g,
        /\bto\s*:\s*["'`](\/[^"'`[\]{}$]*?)(?:[?#][^"'`]*)?["'`]/g,
        /\bpath\s*:\s*["'`](\/[^"'`[\]{}$]*?)(?:[?#][^"'`]*)?["'`]/g,
        /router\.push\s*\(\s*["'`](\/[^"'`[\]{}$]*?)(?:[?#][^"'`]*)?["'`]/g,
        /\bredirect\s*\(\s*["'`](\/[^"'`[\]{}$]*?)(?:[?#][^"'`]*)?["'`]/g,
      ];

      const referencedRoutes = new Set<string>();
      for (const sf of srcFiles) {
        if (sf.includes('node_modules') || sf.includes('.next')) continue;
        try {
          const src = await rdFile(sf, 'utf-8');
          for (const pat of routePatterns) {
            let m;
            while ((m = pat.exec(src)) !== null) {
              const route = m[1].replace(/\/$/, '') || '/';
              if (!route || route.startsWith('/api/') || route.includes('[') || route.includes('${')) continue;
              referencedRoutes.add(route);
            }
          }
        } catch { /* skip */ }
      }

      // Determine which nav routes need page stubs
      const created: string[] = [];
      for (const route of referencedRoutes) {
        if (existingPages.has(route)) continue;
        // Skip auth-provider routes (Cognito, Next-auth)
        if (/^\/(api\/)?auth\/callback|cognito|oauth/.test(route)) continue;
        const pageName = route.split('/').filter(Boolean).map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ') || 'Home';
        const componentName = pageName.replace(/[^a-zA-Z0-9]/g, '');
        const stub = `'use client';
import Link from 'next/link';

export default function ${componentName}Page() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-8 bg-slate-50">
      <div className="max-w-md w-full text-center">
        <h1 className="text-3xl font-bold text-slate-900 mb-3">${pageName}</h1>
        <p className="text-slate-500 mb-6">This page is coming soon.</p>
        <Link href="/" className="inline-flex items-center gap-2 bg-blue-600 text-white px-5 py-2.5 rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium">← Back Home</Link>
      </div>
    </main>
  );
}`;
        const dir = pathMod.join(appDir, route.replace(/^\//, ''));
        await mkdir(dir, { recursive: true });
        await writeFile(pathMod.join(dir, 'page.tsx'), stub, 'utf-8');
        created.push(route);
      }

      return NextResponse.json({ success: true, created, total: created.length, message: created.length > 0 ? `Created ${created.length} missing page stubs: ${created.join(', ')}` : 'All referenced routes already have pages' });
    }

    // ── read-file: read a single file from a project for diagnostics ────────────
    if (action === 'read-file') {
      const { filePath: readPath } = body;
      if (!projectPath || !readPath) return NextResponse.json({ success: false, error: 'Missing projectPath or filePath' }, { status: 400 });
      try {
        const content = await readFile(join(projectPath, readPath), 'utf-8');
        return NextResponse.json({ success: true, content, size: content.length });
      } catch {
        return NextResponse.json({ success: false, error: 'File not found' });
      }
    }

    // ── file-create: create a new file in a project ─────────────────────────
    if (action === 'file-create') {
      const { filePath, content: fileContent = '' } = body;
      if (!projectPath || !filePath) return NextResponse.json({ success: false, error: 'Missing projectPath or filePath' }, { status: 400 });
      const abs = join(projectPath, filePath);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, fileContent, 'utf-8');
      try { await recordFileOp(projectPath, 'create', filePath); } catch { /* non-critical */ }
      return NextResponse.json({ success: true, filePath });
    }

    // ── file-delete: delete a file from a project ────────────────────────────
    if (action === 'file-delete') {
      const { filePath } = body;
      if (!projectPath || !filePath) return NextResponse.json({ success: false, error: 'Missing projectPath or filePath' }, { status: 400 });
      const { unlink } = await import('fs/promises');
      await unlink(join(projectPath, filePath));
      try { await recordFileOp(projectPath, 'delete', filePath); } catch { /* non-critical */ }
      return NextResponse.json({ success: true, filePath });
    }

    // ── file-rename: rename/move a file within a project ────────────────────
    if (action === 'file-rename') {
      const { filePath, newPath } = body;
      if (!projectPath || !filePath || !newPath) return NextResponse.json({ success: false, error: 'Missing fields' }, { status: 400 });
      const abs = join(projectPath, filePath);
      const newAbs = join(projectPath, newPath);
      await mkdir(dirname(newAbs), { recursive: true });
      await rename(abs, newAbs);
      try { await recordFileOp(projectPath, 'rename', filePath, newPath); } catch { /* non-critical */ }
      return NextResponse.json({ success: true, from: filePath, to: newPath });
    }

    // ── file-move: copy then delete (alias for rename with different semantics)
    if (action === 'file-move') {
      const { filePath, newPath } = body;
      if (!projectPath || !filePath || !newPath) return NextResponse.json({ success: false, error: 'Missing fields' }, { status: 400 });
      const abs = join(projectPath, filePath);
      const newAbs = join(projectPath, newPath);
      await mkdir(dirname(newAbs), { recursive: true });
      await rename(abs, newAbs);
      try { await recordFileOp(projectPath, 'move', filePath, newPath); } catch { /* non-critical */ }
      return NextResponse.json({ success: true, from: filePath, to: newPath });
    }

    // ── db-scaffold: generate database integration files ────────────────────
    if (action === 'db-scaffold') {
      const { dbType, resource = 'items' } = body;
      if (!projectPath || !dbType) return NextResponse.json({ success: false, error: 'Missing projectPath or dbType' }, { status: 400 });
      const scaffold = generateDatabaseScaffold(dbType as DatabaseType, resource);

      // Write all scaffold files to the project
      const written: string[] = [];
      for (const file of scaffold.files) {
        const abs = join(projectPath, file.path);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, file.content, 'utf-8');
        written.push(file.path);
      }

      // Append new env vars to .env.local.example
      const examplePath = join(projectPath, '.env.local.example');
      let existing = '';
      try { existing = await readFile(examplePath, 'utf-8'); } catch { /* file may not exist yet */ }
      const toAppend = scaffold.envVars
        .filter(v => !existing.includes(v.key))
        .map(v => `# ${v.description}\n${v.key}=`)
        .join('\n');
      if (toAppend) {
        await writeFile(examplePath, existing + '\n' + toAppend + '\n', 'utf-8');
        written.push('.env.local.example');
      }

      try { await recordScaffold(projectPath, 'db', dbType); } catch { /* non-critical */ }
      return NextResponse.json({
        success: true,
        filesCreated: written,
        envVars: scaffold.envVars,
        packages: scaffold.packages,
        instructions: scaffold.instructions,
      });
    }

    // ── deploy-prepare: generate deployment config files ────────────────────
    if (action === 'deploy-prepare') {
      const { target } = body;
      if (!projectPath || !target) return NextResponse.json({ success: false, error: 'Missing projectPath or target' }, { status: 400 });
      const result = await prepareDeployment(projectPath, target as DeployTarget);

      // Write deployment config files
      const written: string[] = [];
      for (const file of result.files) {
        const abs = join(projectPath, file.path);
        await mkdir(dirname(abs), { recursive: true });
        // Don't overwrite existing next.config.js
        let shouldWrite = true;
        if (file.path === 'next.config.js') {
          try { await readFile(abs, 'utf-8'); shouldWrite = false; } catch { /* doesn't exist */ }
        }
        if (shouldWrite) {
          await writeFile(abs, file.content, 'utf-8');
          written.push(file.path);
        }
      }

      try { await recordScaffold(projectPath, 'deploy', target); } catch { /* non-critical */ }
      return NextResponse.json({
        success: true,
        target: result.target,
        ready: result.ready,
        readinessChecks: result.readinessChecks,
        filesCreated: written,
        envVarsNeeded: result.envVarsNeeded,
        deployCommand: result.deployCommand,
        instructions: result.instructions,
      });
    }

    // ── auth-scaffold: generate authentication integration files ────────────
    if (action === 'auth-scaffold') {
      const { authProvider } = body;
      if (!projectPath || !authProvider) return NextResponse.json({ success: false, error: 'Missing projectPath or authProvider' }, { status: 400 });
      const scaffold = generateAuthScaffold(authProvider as AuthProvider);

      const written: string[] = [];
      const skipped: string[] = [];
      for (const file of scaffold.files) {
        const abs = join(projectPath, file.path);
        await mkdir(dirname(abs), { recursive: true });
        // Don't overwrite existing layout.tsx unless it's Clerk (which requires ClerkProvider wrapping)
        if (file.path === 'app/layout.tsx' && authProvider !== 'clerk') {
          try { await readFile(abs, 'utf-8'); skipped.push(file.path); continue; } catch { /* doesn't exist, write it */ }
        }
        await writeFile(abs, file.content, 'utf-8');
        written.push(file.path);
      }

      // Append new env vars to .env.local.example
      const examplePath = join(projectPath, '.env.local.example');
      let existing = '';
      try { existing = await readFile(examplePath, 'utf-8'); } catch { /* may not exist */ }
      const toAppend = scaffold.envVars
        .filter(v => !existing.includes(v.key))
        .map(v => `# ${v.description}\n${v.key}=`)
        .join('\n');
      if (toAppend) {
        await writeFile(examplePath, existing + '\n' + toAppend + '\n', 'utf-8');
        written.push('.env.local.example');
      }

      try { await recordScaffold(projectPath, 'auth', authProvider); } catch { /* non-critical */ }
      return NextResponse.json({
        success: true,
        provider: scaffold.provider,
        filesCreated: written,
        filesSkipped: skipped,
        envVars: scaffold.envVars,
        packages: scaffold.packages,
        instructions: scaffold.instructions,
      });
    }

    // ── clear-memory: reset project memory while keeping projectId/name/path ─
    if (action === 'clear-memory') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const existing = await getProjectMemory(projectPath);
      if (!existing) return NextResponse.json({ success: false, error: 'No memory found' }, { status: 404 });
      const fresh = await initProjectMemory({
        projectId: existing.projectId,
        name: existing.name,
        originalPrompt: existing.originalPrompt,
        projectPath,
        purpose: existing.purpose,
      });
      return NextResponse.json({ success: true, memory: fresh });
    }

    // ── open-project: restart an existing project and run discovery ───────────
    if (action === 'open-project') {
      if (!projectId) return NextResponse.json({ success: false, error: 'Missing projectId' }, { status: 400 });
      const authUser = await getAuthUser(request);
      if (!authUser) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
      const project = await getProject(projectId, authUser.sub);
      if (!project) return NextResponse.json({ success: false, error: 'Project not found' }, { status: 404 });

      // Ensure project has memory (create if it's an old project)
      let mem = await getProjectMemory(project.projectPath);
      if (!mem) {
        mem = await initProjectMemory({
          projectId: project.id,
          name: project.name,
          originalPrompt: project.description || project.name,
          projectPath: project.projectPath,
        });
      }

      // Run discovery and persist results
      const discovery = await discoverAndPersist(project.projectPath);

      // Start the dev server
      const serverResult = await startDevServer(project.projectPath);
      if (serverResult.port) {
        await updateProjectPort(project.projectPath, serverResult.port);
        await updateProjectMemory(project.projectPath, {
          runningPort: serverResult.port,
          previewUrl: `http://localhost:${serverResult.port}`,
        });
      }

      return NextResponse.json({
        ...serverResult,
        previewUrl: publicPreviewUrl(serverResult.port),
        project,
        discovery: {
          summary: discovery.summary,
          pages: discovery.pages,
          components: discovery.components,
          fileCount: discovery.allFiles.length,
          framework: discovery.framework,
          mode: discovery.mode,
          hasApiRoutes: discovery.hasApiRoutes,
          hasDatabase: discovery.hasDatabase,
          hasDataFiles: discovery.hasDataFiles,
          missingCredentials: discovery.missingCredentials,
          envExampleVars: discovery.envExampleVars,
        },
        memory: await getProjectMemory(project.projectPath),
      });
    }

    // ── auto-recover: classify an error and apply automatic fixes ─────────────
    if (action === 'auto-recover') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const errorText: string = body.errorText || body.error || '';
      if (!errorText) return NextResponse.json({ success: false, error: 'Missing errorText' }, { status: 400 });

      const previousAttempts: number = typeof body.attempt === 'number' ? body.attempt : 0;
      const result = await attemptRecovery(projectPath, errorText, previousAttempts);

      return NextResponse.json({
        success: true,
        fixed: result.fixed,
        kind: result.classified.kind,
        userMessage: result.classified.userMessage,
        successMessage: result.successMessage,
        actions: result.actions,
        filesPatched: result.filesPatched,
        packagesInstalled: result.packagesInstalled,
        requiresReinstall: result.requiresReinstall,
        requiresRevalidate: result.requiresRevalidate,
        requiresRestart: result.requiresRestart,
      });
    }

    // ── fix-file: AI repair of one specific file ──────────────────────────────
    if (action === 'fix-file') {
      const { filePath, errorContext } = body;
      if (!projectPath || !filePath) {
        return NextResponse.json({ success: false, error: 'Missing projectPath or filePath' }, { status: 400 });
      }

      let existingContent = '';
      try {
        existingContent = await readFile(join(projectPath, filePath), 'utf-8');
      } catch {
        return NextResponse.json({ success: false, error: 'File not found' });
      }

      const fixPrompt = `Fix this specific file in a Next.js project. Apply the minimum change needed.

File: ${filePath}
Issue: ${errorContext}

Current content:
\`\`\`tsx
${existingContent.slice(0, 6000)}
\`\`\`

Return ONLY the corrected file in this exact format:
[EDIT_START]
[FILE: ${filePath}]
<corrected content here>
[EDIT_END]`;

      const aiResponse = await fixErrorsWithAI(fixPrompt, BUILD_SYSTEM_PROMPT);

      let fixedFiles = parseEditFormat(aiResponse);
      if (fixedFiles.length === 0) {
        const parsed = parseProjectFormat(aiResponse);
        if (parsed?.files?.length) {
          fixedFiles = parsed.files.map(f => ({ path: f.path, content: f.content }));
        }
      }

      if (fixedFiles.length === 0) {
        return NextResponse.json({ success: false, error: 'AI did not produce a fix' });
      }

      const result = await applyEditsToProject(projectPath, fixedFiles);
      return NextResponse.json({ success: result.success, filesFixed: result.filesChanged.length, errors: result.errors });
    }

    // ── snapshot-files: capture current file contents for rollback ────────────
    if (action === 'snapshot-files') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const files: string[] = body.files || [];
      if (files.length === 0) return NextResponse.json({ success: true, snapshotted: 0 });
      await captureSnapshot(projectPath, files);
      return NextResponse.json({ success: true, snapshotted: files.length, files });
    }

    // ── restore-files: roll back to last snapshot ─────────────────────────────
    if (action === 'restore-files') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const restored = await restoreSnapshot(projectPath);
      return NextResponse.json({ success: true, restored, restoredCount: restored.length });
    }

    // ── clear-snapshot: discard snapshot after a successful fix ───────────────
    if (action === 'clear-snapshot') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      await clearSnapshot(projectPath);
      return NextResponse.json({ success: true });
    }

    // ── timeout-repair: static analysis on a route that hung during verification
    // Reads the route source, identifies WHERE it hangs, returns structured profile
    // + engineering memory match. The repair loop uses this to generate a targeted fix
    // (add AbortSignal timeout, add try/catch, add mock fallback) without guessing.
    if (action === 'timeout-repair') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const { analyzeRouteForTimeout } = await import('@/services/route-timeout-analyzer');
      const { findMatchingRepair, formatPatternForPrompt } = await import('@/services/engineering-memory');

      const routeRelPath: string = body.routeFile || '';
      const urlPath: string = body.urlPath || '';
      if (!routeRelPath) return NextResponse.json({ success: false, error: 'Missing routeFile' }, { status: 400 });

      const absoluteRoutePath = join(projectPath, routeRelPath);
      const [profile, memoryMatch] = await Promise.all([
        analyzeRouteForTimeout(absoluteRoutePath, urlPath),
        findMatchingRepair(`${urlPath} handler hung timeout ${body.errorText ?? ''}`, []),
      ]);

      const memoryContext = memoryMatch ? formatPatternForPrompt(memoryMatch) : null;

      // Build the full repair prompt so agent-fix gets all the context
      const agentFixContext =
        profile.repairContext +
        (memoryContext ? `\n\n${memoryContext}` : '') +
        `\n\nTIMING INSTRUMENTATION TO ADD:\n${profile.timingInstrumentation}` +
        `\n\nMOCK RESPONSE SHAPE (use as fallback when all external APIs unavailable):\n${profile.mockResponseShape}`;

      return NextResponse.json({
        success: true,
        profile,
        memoryMatch: memoryMatch ? {
          confidence: memoryMatch.confidence,
          rootCause: memoryMatch.pattern.rootCause,
          fixApproach: memoryMatch.pattern.fixApproach,
          successfulTier: memoryMatch.pattern.successfulTier,
        } : null,
        memoryContext,
        agentFixContext,
        // Quick summary for status display
        summary: `${profile.primaryCause}: ${profile.hangLocation}`,
        canSoftPass: profile.canSoftPass,
      });
    }

    // ── pre-repair-check: diagnose BEFORE touching any files ─────────────────
    // Detects missing packages, route method mismatches, DB init gaps, tsconfig
    // issues, and OCR setup problems. Returns a structured diagnostic so the
    // repair loop can fix environmental issues without calling an AI model.
    if (action === 'pre-repair-check') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const { runPreRepairDiagnostics } = await import('@/services/pre-repair');
      const { findMatchingRepair, formatPatternForPrompt } = await import('@/services/engineering-memory');
      const userReq: string = body.userRequest || '';
      const errorText: string = body.errorContext || body.errorText || '';
      const tsErrors: string[] = body.tsErrors || [];

      const [diagnostic, memoryMatch] = await Promise.all([
        runPreRepairDiagnostics(projectPath, userReq, errorText, tsErrors),
        findMatchingRepair(errorText, tsErrors),
      ]);

      const memoryContext = memoryMatch ? formatPatternForPrompt(memoryMatch) : null;

      return NextResponse.json({
        success: true,
        ...diagnostic,
        memoryMatch: memoryMatch ? {
          confidence: memoryMatch.confidence,
          rootCause: memoryMatch.pattern.rootCause,
          fixApproach: memoryMatch.pattern.fixApproach,
          targetFiles: memoryMatch.pattern.targetFiles,
          successfulTier: memoryMatch.pattern.successfulTier,
        } : null,
        memoryContext,
      });
    }

    // ── deterministic-repair: apply known code transforms WITHOUT calling AI ───
    // Phase 1 of the repair pipeline. For recognised error patterns (auth-await,
    // db-wrapper, missing-use-client), applies a direct file transformation and
    // re-runs TypeScript to confirm the fix. Only falls back to AI if this fails.
    // ── auth-investigate: build auth dependency graph + ordered repair plan ──────
    // Called BEFORE agent-fix when auth-related errors are detected.
    // Returns a RepairPlan with steps ordered so root causes are fixed first.
    if (action === 'auth-investigate') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const externalTsErrors: string[] = Array.isArray(body.tsErrors) ? body.tsErrors : [];

      const { investigateAuthArchitecture } = await import('@/services/auth-investigator');
      const report = await investigateAuthArchitecture(projectPath, externalTsErrors);

      console.log(`[auth-investigate] provider=${report.provider} brokenFiles=${report.repairOrder.length} steps=${report.repairSteps.length}`);
      if (report.repairOrder.length > 0) {
        console.log(`[auth-investigate] Repair order: ${report.repairOrder.join(' → ')}`);
      }

      return NextResponse.json({
        success: true,
        provider: report.provider,
        repairSteps: report.repairSteps,
        healthChecks: report.healthChecks,
        repairOrder: report.repairOrder,
        summary: report.summary,
        // Condensed file map for debug display
        fileMap: report.authFiles.map(f => ({
          rel: f.rel,
          role: f.role,
          errorCount: f.tsErrors.length,
          missing: f.missing,
          hasBrokenDeps: f.hasBrokenDeps,
          deps: f.localDeps,
        })),
      });
    }

    if (action === 'deterministic-repair') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const errorText: string = body.errorText || body.errorContext || '';
      const tsErrors: string[] = Array.isArray(body.tsErrors) ? body.tsErrors : [];
      const forceTransform: string | undefined = body.forceTransform;

      const { runDeterministicRepairs } = await import('@/services/deterministic-repair');
      // forceTransform: if set, inject the transform ID into the error text so the
      // deterministic engine always runs that specific transform regardless of pattern match
      const effectiveErrorText = forceTransform
        ? `${errorText}\n[FORCE_TRANSFORM:${forceTransform}]`
        : errorText;
      const result = await runDeterministicRepairs(projectPath, effectiveErrorText, tsErrors);

      // Log to console for debugging even when debug mode is off
      if (result.applied.length > 0) {
        console.log('[deterministic-repair] Applied:', result.applied.map(f => `${f.transformId} → ${f.file}`).join(', '));
      }

      return NextResponse.json({
        success: true,
        ...result,
        // User-friendly summary (shown in non-debug mode)
        userSummary: result.applied.length > 0
          ? `Identified and applied ${result.applied.length} targeted fix${result.applied.length > 1 ? 'es' : ''}.`
          : 'No known patterns matched — proceeding to AI-assisted repair.',
      });
    }

    // ── install-packages: install multiple npm packages at once ───────────────
    if (action === 'install-packages') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const packages: string[] = body.packages || [];
      if (packages.length === 0) return NextResponse.json({ success: true, installed: [], message: 'No packages specified' });

      // Add packages to package.json first
      const { readFile: rf, writeFile: wf } = await import('fs/promises');
      const pkgPath = join(projectPath, 'package.json');
      const added: string[] = [];
      try {
        const pkgJson = JSON.parse(await rf(pkgPath, 'utf-8'));
        if (!pkgJson.dependencies) pkgJson.dependencies = {};
        for (const pkg of packages) {
          if (!pkgJson.dependencies[pkg] && !pkgJson.devDependencies?.[pkg]) {
            pkgJson.dependencies[pkg] = 'latest';
            added.push(pkg);
          }
        }
        if (added.length > 0) await wf(pkgPath, JSON.stringify(pkgJson, null, 2) + '\n', 'utf-8');
      } catch { /* proceed anyway */ }

      const result = await installDependencies(projectPath, ['--legacy-peer-deps']);
      return NextResponse.json({
        success: result.success,
        installed: packages,
        addedToPackageJson: added,
        output: result.logs?.slice(-10).join('\n'),
      });
    }

    // ── save-repair-memory: persist a successful repair pattern ───────────────
    if (action === 'save-repair-memory') {
      const { saveRepairSuccess } = await import('@/services/engineering-memory');
      const record = {
        errorPattern:    body.errorPattern    || '',
        rootCause:       body.rootCause       || 'unknown',
        fixApproach:     body.fixApproach     || '',
        targetFiles:     body.targetFiles     || [],
        tsErrorsToAvoid: body.tsErrorsToAvoid || [],
        successfulTier:  body.successfulTier  || 'SONNET',
      };
      if (!record.errorPattern || !record.fixApproach) {
        return NextResponse.json({ success: false, error: 'Missing errorPattern or fixApproach' });
      }
      await saveRepairSuccess(record);
      return NextResponse.json({ success: true, saved: record.rootCause });
    }

    // ── run-browser-journey: full browser-level user journey (Playwright) ───────────────────
    // Opens a real headless browser, navigates pages, fills forms, uploads images, clicks buttons.
    // Returns PASSED or FAILED VERIFICATION — never ambiguous.
    // Failed steps include screenshots, console errors, and failed network requests.
    if (action === 'run-browser-journey') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const port = body.port as number;
      if (!port) return NextResponse.json({ success: false, error: 'Missing port' }, { status: 400 });

      const { runBrowserJourney, BrowserJourneyType } = await import('@/services/browser-journey-runner') as {
        runBrowserJourney: (baseUrl: string, type: import('@/services/browser-journey-runner').BrowserJourneyType) => Promise<import('@/services/browser-journey-runner').BrowserJourneyResult>;
        BrowserJourneyType: unknown;
      };

      // Detect project type from discovery
      let projectType: import('@/services/browser-journey-runner').BrowserJourneyType = 'generic';
      try {
        const disc = await discoverProject(projectPath as string);
        const { detectProjectType } = await import('@/services/journey-tester');
        const name = (projectPath as string).split('/').pop() ?? '';
        const detected = detectProjectType(name, disc.apiRoutes ?? [], disc.pages ?? []);
        if (['marketplace', 'booking', 'social'].includes(detected)) {
          projectType = detected as typeof projectType;
        }
      } catch { /* default to generic */ }

      if (body.projectType && ['marketplace', 'booking', 'social', 'generic'].includes(body.projectType)) {
        projectType = body.projectType as typeof projectType;
      }

      const baseUrl = `http://localhost:${port}`;
      const result = await runBrowserJourney(baseUrl, projectType);
      return NextResponse.json({ success: true, journey: result });
    }

    // ── run-journey: simulate a real user flow (register → login → create → list) ─────────
    // Unlike verify-app (individual route pings), run-journey tests connected user flows.
    // A marketplace with all routes returning 200 can still fail if the auth flow is broken.
    // ── auto-repair-journey-failure: consume a repair package and fix without user intervention ─
    // Takes a RepairPackage (built from browser journey failure), enriches it with flow trace,
    // builds a targeted agent-fix prompt, and applies the repair. Returns fix result + whether
    // the caller should re-run the journey to confirm.
    if (action === 'auto-repair-journey-failure') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const pkg = body.repairPackage as import('@/services/repair-package').RepairPackage;
      if (!pkg?.failedStep) return NextResponse.json({ success: false, error: 'Missing repairPackage' }, { status: 400 });

      const { formatRepairPackageForPrompt } = await import('@/services/repair-package');
      const { traceFailure } = await import('@/services/flow-tracer');

      // Enrich package with flow trace from first failing network request
      let enrichedPrompt = formatRepairPackageForPrompt(pkg);
      const firstFailedReq = pkg.failedNetworkRequests[0];
      if (firstFailedReq && projectPath) {
        try {
          const urlPath = new URL(firstFailedReq.url).pathname;
          const trace = await traceFailure(urlPath, firstFailedReq.status, 'GET', projectPath as string);
          if (trace.diagnosis) {
            enrichedPrompt = `[FLOW TRACE]\n${trace.diagnosis}\nFix: ${trace.fixHint}\n\n${enrichedPrompt}`;
            if (trace.fixFile && !pkg.affectedFiles.includes(trace.fixFile)) {
              pkg.affectedFiles = [...pkg.affectedFiles, trace.fixFile];
            }
          }
        } catch { /* non-critical */ }
      }

      // Enrich with live web search results for unusual or unknown errors
      try {
        const { searchWeb, buildErrorSearchQuery, formatSearchResultsForPrompt } = await import('@/services/web-search');
        const errorContext = pkg.failureDetail ?? pkg.failedStep;
        if (errorContext && pkg.consoleErrors?.length > 0) {
          const query = buildErrorSearchQuery(
            pkg.consoleErrors[0] || errorContext,
            `Next.js ${pkg.projectType ?? 'app'}`,
          );
          const searchRes = await searchWeb(query, 4);
          if (searchRes.results.length > 0) {
            enrichedPrompt += formatSearchResultsForPrompt(searchRes);
          }
        }
      } catch { /* non-critical — repair proceeds without search */ }

      // Determine target files: use affectedFiles from package + any lib files referenced
      const targetFiles = pkg.affectedFiles.length > 0
        ? pkg.affectedFiles
        : [`app/${pkg.projectType === 'marketplace' ? 'api/listings/route.ts' : 'api/auth/me/route.ts'}`];

      // Run agent-fix with the repair package as error context
      const sourceFiles: string[] = [];
      for (const f of targetFiles) {
        try {
          const content = await readFile(join(projectPath as string, f), 'utf-8');
          sourceFiles.push(`=== ${f} ===\n${content.slice(0, 3000)}`);
        } catch { /* skip missing */ }
      }

      const editPrompt = `${enrichedPrompt}\n\nSOURCE FILES TO FIX:\n${sourceFiles.join('\n\n')}\n\n` +
        `Return ONLY the files that need to change. Use the standard XML edit format:\n` +
        `<file path="app/api/listings/route.ts">...fixed content...</file>`;

      let fixResult: { fixedCount: number; changedFiles: string[] } = { fixedCount: 0, changedFiles: [] };
      try {
        const aiResult = await editWithAI(editPrompt, '', 'SONNET');
        const parsed = parseEditFormat(aiResult);
        if (parsed.length > 0) {
          await applyEditsToProject(projectPath as string, parsed);
          fixResult = { fixedCount: parsed.length, changedFiles: parsed.map(f => f.path) };
        }
      } catch { /* non-critical — fixResult stays at 0 */ }

      // Record this repair attempt in the package
      const attempt: import('@/services/repair-package').RepairAttempt = {
        tier: 'SONNET',
        filesChanged: fixResult.changedFiles,
        resultVerdict: 'not-run', // caller updates this after re-running the journey
        attemptedAt: new Date().toISOString(),
      };
      pkg.repairAttempts = [...(pkg.repairAttempts ?? []), attempt];

      // Learn from this repair — store in engineering memory even before re-verification
      if (fixResult.fixedCount > 0) {
        const { learnFromRepair } = await import('@/services/repair-learner');
        const callAI = async (p: string, tier: 'HAIKU' | 'SONNET'): Promise<string> =>
          fixErrorsWithAI(p, '', tier);
        learnFromRepair({
          errorText: `Browser journey FAILED: ${pkg.failedStep} — ${pkg.failureDetail}\nFailed requests: ${pkg.failedNetworkRequests.map(r => `${r.status} ${r.url}`).join(', ')}`,
          changedFiles: fixResult.changedFiles,
          userMessage: `Auto-repair for ${pkg.journeyName} (step: ${pkg.failedStep})`,
          successfulTier: 'SONNET',
          projectPath: projectPath as string,
          fixSummary: `Auto-repaired journey failure at "${pkg.failedStep}" — ${fixResult.changedFiles.join(', ')}`,
        }, callAI).catch(() => { /* non-critical */ });
      }

      return NextResponse.json({
        success: true,
        ...fixResult,
        shouldReverify: fixResult.fixedCount > 0,
        repairPackage: pkg,
      });
    }

    if (action === 'run-journey') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const port = body.port as number;
      if (!port) return NextResponse.json({ success: false, error: 'Missing port' }, { status: 400 });

      const { testUserJourney } = await import('@/services/journey-tester');
      const baseUrl = `http://localhost:${port}`;

      // Discover project routes so we can build an appropriate journey
      let apiRoutes: string[] = body.apiRoutes ?? [];
      let pages: string[] = body.pages ?? [];
      let projectName: string = body.projectName ?? '';

      if ((!apiRoutes.length || !projectName) && projectPath) {
        try {
          const disc = await discoverProject(projectPath as string);
          apiRoutes = apiRoutes.length ? apiRoutes : (disc.apiRoutes ?? []);
          pages = pages.length ? pages : (disc.pages ?? []);
          // DiscoveryResult has no projectName — derive from projectPath
          if (!projectName) {
            projectName = (projectPath as string).split('/').pop() ?? '';
          }
        } catch { /* non-critical */ }
      }

      const result = await testUserJourney({ baseUrl, projectName, apiRoutes, pages });
      return NextResponse.json({ success: true, journey: result });
    }

    // ── trace-failure: trace a failed route through UI → Route → Auth → Database ─────────
    // When verify-app flags a specific route as 401/404/500, trace-failure reads the source
    // to identify exactly which layer in the chain is broken.
    if (action === 'trace-failure') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const path: string = body.path ?? '';
      const httpStatus: number = body.status ?? 500;
      const method: string = body.method ?? 'GET';
      if (!path) return NextResponse.json({ success: false, error: 'Missing path' }, { status: 400 });

      const { traceFailure, formatFlowTrace } = await import('@/services/flow-tracer');
      const trace = await traceFailure(path, httpStatus, method, projectPath as string);
      const formatted = formatFlowTrace(trace);

      return NextResponse.json({ success: true, trace, formatted });
    }

    // ── learn-from-repair: post-repair learning — improves the engine, not just the project ──
    // Called after EVERY successful repair. Unlike save-repair-memory (manual pattern),
    // this uses AI to extract a canonical pattern, classifies the engine capability,
    // tracks confidence, promotes to auto-repair at confidence ≥ 3, and runs verification.
    if (action === 'learn-from-repair') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });

      const errorText: string    = body.errorText    || '';
      const changedFiles: string[] = body.changedFiles || [];
      const userMessage: string  = body.userMessage  || '';
      const fixSummary: string   = body.fixSummary   || '';
      const tier: 'HAIKU' | 'SONNET' | 'STRONGEST' =
        (['HAIKU','SONNET','STRONGEST'].includes(body.tier)) ? body.tier : 'SONNET';

      // Provide the learner with access to the AI (Haiku for pattern extraction)
      const callAI = async (prompt: string, model: 'HAIKU' | 'SONNET'): Promise<string> => {
        const bedrockTier = model === 'HAIKU' ? 'HAIKU' : 'SONNET';
        return await fixErrorsWithAI(prompt, '', bedrockTier);
      };

      const { learnFromRepair } = await import('@/services/repair-learner');
      const result = await learnFromRepair(
        { errorText, changedFiles, userMessage, successfulTier: tier, projectPath, fixSummary },
        callAI,
      );

      return NextResponse.json({ success: true, learning: result });
    }

    // ── agent-fix: targeted multi-file AI repair for the autonomous loop ──────
    // Unlike 'fix-file' (single file) or 'edit' (full discovery + user intent),
    // agent-fix is purpose-built for the engineer loop:
    //   • Only reads the files named in targetFiles
    //   • Includes server logs and TS error summary in the prompt
    //   • Instructs the AI to change MINIMUM code, not rewrite the app
    //   • Returns fixedCount and changedFiles for the loop to track progress
    if (action === 'agent-fix') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });

      const errorContext: string = body.errorContext || '';
      const targetFiles: string[] = body.targetFiles || [];
      const serverLogs: string = body.serverLogs || '';
      const tsErrors: string = body.tsErrors || '';
      const browserErrors: string = body.browserErrors || '';
      // strategy: 'surgical' = single-file minimal change with export map
      //           'targeted' = minimum change across named files
      //           'broader' = broader context, more files
      //           'rewrite' = full file rewrite
      const strategy: 'surgical' | 'targeted' | 'broader' | 'rewrite' = body.strategy || 'targeted';
      // For surgical edits: pre-built export map from export-inspector
      const exportMapBlock: string = body.exportMap || '';
      // tier: explicit model override — caller drives escalation (HAIKU → SONNET → STRONGEST)
      // Falls back to strategy-based selection when not provided.
      const explicitTier: import('@/lib/constants').BedrockTier | undefined =
        body.tier && ['HAIKU', 'SONNET', 'STRONGEST'].includes(body.tier) ? body.tier : undefined;

      // ── Scope-filter targetFiles for backend errors ────────────────────────
      // When the error kind is a pure backend error (route, DB, auth, provider),
      // the AI must NOT touch UI page/layout/component files. Remove them from
      // the target list so they don't appear in file contexts for the repair prompt.
      const errorKind: string = body.errorKind ?? '';
      let effectiveTargetFiles = [...targetFiles];
      try {
        const { isUIFile: _isUI, isBackendErrorKind: _isBE } = await import('@/services/design-baseline');
        if (errorKind && _isBE(errorKind)) {
          const before = effectiveTargetFiles.length;
          effectiveTargetFiles = effectiveTargetFiles.filter(f => !_isUI(f));
          if (effectiveTargetFiles.length < before) {
            console.log(`[agent-fix] Removed ${before - effectiveTargetFiles.length} UI file(s) from target list (backend error: ${errorKind})`);
          }
        }
      } catch { /* non-critical */ }

      // ── Build file context ─────────────────────────────────────────────────
      const fileContexts: string[] = [];
      const extraContextFiles: string[] = [];

      // Primary target files
      for (const relPath of effectiveTargetFiles.slice(0, 6)) {
        try {
          const content = await readFile(join(projectPath, relPath), 'utf-8');
          fileContexts.push(`=== ${relPath} ===\n${content.slice(0, 4000)}`);
        } catch {
          fileContexts.push(`=== ${relPath} === (FILE NOT FOUND — needs to be created)`);
        }
      }

      // 'broader' strategy: also include adjacent context files
      if (strategy === 'broader' || strategy === 'rewrite') {
        // lib/managed/db.ts — always useful for DB errors — show EXPORT MAP, not full source
        try {
          const { extractExports } = await import('@/services/export-inspector');
          const dbTs = await readFile(join(projectPath, 'lib/managed/db.ts'), 'utf-8');
          const dbExports = extractExports(dbTs);
          extraContextFiles.push(
            `=== lib/managed/db.ts ACTUAL EXPORTS (use ONLY these names) ===\n` +
            `named: ${dbExports.named.join(', ')}\ntypes: ${dbExports.types.join(', ')}\n\n` +
            `FULL SOURCE:\n${dbTs.slice(0, 2000)}`
          );
        } catch {}
        // lib/managed/auth.ts — show EXPORT MAP first
        try {
          const { extractExports } = await import('@/services/export-inspector');
          const authTs = await readFile(join(projectPath, 'lib/managed/auth.ts'), 'utf-8');
          const authExports = extractExports(authTs);
          extraContextFiles.push(
            `=== lib/managed/auth.ts ACTUAL EXPORTS (use ONLY these names) ===\n` +
            `named: ${authExports.named.join(', ')}\ntypes: ${authExports.types.join(', ')}\n\n` +
            `FULL SOURCE:\n${authTs.slice(0, 2000)}`
          );
        } catch {}
        // package.json — understand what packages are available
        try {
          const pkg = await readFile(join(projectPath, 'package.json'), 'utf-8');
          const { dependencies = {}, devDependencies = {} } = JSON.parse(pkg);
          const allDeps = Object.keys({ ...dependencies, ...devDependencies }).join(', ');
          extraContextFiles.push(`=== Available packages ===\n${allDeps}`);
        } catch {}
        // Scan error text for file references and include them
        const allText = errorContext + '\n' + serverLogs + '\n' + browserErrors;
        const fileRefs = [...allText.matchAll(/(?:app\/|lib\/|components\/)([\w/-]+\.(?:ts|tsx|js|jsx))/g)]
          .map(mr => mr[1]).filter(f => !f.includes('node_modules') && !targetFiles.includes(f)).slice(0, 3);
        for (const ref of fileRefs) {
          try {
            const content = await readFile(join(projectPath, ref), 'utf-8');
            extraContextFiles.push(`=== ${ref} (referenced in error) ===\n${content.slice(0, 2000)}`);
          } catch {}
        }

        // ── Provider registry context ──────────────────────────────────────
        // When fixing API routes that call external providers, inject the correct
        // provider details so Strongest/Sonnet can fix the integration, not just
        // the syntax. This is what enables "football app provider error → Sonnet/
        // Strongest rewrites the route with the right LiveScore 6 endpoint + headers."
        const allErrorText = errorContext + '\n' + serverLogs + '\n' + browserErrors;
        const isProviderError = /provider.misconfigured|rapidapi|external.*api|fetch.failed|upstream|rate.?limit/i.test(allErrorText);
        const hasApiRouteTargets = targetFiles.some(f => f.includes('/api/'));
        if (isProviderError || hasApiRouteTargets) {
          try {
            // Infer what the route is doing from its name + error text keywords
            const routeSegments = targetFiles.map(f => f.split('/').pop()?.replace(/\.(tsx?|jsx?)$/, '') ?? '');
            const domainKeywords = (allErrorText.match(
              /\b(football|soccer|cricket|basketball|sport|score|match|fixture|weather|currency|exchange|crypto|stock|news|music|video|travel|hotel|flight|restaurant|map|location|country|finance)\b/gi
            ) ?? []).map(w => w.toLowerCase());
            const inferredNeed = [...new Set([...routeSegments, ...domainKeywords])].filter(Boolean).join(' ');

            if (inferredNeed.trim()) {
              const { selectProvider } = await import('@/services/provider-engine');
              const plan = await selectProvider({ need: inferredNeed });
              if (plan.primary) {
                const p = plan.primary;
                const rapidEntry = p.rapidApiEntry;
                let providerBlock = `Provider: ${p.name} [${p.tier}]\nDescription: ${p.description}`;
                if (p.tier === 'rapidapi' && rapidEntry) {
                  providerBlock += `\nRapidAPI Host: ${rapidEntry.host}`;
                  // testEndpoint is the verified working endpoint for this provider
                  if (rapidEntry.testEndpoint) {
                    const method = rapidEntry.testMethod ?? 'GET';
                    providerBlock += `\nSample endpoint: ${method} ${rapidEntry.testEndpoint}`;
                    if (rapidEntry.testParams && Object.keys(rapidEntry.testParams).length) {
                      providerBlock += `\nSample params: ${JSON.stringify(rapidEntry.testParams)}`;
                    }
                  }
                  providerBlock += `\nRequired auth headers:\n  X-RapidAPI-Key: process.env.RAPIDAPI_KEY\n  X-RapidAPI-Host: "${rapidEntry.host}"`;
                } else if (p.tier === 'public' && p.publicEntry) {
                  const pe = p.publicEntry;
                  providerBlock += `\nBase URL: ${pe.buildUrl(pe.testParams ?? {})}`;
                  providerBlock += `\nNo auth key required`;
                } else if (p.tier === 'aws') {
                  providerBlock += `\nAWS service: ${p.awsService}\nKey env var: AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY`;
                }
                if (p.keyEnvVar) providerBlock += `\nKey env var: ${p.keyEnvVar}`;
                if (plan.alternatives.length) {
                  providerBlock += `\nAlternatives available: ${plan.alternatives.slice(0, 3).map(a => `${a.name} [${a.tier}]`).join(', ')}`;
                }
                extraContextFiles.push(`=== DWOMOH Provider Registry — recommended provider for this fix ===\n${providerBlock}`);
              } else {
                extraContextFiles.push(
                  `=== DWOMOH Provider Registry ===\n` +
                  `No subscribed RapidAPI provider found for inferred need: "${inferredNeed}". ` +
                  `Rationale: ${plan.rationale}. ` +
                  `Searched tiers: ${plan.tierSummary.map(t => `${t.tier}(${t.found} found)`).join(', ')}. ` +
                  `Fallback options: use a free public API or check RAPIDAPI_KEY subscription.`
                );
              }
            }
          } catch { /* provider engine unavailable — non-critical, continue without provider context */ }
        }
      }

      // Fallback: if no target files identified, scan logs for file references
      if (fileContexts.length === 0 && (serverLogs || errorContext)) {
        const allText = serverLogs + '\n' + errorContext;
        const fileRefs = [...allText.matchAll(/(?:\.\/|app\/|lib\/|pages\/)([\w/-]+\.(?:ts|tsx|js|jsx))/g)]
          .map(m => m[1]).filter(f => !f.includes('node_modules')).slice(0, 4);
        for (const ref of fileRefs) {
          try {
            const content = await readFile(join(projectPath, ref), 'utf-8');
            fileContexts.push(`=== ${ref} ===\n${content.slice(0, 3000)}`);
          } catch {}
        }
      }

      // ── Load spec for repair context recovery ─────────────────────────────────
      // After any repair cycle, reload the original project spec so the AI knows
      // WHAT it's repairing. This prevents repair from drifting toward a different
      // project type (e.g. re-generating a weather dashboard when fixing a booking app).
      let repairSpecBlock = '';
      try {
        const { loadSpec, formatSpecAnchor } = await import('@/services/project-spec');
        const repairSpec = await loadSpec(projectPath);
        if (repairSpec) {
          repairSpecBlock = `${formatSpecAnchor(repairSpec)}\n\n⚠️ You are repairing THIS specific project (above). Fix the errors without changing the project type, pages, or features.\n\n`;
        }
      } catch { /* non-fatal — spec may not exist for older projects */ }

      // ── Design preservation block ─────────────────────────────────────────
      // Load the baseline file list so repair prompts can explicitly name the
      // protected files. This prevents broader/rewrite strategies from replacing
      // working visual code as a side-effect of fixing backend errors.
      let designPreservationBlock = '';
      let baselineUIFiles: string[] = [];
      try {
        const { getBaselineFileSet, isBackendErrorKind } = await import('@/services/design-baseline');
        const bSet = await getBaselineFileSet(projectPath);
        baselineUIFiles = [...bSet];
        if (baselineUIFiles.length > 0) {
          const errorKind = body.errorKind ?? '';
          const isBackend = errorKind ? isBackendErrorKind(errorKind) : false;
          if (isBackend) {
            designPreservationBlock =
              `\n⚠️ DESIGN PRESERVATION — HARD RULE:\n` +
              `The error you are fixing is a backend/API error. The following UI files contain the app's visual design and MUST NOT be changed:\n` +
              baselineUIFiles.map(f => `  • ${f}`).join('\n') + '\n' +
              `Do NOT touch any CSS, colors, layout, component structure, or JSX in these files.\n` +
              `Only output [EDIT_START] blocks for API routes, lib/, and config files.\n\n`;
          } else {
            designPreservationBlock =
              `\n⚠️ DESIGN PRESERVATION:\n` +
              `These files contain the project's original visual design — preserve their styling, colors, layout, and component structure exactly:\n` +
              baselineUIFiles.map(f => `  • ${f}`).join('\n') + '\n' +
              `If you must edit a UI file to fix a broken import or TypeScript error, change ONLY that import/type line. Do NOT rewrite JSX, styles, or component logic.\n\n`;
          }
        }
      } catch { /* non-critical */ }

      // ── Build the fix prompt based on strategy ─────────────────────────────
      const relevantLogs = serverLogs
        ? serverLogs.split('\n').filter(l => /error|failed|cannot find|syntax|warning/i.test(l)).slice(-20).join('\n')
        : '(none)';

      let fixPrompt: string;

      if (strategy === 'surgical') {
        // Surgical: read the one file we're changing and inject real export maps
        // for every import so the AI can't hallucinate names like getDb/getCurrentUser.
        const singleFile = fileContexts[0] ?? '(file not found)';
        fixPrompt = `${repairSpecBlock}SURGICAL EDIT — Make the MINIMUM change to satisfy the request below.

USER REQUEST:
${errorContext}

CURRENT FILE TO MODIFY:
${singleFile}

ACTUAL EXPORTS FROM THIS FILE'S IMPORTS:
${exportMapBlock || '(no import map — use only what is visible in the file above)'}

SURGICAL RULES — FOLLOW EXACTLY:
1. Return ONLY the file shown above. Do NOT output any other file.
2. Change ONLY the section(s) needed for the user request. Preserve everything else verbatim.
3. Do NOT add new imports unless the change strictly requires them.
4. If you need a function/type from an import, it MUST appear in the ACTUAL EXPORTS list above. Never invent names.
5. Do NOT rename any existing function, variable, component, or export.
6. Do NOT reformat or restructure code you are not changing.
7. Do NOT add comments describing what changed.
Format: [EDIT_START] [FILE: ${targetFiles[0] ?? 'unknown'}] <complete modified file content> [EDIT_END]`;
      } else if (strategy === 'rewrite') {
        fixPrompt = `${repairSpecBlock}${designPreservationBlock}FULL REWRITE TASK — Previous targeted fixes failed. Rewrite the broken files completely.

ERRORS TO FIX:
${errorContext || '(see logs below)'}

SERVER LOGS:
${relevantLogs}

BROWSER CONSOLE ERRORS:
${browserErrors || '(none)'}

TYPESCRIPT ERRORS:
${tsErrors || '(none)'}

FILES TO REWRITE (full replacement):
${fileContexts.join('\n\n')}

${extraContextFiles.length > 0 ? `ADDITIONAL CONTEXT FILES (for reference only — do not change unless broken):\n${extraContextFiles.join('\n\n')}` : ''}

REWRITE RULES:
1. Write complete, correct replacements for ALL listed files.
2. For API routes (app/api/*/route.ts):
   - Export the correct HTTP method handlers (GET, POST, PUT, DELETE, PATCH)
   - Wrap ALL code in try/catch, return { error: message, success: false } with status 500 on failure
   - Use managed db: import { db, initTable, generateId } from '@/lib/managed/db'
   - Return NextResponse.json({ success: true, data: [...] }) on success
3. For database errors: ensure initTable() is called at the top of the handler
4. For 405 errors: ensure the route exports exactly the methods the frontend calls
5. For auth errors: use import { getAuthUser } from '@/lib/managed/auth' — NOT verifyToken, NOT getCurrentUser
6. For timeout errors: add AbortController(5000) to any fetch() inside the handler
7. Output ALL changed files — complete content, no truncation.
8. Format: [EDIT_START] [FILE: path] <content> [EDIT_END]`;
      } else if (strategy === 'broader') {
        fixPrompt = `${repairSpecBlock}${designPreservationBlock}AUTONOMOUS AGENT FIX — Broader context repair attempt.

ERRORS DETECTED:
${errorContext || '(see logs below)'}

SERVER LOGS:
${relevantLogs}

BROWSER CONSOLE ERRORS:
${browserErrors || '(none)'}

TYPESCRIPT ERRORS:
${tsErrors || '(none)'}

FILES TO FIX:
${fileContexts.join('\n\n')}

ADDITIONAL CONTEXT:
${extraContextFiles.join('\n\n')}

REPAIR RULES:
1. Fix ALL errors listed. Do not stop after one file.
2. For HTTP 405: check EVERY route file for missing method exports.
3. For HTTP 500: wrap ALL async operations in try/catch, never let unhandled errors reach the response.
4. For database errors: ensure initTable() is called first, column names match the schema.
5. For auth errors: ensure JWT_SECRET env var is set or use a fallback.
6. For 404 routes: create the missing route file at the exact path.
7. For timeout: add 5-second AbortController to fetch calls.
8. For preview/hydration errors: add 'use client' where needed, check hook rules.
9. Output [EDIT_START] [FILE: path] <content> [EDIT_END] for each changed file.`;
      } else {
        // targeted (default): inject real export maps for any lib/managed imports
        // to prevent hallucinated function names in the AI output
        let managedExportBlock = '';
        const hasApiTargets = targetFiles.some(f => f.includes('/api/'));
        if (hasApiTargets) {
          try {
            const { extractExports } = await import('@/services/export-inspector');
            const parts: string[] = [];
            for (const libFile of ['lib/managed/db.ts', 'lib/managed/auth.ts']) {
              try {
                const src = await readFile(join(projectPath, libFile), 'utf-8');
                const exp = extractExports(src);
                parts.push(`${libFile} → named: ${exp.named.join(', ')}; types: ${exp.types.join(', ')}`);
              } catch {}
            }
            if (parts.length) managedExportBlock = `\nACTUAL LIB EXPORTS (use ONLY these names — do not invent others):\n${parts.join('\n')}\n`;
          } catch {}
        }

        fixPrompt = `${repairSpecBlock}${designPreservationBlock}AUTONOMOUS AGENT FIX — Minimum targeted changes.

ERRORS DETECTED:
${errorContext || '(see logs below)'}

SERVER LOGS:
${relevantLogs}

TYPESCRIPT ERRORS:
${tsErrors || '(none)'}
${managedExportBlock}
FILES TO FIX:
${fileContexts.length > 0 ? fileContexts.join('\n\n') : '(no specific files identified — find the correct file from the error above)'}

RULES:
1. Fix ONLY the specific errors listed.
2. Change ONLY the minimum lines needed.
3. HTTP 405 → add the missing export async function GET/POST/PUT/DELETE.
4. HTTP 500 → wrap the crashing line in try/catch, return safe JSON.
5. Timeout → add AbortController(5000ms) to internal fetch calls.
6. TypeScript error → fix ONLY the flagged type.
7. 404 → create the missing route file.
8. Database error → add initTable() call, fix column names.
9. Do NOT rewrite working code.
10. Output [EDIT_START] [FILE: path] <content> [EDIT_END] for each file.`;
      }

      // Tier selection: explicit caller override wins; otherwise escalate by strategy
      const repairTier: import('@/lib/constants').BedrockTier =
        explicitTier ?? ((strategy === 'broader' || strategy === 'rewrite') ? 'STRONGEST' : strategy === 'surgical' ? 'SONNET' : 'SONNET');
      console.log(`[agent-fix] strategy=${strategy} tier=${repairTier} targets=${targetFiles.join(',')}`);
      const aiResponse = await fixErrorsWithAI(fixPrompt, BUILD_SYSTEM_PROMPT, repairTier);

      let fixedFiles = parseEditFormat(aiResponse);
      if (fixedFiles.length === 0) {
        const parsed = parseProjectFormat(aiResponse);
        if (parsed?.files?.length) {
          fixedFiles = parsed.files.map(f => ({ path: f.path, content: f.content }));
        }
      }

      if (fixedFiles.length === 0) {
        return NextResponse.json({ success: false, error: 'AI did not produce any file changes' });
      }

      const applied = await applyEditsToProject(projectPath, fixedFiles);
      return NextResponse.json({
        success: applied.success,
        fixedCount: applied.filesChanged.length,
        changedFiles: applied.filesChanged,
        errors: applied.errors,
        strategy,
        tier: repairTier,
      });
    }

    // ── list-project-files: return a flat list of source files in the project ──
    if (action === 'list-project-files') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      try {
        const { readdir } = await import('fs/promises');
        const files: string[] = [];
        const SKIP = new Set(['node_modules', '.next', '.git', 'dist', 'out', '.dwomoh']);

        async function walk(dir: string, rel: string): Promise<void> {
          let entries;
          try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
          for (const e of entries) {
            if (SKIP.has(e.name)) continue;
            const childRel = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) {
              await walk(join(dir, e.name), childRel);
            } else if (/\.(tsx?|jsx?|json|css|md)$/.test(e.name)) {
              files.push(childRel);
            }
          }
        }

        await walk(projectPath, '');
        return NextResponse.json({ success: true, files });
      } catch (err) {
        return NextResponse.json({ success: false, error: String(err) });
      }
    }

    // ── inspect-exports: read actual exports from a project file ─────────────
    // Used before surgical edits so the AI prompt contains REAL export names.
    // Prevents hallucinated imports like getDb (→ actual: db) or getCurrentUser (→ actual: getAuthUser).
    if (action === 'inspect-exports') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const sourceFile: string = body.sourceFile || '';  // relative path of the file being edited
      const targetSpecifiers: string[] = body.targetSpecifiers || []; // specific imports to inspect (optional)

      try {
        const { inspectImportedExports, formatExportMap } = await import('@/services/export-inspector');
        const absPath = join(projectPath, sourceFile);
        const maps = await inspectImportedExports(absPath, projectPath);

        // Filter to requested specifiers if provided
        const filtered = targetSpecifiers.length > 0
          ? maps.filter(m => targetSpecifiers.some(s => m.specifier.includes(s)))
          : maps;

        return NextResponse.json({
          success: true,
          maps: filtered,
          formatted: formatExportMap(filtered),
        });
      } catch (err) {
        return NextResponse.json({ success: false, error: String(err) });
      }
    }

    // ── run-command: execute a shell command in the project directory ──────────
    if (action === 'run-command') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const command: string = body.command || '';
      if (!command) return NextResponse.json({ success: false, error: 'Missing command' }, { status: 400 });

      // Block dangerous commands
      const BLOCKED = ['rm -rf', 'sudo', 'curl | bash', 'wget |', '> /dev/', 'mkfs', 'dd if='];
      if (BLOCKED.some(b => command.includes(b))) {
        return NextResponse.json({ success: false, error: 'Command blocked for safety' }, { status: 403 });
      }

      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: projectPath,
          timeout: 30000,
          maxBuffer: 256 * 1024,
        });
        const output = [...(stdout || '').split('\n'), ...(stderr ? ['[stderr]', ...stderr.split('\n')] : [])].filter(Boolean);
        return NextResponse.json({ success: true, output, exitCode: 0 });
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; code?: number };
        const output = [...(e.stdout || '').split('\n'), ...(e.stderr || '').split('\n')].filter(Boolean);
        return NextResponse.json({ success: false, output, exitCode: e.code || 1 });
      }
    }

    // ── collect-signals: Universal Signal Collector ───────────────────────────
    if (action === 'collect-signals') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const { collectAllSignals } = await import('@/services/signal-collector');
      const collection = await collectAllSignals(projectPath, {
        existingErrorText: body.errorText ?? '',
        runBuildCheck: body.runBuildCheck ?? false,
        skipRuntimeLog: false,
      });
      return NextResponse.json({ success: true, collection });
    }

    // ── build-project-map: Project Understanding Engine ───────────────────────
    if (action === 'build-project-map') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const { buildProjectMap, saveProjectMap } = await import('@/services/project-map');
      const map = await buildProjectMap(projectPath);
      await saveProjectMap(projectPath, map);
      // Return a lightweight summary (not the full graph — too large for JSON response)
      return NextResponse.json({
        success: true,
        summary: {
          fileCount: map.files.length,
          authProvider: map.authProvider,
          authFiles: map.authFiles,
          middlewareFile: map.middlewareFile,
          envVarsMissing: map.envVarsMissing,
          dbTables: map.dbTables,
          routeCount: map.routes.length,
          layerCounts: Object.fromEntries(
            Object.entries(map.layers).map(([k, v]) => [k, (v as string[]).length])
          ),
        },
      });
    }

    // ── build-repair-plan: Root Cause Engine → ordered RepairPlan ─────────────
    if (action === 'build-repair-plan') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const { collectAllSignals } = await import('@/services/signal-collector');
      const { getProjectMap } = await import('@/services/project-map');
      const { buildRepairPlan } = await import('@/services/repair-planner');

      const collection = await collectAllSignals(projectPath, {
        existingErrorText: body.errorText ?? '',
        runBuildCheck: false,
      });
      const map = await getProjectMap(projectPath);
      const plan = buildRepairPlan(collection, map);

      return NextResponse.json({
        success: true,
        collection: { totalCount: collection.totalCount, summary: collection.summary },
        plan: {
          hasRootCause: plan.hasRootCause,
          summary: plan.summary,
          debugDetail: plan.debugDetail,
          steps: plan.steps,
          hypothesisCount: plan.hypotheses.length,
        },
      });
    }

    // ── execute-repair-step: run one step from the RepairPlan ─────────────────
    if (action === 'execute-repair-step') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const step = body.step as import('@/services/repair-planner').RepairStep;
      if (!step) return NextResponse.json({ success: false, error: 'Missing step' }, { status: 400 });

      // Snapshot before repair
      const { captureSnapshot: captureRepairSnapshot } = await import('@/services/project-snapshot');
      await captureRepairSnapshot(projectPath, [step.targetFile]).catch(() => {});

      switch (step.action) {
        case 'delete-file': {
          const { rm } = await import('fs/promises');
          const { join: j } = await import('path');
          const { readdir: rd } = await import('fs/promises');
          try {
            await rm(j(projectPath, step.targetFile));
            const parentDir = j(projectPath, step.targetFile, '..');
            const remaining = await rd(parentDir).catch(() => []);
            if (remaining.length === 0) await rm(parentDir, { recursive: true }).catch(() => {});
            const { invalidateProjectMap } = await import('@/services/project-map');
            await invalidateProjectMap(projectPath);
            return NextResponse.json({ success: true, action: 'delete-file', file: step.targetFile });
          } catch (e) {
            return NextResponse.json({ success: false, error: String(e) });
          }
        }

        case 'install-package': {
          if (!step.packageName) return NextResponse.json({ success: false, error: 'Missing packageName' });
          const pkgPath = join(projectPath, 'package.json');
          const { readFile: rf, writeFile: wf } = await import('fs/promises');
          try {
            const pkg = JSON.parse(await rf(pkgPath, 'utf-8'));
            if (!pkg.dependencies) pkg.dependencies = {};
            if (!pkg.dependencies[step.packageName] && !pkg.devDependencies?.[step.packageName]) {
              pkg.dependencies[step.packageName] = 'latest';
              await wf(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
              await installDependencies(projectPath, ['--legacy-peer-deps']);
            }
            return NextResponse.json({ success: true, action: 'install-package', package: step.packageName });
          } catch (e) {
            return NextResponse.json({ success: false, error: String(e) });
          }
        }

        case 'deterministic': {
          const { runDeterministicRepairs } = await import('@/services/deterministic-repair');
          const result = await runDeterministicRepairs(projectPath, step.instruction, []);
          const { invalidateProjectMap } = await import('@/services/project-map');
          if (result.applied.length > 0) await invalidateProjectMap(projectPath);
          return NextResponse.json({
            success: result.applied.length > 0,
            action: 'deterministic',
            applied: result.applied,
            allFixed: result.allFixed,
            tsOutput: result.tsOutput,
          });
        }

        case 'targeted-ai':
        case 'architecture-ai': {
          // Return delegation instructions — the builder calls agent-fix directly,
          // which already contains all the model-calling and file-apply logic.
          const errorContext =
            `REPAIR PLAN STEP ${step.stepNumber}: ${step.title}\n\n` +
            `ROOT CAUSE IDENTIFIED BY ANALYSIS:\n${step.instruction}\n\n` +
            `EXPECTED OUTCOME: ${step.expectedOutcome}\n\n` +
            `Fix ONLY the target file. Do not modify unrelated files.`;

          return NextResponse.json({
            success: true,
            action: step.action,
            delegateToAgentFix: true,
            agentFixParams: {
              projectPath,
              errorContext,
              targetFiles: [step.targetFile],
              contextFiles: step.contextFiles,
              strategy: step.action === 'architecture-ai' ? 'broader' : 'targeted',
              tier: 'SONNET',
            },
          });
        }

        default:
          return NextResponse.json({ success: false, error: `Unhandled step action: ${step.action}` });
      }
    }

    // ── verify-repair: Multi-Level Verification Suite ─────────────────────────
    if (action === 'verify-repair') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const { runVerificationSuite } = await import('@/services/verification-suite');
      const maxLevel: 1 | 2 | 3 | 4 = body.maxLevel ?? 3;
      const result = await runVerificationSuite(projectPath, {
        maxLevel,
        port: body.port ?? null,
        skipL2: body.skipL2 ?? false,
      });

      // Extended verification: page 404 check + CSS health check
      // These run in parallel after the TypeScript/build suite
      let missingRoutes: string[] = [];
      let cssIssues: string[] = [];

      if (result.l1.passed) {
        await Promise.allSettled([
          // Page 404 check
          import('@/services/route-scanner').then(async ({ scanMissingRoutes }) => {
            const scan = await scanMissingRoutes(projectPath).catch(() => null);
            if (scan?.missingRoutes?.length) missingRoutes = scan.missingRoutes;
          }),
          // CSS health check
          import('@/services/css-health-check').then(async ({ checkCssHealth }) => {
            const css = await checkCssHealth(projectPath).catch(() => null);
            if (css && !css.healthy) cssIssues = css.issues.map((i: { title: string }) => i.title);
          }),
        ]);
      }

      const allPassed = result.allPassed && missingRoutes.length === 0 && cssIssues.length === 0;
      const extendedSummary = [
        result.summary,
        missingRoutes.length > 0 ? `Missing pages: ${missingRoutes.join(', ')}` : '',
        cssIssues.length > 0 ? `CSS issues: ${cssIssues.join('; ')}` : '',
      ].filter(Boolean).join(' | ');

      return NextResponse.json({
        success: true,
        result: { ...result, allPassed, summary: extendedSummary },
        missingRoutes,
        cssIssues,
      });
    }

    // ── coordinate-repair: unified Phase 1-3 repair coordinator ──────────────
    if (action === 'coordinate-repair') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const { coordinateRepair } = await import('@/services/repair-coordinator');
      const result = await coordinateRepair(projectPath, body.errorText ?? '', body.port ?? undefined);
      return NextResponse.json({ success: true, result });
    }

    // ── plan-feature: Feature Understanding Layer ─────────────────────────────
    if (action === 'plan-feature') {
      const { request: featureRequest = '' } = body;
      const { planFeature } = await import('@/services/feature-planner');
      const { getProjectMap } = await import('@/services/project-map');

      let map = null;
      if (projectPath) {
        map = await getProjectMap(projectPath).catch(() => null);
      }

      const plan = planFeature(featureRequest, map);
      return NextResponse.json({
        success: true,
        category: plan.category,
        hasSpec: plan.category !== 'unknown',
        specificationBlock: plan.specificationBlock,
        routeStructureNote: plan.routeStructureNote,
        checklist: plan.checklist,
        requiredPages: plan.requiredPages,
        requiredApiRoutes: plan.requiredApiRoutes,
        requiredDbTables: plan.requiredDbTables,
      });
    }

    // ── scan-missing-routes: find UI links that have no page.tsx ─────────────
    if (action === 'scan-missing-routes') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const { scanMissingRoutes, checkRouteReachability } = await import('@/services/route-scanner');
      const scanResult = await scanMissingRoutes(projectPath);

      let reachability = null;
      if (body.port && scanResult.referencedRoutes.length > 0) {
        reachability = await checkRouteReachability(body.port, scanResult.referencedRoutes);
      }

      return NextResponse.json({ success: true, scanResult, reachability });
    }

    // ── scan-and-repair-routes: fast deterministic routing fix, no Playwright needed ──
    // 1. scanMissingRoutes: compare nav links vs existing page files
    // 2. repairStaticRoutes: create redirect stubs for auth routes, plain stubs for others
    // 3. HTTP-check the newly created routes
    // Returns: missingRoutes, created files, redirected routes, stubbed routes, httpChecks
    if (action === 'scan-and-repair-routes') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const port = body.port as number | undefined;

      const { scanMissingRoutes, repairStaticRoutes, checkRouteReachability } = await import('@/services/route-scanner');

      const scanResult = await scanMissingRoutes(projectPath as string);
      let repairResult = { created: [] as string[], redirected: [] as string[], stubbed: [] as string[] };

      if (scanResult.missingRoutes.length > 0) {
        repairResult = await repairStaticRoutes(
          projectPath as string,
          scanResult.missingRoutes,
          scanResult.existingRoutes,
        );
      }

      // HTTP-check all referenced routes after repair (only if port given)
      let httpChecks: Array<{ route: string; statusCode: number; ok: boolean }> = [];
      if (port && scanResult.referencedRoutes.length > 0) {
        await new Promise(r => setTimeout(r, 2000)); // allow Next.js to hot-reload
        httpChecks = await checkRouteReachability(port, scanResult.referencedRoutes);
      }

      const stillBroken = httpChecks.filter(c => !c.ok).map(c => c.route);

      return NextResponse.json({
        success: true,
        scanned: scanResult.referencedRoutes.length,
        missing: scanResult.missingRoutes,
        existing: scanResult.existingRoutes,
        created: repairResult.created,
        redirected: repairResult.redirected,
        stubbed: repairResult.stubbed,
        httpChecks,
        stillBroken,
        allFixed: stillBroken.length === 0,
      });
    }

    // ── crawl-and-repair-links: Playwright click-through link verification ────
    // Opens every page, clicks every link and CTA button, detects 404s,
    // derives missing dynamic routes, creates them with AI, then re-crawls to confirm.
    // Returns a structured VerificationReport: Tested/Passed/Failed/Repaired/Status
    if (action === 'crawl-and-repair-links') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const port = body.port as number;
      if (!port) return NextResponse.json({ success: false, error: 'Missing port' }, { status: 400 });

      const { crawlLinks, buildVerificationReport } = await import('@/services/link-crawler');
      const { scanMissingRoutes, repairStaticRoutes } = await import('@/services/route-scanner');

      const baseUrl = `http://localhost:${port}`;
      const repairedRoutes: string[] = [];

      // ── Phase 0: deterministic static route repair (no AI, instant) ──────────
      // Handles /login → /auth, /signup → /auth, etc. before Playwright even starts.
      const preScan = await scanMissingRoutes(projectPath as string);
      if (preScan.missingRoutes.length > 0) {
        const staticRepair = await repairStaticRoutes(
          projectPath as string,
          preScan.missingRoutes,
          preScan.existingRoutes,
        );
        if (staticRepair.created.length > 0) {
          repairedRoutes.push(...staticRepair.created);
          // Let Next.js hot-reload before crawling
          await new Promise(r => setTimeout(r, 3000));
        }
      }

      // ── Phase 1: Crawl ────────────────────────────────────────────────────────
      const crawlReport = await crawlLinks(baseUrl, projectPath as string, {
        maxPages: body.maxPages ?? 15,
        maxLinksPerPage: body.maxLinksPerPage ?? 8,
        timeoutMs: 75_000,
      });

      // ── Phase 2: Also check source-level dynamic route gaps ───────────────────
      const scanResult = await scanMissingRoutes(projectPath as string);
      const allMissingFiles = [
        ...new Set([
          ...crawlReport.missingRouteFiles,
          ...scanResult.missingDynamicPageFiles,
          ...scanResult.missingRoutes.map(r => `app${r}/page.tsx`),
        ])
      ];

      // ── Phase 3: Auto-create missing pages with AI ────────────────────────────
      if (allMissingFiles.length > 0) {
        // Build context for AI: what the parent pages look like
        const parentContextFiles: string[] = [];
        for (const mf of allMissingFiles.slice(0, 4)) {
          // For app/property/[id]/page.tsx, read app/page.tsx for context
          const parentDir = mf.replace('/[id]/page.tsx', '').replace('/[slug]/page.tsx', '');
          try {
            const parentContent = await readFile(join(projectPath as string, parentDir + '/page.tsx'), 'utf-8');
            parentContextFiles.push(`=== ${parentDir}/page.tsx ===\n${parentContent.slice(0, 2000)}`);
          } catch { /* parent may not exist */ }
          try {
            // Also read the API route for this resource
            const apiDir = parentDir.replace('app/', 'app/api/');
            const apiContent = await readFile(join(projectPath as string, apiDir + '/route.ts'), 'utf-8');
            parentContextFiles.push(`=== ${apiDir}/route.ts ===\n${apiContent.slice(0, 2000)}`);
          } catch { /* skip */ }
        }

        // Search the web for Next.js dynamic route patterns if we have a key
        let webSearchContext = '';
        try {
          const { searchWeb, formatSearchResultsForPrompt } = await import('@/services/web-search');
          const searchRes = await searchWeb('Next.js 15 dynamic route page.tsx async params fetch data', 3);
          webSearchContext = formatSearchResultsForPrompt(searchRes);
        } catch { /* non-critical */ }

        const repairPrompt =
          `These dynamic route pages are missing and return 404 when users click internal links:\n\n` +
          allMissingFiles.map(f => `• ${f}`).join('\n') + '\n\n' +
          `For each missing file, create a complete Next.js page component that:\n` +
          `1. Reads the dynamic param (id or slug) from params\n` +
          `2. Fetches the resource from the corresponding API route (GET /api/...)\n` +
          `3. Renders a full detail view with all relevant fields\n` +
          `4. Shows a "not found" message if the resource doesn't exist\n` +
          `5. Has a Back button/link to return to the listing page\n\n` +
          `Parent page context:\n${parentContextFiles.join('\n\n')}\n\n` +
          `IMPORTANT: Use async params: \`export default async function Page({ params }: { params: Promise<{ id: string }> })\`\n` +
          `Await params: \`const { id } = await params\`\n` +
          (webSearchContext ? webSearchContext + '\n\n' : '') +
          `Use the standard file format:\n<file path="app/property/[id]/page.tsx">...content...</file>`;

        try {
          const aiResult = await editWithAI(repairPrompt, '', 'SONNET');
          const parsed = parseEditFormat(aiResult);
          if (parsed.length > 0) {
            await applyEditsToProject(projectPath as string, parsed);
            repairedRoutes.push(...parsed.map(f => f.path));
          }
        } catch { /* non-critical — report will show remaining errors */ }

        // ── Phase 4: Re-crawl after repair ─────────────────────────────────────
        if (repairedRoutes.length > 0) {
          // Allow Next.js hot-reload to pick up new pages
          await new Promise(r => setTimeout(r, 4000));

          const crawlReport2 = await crawlLinks(baseUrl, projectPath as string, {
            maxPages: 10,
            maxLinksPerPage: 8,
            timeoutMs: 45_000,
          });

          // Merge results: keep repaired in 'passed', update 'failed'
          crawlReport.passed.push(...crawlReport2.passed.filter(r =>
            repairedRoutes.some(rep => r.url.includes(rep.replace('app/', '').replace('/page.tsx', '')))
          ));
          crawlReport.failed = crawlReport2.failed; // post-repair truth
          crawlReport.verdict = crawlReport2.verdict;
          crawlReport.summary = crawlReport2.summary;
        }
      }

      // ── Phase 5: Build structured verification report ─────────────────────────
      const verificationReport = buildVerificationReport(crawlReport, repairedRoutes);

      // Store successful dynamic route repairs in engineering memory
      if (repairedRoutes.length > 0 && crawlReport.verdict === 'PASSED') {
        const { learnFromRepair } = await import('@/services/repair-learner');
        const callAI = async (p: string, tier: 'HAIKU' | 'SONNET'): Promise<string> =>
          fixErrorsWithAI(p, '', tier);
        learnFromRepair({
          errorText: `Dynamic routes returned 404: ${allMissingFiles.join(', ')}`,
          changedFiles: repairedRoutes,
          userMessage: 'Link crawler detected missing dynamic route pages',
          successfulTier: 'SONNET',
          projectPath: projectPath as string,
          fixSummary: `Created ${repairedRoutes.length} missing dynamic page(s): ${repairedRoutes.join(', ')}`,
        }, callAI).catch(() => {});
      }

      return NextResponse.json({
        success: true,
        crawlReport,
        verificationReport,
        repairedRoutes,
        allMissingFiles,
      });
    }

    // ── create-missing-pages: write stubs + queue AI enhancement ─────────────
    if (action === 'create-missing-pages') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const missingRoutes: string[] = body.missingRoutes ?? [];
      const missingDetails: Array<{ route: string; sourceFile: string; context: string }> = body.missingDetails ?? [];
      const routeGroups: string[] = body.routeGroups ?? [];

      if (!missingRoutes.length) return NextResponse.json({ success: true, created: [] });

      const { readFile, writeFile, mkdir } = await import('fs/promises');
      const pathMod = await import('path');
      const appDir = pathMod.join(projectPath, 'app');

      // Read an existing page for style reference
      let styleExample = '';
      for (const candidate of ['page.tsx', '(auth)/login/page.tsx', 'login/page.tsx', '(auth)/signin/page.tsx']) {
        try { styleExample = await readFile(pathMod.join(appDir, candidate), 'utf-8'); if (styleExample.length > 200) break; }
        catch { /* try next */ }
      }

      const { bestPagePath, generatePageStub } = await import('@/services/route-scanner');
      const created: string[] = [];
      const fileInstructions: Array<{ route: string; pagePath: string }> = [];

      for (const route of missingRoutes) {
        const pagePath = bestPagePath(route, routeGroups, appDir);
        const relPath = pagePath.replace(projectPath + pathMod.sep, '').replace(projectPath + '/', '');
        fileInstructions.push({ route, pagePath: relPath });
        try {
          await mkdir(pathMod.dirname(pagePath), { recursive: true });
          // Only write if file does not already exist
          try { await readFile(pagePath, 'utf-8'); /* exists — skip */ }
          catch {
            await writeFile(pagePath, generatePageStub(route, styleExample), 'utf-8');
            created.push(relPath);
          }
        } catch { /* skip on error */ }
      }

      // Build the agent enhancement prompt (caller will use this for agent-fix)
      const missingList = missingRoutes.map((r, i) => {
        const detail = missingDetails[i];
        return `  • ${r}  →  file: ${fileInstructions[i]?.pagePath}  (referenced in ${detail?.sourceFile ?? 'unknown'}: \`${detail?.context ?? r}\`)`;
      }).join('\n');

      const routeGroupNote = routeGroups.length > 0
        ? `Route groups present: ${routeGroups.map(g => `app/${g}/`).join(', ')}. Auth pages go in the (auth) group.`
        : 'No route groups — pages are at top-level app/[route]/page.tsx.';

      const agentPrompt =
        `The UI has navigation links that return 404. Page stub files have been written — now replace each stub with a REAL functional page.\n\n` +
        `Pages to create (stubs already written, now make them real):\n${missingList}\n\n` +
        `${routeGroupNote}\n\n` +
        `Style reference (existing page):\n\`\`\`tsx\n${styleExample.slice(0, 1000)}\n\`\`\`\n\n` +
        `Rules:\n` +
        `• Login/signin: form with email + password fields, submit button, link to signup and forgot-password\n` +
        `• Signup/register: form with name + email + password + confirm-password, submit button, link to login\n` +
        `• Forgot-password: form with email field, submit button, link back to login\n` +
        `• Dashboard: welcome header, navigation cards/grid, recent activity section\n` +
        `• Listings/browse: search bar, filter sidebar, grid of listing cards\n` +
        `• Post-listing/create-listing: multi-field form matching the project domain\n` +
        `• Profile/settings: user info form with save button\n` +
        `• Any other page: real content matching the project's purpose — NOT placeholder text\n` +
        `• Use the same Tailwind classes and component patterns as the style reference\n` +
        `• Add 'use client' when using onClick, useState, useEffect, useRouter\n` +
        `• Use next/link for internal navigation\n` +
        `• Do NOT import components that don't exist yet\n` +
        `• Every page must have a default export\n\n` +
        `Rewrite ALL ${created.length} stub files now with full working content.`;

      return NextResponse.json({ success: true, created, agentPrompt, fileInstructions, needsAgentEnhancement: true });
    }

    // ── inspect-preview: Preview Verification Engine ──────────────────────────
    if (action === 'inspect-preview') {
      const { port: previewPort } = body;
      if (!projectPath || !previewPort) {
        return NextResponse.json({ success: false, error: 'Missing projectPath or port' }, { status: 400 });
      }
      const { inspectPreview } = await import('@/services/preview-inspector');
      const result = await inspectPreview(previewPort, projectPath);
      return NextResponse.json({ success: true, result });
    }

    // ── check-css-health: CSS/Tailwind health check + auto-fix ────────────────
    if (action === 'check-css-health') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const { checkCssHealth, fixCssIssues } = await import('@/services/css-health-check');
      const health = await checkCssHealth(projectPath);

      if (!health.healthy && body.autoFix) {
        const fixResult = await fixCssIssues(projectPath, health);
        // Re-check after fix
        const recheck = await checkCssHealth(projectPath);
        return NextResponse.json({ success: true, health: recheck, fixResult, wasFixed: fixResult.fixed.length > 0 });
      }

      return NextResponse.json({ success: true, health });
    }

    // ── investigate: root cause investigation BEFORE any fix ─────────────────
    if (action === 'investigate') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });

      const { port } = body;
      const report = await investigateRootCause({ projectPath, port: port ?? undefined });
      const formatted = formatRootCauseReport(report);

      return NextResponse.json({
        success: true,
        report,
        formatted,
        primaryLayer: report.primaryLayer,
        confidence: report.confidence,
        canAutoFix: report.canAutoFix,
        missingCredentials: report.missingCredentials,
        placeholderEnvVars: report.placeholderEnvVars,
        recommendedActions: report.recommendedActions,
        findings: report.findings,
      });
    }

    // ── escalation-write: package all failure context and write to projectPath/.dwomoh/ ──
    if (action === 'escalation-write') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const { writeEscalationPackage } = await import('@/services/escalation-engine');
      const result = await writeEscalationPackage(projectPath, {
        projectName:      (body.projectName as string)    ?? 'Unknown project',
        port:             (body.port as number | undefined),
        userMessage:      (body.userMessage as string)    ?? '',
        failingRoutes:    (body.failingRoutes as string[])    ?? [],
        typescriptErrors: (body.typescriptErrors as string[]) ?? [],
        consoleErrors:    (body.consoleErrors as string[])    ?? [],
        networkErrors:    (body.networkErrors as string[])    ?? [],
        buildErrors:      (body.buildErrors as string[])      ?? [],
        playwrightResults:(body.playwrightResults as [])      ?? [],
        failureScreenshot:(body.failureScreenshot as string | undefined),
        allScreenshots:   (body.allScreenshots as string[])   ?? [],
        repairHistory:    (body.repairHistory as [])          ?? [],
      });
      // Also try to open VS Code with the project — non-fatal if VS Code isn't in PATH
      try {
        const { exec } = await import('child_process');
        exec(`code "${projectPath}"`);
      } catch { /* VS Code may not be in PATH — user can open manually */ }
      return NextResponse.json({ success: true, id: result.id, filePath: result.filePath });
    }

    // ── escalation-check: poll for a resolution written by VS Code + Claude Code ──
    if (action === 'escalation-check') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const { checkEscalationResolution } = await import('@/services/escalation-engine');
      const resolution = await checkEscalationResolution(projectPath);
      return NextResponse.json({ success: true, resolution });
    }

    // ── save-repair-pattern: store a repair learned from Claude Code escalation ──
    if (action === 'save-repair-pattern') {
      try {
        const { saveRepairSuccess } = await import('@/services/engineering-memory');
        await saveRepairSuccess({
          errorPattern:    (body.errorPattern as string)    ?? '',
          rootCause:       (body.rootCause as string)       ?? '',
          fixApproach:     (body.fixApproach as string)     ?? '',
          targetFiles:     (body.targetFiles as string[])   ?? [],
          tsErrorsToAvoid: [],
          successfulTier:  (body.successfulTier as 'HAIKU' | 'SONNET' | 'STRONGEST') ?? 'STRONGEST',
        });
      } catch { /* non-critical */ }
      return NextResponse.json({ success: true });
    }

    // ── run-generation-verifier: 18-point post-generation completion gate ────────
    // Runs all 5 verification phases (TypeScript, route map, API health, browser
    // journey, deep interactive crawl) in a repair loop. Returns canComplete:true
    // only when every check passes. Called automatically after every generation.
    if (action === 'run-generation-verifier') {
      if (!projectPath) return NextResponse.json({ error: 'Missing projectPath' }, { status: 400 });
      const port = body.port as number;
      if (!port) return NextResponse.json({ error: 'Missing port' }, { status: 400 });

      const progressLines: string[] = [];
      const onProgress = (msg: string) => { progressLines.push(msg); };

      try {
        const { runGenerationVerifier, saveVerifierResult } = await import('@/services/generation-verifier');
        const result = await runGenerationVerifier(projectPath, port, onProgress);
        await saveVerifierResult(result, projectPath);

        return NextResponse.json({
          success: true,
          canComplete: result.canComplete,
          rounds: result.rounds,
          phases: result.phases,
          totalChecks: result.totalChecks,
          passedChecks: result.passedChecks,
          failedChecks: result.failedChecks,
          repairedTotal: result.repairedTotal,
          repairLog: result.repairLog,
          summary: result.summary,
          failureReason: result.failureReason,
          progressLog: progressLines,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return NextResponse.json({
          success: false,
          canComplete: false,
          error: msg,
          progressLog: progressLines,
        }, { status: 500 });
      }
    }

    // ── escalation-clear: remove escalation files after resolution is applied ──
    if (action === 'escalation-clear') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const { clearEscalation } = await import('@/services/escalation-engine');
      await clearEscalation(projectPath);
      return NextResponse.json({ success: true });
    }

    // ══════════════════════════════════════════════════════════════════════════
    // FLUTTER BUILD PIPELINE — completely isolated from the web pipeline above
    // These actions are only called from runFlutterBuildPipeline() in the UI.
    // They never touch Next.js projects, npm, or the web generation chain.
    // ══════════════════════════════════════════════════════════════════════════

    // ── generate-flutter: AI generation → write Dart files → flutter pub get ──
    if (action === 'generate-flutter') {
      const turns: ConversationTurn[] = Array.isArray(messages) ? messages : [];
      const stringTurns = turns.map(t => ({
        role: t.role,
        content: typeof t.content === 'string' ? t.content : '[image attached]',
      }));

      const { FLUTTER_BUILD_SYSTEM_PROMPT, buildFlutterPromptFromConversation } = await import('@/lib/flutter-prompt-engineer');
      const { parseFlutterProjectFormat, generateFlutterProject, buildFlutterScaffold } = await import('@/services/flutter-generator');
      const { runFlutterPubGet } = await import('@/services/flutter-builder');

      const userMessage = buildFlutterPromptFromConversation(stringTurns);
      if (!userMessage) {
        return NextResponse.json({ success: false, error: 'No prompt provided for Flutter generation' }, { status: 400 });
      }

      const logs: string[] = [];
      let projectData = null;
      let isScaffold  = false;

      // Generation with fallback to scaffold on parse failure
      try {
        const tier: import('@/services/bedrock').BedrockTier = (body.tier as import('@/services/bedrock').BedrockTier) ?? 'SONNET';
        const aiText = await buildWithAI(userMessage, FLUTTER_BUILD_SYSTEM_PROMPT, tier);
        projectData = parseFlutterProjectFormat(aiText);

        if (!projectData) {
          // AI output couldn't be parsed — use scaffold
          logs.push('⚠️ Could not parse AI output — using scaffold fallback');
          const name = stringTurns.filter(t => t.role === 'user').map(t => t.content).join(' ').slice(0, 40).replace(/\W+/g, '-').toLowerCase();
          projectData = buildFlutterScaffold(name || 'my-app', 'Generated Flutter app');
          isScaffold  = true;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ success: false, error: `Flutter AI generation failed: ${msg}` }, { status: 500 });
      }

      // Write files to disk
      const genResult = await generateFlutterProject(projectData, (msg) => logs.push(msg));
      logs.push(`✅ Wrote ${genResult.filesWritten} file(s) to ${genResult.projectPath}`);

      // flutter pub get
      const pubGetResult = await runFlutterPubGet(genResult.projectPath);
      logs.push(...pubGetResult.logs);

      return NextResponse.json({
        success: true,
        projectPath:  genResult.projectPath,
        projectName:  projectData.projectName,
        description:  projectData.description,
        filesWritten: genResult.filesWritten,
        pubGetSuccess: pubGetResult.success,
        pubGetErrors:  pubGetResult.errors,
        isScaffold,
        logs,
      });
    }

    // ── flutter-analyze: run flutter analyze on a project ────────────────────
    if (action === 'flutter-analyze') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const { runFlutterAnalyze } = await import('@/services/flutter-builder');
      const result = await runFlutterAnalyze(projectPath);
      return NextResponse.json({ success: true, ...result });
    }

    // ── flutter-build-apk: start background APK build, return jobId ──────────
    if (action === 'flutter-build-apk') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const { startFlutterApkBuild } = await import('@/services/flutter-builder');
      const jobId = await startFlutterApkBuild(projectPath);
      return NextResponse.json({ success: true, jobId });
    }

    // ── flutter-build-status: poll APK build state ────────────────────────────
    if (action === 'flutter-build-status') {
      const { readFlutterBuildState } = await import('@/services/flutter-builder');
      const state = await readFlutterBuildState();
      if (!state) return NextResponse.json({ success: false, error: 'No active Flutter build' });
      return NextResponse.json({ success: true, ...state });
    }

    // ── flutter-verify: quick verification of a Flutter project ──────────────
    if (action === 'flutter-verify') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const { verifyFlutterProject } = await import('@/services/flutter-verifier');
      const runAnalyze = body.runAnalyze !== false;
      const result = await verifyFlutterProject(projectPath, runAnalyze);
      return NextResponse.json({ success: true, ...result });
    }

    // ── verify-flutter-runtime: install APK on connected device + capture logcat ─
    if (action === 'verify-flutter-runtime') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const { verifyFlutterRuntime } = await import('@/services/flutter-verifier');
      const result = await verifyFlutterRuntime(projectPath);
      return NextResponse.json({ success: true, ...result });
    }

    // ── verify-auth-pages: check Sign In, Sign Up, Forgot Password load correctly ─
    if (action === 'verify-auth-pages') {
      const baseUrl = body.baseUrl ?? 'http://localhost:3000';
      const { verifyAuthPages } = await import('@/services/auth-verifier');
      const result = await verifyAuthPages(baseUrl);
      return NextResponse.json({ success: true, ...result });
    }

    return NextResponse.json({ success: false, error: `Unknown action: ${action}` }, { status: 400 });

  } catch (error) {
    const errorInfo = handleError(error);
    return NextResponse.json(
      { success: false, error: errorInfo.message, code: errorInfo.code },
      { status: errorInfo.statusCode }
    );
  }
}
