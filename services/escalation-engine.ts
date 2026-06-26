/**
 * Escalation engine — packages all context when DWOMOH repair exhausts all tiers
 * and prepares a handoff to VS Code + Claude Code for deeper repair.
 */
import { mkdir, writeFile, readFile, unlink } from 'fs/promises';
import { join } from 'path';

export interface EscalationRepairRound {
  tier: string;
  strategy: string;
  filesChanged: string[];
  resultSummary: string;
}

export interface EscalationPlaywrightStep {
  step: string;
  passed: boolean;
  error?: string;
  screenshotUrl?: string;
}

export interface EscalationResolution {
  status: 'resolved' | 'failed';
  resolvedAt: string;
  resolvedBy: string;
  fixSummary: string;
  filesChanged: string[];
  verificationPassed: boolean;
  buildErrors: string[];
  notes?: string;
}

export interface EscalationPackage {
  version: '1';
  id: string;
  timestamp: string;
  status: 'pending' | 'resolved' | 'failed';
  project: {
    name: string;
    path: string;
    port?: number;
  };
  request: {
    userMessage: string;
  };
  failures: {
    failingRoutes: string[];
    typescriptErrors: string[];
    consoleErrors: string[];
    networkErrors: string[];
    buildErrors: string[];
  };
  playwrightResults: EscalationPlaywrightStep[];
  screenshots: {
    failureScreenshot?: string;
    allScreenshots: string[];
  };
  repairHistory: EscalationRepairRound[];
  resolution?: EscalationResolution;
}

export async function writeEscalationPackage(
  projectPath: string,
  data: {
    projectName: string;
    port?: number;
    userMessage: string;
    failingRoutes: string[];
    typescriptErrors: string[];
    consoleErrors: string[];
    networkErrors: string[];
    buildErrors: string[];
    playwrightResults: EscalationPlaywrightStep[];
    failureScreenshot?: string;
    allScreenshots: string[];
    repairHistory: EscalationRepairRound[];
  }
): Promise<{ id: string; filePath: string }> {
  const id = `esc-${Date.now()}`;
  const timestamp = new Date().toISOString();

  const pkg: EscalationPackage = {
    version: '1',
    id,
    timestamp,
    status: 'pending',
    project: {
      name: data.projectName,
      path: projectPath,
      port: data.port,
    },
    request: {
      userMessage: data.userMessage,
    },
    failures: {
      failingRoutes: data.failingRoutes,
      typescriptErrors: data.typescriptErrors,
      consoleErrors: data.consoleErrors,
      networkErrors: data.networkErrors,
      buildErrors: data.buildErrors,
    },
    playwrightResults: data.playwrightResults,
    screenshots: {
      failureScreenshot: data.failureScreenshot,
      allScreenshots: data.allScreenshots,
    },
    repairHistory: data.repairHistory,
  };

  const dir = join(projectPath, '.dwomoh');
  await mkdir(dir, { recursive: true });

  // Clear any previous resolution before writing new escalation
  await unlink(join(dir, 'escalation-resolved.json')).catch(() => {});

  const filePath = join(dir, 'escalation.json');
  await writeFile(filePath, JSON.stringify(pkg, null, 2), 'utf-8');

  // Write the Claude Code command so it's available immediately when VS Code opens
  const claudeDir = join(projectPath, '.claude', 'commands');
  await mkdir(claudeDir, { recursive: true });
  await writeFile(
    join(claudeDir, 'repair-escalation.md'),
    buildClaudeCodeCommand(pkg),
    'utf-8'
  );

  // Write a CLAUDE.md that surfaces the escalation immediately when Claude Code starts
  await writeFile(
    join(projectPath, 'CLAUDE.md'),
    buildClaudeMd(pkg),
    'utf-8'
  );

  return { id, filePath };
}

export async function checkEscalationResolution(
  projectPath: string
): Promise<EscalationResolution | null> {
  const filePath = join(projectPath, '.dwomoh', 'escalation-resolved.json');
  try {
    const content = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    return parsed as EscalationResolution;
  } catch {
    return null;
  }
}

export async function clearEscalation(projectPath: string): Promise<void> {
  const dir = join(projectPath, '.dwomoh');
  await unlink(join(dir, 'escalation.json')).catch(() => {});
  await unlink(join(dir, 'escalation-resolved.json')).catch(() => {});
}

// ── VS Code / Claude Code integration files ───────────────────────────────────

function buildClaudeCodeCommand(pkg: EscalationPackage): string {
  return `---
description: Repair the DWOMOH Vibe Code escalation — read the failing project and fix it
---

# DWOMOH Vibe Code Repair Escalation

DWOMOH Vibe Code has exhausted all automated repair tiers and needs your help.

## What you must do

1. Read \`.dwomoh/escalation.json\` for the complete failure context.
2. Read the actual failing files listed under \`failures.failingRoutes\`.
3. Inspect the real source files — do not rely on the escalation summary alone.
4. Apply the fix directly to the files in this project.
5. Run \`npx tsc --noEmit\` and confirm zero errors.
6. Write the resolution to \`.dwomoh/escalation-resolved.json\`.

## Escalation summary (as of ${pkg.timestamp})

- **Project**: ${pkg.project.name}
- **User request**: ${pkg.request.userMessage}
- **Failing routes**: ${pkg.failures.failingRoutes.join(', ') || 'see escalation.json'}
- **TypeScript errors**: ${pkg.failures.typescriptErrors.length}
- **Repair rounds already attempted**: ${pkg.repairHistory.length}

## What DWOMOH already tried

${pkg.repairHistory.map((r, i) => `${i + 1}. ${r.tier} (${r.strategy}): ${r.resultSummary}`).join('\n') || 'No repair rounds recorded.'}

## Resolution file format

Write \`.dwomoh/escalation-resolved.json\` with exactly this shape:

\`\`\`json
{
  "status": "resolved",
  "resolvedAt": "<ISO timestamp>",
  "resolvedBy": "claude-code",
  "fixSummary": "<one sentence describing what you did>",
  "filesChanged": ["app/path/file.tsx"],
  "verificationPassed": true,
  "buildErrors": []
}
\`\`\`

If the issue cannot be resolved, write \`status: "failed"\` with \`notes\` explaining why.

**Important**: DWOMOH Vibe Code is polling for this file every 5 seconds. Once you write it, DWOMOH will automatically re-verify the running app and confirm the fix.
`;
}

function buildClaudeMd(pkg: EscalationPackage): string {
  return `# ${pkg.project.name}

This project was generated by DWOMOH Vibe Code and has been escalated for repair.

## Active escalation — read this first

DWOMOH Vibe Code could not automatically fix a problem after ${pkg.repairHistory.length} repair attempt(s). Full context is in \`.dwomoh/escalation.json\`.

**User request**: ${pkg.request.userMessage}

**Failing routes**: ${pkg.failures.failingRoutes.join(', ') || 'see .dwomoh/escalation.json'}

**TypeScript errors** (${pkg.failures.typescriptErrors.length}):
${pkg.failures.typescriptErrors.slice(0, 5).map(e => `- ${e}`).join('\n') || '- See .dwomoh/escalation.json'}

**What was already tried**:
${pkg.repairHistory.map((r, i) => `${i + 1}. ${r.tier} (${r.strategy}): ${r.resultSummary}`).join('\n') || 'None recorded.'}

## How to fix it

Run \`/repair-escalation\` to start the guided repair. Or inspect the files manually:
1. Read \`.dwomoh/escalation.json\`
2. Fix the failing routes
3. Run \`npx tsc --noEmit\`
4. Write \`.dwomoh/escalation-resolved.json\` when done

DWOMOH Vibe Code will pick up the resolution automatically.

## Project info

- **Port**: ${pkg.project.port ?? 'not running — start with: cd ${pkg.project.path} && npm run dev'}
- **Generated by**: DWOMOH Vibe Code
- **Escalated at**: ${pkg.timestamp}
`;
}
