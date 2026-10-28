import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, PASSWORD, PDF, PNG, audits, closeApp, forceVerified, q, signup, staff, verified, base } from './helpers.ts';

after(closeApp);

test('registration validates input and never grants privileges from the request body', async () => {
  const c = new Client();
  const bad = await c.post('/api/auth/register', { email: 'not-an-email', password: 'short', full_name: 'A', category: 'wizard' });
  assert.equal(bad.status, 422);
  assert.ok(bad.body.error.details.email && bad.body.error.details.password && bad.body.error.details.category);

  const noTerms = await c.post('/api/auth/register', { email: 'a1@example.test', password: PASSWORD, full_name: 'Ada Obi', category: 'student', accept_terms: false });
  assert.equal(noTerms.status, 422);

  const partnerNoOrg = await c.post('/api/auth/register', { email: 'p1@example.test', password: PASSWORD, full_name: 'Pat Partner', category: 'partner', accept_terms: true });
  assert.equal(partnerNoOrg.status, 422);

  // Mass-assignment attempt: roles / status / verification supplied by the client must be ignored.
  const sneaky = await signup('student', { roles: ['super_admin'], account_status: 'active', verification_status: 'verified', email_verified: true });
  const me = await sneaky.get('/api/auth/me');
  assert.deepEqual(me.body.user.roles, []);
  assert.equal(me.body.user.verification_status, 'unverified');
  assert.equal(me.body.user.permissions.length, 0);

  const dup = await new Client().post('/api/auth/register', { email: sneaky.email.toUpperCase(), password: PASSWORD, full_name: 'Dup', category: 'student', accept_terms: true });
  assert.equal(dup.status, 409);
});

test('login errors are generic, repeated failures lock the account, and passwords are not stored in clear', async () => {
  const u = await signup();
  const c = new Client();
  const wrong = await c.post('/api/auth/login', { email: u.email, password: 'wrong-password-1' });
  const ghost = await c.post('/api/auth/login', { email: 'nobody@example.test', password: 'wrong-password-1' });
  assert.equal(wrong.status, 401);
  assert.equal(ghost.status, 401);
  assert.equal(wrong.body.error.message, ghost.body.error.message);

  for (let i = 0; i < 4; i++) await c.post('/api/auth/login', { email: u.email, password: 'wrong-password-1' });
  const locked = await c.post('/api/auth/login', { email: u.email, password: PASSWORD });
  assert.equal(locked.status, 429, 'correct password is refused while locked');

  q.run('UPDATE users SET locked_until = NULL, failed_logins = 0 WHERE id = ?', u.id);
  assert.equal((await c.post('/api/auth/login', { email: u.email, password: PASSWORD })).status, 200);
  const row = q.get<any>('SELECT password_hash FROM users WHERE id = ?', u.id)!;
  assert.match(row.password_hash, /^scrypt\$/);
  assert.ok(!row.password_hash.includes(PASSWORD));
});

test('email confirmation and password reset tokens are single use and revoke old sessions', async () => {
  const c = new Client();
  const email = 'reset-me@example.test';
  const reg = await c.post('/api/auth/register', { email, password: PASSWORD, full_name: 'Reset Me', category: 'student', accept_terms: true });
  const token = reg.body.dev_verify_token;
  assert.equal((await c.post('/api/auth/verify-email', { token })).status, 200);
  assert.equal((await c.post('/api/auth/verify-email', { token })).status, 400, 'confirmation token cannot be reused');
  assert.equal((await c.post('/api/auth/verify-email', { token: 'garbage' })).status, 400);

  await c.post('/api/auth/login', { email, password: PASSWORD });
  assert.equal((await c.get('/api/auth/me')).status, 200);

  const unknown = await new Client().post('/api/auth/forgot-password', { email: 'ghost@example.test' });
  const known = await new Client().post('/api/auth/forgot-password', { email });
  assert.equal(unknown.body.message, known.body.message, 'no account enumeration');
  assert.equal(unknown.body.dev_reset_token, undefined);

  const weak = await new Client().post('/api/auth/reset-password', { token: known.body.dev_reset_token, password: 'short' });
  assert.equal(weak.status, 422);
  const ok = await new Client().post('/api/auth/reset-password', { token: known.body.dev_reset_token, password: 'Brand-new-pass9' });
  assert.equal(ok.status, 200);
  assert.equal((await new Client().post('/api/auth/reset-password', { token: known.body.dev_reset_token, password: 'Another-pass-99' })).status, 400);
  assert.equal((await c.get('/api/auth/me')).status, 401, 'existing sessions are revoked after a reset');
  assert.equal((await new Client().post('/api/auth/login', { email, password: 'Brand-new-pass9' })).status, 200);
});

test('verification: complete evidence, review by someone else, role granted only by approval', async () => {
  const student = await signup('student');
  assert.equal((await student.get('/api/mentors')).status, 403, 'unverified accounts cannot use institutional features');

  const early = await student.post('/api/verification/submit', { document_ids: [] });
  assert.equal(early.status, 422, 'affiliation details are required first');

  const aff = await student.put('/api/me/affiliation', { institution: 'ALABATT University', id_number: 'ST/2024/001', department: 'Business', programme_of_study: 'BSc Entrepreneurship', level: '300' });
  assert.equal(aff.status, 200);
  const noDoc = await student.post('/api/verification/submit', { document_ids: [] });
  assert.equal(noDoc.status, 422, 'a student ID document is required');

  const up = await student.upload('student_id', PNG, 'id.png');
  assert.equal(up.status, 201);
  assert.equal(up.body.scan_status, 'basic_checks_passed');
  const sub = await student.post('/api/verification/submit', { document_ids: [up.body.id] });
  assert.equal(sub.status, 201);
  assert.equal((await student.post('/api/verification/submit', { document_ids: [up.body.id] })).status, 409, 'only one open request');
  assert.equal((await student.get('/api/auth/me')).body.user.verification_status, 'pending');

  const officer = await staff('support_officer');
  const queue = await officer.get('/api/admin/verification?status=open');
  assert.ok(queue.body.requests.some((r: any) => r.id === sub.body.id));
  assert.equal((await student.get('/api/admin/verification')).status, 403);

  const noReason = await officer.post(`/api/admin/verification/${sub.body.id}/decide`, { decision: 'reject' });
  assert.equal(noReason.status, 422, 'rejections need a reason');

  const approve = await officer.post(`/api/admin/verification/${sub.body.id}/decide`, { decision: 'approve' });
  assert.equal(approve.status, 200);
  const me = (await student.get('/api/auth/me')).body.user;
  assert.equal(me.verification_status, 'verified');
  assert.deepEqual(me.roles, ['student']);
  assert.equal((await officer.post(`/api/admin/verification/${sub.body.id}/decide`, { decision: 'reject', reason: 'Changed my mind' })).status, 409, 'decisions are final');
  assert.ok(audits('verification.approve').length >= 1);
  assert.equal((await student.get('/api/mentors')).status, 200);

  // Changing affiliation resets verification and removes the role earned under the old claim.
  await student.put('/api/me/affiliation', { institution: 'Another University', id_number: 'ST/2024/001', department: 'Business', programme_of_study: 'BSc Entrepreneurship', level: '300' });
  const after = (await student.get('/api/auth/me')).body.user;
  assert.equal(after.verification_status, 'unverified');
  assert.deepEqual(after.roles, []);
});

test('staff cannot review or approve their own verification', async () => {
  const officer = await staff('support_officer');
  const other = await staff('support_officer');
  q.run("UPDATE users SET verification_status = 'pending' WHERE id = ?", officer.id);
  q.run("INSERT INTO verification_requests(id,user_id,category,status,snapshot,created_at) VALUES ('self-vr',?,?,?,?,?)", officer.id, 'student', 'submitted', '{}', new Date().toISOString());
  assert.equal((await officer.post('/api/admin/verification/self-vr/decide', { decision: 'approve' })).status, 403);
  assert.equal((await officer.post('/api/admin/verification/self-vr/claim')).status, 403);
  assert.equal((await other.post('/api/admin/verification/self-vr/decide', { decision: 'approve' })).status, 200);
});

test('documents: content sniffing, size limit, quarantine, private download and audited reviewer access', async () => {
  const u = await signup('external_entrepreneur');
  assert.equal((await u.upload('identity_document', Buffer.from('just some text pretending'), 'fake.pdf')).status, 415);
  assert.equal((await u.upload('identity_document', Buffer.from('<html><script>alert(1)</script></html>'), 'x.png')).status, 415);
  assert.equal((await u.upload('not_a_category', PDF)).status, 422);
  assert.equal((await u.upload('identity_document', Buffer.alloc(0))).status, 400);

  const big = Buffer.concat([PDF, Buffer.alloc(5.5 * 1024 * 1024)]);
  assert.equal((await u.upload('identity_document', big, 'big.pdf')).status, 413);

  const bad = Buffer.from('%PDF-1.4\n1 0 obj<</S/JavaScript /JS (app.alert(1))>>endobj\n');
  const quarantined = await u.upload('identity_document', bad, 'evil.pdf');
  assert.equal(quarantined.status, 201);
  assert.equal(quarantined.body.scan_status, 'quarantined');

  const good = await u.upload('identity_document', PDF, 'my id (1).pdf');
  const dl = await fetch(`${base}/api/documents/${good.body.id}/download`, { headers: { Cookie: u.cookie } });
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
  assert.match(dl.headers.get('content-disposition') ?? '', /^attachment;/);
  assert.equal(dl.headers.get('cache-control'), 'private, no-store');

  const stranger = await signup('student');
  assert.equal((await stranger.get(`/api/documents/${good.body.id}/download`)).status, 404, 'not yours looks the same as missing');
  assert.equal((await stranger.get('/api/documents/does-not-exist/download')).status, 404);
  assert.equal((await new Client().get(`/api/documents/${good.body.id}/download`)).status, 401);
  const reviewer = await staff('support_officer');
  assert.equal((await reviewer.get(`/api/documents/${good.body.id}/download`)).status, 200);
  assert.ok(audits('document.accessed_by_reviewer').some((a) => a.entity_id === good.body.id), 'reviewer access is recorded');
  assert.equal((await reviewer.get(`/api/documents/${quarantined.body.id}/download`)).status, 404, 'quarantined files are admin-only');

  const mine = await u.get('/api/documents/mine');
  assert.equal(mine.body.documents.length, 2);
  assert.ok(!JSON.stringify(mine.body).includes('storage_key'));
  assert.equal((await u.del(`/api/documents/${good.body.id}`)).status, 200);
});

test('verification rejects quarantined or foreign documents', async () => {
  const a = await signup('external_entrepreneur');
  const b = await signup('external_entrepreneur');
  const foreign = await b.upload('identity_document', PDF);
  const evil = await a.upload('identity_document', Buffer.from('%PDF-1.4\n/JavaScript\n'));
  assert.equal((await a.post('/api/verification/submit', { document_ids: [foreign.body.id] })).status, 400);
  assert.equal((await a.post('/api/verification/submit', { document_ids: [evil.body.id] })).status, 400);
});

test('more-info loop returns the request to the applicant and a new request can be filed', async () => {
  const c = await signup('external_participant');
  const doc = await c.upload('identity_document', PDF);
  const sub = await c.post('/api/verification/submit', { document_ids: [doc.body.id] });
  assert.equal(sub.status, 201);
  const officer = await staff('support_officer');
  const r = await officer.post(`/api/admin/verification/${sub.body.id}/decide`, { decision: 'more_info', reason: 'The scan is too dark to read.' });
  assert.equal(r.status, 200);
  const me = (await c.get('/api/auth/me')).body.user;
  assert.equal(me.verification_status, 'more_info_required');
  const again = await c.post('/api/verification/submit', { document_ids: [doc.body.id] });
  assert.equal(again.status, 201);
  const notes = (await c.get('/api/notifications')).body.notifications;
  assert.ok(notes.some((n: any) => n.title === 'More information needed'));
});

test('profile edits cannot change role, category or status; preferences persist', async () => {
  const c = await signup('student');
  const r = await c.patch('/api/me', { full_name: 'Renamed Person', category: 'partner', account_status: 'closed', roles: ['admin'] });
  assert.equal(r.status, 200);
  const me = await c.get('/api/me');
  assert.equal(me.body.user.full_name, 'Renamed Person');
  assert.equal(me.body.user.category, 'student');
  assert.equal(me.body.user.account_status, 'active');
  assert.deepEqual(me.body.user.roles, []);
  await c.put('/api/me/preferences', { email_enabled: false, in_app_enabled: true });
  assert.equal((await c.get('/api/me')).body.preferences.email_enabled, 0);
});

test('change password rotates the session and rejects a wrong current password', async () => {
  const c = await signup('student');
  assert.equal((await c.post('/api/auth/change-password', { current_password: 'nope-nope-1', new_password: 'Another-pass-77' })).status, 401);
  assert.equal((await c.post('/api/auth/change-password', { current_password: PASSWORD, new_password: 'Another-pass-77' })).status, 200);
  assert.equal((await c.get('/api/auth/me')).status, 200);
  assert.equal((await new Client().post('/api/auth/login', { email: c.email, password: PASSWORD })).status, 401);
});

test('admin may confirm an email manually (audited) because no email provider is connected', async () => {
  const c = new Client();
  const reg = await c.post('/api/auth/register', { email: 'manual@example.test', password: PASSWORD, full_name: 'Manual Confirm', category: 'student', accept_terms: true });
  assert.equal(reg.status, 201);
  const row = q.get<any>('SELECT id FROM users WHERE email = ?', 'manual@example.test')!;
  const admin = await staff('admin');
  assert.equal((await admin.post(`/api/admin/users/${row.id}/confirm-email`, { reason: 'Checked by phone' })).status, 200);
  assert.equal(q.get<any>('SELECT email_verified FROM users WHERE id = ?', row.id)!.email_verified, 1);
  assert.ok(audits('user.email_confirmed_by_admin').length >= 1);
  assert.equal((await admin.post(`/api/admin/users/${row.id}/confirm-email`, { reason: 'Again please' })).status, 409);
  forceVerified(admin);
});

test('confirmation emails can be re-requested until confirmed; requirements are published for the UI', async () => {
  const c = new Client();
  const email = 'resend@example.test';
  await c.post('/api/auth/register', { email, password: PASSWORD, full_name: 'Resend Person', category: 'student', accept_terms: true });
  assert.equal((await c.post('/api/auth/resend-verification')).status, 401, 'needs a session');
  await c.post('/api/auth/login', { email, password: PASSWORD });
  const r = await c.post('/api/auth/resend-verification');
  assert.equal(r.status, 200);
  assert.equal((await c.post('/api/auth/verify-email', { token: r.body.dev_verify_token })).status, 200);
  assert.equal((await c.post('/api/auth/resend-verification')).status, 409, 'already confirmed');
  const meta = await new Client().get('/api/meta');
  assert.equal(meta.body.verification_requirements.student.document, 'student_id');
  assert.ok(meta.body.verification_requirements.student.affiliation_fields.includes('institution'));
  assert.equal(meta.body.capabilities.email_delivery, false, 'the UI is told the truth about email');
});
