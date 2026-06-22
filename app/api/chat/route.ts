export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { parseProjectFormat } from '@/lib/json-parser';
import { converseWithEngineer, buildWithAI, fixErrorsWithAI, editWithAI, analyzeImageWithAI, generateLogoWithAI, ConversationTurn } from '@/services/bedrock';
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

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    const { action, messages, prompt, projectPath, projectId } = body;

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
      const scopeConstraint: { layer?: string; allowedPrefixes?: string[]; blockedPrefixes?: string[] } =
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

      // Build full edit context, including files mentioned in the auto-detected errors
      const contextMessage = await buildEditContext({ discovery, userRequest: enrichedRequest, mem, extraFiles: autoErrorFiles });

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
          'If the fix requires changing files outside the scope, explain why and ask first.',
          'NEVER touch unrelated files to fix a scoped issue.',
        ].filter(Boolean).join('\n');
        effectiveSystemPrompt = EDITOR_SYSTEM_PROMPT + scopeBlock;
      }

      // Call AI in edit mode
      const aiResponse = await editWithAI(contextMessage, effectiveSystemPrompt);

      // Parse the [EDIT_START]...[EDIT_END] format
      let editedFiles = parseEditFormat(aiResponse);

      if (editedFiles.length === 0) {
        return NextResponse.json({ success: true, filesChanged: [], response: aiResponse, conversational: true });
      }

      // ── Scope filter: drop any AI-generated changes that violate scope ─────────
      if (scopeConstraint.allowedPrefixes?.length) {
        const before = editedFiles.length;
        editedFiles = editedFiles.filter(f =>
          scopeConstraint.allowedPrefixes!.some(prefix => f.path.startsWith(prefix))
        );
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
      let apiPromptInstructions = '';
      let apiPlanRoutes: import('@/services/api-manager/generator').GeneratedRoute[] = [];
      let apiPlanMissingCategories: string[] = [];
      let apiPlanResolved: Array<{ category: string; host: string; providerName: string; providerId: string }> = [];
      const projectId = buildUserMessage.slice(0, 40).replace(/\W+/g, '-').toLowerCase() + `-${Date.now()}`;
      try {
        const { apiManager } = await import('@/services/api-manager/index');
        const plan = await apiManager.planForPrompt(buildUserMessage, projectId);
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

      const buildStrategies: Array<() => string> = [
        () => buildUserMessage + apiSuffix,

        () => `${buildUserMessage}${apiSuffix}

⚠️ REQUIRED OUTPUT FORMAT — DO NOT SKIP:
Your response MUST begin with [START_PROJECT] on its own line and end with [END_PROJECT].
Include AT MINIMUM: package.json and app/page.tsx.
Do NOT reply conversationally. Output the project files IMMEDIATELY.`,

        () => `Build a minimal but fully working MVP for: ${shortDesc}
${apiSuffix}
Keep it simple — 5 to 8 files total. Required files:
1. package.json
2. next.config.ts
3. app/layout.tsx
4. app/page.tsx  ← main homepage with real UI and functionality
5. app/globals.css
6. At least one API route under app/api/

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

      for (let attempt = 0; attempt < buildStrategies.length; attempt++) {
        try {
          const strategyPrompt = buildStrategies[attempt]();
          // buildWithAI now uses BEDROCK_FALLBACK_CHAINS internally — if the primary
          // model for generateTier is unavailable it automatically tries the next one
          // in the chain (e.g. Sonnet 4.6 → Sonnet 4.5 → Haiku) without any manual retry.
          const aiResponse = await buildWithAI(strategyPrompt, BUILD_SYSTEM_PROMPT, generateTier);
          const parsed = parseProjectFormat(aiResponse);

          if (parsed && parsed.files.length > 0 && hasRequiredFiles(parsed)) {
            projectData = parsed;
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
        // Surface API plan status to the builder for user messaging
        apiPlan: {
          resolved: apiPlanResolved,
          missing: apiPlanMissingCategories,
          rapidApiConfigured: apiPlanResolved.length > 0 || apiPlanMissingCategories.length === 0,
        },
      });
    }

    // ── create: write generated files to disk ──────────────────────────────────
    if (action === 'create') {
      const projectData = prompt;
      if (!projectData?.projectName || !Array.isArray(projectData.files)) {
        return NextResponse.json({ success: false, error: 'Invalid project data' }, { status: 400 });
      }

      const createAuthUser = await getAuthUser(request);
      const ownerUserId = createAuthUser?.sub ?? 'anonymous';

      const result = await generateProject(projectData.projectName, projectData.files);

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
      }
      return NextResponse.json({ ...result, projectPath });
    }

    // ── get-server-logs: return captured Next.js dev output ───────────────────
    if (action === 'get-server-logs') {
      if (!projectPath) return NextResponse.json({ success: false, error: 'Missing projectPath' }, { status: 400 });
      const logs = await getServerLogs(projectPath);
      return NextResponse.json({ success: true, logs: logs.slice(-4000) });
    }

    // ── list-projects: return projects owned by the authenticated user ────────
    if (action === 'list-projects') {
      const authUser = await getAuthUser(request);
      if (!authUser) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
      const projects = await listProjects(authUser.sub);
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
      const { port } = body;
      if (!port) return NextResponse.json({ success: false, error: 'Missing port' }, { status: 400 });

      let apiRoutes: string[] = [];
      if (projectPath) {
        try {
          const disc = await discoverProject(projectPath);
          apiRoutes = disc.apiRoutes;
        } catch { /* non-critical — verify main page even without discovery */ }
      }

      const result = await verifyRunningApp(port as number, apiRoutes, projectPath as string | undefined);

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
      let filesWritten = 0;
      const written: string[] = [];
      const errors: string[] = [];
      for (const f of genFiles) {
        if (!f.path || f.content === undefined) continue;
        if (f.path.startsWith('lib/managed/')) continue; // never overwrite managed services
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
      return NextResponse.json({ success: true, filesWritten, written, errors });
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
      // strategy: 'targeted' = minimum change, 'broader' = more context, 'rewrite' = full file rewrite
      const strategy: 'targeted' | 'broader' | 'rewrite' = body.strategy || 'targeted';
      // tier: explicit model override — caller drives escalation (HAIKU → SONNET → STRONGEST)
      // Falls back to strategy-based selection when not provided.
      const explicitTier: import('@/lib/constants').BedrockTier | undefined =
        body.tier && ['HAIKU', 'SONNET', 'STRONGEST'].includes(body.tier) ? body.tier : undefined;

      // ── Build file context ─────────────────────────────────────────────────
      const fileContexts: string[] = [];
      const extraContextFiles: string[] = [];

      // Primary target files
      for (const relPath of targetFiles.slice(0, 6)) {
        try {
          const content = await readFile(join(projectPath, relPath), 'utf-8');
          fileContexts.push(`=== ${relPath} ===\n${content.slice(0, 4000)}`);
        } catch {
          fileContexts.push(`=== ${relPath} === (FILE NOT FOUND — needs to be created)`);
        }
      }

      // 'broader' strategy: also include adjacent context files
      if (strategy === 'broader' || strategy === 'rewrite') {
        // lib/managed/db.ts — always useful for DB errors
        try {
          const dbTs = await readFile(join(projectPath, 'lib/managed/db.ts'), 'utf-8');
          extraContextFiles.push(`=== lib/managed/db.ts (database API) ===\n${dbTs.slice(0, 2000)}`);
        } catch {}
        // lib/managed/auth.ts — always useful for auth errors
        try {
          const authTs = await readFile(join(projectPath, 'lib/managed/auth.ts'), 'utf-8');
          extraContextFiles.push(`=== lib/managed/auth.ts (auth API) ===\n${authTs.slice(0, 2000)}`);
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

      // ── Build the fix prompt based on strategy ─────────────────────────────
      const relevantLogs = serverLogs
        ? serverLogs.split('\n').filter(l => /error|failed|cannot find|syntax|warning/i.test(l)).slice(-20).join('\n')
        : '(none)';

      let fixPrompt: string;

      if (strategy === 'rewrite') {
        fixPrompt = `FULL REWRITE TASK — Previous targeted fixes failed. Rewrite the broken files completely.

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
5. For auth errors: use import { verifyToken } from '@/lib/managed/auth'
6. For timeout errors: add AbortController(5000) to any fetch() inside the handler
7. Output ALL changed files — complete content, no truncation.
8. Format: [EDIT_START] [FILE: path] <content> [EDIT_END]`;
      } else if (strategy === 'broader') {
        fixPrompt = `AUTONOMOUS AGENT FIX — Broader context repair attempt.

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
        // targeted (default)
        fixPrompt = `AUTONOMOUS AGENT FIX — Minimum targeted changes.

ERRORS DETECTED:
${errorContext || '(see logs below)'}

SERVER LOGS:
${relevantLogs}

TYPESCRIPT ERRORS:
${tsErrors || '(none)'}

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
        explicitTier ?? ((strategy === 'broader' || strategy === 'rewrite') ? 'STRONGEST' : 'SONNET');
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

    return NextResponse.json({ success: false, error: `Unknown action: ${action}` }, { status: 400 });

  } catch (error) {
    const errorInfo = handleError(error);
    return NextResponse.json(
      { success: false, error: errorInfo.message, code: errorInfo.code },
      { status: errorInfo.statusCode }
    );
  }
}
