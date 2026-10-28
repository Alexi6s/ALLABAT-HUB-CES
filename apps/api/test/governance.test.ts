import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PDF, audits, closeApp, forceVerified, mentorOf, q, signup, staff, verified, ventureFor } from './helpers.ts';

after(closeApp);

const APPLICATION = {
  organization: 'Acme', position: 'Director', bio: 'Fifteen years building and scaling fintech and agritech companies across West Africa.',
  expertise: ['marketing', 'finance'], industries: ['fintech'], venture_stages: ['idea', 'validation'], languages: ['English'], meeting_formats: ['online'],
  timezone: 'Africa/Lagos', availability: 'Weekday evenings', capacity: 2, references_text: 'Available on request', coc_accepted: true, conflict_declaration: 'None',
};

async function applicantWithDocs() {
  const a = await signup('mentor_applicant');
  assert.equal((await a.upload('mentor_credential', PDF, 'cv.pdf')).status, 201);
  return a;
}

test('mentor application: incomplete submissions are refused, complete ones enter review', async () => {
  const a = await applicantWithDocs();
  assert.equal((await a.post('/api/mentor/application/submit')).status, 404, 'nothing saved yet');
  assert.equal((await a.put('/api/mentor/application', { ...APPLICATION, coc_accepted: false, bio: 'Too short' })).status, 200, 'drafts may be incomplete');
  const incomplete = await a.post('/api/mentor/application/submit');
  assert.equal(incomplete.status, 422);
  assert.ok(incomplete.body.error.details.bio && incomplete.body.error.details.coc_accepted);
  assert.equal((await a.put('/api/mentor/application', APPLICATION)).status, 200);
  assert.equal((await a.post('/api/mentor/application/submit')).status, 200);
  assert.equal((await a.put('/api/mentor/application', APPLICATION)).status, 409, 'locked while under review');

  const mgr = await staff('incubation_manager');
  const queue = await mgr.get('/api/admin/mentor-applications?status=submitted');
  assert.ok(queue.body.applications.length >= 1);
  assert.equal((await a.get('/api/admin/mentor-applications')).status, 403);
});

test('mentor approval needs a verified applicant, a different reviewer, and the configured number of approvals', async () => {
  const a = await applicantWithDocs();
  await a.put('/api/mentor/application', APPLICATION);
  await a.post('/api/mentor/application/submit');
  const appId = q.get<any>('SELECT id FROM mentor_applications WHERE user_id = ?', a.id)!.id;
  const m1 = await staff('incubation_manager');
  const m2 = await staff('incubation_manager');

  const early = await m1.post(`/api/admin/mentor-applications/${appId}/review`, { decision: 'approve', notes: 'Strong profile.' });
  assert.equal(early.status, 409, 'applicant is not identity-verified yet');
  forceVerified(a);

  q.run("INSERT INTO system_config(key,value,updated_at) VALUES ('mentor_approvals_required','2',?)", new Date().toISOString());
  const first = await m1.post(`/api/admin/mentor-applications/${appId}/review`, { decision: 'approve', notes: 'Strong profile.' });
  assert.equal(first.status, 200);
  assert.equal(q.get<any>('SELECT status FROM mentor_applications WHERE id = ?', appId)!.status, 'under_review');
  assert.deepEqual((await a.get('/api/auth/me')).body.user.roles.filter((r: string) => r === 'mentor'), [], 'one approval is not enough');
  assert.equal((await m1.post(`/api/admin/mentor-applications/${appId}/review`, { decision: 'approve', notes: 'Approving again.' })).status, 409, 'same reviewer cannot count twice');
  assert.equal((await m2.post(`/api/admin/mentor-applications/${appId}/review`, { decision: 'approve', notes: 'Agreed, approve.' })).status, 200);
  assert.equal(q.get<any>('SELECT status FROM mentor_applications WHERE id = ?', appId)!.status, 'approved');
  assert.ok((await a.get('/api/auth/me')).body.user.roles.includes('mentor'));
  assert.ok(audits('mentor.approve').length >= 2);
  q.run("DELETE FROM system_config WHERE key = 'mentor_approvals_required'");
});

test('reviewers cannot review themselves or after recusal; invalid transitions are refused', async () => {
  const mgr = await staff('incubation_manager');
  q.run(`INSERT INTO mentor_applications(id,user_id,status,created_at,updated_at,submitted_at) VALUES ('self-app',?,?,?,?,?)`, mgr.id, 'submitted', new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  assert.equal((await mgr.post('/api/admin/mentor-applications/self-app/review', { decision: 'approve', notes: 'I approve me.' })).status, 403);

  const a = await applicantWithDocs();
  await a.put('/api/mentor/application', APPLICATION);
  await a.post('/api/mentor/application/submit');
  const appId = q.get<any>('SELECT id FROM mentor_applications WHERE user_id = ?', a.id)!.id;
  const rev = await staff('incubation_manager');
  assert.equal((await rev.post(`/api/admin/mentor-applications/${appId}/review`, { decision: 'recuse', notes: 'Former colleague of applicant.' })).status, 200);
  assert.equal((await rev.post(`/api/admin/mentor-applications/${appId}/review`, { decision: 'approve', notes: 'Looks fine to me.' })).status, 403);
  assert.equal((await mgr.post(`/api/admin/mentor-applications/${appId}/review`, { decision: 'suspend', notes: 'Not approved yet.' })).status, 409);
  assert.equal((await mgr.post(`/api/admin/mentor-applications/${appId}/review`, { decision: 'reject' })).status, 422, 'notes are mandatory');
  assert.equal((await mgr.post(`/api/admin/mentor-applications/${appId}/review`, { decision: 'more_info', notes: 'Please add a reference letter.' })).status, 200);
  assert.equal(q.get<any>('SELECT status FROM mentor_applications WHERE id = ?', appId)!.status, 'more_info_required');
});

test('directory and recommendations are for verified members, explain themselves, and respect capacity', async () => {
  const mentor = await mentorOf();
  const founder = await verified('student');
  const ventureId = await ventureFor(founder, 'Payhive', { industry: 'fintech', stage: 'idea' });

  assert.equal((await (await signup('student')).get('/api/mentors')).status, 403);
  const dir = await founder.get('/api/mentors?expertise=finance');
  assert.equal(dir.status, 200);
  const card = dir.body.mentors.find((m: any) => m.mentor_id === mentor.id);
  assert.ok(card);
  assert.ok(!('email' in card) && !('user_id' in card), 'directory does not expose contact details');
  assert.equal(card.open_slots, 2);
  assert.equal((await founder.get('/api/mentors?expertise=astrophysics')).body.mentors.length, 0);

  const rec = await founder.get(`/api/mentorship/recommendations?venture_id=${ventureId}&areas=finance`);
  const hit = rec.body.recommendations.find((m: any) => m.mentor_id === mentor.id);
  assert.ok(hit && hit.score >= 6);
  assert.ok(hit.reasons.some((r: string) => /industry/i.test(r)) && hit.reasons.some((r: string) => /finance/.test(r)));
  assert.match(rec.body.note, /must still accept/i);
  const strangerVenture = await (await verified('student')).post('/api/ventures', { name: 'Other' });
  assert.equal((await founder.get(`/api/mentorship/recommendations?venture_id=${strangerVenture.body.id}`)).status, 404, 'cannot use someone else\'s venture');
});

test('mentorship lifecycle: consent, capacity, sessions, feedback, privacy', async () => {
  const mentor = await mentorOf(); // capacity 2
  const [m1, m2, m3] = await Promise.all([verified('student'), verified('student'), verified('alumni')]);
  const goals = 'I want help validating pricing for my first customers.';

  const short = await m1.post('/api/mentorship/requests', { mentor_id: mentor.id, goals: 'help' });
  assert.equal(short.status, 422);
  const r1 = await m1.post('/api/mentorship/requests', { mentor_id: mentor.id, goals });
  const r2 = await m2.post('/api/mentorship/requests', { mentor_id: mentor.id, goals });
  const r3 = await m3.post('/api/mentorship/requests', { mentor_id: mentor.id, goals });
  assert.equal(r1.status, 201);
  assert.equal((await m1.post('/api/mentorship/requests', { mentor_id: mentor.id, goals })).status, 409, 'duplicate active request');
  assert.equal((await m1.post('/api/mentorship/requests', { mentor_id: m1.id, goals })).status, 400);

  assert.equal((await m2.post(`/api/mentorship/requests/${r1.body.id}/respond`, { decision: 'accept' })).status, 404, 'other mentees cannot see it');
  assert.equal((await m1.post(`/api/mentorship/requests/${r1.body.id}/respond`, { decision: 'accept' })).status, 403, 'only the mentor can respond');
  assert.equal((await mentor.post(`/api/mentorship/requests/${r1.body.id}/respond`, { decision: 'accept' })).status, 200);
  assert.equal((await mentor.post(`/api/mentorship/requests/${r1.body.id}/respond`, { decision: 'decline' })).status, 409, 'already answered');
  assert.equal((await mentor.post(`/api/mentorship/requests/${r2.body.id}/respond`, { decision: 'accept' })).status, 200);
  assert.equal((await mentor.post(`/api/mentorship/requests/${r3.body.id}/respond`, { decision: 'accept' })).status, 409, 'capacity of 2 is enforced');
  assert.equal((await mentor.post(`/api/mentorship/requests/${r3.body.id}/respond`, { decision: 'decline', note: 'At capacity.' })).status, 200);

  const when = new Date(Date.now() + 86400_000).toISOString();
  assert.equal((await m1.post(`/api/mentorship/requests/${r1.body.id}/sessions`, { scheduled_at: when, notes: 'Intro call' })).status, 201);
  assert.equal((await m3.post(`/api/mentorship/requests/${r1.body.id}/sessions`, { scheduled_at: when })).status, 404);
  assert.equal((await m1.get(`/api/mentorship/requests/${r1.body.id}/sessions`)).body.sessions.length, 1);
  assert.equal((await m3.get(`/api/mentorship/requests/${r1.body.id}/sessions`)).status, 404);

  assert.equal((await m1.post(`/api/mentorship/requests/${r1.body.id}/feedback`, { rating: 6 })).status, 422);
  assert.equal((await m1.post(`/api/mentorship/requests/${r1.body.id}/feedback`, { rating: 5, comment: 'Very useful.' })).status, 201);
  assert.equal((await m1.post(`/api/mentorship/requests/${r1.body.id}/feedback`, { rating: 4 })).status, 409);
  assert.equal((await m1.post(`/api/mentorship/requests/${r1.body.id}/complete`)).status, 403, 'only the mentor closes it');
  assert.equal((await mentor.post(`/api/mentorship/requests/${r1.body.id}/complete`)).status, 200);

  const mine = await m1.get('/api/mentorship/requests');
  assert.equal(mine.body.requests.length, 1);
  assert.equal(mine.body.requests[0].as, 'mentee');
  assert.equal((await mentor.get('/api/mentorship/requests')).body.requests.length, 3);
});

test('capacity is enforced under parallel acceptance', async () => {
  const mentor = await mentorOf();
  q.run('UPDATE mentor_applications SET capacity = 1 WHERE user_id = ?', mentor.id);
  const mentees = await Promise.all([verified('student'), verified('student'), verified('student')]);
  const ids: string[] = [];
  for (const m of mentees) ids.push((await m.post('/api/mentorship/requests', { mentor_id: mentor.id, goals: 'I need guidance on go-to-market strategy.' })).body.id);
  const results = await Promise.all(ids.map((id) => mentor.post(`/api/mentorship/requests/${id}/respond`, { decision: 'accept' })));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 2);
  assert.equal(q.get<any>("SELECT COUNT(*) AS n FROM mentorship_requests WHERE mentor_user_id = ? AND status = 'accepted'", mentor.id)!.n, 1);
});

test('a mentor cannot mentor a venture they belong to; suspension removes the role and cancels pending requests', async () => {
  const mentor = await mentorOf();
  const founder = await verified('student');
  const ventureId = await ventureFor(founder);
  await founder.post(`/api/ventures/${ventureId}/members`, { email: mentor.email, title: 'Advisor' });
  const conflictRes = await founder.post('/api/mentorship/requests', { mentor_id: mentor.id, venture_id: ventureId, goals: 'I want my own advisor to mentor my venture.' });
  assert.equal(conflictRes.status, 400, 'conflict of interest');

  const other = await verified('student');
  const req = await other.post('/api/mentorship/requests', { mentor_id: mentor.id, goals: 'I would like regular guidance on pricing.' });
  const mgr = await staff('incubation_manager');
  const appId = q.get<any>('SELECT id FROM mentor_applications WHERE user_id = ?', mentor.id)!.id;
  assert.equal((await mgr.post(`/api/admin/mentor-applications/${appId}/review`, { decision: 'suspend', notes: 'Code of conduct complaint under review.' })).status, 200);
  assert.ok(!(await mentor.get('/api/auth/me')).body.user.roles.includes('mentor'));
  assert.equal(q.get<any>('SELECT status FROM mentorship_requests WHERE id = ?', req.body.id)!.status, 'cancelled');
  assert.equal((await other.get(`/api/mentors/${mentor.id}`)).status, 404, 'suspended mentors disappear from the directory');
  assert.equal((await mentor.post(`/api/mentorship/requests/${req.body.id}/respond`, { decision: 'accept' })).status, 409);
});

test('withdrawing a mentor application removes the role and pending requests', async () => {
  const mentor = await mentorOf();
  const mentee = await verified('student');
  const req = await mentee.post('/api/mentorship/requests', { mentor_id: mentor.id, goals: 'Looking for guidance on fundraising basics.' });
  assert.equal((await mentor.post('/api/mentor/application/withdraw')).status, 200);
  assert.ok(!(await mentor.get('/api/auth/me')).body.user.roles.includes('mentor'));
  assert.equal(q.get<any>('SELECT status FROM mentorship_requests WHERE id = ?', req.body.id)!.status, 'cancelled');
});
