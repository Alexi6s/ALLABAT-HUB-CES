import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, PASSWORD, base, closeApp, q, signup, staff, verified, ventureFor } from './helpers.ts';
import { listRoutes } from '../src/http.ts';
import { bootstrapAdmin } from '../src/server.ts';
import { config } from '../src/core.ts';
import { csvCell } from '../src/routes/platform.ts';

after(closeApp);

test('CSRF guard: state-changing requests need the custom header and a same-origin Origin', async () => {
  const u = await signup('student');
  const raw = (headers: Record<string, string>) => fetch(`${base}/api/me/preferences`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: u.cookie, ...headers }, body: '{"email_enabled":true}' });
  assert.equal((await raw({})).status, 403, 'missing X-Requested-With');
  assert.equal((await raw({ 'X-Requested-With': 'ALABATT', Origin: 'https://evil.example' })).status, 403, 'cross-origin');
  assert.equal((await raw({ 'X-Requested-With': 'ALABATT', Origin: base })).status, 200, 'same origin passes');
  assert.equal((await raw({ 'X-Requested-With': 'ALABATT' })).status, 200, 'no Origin (non-browser) passes with the header');
});

test('security headers and cookie flags are set', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const csp = res.headers.get('content-security-policy') ?? '';
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'(?!.*unsafe)/);
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp));
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');

  const u = await signup('student');
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ALABATT' }, body: JSON.stringify({ email: u.email, password: PASSWORD }) });
  const cookie = login.headers.get('set-cookie') ?? '';
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  const api = await fetch(`${base}/api/health`);
  assert.equal(api.headers.get('cache-control'), 'no-store');
});

test('static serving cannot be used to read files outside the web root', async () => {
  for (const p of ['/../../../package.json', '/..%2f..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/apps/api/src/core.ts', '/js/../../../../etc/passwd']) {
    const r = await fetch(base + p);
    const text = await r.text();
    assert.ok(!text.includes('scryptSync') && !text.includes('root:') && !text.includes('"devDependencies"'), `leaked via ${p}`);
  }
  assert.equal((await fetch(`${base}/`, { method: 'DELETE' })).status, 405);
});

test('every authenticated endpoint rejects anonymous callers; every permission-gated endpoint rejects an ordinary member', async () => {
  const anon = new Client();
  const member = await verified('student');
  const routes = listRoutes();
  assert.ok(routes.length > 100, `expected 100+ routes, found ${routes.length}`);
  let gated = 0;
  for (const r of routes) {
    if (r.auth === false) continue;
    const url = r.path.replace(/:[a-zA-Z_]+/g, 'x');
    const a = await anon.req(r.method, url, r.method === 'GET' || r.method === 'DELETE' ? undefined : {});
    assert.equal(a.status, 401, `${r.method} ${r.path} should require sign-in (got ${a.status})`);
    if (r.perm) {
      gated++;
      const m = await member.req(r.method, url, r.method === 'GET' || r.method === 'DELETE' ? undefined : {});
      assert.equal(m.status, 403, `${r.method} ${r.path} should need ${r.perm} (got ${m.status})`);
    }
  }
  assert.ok(gated > 40);
});

test('public endpoints are exactly the intended ones', () => {
  const open = listRoutes().filter((r) => r.auth === false).map((r) => `${r.method} ${r.path}`).sort();
  assert.deepEqual(open, [
    'GET /api/health', 'GET /api/meta', 'POST /api/auth/forgot-password', 'POST /api/auth/login', 'POST /api/auth/logout',
    'POST /api/auth/register', 'POST /api/auth/reset-password', 'POST /api/auth/verify-email',
  ]);
});

test('malformed requests get clean errors, not crashes or stack traces', async () => {
  const c = await verified('student');
  const bad = await fetch(`${base}/api/ventures`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ALABATT', Cookie: c.cookie }, body: '{not json' });
  assert.equal(bad.status, 400);
  assert.equal((await c.get('/api/nope')).status, 404);
  assert.equal((await c.req('DELETE', '/api/health')).status, 405);
  const huge = await fetch(`${base}/api/ventures`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ALABATT', Cookie: c.cookie }, body: JSON.stringify({ name: 'x'.repeat(1_200_000) }) });
  assert.equal(huge.status, 413);
  const wrongTypes = await c.post('/api/ventures', { name: { $ne: null }, industry: ['a'], stage: 5 });
  assert.equal(wrongTypes.status, 422);
  const arrayBody = await c.post('/api/ventures', [1, 2, 3]);
  assert.equal(arrayBody.status, 422);
  const err = await c.get('/api/admin/users');
  assert.ok(!/at .*\.ts:\d+/.test(err.text), 'no stack traces');
});

test('SQL metacharacters in search parameters are treated as data', async () => {
  const admin = await staff('admin');
  const victim = await verified('student');
  for (const needle of ["' OR '1'='1", "%'; DROP TABLE users; --", '\\', '%', '_']) {
    const r = await admin.get(`/api/admin/users?q=${encodeURIComponent(needle)}`);
    assert.equal(r.status, 200);
    assert.ok(r.body.users.every((u: any) => (u.email + u.full_name).toLowerCase().includes(needle.toLowerCase()) || needle === '%' || needle === '_'));
  }
  assert.ok(q.get('SELECT 1 FROM users WHERE id = ?', victim.id), 'users table intact');
});

test('login is rate limited per account', async () => {
  const u = await signup('student');
  const c = new Client();
  const codes: number[] = [];
  for (let i = 0; i < 20; i++) codes.push((await c.req('POST', '/api/auth/login', { email: u.email, password: `wrong-pass-${i}1` }, {}, true)).status);
  assert.ok(codes.includes(429), `expected a 429 in ${codes.join(',')}`);
});

test('sessions: logout revokes the token server-side; suspended accounts lose access immediately', async () => {
  const u = await signup('student');
  const stolen = u.cookie;
  assert.equal((await u.post('/api/auth/logout')).status, 200);
  const replay = await fetch(`${base}/api/auth/me`, { headers: { Cookie: stolen } });
  assert.equal(replay.status, 401, 'the old token no longer works');

  const victim = await signup('student');
  const admin = await staff('admin');
  assert.equal((await victim.get('/api/auth/me')).status, 200);
  assert.equal((await admin.post(`/api/admin/users/${victim.id}/status`, { status: 'suspended', reason: 'Policy violation under review.', confirm_password: PASSWORD })).status, 200);
  assert.equal((await victim.get('/api/auth/me')).status, 401, 'session revoked on suspension');
  // A suspended person may sign in only to see their status and contact support; everything else is refused.
  const limited = new Client();
  assert.equal((await limited.post('/api/auth/login', { email: victim.email, password: PASSWORD })).status, 200);
  assert.equal((await limited.get('/api/auth/me')).body.user.account_status, 'suspended');
  assert.equal((await limited.get('/api/ventures')).status, 403);
  assert.equal((await limited.get('/api/notifications')).status, 403);
  assert.equal((await limited.post('/api/support', { subject: 'Why suspended?', message: 'Please tell me why my account was suspended.' })).status, 201);
  assert.equal((await admin.post(`/api/admin/users/${victim.id}/status`, { status: 'disabled', reason: 'Confirmed violation of the rules.', confirm_password: PASSWORD })).status, 200);
  assert.equal((await limited.get('/api/auth/me')).status, 401, 'disabling revokes the limited session too');
  assert.equal((await new Client().post('/api/auth/login', { email: victim.email, password: PASSWORD })).status, 403, 'disabled accounts cannot sign in');
  assert.equal((await admin.post(`/api/admin/users/${victim.id}/status`, { status: 'active', reason: 'Review concluded, reinstated.', confirm_password: PASSWORD })).status, 200);
  assert.equal((await new Client().post('/api/auth/login', { email: victim.email, password: PASSWORD })).status, 200);
});

test('role administration: staff roles only, no self-service, administrator roles need a super administrator', async () => {
  const admin = await staff('admin');
  const sa = await staff('super_admin');
  const target = await verified('student');
  const unconfirmed = new Client();
  const grant = (c: Client, id: string, role: string) => c.post(`/api/admin/users/${id}/roles`, { role, action: 'grant', reason: 'Appointed by management.', confirm_password: PASSWORD });

  assert.equal((await grant(target, target.id, 'admin')).status, 403, 'members cannot promote themselves');
  assert.equal((await grant(admin, admin.id, 'support_officer')).status, 403, 'no self-service');
  assert.equal((await admin.post(`/api/admin/users/${target.id}/roles`, { role: 'mentor', action: 'grant', reason: 'Trying to skip review.', confirm_password: PASSWORD })).status, 422, 'mentor is only granted through governance');
  assert.equal((await admin.post(`/api/admin/users/${target.id}/roles`, { role: 'student', action: 'grant', reason: 'Skipping verification.', confirm_password: PASSWORD })).status, 422);
  assert.equal((await grant(admin, target.id, 'admin')).status, 403, 'admins cannot mint admins');
  assert.equal((await grant(admin, target.id, 'funding_officer')).status, 200);
  assert.equal((await grant(admin, target.id, 'funding_officer')).status, 409);
  assert.ok((await target.get('/api/auth/me')).body.user.permissions.includes('funding.review'));
  assert.equal((await grant(sa, target.id, 'admin')).status, 200);
  assert.equal((await admin.post(`/api/admin/users/${target.id}/status`, { status: 'disabled', reason: 'Trying to disable an admin.', confirm_password: PASSWORD })).status, 403, 'only a super administrator can touch administrators');
  assert.equal((await admin.post(`/api/admin/users/${target.id}/roles`, { role: 'funding_officer', action: 'revoke', reason: 'Role change.', confirm_password: PASSWORD })).status, 200);
  assert.equal((await admin.post(`/api/admin/users/${target.id}/status`, { status: 'disabled', reason: 'x', confirm_password: PASSWORD })).status, 422, 'a reason is required');
  assert.equal((await admin.post(`/api/admin/users/${admin.id}/status`, { status: 'disabled', reason: 'Disable myself.', confirm_password: PASSWORD })).status, 403);

  const row = q.get<any>("SELECT id FROM users WHERE email = 'unconfirmed@example.test'");
  assert.equal(row, undefined);
  await unconfirmed.post('/api/auth/register', { email: 'unconfirmed@example.test', password: PASSWORD, full_name: 'Unconfirmed Person', category: 'student', accept_terms: true });
  const id = q.get<any>("SELECT id FROM users WHERE email = 'unconfirmed@example.test'")!.id;
  assert.equal((await grant(admin, id, 'support_officer')).status, 409, 'staff roles require an active, confirmed account');
  assert.ok(q.all("SELECT * FROM audit_events WHERE action = 'role.grant'").length >= 2);
});

test('audit log is readable only by administrators and records who did what', async () => {
  const admin = await staff('admin');
  const officer = await staff('support_officer');
  const u = await signup('student');
  assert.equal((await officer.get('/api/admin/audit')).status, 403);
  const res = await admin.get('/api/admin/audit?action=user.registered&limit=500');
  assert.equal(res.status, 200);
  const ev = res.body.events.find((e: any) => e.actor_id === u.id);
  assert.ok(ev && ev.entity === 'user' && ev.created_at);
  assert.ok(!JSON.stringify(res.body).match(/password|scrypt|token_hash/i), 'audit never contains secrets');
  const filtered = await admin.get(`/api/admin/audit?actor=${u.id}`);
  assert.ok(filtered.body.events.every((e: any) => e.actor_id === u.id));
});

test('reports: partners see suppressed small counts, staff see exact figures, CSV is anonymous and formula-safe', async () => {
  const partner = await verified('partner');
  const coord = await staff('programme_coordinator');
  for (let i = 0; i < 2; i++) await ventureFor(await verified('student'), `=HYPERLINK("http://evil","click") ${i}`, { industry: '=cmd|calc' });
  const owner = await verified('student');
  const v = await ventureFor(owner, 'Reported Venture', { industry: '@SUM(1+1)' });
  await owner.post(`/api/ventures/${v}/submit`);

  const asPartner = await partner.get('/api/reports/summary');
  assert.equal(asPartner.status, 200);
  assert.match(asPartner.body.suppression, /below 5/);
  const stageCounts = asPartner.body.ventures.by_stage;
  assert.ok(stageCounts.every((s: any) => typeof s.count === 'string' ? s.count === '<5' : s.count === 0 || s.count >= 5));
  const asStaff = await coord.get('/api/reports/summary');
  assert.equal(asStaff.body.suppression, 'none');
  assert.ok(asStaff.body.ventures.by_status.some((s: any) => typeof s.count === 'number'));
  assert.equal((await partner.get('/api/reports/export.csv?dataset=ventures')).status, 403, 'partners cannot export');

  const csv = await coord.get('/api/reports/export.csv?dataset=ventures');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type') ?? '', /text\/csv/);
  assert.ok(!/@example\.test/.test(csv.text) && !/Reported Venture/.test(csv.text), 'no personal or identifying data');
  for (const line of csv.text.split('\n').slice(1).filter(Boolean)) assert.ok(!/^[=+\-@]/.test(line.split(',')[0]), `unsafe cell: ${line}`);
  assert.ok(csv.text.includes("'@SUM(1+1)"));
  assert.equal((await coord.get('/api/reports/export.csv?dataset=users')).status, 422);
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell(null), '');
});

test('resource library: creators draft, publishers publish, audience and verification are enforced, downloads counted once a day', async () => {
  const lecturer = await verified('lecturer');
  const publisher = await staff('incubation_manager');
  const student = await verified('student');
  const outsider = await verified('external_participant');
  const doc = await lecturer.upload('resource_file', Buffer.from('%PDF-1.4\nbody\n'), 'guide.pdf', { 'X-Context': 'resource' });
  assert.equal(doc.status, 201);
  assert.equal((await student.upload('resource_file', Buffer.from('%PDF-1.4\nbody\n'), 'x.pdf', { 'X-Context': 'resource' })).status, 403, 'only creators may attach resource files');

  assert.equal((await student.post('/api/resources', { title: 'Nope', resource_type: 'link', external_url: 'https://example.org' })).status, 403);
  assert.equal((await lecturer.post('/api/resources', { title: 'Bad link', resource_type: 'link', external_url: 'javascript:alert(1)' })).status, 422);
  assert.equal((await lecturer.post('/api/resources', { title: 'Needs file', resource_type: 'document' })).status, 422);
  const created = await lecturer.post('/api/resources', { title: 'Pricing guide', description: 'How to price.', topic: 'pricing', resource_type: 'document', document_id: doc.body.id, audience_categories: ['student'] });
  assert.equal(created.status, 201);
  const rid = created.body.id;

  assert.equal((await student.get('/api/resources')).body.resources.length, 0, 'drafts are invisible');
  assert.equal((await student.get(`/api/resources/${rid}/download`)).status, 404);
  assert.equal((await lecturer.post(`/api/resources/${rid}/publish`)).status, 403, 'creators cannot publish');
  assert.equal((await publisher.post(`/api/resources/${rid}/publish`)).status, 200);
  assert.equal((await publisher.post(`/api/resources/${rid}/publish`)).status, 409);

  const list = await student.get('/api/resources?q=pricing');
  assert.equal(list.body.resources.length, 1);
  assert.ok(!('document_id' in list.body.resources[0]), 'storage ids are not exposed');
  assert.equal((await outsider.get('/api/resources')).body.resources.length, 0, 'audience filter');
  assert.equal((await outsider.get(`/api/resources/${rid}/download`)).status, 404);
  assert.equal((await (await signup('student')).get('/api/resources')).status, 403, 'unverified members are blocked');

  for (let i = 0; i < 3; i++) assert.equal((await student.get(`/api/resources/${rid}/download`)).status, 200);
  assert.equal(q.get<any>('SELECT COUNT(*) AS n FROM resource_downloads WHERE resource_id = ?', rid)!.n, 1, 'one download counted per person per day');
  assert.equal((await lecturer.patch(`/api/resources/${rid}`, { title: 'Changed after publish' })).status, 403);
  assert.equal((await publisher.patch(`/api/resources/${rid}`, { title: 'Pricing guide v2' })).status, 200);
});

test('notifications are private; support requests are answered by staff only', async () => {
  const a = await signup('student');
  const b = await signup('student');
  const notes = (await a.get('/api/notifications')).body.notifications;
  assert.ok(notes.length >= 0);
  const one = q.get<any>('SELECT id FROM notifications WHERE user_id = ?', a.id);
  if (one) assert.equal((await b.post(`/api/notifications/${one.id}/read`)).status, 404, 'cannot touch another user\'s notification');
  assert.equal((await a.post('/api/notifications/read-all')).status, 200);
  assert.equal((await a.get('/api/notifications')).body.unread, 0);

  assert.equal((await a.post('/api/support', { subject: 'Hi', message: 'short' })).status, 422);
  const req = await a.post('/api/support', { subject: 'Cannot upload ID', message: 'My upload keeps failing with a size error.' });
  assert.equal(req.status, 201);
  assert.equal((await b.get('/api/support/mine')).body.requests.length, 0);
  const officer = await staff('support_officer');
  assert.equal((await b.post(`/api/admin/support/${req.body.id}/respond`, { response: 'Hacked', status: 'resolved' })).status, 403);
  assert.equal((await officer.post(`/api/admin/support/${req.body.id}/respond`, { response: 'Please use a PDF under 5 MB.', status: 'resolved' })).status, 200);
  assert.equal((await a.get('/api/support/mine')).body.requests[0].status, 'resolved');
  assert.ok((await a.get('/api/notifications')).body.notifications.some((n: any) => /support request resolved/i.test(n.title)));
});

test('bootstrap creates a super administrator only from explicit credentials, and only once', async () => {
  config.bootstrapEmail = '';
  config.bootstrapPassword = '';
  assert.equal(bootstrapAdmin(), null, 'nothing is created by default');
  config.bootstrapEmail = 'Owner@Example.test';
  config.bootstrapPassword = 'weak';
  assert.throws(() => bootstrapAdmin(), /need attention/);
  config.bootstrapPassword = 'Str0ng-bootstrap-pw';
  const id = bootstrapAdmin();
  assert.ok(id);
  assert.equal(bootstrapAdmin(), null, 'idempotent');
  const c = new Client();
  const login = await c.post('/api/auth/login', { email: 'owner@example.test', password: 'Str0ng-bootstrap-pw' });
  assert.equal(login.status, 200);
  assert.ok(login.body.user.roles.includes('super_admin'));
  assert.equal((await c.get('/api/admin/config')).status, 200);
  assert.equal((await c.put('/api/admin/config', { key: 'mentor_approvals_required', value: 9, confirm_password: 'Str0ng-bootstrap-pw' })).status, 422);
  assert.equal((await c.put('/api/admin/config', { key: 'mentor_approvals_required', value: 2, confirm_password: 'Str0ng-bootstrap-pw' })).status, 200);
  assert.equal((await c.put('/api/admin/config', { key: 'anything_else', value: 1, confirm_password: 'Str0ng-bootstrap-pw' })).status, 422);
  q.run("DELETE FROM system_config WHERE key = 'mentor_approvals_required'");
  config.bootstrapEmail = '';
  config.bootstrapPassword = '';
});

test('production mode: no dev tokens in responses, HSTS and Secure cookies on', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ces-prod-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const entry = path.resolve(import.meta.dirname, '../src/server.ts');
  const child = spawn(process.execPath, [entry], { env: { ...process.env, NODE_ENV: 'production', PORT: String(port), DATA_DIR: dir, BOOTSTRAP_ADMIN_EMAIL: '', BOOTSTRAP_ADMIN_PASSWORD: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('production server did not start')), 15000);
      child.stdout.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(t); resolve(); } });
      child.on('exit', (code) => reject(new Error(`server exited early (${code})`)));
    });
    const url = `http://127.0.0.1:${port}`;
    const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'ALABATT' };
    const reg = await fetch(`${url}/api/auth/register`, { method: 'POST', headers, body: JSON.stringify({ email: 'prod@example.test', password: PASSWORD, full_name: 'Prod User', category: 'student', accept_terms: true }) });
    assert.equal(reg.status, 201);
    const body = await reg.json();
    assert.equal(body.dev_verify_token, undefined, 'tokens must never be returned in production');
    const forgot = await (await fetch(`${url}/api/auth/forgot-password`, { method: 'POST', headers, body: JSON.stringify({ email: 'prod@example.test' }) })).json();
    assert.equal(forgot.dev_reset_token, undefined);
    const login = await fetch(`${url}/api/auth/login`, { method: 'POST', headers, body: JSON.stringify({ email: 'prod@example.test', password: PASSWORD }) });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie') ?? '', /; Secure/);
    assert.match(login.headers.get('strict-transport-security') ?? '', /max-age=/);
    const login2 = await fetch(`${url}/api/health`);
    assert.equal(login2.status, 200);
  } finally {
    child.kill('SIGTERM');
  }
});
