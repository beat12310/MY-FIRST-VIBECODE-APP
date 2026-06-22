/**
 * Database Integrator — Feature 4
 * Generates scaffolding files for Supabase, PostgreSQL, DynamoDB, Firebase.
 * Writes client, query helpers, schema/migration files, and .env additions.
 */

export type DatabaseType = 'supabase' | 'postgresql' | 'dynamodb' | 'firebase';

export interface DbFile {
  path: string;
  content: string;
}

export interface DatabaseScaffold {
  files: DbFile[];
  envVars: { key: string; description: string }[];
  packages: string[];
  instructions: string[];
}

// ─── Supabase ─────────────────────────────────────────────────────────────────

function supabaseScaffold(resource: string): DatabaseScaffold {
  const R = resource.charAt(0).toUpperCase() + resource.slice(1);
  return {
    files: [
      {
        path: 'lib/db/supabase.ts',
        content: `import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

if (!url || !key) throw new Error('Missing Supabase env vars');

export const supabase = createClient(url, key);
`,
      },
      {
        path: `lib/db/queries/${resource}.ts`,
        content: `import { supabase } from '@/lib/db/supabase';

export async function getAll(filters?: Record<string, string>) {
  let q = supabase.from('${resource}').select('*');
  if (filters) {
    for (const [col, val] of Object.entries(filters)) {
      q = q.ilike(col, \`%\${val}%\`);
    }
  }
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function getById(id: string) {
  const { data, error } = await supabase.from('${resource}').select('*').eq('id', id).single();
  if (error) throw new Error(error.message);
  return data;
}

export async function create(record: Record<string, unknown>) {
  const { data, error } = await supabase.from('${resource}').insert(record).select().single();
  if (error) throw new Error(error.message);
  return data;
}

export async function update(id: string, updates: Record<string, unknown>) {
  const { data, error } = await supabase.from('${resource}').update(updates).eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return data;
}

export async function remove(id: string) {
  const { error } = await supabase.from('${resource}').delete().eq('id', id);
  if (error) throw new Error(error.message);
}
`,
      },
      {
        path: `lib/db/migrations/001_create_${resource}.sql`,
        content: `-- Migration: create ${resource} table
-- Run this in your Supabase SQL editor

CREATE TABLE IF NOT EXISTS ${resource} (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
  -- TODO: add your columns here
);

-- Enable Row Level Security
ALTER TABLE ${resource} ENABLE ROW LEVEL SECURITY;

-- Allow public read (adjust as needed)
CREATE POLICY "Allow public read" ON ${resource}
  FOR SELECT USING (true);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON ${resource}
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
`,
      },
    ],
    envVars: [
      { key: 'NEXT_PUBLIC_SUPABASE_URL', description: 'Your Supabase project URL (Settings > API)' },
      { key: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', description: 'Your Supabase anon/public key (Settings > API)' },
    ],
    packages: ['@supabase/supabase-js'],
    instructions: [
      '1. Create a Supabase project at supabase.com (free tier available)',
      '2. Go to Settings > API to find your URL and anon key',
      '3. Run the migration SQL in your Supabase SQL editor',
      `4. Update app/api/${resource}/route.ts to import from lib/db/queries/${resource}.ts instead of lib/data/${resource}.ts`,
      '5. Add credentials to .env.local and Paste into the sidebar credential panel',
    ],
  };
}

// ─── PostgreSQL ───────────────────────────────────────────────────────────────

function postgresScaffold(resource: string): DatabaseScaffold {
  return {
    files: [
      {
        path: 'lib/db/postgres.ts',
        content: `import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

export async function query<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const client = await pool.connect();
  try {
    const res = await client.query(sql, params);
    return res.rows as T[];
  } finally {
    client.release();
  }
}

export async function queryOne<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

export default pool;
`,
      },
      {
        path: `lib/db/queries/${resource}.ts`,
        content: `import { query, queryOne } from '@/lib/db/postgres';

export async function getAll(filters?: Record<string, string>) {
  const conditions: string[] = [];
  const values: string[] = [];

  if (filters) {
    let idx = 1;
    for (const [col, val] of Object.entries(filters)) {
      conditions.push(\`\${col} ILIKE $\${idx}\`);
      values.push(\`%\${val}%\`);
      idx++;
    }
  }

  const where = conditions.length > 0 ? \`WHERE \${conditions.join(' AND ')}\` : '';
  return query(\`SELECT * FROM ${resource} \${where} ORDER BY created_at DESC\`, values);
}

export async function getById(id: string) {
  return queryOne(\`SELECT * FROM ${resource} WHERE id = $1\`, [id]);
}

export async function create(record: Record<string, unknown>) {
  const cols = Object.keys(record).join(', ');
  const placeholders = Object.keys(record).map((_, i) => \`$\${i + 1}\`).join(', ');
  const vals = Object.values(record);
  return queryOne(\`INSERT INTO ${resource} (\${cols}) VALUES (\${placeholders}) RETURNING *\`, vals);
}

export async function update(id: string, updates: Record<string, unknown>) {
  const sets = Object.keys(updates).map((k, i) => \`\${k} = $\${i + 2}\`).join(', ');
  return queryOne(\`UPDATE ${resource} SET \${sets} WHERE id = $1 RETURNING *\`, [id, ...Object.values(updates)]);
}

export async function remove(id: string) {
  await query(\`DELETE FROM ${resource} WHERE id = $1\`, [id]);
}
`,
      },
      {
        path: `lib/db/migrations/001_create_${resource}.sql`,
        content: `-- Migration: create ${resource} table

CREATE TABLE IF NOT EXISTS ${resource} (
  id SERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
  -- TODO: add your columns here
);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON ${resource}
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
`,
      },
    ],
    envVars: [
      { key: 'DATABASE_URL', description: 'PostgreSQL connection string — postgresql://user:pass@host:5432/dbname' },
    ],
    packages: ['pg', '@types/pg'],
    instructions: [
      '1. Provision a PostgreSQL database (Neon, Railway, Supabase, or local)',
      '2. Copy the connection string into DATABASE_URL in .env.local',
      '3. Run the migration SQL against your database',
      `4. Import from lib/db/queries/${resource}.ts in your API route`,
    ],
  };
}

// ─── DynamoDB ─────────────────────────────────────────────────────────────────

function dynamoScaffold(resource: string): DatabaseScaffold {
  const TABLE = resource.toUpperCase().replace(/-/g, '_');
  return {
    files: [
      {
        path: 'lib/db/dynamodb.ts',
        content: `import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, DeleteCommand, ScanCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
  credentials: process.env.AWS_ACCESS_KEY_ID ? {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  } : undefined, // falls back to IAM role in production
});

export const docClient = DynamoDBDocumentClient.from(client);
export { GetCommand, PutCommand, UpdateCommand, DeleteCommand, ScanCommand, QueryCommand };
`,
      },
      {
        path: `lib/db/queries/${resource}.ts`,
        content: `import { docClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand } from '@/lib/db/dynamodb';
import { randomUUID } from 'crypto';

const TABLE = process.env.DYNAMODB_TABLE_${TABLE} ?? '${resource}';

export async function getAll(filters?: Record<string, string>) {
  const { Items = [] } = await docClient.send(new ScanCommand({ TableName: TABLE }));
  if (!filters || Object.keys(filters).length === 0) return Items;
  return Items.filter(item =>
    Object.entries(filters).every(([k, v]) =>
      String(item[k] ?? '').toLowerCase().includes(v.toLowerCase())
    )
  );
}

export async function getById(id: string) {
  const { Item } = await docClient.send(new GetCommand({ TableName: TABLE, Key: { id } }));
  return Item ?? null;
}

export async function create(record: Record<string, unknown>) {
  const item = { id: randomUUID(), createdAt: new Date().toISOString(), ...record };
  await docClient.send(new PutCommand({ TableName: TABLE, Item: item }));
  return item;
}

export async function update(id: string, updates: Record<string, unknown>) {
  const expr = Object.keys(updates).map((k, i) => \`#k\${i} = :v\${i}\`).join(', ');
  const names = Object.fromEntries(Object.keys(updates).map((k, i) => [\`#k\${i}\`, k]));
  const values = Object.fromEntries(Object.keys(updates).map((k, i) => [\`:v\${i}\`, updates[k]]));
  const { Attributes } = await docClient.send(new UpdateCommand({
    TableName: TABLE, Key: { id },
    UpdateExpression: \`SET \${expr}\`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ReturnValues: 'ALL_NEW',
  }));
  return Attributes;
}

export async function remove(id: string) {
  await docClient.send(new DeleteCommand({ TableName: TABLE, Key: { id } }));
}
`,
      },
    ],
    envVars: [
      { key: 'AWS_REGION', description: 'AWS region (e.g. us-east-1)' },
      { key: 'AWS_ACCESS_KEY_ID', description: 'AWS access key (or use IAM role in production)' },
      { key: 'AWS_SECRET_ACCESS_KEY', description: 'AWS secret access key' },
      { key: `DYNAMODB_TABLE_${TABLE}`, description: `DynamoDB table name for ${resource}` },
    ],
    packages: ['@aws-sdk/client-dynamodb', '@aws-sdk/lib-dynamodb'],
    instructions: [
      '1. Create a DynamoDB table in AWS Console with partition key: id (String)',
      `2. Set DYNAMODB_TABLE_${TABLE} to your table name in .env.local`,
      '3. AWS credentials from your existing .env.local will be reused',
      `4. Import from lib/db/queries/${resource}.ts in your API route`,
    ],
  };
}

// ─── Firebase ─────────────────────────────────────────────────────────────────

function firebaseScaffold(resource: string): DatabaseScaffold {
  return {
    files: [
      {
        path: 'lib/db/firebase.ts',
        content: `import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\\\n/g, '\\n'),
    }),
  });
}

export const db = getFirestore();
`,
      },
      {
        path: `lib/db/queries/${resource}.ts`,
        content: `import { db } from '@/lib/db/firebase';
import { FieldValue } from 'firebase-admin/firestore';

const col = db.collection('${resource}');

export async function getAll(filters?: Record<string, string>) {
  let q: FirebaseFirestore.Query = col;
  if (filters) {
    for (const [field, val] of Object.entries(filters)) {
      q = q.where(field, '>=', val).where(field, '<=', val + '');
    }
  }
  const snap = await q.get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function getById(id: string) {
  const doc = await col.doc(id).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

export async function create(record: Record<string, unknown>) {
  const ref = await col.add({ ...record, createdAt: FieldValue.serverTimestamp() });
  return { id: ref.id, ...record };
}

export async function update(id: string, updates: Record<string, unknown>) {
  await col.doc(id).update({ ...updates, updatedAt: FieldValue.serverTimestamp() });
  return getById(id);
}

export async function remove(id: string) {
  await col.doc(id).delete();
}
`,
      },
    ],
    envVars: [
      { key: 'FIREBASE_PROJECT_ID', description: 'Firebase project ID (Project Settings > General)' },
      { key: 'FIREBASE_CLIENT_EMAIL', description: 'Service account client email (Project Settings > Service Accounts)' },
      { key: 'FIREBASE_PRIVATE_KEY', description: 'Service account private key (Project Settings > Service Accounts)' },
    ],
    packages: ['firebase-admin'],
    instructions: [
      '1. Create a Firebase project at console.firebase.google.com',
      '2. Go to Project Settings > Service Accounts > Generate new private key',
      '3. Add FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY to .env.local',
      `4. Import from lib/db/queries/${resource}.ts in your API route`,
    ],
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function generateDatabaseScaffold(type: DatabaseType, resource: string): DatabaseScaffold {
  switch (type) {
    case 'supabase':   return supabaseScaffold(resource);
    case 'postgresql': return postgresScaffold(resource);
    case 'dynamodb':   return dynamoScaffold(resource);
    case 'firebase':   return firebaseScaffold(resource);
    default: throw new Error(`Unknown database type: ${type}`);
  }
}
