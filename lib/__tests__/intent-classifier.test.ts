import { describe, it, expect } from 'vitest';
import { detectIntent } from '../intent-classifier';

describe('detectIntent — greeting misclassification (fixed 2026-07-01)', () => {
  // ROOT CAUSE: isGreeting matched on the message PREFIX alone with no
  // length guard, so a detailed build request that opened with a casual
  // "Hi," or "Hello," discarded everything that followed and returned
  // 'greeting' — confirmed live: a customer's full football-prediction-site
  // description got the cold-start welcome/example-prompts message instead
  // of triggering a build.
  it('does not classify a detailed build request opening with "Hi," as a greeting', () => {
    const result = detectIntent(
      'Hi, I want a website where people can predict football matches and see who gets the most correct predictions',
      false,
      { hasLogo: false },
    );
    expect(result).toBe('build');
  });

  it('does not classify a detailed build request opening with "Hello," as a greeting', () => {
    const result = detectIntent(
      'Hello, I want to build a website where users can predict the results of football games and compete on a leaderboard with rankings',
      false,
      { hasLogo: false },
    );
    expect(result).toBe('build');
  });

  it('still classifies a genuinely short "hi" as a greeting (no history)', () => {
    expect(detectIntent('hi', false, { hasLogo: false })).toBe('greeting');
  });

  it('still classifies "hello there" as a greeting (no history)', () => {
    expect(detectIntent('hello there', false, { hasLogo: false })).toBe('greeting');
  });

  it('classifies a short greeting as conversation when history already exists', () => {
    expect(detectIntent('hi', true, { hasLogo: false })).toBe('conversation');
  });

  it('classifies a 6-word greeting as a greeting (boundary: words.length <= 6)', () => {
    expect(detectIntent('hey, how are you doing today', false, { hasLogo: false })).toBe('greeting');
  });
});

describe('detectIntent — APP_TYPES substring false positives (fixed 2026-07-04)', () => {
  // ROOT CAUSE: hasAppType used plain .includes() substring matching against
  // short (2-4 letter) APP_TYPES entries ('ai', 'go', 'io', 'pass', 'pro',
  // 'net', 'dash', 'lab', 'hub', 'box', 'pad'), which matched inside ordinary
  // English words that have nothing to do with building an app — 'ai' inside
  // "email"/"paid"/"main"/"again"/"detail"/"maintain"/"contain", 'pass'
  // inside "password", 'pro' inside "profile". Confirmed live: "demo email
  // and password is invalid fix it" (a repair request on an already-open
  // project) was misclassified as 'build' because of this, which caused the
  // whole message to skip the project's repair-detection logic entirely and
  // reach the server-side planner, which then asked "what kind of app is
  // ...?" since the text doesn't describe any app.
  it('does not classify "demo email and password is invalid fix it" as build', () => {
    const result = detectIntent('demo email and password is invalid fix it', true, { hasLogo: false });
    expect(result).not.toBe('build');
  });

  it('does not classify "payment was not paid correctly" as build ("ai" inside "paid")', () => {
    const result = detectIntent('payment was not paid correctly please check again', true, { hasLogo: false });
    expect(result).not.toBe('build');
  });

  it('does not classify "profile page is broken" as build ("pro" inside "profile")', () => {
    const result = detectIntent('profile page is broken please fix it now', true, { hasLogo: false });
    expect(result).not.toBe('build');
  });

  it('still classifies a genuine build request mentioning "email" as a feature word as build', () => {
    const result = detectIntent(
      'Build a newsletter platform with email campaigns, subscriber management, and analytics dashboards',
      false,
      { hasLogo: false },
    );
    expect(result).toBe('build');
  });

  it('still classifies a genuine "AI" app request as build (word-boundary "ai" still matches)', () => {
    const result = detectIntent(
      'Build an AI content generator with text summarization and paraphrasing tools',
      false,
      { hasLogo: false },
    );
    expect(result).toBe('build');
  });

  it('still classifies a named app build using the short suffix "Pro" as build', () => {
    const result = detectIntent(
      'Build DeliverGH Pro for food delivery in Accra with orders, tracking, and payments',
      false,
      { hasLogo: false },
    );
    expect(result).toBe('build');
  });
});

describe('detectIntent — repair signals on an already-open project (fixed 2026-07-04)', () => {
  // These are the exact example messages the user listed as expected repair
  // requests against an already-open project — none of them should ever
  // classify as 'build', which is what routes handleSubmit toward starting
  // a brand-new project instead of repairing the existing one.
  const repairMessages = [
    'demo login is not working',
    'billing page is broken',
    'settings page is blank',
    'button is not working',
  ];
  for (const msg of repairMessages) {
    it(`"${msg}" (on an open project) does not classify as build`, () => {
      expect(detectIntent(msg, true, { hasLogo: false })).not.toBe('build');
    });
  }
});

describe('detectIntent — deployment/debug false-positive guards (fixed 2026-06)', () => {
  // ROOT CAUSE: both checks used to match ANY message containing the
  // keyword ANYWHERE with no length guard, so detailed build requests that
  // merely mentioned "publish"/"deploy"/"fix" as part of a feature
  // description never reached the build pipeline at all.
  it('does not classify a detailed build request mentioning "publish" as deployment', () => {
    const result = detectIntent(
      'Build a blog platform where users can write and publish articles with categories, comments, and search',
      false,
      { hasLogo: false },
    );
    expect(result).toBe('build');
  });

  it('still classifies a short deployment question as deployment', () => {
    expect(detectIntent('how do I deploy my app to production', false, { hasLogo: false })).toBe('deployment');
  });

  it('still classifies a short bug report as debug', () => {
    expect(detectIntent('the app is broken', true, { hasLogo: false })).toBe('debug');
  });
});

describe('detectIntent — feature-rich spec without an imperative verb (fixed 2026-06)', () => {
  // ROOT CAUSE: this used to require hasAction (an imperative verb or "I
  // want"/"I need" phrase) together with hasAppType before ever computing
  // featureScore — a detailed, feature-rich answer to "what kind of app?"
  // with no imperative verb fell straight to 'clarification_needed' without
  // ever being evaluated for how detailed it actually was.
  it('classifies a feature-rich spec with no imperative verb as build', () => {
    const result = detectIntent(
      'School Management System with Student Portal, Teacher Portal, Parent Portal, Admin Dashboard, Authentication, Attendance Tracking, Grade Reports',
      true,
      { hasLogo: false },
    );
    expect(result).toBe('build');
  });
});
