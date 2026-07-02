/**
 * Deterministic SQLite FTS5-backed search indexing.
 *
 * Architecture decision (proposed and confirmed with the user before this
 * was built): SQLite FTS5 virtual tables, not an external search service.
 * This is the only option consistent with the existing zero-config managed-
 * service architecture (lib/managed/db.ts, auth.ts, email.ts, ...) — no
 * external account, no API keys, works immediately, matches the "content='
 * table" external-content pattern (verified working live with real
 * better-sqlite3, including insert/update/delete sync via triggers).
 * Trade-off, accepted knowingly: basic full-text matching only (no typo-
 * tolerance, no faceting), and it scales poorly past roughly 100k rows —
 * acceptable for the scale of apps this engine generates.
 *
 * Scope is deliberately narrow to avoid overlapping with the ALREADY-LOCKED
 * api-registration rule, which owns "does this API route exist at all" (and
 * intentionally declines to synthesize routes named "search", deferring to
 * the model, since a generic CRUD template is the wrong shape for a search
 * endpoint). This module and its integration rule never create or rewrite
 * an API route — they only ensure the underlying FTS5 index exists for
 * whatever table an EXISTING search-named route queries, so that route (however
 * it was created) has real, working search infrastructure to call into via
 * searchRows() instead of a naive LIKE query or nothing at all.
 */

export interface SearchIndexFile { filePath: string; content: string }

export const SEARCH_SERVICE_PATH = 'lib/managed/search.ts';

/**
 * Two independent signals for "this file implements a search feature",
 * confirmed necessary by live evidence: a dedicated .../search/route.ts
 * file, AND a query-param-driven search embedded in an EXISTING resource
 * route. Confirmed live: asked to "add a search feature" via the edit
 * pipeline, the model added `searchParams.get('q')` + a `LOWER(name) LIKE ?`
 * clause directly to the existing /api/products route rather than creating
 * a separate endpoint — the dedicated-route-only signal completely missed
 * this, reporting zero gaps for a real, live, naive-search implementation
 * with no FTS5 infrastructure at all.
 */
const SEARCH_ROUTE_RE = /(?:^|\/)search\/route\.[jt]sx?$/;
const QUERY_PARAM_SEARCH_RE = /searchParams\.get\(\s*['"](?:q|search|query)['"]\s*\)/;
const LIKE_OPERATOR_RE = /\bLIKE\b/i;

export function isSearchFeatureFile(f: { path: string; content: string }): boolean {
  return SEARCH_ROUTE_RE.test(f.path) || (QUERY_PARAM_SEARCH_RE.test(f.content) && LIKE_OPERATOR_RE.test(f.content));
}

/** Columns unlikely to be useful in a full-text index (ids, timestamps, foreign keys). */
const NON_INDEXABLE_COLUMN_RE = /^(id|.*_id|.*_at|created|updated)$/i;

export function indexableColumns(columns: string[]): string[] {
  return columns.filter(c => !NON_INDEXABLE_COLUMN_RE.test(c));
}

export function buildSearchService(): SearchIndexFile {
  return {
    filePath: SEARCH_SERVICE_PATH,
    content: `import { initTable, db } from './db';

/**
 * Ensures an FTS5 virtual table + insert/update/delete sync triggers exist
 * for <table>, indexing the given columns. Idempotent (IF NOT EXISTS on the
 * virtual table and every trigger), safe to call on every import alongside
 * initTable() — matching the exact same convention.
 */
export function ensureSearchIndex(table: string, columns: string[]): void {
  const cols = columns.join(', ');
  const newCols = columns.map((c) => \`new.\${c}\`).join(', ');
  const oldCols = columns.map((c) => \`old.\${c}\`).join(', ');
  initTable(\`CREATE VIRTUAL TABLE IF NOT EXISTS \${table}_fts USING fts5(\${cols}, content='\${table}', content_rowid='rowid')\`);
  initTable(\`CREATE TRIGGER IF NOT EXISTS \${table}_ai AFTER INSERT ON \${table} BEGIN
  INSERT INTO \${table}_fts(rowid, \${cols}) VALUES (new.rowid, \${newCols});
END\`);
  initTable(\`CREATE TRIGGER IF NOT EXISTS \${table}_ad AFTER DELETE ON \${table} BEGIN
  INSERT INTO \${table}_fts(\${table}_fts, rowid, \${cols}) VALUES ('delete', old.rowid, \${oldCols});
END\`);
  initTable(\`CREATE TRIGGER IF NOT EXISTS \${table}_au AFTER UPDATE ON \${table} BEGIN
  INSERT INTO \${table}_fts(\${table}_fts, rowid, \${cols}) VALUES ('delete', old.rowid, \${oldCols});
  INSERT INTO \${table}_fts(rowid, \${cols}) VALUES (new.rowid, \${newCols});
END\`);
}

/** Full-text search over a table indexed by ensureSearchIndex(). */
export function searchRows<T = Record<string, unknown>>(table: string, query: string): T[] {
  return db.all<T>(
    \`SELECT \${table}.* FROM \${table} JOIN \${table}_fts ON \${table}.rowid = \${table}_fts.rowid WHERE \${table}_fts MATCH ?\`,
    query,
  );
}
`,
  };
}

/** Does a search.ts file already have an ensureSearchIndex() call for this table? */
export function hasSearchIndex(searchServiceContent: string, table: string): boolean {
  return new RegExp(`ensureSearchIndex\\(\\s*['"]${table}['"]`).test(searchServiceContent);
}

/** Adds an ensureSearchIndex(table, columns) call. Idempotent per table. */
export function addSearchIndexCall(
  searchServiceContent: string, table: string, columns: string[],
): { patched: string; changed: boolean } {
  if (hasSearchIndex(searchServiceContent, table)) return { patched: searchServiceContent, changed: false };
  const call = `ensureSearchIndex('${table}', [${columns.map(c => `'${c}'`).join(', ')}]);\n`;
  return { patched: searchServiceContent + '\n' + call, changed: true };
}
