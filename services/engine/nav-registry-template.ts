/**
 * Deterministic navigation registry — an engine-owned, machine-editable
 * source of truth for what pages a generated app's navigation SHOULD
 * contain, independent of however Navbar.tsx/Footer.tsx/Sidebar.tsx happen
 * to be authored.
 *
 * Root cause this fixes: nav-template.ts's addNavLink() patches Navbar.tsx's
 * OWN array literal, which works well for the common single-array shape but
 * has to decline safely whenever a file has multiple anonymous arrays
 * (confirmed live: a Footer.tsx with separate "Explore"/"Account" sections,
 * each its own unnamed array) — guessing which one to touch risks silently
 * adding a link to the wrong section. That's a correct, safe decision, but
 * it means "does this app's navigation reflect every page" can never be
 * fully deterministic as long as the ONLY record of nav state lives inside
 * arbitrary, model-authored JSX.
 *
 * This module generates a SEPARATE, ENGINE-CONTROLLED file
 * (lib/managed/navigation.ts, injected the same way as lib/managed/db.ts
 * and lib/managed/auth.ts) whose shape is ALWAYS exactly the same: a single
 * `export const NAV_ITEMS: NavEntry[]` array. Because the engine — not the
 * model — owns this file's shape completely, add/update/remove/reorder
 * operations on it are reliable by construction: there is never a "which of
 * several arrays" ambiguity, because there is only ever one.
 *
 * This does NOT replace nav-template.ts's Navbar/Footer patcher, which
 * still exists as a best-effort mechanism for keeping the RENDERED UI in
 * sync (and may still decline for the same safety reasons as before). What
 * changes is that the engine's own tracking of "is every page correctly
 * registered in navigation" moves to this always-reliable registry, rather
 * than depending entirely on parsing whatever JSX the model wrote.
 */

import type { PlannedPage } from './types';
import { NAV_EXCLUDE_RE, routeToLabel } from './nav-template';

export interface NavEntry { id: string; href: string; label: string; order: number }
export interface NavRegistryFile { filePath: string; content: string }

export const NAV_REGISTRY_PATH = 'lib/managed/navigation.ts';

/** Route -> stable identifier, e.g. "/meal-plan" -> "meal-plan", "/" -> "home". */
export function idFromRoute(route: string): string {
  const id = route.replace(/^\/+/, '').replace(/\/+/g, '-').replace(/[[\]]/g, '');
  return id || 'home';
}

/**
 * Derives the initial registry contents from the plan's pages — the same
 * exclusion rule (auth-flow pages, dynamic detail routes, home) the
 * navigation Integration Rule already uses, so what the registry expects
 * and what the rule checks for never disagree.
 */
export function deriveNavEntriesFromPages(pages: PlannedPage[]): NavEntry[] {
  return pages
    .filter(p => p.route !== '/' && !p.dynamic && !p.route.includes('[') && !NAV_EXCLUDE_RE.test(p.route))
    .map((p, i) => ({ id: idFromRoute(p.route), href: p.route, label: p.title || routeToLabel(p.route), order: i }));
}

function entrySource(e: NavEntry): string {
  return `  { id: '${e.id}', href: '${e.href}', label: '${e.label.replace(/'/g, "\\'")}', order: ${e.order} },`;
}

export function buildNavigationRegistry(entries: NavEntry[]): NavRegistryFile {
  const body = entries.map(entrySource).join('\n');
  return {
    filePath: NAV_REGISTRY_PATH,
    content: `export interface NavEntry { id: string; href: string; label: string; order: number }

export const NAV_ITEMS: NavEntry[] = [
${body}
];
`,
  };
}

/** Depth-balanced walk from an opening `[` to its matching `]`, or -1. */
function matchArrayEnd(content: string, bracketIdx: number): number {
  let depth = 0;
  for (let j = bracketIdx; j < content.length; j++) {
    if (content[j] === '[') depth++;
    else if (content[j] === ']') { depth--; if (depth === 0) return j; }
  }
  return -1;
}

/** Finds the NAV_ITEMS array's bounds in a registry file. Null if the file doesn't match the expected shape. */
function findRegistryArray(content: string): { start: number; end: number } | null {
  const m = /export const NAV_ITEMS: NavEntry\[\] = /.exec(content);
  if (!m) return null;
  const bracketIdx = content.indexOf('[', m.index + m[0].length);
  if (bracketIdx === -1 || bracketIdx - (m.index + m[0].length) > 5) return null;
  const end = matchArrayEnd(content, bracketIdx);
  if (end === -1) return null;
  return { start: bracketIdx, end };
}

function parseEntries(content: string, bounds: { start: number; end: number }): { raw: string; id: string }[] {
  const body = content.slice(bounds.start + 1, bounds.end);
  const entryRe = /\{\s*id:\s*'([^']+)'[^}]*\}/g;
  const out: { raw: string; id: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(body))) out.push({ raw: m[0], id: m[1] });
  return out;
}

/** Adds an entry to NAV_ITEMS. Idempotent on `id`. */
export function addRegistryEntry(content: string, entry: NavEntry): NavRegistryFile & { changed: boolean } {
  const bounds = findRegistryArray(content);
  if (!bounds) return { filePath: NAV_REGISTRY_PATH, content, changed: false };
  const existing = parseEntries(content, bounds);
  if (existing.some(e => e.id === entry.id)) return { filePath: NAV_REGISTRY_PATH, content, changed: false };

  const body = content.slice(bounds.start + 1, bounds.end).replace(/,?\s*$/, '');
  const newEntry = entrySource(entry).trim();
  const newBody = body.length > 0 ? `${body},\n  ${newEntry}\n` : `\n  ${newEntry}\n`;
  const patched = content.slice(0, bounds.start + 1) + newBody + content.slice(bounds.end);
  return { filePath: NAV_REGISTRY_PATH, content: patched, changed: true };
}

/** Removes an entry by id. No-op (changed: false) if the id isn't present. */
export function removeRegistryEntry(content: string, id: string): NavRegistryFile & { changed: boolean } {
  const bounds = findRegistryArray(content);
  if (!bounds) return { filePath: NAV_REGISTRY_PATH, content, changed: false };
  const existing = parseEntries(content, bounds);
  const target = existing.find(e => e.id === id);
  if (!target) return { filePath: NAV_REGISTRY_PATH, content, changed: false };

  const body = content.slice(bounds.start + 1, bounds.end);
  const idx = body.indexOf(target.raw);
  // Remove the entry plus one trailing comma (and any following whitespace/
  // newline) so the array stays syntactically valid, or a leading comma if
  // it was the last entry.
  let removeEnd = idx + target.raw.length;
  const afterMatch = body.slice(removeEnd).match(/^\s*,/);
  if (afterMatch) {
    removeEnd += afterMatch[0].length;
  } else {
    const beforeComma = body.slice(0, idx).match(/,\s*$/);
    if (beforeComma) {
      const beforeStart = idx - beforeComma[0].length;
      const newBody = body.slice(0, beforeStart) + body.slice(removeEnd);
      const patched = content.slice(0, bounds.start + 1) + newBody + content.slice(bounds.end);
      return { filePath: NAV_REGISTRY_PATH, content: patched, changed: true };
    }
  }
  const newBody = body.slice(0, idx) + body.slice(removeEnd);
  const patched = content.slice(0, bounds.start + 1) + newBody + content.slice(bounds.end);
  return { filePath: NAV_REGISTRY_PATH, content: patched, changed: true };
}

/** Updates an entry's href/label/order by id. No-op if the id isn't present. */
export function updateRegistryEntry(
  content: string, id: string, updates: Partial<Pick<NavEntry, 'href' | 'label' | 'order'>>,
): NavRegistryFile & { changed: boolean } {
  const bounds = findRegistryArray(content);
  if (!bounds) return { filePath: NAV_REGISTRY_PATH, content, changed: false };
  const existing = parseEntries(content, bounds);
  const target = existing.find(e => e.id === id);
  if (!target) return { filePath: NAV_REGISTRY_PATH, content, changed: false };

  const hrefM = /href:\s*'([^']*)'/.exec(target.raw);
  const labelM = /label:\s*'((?:[^'\\]|\\.)*)'/.exec(target.raw);
  const orderM = /order:\s*(\d+)/.exec(target.raw);
  const merged: NavEntry = {
    id,
    href: updates.href ?? hrefM?.[1] ?? '',
    label: updates.label ?? labelM?.[1] ?? '',
    order: updates.order ?? Number(orderM?.[1] ?? 0),
  };
  const body = content.slice(bounds.start + 1, bounds.end);
  const idx = body.indexOf(target.raw);
  // entrySource() ends with a trailing comma of its own; strip it here since
  // the body already has its OWN trailing comma (or lack thereof) right
  // after target.raw's position, which this splice deliberately leaves
  // untouched — keeping it meant a double comma after every update.
  const replacement = entrySource(merged).trim().replace(/,$/, '');
  const newBody = body.slice(0, idx) + replacement + body.slice(idx + target.raw.length);
  const patched = content.slice(0, bounds.start + 1) + newBody + content.slice(bounds.end);
  return { filePath: NAV_REGISTRY_PATH, content: patched, changed: true };
}

/**
 * Reorders NAV_ITEMS to match `orderedIds` (entries not listed keep their
 * relative order, appended after the ones that were reordered), rewriting
 * every entry's `order` field to match its new position.
 */
export function reorderRegistryEntries(content: string, orderedIds: string[]): NavRegistryFile & { changed: boolean } {
  const bounds = findRegistryArray(content);
  if (!bounds) return { filePath: NAV_REGISTRY_PATH, content, changed: false };
  const existing = parseEntries(content, bounds);
  const byId = new Map(existing.map(e => [e.id, e]));
  const orderedRaw = [
    ...orderedIds.map(id => byId.get(id)).filter((e): e is { raw: string; id: string } => !!e),
    ...existing.filter(e => !orderedIds.includes(e.id)),
  ];
  if (orderedRaw.length !== existing.length) return { filePath: NAV_REGISTRY_PATH, content, changed: false };

  const newBody = '\n' + orderedRaw.map((e, i) => {
    const withOrder = e.raw.replace(/order:\s*\d+/, `order: ${i}`);
    return `  ${withOrder},`;
  }).join('\n') + '\n';
  const patched = content.slice(0, bounds.start + 1) + newBody + content.slice(bounds.end);
  return { filePath: NAV_REGISTRY_PATH, content: patched, changed: true };
}
