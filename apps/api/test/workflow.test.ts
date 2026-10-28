// Day-to-day workflows added in the upgrade: venture archive and history, application scoring and timelines,
// funding recommendations (internal, with optional separation of duties), milestone priority.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, PASSWORD, audits, closeApp, openOpportunity, q, signup, staff, startEvaluation, submitFunding, submittedVenture, verified, ventureFor } from './helpers.ts';

after(closeApp);

test('ventures: location, archive and restore, and a history only the team can read', async () => {
  const owner = await verified('student');
  const teammate = await verified('student');
  const id = await ventureFor(owner, 'Archive Co', { location: 'Makurdi, Benue' });
  assert.equal((await owner.get(`/api/ventures/${id}`)).body.venture.location, 'Makurdi, Benue');
  assert.equal((await owner.patch(`/api/ventures/${id}`, { location: 'Gboko' })).status, 200);
  assert.equal((await owner.get(`/api/ventures/${id}`)).body.venture.location, 'Gboko');
  assert.equal((await owner.patch(`/api/ventures/${id}`, { location: 'x'.repeat(200) })).status, 422);

  q.run("INSERT INTO venture_members(venture_id,user_id,member_role,added_at) VALUES (?,?,'member',?)", id, teammate.id, new Date().toISOString());
  assert.equal((await teammate.post(`/api/ventures/${id}/archive`)).status, 403, 'only the owner archives');
  assert.equal((await (await verified('student')).post(`/api/ventures/${id}/archive`)).status, 404);
  assert.equal((await owner.post(`/api/ventures/${id}/unarchive`)).status, 409, 'not archived yet');
  assert.equal((await owner.post(`/api/ventures/${id}/archive`)).status, 200);
  assert.equal((await owner.post(`/api/ventures/${id}/archive`)).status, 409);
  const listed = (await owner.get('/api/ventures')).body;
  assert.ok(!listed.ventures.some((v: any) => v.id === id), 'archived ventures leave the working list');
  assert.equal(listed.archived_count, 1);
  assert.ok((await owner.get('/api/ventures?archived=1')).body.ventures.some((v: any) => v.id === id && v.archived_at));
  assert.equal((await owner.patch(`/api/ventures/${id}`, { risks: 'None' })).status, 409, 'no edits while archived');
  assert.equal((await owner.get(`/api/ventures/${id}`)).body.can_edit, false);
  assert.equal((await owner.post(`/api/ventures/${id}/submit`)).status, 409);
  assert.equal((await owner.post(`/api/ventures/${id}/unarchive`)).status, 200);
  assert.equal((await owner.patch(`/api/ventures/${id}`, { risks: 'Regulatory timelines.' })).status, 200);
  assert.deepEqual(audits('venture.archived').map((a) => a.entity_id), [id]);

  const history = await teammate.get(`/api/ventures/${id}/history`);
  assert.equal(history.status, 200);
  assert.ok(history.body.events.some((e: any) => e.action === 'venture.archived'));
  assert.ok(history.body.events.some((e: any) => e.action === 'venture.created'));
  assert.ok(!history.body.events.some((e: any) => e.action === 'venture.updated'), 'noise is left out');
  assert.equal((await (await verified('student')).get(`/api/ventures/${id}/history`)).status, 404);
  assert.equal((await new Client().get(`/api/ventures/${id}/history`)).status, 401);
});

test('ventures: an active review, incubation or funding blocks archiving; archived ventures cannot apply for funding', async () => {
  const { owner, ventureId } = await submittedVenture();
  assert.equal((await owner.post(`/api/ventures/${ventureId}/archive`)).status, 409, 'under review');
  const mgr = await staff('incubation_manager');
  assert.equal((await mgr.post(`/api/admin/ventures/${ventureId}/review`, { decision: 'approve' })).status, 200);
  assert.equal((await owner.post(`/api/ventures/${ventureId}/archive`)).status, 409, 'incubating');
  assert.equal((await mgr.post(`/api/admin/ventures/${ventureId}/review`, { decision: 'graduate' })).status, 200);

  const { id: oppId } = await openOpportunity();
  const appId = await submitFunding(oppId, owner, ventureId);
  assert.equal((await owner.post(`/api/ventures/${ventureId}/archive`)).status, 409, 'funding in progress');
  const history = (await owner.get(`/api/ventures/${ventureId}/history`)).body;
  assert.equal(history.funding.length, 1);
  assert.equal(history.funding[0].id, appId);

  const second = await verified('student');
  const draftId = await ventureFor(second, 'Dormant Co');
  assert.equal((await second.post(`/api/ventures/${draftId}/archive`)).status, 200);
  const opp2 = await openOpportunity();
  const res = await second.post(`/api/funding/opportunities/${opp2.id}/applications`, { venture_id: draftId, requested_amount: 200000, justification: 'We need equipment to scale production to forty customers.', use_of_funds: 'Equipment.', budget_items: [{ label: 'Equipment', amount: 200000 }] });
  assert.equal(res.status, 409);
  assert.match(res.body.error.message, /archived/i);
});

test('programme applications: scoring and notes are internal, filters and paging work, applicants see a safe timeline', async () => {
  const coord = await staff('programme_coordinator');
  const created = await coord.post('/api/admin/programmes', { title: 'Cohort B', description: 'Twelve weeks.', capacity: 10, eligible_categories: ['student'], questions: [{ id: 'why', label: 'Why?', required: true }] });
  await coord.post(`/api/admin/programmes/${created.body.id}/publish`);
  const pid = created.body.id;
  const people: Client[] = [];
  for (let n = 0; n < 3; n++) {
    const s = await verified('student');
    assert.equal((await s.post(`/api/programmes/${pid}/apply`, { answers: { why: `Reason number ${n} for applying.` } })).status, 201);
    people.push(s);
  }
  const ids = people.map((p) => q.get<any>('SELECT id FROM programme_applications WHERE user_id = ?', p.id)!.id);
  const other = await staff('programme_coordinator');

  assert.equal((await people[0].post(`/api/admin/programme-applications/${ids[0]}/review`, { score: 90 })).status, 403);
  assert.equal((await coord.post(`/api/admin/programme-applications/${ids[0]}/review`, {})).status, 422, 'a score or notes is needed');
  assert.equal((await coord.post(`/api/admin/programme-applications/${ids[0]}/review`, { score: 101 })).status, 422);
  assert.equal((await coord.post(`/api/admin/programme-applications/${ids[0]}/review`, { score: -1 })).status, 422);
  assert.equal((await coord.post(`/api/admin/programme-applications/${ids[0]}/review`, { score: 82, notes: 'Strong team, weak market evidence.' })).status, 200);
  assert.equal((await coord.post(`/api/admin/programme-applications/${ids[0]}/review`, { notes: 'Follow-up: asked about pricing.' })).status, 200, 'notes can be added without losing the score');
  assert.equal(q.get<any>('SELECT review_score FROM programme_applications WHERE id = ?', ids[0])!.review_score, 82);
  assert.equal((await coord.post('/api/admin/programme-applications/missing/review', { score: 5 })).status, 404);
  q.run('UPDATE programme_applications SET user_id = ? WHERE id = ?', coord.id, ids[2]);
  assert.equal((await coord.post(`/api/admin/programme-applications/${ids[2]}/review`, { score: 50 })).status, 403, 'not your own application');
  q.run('UPDATE programme_applications SET user_id = ? WHERE id = ?', people[2].id, ids[2]);

  const mine = (await people[0].get('/api/programme-applications/mine')).body.applications[0];
  assert.ok(!JSON.stringify(mine).includes('weak market evidence') && !('review_score' in mine) && !('review_notes' in mine), 'the applicant never sees scoring');

  assert.equal((await coord.post(`/api/admin/programme-applications/${ids[0]}/assign`, { assignee_id: other.id })).status, 200);
  const ver = (path: string) => coord.get(`/api/admin/programmes/${pid}/applications${path}`);
  const all = (await ver('')).body;
  assert.equal(all.applications.find((a: any) => a.id === ids[0]).review_score, 82);
  assert.equal(all.applications.find((a: any) => a.id === ids[0]).assignee, other.name);
  assert.deepEqual((await ver('?assigned=none')).body.applications.map((a: any) => a.id).sort(), [ids[1], ids[2]].sort());
  assert.deepEqual((await ver(`?assigned=${other.id}`)).body.applications.map((a: any) => a.id), [ids[0]]);
  assert.equal((await other.get(`/api/admin/programmes/${pid}/applications?assigned=me`)).body.applications.length, 1);
  assert.deepEqual((await ver(`?q=${encodeURIComponent(people[1].name)}`)).body.applications.map((a: any) => a.id), [ids[1]]);
  const first = (await ver('?limit=2')).body;
  assert.equal(first.applications.length, 2);
  assert.equal(first.page.total, 3);
  assert.equal(first.page.has_more, true);
  assert.equal((await ver('?limit=2&offset=2')).body.applications.length, 1);

  // Timeline: what the applicant may see, in order, with the reason they were given.
  assert.equal((await coord.post(`/api/admin/programme-applications/${ids[1]}/decide`, { decision: 'start_review' })).status, 200);
  assert.equal((await coord.post(`/api/admin/programme-applications/${ids[1]}/decide`, { decision: 'more_info', reason: 'Please describe your team in more detail.' })).status, 200);
  assert.equal((await people[1].post(`/api/programme-applications/${ids[1]}/resubmit`, { answers: { why: 'Here is much more detail about our team.' } })).status, 200);
  assert.equal((await coord.post(`/api/admin/programme-applications/${ids[1]}/decide`, { decision: 'accept', reason: 'Welcome to the cohort.' })).status, 200);
  const tl = (await people[1].get('/api/programme-applications/mine')).body.applications[0].timeline;
  assert.deepEqual(tl.map((t: any) => t.label), ['Application submitted', 'Review started', 'More information requested', 'Application resubmitted', 'Accepted']);
  assert.equal(tl[2].note, 'Please describe your team in more detail.');
  assert.equal(tl[4].note, 'Welcome to the cohort.');
});

test('funding recommendation: internal to staff, bounded, and optionally separated from the final decision', async () => {
  const { officer, id: oppId } = await openOpportunity();
  const { owner, ventureId } = await submittedVenture();
  const appId = await submitFunding(oppId, owner, ventureId, 300000);
  const rec = (c: Client, body: Record<string, unknown>) => c.post(`/api/admin/funding/applications/${appId}/recommend`, body);

  assert.equal((await rec(officer, { recommendation: 'approve', recommended_amount: 200000, note: 'Too early to recommend this.' })).status, 409, 'only while it is being reviewed');
  await startEvaluation(officer, appId);
  assert.equal((await rec(owner, { recommendation: 'approve', recommended_amount: 200000, note: 'I recommend my own venture.' })).status, 403);
  assert.equal((await rec(officer, { recommendation: 'maybe', note: 'Not a valid recommendation.' })).status, 422);
  assert.equal((await rec(officer, { recommendation: 'approve', note: 'Missing the amount entirely.' })).status, 422);
  assert.equal((await rec(officer, { recommendation: 'approve', recommended_amount: 900000, note: 'More than was requested here.' })).status, 422);
  assert.equal((await rec(officer, { recommendation: 'approve', recommended_amount: 50000, note: 'Below the minimum award size.' })).status, 422);
  assert.equal((await rec(officer, { recommendation: 'approve', recommended_amount: 250000, note: 'x' })).status, 422);
  assert.equal((await rec(officer, { recommendation: 'approve', recommended_amount: 250000, note: 'Solid traction; fund most of the equipment.' })).status, 200);
  assert.equal(audits('funding.recommended').length, 1);

  const staffView = (await officer.get(`/api/admin/funding/applications/${appId}`)).body.application;
  assert.deepEqual([staffView.recommendation, staffView.recommended_amount, staffView.recommender], ['approve', 250000, officer.name]);
  const applicantView = (await owner.get(`/api/funding/applications/${appId}`)).body.application;
  for (const k of ['recommendation', 'recommended_amount', 'recommendation_note', 'recommended_by', 'assigned_to', 'assignee', 'recommender']) assert.ok(!(k in applicantView), `${k} is hidden from the applicant`);
  assert.ok(!JSON.stringify(applicantView).includes('Solid traction'));
  assert.ok(!JSON.stringify((await owner.get('/api/funding/applications/mine')).body).includes('Solid traction'));

  // Default: the recommender may also decide. With the setting on, a different officer must.
  const admin = await staff('super_admin');
  assert.equal((await admin.put('/api/admin/config', { key: 'funding_recommender_must_differ', value: 1, confirm_password: PASSWORD })).status, 200);
  assert.equal((await officer.post(`/api/admin/funding/applications/${appId}/decide`, { decision: 'approve', reason: 'Approving my own recommendation.', approved_amount: 250000 })).status, 403);
  const second = await staff('funding_officer');
  assert.equal((await second.post(`/api/admin/funding/applications/${appId}/decide`, { decision: 'approve', reason: 'Independent check agrees.', approved_amount: 250000 })).status, 200);

  // And with the setting off, the same officer may do both.
  assert.equal((await admin.put('/api/admin/config', { key: 'funding_recommender_must_differ', value: 0, confirm_password: PASSWORD })).status, 200);
  const owner2 = await submittedVenture();
  const app2 = await submitFunding(oppId, owner2.owner, owner2.ventureId, 200000);
  await startEvaluation(officer, app2);
  assert.equal((await officer.post(`/api/admin/funding/applications/${app2}/recommend`, { recommendation: 'reject', note: 'Not ready for funding yet.' })).status, 200);
  assert.equal((await officer.post(`/api/admin/funding/applications/${app2}/decide`, { decision: 'reject', reason: 'Not ready for funding yet.' })).status, 200);
  q.run("DELETE FROM system_config WHERE key = 'funding_recommender_must_differ'");
});

test('funding queue: assignment, filters and paging; assignment is hidden from applicants', async () => {
  const { officer, id: oppId } = await openOpportunity();
  const ids: string[] = [];
  const owners: Client[] = [];
  for (let n = 0; n < 3; n++) {
    const v = await submittedVenture();
    owners.push(v.owner);
    ids.push(await submitFunding(oppId, v.owner, v.ventureId, 200000 + n * 10000));
  }
  const reviewer = await staff('funding_officer');
  assert.equal((await officer.post(`/api/admin/funding/applications/${ids[0]}/assign`, { assignee_id: reviewer.id })).status, 200);
  const list = (path: string) => officer.get(`/api/admin/funding/applications${path}`);
  assert.deepEqual((await list(`?opportunity_id=${oppId}&assigned=${reviewer.id}`)).body.applications.map((a: any) => a.id), [ids[0]]);
  assert.equal((await list(`?opportunity_id=${oppId}&assigned=none`)).body.applications.length, 2);
  assert.equal((await reviewer.get(`/api/admin/funding/applications?opportunity_id=${oppId}&assigned=me`)).body.applications.length, 1);
  const page = (await list(`?opportunity_id=${oppId}&limit=2`)).body;
  assert.deepEqual([page.applications.length, page.page.total, page.page.has_more], [2, 3, true]);
  assert.equal((await list('?q=Greenfield')).body.applications.length >= 3, true, 'search matches the venture name');
  assert.equal((await list('?q=%25')).body.applications.length, 0, 'wildcards are literal');
  assert.ok(!JSON.stringify((await owners[0].get('/api/funding/applications/mine')).body).includes(reviewer.name));
  assert.ok(!('assigned_to' in (await owners[0].get(`/api/funding/applications/${ids[0]}`)).body.application));
});

test('milestones: priority defaults to normal, can be set and changed, and rejects unknown values', async () => {
  const owner = await verified('student');
  const ventureId = await ventureFor(owner);
  const make = (body: Record<string, unknown>) => owner.post(`/api/ventures/${ventureId}/milestones`, { title: 'Register the business', ...body });
  const a = await make({});
  const b = await make({ priority: 'high' });
  assert.equal((await make({ priority: 'urgent' })).status, 422);
  const get = async () => (await owner.get(`/api/ventures/${ventureId}/milestones`)).body.milestones;
  assert.equal((await get()).find((m: any) => m.id === a.body.id).priority, 'normal');
  assert.equal((await get()).find((m: any) => m.id === b.body.id).priority, 'high');
  assert.equal((await owner.patch(`/api/milestones/${a.body.id}`, { priority: 'low' })).status, 200);
  assert.equal((await owner.patch(`/api/milestones/${a.body.id}`, { priority: 'nope' })).status, 422);
  assert.equal((await get()).find((m: any) => m.id === a.body.id).priority, 'low');
  assert.equal((await (await signup('student')).patch(`/api/milestones/${a.body.id}`, { priority: 'high' })).status, 404);
});
