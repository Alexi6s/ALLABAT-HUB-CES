// Forward-only migrations: data written under migration 001 must survive migration 002 with its meaning intact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(import.meta.dirname, '../migrations');
const sql = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8');
const at = '2026-01-05T10:00:00.000Z';

test('migration 002 carries existing support tickets and mentoring sessions forward without losing anything', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(sql('001_init.sql'));

  // Legacy data as 001 stored it.
  const user = (id: string, email: string) => db.prepare(`INSERT INTO users(id,email,password_hash,full_name,category,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).run(id, email, 'x', id, 'student', at, at);
  user('u1', 'a@example.test'); user('u2', 'b@example.test'); user('staff1', 'c@example.test');
  const ticket = db.prepare(`INSERT INTO support_requests(id,user_id,subject,message,status,response,responder_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`);
  ticket.run('t-open', 'u1', 'Open ticket', 'Original question one', 'open', null, null, at, at);
  ticket.run('t-done', 'u2', 'Answered ticket', 'Original question two', 'resolved', 'Here is the answer', 'staff1', at, '2026-01-06T10:00:00.000Z');
  db.prepare(`INSERT INTO mentorship_requests(id,mentee_id,mentor_user_id,goals,status,created_at) VALUES ('mr1','u1','u2','Some goals to reach together','accepted',?)`).run(at);
  const session = db.prepare(`INSERT INTO mentorship_sessions(id,request_id,scheduled_at,notes,outcome,recorded_by,created_at) VALUES (?,?,?,?,?,?,?)`);
  session.run('s-past-done', 'mr1', '2026-01-07T10:00:00.000Z', null, 'Reviewed the plan', 'u2', at);
  session.run('s-future', 'mr1', '2999-01-01T10:00:00.000Z', null, null, 'u2', at);

  assert.equal((db.prepare('SELECT name FROM sqlite_master WHERE name = ?').get('support_messages') as unknown), undefined, 'not there before the migration');
  db.exec('BEGIN'); db.exec(sql('002_upgrade.sql')); db.exec('COMMIT');

  const msgs = db.prepare('SELECT request_id, kind, body, author_id FROM support_messages ORDER BY request_id, kind').all() as any[];
  assert.deepEqual(msgs.map((m) => [m.request_id, m.kind, m.body, m.author_id]), [
    ['t-done', 'staff', 'Here is the answer', 'staff1'],
    ['t-done', 'user', 'Original question two', 'u2'],
    ['t-open', 'user', 'Original question one', 'u1'],
  ]);
  const t = db.prepare('SELECT id, status, priority, category, assigned_to, resolved_at FROM support_requests ORDER BY id').all() as any[];
  assert.deepEqual(t.map((x) => [x.id, x.status, x.priority, x.category, x.assigned_to]), [['t-done', 'resolved', 'normal', 'general', null], ['t-open', 'open', 'normal', 'general', null]]);
  assert.equal(t[0].resolved_at, '2026-01-06T10:00:00.000Z', 'resolution time is taken from the last update');
  assert.equal(t[1].resolved_at, null);

  const s = Object.fromEntries((db.prepare('SELECT id, status FROM mentorship_sessions').all() as any[]).map((x) => [x.id, x.status]));
  assert.deepEqual(s, { 's-past-done': 'completed', 's-future': 'scheduled' });
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM users').get() as any).n, 3, 'no user was touched');

  // New columns and constraints exist and are enforced.
  assert.throws(() => db.prepare("UPDATE support_requests SET priority = 'bogus' WHERE id = 't-open'").run(), /constraint/i);
  db.exec('PRAGMA foreign_keys = OFF');
  assert.throws(() => db.prepare("INSERT INTO programme_applications(id,programme_id,user_id,status,review_score,created_at) VALUES ('x','p','u1','submitted',101,?)").run(at), /constraint/i, 'review scores are 0 to 100');
  db.exec('PRAGMA foreign_keys = ON');
  db.prepare(`INSERT INTO role_requests(id,user_id,role,justification,status,created_at) VALUES ('rr1','u1','admin','Because of reasons here','pending',?)`).run(at);
  assert.throws(() => db.prepare(`INSERT INTO role_requests(id,user_id,role,justification,status,created_at) VALUES ('rr2','u1','admin','Again','pending',?)`).run(at), /UNIQUE/i, 'one pending request per person and role');
  db.close();
});

test('migrations are idempotent when the runner restarts: each file is recorded and never re-applied', async () => {
  const { DatabaseSync: Db } = await import('node:sqlite');
  const db = new Db(':memory:');
  db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  assert.deepEqual(files.slice(0, 2), ['001_init.sql', '002_upgrade.sql']);
  for (const f of files) { db.exec('BEGIN'); db.exec(sql(f)); db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(f, at); db.exec('COMMIT'); }
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as any).n, files.length);
  assert.throws(() => db.exec(sql('002_upgrade.sql')), /already exists|duplicate column/i, 'applying a migration twice fails loudly, which is why the runner records them');
  db.close();
});
