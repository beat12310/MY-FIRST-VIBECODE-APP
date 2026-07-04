import { parseRouteManifest, findMissingManifestPages, routeToPagePath } from '/sessions/practical-exciting-davinci/mnt/MY-FIRST-VIBECODE-APP/services/route-reconciler.ts';

const raw = `
Some preamble from the model.
[ROUTE_MANIFEST]
pages: /, /listings, /listings/[id], /about, /pricing, /dashboard, /contact
api_routes: /api/listings, /api/listings/[id]
[/ROUTE_MANIFEST]
[START_PROJECT]
...files...
[END_PROJECT]
`;

// Simulate what the model ACTUALLY generated: it skipped /about, /pricing, /contact
const files = [
  { path: 'app/page.tsx', content: 'home' },
  { path: 'app/listings/page.tsx', content: 'list' },
  { path: 'app/listings/[id]/page.tsx', content: 'detail' },
  { path: 'app/(auth)/login/page.tsx', content: 'login' },
  { path: 'app/dashboard/page.tsx', content: 'dash' },
  { path: 'app/api/listings/route.ts', content: 'api' },
];

const declared = parseRouteManifest(raw);
console.log('Declared pages:', declared);

const missing = findMissingManifestPages(declared, files);
console.log('MISSING pages (broken links):', missing);
console.log('Would write to:', missing.map(routeToPagePath));

// Assertions
const expected = ['/about', '/pricing', '/contact'];
const ok = JSON.stringify(missing.sort()) === JSON.stringify(expected.sort());
console.log(ok ? '\n✅ PASS — detected exactly the 3 missing pages' : '\n❌ FAIL — got ' + JSON.stringify(missing));

// Edge: dynamic route group + trailing slash should NOT be flagged
const raw2 = `[ROUTE_MANIFEST]
pages: /, /login, /products/[slug]
[/ROUTE_MANIFEST]`;
const files2 = [
  { path: 'app/page.tsx', content: '' },
  { path: 'app/(auth)/login/page.tsx', content: '' },     // route group → /login
  { path: 'app/products/[id]/page.tsx', content: '' },     // [id] vs declared [slug] → same canonical
];
const missing2 = findMissingManifestPages(parseRouteManifest(raw2), files2);
console.log('\nEdge test missing (expect none):', missing2);
console.log(missing2.length === 0 ? '✅ PASS — route groups + dynamic param names handled' : '❌ FAIL');
