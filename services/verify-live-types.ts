/**
 * Shared event types for real-time verification streaming.
 * Emitted by services (browser-journey-runner, link-crawler) and streamed
 * to the client via /api/verify-live (SSE).
 */

export type VerifyLiveEvent =
  | { type: 'phase'; phase: 'journey' | 'crawl'; message: string }
  | { type: 'step-start'; step: string; url: string; action: string }
  | { type: 'step-complete'; step: string; url: string; passed: boolean; optional: boolean; screenshotUrl?: string; error?: string; durationMs: number }
  | { type: 'page-visiting'; url: string; pageNum: number }
  | { type: 'link-testing'; url: string; linkText: string; fromPage: string }
  | { type: 'link-tested'; url: string; linkText: string; fromPage: string; passed: boolean; is404: boolean; screenshotUrl?: string }
  | { type: 'page-screenshot'; url: string; screenshotUrl: string }
  | { type: 'web-search'; query: string; source: string; resultCount: number }
  | { type: 'journey-complete'; verdict: 'PASSED' | 'FAILED VERIFICATION' | 'SKIPPED'; passCount: number; totalSteps: number; failedAt?: string; failedRequests: number; durationMs: number }
  | { type: 'crawl-complete'; verdict: 'PASSED' | 'FAILED' | 'SKIPPED'; passedLinks: number; failedLinks: number; pagesVisited: number; missingRouteFiles: string[]; durationMs: number }
  | {
      type: 'complete';
      journeyVerdict: 'PASSED' | 'FAILED VERIFICATION' | 'SKIPPED';
      journeyFailedAt?: string;
      journeyFailedRequests: number;
      journeySteps: Array<{ step: string; passed: boolean; optional: boolean; durationMs: number; screenshotUrl?: string; error?: string }>;
      journeyMetrics: { formsTested: number; loginTests: number; logoutTests: number; searchTests: number };
      crawlVerdict: 'PASSED' | 'FAILED' | 'SKIPPED';
      crawlPassedLinks: number;
      crawlFailedLinks: number;
      crawlMissingRouteFiles: string[];
      crawlPagesVisited: number;
    }
  | { type: 'error'; message: string };
