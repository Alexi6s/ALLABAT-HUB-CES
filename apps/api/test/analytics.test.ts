// Trends, turnaround and workload are checked against hand-made records with known dates, so the expected numbers are exact.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, closeApp, q, signup, staff, verified } from './helpers.ts';

after(closeApp);
const at = (d: string) => `${d}T10:00:00.000Z`;
const range = '?from=2020-01-01&to=2020-03-31';
const range2 = '?from=2021-01-01&to=2021-03-31'; // a separate period so tests in this file do not share records
const series = (body: any, key: string) => body.trends.find((t: any) => t.key === key);

async function usersOn(day: string, n: number) {
  for (let i = 0; i < n; i++) q.run('UPDATE users SET created_at = ? WHERE id = ?', at(day), (await signup('student')).id);
}

test('trends: monthly counts match the records exactly, and the period is respected', async () => {
  await usersOn('2020-01-15', 6);
  await usersOn('2020-02-10', 2);
  await usersOn('2019-12-31', 3); // just outside
  await usersOn('2020-04-01', 4); // just outside
  const admin = await staff('admin');
  q.run('UPDATE users SET created_at = ? WHERE id = ?', '2030-01-01T00:00:00.000Z', admin.id);
  const r = (await admin.get(`/api/reports/analytics${range}`)).body;
  assert.deepEqual(r.months, ['2020-01', '2020-02', '2020-03']);
  assert.deepEqual(r.range, { from: '2020-01-01', to: '2020-03-31' });
  assert.deepEqual(series(r, 'registrations').values, [6, 2, 0]);
  assert.equal(series(r, 'registrations').total, 8);
  assert.equal(series(r, 'registrations').link, '#/admin/users', 'each series links to where the work is done');
  assert.equal(r.suppression, 'none');

  // Inclusive end date: a record on the last day counts, the next day does not.
  const lastDay = (await admin.get('/api/reports/analytics?from=2020-01-15&to=2020-01-15')).body;
  assert.deepEqual(lastDay.months, ['2020-01']);
  assert.equal(series(lastDay, 'registrations').total, 6);
});

test('trends: viewers with suppressed counts never see a cell below five, and the other series count the right things', async () => {
  const admin = await staff('admin');
  const partner = await verified('partner');
  const exact = (await admin.get(`/api/reports/analytics${range2}`)).body;
  assert.deepEqual(series(exact, 'registrations').values, [0, 0, 0], 'nothing in this period yet');
  for (const [day, n] of [['2021-01-20', 6], ['2021-02-20', 2]] as const) {
    for (let i = 0; i < n; i++) q.run('UPDATE users SET created_at = ? WHERE id = ?', at(day), (await signup('student')).id);
  }
  const again = (await partner.get(`/api/reports/analytics${range2}`)).body;
  assert.deepEqual(series(again, 'registrations').values, [6, null, 0], 'February has only two people, so it is hidden; zero stays zero');
  assert.equal(series(again, 'registrations').total, 8, 'the total is large enough to show');
  assert.match(again.suppression, /hidden/);
  assert.equal(again.workload, null, 'names of reviewers are for staff only');
  assert.equal(again.turnaround.length, 0, 'operational queues are not shown to partners');
  assert.equal(series(again, 'registrations').link, null, 'no link to pages the viewer cannot open');
  assert.deepEqual(series((await admin.get(`/api/reports/analytics${range2}`)).body, 'registrations').values, [6, 2, 0], 'staff with exact counts see February');

  // Other series use the right date column and status.
  const owner = await verified('student');
  const ventureId = (await owner.post('/api/ventures', { name: 'Trend Co' })).body.id;
  const ms = [1, 2, 3].map((d) => ({ id: `m${d}`, day: `2021-02-0${d}` }));
  for (const m of ms) q.run("INSERT INTO milestones(id,venture_id,title,status,evidence_type,completed_at,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)", m.id, ventureId, m.id, 'completed', 'verified', at(m.day), owner.id, at(m.day), at(m.day));
  q.run("INSERT INTO milestones(id,venture_id,title,status,evidence_type,completed_at,created_by,created_at,updated_at) VALUES ('self','" + ventureId + "','self','completed','self_reported',?,?,?,?)", at('2021-02-04'), owner.id, at('2021-02-04'), at('2021-02-04'));
  const reviewer = await staff('incubation_manager');
  const m = (await reviewer.get(`/api/reports/analytics${range2}`)).body;
  assert.deepEqual(series(m, 'milestones_completed').values, [0, 3, 0], 'only reviewer-verified completions are counted');
});

test('turnaround: averages and medians come from decided items inside the period', async () => {
  const admin = await staff('admin');
  const people = [await signup('student'), await signup('student'), await signup('student')];
  const days = [2, 4, 9]; // 2,4,9 days to decide -> average 5, median 4
  for (const [i, p] of people.entries()) {
    const start = new Date(Date.UTC(2020, 1, 1 + i));
    const end = new Date(start.getTime() + days[i] * 864e5);
    q.run("INSERT INTO verification_requests(id,user_id,category,status,snapshot,reviewer_id,created_at,decided_at) VALUES (?,?,?,?,?,?,?,?)", `vr${i}`, p.id, 'student', 'approved', '{}', admin.id, start.toISOString(), end.toISOString());
  }
  q.run("INSERT INTO verification_requests(id,user_id,category,status,snapshot,created_at) VALUES ('open1',?,?,?,?,?)", people[0].id, 'student', 'submitted', '{}', at('2020-02-05'));
  q.run("INSERT INTO verification_requests(id,user_id,category,status,snapshot,reviewer_id,created_at,decided_at) VALUES ('old',?,?,?,?,?,?,?)", people[1].id, 'student', 'approved', '{}', admin.id, at('2019-06-01'), at('2019-06-30'));

  const r = (await admin.get(`/api/reports/analytics${range}`)).body;
  const v = r.turnaround.find((t: any) => t.key === 'verification');
  assert.deepEqual([v.decided, v.average_days, v.median_days], [3, 5, 4], 'open and out-of-period items are excluded');
  assert.equal(v.link, '#/admin/verification');
  const w = r.workload.find((x: any) => x.user_id === admin.id);
  assert.equal(w.verification, 3, 'workload counts decisions made in the period, by the person who made them (the 2019 one is outside)');
  assert.ok(r.workload.every((x: any) => typeof x.name === 'string'));

  // A reviewer with narrower permissions sees only the queues they work on. Support officers hold no report permission at all.
  const funder = await staff('funding_officer');
  const rf = (await funder.get(`/api/reports/analytics${range}`)).body;
  assert.deepEqual(rf.turnaround.map((t: any) => t.key), ['funding_applications']);
  assert.equal((await (await staff('support_officer')).get(`/api/reports/analytics${range}`)).status, 403);
});

test('workload and support turnaround use the right people and timestamps', async () => {
  const admin = await staff('admin');
  const agentA = await staff('support_officer');
  const user = await signup('student');
  for (const [n, who] of [[1, agentA.id], [2, agentA.id]] as const) {
    q.run("INSERT INTO support_requests(id,user_id,subject,message,status,responder_id,created_at,updated_at,resolved_at) VALUES (?,?,?,?,?,?,?,?,?)", `st${n}`, user.id, `s${n}`, 'm', 'resolved', who, at('2020-03-01'), at('2020-03-03'), at(`2020-03-0${2 + n}`));
  }
  const r = (await admin.get(`/api/reports/analytics${range}`)).body;
  const sup = r.turnaround.find((t: any) => t.key === 'support_tickets');
  assert.deepEqual([sup.decided, sup.average_days], [2, 2.5], 'resolved after 2 and 3 days');
  assert.equal(r.workload.find((x: any) => x.user_id === agentA.id).support, 2);
});

test('analytics: input is validated and the endpoint is for report viewers only', async () => {
  const admin = await staff('admin');
  assert.equal((await admin.get('/api/reports/analytics?from=banana')).status, 422);
  assert.equal((await admin.get('/api/reports/analytics?from=2020-02-30x')).status, 422);
  assert.equal((await admin.get('/api/reports/analytics?from=2020-05-01&to=2020-04-01')).status, 422);
  assert.equal((await admin.get('/api/reports/analytics?from=2010-01-01&to=2020-01-01')).status, 422, 'at most 36 months');
  assert.equal((await admin.get('/api/reports/analytics')).status, 200, 'the default period needs no input');
  assert.equal((await (await verified('student')).get(`/api/reports/analytics${range}`)).status, 403);
  assert.equal((await new Client().get(`/api/reports/analytics${range}`)).status, 401);
});
