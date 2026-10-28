// Support: a ticket is a thread. The requester sees their own thread (never internal notes); support staff triage,
// assign, reply and keep internal notes. Suspended accounts can still reach their own tickets (that is how they appeal).
import { Input, HttpError, audit, conflict, forbidden, getConfigNumber, likeTerm, notFound, notify, now, pageInfo, paging, q, tx, uid } from '../core.ts';
import { get, post, patch, Created } from '../http.ts';

export const SUPPORT_CATEGORIES = ['general', 'account', 'verification', 'programme', 'funding', 'mentoring', 'technical', 'privacy'] as const;
export const SUPPORT_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
const MAX_MESSAGES = 100;
const label = (s: string) => s.replace(/_/g, ' ');

const supportStaff = () => q.all<{ user_id: string }>("SELECT DISTINCT user_id FROM user_roles WHERE role IN ('support_officer','admin','super_admin')");
function tellStaff(ticket: any, title: string, body: string) {
  const targets = ticket.assigned_to ? [{ user_id: ticket.assigned_to }] : supportStaff();
  for (const t of targets) if (t.user_id !== ticket.user_id) notify(t.user_id, 'support', title, body, '#/admin/support');
}

// ---------------------------------------------------------------------
// Requester side
// ---------------------------------------------------------------------
post('/api/support', (c) => {
  const i = new Input(c.body);
  const subject = i.str('subject', { min: 3, max: 160 });
  const message = i.str('message', { min: 10, max: 4000 });
  const category = i.oneOf('category', SUPPORT_CATEGORIES, false) ?? 'general';
  i.done();
  if (q.get<{ n: number }>("SELECT COUNT(*) AS n FROM support_requests WHERE user_id = ? AND status <> 'resolved'", c.user.id)!.n >= 10) throw conflict('You already have several open requests. Please wait for a reply.');
  const id = uid();
  tx(() => {
    q.run('INSERT INTO support_requests(id,user_id,subject,message,category,created_at,updated_at) VALUES (?,?,?,?,?,?,?)', id, c.user.id, subject, message, category, now(), now());
    q.run("INSERT INTO support_messages(id,request_id,author_id,kind,body,created_at) VALUES (?,?,?,'user',?,?)", uid(), id, c.user.id, message, now());
  });
  tellStaff({ user_id: c.user.id, assigned_to: null }, 'New support request', subject ?? '');
  return new Created({ id });
}, { allowInactive: true, limit: 20 });

get('/api/support/mine', (c) => {
  const { limit, offset } = paging(c.query, { limit: 50 });
  const total = q.get<{ n: number }>('SELECT COUNT(*) AS n FROM support_requests WHERE user_id = ?', c.user.id)!.n;
  const requests = q.all(
    `SELECT s.id, s.subject, s.category, s.status, s.created_at, s.updated_at, s.resolved_at,
            (SELECT COUNT(*) FROM support_messages m WHERE m.request_id = s.id AND m.kind <> 'internal') AS message_count,
            (SELECT MAX(m.created_at) FROM support_messages m WHERE m.request_id = s.id AND m.kind <> 'internal') AS last_message_at
       FROM support_requests s WHERE s.user_id = ? ORDER BY s.updated_at DESC LIMIT ? OFFSET ?`, c.user.id, limit, offset);
  return { requests, page: pageInfo(total, limit, offset) };
}, { allowInactive: true });

get('/api/support/:id', (c) => {
  const s = q.get<any>('SELECT id, user_id, subject, category, status, created_at, updated_at, resolved_at FROM support_requests WHERE id = ? AND user_id = ?', c.params.id, c.user.id);
  if (!s) throw notFound('Request not found.');
  const messages = q.all<any>("SELECT id, kind, body, created_at FROM support_messages WHERE request_id = ? AND kind <> 'internal' ORDER BY created_at, rowid", s.id)
    .map((m) => ({ ...m, author: m.kind === 'user' ? 'You' : 'Support team' }));
  const { user_id: _omit, ...request } = s;
  return { request, messages };
}, { allowInactive: true });

post('/api/support/:id/messages', (c) => {
  const i = new Input(c.body);
  const body = i.str('body', { min: 2, max: 4000 });
  i.done();
  const out = tx(() => {
    const s = q.get<any>('SELECT * FROM support_requests WHERE id = ? AND user_id = ?', c.params.id, c.user.id);
    if (!s) throw notFound('Request not found.');
    if (q.get<{ n: number }>('SELECT COUNT(*) AS n FROM support_messages WHERE request_id = ?', s.id)!.n >= MAX_MESSAGES) throw conflict('This conversation is full. Please open a new request.');
    q.run("INSERT INTO support_messages(id,request_id,author_id,kind,body,created_at) VALUES (?,?,?,'user',?,?)", uid(), s.id, c.user.id, body, now());
    const reopened = s.status === 'resolved';
    q.run(`UPDATE support_requests SET status = CASE WHEN status = 'resolved' THEN 'open' ELSE status END, resolved_at = CASE WHEN status = 'resolved' THEN NULL ELSE resolved_at END, updated_at = ? WHERE id = ?`, now(), s.id);
    if (reopened) audit(c.user.id, 'support.reopened', 'support_request', s.id, null, c.ip);
    return { s, reopened };
  });
  tellStaff(out.s, out.reopened ? 'Support request reopened' : 'New reply on a support request', out.s.subject);
  return new Created({ ok: true });
}, { allowInactive: true, limit: 60 });

// ---------------------------------------------------------------------
// Staff side
// ---------------------------------------------------------------------
const RANK = "CASE s.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END";

get('/api/admin/support', (c) => {
  const status = c.query.get('status') || 'open';
  if (!['open', 'in_progress', 'resolved', 'all'].includes(status)) throw new HttpError(422, 'validation_failed', 'Some fields need attention.', { status: 'Unknown status.' });
  const assigned = c.query.get('assigned') || null; // me | none | <user id>
  const priority = c.query.get('priority') || null;
  const category = c.query.get('category') || null;
  if (priority && !(SUPPORT_PRIORITIES as readonly string[]).includes(priority)) throw new HttpError(422, 'validation_failed', 'Some fields need attention.', { priority: 'Unknown priority.' });
  if (category && !(SUPPORT_CATEGORIES as readonly string[]).includes(category)) throw new HttpError(422, 'validation_failed', 'Some fields need attention.', { category: 'Unknown category.' });
  const term = c.query.get('q')?.trim().toLowerCase();
  const like = term ? likeTerm(term) : null;
  const { limit, offset } = paging(c.query);
  const assignedKey = assigned === 'me' ? c.user.id : assigned;
  const where = `(? = 'all' OR (? = 'open' AND s.status <> 'resolved') OR s.status = ?)
    AND (? IS NULL OR (? = 1 AND s.assigned_to IS NULL) OR s.assigned_to = ?)
    AND (? IS NULL OR s.priority = ?) AND (? IS NULL OR s.category = ?)
    AND (? IS NULL OR lower(s.subject) LIKE ? ESCAPE '\\' OR lower(u.full_name) LIKE ? ESCAPE '\\' OR lower(u.email) LIKE ? ESCAPE '\\')`;
  const params = [status, status, status, assignedKey, assignedKey === 'none' ? 1 : 0, assignedKey, priority, priority, category, category, like, like, like, like];
  const total = q.get<{ n: number }>(`SELECT COUNT(*) AS n FROM support_requests s JOIN users u ON u.id = s.user_id WHERE ${where}`, ...params)!.n;
  const overdueDays = getConfigNumber('review_overdue_days', 7);
  const cutoff = new Date(Date.now() - overdueDays * 864e5).toISOString();
  const requests = q.all<any>(
    `SELECT s.id, s.subject, s.category, s.priority, s.status, s.created_at, s.updated_at, s.resolved_at, s.assigned_to, a.full_name AS assignee, u.full_name, u.email,
            (SELECT COUNT(*) FROM support_messages m WHERE m.request_id = s.id AND m.kind <> 'internal') AS message_count,
            (SELECT MAX(m.created_at) FROM support_messages m WHERE m.request_id = s.id) AS last_message_at
       FROM support_requests s JOIN users u ON u.id = s.user_id LEFT JOIN users a ON a.id = s.assigned_to
      WHERE ${where} ORDER BY ${RANK}, s.created_at ASC LIMIT ? OFFSET ?`, ...params, limit, offset)
    .map((r) => ({ ...r, overdue: r.status !== 'resolved' && r.created_at < cutoff }));
  return { requests, page: pageInfo(total, limit, offset) };
}, { perm: 'support.manage' });

get('/api/admin/support/:id', (c) => {
  const s = q.get<any>(
    `SELECT s.id, s.subject, s.category, s.priority, s.status, s.created_at, s.updated_at, s.resolved_at, s.assigned_to, a.full_name AS assignee,
            u.id AS requester_id, u.full_name, u.email, u.category AS requester_category, u.account_status
       FROM support_requests s JOIN users u ON u.id = s.user_id LEFT JOIN users a ON a.id = s.assigned_to WHERE s.id = ?`, c.params.id);
  if (!s) throw notFound('Request not found.');
  const messages = q.all<any>(
    `SELECT m.id, m.kind, m.body, m.created_at, u.full_name AS author FROM support_messages m JOIN users u ON u.id = m.author_id WHERE m.request_id = ? ORDER BY m.created_at, m.rowid`, s.id);
  return { request: s, messages, own_ticket: s.requester_id === c.user.id };
}, { perm: 'support.manage' });

post('/api/admin/support/:id/respond', (c) => {
  const i = new Input(c.body);
  const response = i.str('response', { min: 2, max: 4000 });
  const status = i.oneOf('status', ['in_progress', 'resolved'] as const);
  i.done();
  tx(() => {
    const s = q.get<any>('SELECT * FROM support_requests WHERE id = ?', c.params.id);
    if (!s) throw notFound();
    if (s.user_id === c.user.id) throw forbidden('You cannot answer your own support request. Ask a colleague to handle it.');
    if (q.get<{ n: number }>('SELECT COUNT(*) AS n FROM support_messages WHERE request_id = ?', s.id)!.n >= MAX_MESSAGES) throw conflict('This conversation is full.');
    q.run("INSERT INTO support_messages(id,request_id,author_id,kind,body,created_at) VALUES (?,?,?,'staff',?,?)", uid(), s.id, c.user.id, response, now());
    q.run(`UPDATE support_requests SET response=?, status=?, responder_id=?, updated_at=?, resolved_at = CASE WHEN ? = 'resolved' THEN ? ELSE NULL END,
           assigned_to = COALESCE(assigned_to, ?), assigned_at = CASE WHEN assigned_to IS NULL THEN ? ELSE assigned_at END WHERE id=?`,
      response, status, c.user.id, now(), status, now(), c.user.id, now(), s.id);
    audit(c.user.id, 'support.responded', 'support_request', s.id, { status }, c.ip);
    notify(s.user_id, 'support', `Support request ${label(status!)}`, response ?? undefined, `#/support/${s.id}`);
  });
  return { ok: true };
}, { perm: 'support.manage' });

post('/api/admin/support/:id/note', (c) => {
  const i = new Input(c.body);
  const body = i.str('body', { min: 2, max: 4000 });
  i.done();
  const s = q.get<any>('SELECT id FROM support_requests WHERE id = ?', c.params.id);
  if (!s) throw notFound();
  q.run("INSERT INTO support_messages(id,request_id,author_id,kind,body,created_at) VALUES (?,?,?,'internal',?,?)", uid(), s.id, c.user.id, body, now());
  audit(c.user.id, 'support.note_added', 'support_request', s.id, null, c.ip);
  return new Created({ ok: true });
}, { perm: 'support.manage' });

patch('/api/admin/support/:id', (c) => {
  const i = new Input(c.body);
  const priority = i.oneOf('priority', SUPPORT_PRIORITIES, false);
  const category = i.oneOf('category', SUPPORT_CATEGORIES, false);
  i.done();
  if (!priority && !category) throw new HttpError(422, 'validation_failed', 'Some fields need attention.', { priority: 'Change the priority or the category.' });
  const s = q.get<any>('SELECT * FROM support_requests WHERE id = ?', c.params.id);
  if (!s) throw notFound();
  q.run('UPDATE support_requests SET priority = COALESCE(?, priority), category = COALESCE(?, category), updated_at = ? WHERE id = ?', priority, category, now(), s.id);
  audit(c.user.id, 'support.triaged', 'support_request', s.id, { priority, category, was: { priority: s.priority, category: s.category } }, c.ip);
  return { ok: true };
}, { perm: 'support.manage' });
