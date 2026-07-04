import { describe, it, expect } from 'vitest';
import { GOLDEN_PROJECTS } from '../golden-project-suite';

describe('GOLDEN_PROJECTS manifest — data integrity', () => {
  it('has exactly the 8 required real-world project types', () => {
    expect(GOLDEN_PROJECTS).toHaveLength(8);
  });

  it('every project has a non-empty name and a substantial, descriptive prompt', () => {
    for (const p of GOLDEN_PROJECTS) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.prompt.split(/\s+/).length).toBeGreaterThanOrEqual(10); // detailed enough to build without clarification
    }
  });

  it('every project name is unique', () => {
    const names = GOLDEN_PROJECTS.map(p => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('includes all 8 explicitly required categories', () => {
    const names = GOLDEN_PROJECTS.map(p => p.name);
    expect(names).toContain('Sports Prediction App');
    expect(names).toContain('Real Estate Marketplace');
    expect(names).toContain('TaskCashFlow');
    expect(names).toContain('Visitor Management System');
    expect(names).toContain('AI Video Generator');
    expect(names).toContain('E-commerce Website');
    expect(names).toContain('Dashboard/CRM');
    expect(names).toContain('Blog/News Website');
  });
});
