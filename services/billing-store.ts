/**
 * Durable billing store — single-table design.
 *
 * PRODUCTION: DynamoDB (set BILLING_TABLE + AWS creds/role). SDK is lazy-imported
 *   so the package is only required when actually using DynamoDB.
 * DEV/TEST: a local JSON file under .billing-data/ (NOT /tmp, gitignored). The
 *   store warns loudly if it falls back to local while NODE_ENV=production.
 *
 * Key scheme (one table):
 *   USER#<id> | SUB                 → subscription
 *   USER#<id> | WALLET              → credit balance
 *   USER#<id> | LEDGER#<ts>#<rand>  → credit movement
 *   USER#<id> | PAYMENT#<reference> → payment record
 *   USER#<id> | DOMAIN#<domain>     → domain order
 *   PAYREF#<reference> | PAYMENT    → reference→payment pointer (webhook lookup)
 */
import { join } from 'path';
import { mkdir, readFile, writeFile } from 'fs/promises';

export interface StoreItem { pk: string; sk: string; [k: string]: unknown; }

const TABLE = process.env.BILLING_TABLE?.trim();
const REGION = process.env.AWS_REGION || 'us-east-1';

export function isDurable(): boolean { return !!TABLE; }

if (!TABLE && process.env.NODE_ENV === 'production') {
  console.warn('[billing-store] ⚠️  BILLING_TABLE not set in production — billing is using the LOCAL file fallback and will NOT persist. Set BILLING_TABLE to a DynamoDB table.');
}

// ── DynamoDB backend (lazy) ──────────────────────────────────────────────────
let _doc: { send: (cmd: unknown) => Promise<unknown> } | null = null;
let _cmds: Record<string, new (i: unknown) => unknown> | null = null;
async function ddb() {
  if (_doc && _cmds) return { doc: _doc, cmds: _cmds };
  // webpackIgnore: don't resolve/bundle the AWS SDK at build time. It's only loaded
  // at runtime when BILLING_TABLE is set (production). Locally the file fallback runs
  // and these imports never execute, so the package need not be installed for dev.
  const { DynamoDBClient } = await import(/* webpackIgnore: true */ '@aws-sdk/client-dynamodb');
  const lib = await import(/* webpackIgnore: true */ '@aws-sdk/lib-dynamodb');
  _doc = lib.DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION })) as unknown as typeof _doc;
  _cmds = {
    Get: lib.GetCommand as unknown as new (i: unknown) => unknown,
    Put: lib.PutCommand as unknown as new (i: unknown) => unknown,
    Query: lib.QueryCommand as unknown as new (i: unknown) => unknown,
    Delete: lib.DeleteCommand as unknown as new (i: unknown) => unknown,
  };
  return { doc: _doc!, cmds: _cmds! };
}

// ── Local file backend (dev) ─────────────────────────────────────────────────
const LOCAL_DIR = join(process.cwd(), '.billing-data');
const LOCAL_FILE = join(LOCAL_DIR, 'store.json');
async function readLocal(): Promise<Record<string, StoreItem>> {
  try { return JSON.parse(await readFile(LOCAL_FILE, 'utf-8')); } catch { return {}; }
}
async function writeLocal(map: Record<string, StoreItem>): Promise<void> {
  await mkdir(LOCAL_DIR, { recursive: true });
  await writeFile(LOCAL_FILE, JSON.stringify(map, null, 2), 'utf-8');
}
const keyOf = (pk: string, sk: string) => `${pk}||${sk}`;

// ── Public API ────────────────────────────────────────────────────────────────
export async function putItem(item: StoreItem): Promise<void> {
  if (TABLE) { const { doc, cmds } = await ddb(); await doc.send(new cmds.Put({ TableName: TABLE, Item: item })); return; }
  const m = await readLocal(); m[keyOf(item.pk, item.sk)] = item; await writeLocal(m);
}

export async function getItem(pk: string, sk: string): Promise<StoreItem | null> {
  if (TABLE) { const { doc, cmds } = await ddb(); const r = await doc.send(new cmds.Get({ TableName: TABLE, Key: { pk, sk } })) as { Item?: StoreItem }; return r.Item ?? null; }
  const m = await readLocal(); return m[keyOf(pk, sk)] ?? null;
}

export async function queryItems(pk: string, skPrefix?: string): Promise<StoreItem[]> {
  if (TABLE) {
    const { doc, cmds } = await ddb();
    const params: Record<string, unknown> = {
      TableName: TABLE,
      KeyConditionExpression: skPrefix ? 'pk = :pk AND begins_with(sk, :sk)' : 'pk = :pk',
      ExpressionAttributeValues: skPrefix ? { ':pk': pk, ':sk': skPrefix } : { ':pk': pk },
    };
    const r = await doc.send(new cmds.Query(params)) as { Items?: StoreItem[] };
    return r.Items ?? [];
  }
  const m = await readLocal();
  return Object.values(m).filter(i => i.pk === pk && (!skPrefix || i.sk.startsWith(skPrefix)));
}

export async function deleteItem(pk: string, sk: string): Promise<void> {
  if (TABLE) { const { doc, cmds } = await ddb(); await doc.send(new cmds.Delete({ TableName: TABLE, Key: { pk, sk } })); return; }
  const m = await readLocal(); delete m[keyOf(pk, sk)]; await writeLocal(m);
}

/** Scan helper for the admin revenue route (dev: full map; prod: paginated Query per-user is preferred, but a Scan is acceptable for a low-volume admin view). */
export async function scanAll(): Promise<StoreItem[]> {
  if (TABLE) {
    const { DynamoDBClient } = await import(/* webpackIgnore: true */ '@aws-sdk/client-dynamodb');
    const lib = await import(/* webpackIgnore: true */ '@aws-sdk/lib-dynamodb');
    const doc = lib.DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
    const out: StoreItem[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined = undefined;
    do {
      const r = await doc.send(new lib.ScanCommand({ TableName: TABLE, ExclusiveStartKey })) as { Items?: StoreItem[]; LastEvaluatedKey?: Record<string, unknown> };
      out.push(...(r.Items ?? []));
      ExclusiveStartKey = r.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return out;
  }
  return Object.values(await readLocal());
}
