/**
 * Deterministic breadcrumbs for dynamic detail routes.
 *
 * Scoped narrowly and intentionally: most generated apps in this template
 * are flat (a handful of top-level resource pages), where a breadcrumb adds
 * no navigational value over the nav bar itself. The genuine case is a
 * dynamic detail page (/courses/[id]) reached by drilling into a list —
 * "Courses > Course Detail" is real, useful context there.
 *
 * Injecting breadcrumbs into ARBITRARY, already-AI-authored JSX via regex is
 * a real corruption risk (unlike appending to a `[ ... ]` array literal, a
 * JSX splice has no safe, general insertion point to detect blind). So this
 * module only WRITES breadcrumbs deterministically at stub-creation time —
 * new dynamic-detail stubs get one built in from the start
 * (buildRouteStub in project-generator.ts). For EXISTING pages found
 * missing one, the integration rule only detects the gap; the model
 * (which can safely reason about the specific page's actual JSX structure)
 * makes the fix, the same fallback pattern already used for special-purpose
 * orphaned API endpoints.
 */

export interface BreadcrumbFile { filePath: string; content: string }

export function buildBreadcrumbsComponent(): BreadcrumbFile {
  return {
    filePath: 'components/Breadcrumbs.tsx',
    content: `'use client';
import Link from 'next/link';

interface BreadcrumbItem { label: string; href?: string }

export default function Breadcrumbs({ items }: { items: BreadcrumbItem[] }) {
  return (
    <nav className="flex items-center gap-2 text-sm text-slate-500 mb-4" aria-label="Breadcrumb">
      {items.map((item, i) => (
        <span key={i} className="flex items-center gap-2">
          {i > 0 && <span className="text-slate-300">/</span>}
          {item.href ? (
            <Link href={item.href} className="hover:text-slate-800 hover:underline">{item.label}</Link>
          ) : (
            <span className="text-slate-800 font-medium">{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
`,
  };
}

/** True if a page already renders Breadcrumbs (import OR JSX usage). */
export function hasBreadcrumbs(content: string): boolean {
  return /Breadcrumbs/.test(content);
}

/** Title-cases a route segment, treating "[id]" as a dynamic placeholder. */
function segmentLabel(seg: string): string {
  if (/^\[.+\]$/.test(seg)) return 'Detail';
  return seg.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/** Builds a stub page for a DYNAMIC detail route with breadcrumbs baked in. */
export function buildDynamicRouteStubWithBreadcrumbs(route: string): string {
  const segs = route.split('/').filter(Boolean);
  const parentSeg = segs[segs.length - 2] ?? '';
  const parentHref = '/' + segs.slice(0, -1).join('/');
  const parentLabel = segmentLabel(parentSeg);
  const currentLabel = segmentLabel(segs[segs.length - 1]);

  return `'use client';
import Breadcrumbs from '@/components/Breadcrumbs';

export default function Page() {
  return (
    <main className="max-w-5xl mx-auto px-4 py-8">
      <Breadcrumbs items={[{ label: '${parentLabel}', href: '${parentHref}' }, { label: '${currentLabel}' }]} />
      <h1 className="text-2xl font-bold text-slate-900">${currentLabel}</h1>
      <p className="text-slate-500 mt-2">This page is being finished.</p>
    </main>
  );
}
`;
}
