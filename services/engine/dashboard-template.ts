/**
 * Deterministic dashboard-widget patcher.
 *
 * Root cause this fixes: project-generator.ts's auditAndRepairDashboard()
 * already has a deterministic RESOURCES/NAV_ITEMS array mechanism that
 * drives the dashboard's stat-count widgets — but it only REPLACES the
 * dashboard file wholesale, and only when the existing dashboard looks like
 * a stub. It also runs BEFORE builder.ts's fillMissing pass adds API routes
 * the AI's first response omitted — the same ordering bug fixed for
 * middleware.ts last phase, just for the dashboard template. Confirmed
 * live: a 5-resource app shipped `const RESOURCES = [];` (empty) because
 * the template ran against an incomplete API-route snapshot, and once the
 * dashboard had ANY real content, auditAndRepairDashboard never touched it
 * again — so the gap was permanent, not just a one-time miss.
 *
 * This patcher instead ADDS a missing resource entry to an EXISTING
 * RESOURCES array, surgically — working regardless of whether the dashboard
 * came from the template or was authored by the model, and regardless of
 * when the underlying API route was created (fillMissing, repair, or a
 * later edit).
 */

export interface DashboardPatchResult { patched: string; changed: boolean }

const RESOURCES_ARRAY_NAME_RE = /\b(RESOURCES|resources|dashboardResources|DASHBOARD_RESOURCES)\b/;

function findResourcesArray(content: string): { start: number; end: number } | null {
  const declRe = new RegExp(`(?:const|let)\\s+${RESOURCES_ARRAY_NAME_RE.source}\\s*=`, 'g');
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(content))) {
    const i = declRe.lastIndex;
    const bracketIdx = content.indexOf('[', i);
    if (bracketIdx === -1 || bracketIdx - i > 20) continue;
    let depth = 0, end = -1;
    for (let j = bracketIdx; j < content.length; j++) {
      if (content[j] === '[') depth++;
      else if (content[j] === ']') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end === -1) continue;
    return { start: bracketIdx, end };
  }
  return null;
}

/**
 * Adds `{ key, label, href, apiPath }` to the first recognized RESOURCES
 * array that doesn't already reference this API path. Idempotent.
 */
export function addDashboardResource(
  content: string, key: string, label: string, href: string, apiPath: string,
): DashboardPatchResult {
  const arr = findResourcesArray(content);
  if (!arr) return { patched: content, changed: false };

  const body = content.slice(arr.start + 1, arr.end);
  if (body.includes(`'${apiPath}'`) || body.includes(`"${apiPath}"`)) {
    return { patched: content, changed: false }; // already wired
  }

  const trimmedBody = body.replace(/,?\s*$/, '');
  const entry = `{ key: '${key}', label: '${label}', href: '${href}', apiPath: '${apiPath}' }`;
  const newBody = trimmedBody.length > 0 ? `${trimmedBody}, ${entry}` : entry;
  const patched = content.slice(0, arr.start + 1) + newBody + content.slice(arr.end);
  return { patched, changed: true };
}
