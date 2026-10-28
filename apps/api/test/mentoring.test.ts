import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, audits, closeApp, mentorOf, q, staff, verified } from './helpers.ts';

after(closeApp);
const GOALS = 'I want help validating pricing for my first customers.';
const past = (hours = 2) => new Date(Date.now() - hours * 3600_000).toISOString();
const future = (days = 2) => new Date(Date.now() + days * 86400_000).toISOString();

async function activeMentorship() {
  const mentor = await mentorOf();
  const mentee = await verified('student');
  const r = await mentee.post('/api/mentorship/requests', { mentor_id: mentor.id, goals: GOALS });
  assert.equal(r.status, 201);
  assert.equal((await mentor.post(`/api/mentorship/requests/${r.body.id}/respond`, { decision: 'accept' })).status, 200);
  return { mentor, mentee, id: r.body.id as string };
}

test('sessions: schedule, reschedule, cancel and complete with attendance, by the right people', async () => {
  const { mentor, mentee, id } = await activeMentorship();
  const outsider = await verified('student');

  const planned = await mentee.post(`/api/mentorship/requests/${id}/sessions`, { scheduled_at: future(3), notes: 'Pricing call' });
  assert.equal(planned.status, 201);
  assert.equal(planned.body.status, 'scheduled');
  assert.ok((await mentor.get('/api/notifications')).body.notifications.some((n: any) => /session scheduled/i.test(n.title)));
  const sid = planned.body.id;

  assert.equal((await outsider.post(`/api/mentorship/sessions/${sid}/cancel`, { reason: 'Not my session at all.' })).status, 404);
  assert.equal((await mentee.post(`/api/mentorship/sessions/${sid}/cancel`, { reason: 'x' })).status, 422, 'a reason is required');
  assert.equal((await mentee.post(`/api/mentorship/sessions/${sid}/reschedule`, { scheduled_at: past() })).status, 422, 'rescheduling needs a future time');
  assert.equal((await mentee.post(`/api/mentorship/sessions/${sid}/reschedule`, { scheduled_at: future(5) })).status, 200);
  assert.equal((await mentor.post(`/api/mentorship/sessions/${sid}/complete`, { mentee_attended: true })).status, 409, 'a future session cannot be completed');
  assert.equal((await mentor.post(`/api/mentorship/sessions/${sid}/cancel`, { reason: 'I am travelling that day.' })).status, 200);
  assert.equal((await mentee.post(`/api/mentorship/sessions/${sid}/cancel`, { reason: 'Cancelling again please.' })).status, 409);
  assert.equal((await mentee.post(`/api/mentorship/sessions/${sid}/reschedule`, { scheduled_at: future(6) })).status, 409);
  const cancelled = (await mentee.get(`/api/mentorship/requests/${id}/sessions`)).body.sessions[0];
  assert.deepEqual([cancelled.status, cancelled.cancel_reason], ['cancelled', 'I am travelling that day.']);
  assert.ok((await mentee.get('/api/notifications')).body.notifications.some((n: any) => /session cancelled/i.test(n.title)));

  // A session that already took place: only the mentor records how it went.
  const done = await mentor.post(`/api/mentorship/requests/${id}/sessions`, { scheduled_at: past(1) });
  assert.equal(done.body.status, 'scheduled', 'without an outcome it is still to be recorded');
  assert.equal((await mentee.post(`/api/mentorship/sessions/${done.body.id}/complete`, { mentee_attended: true })).status, 403);
  assert.equal((await mentor.post(`/api/mentorship/sessions/${done.body.id}/complete`, {})).status, 422, 'attendance must be stated');
  assert.equal((await mentor.post(`/api/mentorship/sessions/${done.body.id}/complete`, { mentee_attended: true, outcome: 'Agreed on three price points.' })).status, 200);
  const rec = q.get<any>('SELECT status, mentee_attended, mentor_attended, outcome FROM mentorship_sessions WHERE id = ?', done.body.id)!;
  assert.deepEqual([rec.status, rec.mentee_attended, rec.mentor_attended, rec.outcome], ['completed', 1, 1, 'Agreed on three price points.']);

  const noShow = await mentor.post(`/api/mentorship/requests/${id}/sessions`, { scheduled_at: past(5) });
  assert.equal((await mentor.post(`/api/mentorship/sessions/${noShow.body.id}/complete`, { mentee_attended: false })).status, 200);
  assert.equal(q.get<any>('SELECT status FROM mentorship_sessions WHERE id = ?', noShow.body.id)!.status, 'missed');

  const recorded = await mentee.post(`/api/mentorship/requests/${id}/sessions`, { scheduled_at: past(30), outcome: 'We met and reviewed the plan.' });
  assert.equal(recorded.body.status, 'completed', 'a past session with an outcome is a record of what happened');
  assert.ok(audits('mentorship.session_cancelled').length >= 1);
});

test('action items: shared between mentor and mentee, owned by one of them, overdue is computed', async () => {
  const { mentor, mentee, id } = await activeMentorship();
  const stranger = await verified('student');
  const url = `/api/mentorship/requests/${id}/actions`;
  assert.equal((await stranger.post(url, { description: 'Not mine to add', owner_id: mentee.id })).status, 404);
  assert.equal((await mentee.post(url, { description: 'Interview five customers', owner_id: stranger.id })).status, 422, 'the owner must be one of the two');
  assert.equal((await mentee.post(url, { description: 'x', owner_id: mentee.id })).status, 422);
  const a1 = await mentor.post(url, { description: 'Interview five customers', owner_id: mentee.id, due_date: past(48) });
  assert.equal(a1.status, 201);
  assert.ok((await mentee.get('/api/notifications')).body.notifications.some((n: any) => /action item/i.test(n.title)));
  const a2 = await mentee.post(url, { description: 'Share the pricing sheet', owner_id: mentor.id, due_date: future(7) });
  const list = (await mentee.get(url)).body.actions;
  assert.equal(list.length, 2);
  assert.equal(list.find((a: any) => a.id === a1.body.id).overdue, true);
  assert.equal(list.find((a: any) => a.id === a2.body.id).overdue, false);
  assert.equal((await stranger.get(url)).status, 404);

  assert.equal((await stranger.post(`/api/mentorship/actions/${a1.body.id}/status`, { status: 'done' })).status, 404);
  assert.equal((await mentee.post(`/api/mentorship/actions/${a1.body.id}/status`, { status: 'done' })).status, 200);
  assert.equal((await mentee.post(`/api/mentorship/actions/${a1.body.id}/status`, { status: 'done' })).status, 409);
  const after = (await mentee.get(url)).body.actions.find((a: any) => a.id === a1.body.id);
  assert.deepEqual([after.status, after.overdue], ['done', false], 'finished items are not overdue');
  assert.ok(after.completed_at);
  assert.equal((await mentee.post(`/api/mentorship/actions/${a2.body.id}/status`, { status: 'done' })).status, 200, 'the person who added it may close it');
});

test('conflict reports: either party can report, a reviewer who is not involved resolves, ending a mentorship is recorded', async () => {
  const { mentor, mentee, id } = await activeMentorship();
  const upcoming = await mentor.post(`/api/mentorship/requests/${id}/sessions`, { scheduled_at: future(4) });
  const url = `/api/mentorship/requests/${id}/conflict`;
  const reviewer = await staff('incubation_manager');
  assert.equal((await mentee.post(url, { reason: 'short' })).status, 422);
  assert.equal((await (await verified('student')).post(url, { reason: 'I am not part of this mentorship.' })).status, 404);
  const rep = await mentee.post(url, { reason: 'My mentor keeps steering me towards their own company.' });
  assert.equal(rep.status, 201);
  assert.equal((await mentee.post(url, { reason: 'Reporting the very same thing again.' })).status, 409, 'one open report each');
  assert.ok((await reviewer.get('/api/notifications')).body.notifications.some((n: any) => /conflict reported/i.test(n.title)));
  assert.ok(!(await mentor.get('/api/notifications')).body.notifications.some((n: any) => /conflict reported/i.test(n.title)), 'the other party is not alerted by the report itself');
  assert.equal((await mentee.get(`/api/mentorship/requests/${id}/conflicts`)).body.conflicts.length, 1);
  assert.equal((await mentor.get(`/api/mentorship/requests/${id}/conflicts`)).body.conflicts.length, 0, 'reports are private to the reporter');

  assert.equal((await mentee.get('/api/admin/mentoring/conflicts')).status, 403);
  const open = (await reviewer.get('/api/admin/mentoring/conflicts')).body;
  assert.equal(open.conflicts[0].id, rep.body.id);
  assert.equal((await reviewer.get('/api/admin/mentoring')).body.open_conflicts, 1);

  assert.equal((await mentee.post(`/api/admin/mentoring/conflicts/${rep.body.id}/resolve`, { resolution: 'Resolving my own report.', outcome: 'no_action' })).status, 403);
  assert.equal((await reviewer.post(`/api/admin/mentoring/conflicts/${rep.body.id}/resolve`, { resolution: 'short', outcome: 'no_action' })).status, 422);
  assert.equal((await reviewer.post(`/api/admin/mentoring/conflicts/${rep.body.id}/resolve`, { resolution: 'Spoke with both people; pairing ended by mutual agreement.', outcome: 'end_mentorship' })).status, 200);
  assert.equal((await reviewer.post(`/api/admin/mentoring/conflicts/${rep.body.id}/resolve`, { resolution: 'Resolving the same report twice.', outcome: 'no_action' })).status, 409);
  assert.equal(q.get<any>('SELECT status FROM mentorship_requests WHERE id = ?', id)!.status, 'cancelled');
  assert.equal(q.get<any>('SELECT status FROM mentorship_sessions WHERE id = ?', upcoming.body.id)!.status, 'cancelled', 'planned sessions are cancelled with it');
  assert.ok((await mentee.get('/api/notifications')).body.notifications.some((n: any) => /mentorship was ended/i.test(n.title)));
  assert.ok(audits('mentorship.conflict_resolved').length >= 1);
  // Freed capacity: the mentor can take someone else again.
  assert.equal(q.get<any>("SELECT COUNT(*) AS n FROM mentorship_requests WHERE mentor_user_id = ? AND status = 'accepted'", mentor.id)!.n, 0);
});

test('mentoring oversight: workload, no-shows and filters for reviewers only', async () => {
  const { mentor, mentee, id } = await activeMentorship();
  const noShow = await mentor.post(`/api/mentorship/requests/${id}/sessions`, { scheduled_at: past(3) });
  await mentor.post(`/api/mentorship/sessions/${noShow.body.id}/complete`, { mentee_attended: false });
  const reviewer = await staff('incubation_manager');
  const view = (await reviewer.get('/api/admin/mentoring?status=accepted')).body;
  const row = view.requests.find((r: any) => r.id === id);
  assert.equal(row.sessions_missed, 1);
  const load = view.mentors.find((m: any) => m.user_id === mentor.id);
  assert.deepEqual([load.active, load.capacity, load.sessions_missed], [1, 2, 1]);
  assert.equal((await reviewer.get('/api/admin/mentoring?status=bogus')).status, 422);
  assert.equal((await mentee.get('/api/admin/mentoring')).status, 403);
  assert.equal((await new Client().get('/api/admin/mentoring')).status, 401);
});
