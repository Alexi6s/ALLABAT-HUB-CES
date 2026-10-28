// Operational scripts: demo seed, backup/verify/restore, generated API docs. Each runs as a real child process against a temporary data directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../..');
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `ces-${p}-`));
const run = (script: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [path.join(root, script), ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('demo seed: refuses production and unconfirmed runs, creates labelled demo data once, password is random and works', async () => {
  const dir = tmp('seed');
  const prod = run('apps/api/src/seed-demo.ts', ['--confirm'], { NODE_ENV: 'production', DATA_DIR: dir });
  assert.equal(prod.status, 1);
  assert.match(prod.stderr, /production/);
  assert.equal(fs.existsSync(path.join(dir, 'alabatt-ces.sqlite')), false, 'nothing is created in production mode');

  const noConfirm = run('apps/api/src/seed-demo.ts', [], { NODE_ENV: 'development', DATA_DIR: dir });
  assert.equal(noConfirm.status, 1);
  assert.match(noConfirm.stderr, /--confirm/);
  assert.equal(fs.existsSync(path.join(dir, 'alabatt-ces.sqlite')), false, 'nothing is created without --confirm');

  const first = run('apps/api/src/seed-demo.ts', ['--confirm'], { NODE_ENV: 'development', DATA_DIR: dir });
  assert.equal(first.status, 0, first.stderr);
  const password = /Password for every demo account[^:]*: (\S+)/.exec(first.stdout)?.[1];
  assert.ok(password && password.length >= 14, 'a random password is printed once');

  const db = new DatabaseSync(path.join(dir, 'alabatt-ces.sqlite'), { readOnly: true });
  const users = db.prepare('SELECT email, full_name FROM users').all() as { email: string; full_name: string }[];
  assert.ok(users.length >= 10);
  for (const u of users) {
    assert.match(u.email, /@demo\.alabatt\.invalid$/, 'only reserved .invalid addresses');
    assert.match(u.full_name, /^\[DEMO\] /, 'every demo person is labelled');
  }
  const labelled: [string, string][] = [['programmes', 'title'], ['workshops', 'title'], ['funding_opportunities', 'title'], ['ventures', 'name'], ['milestones', 'title']];
  for (const [table, col] of labelled) {
    const rows = db.prepare(`SELECT ${col} AS label FROM ${table}`).all() as { label: string }[];
    assert.ok(rows.length >= 1 && rows.every((r) => r.label.startsWith('[DEMO]')), `${table} are labelled demo`);
  }
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number }).n, 0, 'no documents');
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM funding_applications").get() as { n: number }).n, 0, 'no applications, so no payments can exist');
  db.close();

  const second = run('apps/api/src/seed-demo.ts', ['--confirm'], { NODE_ENV: 'development', DATA_DIR: dir });
  assert.equal(second.status, 0);
  assert.match(second.stdout, /already exist/);
  assert.doesNotMatch(second.stdout, /Password for every demo account/, 'second run must not print or change credentials');

  // the printed password really signs in, through a real server
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(root, 'apps/api/src/server.ts')], { env: { ...process.env, NODE_ENV: 'development', PORT: String(port), DATA_DIR: dir, BOOTSTRAP_ADMIN_EMAIL: '', BOOTSTRAP_ADMIN_PASSWORD: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server did not start')), 15000);
      child.stdout.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(t); resolve(); } });
      child.on('exit', (c) => reject(new Error(`server exited early (${c})`)));
    });
    const r = await fetch(`http://127.0.0.1:${port}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ALABATT' }, body: JSON.stringify({ email: 'student@demo.alabatt.invalid', password }) });
    assert.equal(r.status, 200);
    const wrong = await fetch(`http://127.0.0.1:${port}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ALABATT' }, body: JSON.stringify({ email: 'student@demo.alabatt.invalid', password: 'Password-123!' }) });
    assert.equal(wrong.status, 401, 'no well-known default password exists');
  } finally {
    child.kill('SIGTERM');
  }
});

test('backup: snapshot, verify, tamper detection, and restore round trip', () => {
  const dir = tmp('bk-src');
  const seed = run('apps/api/src/seed-demo.ts', ['--confirm'], { NODE_ENV: 'development', DATA_DIR: dir });
  assert.equal(seed.status, 0, seed.stderr);
  fs.mkdirSync(path.join(dir, 'uploads', 'ab'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'uploads', 'ab', 'sample.bin'), PNG);

  const out = tmp('bk-out');
  const made = run('scripts/backup.ts', [], { DATA_DIR: dir, BACKUP_DIR: out });
  assert.equal(made.status, 0, made.stderr);
  const backupDir = path.join(out, fs.readdirSync(out)[0]);
  assert.ok(fs.existsSync(path.join(backupDir, 'MANIFEST.json')));
  assert.equal((fs.statSync(path.join(backupDir, 'alabatt-ces.sqlite')).mode & 0o077), 0, 'backup files are owner-only');

  const ok = run('scripts/backup.ts', ['--verify', backupDir]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /OK:/);

  // restore into an empty directory, then read the data back
  const target = tmp('bk-restore');
  const restored = run('scripts/backup.ts', ['--restore', backupDir], { DATA_DIR: target });
  assert.equal(restored.status, 0, restored.stderr);
  const db = new DatabaseSync(path.join(target, 'alabatt-ces.sqlite'), { readOnly: true });
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n, (new DatabaseSync(path.join(dir, 'alabatt-ces.sqlite'), { readOnly: true }).prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n);
  db.close();
  assert.deepEqual(fs.readFileSync(path.join(target, 'uploads', 'ab', 'sample.bin')), PNG, 'uploads restored byte for byte');

  // refuses to overwrite without --force, and --force moves old data aside instead of deleting it
  const again = run('scripts/backup.ts', ['--restore', backupDir], { DATA_DIR: target });
  assert.equal(again.status, 1);
  assert.match(again.stderr, /Refusing to overwrite/);
  const forced = run('scripts/backup.ts', ['--restore', backupDir, '--force'], { DATA_DIR: target });
  assert.equal(forced.status, 0, forced.stderr);
  assert.ok(fs.readdirSync(target).some((n) => n.startsWith('pre-restore-')), 'previous data kept aside');

  // tampering is detected, and a tampered backup is never restored
  fs.appendFileSync(path.join(backupDir, 'uploads', 'ab', 'sample.bin'), 'x');
  const bad = run('scripts/backup.ts', ['--verify', backupDir]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Hash mismatch/);
  const refused = run('scripts/backup.ts', ['--restore', backupDir, '--force'], { DATA_DIR: tmp('bk-refuse') });
  assert.equal(refused.status, 1);
});

test('generated API docs are up to date with the route registry', () => {
  const r = run('scripts/gen-api-docs.ts', ['--check']);
  assert.equal(r.status, 0, `${r.stderr}\nRun: npm run docs:api`);
  assert.match(r.stdout, /up to date \(\d+ endpoints\)/);
});

test('generated database docs are up to date with the migrations', () => {
  const r = run('scripts/gen-db-docs.ts', ['--check']);
  assert.equal(r.status, 0, `${r.stderr}\nRun: npm run docs:db`);
  assert.match(r.stdout, /up to date \(\d+ tables\)/);
});
