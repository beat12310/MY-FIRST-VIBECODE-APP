import { describe, it, expect } from 'vitest';
import { verifyApp } from '../verifier';
import type { AppPlan } from '../types';

/**
 * Level 1 (fast CI) "performance checks" — proves verifyApp's performance
 * budget evaluation (page_render/api_latency/etc. vs services/engine/
 * verifier.ts's DEFAULT_THRESHOLDS) correctly flags a slow response as an
 * internal, repairable failure, and correctly passes a fast one — using an
 * injected fake probe (deterministic timings), not a real network call.
 */
const basePlan: AppPlan = {
  projectName: 'perf-app', displayName: 'Perf App', description: 'test',
  intent: { appType: 'saas', secondaryTypes: [], confidence: 1, label: 'SaaS', source: 'keyword' },
  pages: [{ route: '/', filePath: 'app/page.tsx', title: 'Home', purpose: 'landing' }],
  apiRoutes: [{ route: '/api/orders', filePath: 'app/api/orders/route.ts', methods: ['GET'], purpose: 'list orders' }],
  components: [], dataModels: [], requiresAuth: false,
  seo: { sitemap: false, robots: false, metadata: false, schema: false },
  uiStyle: { preset: 'modern', palette: [], animations: false },
  capabilities: [], resolvedCapabilities: [],
};

describe('verifyApp — performance budget checks', () => {
  it('flags a response slower than its budget as an internal, repairable failure', async () => {
    const result = await verifyApp(basePlan, '/fixture/project', {
      readProjectFiles: async () => [{ path: 'app/page.tsx', content: 'export default function Home() { return null; }' }],
      probe: async (req) => ({ status: 200, body: 'ok', ms: req.path === '/api/orders' ? 5000 : 100, ok: true }), // api_latency budget is 1500ms
    });

    const perf = result.performance.find(p => p.metric === 'api_latency');
    expect(perf).toBeDefined();
    expect(perf!.withinBudget).toBe(false);
    expect(result.performanceWithinBudget).toBe(false);
    expect(result.classifiedFailures.some(f => f.area === 'performance' && f.detail.includes('api_latency'))).toBe(true);
  });

  it('does not flag a response comfortably within budget', async () => {
    const result = await verifyApp(basePlan, '/fixture/project', {
      readProjectFiles: async () => [{ path: 'app/page.tsx', content: 'export default function Home() { return null; }' }],
      probe: async () => ({ status: 200, body: 'ok', ms: 50, ok: true }),
    });

    expect(result.performanceWithinBudget).toBe(true);
    expect(result.classifiedFailures.some(f => f.area === 'performance')).toBe(false);
  });

  it('skips all performance measurement when no probe is available (never fabricates a false pass or false fail)', async () => {
    const result = await verifyApp(basePlan, '/fixture/project', {
      readProjectFiles: async () => [{ path: 'app/page.tsx', content: 'export default function Home() { return null; }' }],
    });
    expect(result.performance).toEqual([]);
  });

  it('a custom threshold override is respected instead of the hard-coded default', async () => {
    const result = await verifyApp(basePlan, '/fixture/project', {
      readProjectFiles: async () => [{ path: 'app/page.tsx', content: 'export default function Home() { return null; }' }],
      probe: async () => ({ status: 200, body: 'ok', ms: 2000, ok: true }), // over the DEFAULT api_latency budget (1500ms)...
      thresholds: { api_latency: 3000 }, // ...but within this custom, higher budget
    });
    const perf = result.performance.find(p => p.metric === 'api_latency');
    expect(perf!.withinBudget).toBe(true);
  });
});
