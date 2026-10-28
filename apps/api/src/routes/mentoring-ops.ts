// Mentoring operations: session lifecycle (cancel, reschedule, complete with attendance), agreed action items,
// conflict reports raised by either party, and staff oversight (workload, no-shows, conflict resolution).
import { Input, HttpError, audit, conflict, forbidden, notFound, notify, now, pageInfo, paging, q, tx, uid } from '../core.ts';
import { get, post, Created } from '../http.ts';
import { PERMISSIONS } from '../policy.ts';

const label = (s: string) => s.replace(/_/g, ' ');
const invalid = (field: string, msg: string) => new HttpError(422, 'validation_failed', 'Some fields need attention.', { [field]: msg });

/** The mentorship a person belongs to, or a 404 (the same answer for "missing" and "not yours"). */
function mine(userId: string, requestId: string) {
  const r = q.get<any>('SELECT * FROM mentorship_requests WHERE id = ? AND (mentee_id = ? OR mentor_user_id = ?)', requestId, userId, userId);
  if (!r) throw notFound('Mentorship not found.');
  return r;
}
const otherParty = (r: any, userId: string) => (r.mentee_id === userId ? r.mentor_user_id : r.mentee_id);
function sessionOf(userId: string, sessionId: string) {
  const s = q.get<any>('SELECT * FROM mentorship_sessions WHERE id = ?', sessionId);
  if (!s) throw notFound('Session not found.');
  return { s, r: mine(userId, s.request_id) };
}

// ---------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------
post('/api/mentorship/sessions/:id/cancel', (c) => {
  const i = new Input(c.body);
  const reason = i.str('reason', { min: 5, max: 500 });
  i.done();
  tx(() => {
    const { s, r } = sessionOf(c.user.id, c.params.id);
    if (s.status !== 'scheduled') throw conflict(`A session that is ${s.status} cannot be cancelled.`);
    q.run("UPDATE mentorship_sessions SET status='cancelled', cancelled_by=?, cancel_reason=? WHERE id=?", c.user.id, reason, s.id);
    audit(c.user.id, 'mentorship.session_cancelled', 'mentorship_session', s.id, { reason }, c.ip);
    notify(otherParty(r, c.user.id), 'mentorship', 'Mentoring session cancelled', reason ?? undefined, '#/mentorship');
  });
  return { ok: true };
});

post('/api/mentorship/sessions/:id/reschedule', (c) => {
  const i = new Input(c.body);
  const when = i.date('scheduled_at', true);
  i.done();
  tx(() => {
    const { s, r } = sessionOf(c.user.id, c.params.id);
    if (s.status !== 'scheduled') throw conflict(`A session that is ${s.status} cannot be rescheduled.`);
    if (when! <= now()) throw invalid('scheduled_at', 'Choose a time in the future.');
    q.run('UPDATE mentorship_sessions SET scheduled_at = ? WHERE id = ?', when, s.id);
    audit(c.user.id, 'mentorship.session_rescheduled', 'mentorship_session', s.id, { from: s.scheduled_at, to: when }, c.ip);
    notify(otherParty(r, c.user.id), 'mentorship', 'Mentoring session rescheduled', `New time: ${when}.`, '#/mentorship');
  });
  return { ok: true };
});

post('/api/mentorship/sessions/:id/complete', (c) => {
  const i = new Input(c.body);
  const menteeAttended = i.bool('mentee_attended', true);
  const mentorAttended = i.bool('mentor_attended') ?? true;
  const outcome = i.str('outcome', { max: 2000, required: false });
  const notes = i.str('notes', { max: 3000, required: false });
  i.done();
  tx(() => {
    const { s, r } = sessionOf(c.user.id, c.params.id);
    if (r.mentor_user_id !== c.user.id) throw forbidden('Only the mentor records how a session went.');
    if (s.status !== 'scheduled') throw conflict(`A session that is ${s.status} cannot be completed.`);
    if (s.scheduled_at > now()) throw conflict('This session has not happened yet. Cancel or reschedule it instead.');
    const status = menteeAttended && mentorAttended ? 'completed' : 'missed';
    q.run('UPDATE mentorship_sessions SET status=?, mentee_attended=?, mentor_attended=?, outcome=COALESCE(?, outcome), notes=COALESCE(?, notes) WHERE id=?', status, menteeAttended ? 1 : 0, mentorAttended ? 1 : 0, outcome, notes, s.id);
    audit(c.user.id, `mentorship.session_${status}`, 'mentorship_session', s.id, { mentee_attended: menteeAttended, mentor_attended: mentorAttended }, c.ip);
    notify(r.mentee_id, 'mentorship', status === 'completed' ? 'Mentoring session recorded' : 'Mentoring session marked as missed', outcome ?? undefined, '#/mentorship');
  });
  return { ok: true };
});

// ---------------------------------------------------------------------
// Action items agreed in mentoring
// ---------------------------------------------------------------------
post('/api/mentorship/requests/:id/actions', (c) => {
  const i = new Input(c.body);
  const description = i.str('description', { min: 3, max: 500 });
  const ownerId = i.str('owner_id', { max: 64 });
  const due = i.date('due_date');
  const sessionId = i.str('session_id', { max: 64, required: false });
  i.done();
  const id = uid();
  tx(() => {
    const r = mine(c.user.id, c.params.id);
    if (!['accepted', 'completed'].includes(r.status)) throw conflict('Action items can be added once a mentorship has started.');
    if (ownerId !== r.mentee_id && ownerId !== r.mentor_user_id) throw invalid('owner_id', 'The owner must be the mentor or the mentee.');
    if (sessionId && !q.get('SELECT 1 FROM mentorship_sessions WHERE id = ? AND request_id = ?', sessionId, r.id)) throw invalid('session_id', 'Unknown session for this mentorship.');
    if (q.get<{ n: number }>("SELECT COUNT(*) AS n FROM mentorship_actions WHERE request_id = ? AND status = 'open'", r.id)!.n >= 50) throw conflict('There are already 50 open action items. Close some first.');
    q.run('INSERT INTO mentorship_actions(id,request_id,session_id,description,owner_id,due_date,status,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)', id, r.id, sessionId, description, ownerId, due, 'open', c.user.id, now());
    audit(c.user.id, 'mentorship.action_added', 'mentorship_request', r.id, { action: id }, c.ip);
    if (ownerId !== c.user.id) notify(ownerId!, 'mentorship', 'New action item from mentoring', description ?? undefined, '#/mentorship', `mact:${id}`);
  });
  return new Created({ id });
});

get('/api/mentorship/requests/:id/actions', (c) => {
  const r = mine(c.user.id, c.params.id);
  const today = now();
  const actions = q.all<any>(
    `SELECT a.id, a.description, a.owner_id, o.full_name AS owner, a.due_date, a.status, a.session_id, a.created_at, a.completed_at FROM mentorship_actions a JOIN users o ON o.id = a.owner_id
      WHERE a.request_id = ? ORDER BY (a.status = 'open') DESC, a.due_date IS NULL, a.due_date, a.created_at`, r.id);
  return { actions: actions.map((a) => ({ ...a, overdue: a.status === 'open' && !!a.due_date && a.due_date < today })) };
});

post('/api/mentorship/actions/:id/status', (c) => {
  const i = new Input(c.body);
  const status = i.oneOf('status', ['open', 'done', 'cancelled'] as const);
  i.done();
  tx(() => {
    const a = q.get<any>('SELECT * FROM mentorship_actions WHERE id = ?', c.params.id);
    if (!a) throw notFound('Action item not found.');
    const r = mine(c.user.id, a.request_id);
    if (a.owner_id !== c.user.id && a.created_by !== c.user.id && r.mentor_user_id !== c.user.id) throw forbidden('Only the owner, the person who added it, or the mentor can change this.');
    if (a.status === status) throw conflict(`This item is already ${status}.`);
    q.run('UPDATE mentorship_actions SET status = ?, completed_at = ? WHERE id = ?', status, status === 'done' ? now() : null, a.id);
    audit(c.user.id, `mentorship.action_${status}`, 'mentorship_request', r.id, { action: a.id }, c.ip);
  });
  return { ok: true };
});

// ---------------------------------------------------------------------
// Conflict reports (either party can flag a problem; a reviewer who is not involved resolves it)
// ---------------------------------------------------------------------
post('/api/mentorship/requests/:id/conflict', (c) => {
  const i = new Input(c.body);
  const reason = i.str('reason', { min: 10, max: 2000 });
  i.done();
  const id = uid();
  const r = tx(() => {
    const r = mine(c.user.id, c.params.id);
    if (!['pending', 'accepted', 'completed'].includes(r.status)) throw conflict(`A mentorship that is ${r.status} cannot be reported.`);
    try {
      q.run("INSERT INTO mentorship_conflicts(id,request_id,reported_by,reason,status,created_at) VALUES (?,?,?,?, 'open', ?)", id, r.id, c.user.id, reason, now());
    } catch {
      throw conflict('You already have an open report for this mentorship. A reviewer will respond.');
    }
    audit(c.user.id, 'mentorship.conflict_reported', 'mentorship_request', r.id, { conflict: id }, c.ip);
    return r;
  });
  const reviewers = q.all<{ user_id: string }>(`SELECT DISTINCT user_id FROM user_roles WHERE role IN (${(PERMISSIONS['mentor.review'] as readonly string[]).map(() => '?').join(',')})`, ...PERMISSIONS['mentor.review']);
  for (const rv of reviewers) if (rv.user_id !== r.mentee_id && rv.user_id !== r.mentor_user_id) notify(rv.user_id, 'mentorship', 'Mentoring conflict reported', 'A mentor or mentee reported a problem.', '#/admin/mentoring', `mconf:${id}`);
  return new Created({ id });
});

get('/api/mentorship/requests/:id/conflicts', (c) => {
  const r = mine(c.user.id, c.params.id);
  return { conflicts: q.all('SELECT id, reason, status, resolution, created_at, resolved_at FROM mentorship_conflicts WHERE request_id = ? AND reported_by = ? ORDER BY created_at DESC', r.id, c.user.id) };
});

// ---------------------------------------------------------------------
// Staff oversight
// ---------------------------------------------------------------------
get('/api/admin/mentoring', (c) => {
  const status = c.query.get('status') || 'all';
  if (!['all', 'pending', 'accepted', 'declined', 'cancelled', 'completed'].includes(status)) throw invalid('status', 'Unknown status.');
  const { limit, offset } = paging(c.query);
  const total = q.get<{ n: number }>("SELECT COUNT(*) AS n FROM mentorship_requests WHERE (? = 'all' OR status = ?)", status, status)!.n;
  const requests = q.all(
    `SELECT r.id, r.status, r.created_at, mentee.full_name AS mentee, mentor.full_name AS mentor,
            (SELECT COUNT(*) FROM mentorship_conflicts k WHERE k.request_id = r.id AND k.status = 'open') AS open_conflicts,
            (SELECT COUNT(*) FROM mentorship_sessions s WHERE s.request_id = r.id AND s.status = 'completed') AS sessions_completed,
            (SELECT COUNT(*) FROM mentorship_sessions s WHERE s.request_id = r.id AND s.status = 'missed') AS sessions_missed
       FROM mentorship_requests r JOIN users mentee ON mentee.id = r.mentee_id JOIN users mentor ON mentor.id = r.mentor_user_id
      WHERE (? = 'all' OR r.status = ?) ORDER BY r.created_at DESC LIMIT ? OFFSET ?`, status, status, limit, offset);
  const mentors = q.all(
    `SELECT a.user_id, u.full_name, a.capacity,
            (SELECT COUNT(*) FROM mentorship_requests r WHERE r.mentor_user_id = a.user_id AND r.status = 'accepted') AS active,
            (SELECT COUNT(*) FROM mentorship_requests r WHERE r.mentor_user_id = a.user_id AND r.status = 'pending') AS pending,
            (SELECT COUNT(*) FROM mentorship_sessions s JOIN mentorship_requests r ON r.id = s.request_id WHERE r.mentor_user_id = a.user_id AND s.status = 'completed') AS sessions_completed,
            (SELECT COUNT(*) FROM mentorship_sessions s JOIN mentorship_requests r ON r.id = s.request_id WHERE r.mentor_user_id = a.user_id AND s.status = 'missed') AS sessions_missed
       FROM mentor_applications a JOIN users u ON u.id = a.user_id WHERE a.status = 'approved' ORDER BY u.full_name LIMIT 200`);
  return { requests, mentors, page: pageInfo(total, limit, offset), open_conflicts: q.get<{ n: number }>("SELECT COUNT(*) AS n FROM mentorship_conflicts WHERE status = 'open'")!.n };
}, { perm: 'mentor.review' });

get('/api/admin/mentoring/conflicts', (c) => {
  const status = c.query.get('status') || 'open';
  if (!['open', 'resolved', 'all'].includes(status)) throw invalid('status', 'Unknown status.');
  const { limit, offset } = paging(c.query);
  const total = q.get<{ n: number }>("SELECT COUNT(*) AS n FROM mentorship_conflicts WHERE (? = 'all' OR status = ?)", status, status)!.n;
  const conflicts = q.all(
    `SELECT k.id, k.request_id, k.reason, k.status, k.resolution, k.created_at, k.resolved_at, rep.full_name AS reported_by, mentee.full_name AS mentee, mentor.full_name AS mentor, r.status AS mentorship_status
       FROM mentorship_conflicts k JOIN mentorship_requests r ON r.id = k.request_id JOIN users rep ON rep.id = k.reported_by
       JOIN users mentee ON mentee.id = r.mentee_id JOIN users mentor ON mentor.id = r.mentor_user_id
      WHERE (? = 'all' OR k.status = ?) ORDER BY k.created_at ASC LIMIT ? OFFSET ?`, status, status, limit, offset);
  return { conflicts, page: pageInfo(total, limit, offset) };
}, { perm: 'mentor.review' });

post('/api/admin/mentoring/conflicts/:id/resolve', (c) => {
  const i = new Input(c.body);
  const resolution = i.str('resolution', { min: 10, max: 2000 });
  const outcome = i.oneOf('outcome', ['no_action', 'end_mentorship'] as const);
  i.done();
  tx(() => {
    const k = q.get<any>('SELECT * FROM mentorship_conflicts WHERE id = ?', c.params.id);
    if (!k) throw notFound('Report not found.');
    if (k.status !== 'open') throw conflict('This report is already resolved.');
    const r = q.get<any>('SELECT * FROM mentorship_requests WHERE id = ?', k.request_id)!;
    if (r.mentee_id === c.user.id || r.mentor_user_id === c.user.id) throw forbidden('You are part of this mentorship and cannot resolve a report about it.');
    q.run("UPDATE mentorship_conflicts SET status='resolved', resolution=?, resolved_by=?, resolved_at=? WHERE id=?", resolution, c.user.id, now(), k.id);
    if (outcome === 'end_mentorship' && ['pending', 'accepted'].includes(r.status)) {
      q.run("UPDATE mentorship_requests SET status='cancelled', responded_at=? WHERE id=?", now(), r.id);
      q.run("UPDATE mentorship_sessions SET status='cancelled', cancelled_by=?, cancel_reason='Mentorship ended after a conflict report' WHERE request_id=? AND status='scheduled'", c.user.id, r.id);
      notify(r.mentee_id, 'mentorship', 'Your mentorship was ended', `A reviewer ended this mentorship. You can choose another mentor. ${resolution}`, '#/mentors');
      notify(r.mentor_user_id, 'mentorship', 'A mentorship was ended', 'A reviewer ended this mentorship after a report.', '#/mentorship');
    }
    audit(c.user.id, 'mentorship.conflict_resolved', 'mentorship_request', r.id, { conflict: k.id, outcome }, c.ip);
    notify(k.reported_by, 'mentorship', 'Your report was reviewed', `Outcome: ${label(outcome!)}. ${resolution}`, '#/mentorship');
  });
  return { ok: true };
}, { perm: 'mentor.review' });

