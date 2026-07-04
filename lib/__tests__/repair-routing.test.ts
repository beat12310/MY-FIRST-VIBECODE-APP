import { describe, it, expect } from 'vitest';
import { decideProjectOpenRouting, reportsRoutingProblem } from '../repair-routing';

describe('decideProjectOpenRouting — the exact user-reported failure', () => {
  // The precise reported scenario: with a project already open, "demo email
  // and password is invalid fix it" must route to repair, never fall
  // through toward a brand-new build (which previously reached the
  // server-side planner and asked "what kind of app is this?").
  it('routes a repair report to edit_pipeline, never new_build', () => {
    const route = decideProjectOpenRouting({
      projectIntent: 'question', // whatever detectIntent actually returns for this text
      appRunning: true,
      hasLivePathAndPort: true,
      userMessage: 'demo email and password is invalid fix it',
    });
    expect(route).not.toBe('new_build');
  });

  const repairMessages = [
    'demo login is not working',
    'billing page is broken',
    'settings page is blank',
    'button is not working',
    'demo login is invalid',
  ];
  for (const msg of repairMessages) {
    it(`"${msg}" never routes to new_build when a project is open and running`, () => {
      const route = decideProjectOpenRouting({
        projectIntent: 'build', // even if detectIntent misfires and says 'build'...
        appRunning: true,
        hasLivePathAndPort: true,
        userMessage: msg,
      });
      // ...the reportsBroken override must still catch it.
      expect(route).not.toBe('new_build');
    });
  }
});

describe('decideProjectOpenRouting — routing precedence', () => {
  it('web_research always wins regardless of app state', () => {
    expect(decideProjectOpenRouting({
      projectIntent: 'web_research', appRunning: false, hasLivePathAndPort: false, userMessage: 'browse amazon',
    })).toBe('web_research');
  });

  it('logo_request always wins regardless of app state', () => {
    expect(decideProjectOpenRouting({
      projectIntent: 'logo_request', appRunning: true, hasLivePathAndPort: true, userMessage: 'make me a logo',
    })).toBe('logo_request');
  });

  it('a genuine "build" intent with no problem report and no running app routes to new_build', () => {
    expect(decideProjectOpenRouting({
      projectIntent: 'build', appRunning: false, hasLivePathAndPort: false,
      userMessage: 'Build a completely different app: a recipe sharing platform with ratings and comments',
    })).toBe('new_build');
  });

  it('build intent + reporting a problem while the app is running overrides to repair', () => {
    expect(decideProjectOpenRouting({
      projectIntent: 'build', appRunning: true, hasLivePathAndPort: true,
      userMessage: 'the dashboard is broken and the form is blank',
    })).not.toBe('new_build');
  });

  it('build intent + reporting a problem, but the app is NOT running, still falls to edit_pipeline (not scan_and_repair, which needs a live app)', () => {
    const route = decideProjectOpenRouting({
      projectIntent: 'question', appRunning: false, hasLivePathAndPort: false, userMessage: 'the button is broken',
    });
    expect(route).toBe('edit_pipeline');
  });

  it('routes to scan_and_repair_routes only when app is running AND a live path+port both exist', () => {
    const route = decideProjectOpenRouting({
      projectIntent: 'question', appRunning: true, hasLivePathAndPort: true, userMessage: 'this page shows a 404',
    });
    expect(route).toBe('scan_and_repair_routes');
  });

  it('does not route to scan_and_repair_routes if the app is running but no live path/port is available', () => {
    const route = decideProjectOpenRouting({
      projectIntent: 'question', appRunning: true, hasLivePathAndPort: false, userMessage: 'this page shows a 404',
    });
    expect(route).toBe('edit_pipeline');
  });

  it('a non-broken, non-build message (e.g. a plain question) falls to edit_pipeline', () => {
    const route = decideProjectOpenRouting({
      projectIntent: 'question', appRunning: false, hasLivePathAndPort: false, userMessage: 'how does the login page work?',
    });
    expect(route).toBe('edit_pipeline');
  });
});

describe('reportsRoutingProblem', () => {
  it('recognizes a routing/navigation-specific problem report', () => {
    expect(reportsRoutingProblem('the navigation links are broken')).toBe(true);
    expect(reportsRoutingProblem('clicking the button does nothing')).toBe(true);
  });

  it('does not flag an unrelated problem report as routing-specific', () => {
    expect(reportsRoutingProblem('the demo password is invalid')).toBe(false);
  });
});
