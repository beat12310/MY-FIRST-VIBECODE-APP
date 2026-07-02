/**
 * Deterministic database schema verification.
 *
 * Root cause this addresses: this template's schema is defined entirely as
 * SQL strings embedded in route files — each generated CRUD route calls
 * `initTable(\`CREATE TABLE IF NOT EXISTS <name> (...)\`)` at import time
 * (confirmed live: every sampled route follows this shape). crud-template.ts
 * always keeps its own initTable call and its own queries in sync, but
 * nothing previously verified that EVERY table/column a query anywhere in
 * the app actually references has a matching schema — if the model writes
 * a custom route bypassing the template (or a query drifts out of sync with
 * its own table's columns), the first sign is a runtime "no such table" or
 * "no such column" SQL error, not a build-time signal.
 *
 * This module extracts the KNOWN schema (every initTable call, anywhere in
 * the codebase) and every db.get/all/run() query's referenced table/columns,
 * then cross-references them — the same "detect the gap deterministically,
 * synthesize a fix from what's actually referenced" pattern already used for
 * orphaned API routes.
 */

export interface TableSchema { columns: Set<string>; foreignKeys: { col: string; refTable: string; refCol: string }[] }
export interface QueryRef { file: string; table: string; columns: string[]; kind: 'select' | 'insert' | 'update' | 'delete' }

const CONSTRAINT_RE = /^(PRIMARY KEY|FOREIGN KEY|UNIQUE|CHECK|CONSTRAINT)\b/i;

/** Splits a CREATE TABLE body on top-level commas, respecting nested parens. */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (s[i] === ',' && depth === 0) { parts.push(s.slice(start, i)); start = i + 1; }
  }
  parts.push(s.slice(start));
  return parts.map(p => p.trim()).filter(Boolean);
}

export function parseCreateTable(sql: string): { name: string; schema: TableSchema } | null {
  const m = sql.match(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(\w+)\s*\(([\s\S]*)\)\s*$/i);
  if (!m) return null;
  const columns = new Set<string>();
  const foreignKeys: TableSchema['foreignKeys'] = [];
  for (const part of splitTopLevel(m[2])) {
    if (CONSTRAINT_RE.test(part)) {
      const fk = part.match(/FOREIGN KEY\s*\(\s*(\w+)\s*\)\s*REFERENCES\s+(\w+)\s*\(\s*(\w+)\s*\)/i);
      if (fk) foreignKeys.push({ col: fk[1], refTable: fk[2], refCol: fk[3] });
      continue;
    }
    const col = part.match(/^(\w+)/);
    if (col) columns.add(col[1]);
  }
  return { name: m[1], schema: { columns, foreignKeys } };
}

/** Extracts the known schema from every initTable() call across the codebase. Later calls for the SAME table merge in (rather than overwrite), matching SQLite's own additive CREATE TABLE IF NOT EXISTS semantics. */
export function extractSchema(files: { path: string; content: string }[]): Map<string, TableSchema> {
  const schema = new Map<string, TableSchema>();
  const initTableRe = /initTable\(\s*[`'"]([\s\S]*?)[`'"]\s*\)/g;
  for (const f of files) {
    let m: RegExpExecArray | null;
    const re = new RegExp(initTableRe);
    while ((m = re.exec(f.content))) {
      const parsed = parseCreateTable(m[1]);
      if (!parsed) continue;
      const existing = schema.get(parsed.name);
      if (existing) {
        parsed.schema.columns.forEach(c => existing.columns.add(c));
        existing.foreignKeys.push(...parsed.schema.foreignKeys);
      } else {
        schema.set(parsed.name, parsed.schema);
      }
    }

    // addColumnIfMissing() calls (the deterministic repair fast-path for a
    // missing column) must ALSO update the known schema — otherwise the
    // schema this function reports never reflects a column that was
    // correctly added this way, and re-verification after a repair keeps
    // reporting the same "missing column" gap forever even though the
    // actual database would have the column. initTable()'s CREATE TABLE
    // parsing can't see this on its own, since the column isn't declared
    // there at all.
    const addColRe = /addColumnIfMissing\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/g;
    while ((m = addColRe.exec(f.content))) {
      const [, table, column] = m;
      const existing = schema.get(table);
      if (existing) existing.columns.add(column);
      else schema.set(table, { columns: new Set([column]), foreignKeys: [] });
    }
  }
  return schema;
}

/**
 * Extracts every db.get/all/run() query's target table and the columns it
 * references. INSERT column lists and UPDATE/WHERE `col = ?` patterns are
 * reliably parseable; a bare `SELECT *` contributes no column references
 * (nothing to check), which is intentional — this only flags columns the
 * query ITSELF names, never invents an expectation from nothing.
 */
export function extractQueryReferences(files: { path: string; content: string }[]): QueryRef[] {
  const refs: QueryRef[] = [];
  const queryRe = /db\.(get|all|run)\(\s*[`'"]([\s\S]*?)[`'"]/g;
  for (const f of files) {
    if (!/\.(tsx?|jsx?)$/.test(f.path)) continue;
    let m: RegExpExecArray | null;
    const re = new RegExp(queryRe);
    while ((m = re.exec(f.content))) {
      const sql = m[2];
      const insertMatch = sql.match(/INSERT INTO\s+(\w+)\s*\(([^)]+)\)/i);
      if (insertMatch) {
        refs.push({ file: f.path, table: insertMatch[1], columns: insertMatch[2].split(',').map(c => c.trim()), kind: 'insert' });
        continue;
      }
      const updateMatch = sql.match(/UPDATE\s+(\w+)\s+SET\s+([\s\S]+?)(?:\s+WHERE|$)/i);
      if (updateMatch) {
        const cols = [...updateMatch[2].matchAll(/(\w+)\s*=\s*\?/g)].map(mm => mm[1]);
        const whereCols = [...sql.slice(sql.search(/WHERE/i) + 1).matchAll(/(\w+)\s*=\s*\?/g)].map(mm => mm[1]);
        refs.push({ file: f.path, table: updateMatch[1], columns: [...cols, ...whereCols], kind: 'update' });
        continue;
      }
      const fromMatch = sql.match(/FROM\s+(\w+)/i);
      const deleteMatch = sql.match(/DELETE FROM\s+(\w+)/i);
      const table = fromMatch?.[1] ?? deleteMatch?.[1];
      if (table) {
        const whereCols = [...sql.matchAll(/(\w+)\s*=\s*\?/g)].map(mm => mm[1]);
        refs.push({ file: f.path, table, columns: whereCols, kind: deleteMatch ? 'delete' : 'select' });
      }
    }
  }
  return refs;
}

export interface SchemaGap {
  kind: 'missing-table' | 'missing-column' | 'dangling-foreign-key';
  table: string;
  column?: string;
  file: string;
  columns?: string[]; // for missing-table: every column any query referenced, for synthesis
}

/** Cross-references the known schema against every query's references. */
export function detectSchemaGaps(schema: Map<string, TableSchema>, refs: QueryRef[]): SchemaGap[] {
  const gaps: SchemaGap[] = [];
  const missingTableColumns = new Map<string, Set<string>>();
  for (const ref of refs) {
    const table = schema.get(ref.table);
    if (!table) {
      if (!missingTableColumns.has(ref.table)) missingTableColumns.set(ref.table, new Set());
      ref.columns.forEach(c => missingTableColumns.get(ref.table)!.add(c));
      continue;
    }
    for (const col of ref.columns) {
      if (!table.columns.has(col)) {
        gaps.push({ kind: 'missing-column', table: ref.table, column: col, file: ref.file });
      }
    }
  }
  for (const [table, cols] of missingTableColumns) {
    const firstRef = refs.find(r => r.table === table);
    gaps.push({ kind: 'missing-table', table, file: firstRef!.file, columns: [...cols] });
  }
  for (const [tableName, tableSchema] of schema) {
    for (const fk of tableSchema.foreignKeys) {
      if (!schema.has(fk.refTable)) {
        gaps.push({ kind: 'dangling-foreign-key', table: tableName, column: fk.col, file: `references missing table ${fk.refTable}` });
      }
    }
  }
  return gaps;
}

/** Synthesizes a minimal CREATE TABLE statement from a set of referenced column names. */
export function synthesizeTableSchema(table: string, columns: string[]): string {
  const cols = columns.length > 0
    ? columns.map(c => c === 'id' ? '  id TEXT PRIMARY KEY' : `  ${c} TEXT`).join(',\n')
    : '  id TEXT PRIMARY KEY';
  const hasId = columns.includes('id');
  const body = hasId ? cols : `  id TEXT PRIMARY KEY,\n${cols}`;
  return `CREATE TABLE IF NOT EXISTS ${table} (\n${body}\n)`;
}
