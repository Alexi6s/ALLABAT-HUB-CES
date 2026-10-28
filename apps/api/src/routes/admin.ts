// Administration portal services: operational overview, staff directory, reviewer assignment (single and bulk),
// and privileged role requests. Visibility is permission-based: a staff member only ever sees figures for areas
// they hold a permission for (a programme officer does not receive funding figures, for example).
import {
  Input, HttpError, audit, conflict, config, forbidden, getConfigNumber, likeTerm, notFound, notify, now, pageInfo, paging, q, tx, uid,
} from '../core.ts';
import { get, post, Created, loadUser } from '../http.ts';
import { PERMISSIONS, PRIVILEGED_ROLES, STAFF_ROLES, can, hasRole, requireVerified, type AuthUser, type Permission, type Role } from '../policy.ts';
import { confirmPassword } from '../stepup.ts';

const label = (s: string) => s.replace(/_/g, ' ');
const n = (sql: string, ...p: unknown[]) => q.get<{ n: number }>(sql, ...p)!.n;
const daysAgo = (d: number) => new Date(Date.now() - d * 864e5).toISOString();

// ---------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------
type Card = { key: string; label: string; value: number; link: string; tone?: 'attention' | 'info'; hint?: string };

export const OPEN_STATUS = {
  programme_application: ['submitted', 'under_review'],
  funding_application: ['submitted', 'eligibility_review', 'under_evaluation'],
  support: ['open', 'in_progress'],
} as const;
const inList = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(',');

get('/api/admin/overview', (c) => {
  const u = c.user;
  const overdueDays = getConfigNumber('review_overdue_days', 7);
  const cutoff = daysAgo(overdueDays);
  const cards: Card[] = [];
  const add = (perm: Permission, card: Card) => { if (can(u, perm)) cards.push(card); };

  add('user.manage', { key: 'users_total', label: 'Registered accounts', value: n('SELECT COUNT(*) AS n FROM users'), link: '#/admin/users' });
  add('user.manage', { key: 'users_new', label: 'New accounts, last 7 days', value: n('SELECT COUNT(*) AS n FROM users WHERE created_at >= ?', daysAgo(7)), link: '#/admin/users' });
  add('user.manage', { key: 'role_requests', label: 'Role requests waiting', value: n("SELECT COUNT(*) AS n FROM role_requests WHERE status = 'pending'"), link: '#/admin/role-requests', tone: 'attention' });

  const vOpen = "status IN ('submitted','under_review')";
  add('verification.review', { key: 'verification_open', label: 'Verification requests waiting', value: n(`SELECT COUNT(*) AS n FROM verification_requests WHERE ${vOpen}`), link: '#/admin/verification', tone: 'attention' });
  add('verification.review', { key: 'verification_overdue', label: `Verification waiting over ${overdueDays} days`, value: n(`SELECT COUNT(*) AS n FROM verification_requests WHERE ${vOpen} AND created_at < ?`, cutoff), link: '#/admin/verification' });

  add('mentor.review', { key: 'mentor_open', label: 'Mentor applications waiting', value: n(`SELECT COUNT(*) AS n FROM mentor_applications WHERE ${vOpen}`), link: '#/admin/mentors', tone: 'attention' });
  add('mentor.review', { key: 'mentor_overdue', label: `Mentor applications waiting over ${overdueDays} days`, value: n(`SELECT COUNT(*) AS n FROM mentor_applications WHERE ${vOpen} AND submitted_at < ?`, cutoff), link: '#/admin/mentors' });
  add('mentor.review', { key: 'mentoring_conflicts', label: 'Mentoring conflict reports open', value: n("SELECT COUNT(*) AS n FROM mentorship_conflicts WHERE status = 'open'"), link: '#/admin/mentoring', tone: 'attention' });

  add('venture.review', { key: 'ventures_open', label: 'Ventures awaiting review', value: n(`SELECT COUNT(*) AS n FROM ventures WHERE ${vOpen}`), link: '#/admin/ventures', tone: 'attention' });
  add('milestone.review', { key: 'milestones_open', label: 'Milestone evidence awaiting review', value: n("SELECT COUNT(*) AS n FROM milestones WHERE status = 'submitted'"), link: '#/admin/milestones', tone: 'attention' });

  const pOpen = inList(OPEN_STATUS.programme_application);
  add('programme.manage', { key: 'programme_open', label: 'Programme applications waiting', value: n(`SELECT COUNT(*) AS n FROM programme_applications WHERE status IN (${pOpen})`), link: '#/admin/programmes', tone: 'attention' });
  add('programme.manage', { key: 'programme_unassigned', label: 'Programme applications unassigned', value: n(`SELECT COUNT(*) AS n FROM programme_applications WHERE status IN (${pOpen}) AND assigned_to IS NULL`), link: '#/admin/programmes' });
  add('programme.manage', { key: 'programme_overdue', label: `Programme applications waiting over ${overdueDays} days`, value: n(`SELECT COUNT(*) AS n FROM programme_applications WHERE status IN (${pOpen}) AND submitted_at < ?`, cutoff), link: '#/admin/programmes' });

  const fOpen = inList(OPEN_STATUS.funding_application);
  add('funding.manage', { key: 'funding_open', label: 'Funding requests in review', value: n(`SELECT COUNT(*) AS n FROM funding_applications WHERE status IN (${fOpen})`), link: '#/admin/funding', tone: 'attention' });
  add('funding.manage', { key: 'funding_unassigned', label: 'Funding requests unassigned', value: n(`SELECT COUNT(*) AS n FROM funding_applications WHERE status IN (${fOpen}) AND assigned_to IS NULL`), link: '#/admin/funding' });
  add('funding.manage', { key: 'funding_overdue', label: `Funding requests waiting over ${overdueDays} days`, value: n(`SELECT COUNT(*) AS n FROM funding_applications WHERE status IN (${fOpen}) AND submitted_at < ?`, cutoff), link: '#/admin/funding' });
  add('funding.disburse', { key: 'funding_to_pay', label: 'Approved and signed, payment not yet recorded', value: n("SELECT COUNT(*) AS n FROM funding_applications WHERE status = 'approved' AND agreement_status = 'signed' AND disbursement_status <> 'disbursed'"), link: '#/admin/funding', hint: 'Recording a payment does not move money; no payment gateway is connected.' });

  const sOpen = inList(OPEN_STATUS.support);
  add('support.manage', { key: 'support_open', label: 'Open support tickets', value: n(`SELECT COUNT(*) AS n FROM support_requests WHERE status IN (${sOpen})`), link: '#/admin/support', tone: 'attention' });
  add('support.manage', { key: 'support_unassigned', label: 'Support tickets unassigned', value: n(`SELECT COUNT(*) AS n FROM support_requests WHERE status IN (${sOpen}) AND assigned_to IS NULL`), link: '#/admin/support' });
  add('support.manage', { key: 'support_overdue', label: `Support tickets waiting over ${overdueDays} days`, value: n(`SELECT COUNT(*) AS n FROM support_requests WHERE status IN (${sOpen}) AND created_at < ?`, cutoff), link: '#/admin/support' });

  // My assigned work, and who is carrying what (only for the kinds this person manages).
  const mine: Record<string, number> = {};
  if (can(u, 'programme.manage')) mine.programme_applications = n(`SELECT COUNT(*) AS n FROM programme_applications WHERE assigned_to = ? AND status IN (${pOpen})`, u.id);
  if (can(u, 'funding.manage')) mine.funding_applications = n(`SELECT COUNT(*) AS n FROM funding_applications WHERE assigned_to = ? AND status IN (${fOpen})`, u.id);
  if (can(u, 'support.manage')) mine.support = n(`SELECT COUNT(*) AS n FROM support_requests WHERE assigned_to = ? AND status IN (${sOpen})`, u.id);

  const load = new Map<string, { user_id: string; name: string; programme_applications: number; funding_applications: number; support: number }>();
  const tally = (perm: Permission, key: 'programme_applications' | 'funding_applications' | 'support', table: string, open: string) => {
    if (!can(u, perm)) return;
    for (const r of q.all<{ id: string; name: string; c: number }>(`SELECT u.id AS id, u.full_name AS name, COUNT(*) AS c FROM ${table} t JOIN users u ON u.id = t.assigned_to WHERE t.status IN (${open}) GROUP BY u.id`)) {
      const row = load.get(r.id) ?? { user_id: r.id, name: r.name, programme_applications: 0, funding_applications: 0, support: 0 };
      row[key] = r.c;
      load.set(r.id, row);
    }
  };
  tally('programme.manage', 'programme_applications', 'programme_applications', pOpen);
  tally('funding.manage', 'funding_applications', 'funding_applications', fOpen);
  tally('support.manage', 'support', 'support_requests', sOpen);

  let delivery: Record<string, unknown> | undefined;
  if (can(u, 'user.manage') || can(u, 'config.manage')) {
    const by = q.all<{ status: string; c: number }>('SELECT status, COUNT(*) AS c FROM email_outbox GROUP BY status');
    delivery = {
      email_delivery_configured: !!config.smtp.host,
      by_status: Object.fromEntries(by.map((r) => [r.status, r.c])),
      note: config.smtp.host ? 'Failed messages keep their last error and are retried with back-off.' : 'No email provider is configured: messages are queued but never sent. Members rely on in-app notifications.',
    };
  }

  return { generated_at: now(), overdue_days: overdueDays, cards, mine, workload: [...load.values()].sort((a, b) => a.name.localeCompare(b.name)), delivery };
}, { perm: 'portal.admin' });

// ---------------------------------------------------------------------
// Staff directory (for assignee pickers)
// ---------------------------------------------------------------------
get('/api/admin/staff', (c) => {
  const perm = c.query.get('permission') ?? 'portal.admin';
  if (!(perm in PERMISSIONS)) throw new HttpError(422, 'validation_failed', 'Some fields need attention.', { permission: 'Unknown permission.' });
  const roles = PERMISSIONS[perm as Permission] as readonly string[];
  const rows = q.all<{ id: string; full_name: string }>(
    `SELECT u.id, u.full_name FROM users u WHERE u.account_status = 'active'
       AND u.id IN (SELECT user_id FROM user_roles WHERE role IN (${roles.map(() => '?').join(',')})) ORDER BY u.full_name LIMIT 200`, ...roles);
  const held = q.all<{ user_id: string; role: string }>(`SELECT user_id, role FROM user_roles WHERE role IN (${STAFF_ROLES.map(() => '?').join(',')})`, ...STAFF_ROLES);
  return { staff: rows.map((r) => ({ ...r, roles: held.filter((h) => h.user_id === r.id).map((h) => h.role) })) };
}, { perm: 'portal.admin' });

// ---------------------------------------------------------------------
// Assignment (single and bulk)
// ---------------------------------------------------------------------
type Kind = 'programme_application' | 'funding_application' | 'support';
const KINDS: Record<Kind, { table: string; manage: Permission; assignee: Permission; ownerCol: string; open: readonly string[]; ventureCol?: string; link: (id: string) => string; noun: string }> = {
  programme_application: { table: 'programme_applications', manage: 'programme.manage', assignee: 'programme.manage', ownerCol: 'user_id', open: OPEN_STATUS.programme_application, link: () => '#/admin/programmes', noun: 'programme application' },
  funding_application: { table: 'funding_applications', manage: 'funding.manage', assignee: 'funding.review', ownerCol: 'applicant_id', ventureCol: 'venture_id', open: OPEN_STATUS.funding_application, link: (id) => `#/admin/funding/applications/${id}`, noun: 'funding application' },
  support: { table: 'support_requests', manage: 'support.manage', assignee: 'support.manage', ownerCol: 'user_id', open: OPEN_STATUS.support, link: () => '#/admin/support', noun: 'support ticket' },
};

export function assignOne(actor: AuthUser, kind: Kind, id: string, assigneeId: string | null, ip?: string) {
  const k = KINDS[kind];
  if (!can(actor, k.manage)) throw forbidden();
  const row = q.get<any>(`SELECT * FROM ${k.table} WHERE id = ?`, id);
  if (!row || row.status === 'draft') throw notFound();
  if (!k.open.includes(row.status)) throw conflict(`Only open items can be assigned. This ${k.noun} is ${label(row.status)}.`);
  if (assigneeId) {
    const a = loadUser(assigneeId);
    if (!a || a.account_status !== 'active' || !can(a, k.assignee)) throw new HttpError(422, 'validation_failed', 'Some fields need attention.', { assignee_id: `That person cannot review ${k.noun}s.` });
    if (a.id === row[k.ownerCol]) throw conflict(`A ${k.noun} cannot be assigned to the person who submitted it.`);
    if (k.ventureCol && q.get('SELECT 1 FROM venture_members WHERE venture_id = ? AND user_id = ?', row[k.ventureCol], a.id)) throw conflict('That reviewer belongs to the venture and cannot be assigned.');
  }
  q.run(`UPDATE ${k.table} SET assigned_to = ?, assigned_at = ? WHERE id = ?`, assigneeId, assigneeId ? now() : null, id);
  audit(actor.id, assigneeId ? 'assignment.set' : 'assignment.cleared', kind, id, { assignee: assigneeId, previous: row.assigned_to ?? null }, ip);
  if (assigneeId && assigneeId !== actor.id) notify(assigneeId, 'assignment', `A ${k.noun} was assigned to you`, `Open your queue to review it.`, k.link(id));
}

const assignHandler = (kind: Kind) => (c: any) => {
  const i = new Input(c.body);
  const assignee = i.str('assignee_id', { required: false, max: 64 });
  i.done();
  tx(() => assignOne(c.user, kind, c.params.id, assignee, c.ip));
  return { ok: true };
};
post('/api/admin/programme-applications/:id/assign', assignHandler('programme_application'), { perm: 'programme.manage' });
post('/api/admin/funding/applications/:id/assign', assignHandler('funding_application'), { perm: 'funding.manage' });
post('/api/admin/support/:id/assign', assignHandler('support'), { perm: 'support.manage' });

post('/api/admin/bulk/assign', (c) => {
  const i = new Input(c.body);
  const kind = i.oneOf('kind', Object.keys(KINDS) as Kind[]);
  const ids = i.list('ids', { max: 50, itemMax: 64 });
  const assignee = i.str('assignee_id', { required: false, max: 64 });
  const confirm = i.bool('confirm', true);
  i.done();
  if (!ids.length) throw new HttpError(422, 'validation_failed', 'Some fields need attention.', { ids: 'Choose at least one item.' });
  if (confirm !== true) throw new HttpError(422, 'validation_failed', 'Some fields need attention.', { confirm: 'Confirm that you want to change every selected item.' });
  const unique = [...new Set(ids)];
  if (!can(c.user, KINDS[kind!].manage)) throw forbidden();
  tx(() => {
    for (const id of unique) {
      try { assignOne(c.user, kind!, id, assignee, c.ip); } catch (e) {
        if (e instanceof HttpError) throw new HttpError(e.status, e.code, `Nothing was changed. Item ${id}: ${e.message}`, e.details); // all-or-nothing
        throw e;
      }
    }
    audit(c.user.id, 'bulk.assign', kind!, null, { count: unique.length, ids: unique, assignee }, c.ip);
  });
  return { ok: true, changed: unique.length };
});

// ---------------------------------------------------------------------
// Role requests: a person asks for a staff role; an administrator decides. A request never grants anything by itself.
// ---------------------------------------------------------------------
const REQUESTABLE: Role[] = ['programme_coordinator', 'funding_officer', 'incubation_manager', 'support_officer', 'admin'];

post('/api/role-requests', (c) => {
  const i = new Input(c.body);
  const role = i.oneOf('role', REQUESTABLE);
  const organisation = i.str('organisation', { max: 200, required: false });
  const justification = i.str('justification', { min: 20, max: 2000 });
  const evidence = i.str('evidence_document_id', { required: false, max: 64 });
  i.done();
  requireVerified(c.user);
  if (c.user.roles.includes(role!)) throw conflict('You already hold that role.');
  if (evidence) {
    const d = q.get<any>('SELECT owner_id, scan_status FROM documents WHERE id = ?', evidence);
    if (!d || d.owner_id !== c.user.id || d.scan_status === 'quarantined') throw new HttpError(422, 'validation_failed', 'Some fields need attention.', { evidence_document_id: 'Choose one of your own uploaded files.' });
  }
  const id = uid();
  try {
    q.run('INSERT INTO role_requests(id,user_id,role,organisation,justification,evidence_document_id,status,created_at) VALUES (?,?,?,?,?,?,?,?)', id, c.user.id, role, organisation, justification, evidence, 'pending', now());
  } catch {
    throw conflict('You already have a pending request for that role.');
  }
  audit(c.user.id, 'role_request.submitted', 'role_request', id, { role }, c.ip);
  const admins = q.all<{ user_id: string }>(`SELECT DISTINCT user_id FROM user_roles WHERE role IN (${(PERMISSIONS['user.manage'] as readonly string[]).map(() => '?').join(',')})`, ...PERMISSIONS['user.manage']);
  for (const a of admins) notify(a.user_id, 'role_request', 'A role request needs a decision', `${c.user.full_name} asked for the ${label(role!)} role.`, '#/admin/role-requests', `rolereq:${id}`);
  return new Created({ id });
});

get('/api/role-requests/mine', (c) => ({
  requests: q.all('SELECT id, role, organisation, justification, status, decision_reason, created_at, decided_at FROM role_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', c.user.id),
  requestable: REQUESTABLE.filter((r) => !c.user.roles.includes(r)),
}));

post('/api/role-requests/:id/withdraw', (c) => {
  const r = q.get<any>('SELECT * FROM role_requests WHERE id = ? AND user_id = ?', c.params.id, c.user.id);
  if (!r) throw notFound();
  if (r.status !== 'pending') throw conflict(`This request is already ${r.status}.`);
  q.run("UPDATE role_requests SET status = 'withdrawn', decided_at = ? WHERE id = ?", now(), r.id);
  audit(c.user.id, 'role_request.withdrawn', 'role_request', r.id, null, c.ip);
  return { ok: true };
});

get('/api/admin/role-requests', (c) => {
  const status = c.query.get('status') ?? 'pending';
  if (!['pending', 'approved', 'rejected', 'withdrawn', 'all'].includes(status)) throw new HttpError(422, 'validation_failed', 'Some fields need attention.', { status: 'Unknown status.' });
  const { limit, offset } = paging(c.query);
  const term = c.query.get('q')?.trim().toLowerCase();
  const like = term ? likeTerm(term) : null;
  const where = `(? = 'all' OR r.status = ?) AND (? IS NULL OR lower(u.full_name) LIKE ? ESCAPE '\\' OR lower(u.email) LIKE ? ESCAPE '\\')`;
  const params = [status, status, like, like, like];
  const total = n(`SELECT COUNT(*) AS n FROM role_requests r JOIN users u ON u.id = r.user_id WHERE ${where}`, ...params);
  const rows = q.all(
    `SELECT r.id, r.role, r.organisation, r.justification, r.status, r.decision_reason, r.created_at, r.decided_at, r.evidence_document_id,
            u.id AS user_id, u.full_name, u.email, u.category, u.verification_status
       FROM role_requests r JOIN users u ON u.id = r.user_id WHERE ${where} ORDER BY r.created_at ASC LIMIT ? OFFSET ?`, ...params, limit, offset);
  return { requests: rows, page: pageInfo(total, limit, offset) };
}, { perm: 'user.manage' });

post('/api/admin/role-requests/:id/decide', (c) => {
  const i = new Input(c.body);
  const decision = i.oneOf('decision', ['approve', 'reject'] as const);
  const reason = i.str('reason', { min: 5, max: 1000 });
  const pw = i.str('confirm_password', { max: 128, required: c.body?.decision === 'approve' });
  i.done();
  if (decision === 'approve') confirmPassword(c.user, pw, c.ip);
  tx(() => {
    const r = q.get<any>('SELECT * FROM role_requests WHERE id = ?', c.params.id);
    if (!r) throw notFound();
    if (r.status !== 'pending') throw conflict(`This request is already ${r.status}.`);
    if (r.user_id === c.user.id) throw forbidden('You cannot decide your own role request.'); // separation of duties
    if (PRIVILEGED_ROLES.includes(r.role) && !hasRole(c.user, 'super_admin')) throw forbidden('Only a super administrator can decide a request for an administrator role.');
    if (decision === 'approve') {
      const t = q.get<any>('SELECT account_status, email_verified, verification_status FROM users WHERE id = ?', r.user_id)!;
      if (t.account_status !== 'active' || !t.email_verified || t.verification_status !== 'verified') throw conflict('The requester must have an active, confirmed and verified account.');
      if (q.get('SELECT 1 FROM user_roles WHERE user_id = ? AND role = ?', r.user_id, r.role)) throw conflict('That person already has this role.');
      q.run('INSERT INTO user_roles(user_id, role, granted_by, granted_at) VALUES (?,?,?,?)', r.user_id, r.role, c.user.id, now());
      audit(c.user.id, 'role.grant', 'user', r.user_id, { role: r.role, reason, via: 'role_request', request: r.id }, c.ip);
    }
    q.run('UPDATE role_requests SET status = ?, decided_by = ?, decision_reason = ?, decided_at = ? WHERE id = ?', decision === 'approve' ? 'approved' : 'rejected', c.user.id, reason, now(), r.id);
    audit(c.user.id, `role_request.${decision === 'approve' ? 'approved' : 'rejected'}`, 'role_request', r.id, { role: r.role, reason }, c.ip);
    notify(r.user_id, 'account', decision === 'approve' ? 'Role request approved' : 'Role request not approved', decision === 'approve' ? `You now hold the ${label(r.role)} role.` : reason!, '#/profile');
  });
  return { ok: true };
}, { perm: 'user.manage' });
