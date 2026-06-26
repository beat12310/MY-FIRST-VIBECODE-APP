/**
 * Capability Registry
 *
 * Maps any error/context to the DWOMOH engine capability domain it belongs to.
 * Every bug report improves exactly one capability. This registry defines what
 * those capabilities are, how to detect them, and what their improvement looks like.
 *
 * When a repair succeeds, the learner calls classifyCapability() to determine
 * which engine subsystem learned something new.
 */

// ─── Capability definitions ────────────────────────────────────────────────────

export interface Capability {
  /** Internal identifier */
  id: string;
  /** User-facing name */
  name: string;
  /** What this engine does */
  description: string;
  /** What "improving" this capability means */
  improvementDescription: string;
  /** File(s) in the DWOMOH platform that implement this capability */
  engineFiles: string[];
  /** Regex patterns that identify errors belonging to this domain */
  errorSignals: RegExp[];
  /** File path signals (errors that touch these files) */
  fileSignals: RegExp[];
  /** Priority: higher = more likely to be selected when signals overlap */
  priority: number;
}

export const CAPABILITIES: Capability[] = [
  {
    id: 'auth-diagnosis',
    name: 'Auth Diagnosis Engine',
    description: 'Detects, repairs, and verifies authentication and session issues',
    improvementDescription: 'Auth issues will be auto-detected and repaired without manual intervention',
    engineFiles: ['services/root-cause-engine.ts', 'services/engineering-memory.ts'],
    errorSignals: [
      /login|signup|register|auth|token|session|jwt|password|credential|unauthorized|401|403/i,
      /getAuthUser|getCurrentUser|verifyToken|managed_token|JWT_SECRET|auth\.sub/i,
      /Property.*does not exist on type.*Promise.*Token/i,
    ],
    fileSignals: [/app\/api\/auth\/|lib\/managed\/auth|app\/login|app\/signup/],
    priority: 8,
  },
  {
    id: 'route-diagnosis',
    name: 'Route Completeness Engine',
    description: 'Detects missing pages, dead navigation links, and 404 routes',
    improvementDescription: 'Missing routes will be auto-detected and page stubs created before build completes',
    engineFiles: ['services/route-scanner.ts', 'services/preview-inspector.ts'],
    errorSignals: [
      /404|not found|missing.*page|page.*missing|route.*not.*exist|cannot.*navigate/i,
      /href.*no.*page|Link.*missing|router\.push.*no.*file/i,
    ],
    fileSignals: [/app\/.*page\.tsx|app\/.*route\.ts/],
    priority: 7,
  },
  {
    id: 'preview-verification',
    name: 'Preview Verification Engine',
    description: 'Inspects rendered preview for CSS, Tailwind, forms, and navigation',
    improvementDescription: 'Preview failures (unstyled, broken nav, blank page) will be caught before the user sees them',
    engineFiles: ['services/preview-inspector.ts', 'services/css-health-check.ts'],
    errorSignals: [
      /unstyled|no css|tailwind.*missing|css.*not.*load|blank.*page|preview.*broken/i,
      /globals\.css|@tailwind|postcss|tailwind\.config/i,
    ],
    fileSignals: [/app\/globals\.css|tailwind\.config|postcss\.config|app\/layout\.tsx/],
    priority: 6,
  },
  {
    id: 'database-diagnosis',
    name: 'Data Layer Diagnosis Engine',
    description: 'Detects SQLite schema, query, and connection failures',
    improvementDescription: 'Database errors (missing table, wrong column, lock) will be auto-diagnosed and repaired',
    engineFiles: ['services/engineering-memory.ts', 'services/deterministic-repair.ts'],
    errorSignals: [
      /sqlite|database|db\.|no such table|column.*not.*exist|SQLITE_|initTable|better-sqlite/i,
      /Property 'get' does not exist.*Database|db\.all.*not.*function/i,
    ],
    fileSignals: [/lib\/managed\/db|lib\/db|app\/api\/.*route\.ts/],
    priority: 8,
  },
  {
    id: 'import-hallucination',
    name: 'Import Integrity Engine',
    description: 'Prevents and repairs hallucinated import names (functions that do not exist)',
    improvementDescription: 'Hallucinated imports will be caught before code is applied, or auto-renamed to correct names',
    engineFiles: ['services/export-inspector.ts', 'services/deterministic-repair.ts', 'services/engineering-memory.ts'],
    errorSignals: [
      /has no exported member|is not exported|Module.*'@\/lib.*has no export/i,
      /getDb|getCurrentUser|verifyToken|createAuthUser|findUser/i,
      /TS2305|TS2307|TS2339.*import/i,
    ],
    fileSignals: [/lib\/managed\/|@\/lib\//],
    priority: 9,
  },
  {
    id: 'build-repair',
    name: 'Build Repair Engine',
    description: 'Diagnoses and repairs TypeScript compilation and Next.js build failures',
    improvementDescription: 'Build errors will be classified, matched to known patterns, and repaired in fewer rounds',
    engineFiles: ['services/repair-coordinator.ts', 'services/repair-planner.ts', 'services/deterministic-repair.ts'],
    errorSignals: [
      /TS\d{4}|Type error|TypeError|SyntaxError|Cannot find module|Module not found/i,
      /next build.*failed|compilation error|build.*error/i,
    ],
    fileSignals: [/\.tsx?$|\.jsx?$/],
    priority: 5,
  },
  {
    id: 'api-route-repair',
    name: 'API Route Repair Engine',
    description: 'Detects and repairs broken API route handlers (405, 500, wrong method, missing export)',
    improvementDescription: 'API route issues will be identified by layer and fixed without touching frontend files',
    engineFiles: ['services/root-cause-engine.ts', 'services/repair-planner.ts'],
    errorSignals: [
      /405|method not allowed|route.*does not.*GET|POST|missing.*export.*GET|missing.*export.*POST/i,
      /500.*api|api.*500|api.*error|route.*crash|handler.*throw/i,
    ],
    fileSignals: [/app\/api\/.*route\.ts/],
    priority: 7,
  },
  {
    id: 'upload-diagnosis',
    name: 'Upload & Media Engine',
    description: 'Detects and repairs file upload, image processing, and media handling failures',
    improvementDescription: 'Upload failures will be auto-diagnosed (size limit, type check, storage path, multipart)',
    engineFiles: ['services/engineering-memory.ts'],
    errorSignals: [
      /upload|file.*size|multipart|formdata|blob|image.*upload|storage.*fail|s3.*error|ENOENT.*upload/i,
    ],
    fileSignals: [/upload|media|storage|image/],
    priority: 6,
  },
  {
    id: 'package-dependency',
    name: 'Package Dependency Engine',
    description: 'Detects missing npm packages and installs them without requiring manual intervention',
    improvementDescription: 'Missing packages will be auto-installed and verified, no manual npm install needed',
    engineFiles: ['app/api/chat/route.ts'],
    errorSignals: [
      /Cannot find module|Module not found|npm install|missing.*package|package.*missing/i,
      /TS2307.*Cannot find module/i,
    ],
    fileSignals: [/package\.json/],
    priority: 7,
  },
  {
    id: 'edit-precision',
    name: 'Surgical Edit Engine',
    description: 'Ensures edits touch only the requested section without breaking working code',
    improvementDescription: 'Small edits will be applied surgically — no full-file rewrites, no import hallucination',
    engineFiles: ['services/export-inspector.ts', 'app/builder/page.tsx'],
    errorSignals: [
      /rewrite.*broke|edit.*broke|changed.*too.*much|unrelated.*file.*changed/i,
    ],
    fileSignals: [],
    priority: 4,
  },
];

// ─── Classifier ───────────────────────────────────────────────────────────────

export interface CapabilityMatch {
  capability: Capability;
  score: number;
  matchedSignals: string[];
}

export function classifyCapability(
  errorText: string,
  changedFiles: string[],
  userMessage = '',
): CapabilityMatch | null {
  const combined = `${errorText}\n${changedFiles.join('\n')}\n${userMessage}`;
  const scores: CapabilityMatch[] = [];

  for (const cap of CAPABILITIES) {
    let score = 0;
    const matchedSignals: string[] = [];

    for (const sig of cap.errorSignals) {
      if (sig.test(combined)) {
        score += 2;
        matchedSignals.push(sig.source.slice(0, 40));
      }
    }
    for (const sig of cap.fileSignals) {
      if (changedFiles.some(f => sig.test(f))) {
        score += 1;
        matchedSignals.push(`file:${sig.source.slice(0, 30)}`);
      }
    }

    if (score > 0) {
      scores.push({ capability: cap, score: score + cap.priority * 0.1, matchedSignals });
    }
  }

  if (scores.length === 0) {
    // Default to build-repair — every TypeScript error is a build repair
    const buildRepair = CAPABILITIES.find(c => c.id === 'build-repair')!;
    return { capability: buildRepair, score: 1, matchedSignals: ['default'] };
  }

  scores.sort((a, b) => b.score - a.score);
  return scores[0];
}

/** Format a capability improvement for the user-facing message */
export function formatCapabilityReport(match: CapabilityMatch, patternStored: string, isAutoRepair: boolean): string {
  const cap = match.capability;
  const autoTag = isAutoRepair ? ' — **auto-repair enabled for this pattern**' : '';
  return `**Engine improved:** ${cap.name}${autoTag}\n> _${cap.improvementDescription}_\n> Pattern stored: _${patternStored}_`;
}
