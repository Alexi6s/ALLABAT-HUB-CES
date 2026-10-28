import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, audits, closeApp, q, signup, staff, verified } from './helpers.ts';

after(closeApp);
const MSG = 'My verification upload keeps failing with a size error.';

test('support thread: requester and staff converse, internal notes stay internal, strangers see nothing', async () => {
  const a = await signup('student');
  const b = await signup('student');
  assert.equal((await a.post('/api/support', { subject: 'Hi', message: 'short' })).status, 422);
  assert.equal((await a.post('/api/support', { subject: 'Upload failing', message: MSG, category: 'nonsense' })).status, 422);
  const t = await a.post('/api/support', { subject: 'Upload failing', message: MSG, category: 'verification' });
  assert.equal(t.status, 201);
  const id = t.body.id;

  const list = (await a.get('/api/support/mine')).body;
  assert.equal(list.requests.length, 1);
  assert.equal(list.requests[0].message_count, 1);
  assert.equal(list.requests[0].category, 'verification');
  assert.equal(list.page.total, 1);
  assert.equal((await b.get(`/api/support/${id}`)).status, 404, 'other people cannot open it');
  assert.equal((await b.post(`/api/support/${id}/messages`, { body: 'I am a stranger posting here.' })).status, 404);

  const agent = await staff('support_officer');
  assert.equal((await a.get('/api/admin/support')).status, 403);
  assert.equal((await a.post(`/api/admin/support/${id}/note`, { body: 'Let me add a note.' })).status, 403);
  const shown = (await agent.get('/api/admin/support?status=open')).body.requests.find((r: any) => r.id === id);
  assert.equal(shown.assignee, null);
  assert.equal(shown.priority, 'normal');

  assert.equal((await agent.post(`/api/admin/support/${id}/note`, { body: 'Requester has uploaded three times already.' })).status, 201);
  assert.equal((await agent.post(`/api/admin/support/${id}/respond`, { response: 'Please try a PDF under 5 MB.', status: 'in_progress' })).status, 200);
  const owned = q.get<any>('SELECT assigned_to, status FROM support_requests WHERE id = ?', id)!;
  assert.equal(owned.assigned_to, agent.id, 'the first responder takes the ticket');
  assert.equal(owned.status, 'in_progress');
  assert.ok((await a.get('/api/notifications')).body.notifications.some((n: any) => n.link === `#/support/${id}`), 'the requester is linked to the thread');

  const thread = (await a.get(`/api/support/${id}`)).body;
  assert.deepEqual(thread.messages.map((m: any) => [m.kind, m.author]), [['user', 'You'], ['staff', 'Support team']]);
  assert.ok(!JSON.stringify(thread).includes('three times'), 'internal notes never reach the requester');
  assert.ok(!JSON.stringify(thread).includes(agent.name), 'staff names are not exposed');
  const staffView = (await agent.get(`/api/admin/support/${id}`)).body;
  assert.equal(staffView.messages.length, 3);
  assert.ok(staffView.messages.some((m: any) => m.kind === 'internal'));

  assert.equal((await agent.post(`/api/admin/support/${id}/respond`, { response: 'Glad that worked for you.', status: 'resolved' })).status, 200);
  assert.ok(q.get<any>('SELECT resolved_at FROM support_requests WHERE id = ?', id)!.resolved_at);
  assert.equal((await a.post(`/api/support/${id}/messages`, { body: 'It happened again today, sorry.' })).status, 201);
  const reopened = q.get<any>('SELECT status, resolved_at FROM support_requests WHERE id = ?', id)!;
  assert.deepEqual([reopened.status, reopened.resolved_at], ['open', null], 'a reply reopens a resolved ticket');
  assert.equal(audits('support.reopened').length >= 1, true);
  assert.ok((await agent.get('/api/notifications')).body.notifications.some((n: any) => /reply on a support request|reopened/i.test(n.title)), 'the assignee is told about follow-ups');
});

test('support triage: priority, category, assignment, filters, search and paging', async () => {
  const people = await Promise.all([signup('student'), signup('student'), signup('student')]);
  const ids: string[] = [];
  for (const [n, p] of people.entries()) ids.push((await p.post('/api/support', { subject: `Triage case ${n}`, message: `Describing triage case number ${n} in some detail.`, category: n === 0 ? 'funding' : 'general' })).body.id);
  const lead = await staff('support_officer');
  const other = await staff('support_officer');

  assert.equal((await lead.patch(`/api/admin/support/${ids[0]}`, {})).status, 422, 'nothing to change');
  assert.equal((await lead.patch(`/api/admin/support/${ids[0]}`, { priority: 'extreme' })).status, 422);
  assert.equal((await lead.patch(`/api/admin/support/${ids[0]}`, { priority: 'urgent' })).status, 200);
  assert.equal((await lead.patch(`/api/admin/support/${ids[1]}`, { priority: 'low', category: 'technical' })).status, 200);
  assert.ok(audits('support.triaged').length >= 2);
  assert.equal((await lead.post(`/api/admin/support/${ids[2]}/assign`, { assignee_id: other.id })).status, 200);

  const all = (await lead.get('/api/admin/support?status=all&q=triage case')).body.requests.map((r: any) => r.id);
  assert.equal(all[0], ids[0], 'urgent tickets are listed first');
  assert.equal(all[all.length - 1], ids[1], 'low priority last');
  const mineOnly = (await other.get('/api/admin/support?assigned=me')).body.requests;
  assert.deepEqual(mineOnly.map((r: any) => r.id), [ids[2]]);
  assert.ok((await lead.get('/api/admin/support?assigned=none&q=triage case')).body.requests.every((r: any) => r.assignee === null));
  assert.deepEqual((await lead.get('/api/admin/support?category=funding&q=triage case')).body.requests.map((r: any) => r.id), [ids[0]]);
  assert.deepEqual((await lead.get('/api/admin/support?priority=urgent&q=triage case')).body.requests.map((r: any) => r.id), [ids[0]]);
  assert.equal((await lead.get('/api/admin/support?q=%25')).body.requests.length, 0, 'a % in the search box is literal');
  const page = (await lead.get('/api/admin/support?status=all&q=triage case&limit=2')).body;
  assert.equal(page.requests.length, 2);
  assert.equal(page.page.total, 3);
  assert.equal(page.page.has_more, true);
  assert.equal((await lead.get('/api/admin/support?status=bogus')).status, 422);
  assert.equal((await lead.get('/api/admin/support?priority=bogus')).status, 422);
});

test('support: staff cannot answer their own ticket, suspended people can still reach support, conversations are capped', async () => {
  const worker = await staff('support_officer');
  const own = await worker.post('/api/support', { subject: 'My own ticket', message: 'I have a question about my own account.' });
  assert.equal((await worker.post(`/api/admin/support/${own.body.id}/respond`, { response: 'Answering myself here.', status: 'resolved' })).status, 403);
  assert.equal((await (await staff('support_officer')).post(`/api/admin/support/${own.body.id}/respond`, { response: 'A colleague answers this one.', status: 'resolved' })).status, 200);

  const person = await signup('student');
  const t = await person.post('/api/support', { subject: 'Why suspended', message: 'I do not understand why I was suspended.' });
  q.run("UPDATE users SET account_status = 'suspended' WHERE id = ?", person.id);
  assert.equal((await person.get('/api/support/mine')).status, 200);
  assert.equal((await person.get(`/api/support/${t.body.id}`)).status, 200);
  assert.equal((await person.post(`/api/support/${t.body.id}/messages`, { body: 'Please review my suspension.' })).status, 201);
  assert.equal((await person.get('/api/notifications')).status, 403, 'other areas stay closed');

  for (let n = 0; n < 98; n++) q.run("INSERT INTO support_messages(id,request_id,author_id,kind,body,created_at) VALUES (?,?,?,'user','filler',?)", `fill-${n}`, t.body.id, person.id, new Date().toISOString());
  assert.equal((await person.post(`/api/support/${t.body.id}/messages`, { body: 'One message too many for this thread.' })).status, 409);
  assert.equal((await person.post('/api/support', { subject: 'Another', message: 'Opening a fresh conversation instead.' })).status, 201);
});

test('support: a person cannot hold more than ten open requests', async () => {
  const p = await verified('student');
  for (let n = 0; n < 10; n++) assert.equal((await p.post('/api/support', { subject: `Open ${n}`, message: `Open request number ${n} for the limit test.` })).status, 201);
  assert.equal((await p.post('/api/support', { subject: 'Eleventh', message: 'This one should be refused politely.' })).status, 409);
  assert.equal((await new Client().post('/api/support', { subject: 'Anonymous', message: 'Not signed in at all, so refused.' })).status, 401);
});
