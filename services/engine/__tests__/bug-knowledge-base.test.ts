import { describe, it, expect } from 'vitest';
import { BUG_KNOWLEDGE_BASE, searchKnowledgeBase, formatKnowledgeHint } from '../bug-knowledge-base';

describe('bug-knowledge-base — data integrity', () => {
  it('every entry has all required fields non-empty', () => {
    for (const entry of BUG_KNOWLEDGE_BASE) {
      expect(entry.id).toBeTruthy();
      expect(entry.title).toBeTruthy();
      expect(entry.rootCause).toBeTruthy();
      expect(entry.filesAffected.length).toBeGreaterThan(0);
      expect(entry.fixApplied).toBeTruthy();
      expect(entry.verificationPerformed).toBeTruthy();
      expect(entry.regressionTest).toBeTruthy();
      expect(entry.dateFixed).toBeTruthy();
      expect(entry.symptoms.length).toBeGreaterThan(0);
    }
  });

  it('every entry id is unique', () => {
    const ids = BUG_KNOWLEDGE_BASE.map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('searchKnowledgeBase', () => {
  it('finds the Prisma-hallucination entry from a matching failure detail', () => {
    const results = searchKnowledgeBase("Module not found: Cannot resolve '@prisma/client'");
    expect(results.some(e => e.id === 'prisma-db-ts-hallucination')).toBe(true);
  });

  it('finds the same entry via a different symptom phrase (case-insensitive)', () => {
    const results = searchKnowledgeBase('LIB/MANAGED/DB.TS is missing expected exports');
    expect(results.some(e => e.id === 'prisma-db-ts-hallucination')).toBe(true);
  });

  it('returns no results for unrelated failure text', () => {
    const results = searchKnowledgeBase('the button color should be blue instead of green');
    expect(results).toHaveLength(0);
  });

  it('filters by category when provided', () => {
    const results = searchKnowledgeBase('Connection to the build engine was lost', 'generated-app-repair');
    // This symptom belongs to the 'verification' category entry, not 'generated-app-repair'.
    expect(results).toHaveLength(0);
  });
});

describe('formatKnowledgeHint', () => {
  it('returns an empty string for no matches', () => {
    expect(formatKnowledgeHint([])).toBe('');
  });

  it('includes the root cause and fix for a matched entry', () => {
    const results = searchKnowledgeBase("Module not found: Cannot resolve '@prisma/client'");
    const hint = formatKnowledgeHint(results);
    expect(hint).toContain('root cause');
    expect(hint).toContain('better-sqlite3');
  });
});
