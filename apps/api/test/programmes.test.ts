import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PDF, audits, closeApp, q, signup, staff, verified, ventureFor } from './helpers.ts';

after(closeApp);
const future = (days: number, hours = 0) => new Date(Date.now() + days * 86400_000 + hours * 3600_000).toISOString();

test('ventures: unverified users are blocked, drafts must be complete, reviewers cannot touch drafts', async () => {
  assert.equal((await (await signup('student')).post('/api/ventures', { name: 'Nope' })).status, 403);
  const owner = await verified('student');
  const created = await owner.post('/api/ventures', { name: 'Skeleton Co' });
  const id = created.body.id;
  const incomplete = await owner.post(`/api/ventures/${id}/submit`);
  assert.equal(incomplete.status, 422);
  assert.ok(incomplete.body.error.details.problem);

  const mgr = await staff('incubation_manager');
  assert.equal((await mgr.get(`/api/ventures/${id}`)).status, 404, 'drafts are private to the team');
  assert.equal((await (await verified('student')).get(`/api/ventures/${id}`)).status, 404);

  assert.equal((await owner.patch(`/api/ventures/${id}`, { description: 'Custom tailoring for freelancers.', problem: 'Slow turnaround.', solution: 'Same-day studio.', target_market: 'Freelancers', value_proposition: 'Fast and fair.', industry: 'fashion', role: 'admin', status: 'incubating' })).status, 200);
  assert.equal(q.get<any>('SELECT status FROM ventures WHERE id = ?', id)!.status, 'draft', 'status cannot be set directly');
  assert.equal((await owner.post(`/api/ventures/${id}/submit`)).status, 200);
  assert.equal((await owner.patch(`/api/ventures/${id}`, { name: 'Edited While In Review' })).status, 409, 'locked while under review');
  assert.equal((await owner.post(`/api/ventures/${id}/submit`)).status, 409);
});

test('venture review: conflict of interest, valid transitions only, team is notified', async () => {
  const owner = await verified('student');
  const id = await ventureFor(owner);
  await owner.post(`/api/ventures/${id}/submit`);
  const mgr = await staff('incubation_manager');
  assert.equal((await mgr.post(`/api/admin/ventures/${id}/review`, { decision: 'graduate' })).status, 409);
  assert.equal((await mgr.post(`/api/admin/ventures/${id}/review`, { decision: 'reject' })).status, 422, 'reasons are mandatory');
  assert.equal((await owner.post(`/api/admin/ventures/${id}/review`, { decision: 'approve' })).status, 403);

  assert.equal((await mgr.post(`/api/admin/ventures/${id}/review`, { decision: 'request_changes', reason: 'Please add market size evidence.' })).status, 200);
  assert.equal((await owner.patch(`/api/ventures/${id}`, { risks: 'Regulatory approval timelines.' })).status, 200, 'editable again');
  assert.equal((await owner.post(`/api/ventures/${id}/submit`)).status, 200);
  assert.equal((await mgr.post(`/api/admin/ventures/${id}/review`, { decision: 'approve' })).status, 200);
  assert.equal((await mgr.post(`/api/admin/ventures/${id}/review`, { decision: 'approve' })).status, 409);
  assert.equal((await mgr.post(`/api/admin/ventures/${id}/review`, { decision: 'graduate' })).status, 200);
  const notes = (await owner.get('/api/notifications')).body.notifications;
  assert.ok(notes.some((n: any) => /changes requested/i.test(n.title)) && notes.some((n: any) => /graduated/i.test(n.title)));

  // A reviewer who is also a member is blocked.
  const mgrVenture = await ventureFor(mgr, 'Staff Side Project');
  await mgr.post(`/api/ventures/${mgrVenture}/submit`);
  const admin = await staff('admin');
  assert.equal((await mgr.post(`/api/admin/ventures/${mgrVenture}/review`, { decision: 'approve' })).status, 403);
  assert.equal((await admin.post(`/api/admin/ventures/${mgrVenture}/review`, { decision: 'approve' })).status, 200);
});

test('venture teams: only the owner manages members; only verified accounts can be added', async () => {
  const owner = await verified('student');
  const teammate = await verified('student');
  const unverified = await signup('student');
  const id = await ventureFor(owner);
  assert.equal((await owner.post(`/api/ventures/${id}/members`, { email: unverified.email })).status, 404);
  assert.equal((await owner.post(`/api/ventures/${id}/members`, { email: teammate.email, title: 'CTO' })).status, 201);
  assert.equal((await owner.post(`/api/ventures/${id}/members`, { email: teammate.email })).status, 409);
  assert.equal((await teammate.post(`/api/ventures/${id}/members`, { email: unverified.email })).status, 403);
  assert.equal((await teammate.get(`/api/ventures/${id}`)).status, 200);
  assert.equal((await owner.del(`/api/ventures/${id}/members/${owner.id}`)).status, 409, 'owner cannot be removed');
  assert.equal((await teammate.del(`/api/ventures/${id}/members/${owner.id}`)).status, 409);
  assert.equal((await teammate.del(`/api/ventures/${id}/members/${teammate.id}`)).status, 200, 'members may leave');
  assert.equal((await teammate.get(`/api/ventures/${id}`)).status, 404);
});

async function publishedProgramme(capacity = 2, extra: Record<string, unknown> = {}) {
  const coord = await staff('programme_coordinator');
  const created = await coord.post('/api/admin/programmes', {
    title: 'Venture Accelerator Cohort', description: 'Twelve weeks.', capacity, eligible_categories: ['student', 'alumni'],
    questions: [{ id: 'why', label: 'Why do you want to join?', required: true }, { id: 'extra', label: 'Anything else?', required: false }], ...extra,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal((await coord.post(`/api/admin/programmes/${created.body.id}/publish`)).status, 200);
  return { coord, id: created.body.id as string };
}

test('programme application: eligibility, window, required answers/documents and one application per person', async () => {
  const { id } = await publishedProgramme(5, { required_documents: ['business_registration'] });
  const student = await verified('student');
  const outsider = await verified('external_participant');
  assert.equal((await (await signup('student')).get('/api/programmes')).status, 403);
  const list = await student.get('/api/programmes');
  const p = list.body.programmes.find((x: any) => x.id === id);
  assert.equal(p.eligible, true);
  assert.equal(p.seats_left, 5);
  assert.equal((await outsider.get('/api/programmes')).body.programmes.find((x: any) => x.id === id).eligible, false);
  assert.equal((await outsider.post(`/api/programmes/${id}/apply`, { answers: { why: 'Because.' } })).status, 403);

  const noDoc = await student.post(`/api/programmes/${id}/apply`, { answers: { why: 'I want to grow my business.' } });
  assert.equal(noDoc.status, 422);
  await student.upload('business_registration', PDF, 'cac.pdf');
  const noAnswer = await student.post(`/api/programmes/${id}/apply`, { answers: { extra: 'x' } });
  assert.equal(noAnswer.status, 422);
  assert.ok(noAnswer.body.error.details.why);
  assert.equal((await student.post(`/api/programmes/${id}/apply`, { answers: { why: 'I want to grow my business.' } })).status, 201);
  assert.equal((await student.post(`/api/programmes/${id}/apply`, { answers: { why: 'Again.' } })).status, 409);
  assert.equal((await student.get('/api/programme-applications/mine')).body.applications.length, 1);

  const closed = await publishedProgramme(5, { opens_at: future(5), closes_at: future(10) });
  assert.equal((await student.post(`/api/programmes/${closed.id}/apply`, { answers: { why: 'Early bird.' } })).status, 409, 'window not open yet');
});

test('programme seats are never over-allocated, even when decided in parallel; waitlist works', async () => {
  const { coord, id } = await publishedProgramme(2);
  const people = await Promise.all([1, 2, 3, 4].map(() => verified('student')));
  for (const p of people) assert.equal((await p.post(`/api/programmes/${id}/apply`, { answers: { why: 'Motivated founder.' } })).status, 201);
  const apps = q.all<any>('SELECT id, user_id FROM programme_applications WHERE programme_id = ?', id);

  const results = await Promise.all(apps.map((a) => coord.post(`/api/admin/programme-applications/${a.id}/decide`, { decision: 'accept', reason: 'Strong application.' })));
  assert.equal(results.filter((r) => r.status === 200).length, 2);
  assert.equal(results.filter((r) => r.status === 409).length, 2);
  const accepted = q.get<any>("SELECT COUNT(*) AS n FROM programme_applications WHERE programme_id = ? AND status = 'accepted'", id)!.n;
  assert.equal(accepted, 2);

  const full = (await people[0].get('/api/programmes')).body.programmes.find((p: any) => p.id === id);
  assert.equal(full.seats_left, 0);
  const rest = apps.filter((a) => q.get<any>('SELECT status FROM programme_applications WHERE id = ?', a.id)!.status === 'submitted');
  assert.equal((await coord.post(`/api/admin/programme-applications/${rest[0].id}/decide`, { decision: 'waitlist', reason: 'Programme is full.' })).status, 200);
  // Freeing a seat lets the waitlisted applicant be accepted.
  const first = apps.find((a) => q.get<any>('SELECT status FROM programme_applications WHERE id = ?', a.id)!.status === 'accepted')!;
  const winner = people.find((p) => p.id === first.user_id)!;
  assert.equal((await winner.post(`/api/programme-applications/${first.id}/withdraw`)).status, 200);
  assert.equal((await coord.post(`/api/admin/programme-applications/${rest[0].id}/decide`, { decision: 'accept', reason: 'Seat available.' })).status, 200);
  assert.ok(audits('programme_application.accept').length >= 3);
});

test('programme administration is permission-gated and applicants cannot decide on themselves', async () => {
  const { coord, id } = await publishedProgramme(3);
  const student = await verified('student');
  await student.post(`/api/programmes/${id}/apply`, { answers: { why: 'Eager to learn.' } });
  const appId = q.get<any>('SELECT id FROM programme_applications WHERE user_id = ?', student.id)!.id;
  assert.equal((await student.post(`/api/admin/programme-applications/${appId}/decide`, { decision: 'accept', reason: 'Accept me please' })).status, 403);
  assert.equal((await student.get('/api/admin/programmes')).status, 403);
  assert.equal((await student.post('/api/admin/programmes', {})).status, 403, 'permission is checked before input');
  assert.equal((await coord.post(`/api/admin/programme-applications/${appId}/decide`, { decision: 'more_info', reason: 'Tell us about your team.' })).status, 200);
  assert.equal((await student.post(`/api/programme-applications/${appId}/resubmit`, { answers: { why: 'Here is more about the team.' } })).status, 200);
  assert.equal((await student.post(`/api/programme-applications/${appId}/resubmit`, { answers: { why: 'Twice?' } })).status, 409);
  assert.equal((await coord.patch(`/api/admin/programmes/${id}`, { capacity: 0 })).status, 422);
  assert.equal((await coord.post(`/api/admin/programmes/${id}/close`)).status, 200);
  assert.equal((await coord.post(`/api/admin/programmes/${id}/close`)).status, 409);
  const late = await verified('student');
  assert.equal((await late.post(`/api/programmes/${id}/apply`, { answers: { why: 'Too late.' } })).status, 409);
});

async function workshop(capacity = 2, extra: Record<string, unknown> = {}) {
  const coord = await staff('programme_coordinator');
  const w = await coord.post('/api/admin/workshops', {
    title: 'Pitch Clinic', mode: 'online', meeting_link: 'https://meet.example.org/pitch', starts_at: future(3), ends_at: future(3, 2), capacity, ...extra,
  });
  assert.equal(w.status, 201, JSON.stringify(w.body));
  assert.equal((await coord.post(`/api/admin/workshops/${w.body.id}/publish`)).status, 200);
  return { coord, id: w.body.id as string };
}

test('workshop validation: dates, mode-specific fields, safe links', async () => {
  const coord = await staff('programme_coordinator');
  const base = { title: 'Finance 101', mode: 'online', meeting_link: 'https://meet.example.org/x', starts_at: future(2), ends_at: future(2, 2), capacity: 10 };
  assert.equal((await coord.post('/api/admin/workshops', { ...base, ends_at: future(1) })).status, 422);
  assert.equal((await coord.post('/api/admin/workshops', { ...base, meeting_link: 'javascript:alert(1)' })).status, 422);
  assert.equal((await coord.post('/api/admin/workshops', { ...base, meeting_link: undefined })).status, 422);
  assert.equal((await coord.post('/api/admin/workshops', { ...base, mode: 'in_person' })).status, 422, 'location required');
  assert.equal((await coord.post('/api/admin/workshops', { ...base, capacity: 0 })).status, 422);
  assert.equal((await coord.post('/api/admin/workshops', { ...base, mode: 'in_person', location: 'Hall A' })).status, 201);
});

test('workshop registration: capacity, waitlist promotion, overlaps, link privacy, feedback after attendance', async () => {
  const { coord, id } = await workshop(2);
  const [a, b, c] = await Promise.all([verified('student'), verified('student'), verified('student')]);

  const list = await a.get('/api/workshops');
  assert.equal(list.body.workshops.find((w: any) => w.id === id).meeting_link, null, 'link hidden before registering');
  assert.equal((await a.post(`/api/workshops/${id}/register`)).body.status, 'registered');
  assert.equal((await a.post(`/api/workshops/${id}/register`)).status, 409);
  assert.equal((await b.post(`/api/workshops/${id}/register`)).body.status, 'registered');
  assert.equal((await c.post(`/api/workshops/${id}/register`)).body.status, 'waitlisted');
  assert.equal((await a.get('/api/workshops')).body.workshops.find((w: any) => w.id === id).meeting_link, 'https://meet.example.org/pitch');
  assert.equal((await c.get('/api/workshops')).body.workshops.find((w: any) => w.id === id).meeting_link, null, 'waitlisted people do not get the link');

  assert.equal((await a.del(`/api/workshops/${id}/register`)).status, 200);
  assert.equal(q.get<any>('SELECT status FROM workshop_registrations WHERE workshop_id = ? AND user_id = ?', id, c.id)!.status, 'registered', 'waitlist promoted');
  assert.ok((await c.get('/api/notifications')).body.notifications.some((n: any) => n.title === 'A seat opened up'));

  const overlap = await workshop(5, { title: 'Overlapping Session', starts_at: future(3, 1), ends_at: future(3, 3) });
  assert.equal((await c.post(`/api/workshops/${overlap.id}/register`)).status, 409, 'overlapping registrations are refused');

  assert.equal((await c.post(`/api/workshops/${id}/feedback`, { rating: 5 })).status, 409, 'no feedback before attendance');
  assert.equal((await coord.post(`/api/admin/workshops/${id}/attendance`, { user_id: c.id, attended: true })).status, 200);
  assert.equal((await c.post(`/api/workshops/${id}/feedback`, { rating: 5, comment: 'Great' })).status, 200);
  assert.equal((await c.post(`/api/workshops/${id}/feedback`, { rating: 4 })).status, 409);
  assert.equal((await coord.post(`/api/admin/workshops/${id}/attendance`, { user_id: a.id, attended: true })).status, 404, 'cancelled registrations cannot be marked');
});

test('workshop seats are never over-allocated under parallel registration', async () => {
  const { id } = await workshop(3);
  const people = await Promise.all(Array.from({ length: 8 }, () => verified('student')));
  const results = await Promise.all(people.map((p) => p.post(`/api/workshops/${id}/register`)));
  assert.ok(results.every((r) => r.status === 201));
  const statuses = results.map((r) => r.body.status);
  assert.equal(statuses.filter((s) => s === 'registered').length, 3);
  assert.equal(statuses.filter((s) => s === 'waitlisted').length, 5);
  assert.equal(q.get<any>("SELECT COUNT(*) AS n FROM workshop_registrations WHERE workshop_id = ? AND status = 'registered'", id)!.n, 3);
});

test('cancelling a workshop notifies registrants and blocks further registration', async () => {
  const { coord, id } = await workshop(5);
  const a = await verified('student');
  await a.post(`/api/workshops/${id}/register`);
  assert.equal((await coord.post(`/api/admin/workshops/${id}/cancel`)).status, 200);
  assert.ok((await a.get('/api/notifications')).body.notifications.some((n: any) => n.title === 'Workshop cancelled'));
  assert.equal((await (await verified('student')).post(`/api/workshops/${id}/register`)).status, 404);
  assert.equal((await coord.patch(`/api/admin/workshops/${id}`, { title: 'Renamed' })).status, 409);
});
