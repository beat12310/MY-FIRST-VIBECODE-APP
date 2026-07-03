/**
 * Deterministic in-app notifications, backed by the SAME managed SQLite
 * database every other managed service already uses.
 *
 * Audit before building (per this phase's explicit instruction to reuse
 * existing infrastructure): lib/managed/email.ts already exports a fully
 * working sendNotificationEmail(email, subject, message) — no new work
 * needed for email delivery, it's reused directly below. api-registration
 * already auto-synthesizes a missing /api/notifications CRUD route
 * (confirmed: "notifications" is not in NON_RESOURCE_SEGMENT). The
 * database-schema rule already detects/repairs a missing notifications
 * TABLE generically from whatever columns a query references. None of that
 * needed to be rebuilt.
 *
 * The genuine, remaining gap: without a dedicated managed service, each
 * generated app would reinvent its own ad-hoc notifications table shape via
 * generic CRUD synthesis (whatever columns the model happens to reference),
 * the same problem lib/managed/auth.ts solves for authentication — a
 * consistent, well-designed CONTRACT (user_id, message, type, read,
 * created_at + create/list/mark-read functions) beats every app inventing
 * its own shape independently.
 */

export interface NotificationsFile { filePath: string; content: string }

export const NOTIFICATIONS_SERVICE_PATH = 'lib/managed/notifications.ts';

/**
 * Detection signal: a dedicated /api/notifications route or /notifications
 * page — narrow and reliable, matching the same "only when actually
 * needed" principle as breadcrumbs/search-indexing's gating.
 */
const NOTIFICATIONS_ROUTE_RE = /(?:^|\/)notifications\/(route|page)\.[jt]sx?$/;

export function isNotificationsFeatureFile(f: { path: string }): boolean {
  return NOTIFICATIONS_ROUTE_RE.test(f.path);
}

export function buildNotificationsService(): NotificationsFile {
  return {
    filePath: NOTIFICATIONS_SERVICE_PATH,
    content: `import crypto from 'crypto';
import { db, initTable } from './db';
import { sendNotificationEmail } from './email';

initTable(\`CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  message TEXT NOT NULL,
  type TEXT DEFAULT 'info',
  read INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)\`);

export interface Notification {
  id: string;
  userId: string;
  message: string;
  type: string;
  read: boolean;
  createdAt: string;
}

function mapRow(row: Record<string, unknown>): Notification {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    message: row.message as string,
    type: row.type as string,
    read: Boolean(row.read),
    createdAt: row.created_at as string,
  };
}

/** Creates an in-app notification for a user. */
export function createNotification(userId: string, message: string, type = 'info'): Notification {
  const id = crypto.randomUUID();
  db.run('INSERT INTO notifications (id, user_id, message, type) VALUES (?, ?, ?, ?)', id, userId, message, type);
  return mapRow(db.get('SELECT * FROM notifications WHERE id = ?', id) as Record<string, unknown>);
}

/** Lists a user's notifications, newest first. */
export function getNotifications(userId: string, unreadOnly = false): Notification[] {
  const sql = unreadOnly
    ? 'SELECT * FROM notifications WHERE user_id = ? AND read = 0 ORDER BY created_at DESC'
    : 'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC';
  return db.all<Record<string, unknown>>(sql, userId).map(mapRow);
}

/** Marks a single notification as read. */
export function markAsRead(id: string): void {
  db.run('UPDATE notifications SET read = 1 WHERE id = ?', id);
}

/** Marks every notification for a user as read. */
export function markAllAsRead(userId: string): void {
  db.run('UPDATE notifications SET read = 1 WHERE user_id = ?', userId);
}

/**
 * Creates an in-app notification AND sends the same message by email —
 * reuses the existing managed email service rather than duplicating
 * delivery logic. Use for events important enough to reach the user
 * outside the app (order confirmed, password reset requested, etc).
 */
export async function notifyWithEmail(
  userId: string, email: string, subject: string, message: string, type = 'info',
): Promise<Notification> {
  const notification = createNotification(userId, message, type);
  await sendNotificationEmail(email, subject, message);
  return notification;
}
`,
  };
}
