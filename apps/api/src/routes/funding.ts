// Funding: opportunities, applications, evaluation, approval, agreement, and recorded disbursement. Plus venture milestones.
// Approval is separate from payment. No payment gateway is integrated; disbursement records that a payment was made elsewhere.
import { confirmPassword } from '../stepup.ts';
import {
  Input, HttpError, audit, bad, conflict, forbidden, getConfigNumber, json, likeTerm, notFound, notify, now, pageInfo, paging, parseJson, q, tx, uid,
} from '../core.ts';
import { get, post, put, patch, del, Created } from '../http.ts';
import { CATEGORIES, can, requireVerified, type AuthUser } from '../policy.ts';

const isMember = (ventureId: string, userId: string) => !!q.get('SELECT 1 FROM venture_members WHERE venture_id = ? AND user_id = ?', ventureId, userId);
const eligibleFor = (list: string, u: AuthUser) => {
  const cats = parseJson<string[]>(list, []);
  return cats.length === 0 || cats.includes(u.category);
};
const spent = (opportunityId: string) =>
  q.get<{ n: number }>("SELECT COALESCE(SUM(approved_amount),0) AS n FROM funding_applications WHERE opportunity_id = ? AND status IN ('approved','completed')", opportunityId)!.n;
const windowOpen = (o: any) => o.status === 'open' && (!o.opens_at || o.opens_at <= now()) && (!o.closes_at || o.closes_at >= now());
const label = (s: string) => s.replace(/_/g, ' ');

const oppShape = (o: any, u?: AuthUser) => ({
  ...o, eligible_categories: parseJson(o.eligible_categories, []), remaining_budget: o.total_budget - spent(o.id), applications_open: windowOpen(o),
  ...(u ? { eligible: eligibleFor(o.eligible_categories, u) } : {}),
});

function event(appId: string, actor: string, from: string | null, to: string, reason?: string | null) {
  q.run('INSERT INTO funding_events(id,application_id,actor_id,from_status,to_status,reason,created_at) VALUES (?,?,?,?,?,?,?)', uid(), appId, actor, from, to, reason ?? null, now());
}

// =====================================================================
// Opportunities
// =====================================================================
function readOpportunity(c: { body: any }, existing?: any) {
  const i = new Input(c.body);
  const req = !existing;
  const title = i.str('title', { min: 3, max: 160, required: req });
  const description = i.str('description', { max: 5000, required: false });
  const currency = i.str('currency', { max: 3, min: 3, required: false });
  const min = i.int('min_amount', { min: 0, required: false });
  const max = i.int('max_amount', { min: 1, required: req });
  const total = i.int('total_budget', { min: 1, required: req });
  const opens = i.date('opens_at');
  const closes = i.date('closes_at');
  const cats = i.list('eligible_categories', { allowed: CATEGORIES });
  const criteria = i.str('criteria', { max: 3000, required: false });
  const conditions = i.str('conditions', { max: 3000, required: false });
  i.done();
  const lo = min ?? existing?.min_amount ?? 0, hi = max ?? existing?.max_amount, tot = total ?? existing?.total_budget;
  const problems: Record<string, string> = {};
  if (hi !== undefined && lo > hi) problems.min_amount = 'The minimum cannot exceed the maximum.';
  if (hi !== undefined && tot !== undefined && hi > tot) problems.max_amount = 'The maximum award cannot exceed the total budget.';
  const o = opens ?? existing?.opens_at, cl = closes ?? existing?.closes_at;
  if (o && cl && cl <= o) problems.closes_at = 'The closing date must be after the opening date.';
  if (Object.keys(problems).length) throw new HttpError(422, 'validation_failed', 'Some fields need attention.', problems);
  return { title, description, currency: currency?.toUpperCase() ?? null, min, max, total, opens, closes, cats: i.has('eligible_categories') ? cats : null, criteria, conditions };
}

post('/api/admin/funding/opportunities', (c) => {
  const o = readOpportunity(c);
  const id = uid();
  q.run(`INSERT INTO funding_opportunities(id,title,description,currency,min_amount,max_amount,total_budget,opens_at,closes_at,eligible_categories,criteria,conditions,status,created_by,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, o.title, o.description, o.currency ?? 'NGN', o.min ?? 0, o.max, o.total, o.opens, o.closes, json(o.cats ?? []), o.criteria, o.conditions, 'draft', c.user.id, now());
  audit(c.user.id, 'funding.opportunity_created', 'funding_opportunity', id, null, c.ip);
  return new Created({ id });
}, { perm: 'funding.manage' });

patch('/api/admin/funding/opportunities/:id', (c) => {
  const ex = q.get<any>('SELECT * FROM funding_opportunities WHERE id = ?', c.params.id);
  if (!ex) throw notFound();
  const o = readOpportunity(c, ex);
  if (o.total !== null && o.total < spent(ex.id)) throw conflict('The budget cannot be lower than the amount already approved.');
  if (ex.status === 'closed') throw conflict('A closed opportunity cannot be edited.');
  q.run(`UPDATE funding_opportunities SET title=COALESCE(?,title), description=COALESCE(?,description), currency=COALESCE(?,currency), min_amount=COALESCE(?,min_amount), max_amount=COALESCE(?,max_amount),
         total_budget=COALESCE(?,total_budget), opens_at=COALESCE(?,opens_at), closes_at=COALESCE(?,closes_at), eligible_categories=COALESCE(?,eligible_categories), criteria=COALESCE(?,criteria), conditions=COALESCE(?,conditions) WHERE id=?`,
    o.title, o.description, o.currency, o.min, o.max, o.total, o.opens, o.closes, o.cats ? json(o.cats) : null, o.criteria, o.conditions, ex.id);
  audit(c.user.id, 'funding.opportunity_updated', 'funding_opportunity', ex.id, null, c.ip);
  return { ok: true };
}, { perm: 'funding.manage' });

for (const [action, from, to] of [['open', ['draft'], 'open'], ['close', ['open'], 'closed']] as const) {
  post(`/api/admin/funding/opportunities/:id/${action}`, (c) => {
    tx(() => {
      const o = q.get<any>('SELECT * FROM funding_opportunities WHERE id = ?', c.params.id);
      if (!o) throw notFound();
      if (!(from as readonly string[]).includes(o.status)) throw conflict(`An opportunity that is ${o.status} cannot be ${to}.`);
      q.run('UPDATE funding_opportunities SET status=? WHERE id=?', to, o.id);
      audit(c.user.id, `funding.opportunity_${action}`, 'funding_opportunity', o.id, null, c.ip);
    });
    return { ok: true };
  }, { perm: 'funding.manage' });
}

get('/api/admin/funding/opportunities', () => ({
  opportunities: q.all<any>('SELECT * FROM funding_opportunities ORDER BY created_at DESC LIMIT 200').map((o) => ({
    ...oppShape(o), applications: q.get<{ n: number }>("SELECT COUNT(*) AS n FROM funding_applications WHERE opportunity_id = ? AND status <> 'draft'", o.id)!.n, approved_total: spent(o.id),
  })),
}), { perm: 'funding.manage' });

get('/api/funding/opportunities', (c) => {
  requireVerified(c.user);
  return { opportunities: q.all<any>("SELECT * FROM funding_opportunities WHERE status = 'open' ORDER BY created_at DESC").map((o) => oppShape(o, c.user)) };
});

// =====================================================================
// Applications (applicant side)
// =====================================================================
function readApplication(c: { body: any }) {
  const i = new Input(c.body);
  const requested = i.int('requested_amount', { min: 1 });
  const justification = i.str('justification', { max: 5000, required: false });
  const use = i.str('use_of_funds', { max: 3000, required: false });
  const raw = i.raw('budget_items');
  i.done();
  let items: { label: string; amount: number }[] = [];
  if (raw !== undefined && raw !== null) {
    const err = (m: string) => new HttpError(422, 'validation_failed', 'Some fields need attention.', { budget_items: m });
    if (!Array.isArray(raw) || raw.length > 30) throw err('Provide at most 30 budget lines.');
    items = raw.map((x: any) => {
      if (!x || typeof x.label !== 'string' || !x.label.trim() || x.label.length > 120 || !Number.isInteger(x.amount) || x.amount < 0) throw err('Each line needs a label and a whole, non-negative amount.');
      return { label: x.label.trim(), amount: x.amount as number };
    });
  }
  return { requested, justification, use, items };
}

const appFor = (c: { user: AuthUser }, id: string) => {
  const a = q.get<any>('SELECT * FROM funding_applications WHERE id = ?', id);
  if (!a || !isMember(a.venture_id, c.user.id)) throw notFound('Application not found.');
  return a;
};
const setItems = (appId: string, items: { label: string; amount: number }[]) => {
  q.run('DELETE FROM funding_budget_items WHERE application_id = ?', appId);
  for (const it of items) q.run('INSERT INTO funding_budget_items(id,application_id,label,amount) VALUES (?,?,?,?)', uid(), appId, it.label, it.amount);
};

post('/api/funding/opportunities/:id/applications', (c) => {
  requireVerified(c.user);
  const i = new Input(c.body);
  const ventureId = i.str('venture_id', { max: 60 });
  i.done();
  const a = readApplication(c);
  const id = uid();
  tx(() => {
    const o = q.get<any>('SELECT * FROM funding_opportunities WHERE id = ?', c.params.id);
    if (!o || o.status !== 'open') throw notFound('Funding opportunity not found.');
    if (!eligibleFor(o.eligible_categories, c.user)) throw forbidden('Your registration category is not eligible for this opportunity.');
    const v = q.get<any>('SELECT * FROM ventures WHERE id = ?', ventureId);
    if (!v || !isMember(v.id, c.user.id)) throw forbidden('That venture is not yours.');
    if (v.archived_at) throw conflict('This venture is archived. Restore it before applying for funding.');
    if (['draft', 'rejected'].includes(v.status)) throw conflict('Submit your venture for review before applying for funding.');
    if (a.requested! < o.min_amount || a.requested! > o.max_amount) throw new HttpError(422, 'validation_failed', 'Some fields need attention.', { requested_amount: `Must be between ${o.min_amount} and ${o.max_amount} ${o.currency}.` });
    if (q.get('SELECT 1 FROM funding_applications WHERE opportunity_id = ? AND venture_id = ?', o.id, v.id)) throw conflict('This venture has already applied to this opportunity.');
    q.run(`INSERT INTO funding_applications(id,opportunity_id,applicant_id,venture_id,requested_amount,justification,use_of_funds,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      id, o.id, c.user.id, v.id, a.requested, a.justification, a.use, 'draft', now());
    setItems(id, a.items);
    event(id, c.user.id, null, 'draft');
    audit(c.user.id, 'funding.application_created', 'funding_application', id, { opportunity: o.id }, c.ip);
  });
  return new Created({ id });
});

put('/api/funding/applications/:id', (c) => {
  const a0 = appFor(c, c.params.id);
  const a = readApplication(c);
  tx(() => {
    const cur = q.get<any>('SELECT * FROM funding_applications WHERE id = ?', a0.id);
    if (!['draft', 'more_info_required'].includes(cur.status)) throw conflict(`An application that is ${label(cur.status)} cannot be edited.`);
    const o = q.get<any>('SELECT * FROM funding_opportunities WHERE id = ?', cur.opportunity_id)!;
    if (a.requested! < o.min_amount || a.requested! > o.max_amount) throw new HttpError(422, 'validation_failed', 'Some fields need attention.', { requested_amount: `Must be between ${o.min_amount} and ${o.max_amount} ${o.currency}.` });
    q.run('UPDATE funding_applications SET requested_amount=?, justification=?, use_of_funds=? WHERE id=?', a.requested, a.justification, a.use, cur.id);
    setItems(cur.id, a.items);
    audit(c.user.id, 'funding.application_updated', 'funding_application', cur.id, null, c.ip);
  });
  return { ok: true };
});

post('/api/funding/applications/:id/submit', (c) => {
  const a0 = appFor(c, c.params.id);
  tx(() => {
    const a = q.get<any>('SELECT * FROM funding_applications WHERE id = ?', a0.id);
    if (!['draft', 'more_info_required'].includes(a.status)) throw conflict(`An application that is ${label(a.status)} cannot be submitted.`);
    const o = q.get<any>('SELECT * FROM funding_opportunities WHERE id = ?', a.opportunity_id)!;
    if (!windowOpen(o)) throw conflict('This funding opportunity is not accepting applications.');
    const problems: Record<string, string> = {};
    if (!a.justification || a.justification.length < 30) problems.justification = 'Explain why this funding is needed (at least 30 characters).';
    if (!a.use_of_funds) problems.use_of_funds = 'Describe how the money will be used.';
    const total = q.get<{ n: number }>('SELECT COALESCE(SUM(amount),0) AS n FROM funding_budget_items WHERE application_id = ?', a.id)!.n;
    if (total !== a.requested_amount) problems.budget_items = `Budget lines add up to ${total}, but you requested ${a.requested_amount}. They must match.`;
    if (Object.keys(problems).length) throw new HttpError(422, 'validation_failed', 'Your application is incomplete.', problems);
    q.run("UPDATE funding_applications SET status='submitted', submitted_at=? WHERE id=?", now(), a.id);
    event(a.id, c.user.id, a.status, 'submitted');
    audit(c.user.id, 'funding.application_submitted', 'funding_application', a.id, null, c.ip);
  });
  for (const r of q.all<any>("SELECT DISTINCT user_id FROM user_roles WHERE role IN ('funding_officer')")) notify(r.user_id, 'review', 'New funding application', 'A funding application is waiting for review.', '#/admin/funding');
  return { ok: true };
});

post('/api/funding/applications/:id/withdraw', (c) => {
  const a0 = appFor(c, c.params.id);
  tx(() => {
    const a = q.get<any>('SELECT * FROM funding_applications WHERE id = ?', a0.id);
    if (!['draft', 'submitted', 'eligibility_review', 'under_evaluation', 'more_info_required', 'waitlisted'].includes(a.status)) throw conflict(`An application that is ${label(a.status)} cannot be withdrawn.`);
    q.run("UPDATE funding_applications SET status='withdrawn' WHERE id=?", a.id);
    event(a.id, c.user.id, a.status, 'withdrawn');
    audit(c.user.id, 'funding.application_withdrawn', 'funding_application', a.id, null, c.ip);
  });
  return { ok: true };
});

post('/api/funding/applications/:id/sign-agreement', (c) => {
  const i = new Input(c.body);
  const name = i.str('typed_name', { max: 120 });
  const accept = i.bool('accept', true);
  i.done();
  const a0 = appFor(c, c.params.id);
  if (a0.applicant_id !== c.user.id) throw forbidden('Only the applicant who submitted this application can sign the agreement.');
  if (!accept || name!.toLowerCase() !== c.user.full_name.toLowerCase()) throw new HttpError(422, 'validation_failed', 'Some fields need attention.', { typed_name: 'Type your full name exactly as registered and accept the conditions.' });
  tx(() => {
    const a = q.get<any>('SELECT * FROM funding_applications WHERE id = ?', a0.id);
    if (a.status !== 'approved' || a.agreement_status !== 'pending') throw conflict('There is no agreement waiting for your signature.');
    q.run("UPDATE funding_applications SET agreement_status='signed' WHERE id=?", a.id);
    event(a.id, c.user.id, 'approved', 'approved', 'Funding agreement signed');
    audit(c.user.id, 'funding.agreement_signed', 'funding_application', a.id, null, c.ip);
  });
  for (const r of q.all<any>("SELECT DISTINCT user_id FROM user_roles WHERE role IN ('funding_officer','admin')")) notify(r.user_id, 'funding', 'Agreement signed', 'An approved funding application now has a signed agreement.', '#/admin/funding');
  return { ok: true };
});

// Assignment and recommendation are internal working notes: they are included for staff and stripped for applicants.
const INTERNAL_FIELDS = ['assigned_to', 'assigned_at', 'recommendation', 'recommended_amount', 'recommendation_note', 'recommended_by', 'recommended_at'];
const appShape = (a: any, forStaff = false) => {
  const base: any = { ...a };
  const extra: Record<string, unknown> = {};
  if (forStaff) {
    extra.assignee = a.assigned_to ? q.get<any>('SELECT full_name FROM users WHERE id = ?', a.assigned_to)?.full_name ?? null : null;
    extra.recommender = a.recommended_by ? q.get<any>('SELECT full_name FROM users WHERE id = ?', a.recommended_by)?.full_name ?? null : null;
  } else for (const k of INTERNAL_FIELDS) delete base[k];
  return {
    ...base, ...extra,
    budget_items: q.all('SELECT id, label, amount FROM funding_budget_items WHERE application_id = ?', a.id),
    events: q.all('SELECT e.from_status, e.to_status, e.reason, e.created_at, u.full_name AS actor FROM funding_events e JOIN users u ON u.id = e.actor_id WHERE e.application_id = ? ORDER BY e.created_at', a.id),
  };
};

get('/api/funding/applications/mine', (c) => ({
  applications: q.all(`SELECT a.id, a.status, a.requested_amount, a.approved_amount, a.agreement_status, a.disbursement_status, a.decision_reason, a.created_at, o.title AS opportunity, o.currency, v.name AS venture
                       FROM funding_applications a JOIN funding_opportunities o ON o.id = a.opportunity_id JOIN ventures v ON v.id = a.venture_id
                       WHERE a.venture_id IN (SELECT venture_id FROM venture_members WHERE user_id = ?) ORDER BY a.created_at DESC`, c.user.id),
}));

get('/api/funding/applications/:id', (c) => {
  const a = appFor(c, c.params.id);
  const o = q.get<any>('SELECT title, currency, conditions FROM funding_opportunities WHERE id = ?', a.opportunity_id);
  return { application: appShape(a), opportunity: o };
});

// =====================================================================
// Review, decision, agreement, disbursement (staff)
// =====================================================================
get('/api/admin/funding/applications', (c) => {
  const status = c.query.get('status') || null;
  const opp = c.query.get('opportunity_id') || null;
  const assigned = c.query.get('assigned') || null; // me | none | <user id>
  const key = assigned === 'me' ? c.user.id : assigned;
  const term = c.query.get('q')?.trim().toLowerCase();
  const like = term ? likeTerm(term) : null;
  const { limit, offset } = paging(c.query);
  const where = `a.status <> 'draft' AND (? IS NULL OR a.opportunity_id = ?)
    AND (? IS NULL OR (? = 'open' AND a.status IN ('submitted','eligibility_review','under_evaluation','waitlisted')) OR a.status = ?)
    AND (? IS NULL OR (? = 1 AND a.assigned_to IS NULL) OR a.assigned_to = ?)
    AND (? IS NULL OR lower(v.name) LIKE ? ESCAPE '\\' OR lower(u.full_name) LIKE ? ESCAPE '\\')`;
  const params = [opp, opp, status, status, status, key, key === 'none' ? 1 : 0, key, like, like, like];
  const from = `FROM funding_applications a JOIN funding_opportunities o ON o.id = a.opportunity_id JOIN ventures v ON v.id = a.venture_id JOIN users u ON u.id = a.applicant_id LEFT JOIN users r ON r.id = a.assigned_to`;
  const total = q.get<{ n: number }>(`SELECT COUNT(*) AS n ${from} WHERE ${where}`, ...params)!.n;
  const cutoff = new Date(Date.now() - getConfigNumber('review_overdue_days', 7) * 864e5).toISOString();
  const applications = q.all<any>(
    `SELECT a.id, a.status, a.requested_amount, a.approved_amount, a.agreement_status, a.disbursement_status, a.submitted_at, a.assigned_to, r.full_name AS assignee, a.recommendation,
            o.title AS opportunity, o.currency, v.name AS venture, u.full_name AS applicant ${from} WHERE ${where} ORDER BY a.submitted_at ASC LIMIT ? OFFSET ?`, ...params, limit, offset)
    .map((x) => ({ ...x, overdue: ['submitted', 'eligibility_review', 'under_evaluation'].includes(x.status) && !!x.submitted_at && x.submitted_at < cutoff }));
  return { applications, page: pageInfo(total, limit, offset) };
}, { perm: 'funding.manage' });

get('/api/admin/funding/applications/:id', (c) => {
  const a = q.get<any>("SELECT * FROM funding_applications WHERE id = ? AND status <> 'draft'", c.params.id);
  if (!a) throw notFound();
  const o = q.get<any>('SELECT * FROM funding_opportunities WHERE id = ?', a.opportunity_id)!;
  const v = q.get<any>('SELECT id, name, stage, status, industry, problem, solution FROM ventures WHERE id = ?', a.venture_id);
  const done = q.get<any>("SELECT COUNT(*) AS total, SUM(status='completed') AS completed FROM milestones WHERE venture_id = ? AND status <> 'cancelled'", a.venture_id);
  audit(c.user.id, 'funding.application_viewed', 'funding_application', a.id, null, c.ip);
  return { application: appShape(a, true), opportunity: oppShape(o), venture: v, milestones: { total: done.total, completed: done.completed ?? 0 } };
}, { perm: 'funding.manage' });

post('/api/admin/funding/applications/:id/decide', (c) => {
  // Authorization first (route-level perm), then input.
  const i = new Input(c.body);
  const decision = i.oneOf('decision', ['start_review', 'advance', 'approve', 'waitlist', 'reject', 'more_info'] as const);
  const quiet = decision === 'start_review' || decision === 'advance';
  const reason = i.str('reason', { max: 2000, min: quiet ? 0 : 5, required: !quiet });
  const amount = decision === 'approve' ? i.int('approved_amount', { min: 1 }) : null;
  i.done();
  tx(() => {
    const a = q.get<any>('SELECT * FROM funding_applications WHERE id = ?', c.params.id);
    if (!a || a.status === 'draft') throw notFound();
    if (isMember(a.venture_id, c.user.id)) throw forbidden('You cannot evaluate an application for a venture you belong to.');
    if (['approve', 'reject', 'waitlist'].includes(decision!) && a.recommended_by === c.user.id && getConfigNumber('funding_recommender_must_differ', 0) === 1)
      throw forbidden('The person who recommended this decision cannot also make it. Ask a colleague to decide.'); // configurable separation of duties
    const flow: Record<string, { from: string[]; to: string }> = {
      start_review: { from: ['submitted'], to: 'eligibility_review' },
      advance: { from: ['eligibility_review'], to: 'under_evaluation' },
      approve: { from: ['under_evaluation', 'waitlisted'], to: 'approved' },
      waitlist: { from: ['under_evaluation'], to: 'waitlisted' },
      reject: { from: ['submitted', 'eligibility_review', 'under_evaluation', 'waitlisted'], to: 'rejected' },
      more_info: { from: ['eligibility_review', 'under_evaluation'], to: 'more_info_required' },
    };
    const step = flow[decision!];
    if (!step.from.includes(a.status)) throw conflict(`An application that is ${label(a.status)} cannot receive "${decision}".`);
    if (decision === 'approve') {
      const o = q.get<any>('SELECT * FROM funding_opportunities WHERE id = ?', a.opportunity_id)!;
      if (amount! > a.requested_amount) throw new HttpError(422, 'validation_failed', 'Some fields need attention.', { approved_amount: 'Cannot exceed the requested amount.' });
      if (amount! < o.min_amount || amount! > o.max_amount) throw new HttpError(422, 'validation_failed', 'Some fields need attention.', { approved_amount: `Must be between ${o.min_amount} and ${o.max_amount}.` });
      // Budget is checked inside the same write transaction, so concurrent approvals cannot overspend.
      if (spent(o.id) + amount! > o.total_budget) throw conflict(`Not enough budget left. Remaining: ${o.total_budget - spent(o.id)} ${o.currency}.`);
      q.run("UPDATE funding_applications SET status='approved', approved_amount=?, agreement_status='pending', decided_by=?, decision_reason=?, decided_at=? WHERE id=?", amount, c.user.id, reason, now(), a.id);
    } else {
      q.run('UPDATE funding_applications SET status=?, decided_by=CASE WHEN ? IN (\'rejected\',\'waitlisted\',\'more_info_required\') THEN ? ELSE decided_by END, decision_reason=COALESCE(?,decision_reason), decided_at=CASE WHEN ? IN (\'rejected\',\'waitlisted\') THEN ? ELSE decided_at END WHERE id=?',
        step.to, step.to, c.user.id, reason, step.to, now(), a.id);
    }
    event(a.id, c.user.id, a.status, step.to, reason);
    audit(c.user.id, `funding.${decision}`, 'funding_application', a.id, { from: a.status, to: step.to, amount, reason }, c.ip);
    if (!quiet || decision === 'advance')
      notify(a.applicant_id, 'funding', `Funding application: ${label(step.to)}`, reason ?? undefined, '#/funding');
  });
  return { ok: true };
}, { perm: 'funding.review' });

// A recommendation is an internal opinion that informs the final decision. It is never shown to the applicant and decides nothing by itself.
post('/api/admin/funding/applications/:id/recommend', (c) => {
  const i = new Input(c.body);
  const recommendation = i.oneOf('recommendation', ['approve', 'reject', 'more_info'] as const);
  const amount = recommendation === 'approve' ? i.int('recommended_amount', { min: 1 }) : null;
  const note = i.str('note', { min: 5, max: 2000 });
  i.done();
  tx(() => {
    const a = q.get<any>('SELECT * FROM funding_applications WHERE id = ?', c.params.id);
    if (!a || a.status === 'draft') throw notFound();
    if (isMember(a.venture_id, c.user.id)) throw forbidden('You cannot evaluate an application for a venture you belong to.');
    if (!['eligibility_review', 'under_evaluation', 'waitlisted'].includes(a.status)) throw conflict(`A recommendation can be recorded while an application is being reviewed. This one is ${label(a.status)}.`);
    if (amount !== null) {
      const o = q.get<any>('SELECT * FROM funding_opportunities WHERE id = ?', a.opportunity_id)!;
      if (amount > a.requested_amount) throw new HttpError(422, 'validation_failed', 'Some fields need attention.', { recommended_amount: 'Cannot exceed the requested amount.' });
      if (amount < o.min_amount || amount > o.max_amount) throw new HttpError(422, 'validation_failed', 'Some fields need attention.', { recommended_amount: `Must be between ${o.min_amount} and ${o.max_amount}.` });
    }
    q.run('UPDATE funding_applications SET recommendation=?, recommended_amount=?, recommendation_note=?, recommended_by=?, recommended_at=? WHERE id=?', recommendation, amount, note, c.user.id, now(), a.id);
    audit(c.user.id, 'funding.recommended', 'funding_application', a.id, { recommendation, amount, previous: a.recommendation }, c.ip);
  });
  return { ok: true };
}, { perm: 'funding.review' });

post('/api/admin/funding/applications/:id/disburse', (c) => {
  const i = new Input(c.body);
  const reference = i.str('reference', { min: 3, max: 120 });
  const pw = i.str('confirm_password', { max: 128 });
  i.done();
  confirmPassword(c.user, pw, c.ip);
  tx(() => {
    const a = q.get<any>('SELECT * FROM funding_applications WHERE id = ?', c.params.id);
    if (!a) throw notFound();
    if (a.status !== 'approved') throw conflict('Only approved applications can be disbursed.');
    if (a.agreement_status !== 'signed') throw conflict('The funding agreement must be signed before disbursement.');
    if (a.disbursement_status === 'disbursed') throw conflict('This application has already been disbursed.');
    if (a.decided_by === c.user.id) throw forbidden('The person who approved the funding cannot also release the payment.'); // separation of duties
    if (isMember(a.venture_id, c.user.id)) throw forbidden('You cannot disburse funds to a venture you belong to.');
    q.run("UPDATE funding_applications SET disbursement_status='disbursed', disbursement_reference=?, disbursed_by=?, disbursed_at=? WHERE id=?", reference, c.user.id, now(), a.id);
    event(a.id, c.user.id, 'approved', 'approved', `Disbursement recorded (ref ${reference})`);
    audit(c.user.id, 'funding.disbursed', 'funding_application', a.id, { reference, amount: a.approved_amount }, c.ip);
    notify(a.applicant_id, 'funding', 'Disbursement recorded', `A disbursement of ${a.approved_amount} has been recorded (reference ${reference}).`, '#/funding');
  });
  return { ok: true };
}, { perm: 'funding.disburse' });

post('/api/admin/funding/applications/:id/complete', (c) => {
  tx(() => {
    const a = q.get<any>('SELECT * FROM funding_applications WHERE id = ?', c.params.id);
    if (!a) throw notFound();
    if (a.status !== 'approved' || a.disbursement_status !== 'disbursed') throw conflict('Only disbursed funding can be marked complete.');
    q.run("UPDATE funding_applications SET status='completed' WHERE id=?", a.id);
    event(a.id, c.user.id, 'approved', 'completed');
    audit(c.user.id, 'funding.completed', 'funding_application', a.id, null, c.ip);
  });
  return { ok: true };
}, { perm: 'funding.manage' });

// =====================================================================
// Milestones
// =====================================================================
const MEMBER_FLOW: Record<string, string[]> = {
  not_started: ['in_progress', 'cancelled'],
  in_progress: ['submitted', 'blocked', 'cancelled'],
  blocked: ['in_progress', 'cancelled'],
  changes_requested: ['in_progress', 'submitted', 'cancelled'],
};

function milestoneFor(c: { user: AuthUser }, id: string, opts: { reviewer?: boolean } = {}) {
  const m = q.get<any>('SELECT * FROM milestones WHERE id = ?', id);
  if (!m || !(isMember(m.venture_id, c.user.id) || (opts.reviewer && can(c.user, 'milestone.review')))) throw notFound('Milestone not found.');
  return m;
}
const withOverdue = (m: any) => ({ ...m, overdue: !!m.due_date && m.due_date < now() && !['completed', 'cancelled'].includes(m.status) });

post('/api/ventures/:id/milestones', (c) => {
  if (!isMember(c.params.id, c.user.id)) throw notFound('Venture not found.');
  const i = new Input(c.body);
  const title = i.str('title', { min: 3, max: 160 });
  const description = i.str('description', { max: 2000, required: false });
  const due = i.date('due_date');
  const criteria = i.str('completion_criteria', { max: 1000, required: false });
  const ownerId = i.str('owner_id', { max: 60, required: false });
  const programmeId = i.str('programme_id', { max: 60, required: false });
  const priority = i.oneOf('priority', ['low', 'normal', 'high'] as const, false) ?? 'normal';
  i.done();
  if (ownerId && !isMember(c.params.id, ownerId)) throw new HttpError(422, 'validation_failed', 'Some fields need attention.', { owner_id: 'The owner must be a member of the venture.' });
  const id = uid();
  q.run(`INSERT INTO milestones(id,venture_id,programme_id,title,description,due_date,owner_id,completion_criteria,status,created_by,created_at,updated_at,priority) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, c.params.id, programmeId, title, description, due, ownerId ?? c.user.id, criteria, 'not_started', c.user.id, now(), now(), priority);
  audit(c.user.id, 'milestone.created', 'milestone', id, { venture: c.params.id }, c.ip);
  return new Created({ id });
});

get('/api/ventures/:id/milestones', (c) => {
  const v = q.get<any>('SELECT * FROM ventures WHERE id = ?', c.params.id);
  if (!v || !(isMember(v.id, c.user.id) || (can(c.user, 'milestone.review') && v.status !== 'draft'))) throw notFound('Venture not found.');
  return { milestones: q.all('SELECT m.*, u.full_name AS owner_name FROM milestones m LEFT JOIN users u ON u.id = m.owner_id WHERE m.venture_id = ? ORDER BY m.due_date IS NULL, m.due_date, m.created_at', v.id).map(withOverdue) };
});

get('/api/milestones/mine', (c) => ({
  milestones: q.all(`SELECT m.*, v.name AS venture_name FROM milestones m JOIN ventures v ON v.id = m.venture_id WHERE m.venture_id IN (SELECT venture_id FROM venture_members WHERE user_id = ?) ORDER BY m.due_date IS NULL, m.due_date`, c.user.id).map(withOverdue),
}));

patch('/api/milestones/:id', (c) => {
  const m = milestoneFor(c, c.params.id);
  if (['completed', 'cancelled'].includes(m.status)) throw conflict(`A milestone that is ${m.status} cannot be edited.`);
  const i = new Input(c.body);
  const title = i.str('title', { min: 3, max: 160, required: false });
  const description = i.str('description', { max: 2000, required: false });
  const due = i.date('due_date');
  const criteria = i.str('completion_criteria', { max: 1000, required: false });
  const priority = i.oneOf('priority', ['low', 'normal', 'high'] as const, false);
  i.done();
  q.run('UPDATE milestones SET title=COALESCE(?,title), description=COALESCE(?,description), due_date=COALESCE(?,due_date), completion_criteria=COALESCE(?,completion_criteria), priority=COALESCE(?,priority), updated_at=? WHERE id=?', title, description, due, criteria, priority, now(), m.id);
  return { ok: true };
});

post('/api/milestones/:id/transition', (c) => {
  const i = new Input(c.body);
  const to = i.oneOf('to', ['in_progress', 'submitted', 'blocked', 'cancelled'] as const);
  const evidenceText = i.str('evidence_text', { max: 3000, required: false });
  const docId = i.str('evidence_document_id', { max: 60, required: false });
  const metric = i.str('outcome_metric', { max: 120, required: false });
  const value = i.num('outcome_value', { required: false });
  i.done();
  tx(() => {
    const m = milestoneFor(c, c.params.id);
    if (!(MEMBER_FLOW[m.status] ?? []).includes(to!)) throw conflict(`A milestone that is ${label(m.status)} cannot move to ${label(to!)}.`);
    if (to === 'submitted') {
      const text = evidenceText ?? m.evidence_text;
      const doc = docId ?? m.evidence_document_id;
      if (!text && !doc) throw new HttpError(422, 'validation_failed', 'Evidence is required.', { evidence_text: 'Describe the evidence or attach a document.' });
      if (docId && !q.get("SELECT 1 FROM documents WHERE id = ? AND owner_id = ? AND scan_status <> 'quarantined'", docId, c.user.id)) throw bad('That document is not yours or failed safety checks.');
      // Whatever a team member submits is self-reported until a reviewer verifies it.
      q.run("UPDATE milestones SET status='submitted', evidence_text=?, evidence_document_id=?, evidence_type='self_reported', outcome_metric=COALESCE(?,outcome_metric), outcome_value=COALESCE(?,outcome_value), review_comment=NULL, updated_at=? WHERE id=?", text, doc, metric, value, now(), m.id);
      for (const r of q.all<any>("SELECT DISTINCT user_id FROM user_roles WHERE role IN ('incubation_manager','programme_coordinator')")) notify(r.user_id, 'review', 'Milestone evidence submitted', `"${m.title}" is waiting for review.`, '#/admin/milestones');
    } else {
      q.run('UPDATE milestones SET status=?, updated_at=? WHERE id=?', to, now(), m.id);
    }
    audit(c.user.id, `milestone.${to}`, 'milestone', m.id, { from: m.status }, c.ip);
  });
  return { ok: true };
});

get('/api/admin/milestones', (c) => {
  const status = c.query.get('status') || 'submitted';
  return {
    milestones: q.all(`SELECT m.id, m.title, m.status, m.due_date, m.evidence_type, m.updated_at, v.name AS venture_name FROM milestones m JOIN ventures v ON v.id = m.venture_id WHERE m.status = ? ORDER BY m.updated_at ASC LIMIT 200`, status).map(withOverdue),
  };
}, { perm: 'milestone.review' });

get('/api/admin/milestones/:id', (c) => {
  const m = milestoneFor(c, c.params.id, { reviewer: true });
  const doc = m.evidence_document_id ? q.get('SELECT id, original_name, mime, size, scan_status FROM documents WHERE id = ?', m.evidence_document_id) : null;
  const v = q.get('SELECT id, name, stage FROM ventures WHERE id = ?', m.venture_id);
  return { milestone: withOverdue(m), venture: v, evidence_document: doc };
}, { perm: 'milestone.review' });

post('/api/admin/milestones/:id/review', (c) => {
  const i = new Input(c.body);
  const decision = i.oneOf('decision', ['verify', 'request_changes'] as const);
  const comment = i.str('comment', { max: 2000, min: decision === 'request_changes' ? 5 : 0, required: decision === 'request_changes' });
  i.done();
  tx(() => {
    const m = q.get<any>('SELECT * FROM milestones WHERE id = ?', c.params.id);
    if (!m) throw notFound();
    if (isMember(m.venture_id, c.user.id)) throw forbidden('You cannot review a milestone for a venture you belong to.');
    if (m.status !== 'submitted') throw conflict(`A milestone that is ${label(m.status)} is not awaiting review.`);
    if (decision === 'verify') q.run("UPDATE milestones SET status='completed', evidence_type='verified', reviewer_id=?, review_comment=?, completed_at=?, updated_at=? WHERE id=?", c.user.id, comment, now(), now(), m.id);
    else q.run("UPDATE milestones SET status='changes_requested', reviewer_id=?, review_comment=?, updated_at=? WHERE id=?", c.user.id, comment, now(), m.id);
    audit(c.user.id, `milestone.${decision}`, 'milestone', m.id, { comment }, c.ip);
    for (const mem of q.all<any>('SELECT user_id FROM venture_members WHERE venture_id = ?', m.venture_id))
      notify(mem.user_id, 'milestone', decision === 'verify' ? 'Milestone verified' : 'Milestone needs changes', comment ?? `"${m.title}" was verified.`, `#/ventures/${m.venture_id}`);
  });
  return { ok: true };
}, { perm: 'milestone.review' });

get('/api/milestones/:id/evidence', (c) => {
  // Evidence download for venture members and reviewers; every reviewer access is audited by the document layer.
  const m = milestoneFor(c, c.params.id, { reviewer: true });
  if (!m.evidence_document_id) throw notFound('No evidence document attached.');
  return { document_id: m.evidence_document_id };
});
