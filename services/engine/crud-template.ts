/**
 * Deterministic CRUD API route templates — zero-cost fallback for the standard
 * list/detail shape the Planner always produces for a resource (planner.ts's
 * planApiRoutes: GET+POST on /api/{resource}, GET+PUT+DELETE on
 * /api/{resource}/[id]), backed by lib/managed/db.ts (injected into every
 * generated project). When a missing/broken API route matches this shape,
 * the Builder/Repairer can write a real, working handler instantly instead of
 * spending a Bedrock call on boilerplate CRUD — freeing that budget for pages
 * and features that actually need creative generation.
 *
 * Falls back silently (returns null) for any route that doesn't match the
 * standard shape — those still go through the model as before.
 */
import type { PlannedApiRoute, PlannedDataModel } from './types';

export interface CrudFile { filePath: string; content: string }

const sameSet = (a: string[], b: string[]): boolean => {
  const as = new Set(a.map(s => s.toUpperCase()));
  const bs = new Set(b.map(s => s.toUpperCase()));
  return as.size === bs.size && [...as].every(m => bs.has(m));
};

/** Resource slug a planned API route belongs to, e.g. "/api/products/[id]" -> "products". */
function resourceOf(route: PlannedApiRoute): string | null {
  const m = route.route.match(/^\/api\/([a-z0-9-]+)(?:\/\[id\])?$/i);
  return m ? m[1] : null;
}

/** Matches planner.ts's own dataModel naming (titleCase(resource) with trailing 's' stripped). */
function titleCase(s: string): string {
  return s.replace(/[-_/]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
}
function modelNameForResource(resource: string): string {
  return titleCase(resource).replace(/s$/, '');
}

function toSnakeCase(name: string): string {
  return name.replace(/[A-Z]/g, l => '_' + l.toLowerCase()).replace(/^_/, '');
}

function columnsSql(model: PlannedDataModel | undefined): string {
  const fields = (model?.fields ?? [{ name: 'title', type: 'string' }, { name: 'createdAt', type: 'string' }])
    .filter(f => f.name !== 'id');
  const cols = fields.map(f => {
    const col = toSnakeCase(f.name);
    const sqlType = f.type === 'number' ? 'REAL' : 'TEXT';
    const notNull = /^(title|name)$/.test(col) ? ' NOT NULL' : '';
    const dflt = col === 'created_at' ? ' DEFAULT CURRENT_TIMESTAMP' : '';
    return `  ${col} ${sqlType}${notNull}${dflt}`;
  });
  return [`  id TEXT PRIMARY KEY`, ...cols].join(',\n');
}

function primaryTextColumn(model: PlannedDataModel | undefined): string {
  const f = model?.fields.find(f => f.name !== 'id' && f.type !== 'number');
  return f ? toSnakeCase(f.name) : 'title';
}

export function isStandardCrudRoute(route: PlannedApiRoute): boolean {
  const resource = resourceOf(route);
  if (!resource) return false;
  const isList = !route.filePath.includes('[id]') && sameSet(route.methods, ['GET', 'POST']);
  const isDetail = route.filePath.includes('[id]') && sameSet(route.methods, ['GET', 'PUT', 'DELETE']);
  return isList || isDetail;
}

/** Returns null if the route isn't the standard list/detail CRUD shape. */
export function buildCrudRoute(route: PlannedApiRoute, dataModels: PlannedDataModel[]): CrudFile | null {
  const resource = resourceOf(route);
  if (!resource || !isStandardCrudRoute(route)) return null;
  const table = toSnakeCase(resource);
  const model = dataModels.find(m => m.name === modelNameForResource(resource));
  const textCol = primaryTextColumn(model);
  const createTable = `CREATE TABLE IF NOT EXISTS ${table} (\n${columnsSql(model)}\n)`;

  if (route.filePath.includes('[id]')) {
    const content = `import { NextRequest, NextResponse } from 'next/server';
import { db, initTable } from '@/lib/managed/db';

initTable(\`${createTable}\`);

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const row = db.get('SELECT * FROM ${table} WHERE id = ?', params.id);
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(row);
}

export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  const existing = db.get('SELECT * FROM ${table} WHERE id = ?', params.id);
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  try {
    const body = await request.json();
    const next = { ...(existing as Record<string, unknown>), ...body };
    db.run('UPDATE ${table} SET ${textCol} = ? WHERE id = ?', next.${textCol}, params.id);
    return NextResponse.json(db.get('SELECT * FROM ${table} WHERE id = ?', params.id));
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const existing = db.get('SELECT * FROM ${table} WHERE id = ?', params.id);
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  db.run('DELETE FROM ${table} WHERE id = ?', params.id);
  return NextResponse.json({ success: true });
}
`;
    return { filePath: route.filePath, content };
  }

  const content = `import { NextRequest, NextResponse } from 'next/server';
import { db, initTable } from '@/lib/managed/db';
import crypto from 'crypto';

initTable(\`${createTable}\`);

export async function GET() {
  const rows = db.all('SELECT * FROM ${table} ORDER BY id DESC');
  return NextResponse.json(rows);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (!body.${textCol}) return NextResponse.json({ error: '${textCol} is required' }, { status: 400 });
    const id = crypto.randomUUID();
    db.run('INSERT INTO ${table} (id, ${textCol}) VALUES (?, ?)', id, body.${textCol});
    return NextResponse.json(db.get('SELECT * FROM ${table} WHERE id = ?', id), { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
}
`;
  return { filePath: route.filePath, content };
}
