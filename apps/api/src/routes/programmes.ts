// Ventures, programmes (cohort applications with capacity), and workshops (registration, waitlist, attendance).
import {
  Input, HttpError, audit, bad, conflict, forbidden, json, notFound, notify, now, parseJson, q, tx, uid,
} from '../core.ts';
import { get, post, put, patch, del, Created } from '../http.ts';
import { CATEGORIES, can, requireVerified, type AuthUser } from '../policy.ts';
import { getConfigNumber, likeTerm, pageInfo, paging } from '../core.ts';

const STAGES = ['idea', 'validation', 'prototype', 'launch', 'growth'] as const;
const eligibleFor = (list: string, u: AuthUser) => {
  const cats = parseJson<string[]>(list, []);
  return cats.length === 0 || cats.includes(u.category);
};
const httpUrl = (s: string | null, field: string) => {
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol === 'https:' || u.protocol === 'http:') return u.toString();
  } catch { /* fall through */ }
  throw new HttpError(422, 'validation_failed', 'Some fields need attention.', { [field]: 'Enter a valid http(s) link.' });
};

// =====================================================================
// Ventures
// =====================================================================
const VENTURE_TEXT = ['description', 'problem', 'solution', 'target_market', 'value_proposition', 'business_model', 'industry', 'risks'] as const;
const EDITABLE = ['draft', 'changes_requested', 'incubating'];

const memberOf = (ventureId: string, userId: string) => q.get<any>('SELECT * FROM venture_members WHERE venture_id = ? AND user_id = ?', ventureId, userId);
function ventureFor(c: { user: AuthUser }, id: string, opts: { reviewer?: boolean } = {}) {
  const v = q.get<any>('SELECT * FROM ventures WHERE id = ?', id);
  // Same 404 for "missing" and "not yours" so ids cannot be probed.
  if (!v || !(memberOf(id, c.user.id) || (opts.reviewer !== false && can(c.user, 'venture.review') && v.status !== 'draft'))) throw notFound('Venture not found.');
  return v;
}

post('/api/ventures', (c) => {
  requireVerified(c.user);
  const i = new Input(c.body);
  const name = i.str('name', { min: 2, max: 120 });
  const text: Record<string, string | null> = {};
  for (const f of VENTURE_TEXT) text[f] = i.str(f, { max: f === 'industry' ? 80 : 3000, required: false });
  const stage = i.oneOf('stage', STAGES, false) ?? 'idea';
  const location = i.str('location', { max: 120, required: false });
  i.done();
  const id = uid();
  tx(() => {
    if (q.get<{ n: number }>('SELECT COUNT(*) AS n FROM ventures WHERE owner_id = ?', c.user.id)!.n >= 20) throw conflict('You have reached the limit of 20 ventures.');
    q.run(`INSERT INTO ventures(id,owner_id,name,description,problem,solution,target_market,value_proposition,business_model,industry,stage,status,risks,created_at,updated_at,location)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, c.user.id, name, text.description, text.problem, text.solution, text.target_market, text.value_proposition, text.business_model, text.industry, stage, 'draft', text.risks, now(), now(), location);
    q.run('INSERT INTO venture_members(venture_id,user_id,member_role,added_at) VALUES (?,?,?,?)', id, c.user.id, 'owner', now());
    audit(c.user.id, 'venture.created', 'venture', id, null, c.ip);
  });
  return new Created({ id });
});

get('/api/ventures', (c) => {
  const archived = c.query.get('archived') === '1';
  return {
    ventures: q.all(`SELECT v.id, v.name, v.stage, v.status, v.industry, v.location, v.archived_at, v.updated_at, m.member_role FROM ventures v JOIN venture_members m ON m.venture_id = v.id
                     WHERE m.user_id = ? AND (? = 1 OR v.archived_at IS NULL) ORDER BY v.updated_at DESC`, c.user.id, archived ? 1 : 0),
    archived_count: q.get<{ n: number }>('SELECT COUNT(*) AS n FROM ventures v JOIN venture_members m ON m.venture_id = v.id WHERE m.user_id = ? AND v.archived_at IS NOT NULL', c.user.id)!.n,
  };
});

get('/api/ventures/:id', (c) => {
  const v = ventureFor(c, c.params.id);
  const members = q.all('SELECT u.id, u.full_name, m.member_role, m.title FROM venture_members m JOIN users u ON u.id = m.user_id WHERE m.venture_id = ? ORDER BY m.added_at', v.id);
  const mine = memberOf(v.id, c.user.id);
  return { venture: v, members, can_edit: !!mine && !v.archived_at && EDITABLE.includes(v.status), is_owner: mine?.member_role === 'owner' };
});

patch('/api/ventures/:id', (c) => {
  const v = ventureFor(c, c.params.id, { reviewer: false });
  const i = new Input(c.body);
  const name = i.str('name', { min: 2, max: 120, required: false });
  const text: Record<string, string | null> = {};
  for (const f of VENTURE_TEXT) text[f] = i.str(f, { max: f === 'industry' ? 80 : 3000, required: false });
  const stage = i.oneOf('stage', STAGES, false);
  const location = i.str('location', { max: 120, required: false });
  i.done();
  if (v.archived_at) throw conflict('This venture is archived. Restore it to edit it.');
  if (!EDITABLE.includes(v.status)) throw conflict(`A venture that is ${v.status.replace(/_/g, ' ')} cannot be edited.`);
  q.run(`UPDATE ventures SET location=COALESCE(?,location), name=COALESCE(?,name), description=COALESCE(?,description), problem=COALESCE(?,problem), solution=COALESCE(?,solution), target_market=COALESCE(?,target_market),
         value_proposition=COALESCE(?,value_proposition), business_model=COALESCE(?,business_model), industry=COALESCE(?,industry), risks=COALESCE(?,risks), stage=COALESCE(?,stage), updated_at=? WHERE id=?`,
    location, name, text.description, text.problem, text.solution, text.target_market, text.value_proposition, text.business_model, text.industry, text.risks, stage, now(), v.id);
  audit(c.user.id, 'venture.updated', 'venture', v.id, null, c.ip);
  return { ok: true };
});

post('/api/ventures/:id/submit', (c) => {
  const v = ventureFor(c, c.params.id, { reviewer: false });
  if (memberOf(v.id, c.user.id).member_role !== 'owner') throw forbidden('Only the venture owner can submit it for review.');
  tx(() => {
    const cur = q.get<any>('SELECT * FROM ventures WHERE id = ?', v.id);
    if (cur.archived_at) throw conflict('This venture is archived. Restore it first.');
    if (!['draft', 'changes_requested'].includes(cur.status)) throw conflict(`A venture that is ${cur.status.replace(/_/g, ' ')} cannot be submitted.`);
    const problems: Record<string, string> = {};
    for (const f of ['description', 'problem', 'solution', 'target_market', 'value_proposition', 'industry'] as const) if (!cur[f]) problems[f] = 'Required before submission.';
    if (Object.keys(problems).length) throw new HttpError(422, 'validation_failed', 'Complete the venture profile before submitting.', problems);
    q.run("UPDATE ventures SET status='submitted', updated_at=? WHERE id=?", now(), v.id);
    audit(c.user.id, 'venture.submitted', 'venture', v.id, null, c.ip);
  });
  for (const r of q.all<any>("SELECT DISTINCT user_id FROM user_roles WHERE role IN ('incubation_manager','programme_coordinator')")) notify(r.user_id, 'review', 'Venture submitted for review', `"${v.name}" is waiting for review.`, '#/admin/ventures');
  return { ok: true };
});

// Archiving hides a venture from the working list without deleting anything. Active reviews and funding must finish first.
const ARCHIVABLE = ['draft', 'changes_requested', 'rejected', 'graduated'];
post('/api/ventures/:id/archive', (c) => {
  const v = ventureFor(c, c.params.id, { reviewer: false });
  if (memberOf(v.id, c.user.id).member_role !== 'owner') throw forbidden('Only the venture owner can archive it.');
  tx(() => {
    const cur = q.get<any>('SELECT * FROM ventures WHERE id = ?', v.id);
    if (cur.archived_at) throw conflict('This venture is already archived.');
    if (!ARCHIVABLE.includes(cur.status)) throw conflict(`A venture that is ${cur.status.replace(/_/g, ' ')} cannot be archived. Wait for the review, or ask a reviewer to graduate or close it.`);
    if (q.get("SELECT 1 FROM funding_applications WHERE venture_id = ? AND status IN ('submitted','eligibility_review','under_evaluation','waitlisted','more_info_required','approved')", cur.id))
      throw conflict('This venture has funding in progress and cannot be archived yet.');
    q.run('UPDATE ventures SET archived_at = ?, updated_at = ? WHERE id = ?', now(), now(), cur.id);
    audit(c.user.id, 'venture.archived', 'venture', cur.id, null, c.ip);
  });
  return { ok: true };
});
post('/api/ventures/:id/unarchive', (c) => {
  const v = ventureFor(c, c.params.id, { reviewer: false });
  if (memberOf(v.id, c.user.id).member_role !== 'owner') throw forbidden('Only the venture owner can restore it.');
  if (!v.archived_at) throw conflict('This venture is not archived.');
  q.run('UPDATE ventures SET archived_at = NULL, updated_at = ? WHERE id = ?', now(), v.id);
  audit(c.user.id, 'venture.unarchived', 'venture', v.id, null, c.ip);
  return { ok: true };
});

/** One place to see what has happened to a venture: review decisions, programmes joined, funding, milestone progress. */
get('/api/ventures/:id/history', (c) => {
  const v = ventureFor(c, c.params.id);
  const events = q.all<any>(
    `SELECT a.action, a.created_at, a.details, u.full_name AS actor FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.entity = 'venture' AND a.entity_id = ? AND a.action NOT IN ('venture.updated') ORDER BY a.created_at DESC LIMIT 100`, v.id)
    .map((e) => ({ action: e.action, created_at: e.created_at, actor: e.actor, reason: parseJson<any>(e.details, null)?.reason ?? null }));
  return {
    events,
    programmes: q.all('SELECT p.id AS programme_id, p.title, a.status, a.submitted_at FROM programme_applications a JOIN programmes p ON p.id = a.programme_id WHERE a.venture_id = ? AND a.status <> \'draft\' ORDER BY a.submitted_at DESC', v.id),
    funding: q.all('SELECT a.id, o.title, o.currency, a.status, a.requested_amount, a.approved_amount, a.agreement_status, a.disbursement_status FROM funding_applications a JOIN funding_opportunities o ON o.id = a.opportunity_id WHERE a.venture_id = ? AND a.status <> \'draft\' ORDER BY a.created_at DESC', v.id),
    milestones: q.all('SELECT status, COUNT(*) AS n FROM milestones WHERE venture_id = ? GROUP BY status', v.id),
  };
});

post('/api/ventures/:id/members', (c) => {
  const v = ventureFor(c, c.params.id, { reviewer: false });
  if (memberOf(v.id, c.user.id).member_role !== 'owner') throw forbidden('Only the venture owner can add members.');
  const i = new Input(c.body);
  const email = i.email('email');
  const title = i.str('title', { max: 80, required: false });
  i.done();
  tx(() => {
    const u = q.get<any>("SELECT id, full_name FROM users WHERE email = ? AND account_status='active' AND email_verified=1 AND verification_status='verified'", email);
    if (!u) throw notFound('No verified member was found with that email.');
    if (memberOf(v.id, u.id)) throw conflict('That person is already a member.');
    if (q.get<{ n: number }>('SELECT COUNT(*) AS n FROM venture_members WHERE venture_id = ?', v.id)!.n >= 10) throw conflict('A venture can have at most 10 members.');
    q.run('INSERT INTO venture_members(venture_id,user_id,member_role,title,added_at) VALUES (?,?,?,?,?)', v.id, u.id, 'member', title, now());
    audit(c.user.id, 'venture.member_added', 'venture', v.id, { user: u.id }, c.ip);
    notify(u.id, 'venture', 'You were added to a venture', `You are now a member of "${v.name}".`, `#/ventures/${v.id}`);
  });
  return new Created({ ok: true });
});

del('/api/ventures/:id/members/:userId', (c) => {
  const v = ventureFor(c, c.params.id, { reviewer: false });
  const me = memberOf(v.id, c.user.id);
  const target = memberOf(v.id, c.params.userId);
  if (!target) throw notFound('Member not found.');
  if (target.member_role === 'owner') throw conflict('The owner cannot be removed.');
  if (me.member_role !== 'owner' && c.params.userId !== c.user.id) throw forbidden('Only the owner can remove other members.');
  q.run('DELETE FROM venture_members WHERE venture_id=? AND user_id=?', v.id, c.params.userId);
  audit(c.user.id, 'venture.member_removed', 'venture', v.id, { user: c.params.userId }, c.ip);
  return { ok: true };
});

get('/api/admin/ventures', (c) => {
  const status = c.query.get('status') || null;
  return {
    ventures: q.all(`SELECT v.id, v.name, v.stage, v.status, v.industry, v.updated_at, u.full_name AS owner FROM ventures v JOIN users u ON u.id = v.owner_id
                     WHERE v.status <> 'draft' AND (? IS NULL OR (? = 'open' AND v.status IN ('submitted','under_review')) OR v.status = ?) ORDER BY v.updated_at ASC LIMIT 200`, status, status, status),
  };
}, { perm: 'venture.review' });

post('/api/admin/ventures/:id/review', (c) => {
  const i = new Input(c.body);
  const decision = i.oneOf('decision', ['start_review', 'approve', 'request_changes', 'reject', 'graduate'] as const);
  const needsReason = decision === 'request_changes' || decision === 'reject';
  const reason = i.str('reason', { max: 2000, min: needsReason ? 5 : 0, required: needsReason });
  i.done();
  tx(() => {
    const v = q.get<any>('SELECT * FROM ventures WHERE id = ?', c.params.id);
    if (!v || v.status === 'draft') throw notFound('Venture not found.');
    if (memberOf(v.id, c.user.id)) throw forbidden('You cannot review a venture you belong to.');
    const flow: Record<string, { from: string[]; to: string }> = {
      start_review: { from: ['submitted'], to: 'under_review' },
      approve: { from: ['submitted', 'under_review'], to: 'incubating' },
      request_changes: { from: ['submitted', 'under_review'], to: 'changes_requested' },
      reject: { from: ['submitted', 'under_review'], to: 'rejected' },
      graduate: { from: ['incubating'], to: 'graduated' },
    };
    const step = flow[decision!];
    if (!step.from.includes(v.status)) throw conflict(`A venture that is ${v.status.replace(/_/g, ' ')} cannot receive "${decision}".`);
    q.run('UPDATE ventures SET status=?, review_reason=?, updated_at=? WHERE id=?', step.to, reason, now(), v.id);
    audit(c.user.id, `venture.${decision}`, 'venture', v.id, { from: v.status, to: step.to, reason }, c.ip);
    for (const m of q.all<any>('SELECT user_id FROM venture_members WHERE venture_id = ?', v.id))
      notify(m.user_id, 'venture', `Venture ${step.to.replace(/_/g, ' ')}`, reason ?? `"${v.name}" is now ${step.to.replace(/_/g, ' ')}.`, `#/ventures/${v.id}`);
  });
  return { ok: true };
}, { perm: 'venture.review' });

// =====================================================================
// Programmes
// =====================================================================
type Question = { id: string; label: string; required: boolean };
function parseQuestions(raw: unknown): Question[] {
  if (raw === undefined || raw === null) return [];
  const err = (m: string) => new HttpError(422, 'validation_failed', 'Some fields need attention.', { questions: m });
  if (!Array.isArray(raw) || raw.length > 15) throw err('Provide at most 15 questions.');
  const seen = new Set<string>();
  return raw.map((x: any) => {
    if (!x || typeof x.id !== 'string' || !/^[a-z][a-z0-9_]{0,30}$/.test(x.id) || typeof x.label !== 'string' || !x.label.trim() || x.label.length > 300) throw err('Each question needs a short id (a-z, 0-9, _) and a label.');
    if (seen.has(x.id)) throw err('Question ids must be unique.');
    seen.add(x.id);
    return { id: x.id, label: x.label.trim(), required: x.required !== false };
  });
}
const taken = (programmeId: string) =>
  q.get<{ n: number }>("SELECT COUNT(*) AS n FROM programme_applications WHERE programme_id = ? AND status IN ('accepted','completed')", programmeId)!.n;
const programmeWindowOpen = (p: any) => p.status === 'published' && (!p.opens_at || p.opens_at <= now()) && (!p.closes_at || p.closes_at >= now());

const programmeShape = (p: any, u?: AuthUser) => ({
  ...p,
  eligible_categories: parseJson(p.eligible_categories, []), required_documents: parseJson(p.required_documents, []), questions: parseJson(p.questions, []),
  seats_left: Math.max(0, p.capacity - taken(p.id)), applications_open: programmeWindowOpen(p),
  ...(u ? { eligible: eligibleFor(p.eligible_categories, u) } : {}),
});

function readProgramme(c: { body: any }, existing?: any) {
  const i = new Input(c.body);
  const req = !existing;
  const title = i.str('title', { min: 3, max: 160, required: req });
  const description = i.str('description', { max: 5000, required: false });
  const cats = i.list('eligible_categories', { allowed: CATEGORIES });
  const requires = i.bool('requires_verification');
  const opens = i.date('opens_at');
  const closes = i.date('closes_at');
  const capacity = i.int('capacity', { min: 1, max: 5000, required: req });
  const docs = i.list('required_documents', { max: 8 });
  const questions = i.has('questions') ? parseQuestions(i.raw('questions')) : null;
  i.done();
  const o = opens ?? existing?.opens_at, cl = closes ?? existing?.closes_at;
  if (o && cl && cl <= o) throw new HttpError(422, 'validation_failed', 'Some fields need attention.', { closes_at: 'The closing date must be after the opening date.' });
  return { title, description, cats: i.has('eligible_categories') ? cats : null, requires, opens, closes, capacity, docs: i.has('required_documents') ? docs : null, questions };
}

post('/api/admin/programmes', (c) => {
  const p = readProgramme(c);
  const id = uid();
  q.run(`INSERT INTO programmes(id,title,description,status,eligible_categories,requires_verification,opens_at,closes_at,capacity,required_documents,questions,created_by,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, p.title, p.description, 'draft', json(p.cats ?? []), p.requires ?? true, p.opens, p.closes, p.capacity, json(p.docs ?? []), json(p.questions ?? []), c.user.id, now(), now());
  audit(c.user.id, 'programme.created', 'programme', id, null, c.ip);
  return new Created({ id });
}, { perm: 'programme.manage' });

patch('/api/admin/programmes/:id', (c) => {
  const ex = q.get<any>('SELECT * FROM programmes WHERE id = ?', c.params.id);
  if (!ex) throw notFound();
  const p = readProgramme(c, ex);
  if (ex.status === 'archived') throw conflict('Archived programmes cannot be edited.');
  if (p.capacity !== null && p.capacity < taken(ex.id)) throw conflict('Capacity cannot be lower than the number of accepted participants.');
  q.run(`UPDATE programmes SET title=COALESCE(?,title), description=COALESCE(?,description), eligible_categories=COALESCE(?,eligible_categories), requires_verification=COALESCE(?,requires_verification),
         opens_at=COALESCE(?,opens_at), closes_at=COALESCE(?,closes_at), capacity=COALESCE(?,capacity), required_documents=COALESCE(?,required_documents), questions=COALESCE(?,questions), updated_at=? WHERE id=?`,
    p.title, p.description, p.cats ? json(p.cats) : null, p.requires, p.opens, p.closes, p.capacity, p.docs ? json(p.docs) : null, p.questions ? json(p.questions) : null, now(), ex.id);
  audit(c.user.id, 'programme.updated', 'programme', ex.id, null, c.ip);
  return { ok: true };
}, { perm: 'programme.manage' });

for (const [action, from, to] of [['publish', ['draft', 'closed'], 'published'], ['close', ['published'], 'closed'], ['archive', ['draft', 'published', 'closed'], 'archived']] as const) {
  post(`/api/admin/programmes/:id/${action}`, (c) => {
    tx(() => {
      const p = q.get<any>('SELECT * FROM programmes WHERE id = ?', c.params.id);
      if (!p) throw notFound();
      if (!(from as readonly string[]).includes(p.status)) throw conflict(`A programme that is ${p.status} cannot be ${to}.`);
      if (action === 'publish' && (!p.title || !p.capacity)) throw bad('A programme needs a title and capacity before publishing.');
      q.run('UPDATE programmes SET status=?, updated_at=? WHERE id=?', to, now(), p.id);
      audit(c.user.id, `programme.${action}`, 'programme', p.id, null, c.ip);
    });
    return { ok: true };
  }, { perm: 'programme.manage' });
}

get('/api/admin/programmes', (c) => ({
  programmes: q.all<any>('SELECT * FROM programmes ORDER BY created_at DESC LIMIT 200').map((p) => ({
    ...programmeShape(p), applications: q.get<{ n: number }>('SELECT COUNT(*) AS n FROM programme_applications WHERE programme_id = ? AND status <> \'withdrawn\'', p.id)!.n,
  })),
}), { perm: 'programme.manage' });

get('/api/admin/programmes/:id/applications', (c) => {
  const p = q.get<any>('SELECT * FROM programmes WHERE id = ?', c.params.id);
  if (!p) throw notFound();
  const status = c.query.get('status') || null;
  const assigned = c.query.get('assigned') || null; // me | none | <user id>
  const key = assigned === 'me' ? c.user.id : assigned;
  const term = c.query.get('q')?.trim().toLowerCase();
  const like = term ? likeTerm(term) : null;
  const { limit, offset } = paging(c.query, { limit: 50 });
  const where = `a.programme_id = ? AND a.status <> 'draft' AND (? IS NULL OR (? = 'open' AND a.status IN ('submitted','under_review','waitlisted')) OR a.status = ?)
    AND (? IS NULL OR (? = 1 AND a.assigned_to IS NULL) OR a.assigned_to = ?) AND (? IS NULL OR lower(u.full_name) LIKE ? ESCAPE '\\' OR lower(u.email) LIKE ? ESCAPE '\\')`;
  const params = [p.id, status, status, status, key, key === 'none' ? 1 : 0, key, like, like, like];
  const from = 'FROM programme_applications a JOIN users u ON u.id = a.user_id LEFT JOIN ventures v ON v.id = a.venture_id LEFT JOIN users r ON r.id = a.assigned_to';
  const total = q.get<{ n: number }>(`SELECT COUNT(*) AS n ${from} WHERE ${where}`, ...params)!.n;
  const cutoff = new Date(Date.now() - getConfigNumber('review_overdue_days', 7) * 864e5).toISOString();
  return {
    programme: programmeShape(p),
    applications: q.all<any>(`SELECT a.id, a.status, a.submitted_at, a.decision_reason, a.answers, a.assigned_to, r.full_name AS assignee, a.review_score, a.review_notes, u.full_name, u.email, u.category, v.name AS venture_name
                              ${from} WHERE ${where} ORDER BY a.submitted_at ASC LIMIT ? OFFSET ?`, ...params, limit, offset)
      .map((a) => ({ ...a, answers: parseJson(a.answers, {}), overdue: ['submitted', 'under_review'].includes(a.status) && !!a.submitted_at && a.submitted_at < cutoff })),
    page: pageInfo(total, limit, offset),
  };
}, { perm: 'programme.manage' });

// A score and private notes help reviewers compare applications. They are never shown to the applicant.
post('/api/admin/programme-applications/:id/review', (c) => {
  const i = new Input(c.body);
  const score = i.int('score', { min: 0, max: 100, required: false });
  const notes = i.str('notes', { max: 3000, required: false });
  i.done();
  if (score === null && notes === null) throw new HttpError(422, 'validation_failed', 'Some fields need attention.', { score: 'Give a score, notes, or both.' });
  tx(() => {
    const a = q.get<any>('SELECT * FROM programme_applications WHERE id = ?', c.params.id);
    if (!a || a.status === 'draft') throw notFound();
    if (a.user_id === c.user.id) throw forbidden('You cannot review your own application.');
    if (!['submitted', 'under_review', 'waitlisted', 'more_info_required'].includes(a.status)) throw conflict(`An application that is ${a.status.replace(/_/g, ' ')} is no longer being reviewed.`);
    q.run('UPDATE programme_applications SET review_score = COALESCE(?, review_score), review_notes = COALESCE(?, review_notes) WHERE id = ?', score, notes, a.id);
    audit(c.user.id, 'programme_application.reviewed', 'programme_application', a.id, { score, had_notes: notes !== null, previous_score: a.review_score }, c.ip);
  });
  return { ok: true };
}, { perm: 'programme.manage' });

post('/api/admin/programme-applications/:id/decide', (c) => {
  const i = new Input(c.body);
  const decision = i.oneOf('decision', ['start_review', 'accept', 'waitlist', 'reject', 'more_info', 'complete'] as const);
  const quiet = decision === 'start_review' || decision === 'complete';
  const reason = i.str('reason', { max: 1000, min: quiet ? 0 : 5, required: !quiet });
  i.done();
  tx(() => {
    const a = q.get<any>('SELECT * FROM programme_applications WHERE id = ?', c.params.id);
    if (!a || a.status === 'draft') throw notFound();
    if (a.user_id === c.user.id) throw forbidden('You cannot decide on your own application.');
    const flow: Record<string, { from: string[]; to: string }> = {
      start_review: { from: ['submitted'], to: 'under_review' },
      accept: { from: ['submitted', 'under_review', 'waitlisted'], to: 'accepted' },
      waitlist: { from: ['submitted', 'under_review'], to: 'waitlisted' },
      reject: { from: ['submitted', 'under_review', 'waitlisted'], to: 'rejected' },
      more_info: { from: ['submitted', 'under_review'], to: 'more_info_required' },
      complete: { from: ['accepted'], to: 'completed' },
    };
    const step = flow[decision!];
    if (!step.from.includes(a.status)) throw conflict(`An application that is ${a.status.replace(/_/g, ' ')} cannot receive "${decision}".`);
    if (decision === 'accept') {
      const p = q.get<any>('SELECT capacity FROM programmes WHERE id = ?', a.programme_id)!;
      if (taken(a.programme_id) >= p.capacity) throw conflict('The programme is full. Waitlist this application instead.');
    }
    q.run('UPDATE programme_applications SET status=?, decision_reason=?, decided_by=?, decided_at=? WHERE id=?', step.to, reason, c.user.id, now(), a.id);
    audit(c.user.id, `programme_application.${decision}`, 'programme_application', a.id, { from: a.status, to: step.to, reason }, c.ip);
    if (decision !== 'start_review') notify(a.user_id, 'programme', `Programme application: ${step.to.replace(/_/g, ' ')}`, reason ?? undefined, '#/programmes');
  });
  return { ok: true };
}, { perm: 'programme.manage' });

get('/api/programmes', (c) => {
  requireVerified(c.user);
  const rows = q.all<any>("SELECT * FROM programmes WHERE status IN ('published','closed') ORDER BY created_at DESC");
  const mine = new Map(q.all<any>('SELECT programme_id, status FROM programme_applications WHERE user_id = ?', c.user.id).map((a) => [a.programme_id, a.status]));
  return { programmes: rows.map((p) => ({ ...programmeShape(p, c.user), my_application_status: mine.get(p.id) ?? null })) };
});

get('/api/programmes/:id', (c) => {
  requireVerified(c.user);
  const p = q.get<any>("SELECT * FROM programmes WHERE id = ? AND status IN ('published','closed')", c.params.id);
  if (!p) throw notFound('Programme not found.');
  const mine = q.get<any>('SELECT id, status, answers, decision_reason FROM programme_applications WHERE programme_id = ? AND user_id = ?', p.id, c.user.id);
  return { programme: programmeShape(p, c.user), application: mine ? { ...mine, answers: parseJson(mine.answers, {}) } : null };
});

function validateAnswers(p: any, raw: unknown) {
  const qs = parseJson<Question[]>(p.questions, []);
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const problems: Record<string, string> = {};
  const out: Record<string, string> = {};
  for (const question of qs) {
    const v = src[question.id];
    if (typeof v === 'string' && v.trim()) {
      if (v.length > 3000) problems[question.id] = 'Must be at most 3000 characters.';
      else out[question.id] = v.trim();
    } else if (question.required) problems[question.id] = 'This question is required.';
  }
  if (Object.keys(problems).length) throw new HttpError(422, 'validation_failed', 'Some answers need attention.', problems);
  return out;
}

post('/api/programmes/:id/apply', (c) => {
  requireVerified(c.user);
  const i = new Input(c.body);
  const ventureId = i.str('venture_id', { max: 60, required: false });
  const answersRaw = i.raw('answers');
  i.done();
  const id = uid();
  tx(() => {
    const p = q.get<any>('SELECT * FROM programmes WHERE id = ?', c.params.id);
    if (!p || !['published', 'closed'].includes(p.status)) throw notFound('Programme not found.');
    if (!programmeWindowOpen(p)) throw conflict('Applications for this programme are not open.');
    if (!eligibleFor(p.eligible_categories, c.user)) throw forbidden('Your registration category is not eligible for this programme.');
    if (ventureId && !memberOf(ventureId, c.user.id)) throw forbidden('That venture is not yours.');
    if (ventureId && q.get('SELECT 1 FROM ventures WHERE id = ? AND archived_at IS NOT NULL', ventureId)) throw conflict('That venture is archived. Restore it first.');
    for (const doc of parseJson<string[]>(p.required_documents, [])) {
      if (!q.get("SELECT 1 FROM documents WHERE owner_id = ? AND category = ? AND scan_status <> 'quarantined'", c.user.id, doc))
        throw new HttpError(422, 'validation_failed', 'A required document is missing.', { required_documents: `Upload a "${doc}" document first.` });
    }
    const answers = validateAnswers(p, answersRaw);
    const ex = q.get<any>('SELECT id, status FROM programme_applications WHERE programme_id = ? AND user_id = ?', p.id, c.user.id);
    if (ex && ex.status !== 'withdrawn') throw conflict('You have already applied to this programme.');
    if (ex) q.run("UPDATE programme_applications SET status='submitted', venture_id=?, answers=?, decision_reason=NULL, decided_by=NULL, decided_at=NULL, submitted_at=? WHERE id=?", ventureId, json(answers), now(), ex.id);
    else q.run('INSERT INTO programme_applications(id,programme_id,user_id,venture_id,status,answers,created_at,submitted_at) VALUES (?,?,?,?,?,?,?,?)', id, p.id, c.user.id, ventureId, 'submitted', json(answers), now(), now());
    audit(c.user.id, 'programme_application.submitted', 'programme_application', ex?.id ?? id, { programme: p.id }, c.ip);
  });
  return new Created({ ok: true });
});

// The applicant's own timeline: only things the applicant is entitled to see (status changes and the reason they were given).
const TIMELINE_LABELS: Record<string, string> = {
  submitted: 'Application submitted', resubmitted: 'Application resubmitted', withdrawn: 'Application withdrawn', start_review: 'Review started',
  accept: 'Accepted', waitlist: 'Placed on the waiting list', reject: 'Not accepted', more_info: 'More information requested', complete: 'Programme completed',
};
function applicationTimeline(id: string) {
  return q.all<any>("SELECT action, details, created_at FROM audit_events WHERE entity = 'programme_application' AND entity_id = ? AND action LIKE 'programme_application.%' ORDER BY created_at, rowid", id)
    .map((e) => ({ key: e.action.replace('programme_application.', ''), details: parseJson<any>(e.details, null), created_at: e.created_at }))
    .filter((e) => TIMELINE_LABELS[e.key])
    .map((e) => ({ label: TIMELINE_LABELS[e.key], created_at: e.created_at, note: ['accept', 'waitlist', 'reject', 'more_info'].includes(e.key) ? e.details?.reason ?? null : null }));
}
get('/api/programme-applications/mine', (c) => ({
  applications: q.all<any>(`SELECT a.id, a.status, a.decision_reason, a.submitted_at, a.answers, p.id AS programme_id, p.title FROM programme_applications a JOIN programmes p ON p.id = a.programme_id WHERE a.user_id = ? ORDER BY a.created_at DESC`, c.user.id)
    .map((a) => ({ ...a, answers: parseJson(a.answers, {}), timeline: applicationTimeline(a.id) })),
}));

post('/api/programme-applications/:id/resubmit', (c) => {
  const i = new Input(c.body);
  const answersRaw = i.raw('answers');
  i.done();
  tx(() => {
    const a = q.get<any>('SELECT * FROM programme_applications WHERE id = ? AND user_id = ?', c.params.id, c.user.id);
    if (!a) throw notFound();
    if (a.status !== 'more_info_required') throw conflict('Only applications waiting for more information can be resubmitted.');
    const p = q.get<any>('SELECT * FROM programmes WHERE id = ?', a.programme_id)!;
    q.run("UPDATE programme_applications SET status='submitted', answers=?, submitted_at=? WHERE id=?", json(validateAnswers(p, answersRaw)), now(), a.id);
    audit(c.user.id, 'programme_application.resubmitted', 'programme_application', a.id, null, c.ip);
  });
  return { ok: true };
});

post('/api/programme-applications/:id/withdraw', (c) => {
  tx(() => {
    const a = q.get<any>('SELECT * FROM programme_applications WHERE id = ? AND user_id = ?', c.params.id, c.user.id);
    if (!a) throw notFound();
    if (!['submitted', 'under_review', 'more_info_required', 'waitlisted', 'accepted'].includes(a.status)) throw conflict(`An application that is ${a.status.replace(/_/g, ' ')} cannot be withdrawn.`);
    q.run("UPDATE programme_applications SET status='withdrawn' WHERE id=?", a.id);
    audit(c.user.id, 'programme_application.withdrawn', 'programme_application', a.id, { was: a.status }, c.ip);
  });
  return { ok: true };
});

// =====================================================================
// Workshops
// =====================================================================
const registeredCount = (wid: string) => q.get<{ n: number }>("SELECT COUNT(*) AS n FROM workshop_registrations WHERE workshop_id = ? AND status = 'registered'", wid)!.n;

function workshopShape(w: any, u?: AuthUser, reg?: any) {
  const showLink = !!reg && reg.status === 'registered';
  return {
    ...w, eligible_categories: parseJson(w.eligible_categories, []), seats_left: Math.max(0, w.capacity - registeredCount(w.id)),
    meeting_link: showLink || (u && can(u, 'workshop.manage')) ? w.meeting_link : null, // link is revealed only to registered participants
    ...(u ? { eligible: eligibleFor(w.eligible_categories, u), my_status: reg?.status ?? null, my_attended: reg?.attended ?? null, my_feedback: reg?.feedback_rating ?? null } : {}),
  };
}

function readWorkshop(c: { body: any }, existing?: any) {
  const i = new Input(c.body);
  const req = !existing;
  const title = i.str('title', { min: 3, max: 160, required: req });
  const description = i.str('description', { max: 5000, required: false });
  const mode = i.oneOf('mode', ['in_person', 'online', 'hybrid'] as const, req);
  const location = i.str('location', { max: 200, required: false });
  const link = httpUrl(i.str('meeting_link', { max: 500, required: false }), 'meeting_link');
  const starts = i.date('starts_at', req);
  const ends = i.date('ends_at', req);
  const capacity = i.int('capacity', { min: 1, max: 5000, required: req });
  const cats = i.list('eligible_categories', { allowed: CATEGORIES });
  const programmeId = i.str('programme_id', { max: 60, required: false });
  i.done();
  const s = starts ?? existing?.starts_at, e = ends ?? existing?.ends_at;
  if (s && e && e <= s) throw new HttpError(422, 'validation_failed', 'Some fields need attention.', { ends_at: 'The end must be after the start.' });
  const m = mode ?? existing?.mode;
  if ((m === 'in_person' || m === 'hybrid') && !(location ?? existing?.location)) throw new HttpError(422, 'validation_failed', 'Some fields need attention.', { location: 'A location is required for in-person and hybrid workshops.' });
  if ((m === 'online' || m === 'hybrid') && !(link ?? existing?.meeting_link)) throw new HttpError(422, 'validation_failed', 'Some fields need attention.', { meeting_link: 'A meeting link is required for online and hybrid workshops.' });
  if (programmeId && !q.get('SELECT 1 FROM programmes WHERE id = ?', programmeId)) throw new HttpError(422, 'validation_failed', 'Some fields need attention.', { programme_id: 'Unknown programme.' });
  return { title, description, mode, location, link, starts, ends, capacity, cats: i.has('eligible_categories') ? cats : null, programmeId };
}

post('/api/admin/workshops', (c) => {
  const w = readWorkshop(c);
  const id = uid();
  q.run(`INSERT INTO workshops(id,title,description,mode,location,meeting_link,starts_at,ends_at,capacity,eligible_categories,status,programme_id,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, w.title, w.description, w.mode, w.location, w.link, w.starts, w.ends, w.capacity, json(w.cats ?? []), 'draft', w.programmeId, c.user.id, now());
  audit(c.user.id, 'workshop.created', 'workshop', id, null, c.ip);
  return new Created({ id });
}, { perm: 'workshop.manage' });

patch('/api/admin/workshops/:id', (c) => {
  const ex = q.get<any>('SELECT * FROM workshops WHERE id = ?', c.params.id);
  if (!ex) throw notFound();
  if (['cancelled', 'completed'].includes(ex.status)) throw conflict(`A workshop that is ${ex.status} cannot be edited.`);
  const w = readWorkshop(c, ex);
  if (w.capacity !== null && w.capacity < registeredCount(ex.id)) throw conflict('Capacity cannot be lower than the number of registered participants.');
  q.run(`UPDATE workshops SET title=COALESCE(?,title), description=COALESCE(?,description), mode=COALESCE(?,mode), location=COALESCE(?,location), meeting_link=COALESCE(?,meeting_link),
         starts_at=COALESCE(?,starts_at), ends_at=COALESCE(?,ends_at), capacity=COALESCE(?,capacity), eligible_categories=COALESCE(?,eligible_categories), programme_id=COALESCE(?,programme_id) WHERE id=?`,
    w.title, w.description, w.mode, w.location, w.link, w.starts, w.ends, w.capacity, w.cats ? json(w.cats) : null, w.programmeId, ex.id);
  audit(c.user.id, 'workshop.updated', 'workshop', ex.id, null, c.ip);
  if (w.starts || w.ends || w.location || w.link)
    for (const r of q.all<any>("SELECT user_id FROM workshop_registrations WHERE workshop_id = ? AND status IN ('registered','waitlisted')", ex.id)) notify(r.user_id, 'workshop', 'Workshop details changed', `"${ex.title}" was updated. Please check the new details.`, '#/workshops');
  return { ok: true };
}, { perm: 'workshop.manage' });

for (const [action, from, to] of [['publish', ['draft'], 'published'], ['cancel', ['draft', 'published'], 'cancelled'], ['complete', ['published'], 'completed']] as const) {
  post(`/api/admin/workshops/:id/${action}`, (c) => {
    tx(() => {
      const w = q.get<any>('SELECT * FROM workshops WHERE id = ?', c.params.id);
      if (!w) throw notFound();
      if (!(from as readonly string[]).includes(w.status)) throw conflict(`A workshop that is ${w.status} cannot be ${to}.`);
      q.run('UPDATE workshops SET status=? WHERE id=?', to, w.id);
      audit(c.user.id, `workshop.${action}`, 'workshop', w.id, null, c.ip);
      if (action === 'cancel')
        for (const r of q.all<any>("SELECT user_id FROM workshop_registrations WHERE workshop_id = ? AND status IN ('registered','waitlisted')", w.id)) notify(r.user_id, 'workshop', 'Workshop cancelled', `"${w.title}" has been cancelled.`, '#/workshops');
    });
    return { ok: true };
  }, { perm: 'workshop.manage' });
}

get('/api/admin/workshops', (c) => ({
  workshops: q.all<any>('SELECT * FROM workshops ORDER BY starts_at DESC LIMIT 200').map((w) => ({
    ...workshopShape(w, c.user), registered: registeredCount(w.id),
    waitlisted: q.get<{ n: number }>("SELECT COUNT(*) AS n FROM workshop_registrations WHERE workshop_id = ? AND status = 'waitlisted'", w.id)!.n,
  })),
}), { perm: 'workshop.manage' });

get('/api/admin/workshops/:id/registrations', (c) => {
  const w = q.get<any>('SELECT * FROM workshops WHERE id = ?', c.params.id);
  if (!w) throw notFound();
  return {
    workshop: workshopShape(w, c.user),
    registrations: q.all(`SELECT r.user_id, r.status, r.attended, r.feedback_rating, u.full_name, u.email FROM workshop_registrations r JOIN users u ON u.id = r.user_id WHERE r.workshop_id = ? AND r.status <> 'cancelled' ORDER BY r.created_at`, w.id),
  };
}, { perm: 'workshop.manage' });

post('/api/admin/workshops/:id/attendance', (c) => {
  const i = new Input(c.body);
  const userId = i.str('user_id', { max: 60 });
  const attended = i.bool('attended', true);
  i.done();
  const w = q.get<any>('SELECT * FROM workshops WHERE id = ?', c.params.id);
  if (!w) throw notFound();
  if (w.status === 'draft' || w.status === 'cancelled') throw conflict('Attendance cannot be recorded for this workshop.');
  const r = q.run("UPDATE workshop_registrations SET attended = ? WHERE workshop_id = ? AND user_id = ? AND status = 'registered'", attended, w.id, userId);
  if (!r.changes) throw notFound('That participant is not registered.');
  audit(c.user.id, 'workshop.attendance', 'workshop', w.id, { user: userId, attended }, c.ip);
  return { ok: true };
}, { perm: 'workshop.manage' });

get('/api/workshops', (c) => {
  requireVerified(c.user);
  const regs = new Map(q.all<any>('SELECT * FROM workshop_registrations WHERE user_id = ?', c.user.id).map((r) => [r.workshop_id, r]));
  const rows = q.all<any>("SELECT * FROM workshops WHERE status IN ('published','completed') ORDER BY starts_at ASC LIMIT 200");
  return { workshops: rows.map((w) => workshopShape(w, c.user, regs.get(w.id))) };
});

post('/api/workshops/:id/register', (c) => {
  requireVerified(c.user);
  let status = 'registered';
  tx(() => {
    const w = q.get<any>('SELECT * FROM workshops WHERE id = ?', c.params.id);
    if (!w || w.status !== 'published') throw notFound('Workshop not found.');
    if (w.starts_at <= now()) throw conflict('This workshop has already started.');
    if (!eligibleFor(w.eligible_categories, c.user)) throw forbidden('Your registration category is not eligible for this workshop.');
    const ex = q.get<any>('SELECT * FROM workshop_registrations WHERE workshop_id = ? AND user_id = ?', w.id, c.user.id);
    if (ex && ex.status !== 'cancelled') throw conflict(`You are already ${ex.status} for this workshop.`);
    const clash = q.get<any>(`SELECT w2.title FROM workshop_registrations r JOIN workshops w2 ON w2.id = r.workshop_id
                              WHERE r.user_id = ? AND r.status = 'registered' AND w2.id <> ? AND w2.status = 'published' AND w2.starts_at < ? AND w2.ends_at > ?`, c.user.id, w.id, w.ends_at, w.starts_at);
    if (clash) throw conflict(`This overlaps with "${clash.title}", which you are already registered for.`);
    status = registeredCount(w.id) < w.capacity ? 'registered' : 'waitlisted'; // capacity is checked inside the write transaction
    if (ex) q.run('UPDATE workshop_registrations SET status = ?, attended = NULL, created_at = ? WHERE workshop_id = ? AND user_id = ?', status, now(), w.id, c.user.id);
    else q.run('INSERT INTO workshop_registrations(workshop_id,user_id,status,created_at) VALUES (?,?,?,?)', w.id, c.user.id, status, now());
    audit(c.user.id, `workshop.${status}`, 'workshop', w.id, null, c.ip);
  });
  return new Created({ status });
});

del('/api/workshops/:id/register', (c) => {
  tx(() => {
    const w = q.get<any>('SELECT * FROM workshops WHERE id = ?', c.params.id);
    const r = w && q.get<any>('SELECT * FROM workshop_registrations WHERE workshop_id = ? AND user_id = ?', w.id, c.user.id);
    if (!r || r.status === 'cancelled') throw notFound('You are not registered for this workshop.');
    q.run("UPDATE workshop_registrations SET status='cancelled' WHERE workshop_id=? AND user_id=?", w.id, c.user.id);
    audit(c.user.id, 'workshop.cancelled_registration', 'workshop', w.id, null, c.ip);
    if (r.status === 'registered') {
      // Promote the longest-waiting participant into the freed seat.
      const next = q.get<any>("SELECT user_id FROM workshop_registrations WHERE workshop_id = ? AND status = 'waitlisted' ORDER BY created_at ASC LIMIT 1", w.id);
      if (next && registeredCount(w.id) < w.capacity) {
        q.run("UPDATE workshop_registrations SET status='registered' WHERE workshop_id=? AND user_id=?", w.id, next.user_id);
        notify(next.user_id, 'workshop', 'A seat opened up', `You are now registered for "${w.title}".`, '#/workshops');
        audit(null, 'workshop.promoted_from_waitlist', 'workshop', w.id, { user: next.user_id });
      }
    }
  });
  return { ok: true };
});

post('/api/workshops/:id/feedback', (c) => {
  const i = new Input(c.body);
  const rating = i.int('rating', { min: 1, max: 5 });
  const comment = i.str('comment', { max: 2000, required: false });
  i.done();
  const r = q.get<any>("SELECT * FROM workshop_registrations WHERE workshop_id = ? AND user_id = ? AND status = 'registered'", c.params.id, c.user.id);
  if (!r) throw notFound('You are not registered for this workshop.');
  if (r.attended !== 1) throw conflict('Feedback is available once your attendance has been recorded.');
  if (r.feedback_rating) throw conflict('You have already left feedback.');
  q.run('UPDATE workshop_registrations SET feedback_rating=?, feedback_comment=? WHERE workshop_id=? AND user_id=?', rating, comment, c.params.id, c.user.id);
  return { ok: true };
});
