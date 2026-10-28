// Authentication, account lifecycle, affiliation, verification, and private document handling.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  Input, HttpError, audit, bad, checkPassword, config, conflict, forbidden, hashPassword, json, notFound, notify,
  now, parseJson, passwordProblem, q, queueEmail, randomToken, sha256, tx, uid, verifyPassword,
} from '../core.ts';
import { get, post, put, patch, del, Created, HANDLED, loadUser, rateLimit, SESSION_COOKIE, type Ctx } from '../http.ts';
import {
  CATEGORIES, DOCUMENT_CATEGORIES, PERMISSIONS, REQUIRED_DOCUMENT, can, categoryRole, require_, type AuthUser, type Permission,
} from '../policy.ts';

const DUMMY_HASH = hashPassword('not-a-real-password-1');
export const PRIVACY_VERSION = '2026-10';

function startSession(c: Ctx, userId: string) {
  const token = randomToken();
  const expires = new Date(Date.now() + config.sessionHours * 3600_000).toISOString();
  q.run('INSERT INTO sessions(token_hash, user_id, expires_at, created_at, ip) VALUES (?,?,?,?,?)', sha256(token), userId, expires, now(), c.ip);
  c.setCookie(SESSION_COOKIE, token, config.sessionHours * 3600);
}

function issueToken(userId: string, kind: 'email_verify' | 'password_reset', hours: number): string {
  const token = randomToken();
  q.run('INSERT INTO auth_tokens(token_hash, user_id, kind, expires_at) VALUES (?,?,?,?)', sha256(token), userId, kind, new Date(Date.now() + hours * 3600_000).toISOString());
  return token;
}

function publicUser(u: AuthUser) {
  return {
    id: u.id, email: u.email, full_name: u.full_name, category: u.category, roles: u.roles,
    account_status: u.account_status, email_verified: !!u.email_verified, verification_status: u.verification_status,
    // Convenience for UI visibility only; every endpoint re-checks on the server.
    permissions: (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(u, p)),
  };
}

// ---------- registration & sign-in ----------
post('/api/auth/register', (c) => {
  const i = new Input(c.body);
  const email = i.email('email');
  const password = i.str('password', { max: 128 });
  const full_name = i.str('full_name', { min: 2, max: 120 });
  const phone = i.str('phone', { max: 30, required: false });
  const country = i.str('country', { max: 80, required: false });
  const organization = i.str('organization', { max: 160, required: false });
  const category = i.oneOf('category', CATEGORIES);
  const accepted = i.bool('accept_terms', true);
  const pwProblem = passwordProblem(password);
  if (pwProblem) i.fail('password', pwProblem);
  if (i.has('accept_terms') && !accepted) i.fail('accept_terms', 'You must accept the terms and privacy notice.');
  if (category === 'partner' && !organization) i.fail('organization', 'Partners must name their organization.');
  i.done();
  const id = uid();
  const token = tx(() => {
    if (q.get('SELECT 1 FROM users WHERE email = ?', email)) throw conflict('An account with this email already exists.');
    q.run('INSERT INTO users(id,email,password_hash,full_name,phone,country,organization,category,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', id, email, hashPassword(password!), full_name, phone, country, organization, category, now(), now());
    q.run('INSERT INTO affiliations(user_id, organization, updated_at) VALUES (?,?,?)', id, organization, now());
    q.run('INSERT INTO notification_preferences(user_id) VALUES (?)', id);
    q.run('INSERT INTO consents(id,user_id,document,version,accepted_at) VALUES (?,?,?,?,?)', uid(), id, 'terms_and_privacy', PRIVACY_VERSION, now());
    const t = issueToken(id, 'email_verify', 48);
    queueEmail(email!, 'Confirm your ALABATT-CES email', `Confirm your address: ${config.appUrl}/#/verify-email?token=${t}`);
    audit(id, 'user.registered', 'user', id, { category }, c.ip);
    return t;
  });
  return new Created({ message: 'Account created. Check your email to confirm your address.', ...(config.devMode ? { dev_verify_token: token } : {}) });
}, { auth: false, limit: 20 });

post('/api/auth/resend-verification', (c) => {
  if (c.user.email_verified) throw conflict('Your email address is already confirmed.');
  rateLimit(`resend:${c.user.id}`, 5, 60 * 60_000);
  const token = issueToken(c.user.id, 'email_verify', 48);
  queueEmail(c.user.email, 'Confirm your ALABATT-CES email', `Confirm your address: ${config.appUrl}/#/verify-email?token=${token}`);
  audit(c.user.id, 'user.verification_email_resent', 'user', c.user.id, null, c.ip);
  return { message: 'A new confirmation link was requested.', ...(config.devMode ? { dev_verify_token: token } : {}) };
}, { allowInactive: true });

post('/api/auth/verify-email', (c) => {
  const i = new Input(c.body);
  const token = i.str('token', { max: 200 });
  i.done();
  tx(() => {
    const t = q.get<any>("SELECT * FROM auth_tokens WHERE token_hash = ? AND kind = 'email_verify'", sha256(token!));
    if (!t || t.used_at || t.expires_at < now()) throw bad('This confirmation link is invalid or has expired.');
    q.run('UPDATE auth_tokens SET used_at = ? WHERE token_hash = ?', now(), t.token_hash);
    q.run('UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?', now(), t.user_id);
    audit(t.user_id, 'user.email_verified', 'user', t.user_id, null, c.ip);
    notify(t.user_id, 'account', 'Email confirmed', 'Next, complete your profile and submit your verification evidence.', '#/verification');
  });
  return { ok: true };
}, { auth: false, limit: 30 });

post('/api/auth/login', (c) => {
  const i = new Input(c.body);
  const email = i.email('email');
  const password = i.str('password', { max: 128 });
  i.done();
  rateLimit(`login:${email}`, 15, 15 * 60_000);
  const u = q.get<any>('SELECT * FROM users WHERE email = ?', email);
  if (u?.locked_until && u.locked_until > now()) throw new HttpError(429, 'locked', 'Too many failed attempts. Try again later.');
  const ok = verifyPassword(password!, u?.password_hash ?? DUMMY_HASH);
  if (!u || !ok) {
    if (u) {
      const n = u.failed_logins + 1;
      q.run('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?', n >= 5 ? 0 : n, n >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null, u.id);
      audit(u.id, 'auth.login_failed', 'user', u.id, null, c.ip);
    }
    throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect.');
  }
  if (u.account_status === 'disabled' || u.account_status === 'closed') throw new HttpError(403, 'account_inactive', `This account is ${u.account_status}.`);
  q.run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', u.id);
  startSession(c, u.id);
  audit(u.id, 'auth.login', 'user', u.id, null, c.ip);
  return { user: publicUser(loadUser(u.id)!) };
}, { auth: false, limit: 40 });

post('/api/auth/logout', (c) => {
  const cookie = c.req.headers.cookie?.split(';').map((s) => s.trim()).find((s) => s.startsWith(SESSION_COOKIE + '='));
  if (cookie) q.run('DELETE FROM sessions WHERE token_hash = ?', sha256(decodeURIComponent(cookie.split('=')[1])));
  c.clearCookie(SESSION_COOKIE);
  return { ok: true };
}, { auth: false });

get('/api/auth/me', (c) => ({ user: publicUser(c.user) }), { allowInactive: true });

post('/api/auth/forgot-password', (c) => {
  const i = new Input(c.body);
  const email = i.email('email');
  i.done();
  const u = q.get<any>('SELECT id FROM users WHERE email = ?', email);
  let token: string | undefined;
  if (u) {
    token = issueToken(u.id, 'password_reset', 1);
    queueEmail(email!, 'Reset your ALABATT-CES password', `Reset link: ${config.appUrl}/#/reset-password?token=${token}`);
    audit(u.id, 'auth.password_reset_requested', 'user', u.id, null, c.ip);
  }
  // Same response whether or not the account exists (no account enumeration here).
  return { message: 'If that address is registered, a reset link has been sent.', ...(config.devMode && token ? { dev_reset_token: token } : {}) };
}, { auth: false, limit: 10 });

post('/api/auth/reset-password', (c) => {
  const i = new Input(c.body);
  const token = i.str('token', { max: 200 });
  const password = i.str('password', { max: 128 });
  i.done();
  checkPassword(password);
  tx(() => {
    const t = q.get<any>("SELECT * FROM auth_tokens WHERE token_hash = ? AND kind = 'password_reset'", sha256(token!));
    if (!t || t.used_at || t.expires_at < now()) throw bad('This reset link is invalid or has expired.');
    q.run('UPDATE auth_tokens SET used_at = ? WHERE token_hash = ?', now(), t.token_hash);
    q.run('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?', hashPassword(password!), now(), t.user_id);
    q.run('DELETE FROM sessions WHERE user_id = ?', t.user_id); // revoke every existing session
    audit(t.user_id, 'auth.password_reset', 'user', t.user_id, null, c.ip);
  });
  return { ok: true };
}, { auth: false, limit: 10 });

post('/api/auth/change-password', (c) => {
  const i = new Input(c.body);
  const current = i.str('current_password', { max: 128 });
  const next = i.str('new_password', { max: 128 });
  i.done();
  checkPassword(next);
  const row = q.get<any>('SELECT password_hash FROM users WHERE id = ?', c.user.id)!;
  if (!verifyPassword(current!, row.password_hash)) throw new HttpError(401, 'invalid_credentials', 'Current password is incorrect.');
  q.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hashPassword(next!), now(), c.user.id);
  q.run('DELETE FROM sessions WHERE user_id = ?', c.user.id);
  startSession(c, c.user.id);
  audit(c.user.id, 'auth.password_changed', 'user', c.user.id, null, c.ip);
  return { ok: true };
}, { limit: 10 });

// ---------- profile & affiliation ----------
get('/api/me', (c) => {
  const aff = q.get('SELECT * FROM affiliations WHERE user_id = ?', c.user.id);
  const u = q.get<any>('SELECT phone, country, organization FROM users WHERE id = ?', c.user.id);
  const prefs = q.get('SELECT email_enabled, in_app_enabled FROM notification_preferences WHERE user_id = ?', c.user.id);
  return { user: publicUser(c.user), profile: u, affiliation: aff, preferences: prefs };
});

patch('/api/me', (c) => {
  const i = new Input(c.body);
  const full_name = i.str('full_name', { min: 2, max: 120, required: false });
  const phone = i.str('phone', { max: 30, required: false });
  const country = i.str('country', { max: 80, required: false });
  const organization = i.str('organization', { max: 160, required: false });
  i.done();
  // Only presentation fields are editable here. Role, category, status and verification can never be set by the user.
  q.run('UPDATE users SET full_name = COALESCE(?, full_name), phone = COALESCE(?, phone), country = COALESCE(?, country), organization = COALESCE(?, organization), updated_at = ? WHERE id = ?', full_name, phone, country, organization, now(), c.user.id);
  return { ok: true };
});

put('/api/me/preferences', (c) => {
  const i = new Input(c.body);
  const email = i.bool('email_enabled');
  const inApp = i.bool('in_app_enabled');
  i.done();
  q.run('UPDATE notification_preferences SET email_enabled = COALESCE(?, email_enabled), in_app_enabled = COALESCE(?, in_app_enabled) WHERE user_id = ?', email, inApp, c.user.id);
  return { ok: true };
});

const AFFIL_FIELDS = ['institution', 'id_number', 'department', 'faculty', 'programme_of_study', 'level', 'position', 'organization', 'institutional_email'] as const;
put('/api/me/affiliation', (c) => {
  const i = new Input(c.body);
  const vals: Record<string, string | number | null> = {};
  for (const f of AFFIL_FIELDS) vals[f] = i.str(f, { max: 160, required: false });
  vals.graduation_year = i.int('graduation_year', { min: 1950, max: 2100, required: false });
  i.done();
  tx(() => {
    const before = q.get<any>('SELECT * FROM affiliations WHERE user_id = ?', c.user.id);
    q.run(`UPDATE affiliations SET institution=?, id_number=?, department=?, faculty=?, programme_of_study=?, level=?, position=?, organization=?, institutional_email=?, graduation_year=?, updated_at=? WHERE user_id=?`,
      vals.institution, vals.id_number, vals.department, vals.faculty, vals.programme_of_study, vals.level, vals.position, vals.organization, vals.institutional_email, vals.graduation_year, now(), c.user.id);
    const changed = AFFIL_FIELDS.some((f) => (before?.[f] ?? null) !== vals[f]) || (before?.graduation_year ?? null) !== vals.graduation_year;
    // Changing an affiliation never keeps privileges earned under the old claim: re-verification is required.
    if (changed && c.user.verification_status === 'verified') {
      q.run("UPDATE users SET verification_status = 'unverified', updated_at = ? WHERE id = ?", now(), c.user.id);
      const role = categoryRole(c.user.category);
      if (role) q.run('DELETE FROM user_roles WHERE user_id = ? AND role = ?', c.user.id, role);
      notify(c.user.id, 'verification', 'Re-verification required', 'You changed your affiliation details, so your verification must be reviewed again.', '#/verification');
      audit(c.user.id, 'verification.reset_on_affiliation_change', 'user', c.user.id, null, c.ip);
    }
  });
  return { ok: true };
});

// ---------- documents ----------
const GUESS = (b: Buffer): { mime: string; ext: string } | null => {
  if (b.subarray(0, 5).toString('latin1') === '%PDF-') return { mime: 'application/pdf', ext: 'pdf' };
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  return null;
};
/** Pluggable scanner. No antivirus engine is bundled; basic structural checks run and anything suspicious is quarantined. */
export function scanBuffer(b: Buffer, mime: string): 'basic_checks_passed' | 'quarantined' {
  if (mime === 'application/pdf') {
    const s = b.toString('latin1');
    if (/\/(JavaScript|JS|Launch|EmbeddedFile|OpenAction)\b/.test(s)) return 'quarantined';
  }
  if (b.includes(Buffer.from('<script', 'latin1')) || b.includes(Buffer.from('<?php', 'latin1'))) return 'quarantined';
  return 'basic_checks_passed';
}
const uploadDir = () => {
  const d = path.join(config.dataDir, 'uploads');
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
};
const safeName = (n: string) => n.replace(/[\\/]/g, '_').replace(/[^\w.\- ()]/g, '').slice(0, 120) || 'file';

export function storeUpload(owner: string, category: string, name: string, buf: Buffer, context = 'general', contextId: string | null = null) {
  if (!buf.length) throw bad('The file is empty.');
  if (buf.length > config.maxUploadBytes) throw new HttpError(413, 'payload_too_large', `Files may be at most ${Math.floor(config.maxUploadBytes / 1024 / 1024)} MB.`);
  const kind = GUESS(buf);
  if (!kind) throw new HttpError(415, 'unsupported_type', 'Only PDF, PNG and JPEG files are accepted.');
  const status = scanBuffer(buf, kind.mime);
  const key = randomBytes(24).toString('hex');
  fs.writeFileSync(path.join(uploadDir(), key), buf, { mode: 0o600 });
  const id = uid();
  q.run('INSERT INTO documents(id,owner_id,category,storage_key,original_name,mime,size,sha256,scan_status,context,context_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', id, owner, category, key, safeName(name), kind.mime, buf.length, sha256(buf), status, context, contextId, now());
  return { id, status, mime: kind.mime };
}

post('/api/documents', (c) => {
  const category = String(c.req.headers['x-category'] ?? '');
  if (!(DOCUMENT_CATEGORIES as readonly string[]).includes(category)) throw new HttpError(422, 'validation_failed', 'Unknown document category.', { category: `Allowed: ${DOCUMENT_CATEGORIES.join(', ')}` });
  const name = decodeURIComponent(String(c.req.headers['x-filename'] ?? 'upload'));
  const context = String(c.req.headers['x-context'] ?? 'general');
  const contextId = c.req.headers['x-context-id'] ? String(c.req.headers['x-context-id']) : null;
  if (!['general', 'venture', 'funding', 'milestone', 'mentor', 'verification', 'resource'].includes(context)) throw bad('Unknown context.');
  if (context === 'resource') require_(c.user, 'resource.create');
  if (context === 'venture' || context === 'milestone') {
    const vid = context === 'venture' ? contextId : q.get<any>('SELECT venture_id FROM milestones WHERE id = ?', contextId)?.venture_id;
    if (!vid || !(q.get('SELECT 1 FROM venture_members WHERE venture_id=? AND user_id=?', vid, c.user.id) || can(c.user, 'venture.review'))) throw forbidden();
  }
  rateLimit(`upload:${c.user.id}`, 60, 60 * 60_000);
  const r = storeUpload(c.user.id, category, name, c.raw ?? Buffer.alloc(0), context, contextId);
  audit(c.user.id, 'document.uploaded', 'document', r.id, { category, scan: r.status }, c.ip);
  return new Created({ id: r.id, scan_status: r.status, mime: r.mime });
}, { raw: true });

get('/api/documents/mine', (c) =>
  ({ documents: q.all('SELECT id, category, original_name, mime, size, scan_status, context, created_at FROM documents WHERE owner_id = ? ORDER BY created_at DESC', c.user.id) }));

const VERIFICATION_DOCS = ['student_id', 'staff_id', 'enrollment_evidence', 'alumni_evidence', 'identity_document', 'organization_evidence'];
const MENTOR_DOCS = ['mentor_credential', 'professional_certificate', 'reference'];

export function canAccessDocument(u: AuthUser, d: any): boolean {
  if (d.scan_status === 'quarantined') return can(u, 'user.manage');
  if (d.owner_id === u.id) return true;
  if (VERIFICATION_DOCS.includes(d.category)) return can(u, 'verification.review');
  if (MENTOR_DOCS.includes(d.category)) return can(u, 'mentor.review') || can(u, 'verification.review');
  if (d.context === 'venture' || d.context === 'milestone' || d.context === 'funding') {
    let vid: string | undefined;
    if (d.context === 'venture') vid = d.context_id;
    else if (d.context === 'milestone') vid = q.get<any>('SELECT venture_id FROM milestones WHERE id = ?', d.context_id)?.venture_id;
    else vid = q.get<any>('SELECT venture_id FROM funding_applications WHERE id = ?', d.context_id)?.venture_id;
    if (vid && q.get('SELECT 1 FROM venture_members WHERE venture_id=? AND user_id=?', vid, u.id)) return true;
    if (d.context === 'funding') return can(u, 'funding.review') || can(u, 'funding.manage');
    return can(u, 'venture.review');
  }
  return can(u, 'user.manage');
}

export function sendDocument(c: Ctx, d: any) {
  const file = path.join(uploadDir(), d.storage_key);
  if (!fs.existsSync(file)) throw notFound('The stored file is missing.');
  c.res.writeHead(200, {
    'Content-Type': d.mime, 'Content-Length': d.size, 'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `attachment; filename="${d.original_name.replace(/"/g, '')}"`, 'Cache-Control': 'private, no-store',
  });
  fs.createReadStream(file).pipe(c.res);
  return HANDLED;
}

get('/api/documents/:id/download', (c) => {
  const d = q.get<any>('SELECT * FROM documents WHERE id = ?', c.params.id);
  // Same response for "missing" and "not yours" so identifiers cannot be probed.
  if (!d || !canAccessDocument(c.user, d)) throw notFound('Document not found.');
  if (d.owner_id !== c.user.id) audit(c.user.id, 'document.accessed_by_reviewer', 'document', d.id, { owner: d.owner_id, category: d.category }, c.ip);
  return sendDocument(c, d);
});

del('/api/documents/:id', (c) => {
  const d = q.get<any>('SELECT * FROM documents WHERE id = ? AND owner_id = ?', c.params.id, c.user.id);
  if (!d) throw notFound('Document not found.');
  const inUse = q.get('SELECT 1 FROM verification_requests WHERE user_id = ? AND snapshot LIKE ?', c.user.id, `%${d.id}%`);
  if (inUse) throw conflict('This document is part of a verification record and is retained.');
  q.run('DELETE FROM documents WHERE id = ?', d.id);
  fs.rmSync(path.join(uploadDir(), d.storage_key), { force: true });
  audit(c.user.id, 'document.deleted', 'document', d.id, null, c.ip);
  return { ok: true };
});

// ---------- verification ----------
export const REQUIRED_FIELDS: Record<string, string[]> = {
  student: ['institution', 'id_number', 'department', 'programme_of_study', 'level'],
  lecturer: ['institution', 'id_number', 'department', 'position'],
  alumni: ['institution', 'department', 'graduation_year'],
  external_entrepreneur: [],
  external_participant: [],
  partner: ['organization', 'position'],
  mentor_applicant: [],
};

post('/api/verification/submit', (c) => {
  const u = c.user;
  if (!u.email_verified) throw new HttpError(403, 'email_unverified', 'Confirm your email address first.');
  const i = new Input(c.body);
  const docIds = i.list('document_ids', { max: 6, itemMax: 60 });
  i.done();
  const aff = q.get<any>('SELECT * FROM affiliations WHERE user_id = ?', u.id) ?? {};
  const missing = (REQUIRED_FIELDS[u.category] ?? []).filter((f) => !aff[f]);
  if (missing.length) throw new HttpError(422, 'validation_failed', 'Complete your affiliation details first.', Object.fromEntries(missing.map((m) => [m, 'Required for your category.'])));
  const need = REQUIRED_DOCUMENT[u.category];
  const docs = docIds.map((id) => q.get<any>('SELECT * FROM documents WHERE id = ? AND owner_id = ?', id, u.id));
  if (docs.some((d) => !d)) throw bad('One of the documents is not yours or does not exist.');
  if (docs.some((d) => d.scan_status === 'quarantined')) throw bad('A selected document failed safety checks and cannot be used.');
  if (need && !docs.some((d) => d.category === need)) throw new HttpError(422, 'validation_failed', 'Required evidence is missing.', { document_ids: `Upload and attach a "${need}" document.` });
  const id = uid();
  tx(() => {
    if (u.verification_status === 'verified') throw conflict('You are already verified.');
    if (q.get("SELECT 1 FROM verification_requests WHERE user_id = ? AND status IN ('submitted','under_review')", u.id)) throw conflict('A verification request is already awaiting review.');
    q.run('INSERT INTO verification_requests(id,user_id,category,status,snapshot,created_at) VALUES (?,?,?,?,?,?)', id, u.id, u.category, 'submitted', json({ affiliation: aff, document_ids: docIds }), now());
    q.run("UPDATE users SET verification_status = 'pending', updated_at = ? WHERE id = ?", now(), u.id);
    audit(u.id, 'verification.submitted', 'verification_request', id, { category: u.category }, c.ip);
  });
  for (const r of q.all<any>("SELECT DISTINCT user_id FROM user_roles WHERE role IN ('support_officer','admin','super_admin')")) notify(r.user_id, 'review', 'New verification request', `${u.full_name} (${u.category}) is awaiting review.`, '#/admin/verification');
  return new Created({ id });
});

get('/api/verification/mine', (c) =>
  ({ requests: q.all('SELECT id, category, status, decision_reason, created_at, decided_at FROM verification_requests WHERE user_id = ? ORDER BY created_at DESC', c.user.id) }));

get('/api/admin/verification', (c) => {
  const status = c.query.get('status') || null;
  const rows = q.all<any>(
    `SELECT vr.id, vr.category, vr.status, vr.created_at, vr.decided_at, u.full_name, u.email FROM verification_requests vr JOIN users u ON u.id = vr.user_id
     WHERE (? IS NULL OR (? = 'open' AND vr.status IN ('submitted','under_review')) OR vr.status = ?) ORDER BY vr.created_at ASC LIMIT 200`, status, status, status);
  return { requests: rows };
}, { perm: 'verification.review' });

get('/api/admin/verification/:id', (c) => {
  const r = q.get<any>('SELECT vr.*, u.full_name, u.email, u.email_verified FROM verification_requests vr JOIN users u ON u.id = vr.user_id WHERE vr.id = ?', c.params.id);
  if (!r) throw notFound();
  const snap = parseJson<any>(r.snapshot, {});
  const documents = (snap.document_ids ?? []).map((id: string) => q.get('SELECT id, category, original_name, mime, size, scan_status FROM documents WHERE id = ?', id)).filter(Boolean);
  audit(c.user.id, 'verification.viewed', 'verification_request', r.id, null, c.ip);
  return { request: { ...r, snapshot: snap }, documents };
}, { perm: 'verification.review' });

post('/api/admin/verification/:id/claim', (c) => {
  const r = q.get<any>('SELECT * FROM verification_requests WHERE id = ?', c.params.id);
  if (!r) throw notFound();
  if (r.user_id === c.user.id) throw forbidden('You cannot review your own verification.');
  if (r.status !== 'submitted') throw conflict(`Request is ${r.status}.`);
  q.run("UPDATE verification_requests SET status = 'under_review', reviewer_id = ? WHERE id = ?", c.user.id, r.id);
  q.run("UPDATE users SET verification_status = 'under_review' WHERE id = ?", r.user_id);
  audit(c.user.id, 'verification.claimed', 'verification_request', r.id, null, c.ip);
  return { ok: true };
}, { perm: 'verification.review' });

post('/api/admin/verification/:id/decide', (c) => {
  const i = new Input(c.body);
  const decision = i.oneOf('decision', ['approve', 'reject', 'more_info'] as const);
  const reason = i.str('reason', { max: 1000, required: decision !== 'approve', min: decision === 'approve' ? 0 : 5 });
  i.done();
  tx(() => {
    const r = q.get<any>('SELECT * FROM verification_requests WHERE id = ?', c.params.id);
    if (!r) throw notFound();
    if (r.user_id === c.user.id) throw forbidden('You cannot decide on your own verification.'); // separation of duties
    if (!['submitted', 'under_review'].includes(r.status)) throw conflict(`This request is already ${r.status}.`);
    const next = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'more_info_required';
    q.run('UPDATE verification_requests SET status=?, reviewer_id=?, decision_reason=?, decided_at=? WHERE id=?', next, c.user.id, reason, now(), r.id);
    const userStatus = decision === 'approve' ? 'verified' : decision === 'reject' ? 'rejected' : 'more_info_required';
    q.run('UPDATE users SET verification_status=?, updated_at=? WHERE id=?', userStatus, now(), r.user_id);
    if (decision === 'approve') {
      const role = categoryRole(r.category);
      if (role) q.run('INSERT OR IGNORE INTO user_roles(user_id, role, granted_by, granted_at) VALUES (?,?,?,?)', r.user_id, role, c.user.id, now());
    }
    audit(c.user.id, `verification.${decision}`, 'verification_request', r.id, { reason }, c.ip);
    notify(r.user_id, 'verification',
      decision === 'approve' ? 'You are verified' : decision === 'reject' ? 'Verification not approved' : 'More information needed',
      reason ?? 'Your verification was approved.', '#/verification');
  });
  return { ok: true };
}, { perm: 'verification.review' });
