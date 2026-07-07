import { describe, it, expect, afterEach } from 'vitest';
import { rm } from 'fs/promises';
import { generateProject } from '../project-generator';

/**
 * Regression coverage for a real live-production failure: a user built a
 * car sales marketplace, but the preview opened an unrelated prior
 * project ("ExamGuide") instead. Root cause: generateProject's folder name
 * was just `projectName` as-is unless the caller opted into `freshFolder`
 * — and it never wipes the target directory first, only writing the files
 * in its own `files` array — so if a new build's projectName happened to
 * match (or reuse) an earlier build's folder name, files from the OLD
 * project not overwritten by the new generation would remain on disk and
 * get served by the dev server. app/api/chat/route.ts's `action:'create'`
 * handler (generateProject's only caller) now always passes
 * `freshFolder: true` with a unique buildId — these tests cover the
 * mechanism that guarantees that isolation.
 */
describe('generateProject — folder isolation (closes the stale-project-preview gap)', () => {
  const createdDirs: string[] = [];

  afterEach(async () => {
    for (const dir of createdDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('freshFolder produces a genuinely unique path even for the IDENTICAL projectName used twice', async () => {
    const files = [{ path: 'app/page.tsx', content: 'export default function Home() { return <div>hi</div>; }' }];

    const result1 = await generateProject('car-sales-marketplace', files, { freshFolder: true, buildId: 'testbuild1' });
    createdDirs.push(result1.projectPath);
    const result2 = await generateProject('car-sales-marketplace', files, { freshFolder: true, buildId: 'testbuild2' });
    createdDirs.push(result2.projectPath);

    expect(result1.projectPath).not.toBe(result2.projectPath);
    // The clean, user-facing name is unaffected — only the folder differs.
    expect(result1.projectName).toBe('car-sales-marketplace');
    expect(result2.projectName).toBe('car-sales-marketplace');
  });

  it('a second build never lands inside the first build\'s folder — the exact class of bug that caused a stale project to be served', async () => {
    const files1 = [{ path: 'app/page.tsx', content: 'export default function Home() { return <div>OLD_PROJECT_MARKER</div>; }' }];
    const files2 = [{ path: 'app/page.tsx', content: 'export default function Home() { return <div>NEW_PROJECT_MARKER</div>; }' }];

    const result1 = await generateProject('duplicate-name-app', files1, { freshFolder: true, buildId: 'stale-test-1' });
    createdDirs.push(result1.projectPath);
    const result2 = await generateProject('duplicate-name-app', files2, { freshFolder: true, buildId: 'stale-test-2' });
    createdDirs.push(result2.projectPath);

    const { readFile } = await import('fs/promises');
    const { join } = await import('path');
    const content1 = await readFile(join(result1.projectPath, 'app/page.tsx'), 'utf-8');
    const content2 = await readFile(join(result2.projectPath, 'app/page.tsx'), 'utf-8');

    // Each build's own folder contains ONLY its own content — proves the
    // second build did not write into (or read stale files from) the first.
    expect(content1).toContain('OLD_PROJECT_MARKER');
    expect(content2).toContain('NEW_PROJECT_MARKER');
    expect(content1).not.toContain('NEW_PROJECT_MARKER');
    expect(content2).not.toContain('OLD_PROJECT_MARKER');
  });

  it('refuses to proceed if a freshFolder buildId collides with an existing directory (defensive guard)', async () => {
    const files = [{ path: 'app/page.tsx', content: 'export default function Home() { return <div>hi</div>; }' }];
    const result1 = await generateProject('collision-test-app', files, { freshFolder: true, buildId: 'same-id' });
    createdDirs.push(result1.projectPath);

    await expect(
      generateProject('collision-test-app', files, { freshFolder: true, buildId: 'same-id' })
    ).rejects.toThrow(/already exists|refusing to write/i);
  });

  it('without freshFolder (legacy default), behavior is unchanged — same projectName reuses the same folder', async () => {
    const files = [{ path: 'app/page.tsx', content: 'export default function Home() { return <div>v1</div>; }' }];
    const result1 = await generateProject('legacy-behavior-test-app', files);
    createdDirs.push(result1.projectPath);
    const result2 = await generateProject('legacy-behavior-test-app', files);
    // Not pushed again — same dir as result1, only need to clean up once.

    expect(result1.projectPath).toBe(result2.projectPath);
  });
});
