// Administration portal pages: the operational overview, role requests (member and administrator sides), mentoring oversight.
// Every number shown here is computed on the server for the viewer's own permissions; this file only displays it.
import { h, raw, esc, GET, POST, fld, notice, badge, label, empty, table, fmtDate, fmtDateTime, toast } from './lib.js';
import { state, route, view, forms, actions, refresh, can, isStaff } from './core.js';
import { form, stepUp, pager, keep, docLabel } from './shared.js';

// =====================================================================
// Overview
// =====================================================================
const TONES = { attention: 'attention', info: 'info' };
route('/admin', async () => {
  const o = await GET('/api/admin/overview');
  const card = (c) => h`<a class="card tile ${TONES[c.tone] ?? ''}" href="${c.link}"><div class="kpi">${c.value}</div><div class="kpi-label">${c.label}</div>${c.hint ? h`<div class="small muted">${c.hint}</div>` : ''}</a>`;
  const mineKinds = { programme_applications: ['/admin/programmes', 'Programme applications'], funding_applications: ['/admin/funding?assigned=me', 'Funding requests'], support: ['/admin/support?assigned=me', 'Support tickets'] };
  const mine = Object.entries(o.mine).filter(([k]) => mineKinds[k]);
  return view('Administration overview', h`
    <p class="muted">Figures cover only the areas your role manages. Items count as overdue after ${o.overdue_days} days; an administrator can change that in Settings.</p>
    ${mine.length ? h`<section class="card mt"><h2>Assigned to me</h2><div class="grid cols-3">${mine.map(([k, n]) => h`<a class="card tile" href="#${mineKinds[k][0]}"><div class="kpi">${n}</div><div class="kpi-label">${mineKinds[k][1]}</div></a>`)}</div></section>` : ''}
    ${o.cards.length ? h`<h2 class="mt">What needs attention</h2><div class="grid cols-3">${o.cards.map(card)}</div>` : notice('info', 'Your role has no review queues. Use the menu for the areas you can open.')}
    ${o.workload.length ? h`<section class="card mt"><h2>Who is carrying what</h2><p class="small muted">Open items assigned to each person, for the areas you manage.</p>${table([{ label: 'Person', key: 'name' }, { label: 'Programme applications', render: (r) => r.programme_applications }, { label: 'Funding requests', render: (r) => r.funding_applications }, { label: 'Support tickets', render: (r) => r.support }], o.workload)}</section>` : ''}
    ${o.delivery ? h`<section class="card mt"><h2>Email delivery</h2>${notice(o.delivery.email_delivery_configured ? 'ok' : 'warn', o.delivery.note)}
      ${Object.keys(o.delivery.by_status).length ? h`<p class="mt small">${Object.entries(o.delivery.by_status).map(([k, v]) => h`<span class="badge">${label(k)}: ${v}</span> `)}</p>` : ''}</section>` : ''}
    <p class="small muted mt">Generated ${fmtDateTime(o.generated_at)}.</p>`);
}, { perm: 'portal.admin' });

// =====================================================================
// Role requests: member side
// =====================================================================
route('/role-requests', async () => {
  const [r, docs] = await Promise.all([GET('/api/role-requests/mine'), GET('/api/documents/mine')]);
  const files = docs.documents.filter((d) => d.scan_status !== 'quarantined');
  return view('Request a staff role', h`
    ${notice('info', 'A request never grants anything by itself. An administrator reviews it, and approving a role needs their password confirmation. Administrator roles can only be approved by a super administrator.')}
    <section class="card mt"><h2>New request</h2>
      ${r.requestable.length ? form('role-request', h`${fld('role', 'Role you are asking for', { type: 'select', required: true, blank: 'Choose…', options: r.requestable.map((x) => [x, label(x)]) })}
        ${fld('organisation', 'Organisation (optional)', { max: 200 })}${fld('justification', 'Why do you need this role?', { type: 'textarea', required: true, max: 2000, hint: 'At least 20 characters. Say what you will do with it.' })}
        ${files.length ? fld('evidence_document_id', 'Supporting file (optional)', { type: 'select', blank: 'None', options: files.map((d) => [d.id, `${docLabel(d.category)} — ${d.original_name}`]) }) : ''}`, 'Send request') : notice('ok', 'You already hold every role that can be requested.')}</section>
    <h2 class="mt">Your requests</h2>
    ${table([{ label: 'Role', render: (x) => label(x.role) }, { label: 'Status', render: (x) => badge(x.status) }, { label: 'Sent', render: (x) => fmtDate(x.created_at) }, { label: 'Decision note', render: (x) => x.decision_reason ?? '—' },
      { label: '', render: (x) => (x.status === 'pending' ? h`<button class="btn secondary small" type="button" data-action="rr-withdraw" data-id="${x.id}" data-confirm="Withdraw this request?">Withdraw</button>` : '') }], r.requests, 'You have not asked for a role.')}`);
}, {});
forms['role-request'] = async (d) => { await POST('/api/role-requests', d); await refresh(); toast('Request sent. You will be notified of the decision.', 'ok'); };
actions['rr-withdraw'] = async (el) => { await POST(`/api/role-requests/${el.dataset.id}/withdraw`); await refresh(); toast('Withdrawn.', 'ok'); };

// =====================================================================
// Role requests: administrator side
// =====================================================================
route('/admin/role-requests', async ({ query }) => {
  const status = query.get('status') ?? 'pending';
  const qs = keep(query, ['q', 'offset']);
  qs.set('status', status);
  const r = await GET(`/api/admin/role-requests?${qs}`);
  const decidable = (x) => x.status === 'pending' && x.user_id !== state.user.id;
  return view('Role requests', h`
    <form data-form="filter" data-path="/admin/role-requests" class="filters" role="search">${fld('status', 'Status', { type: 'select', value: status, options: [['pending', 'Waiting'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['withdrawn', 'Withdrawn'], ['all', 'All']] })}${fld('q', 'Name or email', { value: query.get('q') })}<button class="btn secondary" type="submit">Filter</button></form>
    ${r.requests.length ? r.requests.map((x) => h`<article class="card mb"><div class="row between"><strong>${x.full_name}</strong><span class="row">${badge(x.status)}<span class="badge info">${label(x.role)}</span></span></div>
      <p class="small muted">${x.email} · ${label(x.category)} · identity ${label(x.verification_status)} · sent ${fmtDate(x.created_at)}${x.organisation ? ' · ' + x.organisation : ''}</p>
      <p class="pre">${x.justification}</p>${x.evidence_document_id ? h`<p class="small"><a href="/api/documents/${x.evidence_document_id}/download">Supporting file</a> (opening it is logged)</p>` : ''}
      ${x.decision_reason ? h`<p class="small"><em>Decision: ${x.decision_reason}</em></p>` : ''}
      ${x.status === 'pending' && x.user_id === state.user.id ? notice('warn', 'You cannot decide your own request.') : ''}
      ${decidable(x) ? form('role-decide', h`<div class="grid cols-2">${fld('decision', 'Decision', { type: 'select', required: true, blank: 'Choose…', options: [['approve', 'Approve — grants the role'], ['reject', 'Reject']] })}${fld('reason', 'Reason (the person sees this)', { required: true, max: 1000, hint: 'At least 5 characters.' })}</div>${stepUp('Needed to approve. Rejecting does not need it.')}`, 'Record decision', { id: x.id }) : ''}</article>`) : empty('No requests match.')}
    ${pager(r.page, '/admin/role-requests', query)}`);
}, { perm: 'user.manage' });
forms['role-decide'] = async (d, f) => { await POST(`/api/admin/role-requests/${f.dataset.id}/decide`, d); await refresh(); toast('Decision recorded.', 'ok'); };

// =====================================================================
// Mentoring oversight
// =====================================================================
route('/admin/mentoring', async ({ query }) => {
  const status = query.get('status') ?? 'all';
  const qs = keep(query, ['offset']);
  qs.set('status', status);
  const [m, c] = await Promise.all([GET(`/api/admin/mentoring?${qs}`), GET('/api/admin/mentoring/conflicts?status=open')]);
  return view('Mentoring oversight', h`
    <section class="card"><h2>Open conflict reports <span class="badge ${c.conflicts.length ? 'warn' : 'ok'}">${c.page.total}</span></h2>
      <p class="small muted">A report is private to the person who raised it. You cannot resolve a report about a mentorship you belong to.</p>
      ${c.conflicts.length ? c.conflicts.map((k) => h`<article class="card mb"><div class="row between"><strong>${k.mentee} with ${k.mentor}</strong>${badge(k.mentorship_status)}</div>
        <p class="small muted">Reported by ${k.reported_by} on ${fmtDate(k.created_at)}</p><p class="pre">${k.reason}</p>
        ${form('conflict-resolve', h`<div class="grid cols-2">${fld('outcome', 'Outcome', { type: 'select', required: true, blank: 'Choose…', options: [['no_action', 'No action needed'], ['end_mentorship', 'End the mentorship']] })}${fld('resolution', 'What was decided and why', { required: true, max: 2000, hint: 'At least 10 characters. The reporter sees this.' })}</div>`, 'Resolve report', { id: k.id })}</article>`) : empty('No open reports.')}
      ${pager(c.page, '/admin/mentoring', new URLSearchParams())}</section>
    <section class="card mt"><h2>Mentor workload</h2>${table([{ label: 'Mentor', key: 'full_name' }, { label: 'Active', render: (x) => `${x.active} of ${x.capacity}` }, { label: 'Pending', key: 'pending' }, { label: 'Sessions held', key: 'sessions_completed' }, { label: 'No-shows', key: 'sessions_missed' }], m.mentors, 'No approved mentors yet.')}</section>
    <h2 class="mt">Mentorships</h2>
    <form data-form="filter" data-path="/admin/mentoring" class="filters">${fld('status', 'Status', { type: 'select', value: status, options: ['all', 'pending', 'accepted', 'declined', 'cancelled', 'completed'].map((x) => [x, label(x)]) })}<button class="btn secondary" type="submit">Filter</button></form>
    ${table([{ label: 'Mentee', key: 'mentee' }, { label: 'Mentor', key: 'mentor' }, { label: 'Status', render: (x) => badge(x.status) }, { label: 'Started', render: (x) => fmtDate(x.created_at) }, { label: 'Sessions held', key: 'sessions_completed' }, { label: 'No-shows', key: 'sessions_missed' }, { label: 'Open reports', render: (x) => (x.open_conflicts ? badge('overdue') : '—') }], m.requests, 'No mentorships match.')}
    ${pager(m.page, '/admin/mentoring', query)}`);
}, { perm: 'mentor.review' });
forms['conflict-resolve'] = async (d, f) => { await POST(`/api/admin/mentoring/conflicts/${f.dataset.id}/resolve`, d); await refresh(); toast('Report resolved.', 'ok'); };
