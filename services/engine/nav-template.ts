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
 */

export interface NavPatchResult { patched: string; changed: boolean }

const NAV_ARRAY_NAME_RE = /\b(navLinks|navItems|NAV_ITEMS|menuItems|MENU_ITEMS|links|sidebarLinks|sidebarItems|SIDEBAR_ITEMS)\b/;

/**
 * Finds the first `[ ... ]` array literal that (a) is assigned to a
 * recognized nav-array name and (b) contains at least one `href:` entry
 * (distinguishing a real link list from an unrelated array with the same
 * name). Returns the array's content bounds so the caller can splice a new
 * entry in before the closing bracket.
 */
function findNavArray(content: string): { start: number; end: number; declStart: number } | null {
  const declRe = new RegExp(`(?:const|let)\\s+${NAV_ARRAY_NAME_RE.source}\\s*=`, 'g');
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(content))) {
    // From the declaration, scan forward to the first `[` — skipping over a
    // ternary condition (`user ?`) if present, since the logged-in list
    // (the one a newly protected page belongs in) is conventionally first.
    let i = declRe.lastIndex;
    const bracketIdx = content.indexOf('[', i);
    if (bracketIdx === -1 || bracketIdx - i > 80) continue; // too far — not this array
    // Walk to the matching close, tracking bracket depth so nested `{ }`/`[ ]`
    // inside link objects (icons, nested arrays) don't end the scan early.
    let depth = 0, end = -1;
    for (let j = bracketIdx; j < content.length; j++) {
      if (content[j] === '[') depth++;
      else if (content[j] === ']') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end === -1) continue;
    const body = content.slice(bracketIdx + 1, end);
    if (!/href\s*:/.test(body)) continue; // not a link array
    return { start: bracketIdx, end, declStart: m.index };
  }
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
