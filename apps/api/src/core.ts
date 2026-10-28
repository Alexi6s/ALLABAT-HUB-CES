// Core infrastructure: configuration, database, errors, validation, crypto helpers, audit and notifications.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 8787),
  dataDir: process.env.DATA_DIR ?? path.join(root, 'data'),
  dbFile: process.env.DB_FILE ?? '',
  appUrl: process.env.APP_URL ?? 'http://localhost:8787',
  sessionHours: Number(process.env.SESSION_HOURS ?? 12),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 5 * 1024 * 1024),
  // Only ever true outside production: exposes email tokens in API responses so flows can be tested without an email provider.
  devMode: (process.env.NODE_ENV ?? 'development') !== 'production' && process.env.EXPOSE_DEV_TOKENS !== 'false',
  mentorApprovalsRequired: Number(process.env.MENTOR_APPROVALS_REQUIRED ?? 1),
  // Outbound email. Empty host = no provider: messages are queued as 'queued_no_provider' and never sent.
  smtp: {
    host: process.env.SMTP_HOST ?? '',
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true', // true = TLS from the first byte (usually port 465)
    starttls: process.env.SMTP_STARTTLS !== 'false', // upgrade a plain connection with STARTTLS when the server offers it
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    from: process.env.MAIL_FROM ?? '',
    rejectUnauthorized: process.env.SMTP_TLS_REJECT_UNAUTHORIZED !== 'false',
  },
  bootstrapEmail: process.env.BOOTSTRAP_ADMIN_EMAIL ?? '',
  bootstrapPassword: process.env.BOOTSTRAP_ADMIN_PASSWORD ?? '',
};
config.dbFile = config.dbFile || path.join(config.dataDir, 'alabatt-ces.sqlite');

export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export const bad = (msg: string, details?: unknown) => new HttpError(400, 'bad_request', msg, details);
export const forbidden = (msg = 'You do not have permission to perform this action.') => new HttpError(403, 'forbidden', msg);
export const notFound = (msg = 'Not found.') => new HttpError(404, 'not_found', msg);
export const conflict = (msg: string) => new HttpError(409, 'conflict', msg);

export const now = () => new Date().toISOString();
export const uid = () => randomUUID();
export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(pw, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(expected, actual);
}

// ---------- database ----------
type P = string | number | null | bigint | Uint8Array;
let db!: DatabaseSync;

const clean = (params: unknown[]): P[] => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : (p as P)));
export const q = {
  get<T = any>(sql: string, ...params: unknown[]): T | undefined {
    return db.prepare(sql).get(...clean(params)) as T | undefined;
  },
  all<T = any>(sql: string, ...params: unknown[]): T[] {
    return db.prepare(sql).all(...clean(params)) as T[];
  },
  run(sql: string, ...params: unknown[]) {
    return db.prepare(sql).run(...clean(params));
  },
};

let txDepth = 0;
/** Run fn inside an immediate transaction (serialises writers, so capacity checks cannot race). */
export function tx<T>(fn: () => T): T {
  if (txDepth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  txDepth++;
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    txDepth--;
  }
}

export function openDb(file = config.dbFile): DatabaseSync {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  runMigrations();
  return db;
}
export function closeDb() {
  db?.close();
}

function runMigrations() {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const dir = path.join(root, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const done = q.get('SELECT name FROM schema_migrations WHERE name = ?', f);
    if (done) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      q.run('INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?)', f, now());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

export const json = (v: unknown): string => JSON.stringify(v ?? null);
export const parseJson = <T = any>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

// ---------- validation ----------
export class Input {
  private src: Record<string, unknown>;
  private errors: Record<string, string> = {};
  constructor(src: unknown) {
    this.src = src && typeof src === 'object' && !Array.isArray(src) ? (src as Record<string, unknown>) : {};
  }
  has(k: string) {
    return this.src[k] !== undefined;
  }
  str(k: string, o: { min?: number; max?: number; required?: boolean } = {}): string | null {
    const { min = 0, max = 2000, required = true } = o;
    const raw = this.src[k];
    if (raw === undefined || raw === null || raw === '') {
      if (required) this.errors[k] = 'This field is required.';
      return null;
    }
    if (typeof raw !== 'string') {
      this.errors[k] = 'Must be text.';
      return null;
    }
    const s = raw.trim();
    if (s.length < min) this.errors[k] = `Must be at least ${min} characters.`;
    else if (s.length > max) this.errors[k] = `Must be at most ${max} characters.`;
    else if (required && !s) this.errors[k] = 'This field is required.';
    return s || null;
  }
  email(k: string): string | null {
    const s = this.str(k, { max: 254 });
    if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) this.errors[k] = 'Enter a valid email address.';
    return s ? s.toLowerCase() : null;
  }
  int(k: string, o: { min?: number; max?: number; required?: boolean } = {}): number | null {
    const { min = -Infinity, max = Infinity, required = true } = o;
    const raw = this.src[k];
    if (raw === undefined || raw === null || raw === '') {
      if (required) this.errors[k] = 'This field is required.';
      return null;
    }
    const n = Number(raw);
    if (!Number.isInteger(n)) this.errors[k] = 'Must be a whole number.';
    else if (n < min || n > max) this.errors[k] = `Must be between ${min} and ${max}.`;
    return Number.isInteger(n) ? n : null;
  }
  num(k: string, o: { required?: boolean } = {}): number | null {
    const raw = this.src[k];
    if (raw === undefined || raw === null || raw === '') {
      if (o.required ?? true) this.errors[k] = 'This field is required.';
      return null;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      this.errors[k] = 'Must be a number.';
      return null;
    }
    return n;
  }
  bool(k: string, required = false): boolean | null {
    const raw = this.src[k];
    if (raw === undefined || raw === null) {
      if (required) this.errors[k] = 'This field is required.';
      return null;
    }
    if (typeof raw !== 'boolean') {
      this.errors[k] = 'Must be true or false.';
      return null;
    }
    return raw;
  }
  oneOf<T extends string>(k: string, values: readonly T[], required = true): T | null {
    const raw = this.src[k];
    if (raw === undefined || raw === null || raw === '') {
      if (required) this.errors[k] = 'This field is required.';
      return null;
    }
    if (typeof raw !== 'string' || !(values as readonly string[]).includes(raw)) {
      this.errors[k] = `Must be one of: ${values.join(', ')}.`;
      return null;
    }
    return raw as T;
  }
  list(k: string, o: { max?: number; itemMax?: number; allowed?: readonly string[] } = {}): string[] {
    const { max = 30, itemMax = 100, allowed } = o;
    const raw = this.src[k];
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw) || raw.length > max || raw.some((x) => typeof x !== 'string' || x.length > itemMax)) {
      this.errors[k] = 'Must be a list of short text values.';
      return [];
    }
    const out = raw.map((x) => (x as string).trim()).filter(Boolean);
    if (allowed && out.some((x) => !allowed.includes(x))) this.errors[k] = `Allowed values: ${allowed.join(', ')}.`;
    return out;
  }
  date(k: string, required = false): string | null {
    const raw = this.src[k];
    if (raw === undefined || raw === null || raw === '') {
      if (required) this.errors[k] = 'This field is required.';
      return null;
    }
    const d = new Date(String(raw));
    if (Number.isNaN(d.getTime())) {
      this.errors[k] = 'Enter a valid date.';
      return null;
    }
    return d.toISOString();
  }
  raw(k: string): unknown {
    return this.src[k];
  }
  /** Records a field error from custom rules so every problem is reported in one response. */
  fail(k: string, message: string) {
    this.errors[k] = message;
  }
  done() {
    if (Object.keys(this.errors).length) throw new HttpError(422, 'validation_failed', 'Some fields need attention.', this.errors);
  }
}

export const PASSWORD_RULE = 'Use 10 to 128 characters including at least one letter and one number.';
export const passwordProblem = (pw: string | null): string | null =>
  pw && (pw.length < 10 || pw.length > 128 || !/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) ? PASSWORD_RULE : null;
export function checkPassword(pw: string | null) {
  const p = passwordProblem(pw);
  if (p) throw new HttpError(422, 'validation_failed', 'Some fields need attention.', { password: p });
}

// ---------- audit & notifications ----------
export function audit(actorId: string | null, action: string, entity: string, entityId: string | null, details?: unknown, ip?: string) {
  q.run('INSERT INTO audit_events(id, actor_id, action, entity, entity_id, details, ip, created_at) VALUES (?,?,?,?,?,?,?,?)', uid(), actorId, action, entity, entityId, details ? json(details) : null, ip ?? null, now());
}

/**
 * Creates an in-app notification and queues an email record. No email is delivered unless a provider is configured (see mailer.ts).
 * With a dedupeKey the same (user, key) is only ever notified once, even if the triggering event is retried or a reminder job re-runs.
 * Returns false when the notification was suppressed as a duplicate.
 */
export function notify(userId: string, type: string, title: string, body?: string, link?: string, dedupeKey?: string): boolean {
  if (dedupeKey) {
    const first = q.run('INSERT OR IGNORE INTO notification_dedupe(user_id, dedupe_key, created_at) VALUES (?,?,?)', userId, dedupeKey, now());
    if (Number(first.changes) === 0) return false;
  }
  const prefs = q.get<{ email_enabled: number; in_app_enabled: number }>('SELECT * FROM notification_preferences WHERE user_id = ?', userId);
  if (!prefs || prefs.in_app_enabled) {
    q.run('INSERT INTO notifications(id, user_id, type, title, body, link, created_at) VALUES (?,?,?,?,?,?,?)', uid(), userId, type, title, body ?? null, link ?? null, now());
  }
  if (!prefs || prefs.email_enabled) {
    const u = q.get<{ email: string }>('SELECT email FROM users WHERE id = ?', userId);
    if (u) queueEmail(u.email, title, body ?? title);
  }
  return true;
}
export function queueEmail(to: string, subject: string, body: string) {
  q.run('INSERT INTO email_outbox(id, to_email, subject, body, created_at) VALUES (?,?,?,?,?)', uid(), to, subject, body, now());
}

export function getConfigNumber(key: string, fallback: number): number {
  const r = q.get<{ value: string }>('SELECT value FROM system_config WHERE key = ?', key);
  return r ? Number(r.value) : fallback;
}

// ---------- pagination ----------
/** Reads ?limit= and ?offset= with safe bounds. Lists never return unbounded rows. */
export function paging(query: URLSearchParams, defaults: { limit?: number; max?: number } = {}) {
  const max = defaults.max ?? 100;
  const limit = Math.min(max, Math.max(1, Math.trunc(Number(query.get('limit') ?? defaults.limit ?? 25)) || (defaults.limit ?? 25)));
  const offset = Math.max(0, Math.trunc(Number(query.get('offset') ?? 0)) || 0);
  return { limit, offset };
}
/** Wraps one page of rows with the numbers a client needs to build a pager. */
export const pageInfo = (total: number, limit: number, offset: number) => ({ total, limit, offset, has_more: offset + limit < total });
/** Escapes LIKE wildcards so a search term is matched literally. Use with `LIKE ? ESCAPE '\\'`. */
export const likeTerm = (s: string) => `%${s.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
