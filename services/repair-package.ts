/**
 * Repair Package
 *
 * A structured diagnosis object created whenever a browser journey step fails.
 * Contains everything the repair engine needs to fix the issue without AI guessing:
 *   - What failed (step name, failure detail)
 *   - Screenshot of the browser at the failure point
 *   - Console errors captured by Playwright
 *   - Failed network requests (which API routes returned 4xx/5xx)
 *   - Suspected root cause (from flow tracer)
 *   - Affected source files (from failed network requests → route file path)
 *   - Suggested fix (from flow tracer)
 *
 * The repair engine converts this into a highly targeted agent-fix prompt,
 * then re-runs the exact failed journey step to verify the repair.
 */

export interface RepairAttempt {
  /** Which AI tier was used */
  tier: 'HAIKU' | 'SONNET' | 'STRONGEST' | 'AUTO';
  /** Files that were modified */
  filesChanged: string[];
  /** Verdict from the re-run journey AFTER this repair attempt */
  resultVerdict: 'PASSED' | 'FAILED VERIFICATION' | 'not-run';
  /** Error message if the repair itself threw */
  error?: string;
  /** Unix timestamp of this attempt */
  attemptedAt: string;
}

export interface RepairPackage {
  verdict: 'FAILED VERIFICATION';
  /** Journey type: marketplace / booking / social / generic */
  projectType: string;
  /** Name of the journey (e.g. "Marketplace Browser Journey") */
  journeyName: string;
  /** The journey step that failed */
  failedStep: string;
  /** Human-readable failure detail (includes error + console + network context) */
  failureDetail: string;
  /** Path to the failure screenshot (served from /public) */
  screenshotPath?: string;
  /** Console errors captured by Playwright across all journey steps */
  consoleErrors: string[];
  /** API requests that returned 4xx/5xx during any journey step */
  failedNetworkRequests: Array<{ url: string; status: number }>;
  /** Derived from flow tracer — the layer that is broken */
  suspectedRootCause?: string;
  /** Derived from flow tracer — file to edit */
  affectedFiles: string[];
  /** Derived from flow tracer — what to change */
  suggestedFix?: string;
  /** All repair attempts made for this package (populated as repair runs) */
  repairAttempts: RepairAttempt[];
  /** When this package was created */
  createdAt: string;
}

/**
 * Build a repair package from a browser journey failure result.
 * Optionally enriched with flow trace results.
 */
export function buildRepairPackage(
  journeyResult: {
    projectType: string;
    journeyName: string;
    failedAt?: string;
    failureDetail?: string;
    failureScreenshotPath?: string;
    steps: Array<{
      step: string;
      consoleErrors: string[];
      failedRequests: Array<{ url: string; status: number }>;
    }>;
  },
  flowTrace?: {
    fixFile?: string;
    fixHint?: string;
    diagnosis?: string;
  },
): RepairPackage {
  // Collect all console errors and failed requests from all steps, not just the failing one
  const allConsoleErrors = journeyResult.steps.flatMap(s => s.consoleErrors ?? []);
  const allFailedRequests = journeyResult.steps.flatMap(s => s.failedRequests ?? []);

  // Derive affected files from failed network requests (url path → route file)
  const derivedFiles: string[] = [];
  for (const req of allFailedRequests) {
    try {
      const urlPath = new URL(req.url).pathname;
      if (urlPath.startsWith('/api/')) {
        // /api/listings → app/api/listings/route.ts
        const routeFile = `app/api${urlPath}/route.ts`.replace(/\/+/g, '/');
        derivedFiles.push(routeFile);
      }
    } catch { /* non-critical */ }
  }

  if (flowTrace?.fixFile) derivedFiles.push(flowTrace.fixFile);

  return {
    verdict: 'FAILED VERIFICATION',
    projectType: journeyResult.projectType,
    journeyName: journeyResult.journeyName,
    failedStep: journeyResult.failedAt ?? 'unknown step',
    failureDetail: journeyResult.failureDetail ?? 'step failed without detail',
    screenshotPath: journeyResult.failureScreenshotPath,
    consoleErrors: [...new Set(allConsoleErrors)].slice(0, 10),
    failedNetworkRequests: allFailedRequests.slice(0, 10),
    suspectedRootCause: flowTrace?.diagnosis,
    affectedFiles: [...new Set(derivedFiles)],
    suggestedFix: flowTrace?.fixHint,
    repairAttempts: [],
    createdAt: new Date().toISOString(),
  };
}

/**
 * Format the repair package as an agent-fix prompt section.
 * This is injected as the error context so the AI has everything it needs.
 */
export function formatRepairPackageForPrompt(pkg: RepairPackage): string {
  const lines: string[] = [
    `=== FAILED VERIFICATION REPAIR PACKAGE ===`,
    `Journey: ${pkg.journeyName}`,
    `Failed Step: ${pkg.failedStep}`,
    `Detail: ${pkg.failureDetail}`,
    '',
  ];

  if (pkg.suspectedRootCause) {
    lines.push(`Suspected Root Cause: ${pkg.suspectedRootCause}`);
  }

  if (pkg.suggestedFix) {
    lines.push(`Suggested Fix: ${pkg.suggestedFix}`);
  }

  if (pkg.affectedFiles.length > 0) {
    lines.push(`Affected Files: ${pkg.affectedFiles.join(', ')}`);
  }

  if (pkg.failedNetworkRequests.length > 0) {
    lines.push('', 'Failed API Requests (these routes returned errors during the user flow):');
    for (const req of pkg.failedNetworkRequests) {
      lines.push(`  ${req.status} ${req.url}`);
    }
  }

  if (pkg.consoleErrors.length > 0) {
    lines.push('', 'Browser Console Errors:');
    for (const err of pkg.consoleErrors.slice(0, 5)) {
      lines.push(`  ERROR: ${err}`);
    }
  }

  if (pkg.screenshotPath) {
    lines.push('', `Screenshot: ${pkg.screenshotPath} (browser state at time of failure)`);
  }

  lines.push('', '=== END REPAIR PACKAGE ===');
  lines.push('', 'TASK: Fix the root cause so the browser journey can complete the failed step.');
  lines.push('Do NOT rewrite working pages. Fix ONLY what caused the verification to fail.');

  return lines.join('\n');
}
