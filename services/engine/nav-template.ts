/**
 * Deterministic navigation-link patcher — the nav counterpart to
 * auth-template.ts's addProtectedRoute().
 *
 * Root cause this fixes: unlike middleware.ts (which this engine generates
 * from a fixed template, so its shape is always predictable), Navbar/Footer/
 * Sidebar components are 100% AI-authored free-form JSX. Adding a link to
 * them has always been left entirely to model judgment — confirmed
 * inconsistent across live apps this session: some new pages get added to
 * the nav, others silently don't, with no reliable pattern.
 *
 * Because these files vary far more than a template-generated middleware.ts,
 * this patcher is intentionally conservative: it recognizes a handful of
 * COMMON array-literal shapes real generated navbars actually use (confirmed
 * against live apps — `const navLinks = [...]`, `const NAV_ITEMS = [...]`,
 * and the conditional `user ? [...] : [...]` pattern where the logged-in
 * list comes first) and only ever ADDS an entry to a recognized array. On
 * anything it doesn't recognize, it changes nothing and reports
 * `changed: false` — same contract as addProtectedRoute — so an unrecognized
 * file falls through to a model-generated fix instead of risking corruption.
 *
 * A second, narrower fallback handles an ANONYMOUS array fed directly into
 * `.map()` with no named declaration at all — confirmed live on a real
 * generated Navbar.tsx, which typically has exactly ONE such list. It's only
 * ever used when there's EXACTLY ONE such candidate in the whole file:
 * confirmed live on a real Footer.tsx with separate "Explore"/"Account"
 * sections, each its own unnamed array — with 2+ candidates, guessing which
 * one to patch risks silently adding a link to the wrong section, so that
 * case still declines exactly as before.
 */

export interface NavPatchResult { patched: string; changed: boolean }

const NAV_ARRAY_NAME_RE = /\b(navLinks|navItems|NAV_ITEMS|menuItems|MENU_ITEMS|links|sidebarLinks|sidebarItems|SIDEBAR_ITEMS)\b/;

// "auth" covers a combined signin/signup page (confirmed live: a generated
// app used exactly this route with a mode=signup/signin toggle, matching
// the SAME shape buildRouteStub's own auth-page template produces) — the
// same reasoning that excludes /login and /signup individually applies to
// a single page serving both. The (\/.*)? suffix ALSO excludes sub-paths
// like /auth/login, /auth/register — confirmed live: a dead-link fast-path
// created exactly these as separate stub pages (duplicating the combined
// /auth?mode= page), and without the suffix they were flagged as missing
// from nav even though they're auth-flow pages, not real navigable
// destinations, same as their exact-match counterparts. Exported so both
// the navigation Integration Rule and the navigation registry template
// (nav-registry-template.ts) apply the identical definition of "route that
// doesn't belong in a nav list" rather than risking two definitions drifting.
export const NAV_EXCLUDE_RE = /^\/(login|signup|register|sign-in|sign-up|signin|auth|logout|forgot-password|reset-password)(\/.*)?$/i;

/** Walks from an opening `[` to its depth-balanced matching `]`, or -1 if unbalanced. */
function matchArrayEnd(content: string, bracketIdx: number): number {
  let depth = 0;
  for (let j = bracketIdx; j < content.length; j++) {
    if (content[j] === '[') depth++;
    else if (content[j] === ']') { depth--; if (depth === 0) return j; }
  }
  return -1;
}

/**
 * Finds every anonymous `[ ... ].map(` array literal in the file that
 * contains at least one `href:` entry — a rendered link list with no named
 * declaration. Requires the closing `]` to be immediately (whitespace
 * aside) followed by `.map(`, distinguishing a list actually being rendered
 * from an unrelated array that merely happens to contain an `href` field.
 */
function findAnonymousHrefMapArrays(content: string): { start: number; end: number }[] {
  const results: { start: number; end: number }[] = [];
  for (let i = 0; i < content.length; i++) {
    if (content[i] !== '[') continue;
    const end = matchArrayEnd(content, i);
    if (end === -1) continue;
    const body = content.slice(i + 1, end);
    if (!/href\s*:/.test(body)) continue;
    if (!/^\s*\.map\s*\(/.test(content.slice(end + 1))) continue;
    results.push({ start: i, end });
  }
  return results;
}

/**
 * Finds the array literal to patch: a named nav-array declaration first
 * (unambiguous, tried regardless of how many other arrays exist in the
 * file), falling back to the sole anonymous `.map()`-fed array when there
 * is exactly one such candidate and no named one was found.
 */
function findNavArray(content: string): { start: number; end: number } | null {
  const declRe = new RegExp(`(?:const|let)\\s+${NAV_ARRAY_NAME_RE.source}\\s*=`, 'g');
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(content))) {
    // From the declaration, scan forward to the first `[` — skipping over a
    // ternary condition (`user ?`) if present, since the logged-in list
    // (the one a newly protected page belongs in) is conventionally first.
    const i = declRe.lastIndex;
    const bracketIdx = content.indexOf('[', i);
    if (bracketIdx === -1 || bracketIdx - i > 80) continue; // too far — not this array
    const end = matchArrayEnd(content, bracketIdx);
    if (end === -1) continue;
    const body = content.slice(bracketIdx + 1, end);
    if (!/href\s*:/.test(body)) continue; // not a link array
    return { start: bracketIdx, end };
  }

  const anonymous = findAnonymousHrefMapArrays(content);
  if (anonymous.length === 1) return anonymous[0];
  return null;
}

/**
 * Adds `{ href: route, label }` to the first recognized nav array that
 * doesn't already contain this route. Idempotent — calling it again with
 * the same route is a no-op.
 */
export function addNavLink(content: string, route: string, label: string): NavPatchResult {
  const arr = findNavArray(content);
  if (!arr) return { patched: content, changed: false };

  const body = content.slice(arr.start + 1, arr.end);
  if (body.includes(`'${route}'`) || body.includes(`"${route}"`)) {
    return { patched: content, changed: false }; // already linked
  }

  const trimmedBody = body.replace(/,?\s*$/, '');
  const entry = `{ href: '${route}', label: '${label}' }`;
  const newBody = trimmedBody.length > 0 ? `${trimmedBody}, ${entry}` : entry;
  const patched = content.slice(0, arr.start + 1) + newBody + content.slice(arr.end);
  return { patched, changed: true };
}

/** Title-cases a route's last segment into a nav label — e.g. "/meal-plan" -> "Meal Plan". */
export function routeToLabel(route: string): string {
  const seg = route.split('/').filter(Boolean).pop() ?? route;
  return seg.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
