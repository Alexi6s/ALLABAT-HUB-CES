import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, PASSWORD, audits, closeApp, q, signup, staff, verified, ventureFor } from './helpers.ts';

after(closeApp);

const card = (body: any, key: string) => body.cards.find((c: any) => c.key === key);
const old = (days: number) => new Date(Date.now() - days * 864e5).toISOString();

async function programmeWith(applicants: number) {
  const coord = await staff('programme_coordinator');
  const created = await coord.post('/api/admin/programmes', {
    title: 'Cohort A', description: 'Twelve weeks.', capacity: 20, eligible_categories: ['student'],
    questions: [{ id: 'why', label: 'Why?', required: true }],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal((await coord.post(`/api/admin/programmes/${created.body.id}/publish`)).status, 200);
  const people: Client[] = [];
  const appIds: string[] = [];
  for (let i = 0; i < applicants; i++) {
    const s = await verified('student');
    assert.equal((await s.post(`/api/programmes/${created.body.id}/apply`, { answers: { why: 'To grow my business.' } })).status, 201);
    people.push(s);
    appIds.push(q.get<any>('SELECT id FROM programme_applications WHERE user_id = ?', s.id)!.id);
  }
  return { coord, people, appIds, programmeId: created.body.id as string };
}

test('overview: only staff, and each person sees figures only for the areas they hold a permission for', async () => {
  const student = await verified('student');
  assert.equal((await student.get('/api/admin/overview')).status, 403);
  assert.equal((await new Client().get('/api/admin/overview')).status, 401);

  await programmeWith(2);
  const support = await signup('student');
  assert.equal((await support.post('/api/support', { subject: 'Cannot log in', message: 'I never receive the confirmation message.' })).status, 201);

  const officer = await staff('support_officer');
  const o = (await officer.get('/api/admin/overview')).body;
  assert.ok(card(o, 'support_open'), 'support officer sees support figures');
  assert.equal(card(o, 'programme_open'), undefined, 'but not programme figures');
  assert.equal(card(o, 'funding_open'), undefined, 'or funding figures');
  assert.equal(card(o, 'users_total'), undefined, 'or the user count');
  assert.equal(o.delivery, undefined, 'or email delivery state');
  assert.ok(o.generated_at);

  const coord = await staff('programme_coordinator');
  const c = (await coord.get('/api/admin/overview')).body;
  assert.equal(card(c, 'programme_open').value, 2);
  assert.equal(card(c, 'programme_unassigned').value, 2);
  assert.equal(card(c, 'support_open'), undefined);

  const admin = await staff('admin');
  const a = (await admin.get('/api/admin/overview')).body;
  assert.ok(a.cards.length >= 10, 'an administrator sees every area');
  assert.equal(a.delivery.email_delivery_configured, false);
  assert.match(a.delivery.note, /No email provider/);
  assert.ok(card(a, 'users_total').value >= 5);
});

test('overview: overdue counts use the configured number of days', async () => {
  const { coord, appIds } = await programmeWith(2);
  q.run('UPDATE programme_applications SET submitted_at = ? WHERE id = ?', old(30), appIds[0]);
  const before = card((await coord.get('/api/admin/overview')).body, 'programme_overdue').value;
  assert.ok(before >= 1);
  const owner = await staff('super_admin');
  assert.equal((await owner.put('/api/admin/config', { key: 'review_overdue_days', value: 60, confirm_password: PASSWORD })).status, 200);
  const after60 = card((await coord.get('/api/admin/overview')).body, 'programme_overdue').value;
  assert.ok(after60 < before, 'a longer allowance means fewer overdue items');
  q.run("DELETE FROM system_config WHERE key = 'review_overdue_days'");
});

test('assignment: only a reviewer who may review it, never the applicant, with notification, audit and workload', async () => {
  const { coord, people, appIds } = await programmeWith(3);
  const reviewer = await staff('programme_coordinator');
  const supportOnly = await staff('support_officer');

  // Permission is checked before the body is read.
  assert.equal((await supportOnly.post(`/api/admin/programme-applications/${appIds[0]}/assign`, { assignee_id: reviewer.id })).status, 403);
  assert.equal((await people[0].post(`/api/admin/programme-applications/${appIds[0]}/assign`, { assignee_id: reviewer.id })).status, 403);

  // The assignee must hold the reviewing permission and an active account.
  assert.equal((await coord.post(`/api/admin/programme-applications/${appIds[0]}/assign`, { assignee_id: supportOnly.id })).status, 422);
  assert.equal((await coord.post(`/api/admin/programme-applications/${appIds[0]}/assign`, { assignee_id: people[0].id })).status, 422);
  assert.equal((await coord.post(`/api/admin/programme-applications/${appIds[0]}/assign`, { assignee_id: 'no-such-user' })).status, 422);
  const suspended = await staff('programme_coordinator');
  q.run("UPDATE users SET account_status = 'suspended' WHERE id = ?", suspended.id);
  assert.equal((await coord.post(`/api/admin/programme-applications/${appIds[0]}/assign`, { assignee_id: suspended.id })).status, 422);

  // A staff member who is themselves the applicant cannot be given their own application.
  const selfStaff = await staff('programme_coordinator');
  q.run('UPDATE programme_applications SET user_id = ? WHERE id = ?', selfStaff.id, appIds[2]);
  assert.equal((await coord.post(`/api/admin/programme-applications/${appIds[2]}/assign`, { assignee_id: selfStaff.id })).status, 409);
  q.run('UPDATE programme_applications SET user_id = ? WHERE id = ?', people[2].id, appIds[2]);

  assert.equal((await coord.post(`/api/admin/programme-applications/${appIds[0]}/assign`, { assignee_id: reviewer.id })).status, 200);
  assert.equal(q.get<any>('SELECT assigned_to FROM programme_applications WHERE id = ?', appIds[0])!.assigned_to, reviewer.id);
  assert.ok(audits('assignment.set').some((a) => a.entity_id === appIds[0]));
  assert.ok((await reviewer.get('/api/notifications')).body.notifications.some((n: any) => /assigned to you/i.test(n.title)));

  const overview = (await coord.get('/api/admin/overview')).body;
  assert.ok(overview.workload.find((w: any) => w.user_id === reviewer.id).programme_applications >= 1);
  const mine = (await reviewer.get('/api/admin/overview')).body.mine;
  assert.equal(mine.programme_applications, 1);

  // Clearing an assignment is allowed and audited; a decided application can no longer be assigned.
  assert.equal((await coord.post(`/api/admin/programme-applications/${appIds[0]}/assign`, {})).status, 200);
  assert.equal(q.get<any>('SELECT assigned_to FROM programme_applications WHERE id = ?', appIds[0])!.assigned_to, null);
  assert.ok(audits('assignment.cleared').length >= 1);
  assert.equal((await coord.post(`/api/admin/programme-applications/${appIds[1]}/decide`, { decision: 'reject', reason: 'Not a fit this round.' })).status, 200);
  assert.equal((await coord.post(`/api/admin/programme-applications/${appIds[1]}/assign`, { assignee_id: reviewer.id })).status, 409);
  assert.equal((await coord.post('/api/admin/programme-applications/missing/assign', { assignee_id: reviewer.id })).status, 404);
});

test('assignment: funding reviewers must not be members of the applying venture; support tickets can be assigned', async () => {
  const officer = await staff('funding_officer');
  const opp = await officer.post('/api/admin/funding/opportunities', {
    title: 'Seed', description: 'Grant.', currency: 'NGN', min_amount: 100000, max_amount: 500000, total_budget: 900000,
    eligible_categories: ['student'], criteria: 'Traction.', conditions: 'Reports.',
  });
  assert.equal((await officer.post(`/api/admin/funding/opportunities/${opp.body.id}/open`)).status, 200);
  const owner = await verified('student');
  const ventureId = await ventureFor(owner);
  assert.equal((await owner.post(`/api/ventures/${ventureId}/submit`)).status, 200);
  const app = await owner.post(`/api/funding/opportunities/${opp.body.id}/applications`, {
    venture_id: ventureId, requested_amount: 200000, justification: 'We need equipment to scale production to forty customers.', use_of_funds: 'Equipment.',
    budget_items: [{ label: 'Equipment', amount: 200000 }],
  });
  assert.equal(app.status, 201, JSON.stringify(app.body));
  assert.equal((await owner.post(`/api/funding/applications/${app.body.id}/submit`)).status, 200);

  const conflicted = await staff('funding_officer');
  q.run("INSERT INTO venture_members(venture_id,user_id,member_role,added_at) VALUES (?,?,'member',?)", ventureId, conflicted.id, new Date().toISOString());
  const url = `/api/admin/funding/applications/${app.body.id}/assign`;
  assert.equal((await officer.post(url, { assignee_id: conflicted.id })).status, 409, 'a venture member cannot review its grant');
  const programmeOnly = await staff('programme_coordinator');
  assert.equal((await officer.post(url, { assignee_id: programmeOnly.id })).status, 422, 'assignee must hold funding.review');
  const other = await staff('funding_officer');
  assert.equal((await officer.post(url, { assignee_id: other.id })).status, 200);
  assert.equal((await programmeOnly.post(url, { assignee_id: other.id })).status, 403);

  const user = await signup('student');
  const ticket = await user.post('/api/support', { subject: 'Question about grants', message: 'Who can apply for the seed grant this year?' });
  const agent = await staff('support_officer');
  const manager = await staff('support_officer');
  assert.equal((await agent.post(`/api/admin/support/${ticket.body.id}/assign`, { assignee_id: manager.id })).status, 200);
  assert.equal(q.get<any>('SELECT assigned_to FROM support_requests WHERE id = ?', ticket.body.id)!.assigned_to, manager.id);
  assert.equal((await agent.post(`/api/admin/support/${ticket.body.id}/assign`, { assignee_id: user.id })).status, 422, 'the requester is not support staff');
});

test('bulk assignment: needs confirmation, is capped, and changes everything or nothing', async () => {
  const { coord, appIds, people } = await programmeWith(4);
  const reviewer = await staff('programme_coordinator');
  const base = { kind: 'programme_application', assignee_id: reviewer.id };
  assert.equal((await people[0].post('/api/admin/bulk/assign', { ...base, ids: [appIds[0]], confirm: true })).status, 403);
  assert.equal((await coord.post('/api/admin/bulk/assign', { ...base, ids: [appIds[0]] })).status, 422, 'confirmation is required');
  assert.equal((await coord.post('/api/admin/bulk/assign', { ...base, ids: [], confirm: true })).status, 422);
  assert.equal((await coord.post('/api/admin/bulk/assign', { ...base, ids: Array.from({ length: 51 }, (_, i) => `x${i}`), confirm: true })).status, 422, 'at most 50 at a time');
  assert.equal((await coord.post('/api/admin/bulk/assign', { ...base, kind: 'funding_application', ids: [appIds[0]], confirm: true })).status, 403, 'kind-specific permission applies');

  // One bad id must roll back all of the others.
  const res = await coord.post('/api/admin/bulk/assign', { ...base, ids: [appIds[0], appIds[1], 'missing-id'], confirm: true });
  assert.equal(res.status, 404);
  assert.match(res.body.error.message, /Nothing was changed/);
  assert.equal(q.get<any>(`SELECT COUNT(*) AS n FROM programme_applications WHERE id IN (${appIds.map(() => '?').join(',')}) AND assigned_to IS NOT NULL`, ...appIds)!.n, 0);

  const ok = await coord.post('/api/admin/bulk/assign', { ...base, ids: [appIds[0], appIds[1], appIds[1], appIds[2]], confirm: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.changed, 3, 'duplicates are collapsed');
  assert.equal(q.get<any>('SELECT COUNT(*) AS n FROM programme_applications WHERE assigned_to = ?', reviewer.id)!.n, 3);
  assert.equal(audits('bulk.assign').length, 1);
});

test('staff directory: lists only active people who hold the requested permission', async () => {
  const coord = await staff('programme_coordinator');
  const second = await staff('programme_coordinator');
  q.run("UPDATE users SET account_status = 'suspended' WHERE id = ?", second.id);
  const list = (await coord.get('/api/admin/staff?permission=programme.manage')).body.staff;
  assert.ok(list.some((s: any) => s.id === coord.id));
  assert.ok(!list.some((s: any) => s.id === second.id), 'suspended staff are not offered');
  assert.ok(list.every((s: any) => s.roles.length > 0));
  assert.equal((await coord.get('/api/admin/staff?permission=nope.nope')).status, 422);
  assert.equal((await (await verified('student')).get('/api/admin/staff')).status, 403);
  assert.ok(!JSON.stringify(list).includes('@'), 'no email addresses in the picker');
});

test('role requests: verified people ask, a different administrator decides with their password, nothing is self-granted', async () => {
  const unverified = await signup('student');
  assert.equal((await unverified.post('/api/role-requests', { role: 'support_officer', justification: 'I would like to help answer member questions.' })).status, 403);

  const admin = await staff('admin'); // exists before the request so it is notified
  const person = await verified('alumni');
  const bad = await person.post('/api/role-requests', { role: 'super_admin', justification: 'Give me everything please, I deserve it.' });
  assert.equal(bad.status, 422, 'super_admin cannot be requested');
  assert.equal((await person.post('/api/role-requests', { role: 'support_officer', justification: 'too short' })).status, 422);
  assert.equal((await person.post('/api/role-requests', { role: 'support_officer', justification: 'I would like to help answer member questions every week.', evidence_document_id: 'not-mine' })).status, 422);

  const req = await person.post('/api/role-requests', { role: 'support_officer', organisation: 'Alumni office', justification: 'I would like to help answer member questions every week.' });
  assert.equal(req.status, 201, JSON.stringify(req.body));
  assert.equal((await person.post('/api/role-requests', { role: 'support_officer', justification: 'Submitting the same request again right now.' })).status, 409);
  assert.equal(q.get<any>('SELECT COUNT(*) AS n FROM user_roles WHERE user_id = ? AND role = ?', person.id, 'support_officer')!.n, 0, 'a request grants nothing');
  assert.equal((await person.get('/api/role-requests/mine')).body.requests.length, 1);

  assert.ok((await admin.get('/api/notifications')).body.notifications.some((n: any) => /role request/i.test(n.title)), 'administrators are told');
  assert.equal((await person.get('/api/admin/role-requests')).status, 403);
  const listed = (await admin.get('/api/admin/role-requests')).body;
  assert.ok(listed.requests.some((r: any) => r.id === req.body.id));
  assert.equal(typeof listed.page.total, 'number');
  assert.equal((await admin.get('/api/admin/role-requests?status=bogus')).status, 422);
  assert.equal((await admin.get(`/api/admin/role-requests?q=${encodeURIComponent(person.name)}`)).body.requests.length, 1);
  assert.equal((await admin.get('/api/admin/role-requests?q=%25')).body.requests.length, 0, 'wildcards in a search are literal');

  const decide = (c: Client, body: Record<string, unknown>) => c.post(`/api/admin/role-requests/${req.body.id}/decide`, body);
  assert.equal((await person.post(`/api/admin/role-requests/${req.body.id}/decide`, { decision: 'approve', reason: 'Approve myself.', confirm_password: PASSWORD })).status, 403, 'permission first');
  assert.equal((await decide(admin, { decision: 'approve', reason: 'Fits the alumni office.' })).status, 422, 'approval needs the password');
  assert.equal((await decide(admin, { decision: 'approve', reason: 'Fits the alumni office.', confirm_password: 'wrong-Password1' })).status, 403);
  assert.equal(q.get<any>('SELECT status FROM role_requests WHERE id = ?', req.body.id)!.status, 'pending');
  assert.equal((await decide(admin, { decision: 'approve', reason: 'Fits the alumni office.', confirm_password: PASSWORD })).status, 200);
  assert.equal(q.get<any>('SELECT COUNT(*) AS n FROM user_roles WHERE user_id = ? AND role = ?', person.id, 'support_officer')!.n, 1);
  assert.ok(audits('role.grant').some((a) => a.entity_id === person.id && /role_request/.test(a.details)));
  assert.ok((await person.get('/api/notifications')).body.notifications.some((n: any) => /approved/i.test(n.title)));
  assert.equal((await decide(admin, { decision: 'reject', reason: 'Too late to reject now.' })).status, 409, 'decided requests are final');
  assert.equal((await person.post(`/api/role-requests/${req.body.id}/withdraw`)).status, 409);
  assert.equal((await person.post('/api/role-requests', { role: 'support_officer', justification: 'Asking again for a role I already have.' })).status, 409);
});

test('role requests: administrator roles need a super administrator; administrators cannot decide their own; reject and withdraw work', async () => {
  const person = await verified('alumni');
  const toAdmin = await person.post('/api/role-requests', { role: 'admin', justification: 'I run the alumni office and need to administer accounts.' });
  assert.equal(toAdmin.status, 201);
  const admin = await staff('admin');
  const decide = (c: Client, id: string, body: Record<string, unknown>) => c.post(`/api/admin/role-requests/${id}/decide`, body);
  assert.equal((await decide(admin, toAdmin.body.id, { decision: 'approve', reason: 'Seems fine to me.', confirm_password: PASSWORD })).status, 403, 'a plain administrator cannot create administrators');
  const superAdmin = await staff('super_admin');
  assert.equal((await decide(superAdmin, toAdmin.body.id, { decision: 'reject', reason: 'Not needed at this time.' })).status, 200, 'rejecting needs no password');
  assert.ok((await person.get('/api/notifications')).body.notifications.some((n: any) => /not approved/i.test(n.title)));
  assert.equal(q.get<any>('SELECT COUNT(*) AS n FROM user_roles WHERE user_id = ? AND role = ?', person.id, 'admin')!.n, 0);

  // An administrator who asks for a role may not decide it.
  const second = await staff('admin');
  const own = await second.post('/api/role-requests', { role: 'support_officer', justification: 'I would also like the support officer role.' });
  assert.equal(own.status, 201);
  assert.equal((await decide(second, own.body.id, { decision: 'approve', reason: 'Approving my own request.', confirm_password: PASSWORD })).status, 403);
  assert.equal((await decide(admin, own.body.id, { decision: 'approve', reason: 'Reviewed by a colleague.', confirm_password: PASSWORD })).status, 200);

  // The requester can withdraw a pending request; it is then gone from the pending queue.
  const w = await person.post('/api/role-requests', { role: 'funding_officer', justification: 'I would like to review funding applications.' });
  assert.equal((await new Client().post(`/api/role-requests/${w.body.id}/withdraw`)).status, 401);
  assert.equal((await (await verified('alumni')).post(`/api/role-requests/${w.body.id}/withdraw`)).status, 404, 'not yours means not found');
  assert.equal((await person.post(`/api/role-requests/${w.body.id}/withdraw`)).status, 200);
  assert.ok(!(await admin.get('/api/admin/role-requests')).body.requests.some((r: any) => r.id === w.body.id));
  assert.equal((await decide(admin, w.body.id, { decision: 'approve', reason: 'Approving after withdrawal.', confirm_password: PASSWORD })).status, 409);
});

test('role requests: the requester must still be active and verified when approved', async () => {
  const person = await verified('alumni');
  const r = await person.post('/api/role-requests', { role: 'support_officer', justification: 'I would like to help answer member questions.' });
  q.run("UPDATE users SET verification_status = 'unverified' WHERE id = ?", person.id);
  const admin = await staff('admin');
  assert.equal((await admin.post(`/api/admin/role-requests/${r.body.id}/decide`, { decision: 'approve', reason: 'Looks good to me.', confirm_password: PASSWORD })).status, 409);
  assert.equal(q.get<any>('SELECT COUNT(*) AS n FROM user_roles WHERE user_id = ? AND role = ?', person.id, 'support_officer')!.n, 0);
});
