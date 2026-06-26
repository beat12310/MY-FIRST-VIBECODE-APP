/**
 * Journey Scope
 *
 * When the user edits a file, determines which browser journey steps are affected
 * so we run the minimal subset needed to verify the change — not the full journey.
 *
 * Example:
 *   User says "change button color on the login page"
 *   → edit touches app/login/page.tsx
 *   → affected steps: [Login, Navigate to Login Page]
 *   → we run ONLY those two steps, not the full 11-step marketplace journey
 *
 * This makes post-edit verification fast (seconds not minutes) while still
 * catching real regressions caused by the change.
 */

export type JourneyStepName =
  | 'Open Homepage'
  | 'Navigate to Register Page'
  | 'Fill Registration Form'
  | 'Submit Registration'
  | 'Navigate to Login Page'
  | 'Login'
  | 'Navigate to Create Listing Page'
  | 'Fill Listing Form'
  | 'Upload Image'
  | 'Submit Listing'
  | 'View Listing Details'
  | 'Verify Listing Appears in Browse'
  | 'Navigate to Booking Page'
  | 'Fill Booking Form'
  | 'Submit Booking'
  | 'Verify Booking in Dashboard'
  | 'Navigate to Create Post'
  | 'Fill Post Form'
  | 'Upload Image (optional)'
  | 'Submit Post'
  | 'Verify Post Appears in Feed'
  | 'Open Homepage'
  | 'Register & Login'
  | 'Check Homepage Has Content';

export interface AffectedScope {
  /** Which journey steps to re-run */
  stepsToRerun: JourneyStepName[];
  /** Why these steps were selected */
  reason: string;
  /** Whether the full journey should be re-run (e.g. layout.tsx changed) */
  runFullJourney: boolean;
}

// ─── File → journey step mapping ─────────────────────────────────────────────
// Each entry: file path regex → which journey steps it affects

const FILE_STEP_MAP: Array<{ pattern: RegExp; steps: JourneyStepName[]; fullJourney?: boolean }> = [
  // ── Auth / Login / Register ──────────────────────────────────────────
  {
    pattern: /app\/(login|signin)[/.]|app\/auth\/(login|signin)[/.]/i,
    steps: ['Navigate to Login Page', 'Login'],
  },
  {
    pattern: /app\/(register|signup)[/.]|app\/auth\/(register|signup)[/.]/i,
    steps: ['Navigate to Register Page', 'Fill Registration Form', 'Submit Registration'],
  },
  {
    pattern: /app\/api\/auth\/login/i,
    steps: ['Login'],
  },
  {
    pattern: /app\/api\/auth\/register/i,
    steps: ['Fill Registration Form', 'Submit Registration'],
  },
  {
    pattern: /app\/api\/auth\/me/i,
    steps: ['Login'],
  },

  // ── Listings (marketplace) ────────────────────────────────────────────
  {
    pattern: /app\/(sell|listings\/new|create-listing|new-listing)[/.]|app\/api\/listings\/route/i,
    steps: ['Navigate to Create Listing Page', 'Fill Listing Form', 'Submit Listing'],
  },
  {
    pattern: /app\/listings\/\[/i,  // dynamic route: app/listings/[id]/page.tsx
    steps: ['View Listing Details'],
  },
  {
    pattern: /app\/listings[/.]|app\/api\/listings\/route/i,
    steps: ['Verify Listing Appears in Browse', 'View Listing Details'],
  },
  {
    pattern: /app\/api\/listings\//i,
    steps: ['Submit Listing', 'View Listing Details', 'Verify Listing Appears in Browse'],
  },

  // ── Bookings ──────────────────────────────────────────────────────────
  {
    pattern: /app\/(book|bookings\/new|create-booking|appointments\/new)[/.]|app\/api\/bookings\/route/i,
    steps: ['Navigate to Booking Page', 'Fill Booking Form', 'Submit Booking'],
  },
  {
    pattern: /app\/dashboard[/.]|app\/api\/dashboard/i,
    steps: ['Verify Booking in Dashboard'],
  },
  {
    pattern: /app\/api\/bookings\//i,
    steps: ['Submit Booking', 'Verify Booking in Dashboard'],
  },

  // ── Social / Posts ────────────────────────────────────────────────────
  {
    pattern: /app\/(posts\/new|create-post|compose)[/.]|app\/api\/posts\/route/i,
    steps: ['Navigate to Create Post', 'Fill Post Form', 'Submit Post'],
  },
  {
    pattern: /app\/(feed|posts)[/.]|app\/api\/(posts|feed)\//i,
    steps: ['Verify Post Appears in Feed'],
  },

  // ── Upload / Image handling ───────────────────────────────────────────
  {
    pattern: /upload|media|storage|image|file[-.]/i,
    steps: ['Upload Image', 'Upload Image (optional)'],
  },

  // ── Homepage ──────────────────────────────────────────────────────────
  {
    pattern: /app\/page\.(tsx|ts)|app\/home[/.]/i,
    steps: ['Open Homepage', 'Check Homepage Has Content'],
  },

  // ── Global layout / styles (affects every page) ───────────────────────
  {
    pattern: /app\/layout\.(tsx|ts)|app\/globals\.css|tailwind\.config/i,
    steps: ['Open Homepage'],
    fullJourney: true,
  },

  // ── Navigation components ─────────────────────────────────────────────
  {
    pattern: /components\/(nav|header|sidebar|menu)/i,
    steps: ['Open Homepage', 'Navigate to Login Page'],
    fullJourney: false,
  },
];

// ─── User request → journey step mapping ──────────────────────────────────────
// When the user's message contains these keywords, force certain steps

const REQUEST_STEP_MAP: Array<{ pattern: RegExp; steps: JourneyStepName[] }> = [
  { pattern: /login|sign.?in|auth/i,                       steps: ['Navigate to Login Page', 'Login'] },
  { pattern: /register|sign.?up|create.*account/i,         steps: ['Navigate to Register Page', 'Fill Registration Form', 'Submit Registration'] },
  { pattern: /upload|image|photo|file/i,                   steps: ['Upload Image', 'Upload Image (optional)', 'Submit Listing'] },
  { pattern: /listing|sell|post.*item|create.*listing/i,   steps: ['Navigate to Create Listing Page', 'Fill Listing Form', 'Submit Listing'] },
  { pattern: /booking|appointment|reserve|schedule/i,      steps: ['Navigate to Booking Page', 'Fill Booking Form', 'Submit Booking'] },
  { pattern: /dashboard|my.*account|profile/i,             steps: ['Verify Booking in Dashboard'] },
  { pattern: /button|color|colour|style|css|theme|design/i, steps: ['Open Homepage'] },
];

// ─── Public API ───────────────────────────────────────────────────────────────

export function determineAffectedScope(
  changedFiles: string[],
  userRequest: string,
): AffectedScope {
  const affectedSteps = new Set<JourneyStepName>();
  let runFullJourney = false;

  // Check file patterns
  for (const file of changedFiles) {
    for (const entry of FILE_STEP_MAP) {
      if (entry.pattern.test(file)) {
        for (const step of entry.steps) affectedSteps.add(step);
        if (entry.fullJourney) runFullJourney = true;
      }
    }
  }

  // Check request patterns
  for (const entry of REQUEST_STEP_MAP) {
    if (entry.pattern.test(userRequest)) {
      for (const step of entry.steps) affectedSteps.add(step);
    }
  }

  // If layout/globals changed, just run the full journey — it's faster
  if (runFullJourney) {
    return {
      stepsToRerun: [],
      reason: 'Global layout or style file changed — full journey re-run required',
      runFullJourney: true,
    };
  }

  // If nothing specific matched, run homepage at minimum
  if (affectedSteps.size === 0) {
    return {
      stepsToRerun: ['Open Homepage'],
      reason: 'No specific journey step affected — verifying homepage renders correctly',
      runFullJourney: false,
    };
  }

  const stepsToRerun = [...affectedSteps] as JourneyStepName[];
  return {
    stepsToRerun,
    reason: `${changedFiles.length} file(s) changed → ${stepsToRerun.length} step(s) need re-verification`,
    runFullJourney: false,
  };
}

/**
 * Return a human-readable summary of the scope decision.
 */
export function formatScopeDecision(scope: AffectedScope): string {
  if (scope.runFullJourney) return `Re-running full journey — ${scope.reason}`;
  return `Re-running ${scope.stepsToRerun.length} step(s): ${scope.stepsToRerun.join(', ')} — ${scope.reason}`;
}
