/**
 * Edit scope computation — the engine capability that makes "edit only the
 * requested page/component/route/file without affecting unrelated parts" a
 * GUARANTEE rather than a best-effort heuristic.
 *
 * Root cause this fixes: the existing edit pipeline (app/api/chat/route.ts's
 * `edit` action, via services/project-discovery.ts's buildEditContext) selects
 * files to send to the model using pure keyword-substring matching against the
 * user's request text — it never consults services/project-map.ts's
 * already-built import graph or layer classification. Scope ENFORCEMENT on
 * the model's response also already exists (an allowedPrefixes/blockedPrefixes
 * filter) but is entirely opt-in via `scopeConstraint`, which the default
 * chat edit flow never sets — so by default a "change the pricing page text"
 * request can come back with edits to unrelated pages, API routes, or the
 * database layer, and nothing stops them from being applied.
 *
 * computeEditScope() gives every edit request a precise, LAYER-AWARE boundary:
 *   1. Identify PRIMARY target files by name/route match against the request.
 *   2. Walk ONE hop of the import graph in both directions (what the target
 *      imports, what imports the target) — this is the actual "isolated
 *      edit" boundary: a page can legitimately need to touch a component it
 *      renders or an API route it calls, but has no business touching an
 *      unrelated page or the database schema.
 *   3. Derive allowedPrefixes/blockedPrefixes from the LAYERS actually
 *      touched, so a frontend-only request is structurally prevented from
 *      reaching into app/api/ or lib/managed/ even if the model tries.
 */
import type { ProjectMap, FileLayer } from '@/services/project-map';

export interface EditScope {
  /** Files whose current content should be sent to the model as context. */
  targetFiles: string[];
  /** Path prefixes the model's response is allowed to touch. */
  allowedPrefixes: string[];
  /** Path prefixes the model's response must NOT touch, even if also allowed by a broader prefix. */
  blockedPrefixes: string[];
  /** Layer(s) this request was classified into — for logging/diagnostics. */
  layers: FileLayer[];
  /** file path -> why it was included, for debugging. Not sent to the model. */
  reasons: Record<string, string>;
}

/** Root path prefix(es) new/edited files in a given layer are expected under. */
const LAYER_ALLOWED_PREFIXES: Partial<Record<FileLayer, string[]>> = {
  ui: ['app/'],
  component: ['components/', 'app/components/'],
  api: ['app/api/'],
  data: ['lib/data/', 'lib/managed/'],
  auth: ['lib/auth', 'middleware.ts'],
  middleware: ['middleware.ts', 'middleware.js'],
  types: ['lib/types/', 'types/'],
  services: ['services/'],
  hooks: ['hooks/', 'lib/hooks/'],
};

function layerOf(map: ProjectMap, path: string): FileLayer | undefined {
  return map.files.find(f => f.path === path)?.layer;
}

/**
 * Primary targets: files whose name, containing directory, or computed route
 * URL segment appears in the request text. Falls back to app/page.tsx when
 * nothing matches, mirroring the previous default behavior so unscoped/vague
 * requests ("make the site look nicer") still resolve to something sane.
 */
/** Word-boundary substring test — `req.includes('auth')` also matches inside
 *  "author", "authority", etc. Confirmed live: this made a per-resource
 *  authorization request ("only the AUTHOR can delete it") wrongly identify
 *  lib/managed/auth.ts as the PRIMARY edit target. */
/**
 * Word-boundary match, tolerant of simple singular/plural variants. Resource
 * directories follow REST convention (plural: "reservations", "products"),
 * but requests are natural English and often singular ("the reservation
 * form", "the product page") — confirmed live: "Remove the special-requests
 * field from the reservation form" matched NEITHER "reservations" (plural,
 * the real directory) NOR any other primary target, because word-boundary
 * matching correctly requires the exact word and neither substring contains
 * the other. The edit fell through to the app/page.tsx fallback, found
 * nothing relevant to remove, and applied no changes at all.
 */
function mentionsWord(req: string, word: string): boolean {
  const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const variants = new Set([word]);
  if (word.endsWith('ies')) variants.add(word.slice(0, -3) + 'y');       // categories -> category
  else if (word.endsWith('y')) variants.add(word.slice(0, -1) + 'ies');  // category -> categories
  else if (word.endsWith('s')) variants.add(word.slice(0, -1));         // reservations -> reservation
  else variants.add(word + 's');                                        // reservation -> reservations
  return [...variants].some(w => new RegExp(`\\b${escape(w)}\\b`).test(req));
}

/**
 * The resource-name path segment nearest the filename, skipping past dynamic
 * segments like [id]/[slug]. For "app/api/post/[id]/route.ts" this is "post",
 * not "[id]" — a plain `.slice(-2,-1)` grabs the dynamic placeholder instead
 * of the real resource name, so a request naming the resource ("the post
 * delete endpoint") would never match its own detail route at all.
 */
function resourceSegment(path: string): string | undefined {
  const segs = path.split('/').slice(0, -1); // drop the filename
  for (let i = segs.length - 1; i >= 0; i--) {
    if (!/^\[.*\]$/.test(segs[i])) return segs[i].toLowerCase();
  }
  return undefined;
}

function findPrimaryTargets(map: ProjectMap, req: string): Set<string> {
  // A resource name like "pricing" often names BOTH app/pricing/page.tsx and
  // app/api/pricing/route.ts. Bare substring matching would pull in both for
  // ANY mention of "pricing" — including "the pricing PAGE", which is clearly
  // UI-only. Require explicit backend language before letting a name match
  // pull in the API side; the page/component side is the default assumption.
  const mentionsApi = /\bapi\b|endpoint|backend|route handler|server route/i.test(req);
  const mentionsUi = /\bpage\b|\bscreen\b|\bview\b|\bui\b|frontend|component|button|card|modal|form|nav/i.test(req);

  const primary = new Set<string>();

  for (const f of map.files) {
    const base = f.path.split('/').pop()!.replace(/\.(tsx?|jsx?)$/, '').toLowerCase();
    const dirSeg = resourceSegment(f.path);
    const isApiFile = f.layer === 'api';
    if (isApiFile && !mentionsApi && mentionsUi) continue; // explicit UI language, no API language -> skip API matches
    if (base && base !== 'page' && base !== 'route' && base !== 'layout' && mentionsWord(req, base)) {
      primary.add(f.path);
    } else if (dirSeg && dirSeg !== 'app' && dirSeg.length > 2 && mentionsWord(req, dirSeg)) {
      primary.add(f.path);
    }
  }

  for (const r of map.routes) {
    if (r.isApi && !mentionsApi && mentionsUi) continue;
    const urlSegs = r.url.replace(/^\//, '').split('/').filter(Boolean);
    // For API routes the first URL segment is ALWAYS the literal "api" (every
    // route lives under /api/...) — it is never the resource name. Using it
    // unfiltered meant ANY request mentioning the word "api" (extremely
    // common: "add an API route", "fix the API") matched EVERY SINGLE API
    // route in the app as a primary target. Confirmed live: a request purely
    // about adding a "/staff" page pulled in 9 completely unrelated routes
    // (auth, billing, patients, appointments) plus their one-hop dependents —
    // 18 files total — just because it said "a new API endpoint."
    const seg = r.isApi && urlSegs[0] === 'api' ? urlSegs[1] : urlSegs[0];
    if (seg && seg.length > 2 && !/^\[.*\]$/.test(seg) && mentionsWord(req, seg)) primary.add(r.file);
  }

  if (primary.size === 0) primary.add('app/page.tsx');
  return primary;
}

// Route-protection / access-control requests ("require login for X",
// "redirect to /login if not signed in", "protect this route") are a
// STRUCTURAL concern (does this route require a session) that belongs to
// middleware.ts, not a DATA-FLOW concern. Confirmed live: a request like this
// about a dashboard page pulled in every API route the dashboard happens to
// fetch for its own widgets (listings, orders, auth/me) via the one-hop
// fetch-edge walk — all legitimate edges for THIS page, all irrelevant to
// "add an auth gate." Route-protection requests skip the general one-hop walk
// entirely and target middleware.ts + the mentioned page only.
const ROUTE_PROTECTION_RE = /\b(require|need)s?\s+(login|auth|sign.?in)|redirect.*(login|sign.?in)|protect(ed)?\s+route|route\s+protection|not\s+(signed|logged)\s+in|unauthenticated|access\s+control|auth\s+gate/i;

// Per-resource ownership/authorization requests ("only the AUTHOR can delete
// it", "only the owner should be able to edit") are a check that belongs
// entirely inside ONE mutation handler — the API route matching the resource
// and action named. Confirmed live: even after the hub-fanout cap and
// narrowed-prefix fixes, a request like this still pulled in the resource's
// detail PAGE (which has its own, unrelated one-hop neighbors: auth/me,
// feed, dashboard) alongside the correct API route, because both the page
// and the API route legitimately match the resource name. Skip the general
// one-hop walk and target only the matching API route(s).
const OWNERSHIP_AUTH_RE = /\bonly\s+(the\s+)?(author|owner|creator)\b|ownership\s+check|not\s+(the\s+)?owner/i;

export function computeEditScope(map: ProjectMap, userRequest: string): EditScope {
  const req = userRequest.toLowerCase();
  const reasons: Record<string, string> = {};

  const primary = findPrimaryTargets(map, req);
  for (const p of primary) reasons[p] = 'name/route match against request';

  if (ROUTE_PROTECTION_RE.test(req)) {
    const scopeSet = new Set(primary);
    if (map.middlewareFile) { scopeSet.add(map.middlewareFile); reasons[map.middlewareFile] = 'route-protection request — middleware owns access control'; }
    const layers = new Set<FileLayer>(['middleware']);
    for (const p of scopeSet) { const l = layerOf(map, p); if (l) layers.add(l); }
    const allowedPrefixes = new Set<string>();
    for (const l of layers) for (const prefix of LAYER_ALLOWED_PREFIXES[l] ?? []) allowedPrefixes.add(prefix);
    for (const p of scopeSet) allowedPrefixes.add(p);
    return {
      targetFiles: [...scopeSet],
      allowedPrefixes: [...allowedPrefixes],
      blockedPrefixes: ['app/api/'], // a route gate never needs to touch business-logic API routes
      layers: [...layers],
      reasons,
    };
  }

  if (OWNERSHIP_AUTH_RE.test(req)) {
    const apiPrimary = [...primary].filter(p => layerOf(map, p) === 'api');
    const scopeSet = new Set(apiPrimary.length > 0 ? apiPrimary : primary);
    for (const p of scopeSet) reasons[p] = 'ownership/authorization request — scoped to the mutation handler only';
    const allowedPrefixes = new Set<string>();
    for (const p of scopeSet) {
      allowedPrefixes.add(p);
      const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '';
      if (dir) allowedPrefixes.add(dir);
    }
    return {
      targetFiles: [...scopeSet],
      allowedPrefixes: [...allowedPrefixes],
      blockedPrefixes: [],
      layers: ['api'],
      reasons,
    };
  }

  // One-hop import graph walk: direct dependencies AND direct dependents of
  // every primary target. This is deliberately shallow — a page importing a
  // component that itself imports a dozen unrelated utilities should not drag
  // the whole dependency tree into scope, only the file the request is
  // actually about and what it directly touches.
  //
  // Two guards against "hub" files exploding the scope, confirmed live: a
  // per-resource authorization request ("only the post author can delete it")
  // pulled in ALL FOUR auth routes plus lib/managed/auth.ts itself — because
  // the target route imports auth.ts (one hop in), and auth.ts is in turn
  // imported by every other auth route (one hop OUT from auth.ts pulls in
  // everything that uses it). A file used by many other files is shared
  // infrastructure, not part of THIS request's boundary:
  //  1. lib/managed/** (the deterministic, platform-injected auth/db/email/
  //     storage contract — auth-template.ts's own header describes why this
  //     must stay stable) is never added as an editable target via the
  //     dependency walk, only as read-only awareness when it's a PRIMARY
  //     (explicitly named) target.
  //  2. Any file with more than HUB_FANOUT_CAP dependents is treated as
  //     shared/hub infrastructure — its dependents are not walked, since
  //     "everything that imports the thing this file imports" is not the
  //     same boundary as "this specific edit."
  const HUB_FANOUT_CAP = 4;
  const SHARED_INFRA_RE = /^lib\/managed\//;
  const scopeSet = new Set(primary);
  for (const p of primary) {
    for (const dep of map.importGraph[p] ?? []) {
      if (SHARED_INFRA_RE.test(dep) && !primary.has(dep)) continue;
      if (!scopeSet.has(dep)) { scopeSet.add(dep); reasons[dep] = `imported by ${p}`; }
    }
    const dependents = map.exportGraph[p] ?? [];
    if (dependents.length > HUB_FANOUT_CAP) continue;
    for (const dependent of dependents) {
      if (!scopeSet.has(dependent)) { scopeSet.add(dependent); reasons[dependent] = `imports ${p}`; }
    }
  }

  // Layout/nav/auth-adjacent requests legitimately need the layout file even
  // though nothing "imports" it in the request-driven sense above.
  if (/header|footer|\bnav\b|navbar|navigation|layout|sign.in|sign-in|top\s+right/i.test(req)) {
    for (const f of map.layers.ui) {
      if (/layout\.(tsx|ts|jsx|js)$/.test(f) && !scopeSet.has(f)) { scopeSet.add(f); reasons[f] = 'layout/nav keyword in request'; }
    }
  }

  // Layers actually present in the computed scope.
  const layers = new Set<FileLayer>();
  for (const p of scopeSet) {
    const l = layerOf(map, p);
    if (l) layers.add(l);
  }
  // A primary target that doesn't exist yet (a genuinely NEW file, e.g. "add
  // a /pricing page") won't be in map.files — infer its layer from keywords
  // so the allow-list still covers legitimate net-new files in the right
  // place. This inference must run whenever the keywords are present, NOT
  // only when `layers` is otherwise empty — confirmed live: "add a new
  // /events page ... fetched from a new API route" always resolves at least
  // one 'ui' layer entry (findPrimaryTargets' fallback to app/page.tsx when
  // NEITHER the new page nor the new API route exist yet to match by name),
  // so the old `layers.size === 0` gate never fired for the 'api' inference
  // — the model's own API route creation was then invisible to the scope
  // filter, and the resulting page shipped calling a /api/events endpoint
  // that was never generated.
  if (/\bapi\b|endpoint|route handler/i.test(req)) layers.add('api');
  if (/database|\bdb\b|table|schema/i.test(req)) layers.add('data');
  if (layers.size === 0) layers.add('ui');

  // allowedPrefixes must be narrow by default. Confirmed live: using the
  // full layer-root prefix (e.g. "app/api/") unconditionally let a
  // per-resource authorization fix ("only the post author can delete it")
  // pass the scope filter for THREE unrelated resources (auth/*, feed/*)
  // just because they're ALSO under app/api/ — the prefix was broad enough
  // to defeat the whole point of computing a specific scope. The broad
  // layer-root prefix is only needed when the request implies creating a
  // file that doesn't exist yet (its future path can't be known in advance);
  // for edits to already-existing, already-identified resources, restrict to
  // their own directories.
  const allowedPrefixes = new Set<string>();
  const impliesNewFile = /\b(add|create|new|build)\b/i.test(req);
  if (impliesNewFile) {
    for (const l of layers) for (const prefix of LAYER_ALLOWED_PREFIXES[l] ?? []) allowedPrefixes.add(prefix);
  }
  for (const p of scopeSet) {
    allowedPrefixes.add(p); // exact file
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : ''; // its own directory, e.g. "app/api/post/[id]/"
    if (dir) allowedPrefixes.add(dir);
  }

  // The one cross-contamination risk worth structurally blocking by default:
  // a frontend-only request reaching into API routes. 'app/' is a broad
  // allow-prefix (needed so new pages can be created), so without this,
  // app/api/** would ALSO match it. Only applies when the request wasn't
  // ALSO classified into the api layer.
  const blockedPrefixes: string[] = [];
  if (layers.has('ui') && !layers.has('api')) blockedPrefixes.push('app/api/');

  return {
    targetFiles: [...scopeSet],
    allowedPrefixes: [...allowedPrefixes],
    blockedPrefixes,
    layers: [...layers],
    reasons,
  };
}

/**
 * Whether an edit to `filePath` should be applied, given the computed scope.
 * This is the enforcement layer prefix-matching alone can't provide: a path
 * PREFIX being "allowed" (e.g. "app/api/" to permit creating a genuinely new
 * route) says nothing about whether the model was actually shown that
 * specific file's CURRENT content — and a model asked to "return the complete
 * file" for a path it never saw will invent new content from scratch,
 * silently discarding whatever was really there. Confirmed live: a request
 * to add a new /statements page also touched app/api/transactions/[id]/route.ts
 * and app/api/wallet/[id]/route.ts — both pre-existing, unrelated, working
 * routes, neither shown to the model as context, both within the broad
 * "app/api/" allow-prefix needed for the genuinely new /api/statements route.
 *
 * Rule: an EXISTING file may only be touched if it's an exact member of the
 * computed scope (it was actually shown to the model). A file that does NOT
 * exist yet may be created anywhere under an allowed (and not blocked)
 * prefix, since its path can't be known in advance.
 */
export function isEditAllowed(scope: EditScope, filePath: string, existingFilePaths: ReadonlySet<string>): boolean {
  if (scope.blockedPrefixes.some(p => filePath.startsWith(p))) return false;
  if (existingFilePaths.has(filePath)) return scope.targetFiles.includes(filePath);
  return scope.allowedPrefixes.some(p => filePath.startsWith(p));
}
