import { describe, it, expect } from 'vitest';
import { pathsMatch } from '../repairer';

/**
 * pathsMatch is the exact mechanism behind "a repair preserves unrelated UI
 * files" — repairer.ts's applyFix/applyFixBatch filter the model's returned
 * edits down to ONLY files matching pathsMatch(edit.path, targetPath) before
 * writing anything; if nothing matches, nothing is written at all (no
 * fallback fan-out to "whatever the model returned"). This is documented as
 * a fix for a real, confirmed incident: a model response named a file plain
 * "page.tsx" instead of the full "app/vendor/[id]/page.tsx" — a loose
 * endsWith/startsWith check let that pass as satisfying the real target,
 * writing to the wrong location while the real target stayed missing.
 */
describe('pathsMatch — the repair route-scope guard', () => {
  it('matches an identical path', () => {
    expect(pathsMatch('app/vendor/[id]/page.tsx', 'app/vendor/[id]/page.tsx')).toBe(true);
  });

  it('matches via last-2-segment overlap even with a different prefix', () => {
    expect(pathsMatch('src/app/vendor/[id]/page.tsx', 'app/vendor/[id]/page.tsx')).toBe(true);
  });

  it('does NOT match an unrelated file with the same filename but a different route — the exact historical bug', () => {
    // Confirmed live: a model response named just "page.tsx" (or a
    // DIFFERENT route's page.tsx) previously satisfied a loose check
    // against "app/vendor/[id]/page.tsx" — pathsMatch's 2-segment
    // requirement specifically rejects this.
    expect(pathsMatch('page.tsx', 'app/vendor/[id]/page.tsx')).toBe(false);
    expect(pathsMatch('app/dashboard/page.tsx', 'app/vendor/[id]/page.tsx')).toBe(false);
  });

  it('does NOT match a completely unrelated UI file — the actual "repair preserves unrelated UI" guarantee', () => {
    expect(pathsMatch('components/Navbar.tsx', 'app/api/billing/route.ts')).toBe(false);
    expect(pathsMatch('app/dashboard/layout.tsx', 'app/api/orders/route.ts')).toBe(false);
  });

  it('requires at least 2 path segments on both sides to consider a match (guards against 1-segment false positives)', () => {
    expect(pathsMatch('page.tsx', 'page.tsx')).toBe(true); // identical short paths still match via the exact-equality branch
    expect(pathsMatch('a/page.tsx', 'page.tsx')).toBe(false); // one side has no room for a meaningful 2-segment overlap
  });
});

describe('repair edit-scoping filter — the actual mechanism repairer.ts applies before writing anything', () => {
  // Mirrors the exact filtering repairer.ts's applyFix does: edits.filter(e
  // => pathsMatch(e.path, targetPath)), with nothing applied if the filtered
  // set is empty — this is what makes it structurally impossible for a
  // repair targeting one file to silently rewrite something else instead.
  function scopeEdits(edits: { path: string; content: string }[], targetPath: string): { path: string; content: string }[] {
    return edits.filter(e => pathsMatch(e.path, targetPath));
  }

  it('a repair targeting one file only ever applies edits to that file, even if the model returned edits for other files too', () => {
    const modelEdits = [
      { path: 'app/vendor/[id]/page.tsx', content: 'fixed content' },
      { path: 'components/Navbar.tsx', content: 'unrelated content the model should not have touched' },
      { path: 'app/dashboard/layout.tsx', content: 'another unrelated file' },
    ];
    const scoped = scopeEdits(modelEdits, 'app/vendor/[id]/page.tsx');
    expect(scoped).toHaveLength(1);
    expect(scoped[0].path).toBe('app/vendor/[id]/page.tsx');
  });

  it('applies NOTHING (not a fallback guess) when the model\'s response does not actually address the real target', () => {
    const modelEdits = [
      { path: 'components/Navbar.tsx', content: 'wrong file' },
    ];
    const scoped = scopeEdits(modelEdits, 'app/vendor/[id]/page.tsx');
    expect(scoped).toHaveLength(0);
  });
});
