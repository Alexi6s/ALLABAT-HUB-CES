import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, PASSWORD, PDF, audits, closeApp, q, signup, staff, verified, ventureFor } from './helpers.ts';

after(closeApp);
const future = (days: number) => new Date(Date.now() + days * 86400_000).toISOString();

async function opportunity(overrides: Record<string, unknown> = {}) {
  const officer = await staff('funding_officer');
  const o = await officer.post('/api/admin/funding/opportunities', {
    title: 'Seed Grant', description: 'Early-stage grant.', currency: 'NGN', min_amount: 100000, max_amount: 500000, total_budget: 600000,
    eligible_categories: ['student', 'alumni', 'external_entrepreneur'], criteria: 'Traction and team.', conditions: 'Quarterly reporting.', ...overrides,
  });
  assert.equal(o.status, 201, JSON.stringify(o.body));
  assert.equal((await officer.post(`/api/admin/funding/opportunities/${o.body.id}/open`)).status, 200);
  return { officer, id: o.body.id as string };
}

async function readyVenture(category = 'student') {
  const owner = await verified(category);
  const ventureId = await ventureFor(owner);
  assert.equal((await owner.post(`/api/ventures/${ventureId}/submit`)).status, 200);
  return { owner, ventureId };
}

async function submitted(oppId: string, owner: Client, ventureId: string, amount = 300000) {
  const a = await owner.post(`/api/funding/opportunities/${oppId}/applications`, {
    venture_id: ventureId, requested_amount: amount,
    justification: 'We need equipment to scale production to forty customers within six months.', use_of_funds: 'Equipment and working capital.',
    budget_items: [{ label: 'Equipment', amount: amount - 50000 }, { label: 'Working capital', amount: 50000 }],
  });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal((await owner.post(`/api/funding/applications/${a.body.id}/submit`)).status, 200);
  return a.body.id as string;
}

async function toEvaluation(officer: Client, appId: string) {
  assert.equal((await officer.post(`/api/admin/funding/applications/${appId}/decide`, { decision: 'start_review' })).status, 200);
  assert.equal((await officer.post(`/api/admin/funding/applications/${appId}/decide`, { decision: 'advance' })).status, 200);
}

test('reports: money totals are hidden from partners until at least five grants contribute (small-group disclosure)', async () => {
  // Must run before any other test here approves a grant, so the counts below are exact.
  assert.equal(q.get<{ n: number }>("SELECT COUNT(*) AS n FROM funding_applications WHERE status IN ('approved','completed')")!.n, 0, 'precondition: this test runs first');
  const partner = await verified('partner');
  const coord = await staff('programme_coordinator');
  const admin = await staff('admin');
  const { officer, id } = await opportunity();
  const funding = async (c: Client) => (await c.get('/api/reports/summary')).body.funding;

  const zero = await funding(partner);
  assert.equal(zero.approved_amount, 0, 'no grants at all is a real zero, not a hidden figure');
  assert.equal(zero.amounts_suppressed, false);

  async function approveOne(amount: number) {
    const { owner, ventureId } = await readyVenture();
    const appId = await submitted(id, owner, ventureId, 150000);
    await toEvaluation(officer, appId);
    assert.equal((await officer.post(`/api/admin/funding/applications/${appId}/decide`, { decision: 'approve', reason: 'Meets the criteria.', approved_amount: amount })).status, 200);
    return { owner, appId };
  }

  const first = await approveOne(100000);
  const one = await funding(partner);
  assert.equal(one.approved_amount, null, 'one grant: the total would reveal an individual award');
  assert.equal(one.amounts_suppressed, true);
  assert.equal((await funding(coord)).approved_amount, 100000, 'staff with exact-count roles still see the figure');
  assert.equal((await funding(coord)).amounts_suppressed, false);

  assert.equal((await first.owner.post(`/api/funding/applications/${first.appId}/sign-agreement`, { typed_name: first.owner.name, accept: true })).status, 200);
  assert.equal((await admin.post(`/api/admin/funding/applications/${first.appId}/disburse`, { reference: 'TRF-R1', confirm_password: PASSWORD })).status, 200);
  assert.equal((await funding(partner)).disbursed_amount, null, 'one disbursement is hidden too');
  assert.equal((await funding(coord)).disbursed_amount, 100000);

  for (let i = 0; i < 4; i++) await approveOne(100000);
  const five = await funding(partner);
  assert.equal(five.approved_amount, 500000, 'five contributing grants: the total is shown');
  assert.equal(five.disbursed_amount, null, 'still only one disbursement: still hidden');
  assert.equal(five.amounts_suppressed, true, 'the flag means at least one amount is withheld (here the disbursed total)');
});

test('opportunity validation protects the budget arithmetic', async () => {
  const officer = await staff('funding_officer');
  const base = { title: 'Grant', min_amount: 10, max_amount: 100, total_budget: 1000 };
  assert.equal((await officer.post('/api/admin/funding/opportunities', { ...base, min_amount: 200 })).status, 422);
  assert.equal((await officer.post('/api/admin/funding/opportunities', { ...base, max_amount: 5000 })).status, 422);
  assert.equal((await officer.post('/api/admin/funding/opportunities', { ...base, opens_at: future(5), closes_at: future(1) })).status, 422);
  assert.equal((await (await verified('student')).post('/api/admin/funding/opportunities', base)).status, 403);
  assert.equal((await officer.post('/api/admin/funding/opportunities', base)).status, 201);
});

test('applicants need a submitted venture, a reconciled budget and eligibility', async () => {
  const { id } = await opportunity();
  const owner = await verified('student');
  const draftVenture = await ventureFor(owner, 'Still Draft');
  const early = await owner.post(`/api/funding/opportunities/${id}/applications`, { venture_id: draftVenture, requested_amount: 200000 });
  assert.equal(early.status, 409, 'venture must be submitted first');

  const { owner: o2, ventureId } = await readyVenture();
  assert.equal((await o2.post(`/api/funding/opportunities/${id}/applications`, { venture_id: ventureId, requested_amount: 50 })).status, 422, 'below the minimum');
  assert.equal((await o2.post(`/api/funding/opportunities/${id}/applications`, { venture_id: ventureId, requested_amount: 900000 })).status, 422, 'above the maximum');
  assert.equal((await o2.post(`/api/funding/opportunities/${id}/applications`, { venture_id: 'not-mine', requested_amount: 200000 })).status, 403);

  const created = await o2.post(`/api/funding/opportunities/${id}/applications`, {
    venture_id: ventureId, requested_amount: 200000, justification: 'We need equipment to scale production for forty customers.', use_of_funds: 'Equipment',
    budget_items: [{ label: 'Equipment', amount: 150000 }],
  });
  assert.equal(created.status, 201);
  const mismatch = await o2.post(`/api/funding/applications/${created.body.id}/submit`);
  assert.equal(mismatch.status, 422);
  assert.match(mismatch.body.error.details.budget_items, /must match/);
  assert.equal((await o2.put(`/api/funding/applications/${created.body.id}`, { requested_amount: 200000, justification: 'We need equipment to scale production for forty customers.', use_of_funds: 'Equipment', budget_items: [{ label: 'Equipment', amount: 200000 }] })).status, 200);
  assert.equal((await o2.post(`/api/funding/applications/${created.body.id}/submit`)).status, 200);
  assert.equal((await o2.post(`/api/funding/opportunities/${id}/applications`, { venture_id: ventureId, requested_amount: 200000 })).status, 409, 'one application per venture');

  const outsider = await verified('external_participant');
  assert.equal((await outsider.post(`/api/funding/opportunities/${id}/applications`, { venture_id: await ventureFor(outsider), requested_amount: 200000 })).status, 403);
  assert.equal((await (await signup('student')).get('/api/funding/opportunities')).status, 403);
});

test('applications are private to the venture team', async () => {
  const { id } = await opportunity();
  const { owner, ventureId } = await readyVenture();
  const appId = await submitted(id, owner, ventureId);
  const stranger = await verified('student');
  assert.equal((await stranger.get(`/api/funding/applications/${appId}`)).status, 404);
  assert.equal((await stranger.post(`/api/funding/applications/${appId}/withdraw`)).status, 404);
  assert.equal((await stranger.put(`/api/funding/applications/${appId}`, { requested_amount: 100000 })).status, 404);
  assert.equal((await stranger.get('/api/funding/applications/mine')).body.applications.length, 0);
  assert.equal((await owner.get(`/api/funding/applications/${appId}`)).status, 200);
  assert.equal((await stranger.get(`/api/admin/funding/applications/${appId}`)).status, 403);
});

test('full funding path: evaluation, approval, agreement, separated disbursement, completion', async () => {
  const { officer, id } = await opportunity();
  const { owner, ventureId } = await readyVenture();
  const appId = await submitted(id, owner, ventureId, 300000);

  // Permission is checked before input and before state.
  assert.equal((await owner.post(`/api/admin/funding/applications/${appId}/decide`, {})).status, 403);
  assert.equal((await officer.post(`/api/admin/funding/applications/${appId}/decide`, { decision: 'approve', reason: 'Too early', approved_amount: 100000 })).status, 409, 'cannot skip evaluation');
  await toEvaluation(officer, appId);
  assert.equal((await officer.post(`/api/admin/funding/applications/${appId}/decide`, { decision: 'approve', reason: 'Strong case.' })).status, 422, 'amount is required');
  assert.equal((await officer.post(`/api/admin/funding/applications/${appId}/decide`, { decision: 'approve', reason: 'Strong case.', approved_amount: 400000 })).status, 422, 'cannot exceed the request');
  assert.equal((await officer.post(`/api/admin/funding/applications/${appId}/decide`, { decision: 'approve', reason: 'Strong case.', approved_amount: 250000 })).status, 200);

  const row = () => q.get<any>('SELECT * FROM funding_applications WHERE id = ?', appId)!;
  assert.equal(row().status, 'approved');
  assert.equal(row().approved_amount, 250000);
  assert.equal(row().agreement_status, 'pending');
  assert.equal(row().disbursement_status, 'not_started', 'approval is not payment');

  const admin = await staff('admin');
  assert.equal((await admin.post(`/api/admin/funding/applications/${appId}/disburse`, { reference: 'TRF-001', confirm_password: PASSWORD })).status, 409, 'agreement not signed');
  assert.equal((await owner.post(`/api/funding/applications/${appId}/sign-agreement`, { typed_name: 'Someone Else', accept: true })).status, 422);
  assert.equal((await owner.post(`/api/funding/applications/${appId}/sign-agreement`, { typed_name: owner.name, accept: false })).status, 422);
  const teammate = await verified('student');
  await owner.post(`/api/ventures/${ventureId}/members`, { email: teammate.email });
  assert.equal((await teammate.post(`/api/funding/applications/${appId}/sign-agreement`, { typed_name: teammate.name, accept: true })).status, 403, 'only the applicant signs');
  assert.equal((await owner.post(`/api/funding/applications/${appId}/sign-agreement`, { typed_name: owner.name.toUpperCase(), accept: true })).status, 200);
  assert.equal((await owner.post(`/api/funding/applications/${appId}/sign-agreement`, { typed_name: owner.name, accept: true })).status, 409);

  assert.equal((await owner.post(`/api/admin/funding/applications/${appId}/disburse`, { reference: 'X', confirm_password: PASSWORD })).status, 403);
  assert.equal((await officer.post(`/api/admin/funding/applications/${appId}/disburse`, { reference: 'TRF-001', confirm_password: PASSWORD })).status, 403, 'funding officers cannot release payments');
  assert.equal((await admin.post(`/api/admin/funding/applications/${appId}/disburse`, { reference: 'TRF-001', confirm_password: PASSWORD })).status, 200);
  assert.equal((await admin.post(`/api/admin/funding/applications/${appId}/disburse`, { reference: 'TRF-002', confirm_password: PASSWORD })).status, 409, 'cannot pay twice');
  assert.equal(row().disbursed_by, admin.id);
  assert.equal((await admin.post(`/api/admin/funding/applications/${appId}/complete`)).status, 200);
  assert.equal(row().status, 'completed');

  const trail = (await owner.get(`/api/funding/applications/${appId}`)).body.application.events.map((e: any) => e.to_status);
  assert.deepEqual(trail.slice(0, 3), ['draft', 'submitted', 'eligibility_review']);
  assert.ok(audits('funding.disbursed').length >= 1);
});

test('the person who approved funding can never release it, even as super administrator', async () => {
  const { id } = await opportunity();
  const { owner, ventureId } = await readyVenture();
  const appId = await submitted(id, owner, ventureId, 200000);
  const boss = await staff('super_admin'); // holds both funding.review and funding.disburse
  await toEvaluation(boss, appId);
  assert.equal((await boss.post(`/api/admin/funding/applications/${appId}/decide`, { decision: 'approve', reason: 'Approved by me.', approved_amount: 200000 })).status, 200);
  await owner.post(`/api/funding/applications/${appId}/sign-agreement`, { typed_name: owner.name, accept: true });
  const res = await boss.post(`/api/admin/funding/applications/${appId}/disburse`, { reference: 'SELF-PAY', confirm_password: PASSWORD });
  assert.equal(res.status, 403);
  assert.match(res.body.error.message, /cannot also release/);
  const other = await staff('admin');
  assert.equal((await other.post(`/api/admin/funding/applications/${appId}/disburse`, { reference: 'OK-1', confirm_password: PASSWORD })).status, 200);
});

test('budget cannot be overspent, including by parallel approvals', async () => {
  const { officer, id } = await opportunity({ total_budget: 500000, max_amount: 300000, min_amount: 1000 });
  const teams = await Promise.all([readyVenture(), readyVenture(), readyVenture()]);
  const apps: string[] = [];
  for (const t of teams) {
    const appId = await submitted(id, t.owner, t.ventureId, 250000);
    await toEvaluation(officer, appId);
    apps.push(appId);
  }
  const results = await Promise.all(apps.map((a) => officer.post(`/api/admin/funding/applications/${a}/decide`, { decision: 'approve', reason: 'Meets criteria.', approved_amount: 250000 })));
  assert.equal(results.filter((r) => r.status === 200).length, 2, '2 x 250000 fits in 500000');
  assert.equal(results.filter((r) => r.status === 409).length, 1);
  assert.equal(q.get<any>("SELECT SUM(approved_amount) AS s FROM funding_applications WHERE opportunity_id = ? AND status = 'approved'", id)!.s, 500000);
  const view = (await officer.get('/api/admin/funding/opportunities')).body.opportunities.find((o: any) => o.id === id);
  assert.equal(view.remaining_budget, 0);
  const loser = apps.find((a) => q.get<any>('SELECT status FROM funding_applications WHERE id = ?', a)!.status === 'under_evaluation')!;
  assert.equal((await officer.post(`/api/admin/funding/applications/${loser}/decide`, { decision: 'waitlist', reason: 'Budget exhausted for now.' })).status, 200);
  assert.equal((await officer.post(`/api/admin/funding/opportunities/${id}`, {})).status, 405);
  assert.equal((await officer.patch(`/api/admin/funding/opportunities/${id}`, { total_budget: 400000, max_amount: 300000 })).status, 409, 'budget cannot drop below what is approved');
});

test('evaluators cannot decide on ventures they belong to; rejection and more-info loops work', async () => {
  const { officer, id } = await opportunity();
  const { owner, ventureId } = await readyVenture();
  const appId = await submitted(id, owner, ventureId);
  await owner.post(`/api/ventures/${ventureId}/members`, { email: officer.email });
  assert.equal((await officer.post(`/api/admin/funding/applications/${appId}/decide`, { decision: 'start_review' })).status, 403);
  await owner.del(`/api/ventures/${ventureId}/members/${officer.id}`);
  assert.equal((await officer.post(`/api/admin/funding/applications/${appId}/decide`, { decision: 'start_review' })).status, 200);
  assert.equal((await officer.post(`/api/admin/funding/applications/${appId}/decide`, { decision: 'more_info', reason: 'Add customer letters of intent.' })).status, 200);
  assert.equal((await owner.put(`/api/funding/applications/${appId}`, { requested_amount: 300000, justification: 'We need equipment to scale production to forty customers within six months.', use_of_funds: 'Equipment', budget_items: [{ label: 'All', amount: 300000 }] })).status, 200);
  assert.equal((await owner.post(`/api/funding/applications/${appId}/submit`)).status, 200);
  assert.equal((await officer.post(`/api/admin/funding/applications/${appId}/decide`, { decision: 'reject', reason: 'Does not meet criteria.' })).status, 200);
  assert.equal((await owner.post(`/api/funding/applications/${appId}/withdraw`)).status, 409);
  assert.ok((await owner.get('/api/notifications')).body.notifications.some((n: any) => /rejected/i.test(n.title)));
});

test('milestones: members submit evidence, evidence stays self-reported until a reviewer verifies it', async () => {
  const owner = await verified('student');
  const ventureId = await ventureFor(owner);
  const m = await owner.post(`/api/ventures/${ventureId}/milestones`, { title: 'Sign 5 pilot customers', due_date: future(30), completion_criteria: 'Five signed letters of intent.' });
  assert.equal(m.status, 201);
  const mid = m.body.id;
  assert.equal((await owner.post(`/api/milestones/${mid}/transition`, { to: 'submitted' })).status, 409, 'must start first');
  assert.equal((await owner.post(`/api/milestones/${mid}/transition`, { to: 'in_progress' })).status, 200);
  assert.equal((await owner.post(`/api/milestones/${mid}/transition`, { to: 'submitted' })).status, 422, 'evidence required');
  const doc = await owner.upload('milestone_evidence', PDF, 'loi.pdf', { 'X-Context': 'milestone', 'X-Context-Id': mid });
  assert.equal(doc.status, 201);
  const foreign = await (await verified('student')).upload('milestone_evidence', PDF);
  assert.equal((await owner.post(`/api/milestones/${mid}/transition`, { to: 'submitted', evidence_document_id: foreign.body.id })).status, 400, 'cannot attach someone else\'s file');
  assert.equal((await owner.post(`/api/milestones/${mid}/transition`, { to: 'submitted', evidence_text: 'Five LOIs attached.', evidence_document_id: doc.body.id, outcome_metric: 'pilot_customers', outcome_value: 5 })).status, 200);
  assert.equal(q.get<any>('SELECT evidence_type FROM milestones WHERE id = ?', mid)!.evidence_type, 'self_reported');
  assert.equal((await owner.post(`/api/milestones/${mid}/transition`, { to: 'in_progress' })).status, 409, 'locked while awaiting review');

  const mgr = await staff('incubation_manager');
  assert.equal((await owner.post(`/api/admin/milestones/${mid}/review`, { decision: 'verify' })).status, 403, 'teams cannot verify themselves');
  assert.equal((await mgr.post(`/api/admin/milestones/${mid}/review`, { decision: 'request_changes' })).status, 422);
  assert.equal((await mgr.post(`/api/admin/milestones/${mid}/review`, { decision: 'request_changes', comment: 'Two of the letters are unsigned.' })).status, 200);
  assert.equal((await owner.post(`/api/milestones/${mid}/transition`, { to: 'submitted' })).status, 200, 'resubmit with existing evidence');
  const dl = await mgr.get(`/api/documents/${doc.body.id}/download`);
  assert.equal(dl.status, 200, 'reviewers can open milestone evidence');
  assert.equal((await mgr.post(`/api/admin/milestones/${mid}/review`, { decision: 'verify', comment: 'Confirmed with customers.' })).status, 200);
  const done = q.get<any>('SELECT * FROM milestones WHERE id = ?', mid)!;
  assert.equal(done.status, 'completed');
  assert.equal(done.evidence_type, 'verified');
  assert.ok(done.completed_at);
  assert.equal((await mgr.post(`/api/admin/milestones/${mid}/review`, { decision: 'verify' })).status, 409);
  assert.equal((await owner.patch(`/api/milestones/${mid}`, { title: 'Edited after completion' })).status, 409);
});

test('milestone access follows venture membership; overdue is computed, not stored', async () => {
  const owner = await verified('student');
  const ventureId = await ventureFor(owner);
  const stranger = await verified('student');
  assert.equal((await stranger.post(`/api/ventures/${ventureId}/milestones`, { title: 'Intruder milestone' })).status, 404);
  assert.equal((await stranger.get(`/api/ventures/${ventureId}/milestones`)).status, 404);
  const past = new Date(Date.now() - 86400_000).toISOString();
  const m = await owner.post(`/api/ventures/${ventureId}/milestones`, { title: 'Overdue thing', due_date: past });
  const list = (await owner.get(`/api/ventures/${ventureId}/milestones`)).body.milestones;
  assert.equal(list.find((x: any) => x.id === m.body.id).overdue, true);
  assert.equal((await stranger.patch(`/api/milestones/${m.body.id}`, { title: 'Hijacked' })).status, 404);
  assert.equal((await stranger.post(`/api/milestones/${m.body.id}/transition`, { to: 'in_progress' })).status, 404);
  const dash = (await owner.get('/api/dashboard')).body;
  assert.equal(dash.counts.overdue_milestones, 1);
  assert.ok(dash.next_steps.some((s: any) => /overdue/.test(s.text)));
  assert.equal((await owner.get('/api/admin/milestones')).status, 403);
});
