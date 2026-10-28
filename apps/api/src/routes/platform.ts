// Platform services: resource library, notifications, support, user administration, audit, configuration, reports, health.
import fs from 'node:fs';
import path from 'node:path';
import {
  Input, HttpError, audit, bad, config, conflict, forbidden, notFound, notify, now, parseJson, q, tx, uid, json,
} from '../core.ts';
import { get, post, put, patch, HANDLED, Created, type Ctx } from '../http.ts';
import {
  CATEGORIES, DOCUMENT_CATEGORIES, ROLES, STAFF_ROLES, PRIVILEGED_ROLES, can, hasRole, requireVerified, type AuthUser, type Role,
} from '../policy.ts';
import { PRIVACY_VERSION, REQUIRED_FIELDS, sendDocument } from './identity.ts';
import { confirmPassword } from '../stepup.ts';
import { REQUIRED_DOCUMENT } from '../policy.ts';

const label = (s: string) => s.replace(/_/g, ' ');
const eligibleFor = (list: string, u: AuthUser) => {
  const cats = parseJson<string[]>(list, []);
  return cats.length === 0 || cats.includes(u.category);
};

// =====================================================================
// Meta & health (public)
// =====================================================================
get('/api/health', () => {
  q.get('SELECT 1');
  return { status: 'ok', time: now() };
}, { auth: false });

get('/api/meta', () => ({
  categories: CATEGORIES, roles: ROLES, staff_roles: STAFF_ROLES, document_categories: DOCUMENT_CATEGORIES, privacy_version: PRIVACY_VERSION,
  stages: ['idea', 'validation', 'prototype', 'launch', 'growth'],
  verification_requirements: Object.fromEntries(CATEGORIES.map((c) => [c, { affiliation_fields: REQUIRED_FIELDS[c] ?? [], document: REQUIRED_DOCUMENT[c] ?? null }])),
  // Honest capability flags so the interface never implies something that is not wired up.
  capabilities: { email_delivery: false, antivirus_scanning: false, payment_gateway: false, ai_features: false, multi_factor_auth: false },
  max_upload_mb: Math.floor(config.maxUploadBytes / 1024 / 1024),
}), { auth: false });

// =====================================================================
// Dashboard (personalised next steps)
// =====================================================================
get('/api/dashboard', (c) => {
  const u = c.user;
  const steps: { text: string; link: string }[] = [];
  if (!u.email_verified) steps.push({ text: 'Confirm your email address.', link: '#/profile' });
  else if (u.verification_status === 'unverified' || u.verification_status === 'rejected') steps.push({ text: 'Complete your affiliation details and submit verification evidence.', link: '#/verification' });
  else if (u.verification_status === 'more_info_required') steps.push({ text: 'The reviewer needs more information for your verification.', link: '#/verification' });
  else if (u.verification_status === 'pending' || u.verification_status === 'under_review') steps.push({ text: 'Your verification is being reviewed.', link: '#/verification' });
  const verified = u.verification_status === 'verified';
  const count = (sql: string, ...p: unknown[]) => q.get<{ n: number }>(sql, ...p)!.n;
  const counts = {
    unread_notifications: count('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', u.id),
    ventures: count('SELECT COUNT(*) AS n FROM venture_members WHERE user_id = ?', u.id),
    open_milestones: count("SELECT COUNT(*) AS n FROM milestones WHERE status IN ('not_started','in_progress','changes_requested') AND venture_id IN (SELECT venture_id FROM venture_members WHERE user_id = ?)", u.id),
    overdue_milestones: count("SELECT COUNT(*) AS n FROM milestones WHERE status IN ('not_started','in_progress','changes_requested','blocked') AND due_date < ? AND venture_id IN (SELECT venture_id FROM venture_members WHERE user_id = ?)", now(), u.id),
    programme_applications: count('SELECT COUNT(*) AS n FROM programme_applications WHERE user_id = ?', u.id),
    upcoming_workshops: count("SELECT COUNT(*) AS n FROM workshop_registrations r JOIN workshops w ON w.id = r.workshop_id WHERE r.user_id = ? AND r.status = 'registered' AND w.status = 'published' AND w.starts_at > ?", u.id, now()),
    pending_mentor_requests: u.roles.includes('mentor') ? count("SELECT COUNT(*) AS n FROM mentorship_requests WHERE mentor_user_id = ? AND status = 'pending'", u.id) : 0,
    agreements_to_sign: count("SELECT COUNT(*) AS n FROM funding_applications WHERE status = 'approved' AND agreement_status = 'pending' AND applicant_id = ?", u.id),
  };
  if (verified && counts.ventures === 0) steps.push({ text: 'Create your first venture profile.', link: '#/ventures' });
  if (counts.overdue_milestones) steps.push({ text: `${counts.overdue_milestones} milestone(s) are overdue.`, link: '#/milestones' });
  if (counts.agreements_to_sign) steps.push({ text: 'A funding agreement is waiting for your signature.', link: '#/funding' });
  if (counts.pending_mentor_requests) steps.push({ text: `${counts.pending_mentor_requests} mentorship request(s) need your response.`, link: '#/mentorship' });
  const queues: Record<string, number> = {};
  if (can(u, 'verification.review')) queues.verification = count("SELECT COUNT(*) AS n FROM verification_requests WHERE status IN ('submitted','under_review')");
  if (can(u, 'mentor.review')) queues.mentor_applications = count("SELECT COUNT(*) AS n FROM mentor_applications WHERE status IN ('submitted','under_review')");
  if (can(u, 'venture.review')) queues.ventures = count("SELECT COUNT(*) AS n FROM ventures WHERE status IN ('submitted','under_review')");
  if (can(u, 'milestone.review')) queues.milestones = count("SELECT COUNT(*) AS n FROM milestones WHERE status = 'submitted'");
  if (can(u, 'funding.manage')) queues.funding = count("SELECT COUNT(*) AS n FROM funding_applications WHERE status IN ('submitted','eligibility_review','under_evaluation')");
  if (can(u, 'programme.manage')) queues.programme_applications = count("SELECT COUNT(*) AS n FROM programme_applications WHERE status IN ('submitted','under_review')");
  if (can(u, 'support.manage')) queues.support = count("SELECT COUNT(*) AS n FROM support_requests WHERE status <> 'resolved'");
  return { next_steps: steps, counts, queues };
});

// =====================================================================
// Resource library
// =====================================================================
const RESOURCE_TYPES = ['document', 'link', 'template', 'video'] as const;
const STAGES = ['idea', 'validation', 'prototype', 'launch', 'growth'] as const;

function readResource(c: Ctx, existing?: any) {
  const i = new Input(c.body);
  const req = !existing;
  const title = i.str('title', { min: 3, max: 160, required: req });
  const description = i.str('description', { max: 3000, required: false });
  const topic = i.str('topic', { max: 80, required: false });
  const type = i.oneOf('resource_type', RESOURCE_TYPES, req);
  const url = i.str('external_url', { max: 500, required: false });
  const docId = i.str('document_id', { max: 60, required: false });
  const cats = i.list('audience_categories', { allowed: CATEGORIES });
  const stage = i.oneOf('venture_stage', STAGES, false);
  i.done();
  let cleanUrl: string | null = null;
  if (url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme');
      cleanUrl = u.toString();
    } catch {
      throw new HttpError(422, 'validation_failed', 'Some fields need attention.', { external_url: 'Enter a valid http(s) link.' });
    }
  }
  if (docId && !q.get("SELECT 1 FROM documents WHERE id = ? AND owner_id = ? AND scan_status <> 'quarantined'", docId, c.user.id))
    throw new HttpError(422, 'validation_failed', 'Some fields need attention.', { document_id: 'Unknown document, or it failed safety checks.' });
  const t = type ?? existing?.resource_type;
  if ((t === 'link' || t === 'video') && !(cleanUrl ?? existing?.external_url)) throw new HttpError(422, 'validation_failed', 'Some fields need attention.', { external_url: 'A link is required for this resource type.' });
  if ((t === 'document' || t === 'template') && !(docId ?? existing?.document_id) && !(cleanUrl ?? existing?.external_url)) throw new HttpError(422, 'validation_failed', 'Some fields need attention.', { document_id: 'Attach a file or provide a link.' });
  return { title, description, topic, type, url: cleanUrl, docId, cats: i.has('audience_categories') ? cats : null, stage };
}

post('/api/resources', (c) => {
  const r = readResource(c);
  const id = uid();
  q.run(`INSERT INTO resources(id,title,description,topic,resource_type,external_url,document_id,audience_categories,venture_stage,status,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, r.title, r.description, r.topic, r.type, r.url, r.docId, json(r.cats ?? []), r.stage, 'draft', c.user.id, now());
  audit(c.user.id, 'resource.created', 'resource', id, null, c.ip);
  return new Created({ id });
}, { perm: 'resource.create' });

patch('/api/resources/:id', (c) => {
  const ex = q.get<any>('SELECT * FROM resources WHERE id = ?', c.params.id);
  // Creators may edit their own drafts; publishers may edit anything.
  if (!ex || (ex.created_by !== c.user.id && !can(c.user, 'resource.publish'))) throw notFound('Resource not found.');
  if (ex.status === 'archived') throw conflict('Archived resources cannot be edited.');
  if (ex.status === 'published' && !can(c.user, 'resource.publish')) throw forbidden('Published resources can only be changed by a publisher.');
  const r = readResource(c, ex);
  q.run(`UPDATE resources SET title=COALESCE(?,title), description=COALESCE(?,description), topic=COALESCE(?,topic), resource_type=COALESCE(?,resource_type), external_url=COALESCE(?,external_url),
         document_id=COALESCE(?,document_id), audience_categories=COALESCE(?,audience_categories), venture_stage=COALESCE(?,venture_stage) WHERE id=?`,
    r.title, r.description, r.topic, r.type, r.url, r.docId, r.cats ? json(r.cats) : null, r.stage, ex.id);
  audit(c.user.id, 'resource.updated', 'resource', ex.id, null, c.ip);
  return { ok: true };
}, { perm: 'resource.create' });

for (const [action, from, to] of [['publish', ['draft', 'archived'], 'published'], ['archive', ['draft', 'published'], 'archived']] as const) {
  post(`/api/resources/:id/${action}`, (c) => {
    tx(() => {
      const r = q.get<any>('SELECT * FROM resources WHERE id = ?', c.params.id);
      if (!r) throw notFound('Resource not found.');
      if (!(from as readonly string[]).includes(r.status)) throw conflict(`A resource that is ${r.status} cannot be ${to}.`);
      q.run('UPDATE resources SET status=?, published_at=CASE WHEN ?=\'published\' THEN ? ELSE published_at END WHERE id=?', to, to, now(), r.id);
      audit(c.user.id, `resource.${action}`, 'resource', r.id, null, c.ip);
    });
    return { ok: true };
  }, { perm: 'resource.publish' });
}

const resourceShape = (r: any) => ({
  id: r.id, title: r.title, description: r.description, topic: r.topic, resource_type: r.resource_type, external_url: r.external_url,
  has_file: !!r.document_id, audience_categories: parseJson(r.audience_categories, []), venture_stage: r.venture_stage, status: r.status, published_at: r.published_at,
});

get('/api/resources', (c) => {
  requireVerified(c.user);
  const topic = c.query.get('topic');
  const stage = c.query.get('stage');
  const type = c.query.get('type');
  const search = c.query.get('q')?.toLowerCase();
  const rows = q.all<any>("SELECT * FROM resources WHERE status = 'published' ORDER BY published_at DESC LIMIT 500")
    .filter((r) => eligibleFor(r.audience_categories, c.user) || can(c.user, 'resource.publish'))
    .filter((r) => (!topic || r.topic === topic) && (!stage || r.venture_stage === stage) && (!type || r.resource_type === type) && (!search || `${r.title} ${r.description ?? ''}`.toLowerCase().includes(search)));
  return { resources: rows.map(resourceShape), topics: [...new Set(rows.map((r) => r.topic).filter(Boolean))] };
});

get('/api/resources/mine', (c) => ({
  resources: q.all<any>('SELECT * FROM resources WHERE created_by = ? ORDER BY created_at DESC', c.user.id).map(resourceShape),
}), { perm: 'resource.create' });

get('/api/admin/resources', () => ({
  resources: q.all<any>('SELECT r.*, u.full_name AS author, (SELECT COUNT(*) FROM resource_downloads d WHERE d.resource_id = r.id) AS downloads FROM resources r JOIN users u ON u.id = r.created_by ORDER BY r.created_at DESC LIMIT 500')
    .map((r) => ({ ...resourceShape(r), author: r.author, downloads: r.downloads })),
}), { perm: 'resource.publish' });

get('/api/resources/:id/download', (c) => {
  const r = q.get<any>('SELECT * FROM resources WHERE id = ?', c.params.id);
  const privileged = !!r && (r.created_by === c.user.id || can(c.user, 'resource.publish'));
  if (!r || !r.document_id) throw notFound('Resource not found.');
  if (!privileged) {
    requireVerified(c.user);
    if (r.status !== 'published' || !eligibleFor(r.audience_categories, c.user)) throw notFound('Resource not found.');
  }
  const d = q.get<any>('SELECT * FROM documents WHERE id = ?', r.document_id);
  if (!d || d.scan_status === 'quarantined') throw notFound('The file is not available.');
  // One download counted per person per day, so counts cannot be inflated by refreshing.
  q.run('INSERT OR IGNORE INTO resource_downloads(id,resource_id,user_id,day,created_at) VALUES (?,?,?,?,?)', uid(), r.id, c.user.id, now().slice(0, 10), now());
  return sendDocument(c, d);
});

// =====================================================================
// Notifications
// =====================================================================
get('/api/notifications', (c) => ({
  notifications: q.all('SELECT id, type, title, body, link, read_at, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100', c.user.id),
  unread: q.get<{ n: number }>('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', c.user.id)!.n,
}));

post('/api/notifications/read-all', (c) => {
  q.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', now(), c.user.id);
  return { ok: true };
});

post('/api/notifications/:id/read', (c) => {
  const r = q.run('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?', now(), c.params.id, c.user.id);
  if (!r.changes) throw notFound('Notification not found.');
  return { ok: true };
});

// =====================================================================
// User administration
// =====================================================================
get('/api/admin/users', (c) => {
  const search = c.query.get('q')?.toLowerCase() || null;
  const status = c.query.get('status') || null;
  const role = c.query.get('role') || null;
  const rows = q.all<any>(
    `SELECT id, email, full_name, category, account_status, email_verified, verification_status, created_at FROM users
     WHERE (? IS NULL OR account_status = ?) AND (? IS NULL OR id IN (SELECT user_id FROM user_roles WHERE role = ?))
       AND (? IS NULL OR lower(email) LIKE '%' || ? || '%' OR lower(full_name) LIKE '%' || ? || '%') ORDER BY created_at DESC LIMIT 200`, status, status, role, role, search, search, search);
  const roles = q.all<{ user_id: string; role: string }>('SELECT user_id, role FROM user_roles');
  return { users: rows.map((u) => ({ ...u, roles: roles.filter((r) => r.user_id === u.id).map((r) => r.role) })) };
}, { perm: 'user.manage' });

get('/api/admin/users/:id', (c) => {
  const u = q.get<any>('SELECT id, email, full_name, phone, country, organization, category, account_status, email_verified, verification_status, created_at FROM users WHERE id = ?', c.params.id);
  if (!u) throw notFound();
  audit(c.user.id, 'user.viewed', 'user', u.id, null, c.ip);
  return { user: u, roles: q.all('SELECT role, granted_at FROM user_roles WHERE user_id = ?', u.id), affiliation: q.get('SELECT * FROM affiliations WHERE user_id = ?', u.id) };
}, { perm: 'user.manage' });

const isSuper = (u: AuthUser) => hasRole(u, 'super_admin');
function targetUser(id: string) {
  const u = q.get<any>('SELECT * FROM users WHERE id = ?', id);
  if (!u) throw notFound('User not found.');
  const roles = q.all<{ role: Role }>('SELECT role FROM user_roles WHERE user_id = ?', id).map((r) => r.role);
  return { ...u, roles } as any;
}

post('/api/admin/users/:id/status', (c) => {
  const i = new Input(c.body);
  const status = i.oneOf('status', ['active', 'suspended', 'disabled'] as const);
  const reason = i.str('reason', { min: 5, max: 1000 });
  const pw = i.str('confirm_password', { max: 128 });
  i.done();
  confirmPassword(c.user, pw, c.ip);
  tx(() => {
    const t = targetUser(c.params.id);
    if (t.id === c.user.id) throw forbidden('You cannot change your own account status.');
    if (t.roles.some((r: Role) => PRIVILEGED_ROLES.includes(r)) && !isSuper(c.user)) throw forbidden('Only a super administrator can change an administrator account.');
    if (t.account_status === 'closed') throw conflict('Closed accounts cannot be changed.');
    q.run('UPDATE users SET account_status=?, updated_at=? WHERE id=?', status, now(), t.id);
    if (status !== 'active') q.run('DELETE FROM sessions WHERE user_id = ?', t.id); // revoke access immediately
    audit(c.user.id, `user.status_${status}`, 'user', t.id, { from: t.account_status, reason }, c.ip);
  });
  return { ok: true };
}, { perm: 'user.manage' });

post('/api/admin/users/:id/roles', (c) => {
  const i = new Input(c.body);
  const role = i.oneOf('role', STAFF_ROLES as readonly string[] as readonly Role[]);
  const action = i.oneOf('action', ['grant', 'revoke'] as const);
  const reason = i.str('reason', { min: 5, max: 1000 });
  const pw = i.str('confirm_password', { max: 128 });
  i.done();
  confirmPassword(c.user, pw, c.ip);
  tx(() => {
    const t = targetUser(c.params.id);
    if (PRIVILEGED_ROLES.includes(role!) && !isSuper(c.user)) throw forbidden('Only a super administrator can grant or revoke administrator roles.');
    if (t.id === c.user.id) throw forbidden('You cannot change your own roles.');
    if (action === 'grant') {
      if (t.account_status !== 'active' || !t.email_verified) throw conflict('Staff roles can only be granted to active, email-confirmed accounts.');
      if (t.roles.includes(role)) throw conflict('That person already has this role.');
      q.run('INSERT INTO user_roles(user_id, role, granted_by, granted_at) VALUES (?,?,?,?)', t.id, role, c.user.id, now());
    } else {
      if (!t.roles.includes(role)) throw conflict('That person does not have this role.');
      if (role === 'super_admin' && q.get<{ n: number }>("SELECT COUNT(*) AS n FROM user_roles WHERE role = 'super_admin'")!.n <= 1) throw conflict('The last super administrator cannot be removed.');
      q.run('DELETE FROM user_roles WHERE user_id = ? AND role = ?', t.id, role);
    }
    audit(c.user.id, `role.${action}`, 'user', t.id, { role, reason }, c.ip);
    notify(t.id, 'account', `Role ${action === 'grant' ? 'granted' : 'removed'}`, `${label(role!)} role ${action === 'grant' ? 'added to' : 'removed from'} your account.`, '#/profile');
  });
  return { ok: true };
}, { perm: 'user.manage' });

// No email provider is connected, so an administrator may confirm an address after checking it another way. Always audited.
post('/api/admin/users/:id/confirm-email', (c) => {
  const i = new Input(c.body);
  const reason = i.str('reason', { min: 5, max: 500 });
  i.done();
  const t = targetUser(c.params.id);
  if (t.email_verified) throw conflict('This email address is already confirmed.');
  q.run('UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?', now(), t.id);
  audit(c.user.id, 'user.email_confirmed_by_admin', 'user', t.id, { reason }, c.ip);
  notify(t.id, 'account', 'Email confirmed', 'An administrator confirmed your email address.', '#/verification');
  return { ok: true };
}, { perm: 'user.manage' });

// =====================================================================
// Audit & configuration
// =====================================================================
get('/api/admin/audit', (c) => {
  const action = c.query.get('action') || null;
  const entity = c.query.get('entity') || null;
  const actor = c.query.get('actor') || null;
  const before = c.query.get('before') || null;
  const limit = Math.min(Math.max(Number(c.query.get('limit') ?? 100) || 100, 1), 500);
  const rows = q.all<any>(
    `SELECT a.id, a.action, a.entity, a.entity_id, a.details, a.created_at, u.full_name AS actor_name, a.actor_id FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id
     WHERE (? IS NULL OR a.action LIKE ? || '%') AND (? IS NULL OR a.entity = ?) AND (? IS NULL OR a.actor_id = ?) AND (? IS NULL OR a.created_at < ?) ORDER BY a.created_at DESC LIMIT ?`,
    action, action, entity, entity, actor, actor, before, before, limit);
  return { events: rows.map((r) => ({ ...r, details: parseJson(r.details, null) })) };
}, { perm: 'audit.view' });

const CONFIG_KEYS: Record<string, { min: number; max: number; default: number; description: string }> = {
  mentor_approvals_required: { min: 1, max: 5, default: config.mentorApprovalsRequired, description: 'Number of distinct reviewer approvals needed before a mentor is approved.' },
  review_overdue_days: { min: 1, max: 60, default: 7, description: 'Days a review item may wait before it is shown as overdue on the administration overview and in reports.' },
  funding_recommender_must_differ: { min: 0, max: 1, default: 0, description: '1 = the person who records a funding recommendation cannot also make the final decision. 0 = one officer may do both.' },
};
get('/api/admin/config', () => ({
  settings: Object.entries(CONFIG_KEYS).map(([key, def]) => ({
    key, ...def, value: Number(q.get<{ value: string }>('SELECT value FROM system_config WHERE key = ?', key)?.value ?? def.default),
  })),
}), { perm: 'config.manage' });

put('/api/admin/config', (c) => {
  const i = new Input(c.body);
  const key = i.oneOf('key', Object.keys(CONFIG_KEYS));
  const value = i.int('value');
  const pw = i.str('confirm_password', { max: 128 });
  i.done();
  confirmPassword(c.user, pw, c.ip);
  const def = CONFIG_KEYS[key!];
  if (value! < def.min || value! > def.max) throw new HttpError(422, 'validation_failed', 'Some fields need attention.', { value: `Must be between ${def.min} and ${def.max}.` });
  q.run('INSERT INTO system_config(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at', key, String(value), now());
  audit(c.user.id, 'config.updated', 'system_config', key, { value }, c.ip);
  return { ok: true };
}, { perm: 'config.manage' });

// =====================================================================
// Reports (server-side aggregates, small-count suppression for partners, anonymised CSV)
// =====================================================================
const SMALL = 5;
const exactCounts = (u: AuthUser) => hasRole(u, 'programme_coordinator', 'incubation_manager', 'funding_officer', 'admin', 'super_admin');
const shown = (n: number, exact: boolean): number | string => (exact || n === 0 || n >= SMALL ? n : `<${SMALL}`);
function grouped(sql: string, exact: boolean, ...p: unknown[]) {
  return q.all<{ k: string | null; n: number }>(sql, ...p).map((r) => ({ key: r.k ?? 'unspecified', count: shown(r.n, exact) }));
}

get('/api/reports/summary', (c) => {
  const exact = exactCounts(c.user);
  const total = (sql: string) => q.get<{ n: number }>(sql)!.n;
  const funding = q.get<any>(`SELECT COALESCE(SUM(CASE WHEN status IN ('approved','completed') THEN approved_amount END),0) AS approved,
                                     COALESCE(SUM(CASE WHEN disbursement_status='disbursed' THEN approved_amount END),0) AS disbursed,
                                     COALESCE(SUM(status IN ('approved','completed')),0) AS approved_n,
                                     COALESCE(SUM(disbursement_status='disbursed'),0) AS disbursed_n FROM funding_applications`);
  // A money total built from 1-4 grants can reveal an individual award, so it is withheld (null) from viewers who only get suppressed counts.
  const amount = (sum: number, n: number) => (exact || n === 0 || n >= SMALL ? sum : null);
  const approvedAmount = amount(funding.approved, funding.approved_n);
  const disbursedAmount = amount(funding.disbursed, funding.disbursed_n);
  const milestones = q.get<any>("SELECT COUNT(*) AS total, SUM(status='completed') AS completed, SUM(status='completed' AND evidence_type='verified') AS verified FROM milestones WHERE status <> 'cancelled'");
  const attendance = q.get<any>("SELECT SUM(status='registered') AS registered, SUM(attended=1) AS attended FROM workshop_registrations");
  const ratings = q.get<any>('SELECT AVG(feedback_rating) AS avg, COUNT(feedback_rating) AS n FROM workshop_registrations');
  const mentorFeedback = q.get<any>('SELECT AVG(rating) AS avg, COUNT(*) AS n FROM mentorship_feedback');
  return {
    suppression: exact ? 'none' : `Counts below ${SMALL} are hidden to protect individuals.`,
    generated_at: now(),
    members: {
      total_verified: shown(total("SELECT COUNT(*) AS n FROM users WHERE verification_status = 'verified'"), exact),
      by_category: grouped("SELECT category AS k, COUNT(*) AS n FROM users WHERE verification_status = 'verified' GROUP BY category", exact),
    },
    ventures: {
      by_stage: grouped("SELECT stage AS k, COUNT(*) AS n FROM ventures WHERE status <> 'draft' GROUP BY stage", exact),
      by_status: grouped("SELECT status AS k, COUNT(*) AS n FROM ventures WHERE status <> 'draft' GROUP BY status", exact),
      by_industry: grouped("SELECT industry AS k, COUNT(*) AS n FROM ventures WHERE status <> 'draft' GROUP BY industry ORDER BY n DESC LIMIT 15", exact),
    },
    programmes: {
      applications_by_status: grouped("SELECT status AS k, COUNT(*) AS n FROM programme_applications WHERE status <> 'draft' GROUP BY status", exact),
      published: shown(total("SELECT COUNT(*) AS n FROM programmes WHERE status IN ('published','closed')"), exact),
    },
    workshops: {
      published: shown(total("SELECT COUNT(*) AS n FROM workshops WHERE status IN ('published','completed')"), exact),
      registered: shown(attendance.registered ?? 0, exact), attended: shown(attendance.attended ?? 0, exact),
      average_rating: exact || (ratings.n ?? 0) >= SMALL ? (ratings.avg === null ? null : Math.round(ratings.avg * 10) / 10) : null,
    },
    mentorship: {
      active_mentors: shown(total("SELECT COUNT(*) AS n FROM user_roles WHERE role = 'mentor'"), exact),
      by_status: grouped('SELECT status AS k, COUNT(*) AS n FROM mentorship_requests GROUP BY status', exact),
      average_rating: exact || (mentorFeedback.n ?? 0) >= SMALL ? (mentorFeedback.avg === null ? null : Math.round(mentorFeedback.avg * 10) / 10) : null,
    },
    funding: {
      applications_by_status: grouped("SELECT status AS k, COUNT(*) AS n FROM funding_applications WHERE status <> 'draft' GROUP BY status", exact),
      approved_amount: approvedAmount, disbursed_amount: disbursedAmount,
      amounts_suppressed: approvedAmount === null || disbursedAmount === null,
      note: 'Disbursed amounts are payments recorded by staff; no payment gateway is connected.' + (approvedAmount === null || disbursedAmount === null ? ` Totals built from fewer than ${SMALL} grants are hidden to protect individuals.` : ''),
    },
    milestones: {
      total: shown(milestones.total ?? 0, exact),
      completed: shown(milestones.completed ?? 0, exact),
      verified_by_reviewer: shown(milestones.verified ?? 0, exact),
      note: 'Only milestones a reviewer has verified count as verified; everything else is self-reported.',
    },
  };
}, { perm: 'report.view' });

/** Spreadsheet programs run text starting with = + - @ as formulas. Prefix such cells so exports cannot execute anything. */
export const csvCell = (v: unknown): string => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const DATASETS: Record<string, { header: string[]; sql: string }> = {
  ventures: { header: ['industry', 'stage', 'status', 'created_month'], sql: "SELECT industry, stage, status, substr(created_at,1,7) AS created_month FROM ventures WHERE status <> 'draft' ORDER BY created_at" },
  programme_applications: { header: ['programme', 'applicant_category', 'status', 'submitted_month'], sql: "SELECT p.title AS programme, u.category AS applicant_category, a.status, substr(a.submitted_at,1,7) AS submitted_month FROM programme_applications a JOIN programmes p ON p.id = a.programme_id JOIN users u ON u.id = a.user_id WHERE a.status <> 'draft' ORDER BY a.submitted_at" },
  workshops: { header: ['title', 'mode', 'status', 'capacity', 'registered', 'attended'], sql: "SELECT w.title, w.mode, w.status, w.capacity, SUM(r.status='registered') AS registered, SUM(r.attended=1) AS attended FROM workshops w LEFT JOIN workshop_registrations r ON r.workshop_id = w.id WHERE w.status <> 'draft' GROUP BY w.id ORDER BY w.starts_at" },
  funding: { header: ['opportunity', 'status', 'requested_amount', 'approved_amount', 'disbursement_status'], sql: "SELECT o.title AS opportunity, a.status, a.requested_amount, a.approved_amount, a.disbursement_status FROM funding_applications a JOIN funding_opportunities o ON o.id = a.opportunity_id WHERE a.status <> 'draft' ORDER BY a.submitted_at" },
  milestones: { header: ['status', 'evidence_type', 'overdue', 'due_month'], sql: "SELECT status, evidence_type, CASE WHEN due_date < datetime('now') AND status NOT IN ('completed','cancelled') THEN 'yes' ELSE 'no' END AS overdue, substr(due_date,1,7) AS due_month FROM milestones WHERE status <> 'cancelled'" },
};

get('/api/reports/export.csv', (c) => {
  const name = c.query.get('dataset') ?? '';
  const ds = DATASETS[name];
  if (!ds) throw new HttpError(422, 'validation_failed', 'Unknown dataset.', { dataset: `Choose one of: ${Object.keys(DATASETS).join(', ')}` });
  const rows = q.all<Record<string, unknown>>(ds.sql);
  const body = [ds.header.join(','), ...rows.map((r) => ds.header.map((h) => csvCell(r[h])).join(','))].join('\n') + '\n';
  audit(c.user.id, 'report.exported', 'report', name, { rows: rows.length }, c.ip);
  c.res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="alabatt-ces-${name}.csv"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  c.res.end(body);
  return HANDLED;
}, { perm: 'report.export' });
