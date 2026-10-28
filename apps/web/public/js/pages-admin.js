// Staff pages. Every route is gated by a permission in the UI, and every endpoint re-checks it on the server.
import { h, html, raw, esc, GET, POST, PUT, PATCH, DEL, fld, notice, badge, label, empty, table, kv, fmtDate, fmtDateTime, money, toast, toInputDateTime } from './lib.js';
import { state, route, view, forms, actions, go, refresh, can } from './core.js';
import { CATEGORIES, STAGES, SUPPORT_CATEGORIES, docLabel, lines, form, stepUp, pager, keep, staffFor, assignForm, thread } from './shared.js';

const tabs = (items, active) => h`<nav class="tabs" aria-label="Sections">${items.map(([href, text]) => h`<a href="#${href}"${href === active ? raw(' aria-current="page"') : ''}>${text}</a>`)}</nav>`;
const statusFilter = (path, current, options) => h`<form data-form="filter" data-path="${path}" class="filters">${fld('status', 'Status', { type: 'select', options, value: current, blank: 'All' })}<button class="btn secondary" type="submit">Filter</button></form>`;
const docLinks = (docs) => (docs.length ? h`<ul>${docs.map((d) => h`<li><a href="/api/documents/${d.id}/download">${d.original_name}</a> — ${docLabel(d.category)} ${d.scan_status === 'quarantined' ? badge('quarantined') : ''}</li>`)}</ul>` : h`<p class="muted">No documents.</p>`);
const json = (o) => (o && typeof o === 'object' ? Object.entries(o).map(([k, v]) => `${label(k)}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('; ') : '');
const listify = (s) => (s ? s.split('\n').map((x) => x.trim()).filter(Boolean) : []);

// =====================================================================
// Verification
// =====================================================================
route('/admin/verification', async ({ query }) => {
  const status = query.get('status') ?? 'open';
  const { requests } = await GET(`/api/admin/verification?status=${encodeURIComponent(status)}`);
  return view('Verification requests', h`${statusFilter('/admin/verification', status, [['open', 'Open (needs action)'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['more_info_required', 'More info required']])}
    ${table([{ label: 'Person', render: (r) => h`<a href="#/admin/verification/${r.id}"><strong>${r.full_name}</strong></a><div class="small muted">${r.email}</div>` }, { label: 'Category', render: (r) => label(r.category) }, { label: 'Submitted', render: (r) => fmtDate(r.created_at) }, { label: 'Status', render: (r) => badge(r.status) }], requests, 'The queue is empty.')}`);
}, { perm: 'verification.review' });

route('/admin/verification/:id', async ({ params }) => {
  const { request: r, documents } = await GET(`/api/admin/verification/${params.id}`);
  const open = ['submitted', 'under_review'].includes(r.status);
  return view(r.full_name, h`
    <div class="row mb">${badge(r.status)}<span class="muted">${label(r.category)} · ${r.email} ${r.email_verified ? '' : badge('unverified')}</span></div>
    <div class="grid cols-2"><section class="card"><h2>Claimed affiliation</h2>${kv(Object.entries(r.snapshot.affiliation ?? {}).filter(([k, v]) => v && !['user_id', 'updated_at'].includes(k)).map(([k, v]) => [label(k), v]))}</section>
      <section class="card"><h2>Evidence</h2><p class="small muted">Opening a file is recorded in the audit log.</p>${docLinks(documents)}</section></div>
    ${r.decision_reason ? notice('info', h`<strong>Decision note:</strong> ${r.decision_reason}`) : ''}
    ${open ? h`<section class="card mt"><h2>Decision</h2>
      ${r.status === 'submitted' ? h`<p><button class="btn secondary" type="button" data-action="vr-claim" data-id="${r.id}">Claim for review</button></p>` : ''}
      ${form('vr-decide', h`${fld('decision', 'Decision', { type: 'select', required: true, blank: 'Choose…', options: [['approve', 'Approve — grants the member role'], ['reject', 'Reject'], ['more_info', 'Ask for more information']] })}${fld('reason', 'Reason (required unless approving)', { type: 'textarea', rows: 3, max: 1000, hint: 'The applicant will see this.' })}`, 'Record decision', { id: r.id })}</section>` : ''}`,
  { crumbs: h`<a href="#/admin/verification">Verification</a> /` });
}, { perm: 'verification.review' });
actions['vr-claim'] = async (el) => { await POST(`/api/admin/verification/${el.dataset.id}/claim`); await refresh(); toast('Claimed.', 'ok'); };
forms['vr-decide'] = async (d, f) => { await POST(`/api/admin/verification/${f.dataset.id}/decide`, d); toast('Decision recorded.', 'ok'); go('/admin/verification'); };

// =====================================================================
// Mentor applications
// =====================================================================
route('/admin/mentors', async ({ query }) => {
  const status = query.get('status') ?? '';
  const { applications } = await GET(`/api/admin/mentor-applications${status ? `?status=${status}` : ''}`);
  return view('Mentor applications', h`${statusFilter('/admin/mentors', status, ['submitted', 'under_review', 'more_info_required', 'approved', 'rejected', 'suspended', 'withdrawn'].map((s) => [s, label(s)]))}
    ${table([{ label: 'Applicant', render: (a) => h`<a href="#/admin/mentors/${a.id}"><strong>${a.full_name}</strong></a><div class="small muted">${a.email}</div>` }, { label: 'Organisation', render: (a) => [a.position, a.organization].filter(Boolean).join(', ') }, { label: 'Identity', render: (a) => badge(a.verification_status) }, { label: 'Approvals', key: 'approvals' }, { label: 'Status', render: (a) => badge(a.status) }, { label: 'Submitted', render: (a) => fmtDate(a.submitted_at) }], applications, 'No applications.')}`);
}, { perm: 'mentor.review' });

route('/admin/mentors/:id', async ({ params }) => {
  const { application: a, documents, reviews, approvals_required } = await GET(`/api/admin/mentor-applications/${params.id}`);
  return view(a.full_name, h`
    <div class="row mb">${badge(a.status)} Identity: ${badge(a.verification_status)}<span class="muted">${reviews.filter((r) => r.decision === 'approve').length} of ${approvals_required} approvals needed</span></div>
    <div class="grid cols-2"><section class="card"><h2>Application</h2>${kv([['Organisation', a.organization], ['Position', a.position], ['Biography', lines(a.bio)], ['Expertise', a.expertise.join(', ')], ['Industries', a.industries.join(', ')], ['Stages', a.venture_stages.map(label).join(', ')], ['Languages', a.languages.join(', ')], ['Formats', a.meeting_formats.map(label).join(', ')], ['Capacity', a.capacity], ['References', lines(a.references_text)], ['Conflict declaration', lines(a.conflict_declaration)], ['Code of conduct', a.coc_accepted ? 'Accepted' : 'Not accepted']])}</section>
      <section class="card"><h2>Credentials</h2><p class="small muted">Opening a file is recorded in the audit log.</p>${docLinks(documents)}<h2 class="mt">Review history</h2>${reviews.length ? h`<ul class="plain">${reviews.map((r) => h`<li class="mb"><strong>${label(r.decision)}</strong> by ${r.reviewer} <span class="small muted">${fmtDateTime(r.created_at)}</span><p class="small pre">${r.notes}</p></li>`)}</ul>` : h`<p class="muted">No reviews yet.</p>`}</section></div>
    <section class="card mt"><h2>Record a decision</h2><p class="small muted">You cannot review your own application. Approval needs a verified applicant and the configured number of distinct approvals. If you know the applicant personally, choose “recuse”.</p>
      ${form('mentor-review', h`${fld('decision', 'Decision', { type: 'select', required: true, blank: 'Choose…', options: [['approve', 'Approve'], ['reject', 'Reject'], ['more_info', 'Ask for more information'], ['suspend', 'Suspend (approved mentors)'], ['recuse', 'Recuse myself']] })}${fld('notes', 'Notes', { type: 'textarea', required: true, rows: 3, max: 2000, hint: 'Applicants may be shown these notes.' })}`, 'Record decision', { id: a.id })}</section>`,
  { crumbs: h`<a href="#/admin/mentors">Mentor applications</a> /` });
}, { perm: 'mentor.review' });
forms['mentor-review'] = async (d, f) => { await POST(`/api/admin/mentor-applications/${f.dataset.id}/review`, d); await refresh(); toast('Recorded.', 'ok'); };

// =====================================================================
// Venture & milestone reviews
// =====================================================================
route('/admin/ventures', async ({ query }) => {
  const status = query.get('status') ?? 'open';
  const { ventures } = await GET(`/api/admin/ventures?status=${encodeURIComponent(status)}`);
  return view('Venture reviews', h`${statusFilter('/admin/ventures', status, [['open', 'Open (needs action)'], ['incubating', 'Incubating'], ['changes_requested', 'Changes requested'], ['rejected', 'Rejected'], ['graduated', 'Graduated']])}
    ${table([{ label: 'Venture', render: (v) => h`<a href="#/admin/ventures/${v.id}"><strong>${v.name}</strong></a>` }, { label: 'Owner', key: 'owner' }, { label: 'Industry', key: 'industry' }, { label: 'Stage', render: (v) => label(v.stage) }, { label: 'Status', render: (v) => badge(v.status) }, { label: 'Updated', render: (v) => fmtDate(v.updated_at) }], ventures, 'Nothing to review.')}`);
}, { perm: 'venture.review' });

route('/admin/ventures/:id', async ({ params }) => {
  const [{ venture: v, members }, ms] = await Promise.all([GET(`/api/ventures/${params.id}`), GET(`/api/ventures/${params.id}/milestones`)]);
  return view(v.name, h`<div class="row mb">${badge(v.status)}<span class="muted">Stage: ${label(v.stage)} · ${v.industry ?? 'No industry'}</span></div>
    <div class="grid cols-2"><section class="card"><h2>Profile</h2>${kv([['Description', lines(v.description)], ['Problem', lines(v.problem)], ['Solution', lines(v.solution)], ['Target market', lines(v.target_market)], ['Value proposition', lines(v.value_proposition)], ['Business model', lines(v.business_model)], ['Risks', lines(v.risks)]])}</section>
      <section class="card"><h2>Team</h2>${table([{ label: 'Name', key: 'full_name' }, { label: 'Role', render: (m) => label(m.member_role) }, { label: 'Title', key: 'title' }], members)}<h2 class="mt">Milestones</h2>${table([{ label: 'Milestone', key: 'title' }, { label: 'Due', render: (m) => fmtDate(m.due_date) }, { label: 'Status', render: (m) => h`${badge(m.status)} ${m.overdue ? badge('overdue') : ''}` }], ms.milestones, 'None yet.')}</section></div>
    ${v.review_reason ? notice('info', h`<strong>Last review note:</strong> ${v.review_reason}`) : ''}
    <section class="card mt"><h2>Review decision</h2><p class="small muted">You cannot review a venture you belong to.</p>
      ${form('venture-review', h`${fld('decision', 'Decision', { type: 'select', required: true, blank: 'Choose…', options: [['start_review', 'Start review'], ['approve', 'Approve into incubation'], ['request_changes', 'Request changes'], ['reject', 'Reject'], ['graduate', 'Mark as graduated']] })}${fld('reason', 'Reason (required for changes and rejection)', { type: 'textarea', rows: 3, max: 2000, hint: 'The team will see this.' })}`, 'Record decision', { id: v.id })}</section>`,
  { crumbs: h`<a href="#/admin/ventures">Venture reviews</a> /` });
}, { perm: 'venture.review' });
forms['venture-review'] = async (d, f) => { await POST(`/api/admin/ventures/${f.dataset.id}/review`, d); await refresh(); toast('Decision recorded.', 'ok'); };

route('/admin/milestones', async ({ query }) => {
  const status = query.get('status') ?? 'submitted';
  const { milestones } = await GET(`/api/admin/milestones?status=${encodeURIComponent(status)}`);
  return view('Milestone reviews', h`${statusFilter('/admin/milestones', status, ['submitted', 'changes_requested', 'completed', 'blocked', 'in_progress'].map((s) => [s, label(s)]))}
    ${table([{ label: 'Milestone', render: (m) => h`<a href="#/admin/milestones/${m.id}"><strong>${m.title}</strong></a>` }, { label: 'Venture', key: 'venture_name' }, { label: 'Due', render: (m) => fmtDate(m.due_date) }, { label: 'Evidence', render: (m) => badge(m.evidence_type) }, { label: 'Status', render: (m) => badge(m.status) }], milestones, 'Nothing waiting for review.')}`);
}, { perm: 'milestone.review' });

route('/admin/milestones/:id', async ({ params }) => {
  const { milestone: m, venture, evidence_document: doc } = await GET(`/api/admin/milestones/${params.id}`);
  return view(m.title, h`<div class="row mb">${badge(m.status)} Evidence: ${badge(m.evidence_type)} ${m.overdue ? badge('overdue') : ''}</div>
    <section class="card">${kv([['Venture', h`<a href="#/admin/ventures/${venture.id}">${venture.name}</a>`], ['Done when', m.completion_criteria], ['Details', lines(m.description)], ['Due', fmtDate(m.due_date)], ['Evidence note', lines(m.evidence_text)], ['Evidence file', doc ? h`<a href="/api/documents/${doc.id}/download">${doc.original_name}</a> ${doc.scan_status === 'quarantined' ? badge('quarantined') : ''}` : 'None'], ['Outcome', m.outcome_metric ? `${m.outcome_metric}: ${m.outcome_value ?? '—'}` : undefined], ['Last review note', m.review_comment]])}
    <p class="small muted mt">Until you verify it, this evidence is reported as self-reported.</p></section>
    ${m.status === 'submitted' ? h`<section class="card mt"><h2>Review</h2>${form('ms-review', h`${fld('decision', 'Decision', { type: 'select', required: true, blank: 'Choose…', options: [['verify', 'Verify — mark completed'], ['request_changes', 'Request changes']] })}${fld('comment', 'Comment (required when requesting changes)', { type: 'textarea', rows: 3, max: 2000 })}`, 'Record review', { id: m.id })}</section>` : ''}`,
  { crumbs: h`<a href="#/admin/milestones">Milestone reviews</a> /` });
}, { perm: 'milestone.review' });
forms['ms-review'] = async (d, f) => { await POST(`/api/admin/milestones/${f.dataset.id}/review`, d); toast('Review recorded.', 'ok'); go('/admin/milestones'); };

// =====================================================================
// Programmes
// =====================================================================
const docCats = () => (state.meta?.document_categories ?? []).filter((c) => ['business_registration', 'identity_document', 'venture_document', 'student_id', 'staff_id', 'alumni_evidence'].includes(c)).map((c) => [c, docLabel(c)]);
const questionsText = (qs = []) => qs.map((q) => (q.required ? '' : '(optional) ') + q.label).join('\n');
const questionsFrom = (text, existing = []) => listify(text).map((line, i) => ({ id: existing[i]?.id ?? `q${i + 1}`, label: line.replace(/^\(optional\)\s*/i, ''), required: !/^\(optional\)/i.test(line) }));
const programmeFields = (p = {}) => h`${fld('title', 'Title', { value: p.title, required: true, max: 160 })}${fld('description', 'Description', { type: 'textarea', value: p.description, max: 5000 })}
  <div class="grid cols-2">${fld('capacity', 'Seats', { type: 'number', min: 1, value: p.capacity ?? 30, required: true })}${fld('opens_at', 'Applications open', { type: 'datetime-local', value: toInputDateTime(p.opens_at) })}${fld('closes_at', 'Applications close', { type: 'datetime-local', value: toInputDateTime(p.closes_at) })}</div>
  ${fld('eligible_categories', 'Eligible categories (none selected = everyone verified)', { type: 'checks', options: CATEGORIES, value: p.eligible_categories ?? [] })}
  ${fld('required_documents', 'Documents applicants must have uploaded', { type: 'checks', options: docCats(), value: p.required_documents ?? [] })}
  ${fld('questions_text', 'Application questions (one per line; start with "(optional)" to make one optional)', { type: 'textarea', rows: 4, value: questionsText(p.questions) })}`;
const programmeBody = (d, existing = []) => { const { questions_text, ...rest } = d; return { ...rest, questions: questionsFrom(questions_text, existing) }; };

route('/admin/programmes', async () => {
  const { programmes } = await GET('/api/admin/programmes');
  return view('Programmes', h`${table([{ label: 'Programme', render: (p) => h`<a href="#/admin/programmes/${p.id}"><strong>${p.title}</strong></a>` }, { label: 'Status', render: (p) => badge(p.status) }, { label: 'Seats', render: (p) => `${p.capacity - p.seats_left} / ${p.capacity}` }, { label: 'Applications', key: 'applications' }, { label: 'Window', render: (p) => `${fmtDate(p.opens_at)} – ${fmtDate(p.closes_at)}` }], programmes, 'No programmes yet.')}
    <details class="card mt"><summary><strong>Create a programme</strong></summary><div class="mt">${form('prog-create', programmeFields(), 'Create draft')}</div></details>`);
}, { perm: 'programme.manage' });
forms['prog-create'] = async (d) => { const r = await POST('/api/admin/programmes', programmeBody(d)); toast('Draft created.', 'ok'); go(`/admin/programmes/${r.id}`); };

route('/admin/programmes/:id', async ({ params, query }) => {
  const qs = keep(query, ['status', 'assigned', 'q', 'offset']);
  const [{ programme: p, applications, page }, all, staff] = await Promise.all([GET(`/api/admin/programmes/${params.id}/applications?${qs}`), GET('/api/admin/programmes'), staffFor('programme.manage')]);
  const full = all.programmes.find((x) => x.id === params.id) ?? p;
  const next = { draft: [['publish', 'Publish']], published: [['close', 'Close applications'], ['archive', 'Archive']], closed: [['publish', 'Reopen'], ['archive', 'Archive']], archived: [] }[p.status] ?? [];
  const here = `/admin/programmes/${p.id}`;
  return view(p.title, h`<div class="row mb">${badge(p.status)}<span class="muted">${p.capacity - p.seats_left} of ${p.capacity} seats taken</span>${next.map(([a, t]) => h`<button class="btn secondary" type="button" data-action="prog-state" data-id="${p.id}" data-do="${a}">${t}</button>`)}</div>
    <section class="card"><h2>Applications</h2>
      <form data-form="filter" data-path="${here}" class="filters" role="search">
        ${fld('status', 'Status', { type: 'select', blank: 'All', value: query.get('status'), options: [['open', 'Needs action'], ...['submitted', 'under_review', 'more_info_required', 'accepted', 'waitlisted', 'rejected', 'withdrawn', 'completed'].map((x) => [x, label(x)])] })}
        ${fld('assigned', 'Assigned', { type: 'select', options: [['me', 'To me'], ['none', 'Unassigned']], blank: 'Anyone', value: query.get('assigned') })}
        ${fld('q', 'Name or email', { value: query.get('q') })}<button class="btn secondary" type="submit">Filter</button></form>
      ${applications.length ? applications.map((a) => h`<article class="card mb"><div class="row between"><strong>${a.full_name}</strong><span class="row">${a.overdue ? badge('overdue') : ''}${badge(a.status)}</span></div><p class="small muted">${a.email} · ${label(a.category)}${a.venture_name ? ' · ' + a.venture_name : ''} · submitted ${fmtDate(a.submitted_at)}</p>
        <p class="small">Assigned to: <strong>${a.assignee ?? 'nobody'}</strong>${a.review_score !== null && a.review_score !== undefined ? h` · Internal score <strong>${a.review_score}/100</strong>` : ''}</p>
        ${Object.keys(a.answers).length ? kv(p.questions.map((q) => [q.label, lines(a.answers[q.id])])) : ''}${a.decision_reason ? h`<p class="small"><em>Last note to applicant: ${a.decision_reason}</em></p>` : ''}${a.review_notes ? h`<p class="small"><em>Internal notes (never shown to the applicant): ${a.review_notes}</em></p>` : ''}
        ${['completed', 'rejected', 'withdrawn'].includes(a.status) ? '' : h`<details class="mb"><summary><strong>Assign, score and note</strong></summary><div class="grid cols-2 mt"><div>${assignForm('programme', a.id, staff, a.assigned_to)}</div><div>${form('prog-review', h`${fld('score', 'Score (0 to 100)', { type: 'number', min: 0, value: a.review_score })}${fld('notes', 'Internal notes', { type: 'textarea', rows: 3, max: 3000, value: a.review_notes })}`, 'Save score and notes', { id: a.id })}</div></div></details>
          ${form('prog-decide', h`<div class="grid cols-2">${fld('decision', 'Decision', { type: 'select', required: true, blank: 'Choose…', options: [['start_review', 'Start review'], ['accept', 'Accept'], ['waitlist', 'Waitlist'], ['more_info', 'Ask for more information'], ['reject', 'Reject'], ['complete', 'Mark as completed']] })}${fld('reason', 'Reason (shown to applicant)', { max: 1000 })}</div>`, 'Record decision', { id: a.id })}`}</article>`) : empty('No applications match.')}
      ${pager(page, here, query)}</section>
    <details class="card mt"><summary><strong>Edit programme</strong></summary><div class="mt">${form('prog-edit', programmeFields(full), 'Save changes', { id: p.id })}</div></details>`,
  { crumbs: h`<a href="#/admin/programmes">Programmes</a> /` });
}, { perm: 'programme.manage' });
forms['prog-review'] = async (d, f) => { await POST(`/api/admin/programme-applications/${f.dataset.id}/review`, d); await refresh(); toast('Saved. The applicant cannot see scores or notes.', 'ok'); };
forms['prog-edit'] = async (d, f) => { const cur = (await GET(`/api/admin/programmes/${f.dataset.id}/applications`)).programme; await PATCH(`/api/admin/programmes/${f.dataset.id}`, programmeBody(d, cur.questions)); await refresh(); toast('Saved.', 'ok'); };
forms['prog-decide'] = async (d, f) => { await POST(`/api/admin/programme-applications/${f.dataset.id}/decide`, d); await refresh(); toast('Recorded.', 'ok'); };
actions['prog-state'] = async (el) => { await POST(`/api/admin/programmes/${el.dataset.id}/${el.dataset.do}`); await refresh(); toast('Updated.', 'ok'); };

// =====================================================================
// Workshops
// =====================================================================
const MODES = [['online', 'Online'], ['in_person', 'In person'], ['hybrid', 'Hybrid']];
const workshopFields = (w = {}) => h`${fld('title', 'Title', { value: w.title, required: true, max: 160 })}${fld('description', 'Description', { type: 'textarea', value: w.description, max: 5000 })}
  <div class="grid cols-2">${fld('mode', 'Mode', { type: 'select', options: MODES, value: w.mode ?? 'online', required: true })}${fld('capacity', 'Seats', { type: 'number', min: 1, value: w.capacity ?? 30, required: true })}${fld('starts_at', 'Starts', { type: 'datetime-local', value: toInputDateTime(w.starts_at), required: true })}${fld('ends_at', 'Ends', { type: 'datetime-local', value: toInputDateTime(w.ends_at), required: true })}${fld('location', 'Location (in person / hybrid)', { value: w.location, max: 200 })}${fld('meeting_link', 'Meeting link (online / hybrid)', { type: 'url', value: w.meeting_link, max: 500, hint: 'Shown only to registered participants.' })}</div>
  ${fld('eligible_categories', 'Eligible categories (none selected = everyone verified)', { type: 'checks', options: CATEGORIES, value: w.eligible_categories ?? [] })}`;

route('/admin/workshops', async () => {
  const { workshops } = await GET('/api/admin/workshops');
  return view('Workshops', h`${table([{ label: 'Workshop', render: (w) => h`<a href="#/admin/workshops/${w.id}"><strong>${w.title}</strong></a>` }, { label: 'When', render: (w) => fmtDateTime(w.starts_at) }, { label: 'Mode', render: (w) => label(w.mode) }, { label: 'Registered', render: (w) => `${w.registered} / ${w.capacity}` }, { label: 'Waitlist', key: 'waitlisted' }, { label: 'Status', render: (w) => badge(w.status) }], workshops, 'No workshops yet.')}
    <details class="card mt"><summary><strong>Create a workshop</strong></summary><div class="mt">${form('ws-create', workshopFields(), 'Create draft')}</div></details>`);
}, { perm: 'workshop.manage' });
forms['ws-create'] = async (d) => { const r = await POST('/api/admin/workshops', d); toast('Draft created.', 'ok'); go(`/admin/workshops/${r.id}`); };

route('/admin/workshops/:id', async ({ params }) => {
  const [{ workshop: w, registrations }] = await Promise.all([GET(`/api/admin/workshops/${params.id}/registrations`)]);
  const next = { draft: [['publish', 'Publish'], ['cancel', 'Cancel workshop']], published: [['complete', 'Mark completed'], ['cancel', 'Cancel workshop']] }[w.status] ?? [];
  return view(w.title, h`<div class="row mb">${badge(w.status)}<span class="muted">${fmtDateTime(w.starts_at)} · ${w.seats_left} of ${w.capacity} seats left</span>${next.map(([a, t]) => h`<button class="btn ${a === 'cancel' ? 'danger' : 'secondary'}" type="button" data-action="ws-state" data-id="${w.id}" data-do="${a}"${a === 'cancel' ? raw(' data-confirm="Cancel this workshop? Everyone registered is notified."') : ''}>${t}</button>`)}</div>
    <section class="card"><h2>Participants</h2>${table([{ label: 'Name', key: 'full_name' }, { label: 'Email', key: 'email' }, { label: 'Status', render: (r) => badge(r.status) }, { label: 'Attended', render: (r) => (r.attended === 1 ? 'Yes' : r.attended === 0 ? 'No' : '—') }, { label: 'Rating', render: (r) => r.feedback_rating ?? '—' },
      { label: 'Attendance', render: (r) => (r.status === 'registered' && !['draft', 'cancelled'].includes(w.status) ? h`<button class="btn secondary small" type="button" data-action="ws-attend" data-id="${w.id}" data-user="${r.user_id}" data-value="true">Present</button> <button class="btn secondary small" type="button" data-action="ws-attend" data-id="${w.id}" data-user="${r.user_id}" data-value="false">Absent</button>` : '') }], registrations, 'No registrations yet.')}</section>
    ${['cancelled', 'completed'].includes(w.status) ? '' : h`<details class="card mt"><summary><strong>Edit workshop</strong></summary><div class="mt">${form('ws-edit', workshopFields(w), 'Save changes', { id: w.id })}</div></details>`}`,
  { crumbs: h`<a href="#/admin/workshops">Workshops</a> /` });
}, { perm: 'workshop.manage' });
forms['ws-edit'] = async (d, f) => { await PATCH(`/api/admin/workshops/${f.dataset.id}`, d); await refresh(); toast('Saved.', 'ok'); };
actions['ws-state'] = async (el) => { await POST(`/api/admin/workshops/${el.dataset.id}/${el.dataset.do}`); await refresh(); toast('Updated.', 'ok'); };
actions['ws-attend'] = async (el) => { await POST(`/api/admin/workshops/${el.dataset.id}/attendance`, { user_id: el.dataset.user, attended: el.dataset.value === 'true' }); await refresh(); toast('Recorded.', 'ok'); };

// =====================================================================
// Funding administration
// =====================================================================
const oppFields = (o = {}) => h`${fld('title', 'Title', { value: o.title, required: true, max: 160 })}${fld('description', 'Description', { type: 'textarea', value: o.description, max: 5000 })}
  <div class="grid cols-2">${fld('currency', 'Currency (3 letters)', { value: o.currency ?? 'NGN', max: 3 })}${fld('total_budget', 'Total budget', { type: 'number', min: 1, value: o.total_budget, required: true })}${fld('min_amount', 'Minimum award', { type: 'number', min: 0, value: o.min_amount ?? 0 })}${fld('max_amount', 'Maximum award', { type: 'number', min: 1, value: o.max_amount, required: true })}${fld('opens_at', 'Opens', { type: 'datetime-local', value: toInputDateTime(o.opens_at) })}${fld('closes_at', 'Closes', { type: 'datetime-local', value: toInputDateTime(o.closes_at) })}</div>
  ${fld('criteria', 'Evaluation criteria', { type: 'textarea', rows: 3, value: o.criteria, max: 3000 })}${fld('conditions', 'Funding conditions (shown before signing the agreement)', { type: 'textarea', rows: 3, value: o.conditions, max: 3000 })}
  ${fld('eligible_categories', 'Eligible categories (none selected = everyone verified)', { type: 'checks', options: CATEGORIES, value: o.eligible_categories ?? [] })}`;

route('/admin/funding', async ({ query }) => {
  const status = query.get('status') ?? 'open';
  const qs = keep(query, ['assigned', 'q', 'offset']);
  qs.set('status', status);
  const [opps, apps] = await Promise.all([GET('/api/admin/funding/opportunities'), GET(`/api/admin/funding/applications?${qs}`)]);
  return view('Funding', h`
    <h2>Applications</h2>
    <form data-form="filter" data-path="/admin/funding" class="filters" role="search">
      ${fld('status', 'Status', { type: 'select', value: status, options: [['open', 'Open (needs action)'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['more_info_required', 'More info required'], ['completed', 'Completed']] })}
      ${fld('assigned', 'Assigned', { type: 'select', options: [['me', 'To me'], ['none', 'Unassigned']], blank: 'Anyone', value: query.get('assigned') })}
      ${fld('q', 'Venture or applicant', { value: query.get('q') })}<button class="btn secondary" type="submit">Filter</button></form>
    ${table([{ label: 'Application', render: (a) => h`<a href="#/admin/funding/applications/${a.id}"><strong>${a.venture}</strong></a> ${a.overdue ? badge('overdue') : ''}<div class="small muted">${a.opportunity}</div>` }, { label: 'Applicant', key: 'applicant' }, { label: 'Requested', render: (a) => money(a.requested_amount, a.currency) }, { label: 'Approved', render: (a) => money(a.approved_amount, a.currency) }, { label: 'Status', render: (a) => badge(a.status) }, { label: 'Assigned to', render: (a) => a.assignee ?? h`<span class="muted">Unassigned</span>` }, { label: 'Recommended', render: (a) => (a.recommendation ? label(a.recommendation) : '—') }, { label: 'Agreement', render: (a) => (a.status === 'approved' ? badge(a.agreement_status) : '—') }, { label: 'Payment', render: (a) => (a.status === 'approved' ? badge(a.disbursement_status) : '—') }], apps.applications, 'No applications match.')}
    ${pager(apps.page, '/admin/funding', query)}
    <h2 class="mt">Opportunities</h2>
    ${table([{ label: 'Opportunity', render: (o) => h`<a href="#/admin/funding/opportunities/${o.id}"><strong>${o.title}</strong></a>` }, { label: 'Status', render: (o) => badge(o.status) }, { label: 'Budget', render: (o) => money(o.total_budget, o.currency) }, { label: 'Approved so far', render: (o) => money(o.approved_total, o.currency) }, { label: 'Remaining', render: (o) => money(o.remaining_budget, o.currency) }, { label: 'Applications', key: 'applications' },
      { label: '', render: (o) => (o.status === 'draft' ? h`<button class="btn small" type="button" data-action="opp-state" data-id="${o.id}" data-do="open">Open</button>` : o.status === 'open' ? h`<button class="btn secondary small" type="button" data-action="opp-state" data-id="${o.id}" data-do="close" data-confirm="Close this opportunity to new applications?">Close</button>` : '') }], opps.opportunities, 'No opportunities yet.')}
    <details class="card mt"><summary><strong>Create an opportunity</strong></summary><div class="mt">${form('opp-create', oppFields(), 'Create draft')}</div></details>`);
}, { perm: 'funding.manage' });
forms['opp-create'] = async (d) => { await POST('/api/admin/funding/opportunities', d); await refresh(); toast('Draft created. Open it when ready.', 'ok'); };
actions['opp-state'] = async (el) => { await POST(`/api/admin/funding/opportunities/${el.dataset.id}/${el.dataset.do}`); await refresh(); toast('Updated.', 'ok'); };

route('/admin/funding/opportunities/:id', async ({ params }) => {
  const { opportunities } = await GET('/api/admin/funding/opportunities');
  const o = opportunities.find((x) => x.id === params.id);
  if (!o) return view('Not found', notice('bad', 'Opportunity not found.'));
  return view(o.title, h`<div class="row mb">${badge(o.status)}<span class="muted">Remaining budget ${money(o.remaining_budget, o.currency)}</span></div>
    ${o.status === 'closed' ? notice('info', 'Closed opportunities cannot be edited.') : h`<section class="card">${form('opp-edit', oppFields(o), 'Save changes', { id: o.id })}</section>`}`, { crumbs: h`<a href="#/admin/funding">Funding</a> /` });
}, { perm: 'funding.manage' });
forms['opp-edit'] = async (d, f) => { await PATCH(`/api/admin/funding/opportunities/${f.dataset.id}`, d); await refresh(); toast('Saved.', 'ok'); };

route('/admin/funding/applications/:id', async ({ params }) => {
  const { application: a, opportunity: o, venture: v, milestones: ms } = await GET(`/api/admin/funding/applications/${params.id}`);
  const inReview = ['submitted', 'eligibility_review', 'under_evaluation'].includes(a.status);
  const canRecommend = can('funding.review') && ['eligibility_review', 'under_evaluation', 'waitlisted'].includes(a.status);
  const staff = inReview ? await staffFor('funding.review') : [];
  const canDecide = can('funding.review') && ['submitted', 'eligibility_review', 'under_evaluation', 'waitlisted'].includes(a.status);
  const canPay = can('funding.disburse') && a.status === 'approved' && a.agreement_status === 'signed' && a.disbursement_status !== 'disbursed';
  const decisions = { submitted: [['start_review', 'Start eligibility review'], ['reject', 'Reject']], eligibility_review: [['advance', 'Pass eligibility — move to evaluation'], ['more_info', 'Ask for more information'], ['reject', 'Reject']], under_evaluation: [['approve', 'Approve'], ['waitlist', 'Waitlist'], ['more_info', 'Ask for more information'], ['reject', 'Reject']], waitlisted: [['approve', 'Approve'], ['reject', 'Reject']] }[a.status] ?? [];
  return view(v.name, h`<div class="row mb">${badge(a.status)}${a.status === 'approved' ? h`Agreement: ${badge(a.agreement_status)} Payment: ${badge(a.disbursement_status)}` : ''}</div>
    <div class="grid cols-2"><section class="card"><h2>Request</h2>${kv([['Opportunity', o.title], ['Requested', money(a.requested_amount, o.currency)], ['Approved', money(a.approved_amount, o.currency)], ['Budget remaining', money(o.remaining_budget, o.currency)], ['Justification', lines(a.justification)], ['Use of funds', lines(a.use_of_funds)]])}
      <h3 class="mt">Budget lines</h3>${table([{ label: 'Line', key: 'label' }, { label: 'Amount', render: (x) => money(x.amount, o.currency) }], a.budget_items, 'None.')}</section>
      <section class="card"><h2>Venture</h2>${kv([['Name', h`<a href="#/admin/ventures/${v.id}">${v.name}</a>`], ['Stage', label(v.stage)], ['Status', badge(v.status)], ['Industry', v.industry], ['Milestones', `${ms.completed} of ${ms.total} verified complete`], ['Problem', lines(v.problem)], ['Solution', lines(v.solution)]])}
      <h2 class="mt">History</h2><ol class="timeline plain">${a.events.map((e) => h`<li><strong>${label(e.to_status)}</strong> <span class="small muted">${fmtDateTime(e.created_at)} · ${e.actor}</span>${e.reason ? h`<p class="small">${e.reason}</p>` : ''}</li>`)}</ol></section></div>
    ${inReview || a.recommendation ? h`<section class="card mt"><h2>Internal review</h2><p class="small muted">Assignment and recommendations are internal. The applicant never sees them.</p>
      <div class="grid cols-2"><div><p>Assigned to: <strong>${a.assignee ?? 'nobody'}</strong></p>${inReview ? assignForm('funding', a.id, staff, a.assigned_to) : ''}</div>
        <div>${a.recommendation ? h`<p>Recommendation: <strong>${label(a.recommendation)}</strong>${a.recommended_amount ? ` of ${money(a.recommended_amount, o.currency)}` : ''} by ${a.recommender ?? 'a colleague'} on ${fmtDate(a.recommended_at)}</p><p class="pre small">${a.recommendation_note}</p>` : h`<p class="muted">No recommendation yet.</p>`}
          ${canRecommend ? form('fund-recommend', h`<div class="grid cols-2">${fld('recommendation', 'Recommend', { type: 'select', required: true, blank: 'Choose…', options: [['approve', 'Approve'], ['reject', 'Reject'], ['more_info', 'Ask for more information']] })}${fld('recommended_amount', `Amount (${o.currency}, when approving)`, { type: 'number', min: 1 })}</div>${fld('note', 'Why', { type: 'textarea', rows: 3, required: true, max: 2000 })}`, 'Save recommendation', { id: a.id }) : ''}</div></div></section>` : ''}
    ${canDecide ? h`<section class="card mt"><h2>Decision</h2><p class="small muted">You cannot evaluate a venture you belong to. Approval reserves budget; it is not a payment.</p>${form('fund-decide', h`<div class="grid cols-2">${fld('decision', 'Decision', { type: 'select', required: true, blank: 'Choose…', options: decisions })}${fld('approved_amount', `Approved amount (${o.currency}, when approving)`, { type: 'number', min: 1 })}</div>${fld('reason', 'Reason (shown to the applicant)', { type: 'textarea', rows: 3, max: 2000 })}`, 'Record decision', { id: a.id })}</section>` : ''}
    ${canPay ? h`<section class="card mt"><h2>Record disbursement</h2><p class="small muted">Record the bank or transfer reference after the payment was made outside this platform. The person who approved the funding cannot record the payment.</p>${form('fund-pay', h`${fld('reference', 'Payment reference', { required: true, max: 120 })}${stepUp()}`, 'Record disbursement', { id: a.id })}</section>` : ''}
    ${a.status === 'approved' && a.disbursement_status === 'disbursed' ? h`<p class="mt"><button class="btn" type="button" data-action="fund-complete" data-id="${a.id}" data-confirm="Mark this funding as completed?">Mark funding completed</button></p>` : ''}
    ${a.status === 'approved' && a.agreement_status !== 'signed' ? notice('warn', 'Payment cannot be recorded until the applicant signs the funding agreement.') : ''}`,
  { crumbs: h`<a href="#/admin/funding">Funding</a> /` });
}, { perm: 'funding.manage' });
forms['fund-recommend'] = async (d, f) => { await POST(`/api/admin/funding/applications/${f.dataset.id}/recommend`, d); await refresh(); toast('Recommendation saved.', 'ok'); };
forms['fund-decide'] = async (d, f) => { await POST(`/api/admin/funding/applications/${f.dataset.id}/decide`, d); await refresh(); toast('Decision recorded.', 'ok'); };
forms['fund-pay'] = async (d, f) => { await POST(`/api/admin/funding/applications/${f.dataset.id}/disburse`, d); await refresh(); toast('Disbursement recorded.', 'ok'); };
actions['fund-complete'] = async (el) => { await POST(`/api/admin/funding/applications/${el.dataset.id}/complete`); await refresh(); toast('Completed.', 'ok'); };

// =====================================================================
// Resources, support
// =====================================================================
route('/admin/resources', async () => {
  const { resources } = await GET('/api/admin/resources');
  return view('Resource library management', table([{ label: 'Title', key: 'title' }, { label: 'Type', render: (r) => label(r.resource_type) }, { label: 'Author', key: 'author' }, { label: 'Audience', render: (r) => (r.audience_categories.length ? r.audience_categories.map(label).join(', ') : 'Everyone') }, { label: 'Downloads', key: 'downloads' }, { label: 'Status', render: (r) => badge(r.status) },
    { label: '', render: (r) => h`${r.status !== 'published' ? h`<button class="btn small" type="button" data-action="res-state" data-id="${r.id}" data-do="publish">Publish</button>` : ''} ${r.status !== 'archived' ? h`<button class="btn secondary small" type="button" data-action="res-state" data-id="${r.id}" data-do="archive">Archive</button>` : ''}` }], resources, 'No resources yet.'), { sub: h`Drafts are written by lecturers, mentors and staff. <a href="#/my-resources">Add your own</a>.` });
}, { perm: 'resource.publish' });
actions['res-state'] = async (el) => { await POST(`/api/resources/${el.dataset.id}/${el.dataset.do}`); await refresh(); toast('Updated.', 'ok'); };

const PRIORITIES = [['low', 'Low'], ['normal', 'Normal'], ['high', 'High'], ['urgent', 'Urgent']];
const supportAbout = (c) => (SUPPORT_CATEGORIES.find(([k]) => k === c) ?? [c, label(c)])[1];
route('/admin/support', async ({ query }) => {
  const status = query.get('status') ?? 'open';
  const qs = keep(query, ['assigned', 'priority', 'category', 'q', 'offset']);
  qs.set('status', status);
  const r = await GET(`/api/admin/support?${qs}`);
  return view('Support inbox', h`<form data-form="filter" data-path="/admin/support" class="filters" role="search">
      ${fld('status', 'Status', { type: 'select', options: [['open', 'Open'], ['in_progress', 'In progress'], ['resolved', 'Resolved'], ['all', 'All']], value: status })}
      ${fld('assigned', 'Assigned', { type: 'select', options: [['me', 'To me'], ['none', 'Unassigned']], blank: 'Anyone', value: query.get('assigned') })}
      ${fld('priority', 'Priority', { type: 'select', options: PRIORITIES, blank: 'Any', value: query.get('priority') })}
      ${fld('category', 'About', { type: 'select', options: SUPPORT_CATEGORIES, blank: 'Any', value: query.get('category') })}
      ${fld('q', 'Search', { value: query.get('q'), hint: 'Subject, name or email.' })}<button class="btn secondary" type="submit">Filter</button></form>
    ${table([
      { label: 'Request', render: (s) => h`<a href="#/admin/support/${s.id}"><strong>${s.subject}</strong></a> ${s.overdue ? badge('overdue') : ''}<div class="small muted">${s.full_name} · ${s.email}</div>` },
      { label: 'About', render: (s) => supportAbout(s.category) }, { label: 'Priority', render: (s) => badge(s.priority) }, { label: 'Status', render: (s) => badge(s.status) },
      { label: 'Assigned to', render: (s) => s.assignee ?? h`<span class="muted">Unassigned</span>` }, { label: 'Last activity', render: (s) => fmtDateTime(s.last_message_at ?? s.updated_at) },
    ], r.requests, 'No requests match.')}${pager(r.page, '/admin/support', query)}`);
}, { perm: 'support.manage' });

route('/admin/support/:id', async ({ params }) => {
  const [{ request: s, messages, own_ticket }, staff] = await Promise.all([GET(`/api/admin/support/${params.id}`), staffFor('support.manage')]);
  return view(s.subject, h`<div class="row mb">${badge(s.status)}${badge(s.priority)}${s.account_status !== 'active' ? badge(s.account_status) : ''}<span class="muted">${supportAbout(s.category)} · ${s.full_name} (${s.email}) · opened ${fmtDateTime(s.created_at)}</span></div>
    ${own_ticket ? notice('warn', 'You opened this request yourself, so you cannot answer it. Another staff member must.') : ''}
    <div class="grid cols-2">
      <section class="card"><h2>Conversation</h2>${thread(messages)}</section>
      <div class="stack">
        <section class="card"><h2>Assignment</h2><p class="small muted">${s.assignee ? `Assigned to ${s.assignee}.` : 'Nobody is handling this yet. Replying assigns it to you.'}</p>${assignForm('support', s.id, staff, s.assigned_to)}</section>
        <section class="card"><h2>Triage</h2>${form('support-triage', h`<div class="grid cols-2">${fld('priority', 'Priority', { type: 'select', options: PRIORITIES, value: s.priority })}${fld('category', 'About', { type: 'select', options: SUPPORT_CATEGORIES, value: s.category })}</div>`, 'Save triage', { id: s.id })}</section>
      </div></div>
    ${own_ticket ? '' : h`<section class="card mt"><h2>Reply to the requester</h2>${form('support-reply', h`${fld('response', 'Reply', { type: 'textarea', rows: 4, required: true, max: 4000, hint: 'The requester sees this as “Support team”, not your name.' })}${fld('status', 'Then mark as', { type: 'select', required: true, options: [['in_progress', 'In progress'], ['resolved', 'Resolved']] })}`, 'Send reply', { id: s.id })}</section>`}
    <section class="card mt"><h2>Internal note</h2><p class="small muted">Only staff see notes. They are never shown to the requester.</p>${form('support-note', fld('body', 'Note', { type: 'textarea', rows: 3, required: true, max: 4000 }), 'Save note', { id: s.id })}</section>`,
  { crumbs: h`<a href="#/admin/support">Support inbox</a> /` });
}, { perm: 'support.manage' });
forms['support-reply'] = async (d, f) => { await POST(`/api/admin/support/${f.dataset.id}/respond`, d); await refresh(); toast('Reply sent.', 'ok'); };
forms['support-note'] = async (d, f) => { await POST(`/api/admin/support/${f.dataset.id}/note`, d); await refresh(); toast('Note saved.', 'ok'); };
forms['support-triage'] = async (d, f) => { await PATCH(`/api/admin/support/${f.dataset.id}`, d); await refresh(); toast('Saved.', 'ok'); };

// =====================================================================
// Users, audit, reports, settings
// =====================================================================
route('/admin/users', async ({ query }) => {
  const qs = new URLSearchParams([...query].filter(([, v]) => v));
  const { users } = await GET(`/api/admin/users?${qs}`);
  return view('Users & roles', h`<form data-form="filter" data-path="/admin/users" class="filters" role="search">${fld('q', 'Name or email', { value: query.get('q') })}${fld('status', 'Account status', { type: 'select', options: ['active', 'suspended', 'disabled'].map((s) => [s, label(s)]), blank: 'All', value: query.get('status') })}${fld('role', 'Role', { type: 'select', options: (state.meta?.roles ?? []).map((r) => [r, label(r)]), blank: 'All', value: query.get('role') })}<button class="btn secondary" type="submit">Search</button></form>
    ${table([{ label: 'Person', render: (u) => h`<a href="#/admin/users/${u.id}"><strong>${u.full_name}</strong></a><div class="small muted">${u.email}</div>` }, { label: 'Category', render: (u) => label(u.category) }, { label: 'Roles', render: (u) => u.roles.map(label).join(', ') || '—' }, { label: 'Verification', render: (u) => badge(u.verification_status) }, { label: 'Account', render: (u) => badge(u.account_status) }, { label: 'Joined', render: (u) => fmtDate(u.created_at) }], users, 'No users match.')}<p class="small muted mt">Showing up to 200 results.</p>`);
}, { perm: 'user.manage' });

route('/admin/users/:id', async ({ params }) => {
  const { user: u, roles, affiliation } = await GET(`/api/admin/users/${params.id}`);
  const isSelf = u.id === state.user.id;
  return view(u.full_name, h`<div class="row mb">${badge(u.account_status)} ${badge(u.verification_status)} ${u.email_verified ? '' : badge('unverified')}</div>
    <div class="grid cols-2"><section class="card"><h2>Account</h2>${kv([['Email', u.email], ['Category', label(u.category)], ['Phone', u.phone], ['Country', u.country], ['Organisation', u.organization], ['Joined', fmtDate(u.created_at)], ['Institution', affiliation?.institution]])}</section>
      <section class="card"><h2>Roles</h2><p>${roles.length ? roles.map((r) => h`<span class="badge info">${label(r.role)}</span> `) : 'None'}</p>
        ${isSelf ? notice('info', 'You cannot change your own roles or status.') : form('user-role', h`<div class="grid cols-2">${fld('action', 'Action', { type: 'select', required: true, options: [['grant', 'Grant'], ['revoke', 'Revoke']] })}${fld('role', 'Staff role', { type: 'select', required: true, options: (state.meta?.staff_roles ?? []).map((r) => [r, label(r)]), blank: 'Choose…' })}</div>${fld('reason', 'Reason (recorded in the audit log)', { required: true, max: 1000 })}${stepUp()}`, 'Apply', { id: u.id })}
        <p class="small muted mt">Member roles come from verification, and the mentor role comes from mentor review. Only staff roles are granted here. Administrator roles need a super administrator.</p></section></div>
    ${isSelf ? '' : h`<section class="card mt"><h2>Account status</h2>${form('user-status', h`<div class="grid cols-2">${fld('status', 'Set status', { type: 'select', required: true, options: [['active', 'Active'], ['suspended', 'Suspended (can sign in only to contact support)'], ['disabled', 'Disabled (cannot sign in)']], value: u.account_status })}${fld('reason', 'Reason', { required: true, max: 1000 })}</div>${stepUp()}`, 'Update status', { id: u.id })}<p class="small muted mt">Changing status signs the person out everywhere immediately.</p></section>`}
    ${u.email_verified ? '' : h`<section class="card mt"><h2>Confirm email manually</h2><p class="muted">No email provider is connected, so you can confirm an address after checking it another way. This is recorded in the audit log.</p>${form('user-confirm', fld('reason', 'How did you check?', { required: true, max: 500 }), 'Confirm email', { id: u.id })}</section>`}`,
  { crumbs: h`<a href="#/admin/users">Users & roles</a> /` });
}, { perm: 'user.manage' });
forms['user-role'] = async (d, f) => { await POST(`/api/admin/users/${f.dataset.id}/roles`, d); await refresh(); toast('Done.', 'ok'); };
forms['user-status'] = async (d, f) => { await POST(`/api/admin/users/${f.dataset.id}/status`, d); await refresh(); toast('Status updated.', 'ok'); };
forms['user-confirm'] = async (d, f) => { await POST(`/api/admin/users/${f.dataset.id}/confirm-email`, d); await refresh(); toast('Email confirmed.', 'ok'); };

route('/admin/audit', async ({ query }) => {
  const qs = new URLSearchParams([...query].filter(([, v]) => v));
  const { events } = await GET(`/api/admin/audit?${qs}`);
  const last = events[events.length - 1];
  return view('Audit log', h`<form data-form="filter" data-path="/admin/audit" class="filters" role="search">${fld('action', 'Action starts with', { value: query.get('action'), hint: 'For example funding.' })}${fld('entity', 'Entity', { value: query.get('entity') })}${fld('actor', 'Actor id', { value: query.get('actor') })}<button class="btn secondary" type="submit">Filter</button></form>
    ${table([{ label: 'When', render: (e) => h`<span class="nowrap">${fmtDateTime(e.created_at)}</span>` }, { label: 'Who', render: (e) => e.actor_name ?? 'System' }, { label: 'Action', render: (e) => h`<code>${e.action}</code>` }, { label: 'Target', render: (e) => `${e.entity}${e.entity_id ? ' ' + String(e.entity_id).slice(0, 8) : ''}` }, { label: 'Details', render: (e) => json(e.details) }], events, 'No events match.')}
    ${events.length >= 100 && last ? h`<p class="mt"><a class="btn secondary" href="#/admin/audit?${new URLSearchParams({ ...Object.fromEntries(qs), before: last.created_at })}">Older events</a></p>` : ''}`);
}, { perm: 'audit.view' });

const grp = (title, rows) => h`<div class="card"><h3>${title}</h3>${rows?.length ? h`<table><tbody>${rows.map((r) => h`<tr><td>${label(r.key)}</td><td class="right"><strong>${r.count}</strong></td></tr>`)}</tbody></table>` : h`<p class="muted">No data yet.</p>`}</div>`;
// ---- trends: small, honest charts. One series per chart, one axis from zero, value labelled at the peak only, and a table for every chart. ----
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthText = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(2, 4)}`;
let chartSeq = 0;
const barChart = (months, values, title) => {
  const id = `chart-${++chartSeq}`;
  const W = 320, H = 140, L = 30, B = 22, T = 16, n = months.length;
  const known = values.filter((v) => v !== null);
  const top0 = Math.max(0, ...known);
  const max = Math.max(1, top0);
  const slot = (W - L - 6) / n, bw = Math.min(24, Math.max(3, slot - 4));
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const base = H - B;
  const peak = top0 > 0 ? values.indexOf(top0) : -1;
  const every = Math.ceil(n / 5);
  const bars = values.map((v, i) => {
    const x = L + slot * i + (slot - bw) / 2;
    if (v === null) return `<rect class="bar-hidden" x="${x.toFixed(1)}" y="${base - 3}" width="${bw.toFixed(1)}" height="3"><title>${esc(monthText(months[i]))}: hidden, fewer than 5</title></rect>`;
    if (v === 0) return `<rect class="bar-zero" x="${x.toFixed(1)}" y="${base - 1}" width="${bw.toFixed(1)}" height="1"><title>${esc(monthText(months[i]))}: 0</title></rect>`;
    const top = y(v), r = Math.min(4, (base - top) / 2, bw / 2);
    const d = `M${x.toFixed(1)} ${base} V${(top + r).toFixed(1)} Q${x.toFixed(1)} ${top.toFixed(1)} ${(x + r).toFixed(1)} ${top.toFixed(1)} H${(x + bw - r).toFixed(1)} Q${(x + bw).toFixed(1)} ${top.toFixed(1)} ${(x + bw).toFixed(1)} ${(top + r).toFixed(1)} V${base} Z`;
    return `<path class="bar" d="${d}"><title>${esc(monthText(months[i]))}: ${v}</title></path>`;
  }).join('');
  const ticks = months.map((m, i) => (i % every === 0 || i === n - 1 ? `<text class="axis" x="${(L + slot * i + slot / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(monthText(m))}</text>` : '')).join('');
  const peakLabel = peak >= 0 ? `<text class="axis strong" x="${(L + slot * peak + slot / 2).toFixed(1)}" y="${(y(top0) - 4).toFixed(1)}" text-anchor="middle">${top0}</text>` : '';
  const desc = peak >= 0 ? `Highest month ${monthText(months[peak])} with ${top0}. Open the table for every month.` : known.length ? 'Nothing recorded in this period.' : 'No visible data in this period.';
  return raw(`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="${id}-t ${id}-d" focusable="false"><title id="${id}-t">${esc(title)}</title><desc id="${id}-d">${esc(desc)}</desc>
    <line class="grid-line" x1="${L}" x2="${W - 6}" y1="${T}" y2="${T}"/><line class="axis-line" x1="${L}" x2="${W - 6}" y1="${base}" y2="${base}"/>
    <text class="axis" x="${L - 6}" y="${T + 4}" text-anchor="end">${max}</text><text class="axis" x="${L - 6}" y="${base + 4}" text-anchor="end">0</text>${bars}${peakLabel}${ticks}</svg>`);
};
const trendCard = (months, t) => h`<section class="card"><div class="row between"><h3>${t.label}</h3><span class="kpi-sm">${t.total === null ? 'Hidden' : t.total}</span></div>
  ${barChart(months, t.values, t.label)}
  <details class="mt"><summary class="small">Show as a table</summary>${table([{ label: 'Month', render: (m) => m.m }, { label: 'Count', render: (m) => (m.v === null ? 'Hidden (fewer than 5)' : m.v) }], months.map((m, i) => ({ m, v: t.values[i] })))}</details>
  ${t.link ? h`<p class="small mt"><a href="${t.link}">Open the list</a></p>` : ''}</section>`;
const days = (n) => (n === null ? '—' : `${n} days`);

route('/admin/reports', async ({ query }) => {
  const qs = keep(query, ['from', 'to']);
  const [r, an] = await Promise.all([GET('/api/reports/summary'), GET(`/api/reports/analytics?${qs}`)]);
  const kpi = (n, t) => h`<div class="card"><div class="kpi">${n}</div><div class="kpi-label">${t}</div></div>`;
  return view('Reports', h`${r.suppression !== 'none' ? notice('info', r.suppression) : ''}
    <div class="grid cols-3 mt">${kpi(r.members.total_verified, 'Verified members')}${kpi(r.workshops.attended, 'Workshop attendances')}${kpi(r.mentorship.active_mentors, 'Active mentors')}${kpi(r.funding.approved_amount === null ? 'Hidden' : money(r.funding.approved_amount), 'Approved funding')}${kpi(r.funding.disbursed_amount === null ? 'Hidden' : money(r.funding.disbursed_amount), 'Disbursements recorded')}${kpi(r.milestones.verified_by_reviewer, 'Reviewer-verified milestones')}</div>
    <p class="small muted mt">${r.funding.note} ${r.milestones.note}</p>
    <div class="grid cols-3 mt">${grp('Members by category', r.members.by_category)}${grp('Ventures by stage', r.ventures.by_stage)}${grp('Ventures by status', r.ventures.by_status)}${grp('Ventures by industry', r.ventures.by_industry)}${grp('Programme applications', r.programmes.applications_by_status)}${grp('Mentorship requests', r.mentorship.by_status)}${grp('Funding applications', r.funding.applications_by_status)}</div>
    <div class="grid cols-3 mt">${kpi(r.workshops.average_rating ?? '—', 'Average workshop rating')}${kpi(r.mentorship.average_rating ?? '—', 'Average mentoring rating')}${kpi(`${r.milestones.completed} / ${r.milestones.total}`, 'Milestones completed')}</div>
    <h2 class="mt">Trends over time</h2>
    <form data-form="report-range" class="filters">${fld('from', 'From', { type: 'date', value: an.range.from })}${fld('to', 'To', { type: 'date', value: an.range.to })}<button class="btn secondary" type="submit">Show period</button></form>
    ${an.suppression !== 'none' ? notice('info', an.suppression) : ''}
    <div class="grid cols-2">${an.trends.map((t) => trendCard(an.months, t))}</div>
    ${an.turnaround.length ? h`<section class="card mt"><h2>How long decisions take</h2><p class="small muted">Only items decided in the period. Days from submission to decision.</p>${table([{ label: 'Process', render: (t) => (t.link ? h`<a href="${t.link}">${t.label}</a>` : t.label) }, { label: 'Decided', render: (t) => (t.decided === null ? 'Hidden' : t.decided) }, { label: 'Average', render: (t) => days(t.average_days) }, { label: 'Median', render: (t) => days(t.median_days) }], an.turnaround)}</section>` : ''}
    ${an.workload ? h`<section class="card mt"><h2>Reviewer workload</h2><p class="small muted">Decisions made in the period, by person. Shown only to roles that see exact counts.</p>${table([{ label: 'Person', key: 'name' }, { label: 'Verification', key: 'verification' }, { label: 'Programmes', key: 'programme' }, { label: 'Funding', key: 'funding' }, { label: 'Support tickets resolved', key: 'support' }], an.workload, 'No decisions in this period.')}</section>` : ''}
    ${can('report.export') ? h`<section class="card mt"><h2>Anonymised CSV exports</h2><p class="muted">No names or emails. Cells that could be read as formulas are neutralised.</p><div class="row">${['ventures', 'programme_applications', 'workshops', 'funding', 'milestones'].map((d) => h`<a class="btn secondary" href="/api/reports/export.csv?dataset=${d}" download>${label(d)}</a>`)}</div></section>` : ''}
    <p class="small muted mt">Generated ${fmtDateTime(r.generated_at)}. Period ${an.range.from} to ${an.range.to}. PDF export is not available.</p>`);
}, { perm: 'report.view' });
forms['report-range'] = (d, f) => {
  const qs = new URLSearchParams();
  if (f.elements.from.value) qs.set('from', f.elements.from.value);
  if (f.elements.to.value) qs.set('to', f.elements.to.value);
  go(`/admin/reports${qs.toString() ? '?' + qs : ''}`);
};

route('/admin/config', async () => {
  const { settings } = await GET('/api/admin/config');
  return view('Settings', h`${settings.map((s) => h`<section class="card mb"><h2>${label(s.key)}</h2><p class="muted">${s.description}</p>${form('config-save', h`<input type="hidden" name="key" value="${s.key}">${fld('value', `Value (${s.min} to ${s.max})`, { type: 'number', min: s.min, value: s.value, required: true })}${stepUp()}`, 'Save')}</section>`)}`);
}, { perm: 'config.manage' });
forms['config-save'] = async (d) => { await PUT('/api/admin/config', d); await refresh(); toast('Setting saved.', 'ok'); };
