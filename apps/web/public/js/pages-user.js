// Member pages: profile, verification, ventures, milestones, resource library, support.
import { h, html, raw, GET, POST, PUT, PATCH, DEL, uploadFile, fld, formShell, notice, badge, label, empty, table, kv, fmtDate, fmtDateTime, toInputDate, safeUrl, toast } from './lib.js';
import { state, route, view, forms, actions, go, refresh, can, verified } from './core.js';
import { STAGES, CATEGORIES, docsTable, uploadForm, myVentures, optionsOf, lines, docLabel, form, pager, stepUp, thread, SUPPORT_CATEGORIES } from './shared.js';


// =====================================================================
// Profile
// =====================================================================
route('/profile', async () => {
  const [me, docs] = await Promise.all([GET('/api/me'), GET('/api/documents/mine')]);
  const u = me.user, p = me.profile ?? {}, pref = me.preferences ?? { email_enabled: 1, in_app_enabled: 1 };
  return view('Your profile', h`
    <div class="grid cols-2">
      <section class="card"><h2>Account</h2>
        ${kv([['Email', u.email], ['Category', label(u.category)], ['Email confirmed', u.email_verified ? badge('verified') : badge('unverified')], ['Verification', badge(u.verification_status)], ['Roles', u.roles.length ? u.roles.map(label).join(', ') : 'None yet']])}
        ${u.email_verified ? '' : h`<div class="mt">${notice('warn', h`Your email address is not confirmed yet.${state.meta?.capabilities?.email_delivery ? '' : ' Email delivery is not configured here, so ask an administrator to confirm it.'}`)}
          <p class="mt"><button class="btn secondary" type="button" data-action="resend-verification">Request a new confirmation link</button></p></div>`}
      </section>
      <section class="card"><h2>Personal details</h2>
        ${form('profile', h`${fld('full_name', 'Full name', { value: u.full_name, required: true, max: 120 })}${fld('phone', 'Phone', { value: p.phone, type: 'tel', max: 30 })}${fld('country', 'Country', { value: p.country, max: 80 })}${fld('organization', 'Organisation', { value: p.organization, max: 160 })}`)}
      </section>
      <section class="card"><h2>Notifications</h2>
        ${form('prefs', h`${fld('in_app_enabled', 'Show notifications in the app', { type: 'checkbox', value: pref.in_app_enabled })}${fld('email_enabled', 'Queue email copies', { type: 'checkbox', value: pref.email_enabled, hint: state.meta?.capabilities?.email_delivery ? 'Copies are emailed to your confirmed address.' : 'No email provider is configured on this installation, so copies are queued but not sent.' })}`)}
      </section>
      <section class="card"><h2>Change password</h2>
        ${form('password', h`${fld('current_password', 'Current password', { type: 'password', required: true, autocomplete: 'current-password' })}${fld('new_password', 'New password', { type: 'password', required: true, autocomplete: 'new-password', hint: 'At least 10 characters, with a letter and a number.' })}`, 'Change password')}
      </section>
    </div>
    <section class="card mt"><h2>Your files</h2>${docsTable(docs.documents)}<p class="small muted mt">Files are private. Reviewers can open them only to decide your applications, and each access is logged.</p></section>`);
});
forms.profile = async (d) => { await PATCH('/api/me', d); state.user = (await GET('/api/auth/me')).user; await refresh(); toast('Profile saved.', 'ok'); };
forms.prefs = async (d) => { await PUT('/api/me/preferences', d); toast('Preferences saved.', 'ok'); };
forms.password = async (d) => { await POST('/api/auth/change-password', d); await refresh(); toast('Password changed. Other devices were signed out.', 'ok'); };
actions['resend-verification'] = async () => {
  const r = await POST('/api/auth/resend-verification');
  if (r.dev_verify_token) go(`/verify-email?token=${r.dev_verify_token}`);
  else toast(r.message, 'ok');
};

// =====================================================================
// Verification
// =====================================================================
const VERIFY_DOCS = ['student_id', 'staff_id', 'enrollment_evidence', 'alumni_evidence', 'identity_document', 'organization_evidence'];
const AFFIL = [
  ['institution', 'Institution'], ['id_number', 'ID / matric / staff number'], ['faculty', 'Faculty'], ['department', 'Department'], ['programme_of_study', 'Programme of study'],
  ['level', 'Level'], ['graduation_year', 'Graduation year', 'number'], ['position', 'Position / title'], ['organization', 'Organisation'], ['institutional_email', 'Institutional email', 'email'],
];

route('/verification', async () => {
  const [me, mine, docs] = await Promise.all([GET('/api/me'), GET('/api/verification/mine'), GET('/api/documents/mine')]);
  const u = me.user, a = me.affiliation ?? {};
  const req = state.meta?.verification_requirements?.[u.category] ?? { affiliation_fields: [], document: null };
  const last = mine.requests[0];
  const vdocs = docs.documents.filter((d) => VERIFY_DOCS.includes(d.category));
  const usable = vdocs.filter((d) => d.scan_status !== 'quarantined');
  const open = ['pending', 'under_review'].includes(u.verification_status);
  const banner = {
    verified: notice('ok', 'You are verified. If you change your affiliation details you will need to be verified again.'),
    pending: notice('info', 'Your request was submitted and is waiting for a reviewer.'),
    under_review: notice('info', 'A reviewer is looking at your request.'),
    more_info_required: notice('warn', h`<strong>More information needed.</strong> ${last?.decision_reason ?? ''}`),
    rejected: notice('bad', h`<strong>Your request was not approved.</strong> ${last?.decision_reason ?? ''} You can correct your details and submit again.`),
    unverified: notice('info', 'Complete the three steps below. Only reviewers with the right role can see your documents.'),
  }[u.verification_status];
  const requiredField = (k) => req.affiliation_fields.includes(k);
  return view('Verification', h`
    ${banner}
    ${!u.email_verified ? h`<div class="mt">${notice('warn', h`Step 0: confirm your email address first. <a href="#/profile">Open your profile</a>.`)}</div>` : ''}
    <section class="card mt"><h2>1. Your affiliation details</h2>
      <p class="muted">Fields marked * are required for ${label(u.category)} accounts.</p>
      ${form('affiliation', h`<div class="grid cols-2">${AFFIL.map(([k, t, type]) => fld(k, t, { value: a[k], type: type ?? 'text', required: requiredField(k), max: 160, min: type === 'number' ? 1950 : undefined }))}</div>`, 'Save details')}
    </section>
    <section class="card mt"><h2>2. Evidence</h2>
      ${req.document ? h`<p>Required document: <strong>${docLabel(req.document)}</strong> (PDF, PNG or JPEG, up to 5 MB).</p>` : ''}
      ${uploadForm(VERIFY_DOCS.map((c) => [c, docLabel(c)]), { id: 'verify' })}
      <div class="mt">${docsTable(vdocs)}</div>
    </section>
    ${u.verification_status === 'verified' || open ? '' : h`<section class="card mt"><h2>3. Submit for review</h2>
      ${usable.length ? h`<form data-form="verify-submit" novalidate><div class="form-error notice bad" role="alert" tabindex="-1" hidden></div>
        ${fld('document_ids', 'Documents to include', { type: 'checks', options: usable.map((d) => [d.id, `${docLabel(d.category)} — ${d.original_name}`]), value: usable.map((d) => d.id) })}
        <button class="btn" type="submit"${u.email_verified ? '' : raw(' disabled')}>Submit for verification</button></form>` : empty('Upload your evidence first.')}</section>`}
    <section class="card mt"><h2>History</h2>${table([{ label: 'Submitted', render: (r) => fmtDateTime(r.created_at) }, { label: 'Status', render: (r) => badge(r.status) }, { label: 'Reviewer note', key: 'decision_reason' }, { label: 'Decided', render: (r) => fmtDate(r.decided_at) }], mine.requests, 'No requests yet.')}</section>`);
});
forms.affiliation = async (d) => { await PUT('/api/me/affiliation', d); state.user = (await GET('/api/auth/me')).user; await refresh(); toast('Details saved.', 'ok'); };
forms['verify-submit'] = async (d) => {
  await POST('/api/verification/submit', { document_ids: d.document_ids });
  state.user = (await GET('/api/auth/me')).user;
  toast('Submitted for verification.', 'ok');
  await refresh();
};

// =====================================================================
// Ventures
// =====================================================================
const ventureFields = (v = {}) => h`
  ${fld('name', 'Venture name', { value: v.name, required: true, max: 120 })}
  <div class="grid cols-2">${fld('stage', 'Stage', { type: 'select', options: STAGES, value: v.stage ?? 'idea' })}${fld('industry', 'Industry', { value: v.industry, max: 80, hint: 'For example agritech, fintech, health.' })}</div>
  ${fld('location', 'Where it operates', { value: v.location, max: 120, hint: 'Town, state or country.' })}
  ${fld('description', 'Description', { type: 'textarea', value: v.description, max: 3000 })}
  ${fld('problem', 'Problem you solve', { type: 'textarea', value: v.problem, max: 3000 })}
  ${fld('solution', 'Your solution', { type: 'textarea', value: v.solution, max: 3000 })}
  ${fld('target_market', 'Target market', { type: 'textarea', value: v.target_market, max: 3000, rows: 3 })}
  ${fld('value_proposition', 'Value proposition', { type: 'textarea', value: v.value_proposition, max: 3000, rows: 3 })}
  ${fld('business_model', 'Business model', { type: 'textarea', value: v.business_model, max: 3000, rows: 3 })}
  ${fld('risks', 'Key risks', { type: 'textarea', value: v.risks, max: 3000, rows: 3 })}`;

route('/ventures', async ({ query }) => {
  const showArchived = query.get('archived') === '1';
  const { ventures: list, archived_count: archivedCount } = await GET(`/api/ventures${showArchived ? '?archived=1' : ''}`);
  return view('My ventures', h`
    <div class="row mb">${showArchived ? h`<a class="btn secondary small" href="#/ventures">Hide archived</a>` : archivedCount ? h`<a class="btn secondary small" href="#/ventures?archived=1">Show ${archivedCount} archived</a>` : ''}</div>
    <div class="stack">${list.length ? table([
      { label: 'Venture', render: (v) => h`<a href="#/ventures/${v.id}"><strong>${v.name}</strong></a>` }, { label: 'Stage', render: (v) => label(v.stage) }, { label: 'Industry', key: 'industry' },
      { label: 'Status', render: (v) => h`${badge(v.status)} ${v.archived_at ? h`<span class="badge">archived</span>` : ''}` }, { label: 'Your role', render: (v) => label(v.member_role) }, { label: 'Updated', render: (v) => fmtDate(v.updated_at) },
    ], list) : empty('You have no ventures yet.')}
    <details class="card"${list.length ? '' : raw(' open')}><summary><strong>Create a venture</strong></summary><div class="mt">${form('venture-create', ventureFields(), 'Create venture')}</div></details></div>`);
});
forms['venture-create'] = async (d) => { const r = await POST('/api/ventures', d); toast('Venture created.', 'ok'); go(`/ventures/${r.id}`); };

route('/ventures/:id', async ({ params }) => {
  const [{ venture: v, members, can_edit, is_owner }, ms, hist] = await Promise.all([GET(`/api/ventures/${params.id}`), GET(`/api/ventures/${params.id}/milestones`), GET(`/api/ventures/${params.id}/history`)]);
  const me = state.user.id;
  const canSubmit = is_owner && !v.archived_at && ['draft', 'changes_requested'].includes(v.status);
  const canArchive = is_owner && !v.archived_at && ['draft', 'changes_requested', 'rejected', 'graduated'].includes(v.status);
  const isMember = members.some((m) => m.id === me);
  return view(v.name, h`
    ${v.review_reason && ['changes_requested', 'rejected'].includes(v.status) ? notice(v.status === 'rejected' ? 'bad' : 'warn', h`<strong>Reviewer feedback:</strong> ${v.review_reason}`) : ''}
    ${v.archived_at ? notice('info', h`This venture is archived since ${fmtDate(v.archived_at)}. It is hidden from your working list and cannot be edited or used in applications.${is_owner ? h` <button class="btn secondary small" type="button" data-action="venture-unarchive" data-id="${v.id}">Restore</button>` : ''}`) : ''}
    <div class="row mb">${badge(v.status)}<span class="muted">Stage: ${label(v.stage)}${v.location ? ' · ' + v.location : ''}</span>${canArchive ? h`<button class="btn secondary" type="button" data-action="venture-archive" data-id="${v.id}" data-confirm="Archive this venture? Nothing is deleted. You can restore it later.">Archive</button>` : ''}${canSubmit ? h`<button class="btn" type="button" data-action="venture-submit" data-id="${v.id}" data-confirm="Submit this venture for review? You will not be able to edit it while it is under review.">Submit for review</button>` : ''}</div>
    <div class="grid cols-2">
      <section class="card"><h2>Profile</h2>${kv([['Industry', v.industry], ['Location', v.location], ['Problem', lines(v.problem)], ['Solution', lines(v.solution)], ['Target market', lines(v.target_market)], ['Value proposition', lines(v.value_proposition)], ['Business model', lines(v.business_model)], ['Risks', lines(v.risks)]])}</section>
      <section class="card"><h2>Team</h2>
        ${table([{ label: 'Name', key: 'full_name' }, { label: 'Role', render: (m) => label(m.member_role) }, { label: 'Title', key: 'title' }, { label: '', render: (m) => (m.member_role !== 'owner' && (is_owner || m.id === me) ? h`<button class="btn secondary small" type="button" data-action="member-remove" data-venture="${v.id}" data-id="${m.id}" data-confirm="Remove this member?">${m.id === me ? 'Leave' : 'Remove'}</button>` : '') }], members)}
        ${is_owner ? h`<h3 class="mt">Add a teammate</h3>${form('member-add', h`<div class="grid cols-2">${fld('email', 'Their email', { type: 'email', required: true, hint: 'They must be a verified member.' })}${fld('title', 'Role in the venture', { max: 80 })}</div>`, 'Add teammate', { id: v.id })}` : ''}
      </section>
    </div>
    ${can_edit ? h`<details class="card mt"><summary><strong>Edit venture profile</strong></summary><div class="mt">${form('venture-edit', ventureFields(v), 'Save changes', { id: v.id })}</div></details>` : ''}
    <section class="card mt"><h2>Milestones</h2>
      ${table([{ label: 'Milestone', render: (m) => (isMember ? h`<a href="#/milestones/${m.id}">${m.title}</a>` : m.title) }, { label: 'Owner', key: 'owner_name' }, { label: 'Due', render: (m) => fmtDate(m.due_date) }, { label: 'Priority', render: (m) => (m.priority === 'high' ? badge('high') : label(m.priority)) }, { label: 'Status', render: (m) => h`${badge(m.status)} ${m.overdue ? badge('overdue') : ''}` }, { label: 'Evidence', render: (m) => (m.status === 'completed' ? badge(m.evidence_type) : m.evidence_text || m.evidence_document_id ? badge('self_reported') : '—') }], ms.milestones, 'No milestones yet.')}
      ${isMember ? h`<details class="mt"><summary><strong>Add a milestone</strong></summary><div class="mt">${form('milestone-create', h`${fld('title', 'Milestone', { required: true, max: 160 })}${fld('description', 'Details', { type: 'textarea', rows: 3, max: 2000 })}<div class="grid cols-2">${fld('due_date', 'Due date', { type: 'date' })}${fld('completion_criteria', 'How will we know it is done?', { max: 1000 })}</div>${fld('owner_id', 'Owner', { type: 'select', options: members.map((m) => [m.id, m.full_name]), value: me })}${fld('priority', 'Priority', { type: 'select', options: PRIORITIES, value: 'normal' })}`, 'Add milestone', { id: v.id })}</div></details>` : ''}
    </section>
    <section class="card mt"><h2>History</h2>
      <div class="grid cols-2"><div><h3>Reviews and changes</h3>${hist.events.length ? h`<ol class="timeline plain">${hist.events.map((e) => h`<li><strong>${label(e.action.replace(/^venture\./, ''))}</strong> <span class="small muted">${fmtDateTime(e.created_at)}${e.actor ? ' · ' + e.actor : ''}</span>${e.reason ? h`<p class="small">${e.reason}</p>` : ''}</li>`)}</ol>` : h`<p class="muted">Nothing yet.</p>`}</div>
        <div><h3>Programmes</h3>${hist.programmes.length ? h`<ul>${hist.programmes.map((p) => h`<li><a href="#/programmes/${p.programme_id}">${p.title}</a> ${badge(p.status)}</li>`)}</ul>` : h`<p class="muted">Not applied to any programme.</p>`}
          <h3 class="mt">Funding</h3>${hist.funding.length ? h`<ul>${hist.funding.map((f) => h`<li><a href="#/funding/applications/${f.id}">${f.title}</a> ${badge(f.status)}</li>`)}</ul>` : h`<p class="muted">No funding applications.</p>`}
          <h3 class="mt">Milestones</h3>${hist.milestones.length ? h`<p>${hist.milestones.map((m) => h`<span class="badge">${label(m.status)}: ${m.n}</span> `)}</p>` : h`<p class="muted">None yet.</p>`}</div></div></section>`, { crumbs: h`<a href="#/ventures">My ventures</a> /` });
});
actions['venture-archive'] = async (el) => { await POST(`/api/ventures/${el.dataset.id}/archive`); await refresh(); toast('Archived. Nothing was deleted.', 'ok'); };
actions['venture-unarchive'] = async (el) => { await POST(`/api/ventures/${el.dataset.id}/unarchive`); await refresh(); toast('Restored.', 'ok'); };
actions['venture-submit'] = async (el) => { await POST(`/api/ventures/${el.dataset.id}/submit`); await refresh(); toast('Submitted for review.', 'ok'); };
actions['member-remove'] = async (el) => { await DEL(`/api/ventures/${el.dataset.venture}/members/${el.dataset.id}`); toast('Done.', 'ok'); if (el.dataset.id === state.user.id) go('/ventures'); else await refresh(); };
forms['venture-edit'] = async (d, f) => { await PATCH(`/api/ventures/${f.dataset.id}`, d); await refresh(); toast('Saved.', 'ok'); };
forms['member-add'] = async (d, f) => { await POST(`/api/ventures/${f.dataset.id}/members`, d); await refresh(); toast('Teammate added.', 'ok'); };
forms['milestone-create'] = async (d, f) => { await POST(`/api/ventures/${f.dataset.id}/milestones`, d); await refresh(); toast('Milestone added.', 'ok'); };

// =====================================================================
// Milestones
// =====================================================================
const PRIORITIES = [['low', 'Low'], ['normal', 'Normal'], ['high', 'High']];
const MS_ACTIONS = {
  not_started: [['in_progress', 'Start work'], ['cancelled', 'Cancel milestone']],
  in_progress: [['blocked', 'Mark as blocked'], ['cancelled', 'Cancel milestone']],
  blocked: [['in_progress', 'Resume work'], ['cancelled', 'Cancel milestone']],
  changes_requested: [['in_progress', 'Resume work'], ['cancelled', 'Cancel milestone']],
};
route('/milestones', async () => {
  const { milestones } = await GET('/api/milestones/mine');
  return view('Milestones', h`${table([
    { label: 'Milestone', render: (m) => h`<a href="#/milestones/${m.id}">${m.title}</a>` }, { label: 'Venture', key: 'venture_name' }, { label: 'Due', render: (m) => fmtDate(m.due_date) },
    { label: 'Status', render: (m) => h`${badge(m.status)} ${m.overdue ? badge('overdue') : ''}` }, { label: 'Evidence', render: (m) => (m.status === 'completed' ? badge(m.evidence_type) : '—') },
  ], milestones, 'No milestones yet. Add them from one of your ventures.')}`, { sub: 'Only evidence that a reviewer has verified counts as verified. Everything else is self-reported.' });
});
route('/milestones/:id', async ({ params }) => {
  const { milestones } = await GET('/api/milestones/mine');
  const m = milestones.find((x) => x.id === params.id);
  if (!m) return view('Milestone not found', notice('bad', 'That milestone does not exist or is not part of your ventures.'));
  const canEvidence = ['in_progress', 'changes_requested'].includes(m.status);
  return view(m.title, h`
    ${m.status === 'changes_requested' && m.review_comment ? notice('warn', h`<strong>Reviewer asked for changes:</strong> ${m.review_comment}`) : ''}
    ${m.status === 'completed' ? notice('ok', h`Verified by a reviewer on ${fmtDate(m.completed_at)}.`) : ''}
    ${m.status === 'submitted' ? notice('info', 'Evidence submitted. It is self-reported until a reviewer verifies it.') : ''}
    <section class="card mt">${kv([['Venture', m.venture_name], ['Status', h`${badge(m.status)} ${m.overdue ? badge('overdue') : ''}`], ['Due', fmtDate(m.due_date)], ['Priority', label(m.priority)], ['Done when', m.completion_criteria], ['Details', lines(m.description)],
      ['Evidence status', m.evidence_text || m.evidence_document_id ? badge(m.evidence_type) : 'None yet'], ['Evidence note', m.evidence_text ? lines(m.evidence_text) : undefined],
      ['Evidence file', m.evidence_document_id ? h`<a href="/api/documents/${m.evidence_document_id}/download">Download</a>` : undefined], ['Outcome', m.outcome_metric ? `${m.outcome_metric}: ${m.outcome_value ?? '—'}` : undefined]])}
      <div class="row mt">${(MS_ACTIONS[m.status] ?? []).map(([to, text]) => h`<button class="btn ${to === 'cancelled' ? 'danger' : 'secondary'}" type="button" data-action="ms-transition" data-id="${m.id}" data-to="${to}"${to === 'cancelled' ? raw(' data-confirm="Cancel this milestone?"') : ''}>${text}</button>`)}</div></section>
    ${canEvidence ? h`<section class="card mt"><h2>Submit evidence</h2>${form('ms-evidence', h`${fld('evidence_text', 'What did you achieve?', { type: 'textarea', value: m.evidence_text, max: 3000 })}
      <div class="grid cols-2">${fld('outcome_metric', 'Outcome metric (optional)', { value: m.outcome_metric, max: 120, hint: 'For example pilot customers.' })}${fld('outcome_value', 'Value', { type: 'number', value: m.outcome_value, step: 'any' })}</div>
      <div class="field"><label for="f-file-ms">Supporting file (optional, PDF, PNG or JPEG)</label><input id="f-file-ms" name="file" type="file" accept="application/pdf,image/png,image/jpeg"></div>`, 'Submit for review', { id: m.id })}</section>` : ''}
    ${!['completed', 'cancelled'].includes(m.status) ? h`<details class="card mt"><summary><strong>Edit milestone</strong></summary><div class="mt">${form('ms-edit', h`${fld('title', 'Title', { value: m.title, max: 160 })}${fld('description', 'Details', { type: 'textarea', value: m.description, rows: 3 })}<div class="grid cols-2">${fld('due_date', 'Due date', { type: 'date', value: toInputDate(m.due_date) })}${fld('completion_criteria', 'Done when', { value: m.completion_criteria })}${fld('priority', 'Priority', { type: 'select', options: PRIORITIES, value: m.priority ?? 'normal' })}</div>`, 'Save', { id: m.id })}</div></details>` : ''}`,
  { crumbs: h`<a href="#/milestones">Milestones</a> /` });
});
actions['ms-transition'] = async (el) => { await POST(`/api/milestones/${el.dataset.id}/transition`, { to: el.dataset.to }); await refresh(); toast('Updated.', 'ok'); };
forms['ms-edit'] = async (d, f) => { await PATCH(`/api/milestones/${f.dataset.id}`, d); await refresh(); toast('Saved.', 'ok'); };
forms['ms-evidence'] = async (d, f) => {
  const file = f.elements.file.files[0];
  const body = { to: 'submitted', ...d };
  if (file) body.evidence_document_id = (await uploadFile(file, 'milestone_evidence', { 'X-Context': 'milestone', 'X-Context-Id': f.dataset.id })).id;
  await POST(`/api/milestones/${f.dataset.id}/transition`, body);
  toast('Evidence submitted for review.', 'ok');
  await refresh();
};

// =====================================================================
// Resource library
// =====================================================================
const RES_TYPES = [['document', 'Document'], ['template', 'Template'], ['link', 'Link'], ['video', 'Video']];
route('/resources', async ({ query }) => {
  const qs = new URLSearchParams([...query].filter(([, v]) => v));
  const r = await GET(`/api/resources?${qs}`);
  return view('Resource library', h`
    <form data-form="filter" data-path="/resources" class="filters" role="search">
      ${fld('q', 'Search', { value: query.get('q') })}${fld('topic', 'Topic', { type: 'select', options: r.topics.map((t) => [t, t]), blank: 'All', value: query.get('topic') })}
      ${fld('stage', 'Stage', { type: 'select', options: STAGES, blank: 'All', value: query.get('stage') })}${fld('type', 'Type', { type: 'select', options: RES_TYPES, blank: 'All', value: query.get('type') })}
      <button class="btn secondary" type="submit">Filter</button></form>
    ${r.resources.length ? h`<div class="grid cols-2">${r.resources.map((x) => h`<article class="card"><div class="row between"><h2>${x.title}</h2><span class="badge info">${label(x.resource_type)}</span></div>
      <p class="muted small">${[x.topic, x.venture_stage ? `Stage: ${label(x.venture_stage)}` : null].filter(Boolean).join(' · ')}</p><p>${x.description ?? ''}</p>
      <div class="row">${x.external_url ? h`<a class="btn secondary" href="${safeUrl(x.external_url)}" target="_blank" rel="noopener noreferrer">Open link</a>` : ''}${x.has_file ? h`<a class="btn" href="/api/resources/${x.id}/download">Download</a>` : ''}</div></article>`)}</div>` : empty('No resources match your filters yet.')}`);
});

route('/my-resources', async () => {
  const r = await GET('/api/resources/mine');
  return view('My resource drafts', h`
    ${table([{ label: 'Title', key: 'title' }, { label: 'Type', render: (x) => label(x.resource_type) }, { label: 'Status', render: (x) => badge(x.status) },
      { label: '', render: (x) => h`${can('resource.publish') && x.status !== 'published' ? h`<button class="btn small" type="button" data-action="res-publish" data-id="${x.id}">Publish</button>` : ''}` }], r.resources, 'You have not created any resources.')}
    <section class="card mt"><h2>Add a resource</h2>
      <p class="muted">${can('resource.publish') ? 'You can publish what you add.' : 'New resources are saved as drafts. A programme or incubation manager publishes them.'}</p>
      ${form('res-create', h`${fld('title', 'Title', { required: true, max: 160 })}${fld('description', 'Description', { type: 'textarea', rows: 3, max: 3000 })}
        <div class="grid cols-2">${fld('resource_type', 'Type', { type: 'select', options: RES_TYPES, required: true })}${fld('topic', 'Topic', { max: 80 })}${fld('venture_stage', 'Best for stage', { type: 'select', options: STAGES, blank: 'Any' })}${fld('external_url', 'Link (for links and videos)', { type: 'url', max: 500 })}</div>
        <div class="field"><label for="f-file-res">File (for documents and templates)</label><input id="f-file-res" name="file" type="file" accept="application/pdf,image/png,image/jpeg"></div>
        ${fld('audience_categories', 'Audience (leave empty for everyone)', { type: 'checks', options: CATEGORIES })}`, 'Save draft')}</section>`);
}, { perm: 'resource.create' });
forms['res-create'] = async (d, f) => {
  const file = f.elements.file.files[0];
  const body = { ...d };
  if (file) body.document_id = (await uploadFile(file, 'resource_file', { 'X-Context': 'resource' })).id;
  await POST('/api/resources', body);
  toast('Draft saved.', 'ok');
  await refresh();
};
actions['res-publish'] = async (el) => { await POST(`/api/resources/${el.dataset.id}/publish`); await refresh(); toast('Published.', 'ok'); };

// =====================================================================
// Support: a request is a conversation. You see your own thread; internal staff notes are never sent to you.
// =====================================================================
const supportCategory = (c) => (SUPPORT_CATEGORIES.find(([k]) => k === c) ?? [c, label(c)])[1];

route('/support', async ({ query }) => {
  const offset = Number(query.get('offset')) || 0;
  const r = await GET(`/api/support/mine?offset=${offset}`);
  return view('Help & support', h`
    <section class="card"><h2>Ask for help</h2>${form('support', h`${fld('subject', 'Subject', { required: true, max: 160 })}${fld('category', 'About', { type: 'select', options: SUPPORT_CATEGORIES, value: 'general' })}${fld('message', 'How can we help?', { type: 'textarea', required: true, max: 4000, hint: 'Do not include passwords. To correct, export or delete your data, choose “My data and privacy” and say so here.' })}`, 'Send')}</section>
    <h2 class="mt">Your requests</h2>
    ${table([
      { label: 'Subject', render: (s) => h`<a href="#/support/${s.id}"><strong>${s.subject}</strong></a>` }, { label: 'About', render: (s) => supportCategory(s.category) },
      { label: 'Status', render: (s) => badge(s.status) }, { label: 'Messages', key: 'message_count' }, { label: 'Last activity', render: (s) => fmtDateTime(s.last_message_at ?? s.updated_at) },
    ], r.requests, 'No requests yet.')}
    ${pager(r.page, '/support', query)}
    <p class="small muted mt">Need an answer about how things work first? Try the <a href="#/help">help centre</a>.</p>`);
});
forms.support = async (d) => { const r = await POST('/api/support', d); toast('Sent. Replies appear in this conversation.', 'ok'); go(`/support/${r.id}`); };


route('/support/:id', async ({ params }) => {
  const { request: s, messages } = await GET(`/api/support/${params.id}`);
  return view(s.subject, h`<div class="row mb">${badge(s.status)}<span class="muted">${supportCategory(s.category)} · opened ${fmtDateTime(s.created_at)}</span></div>
    ${s.status === 'resolved' ? notice('ok', 'The support team marked this as resolved. If it is not, write below and it will be reopened.') : ''}
    <section class="card">${thread(messages)}</section>
    <section class="card mt"><h2>Write a reply</h2>${form('support-reply-member', fld('body', 'Your message', { type: 'textarea', required: true, max: 4000, hint: 'Do not include passwords.' }), 'Send reply', { id: s.id })}</section>`,
  { crumbs: h`<a href="#/support">Help &amp; support</a> /` });
});
forms['support-reply-member'] = async (d, f) => { await POST(`/api/support/${f.dataset.id}/messages`, d); await refresh(); toast('Sent.', 'ok'); };

// =====================================================================
// Help centre: plain answers about how the platform works. Nothing here promises a feature that is not built.
// =====================================================================
const FAQ = [
  ['How do I get access to programmes, funding and mentoring?', 'Create an account, confirm your email address, then submit your affiliation details and evidence on the Verification page. A reviewer decides. Until you are verified, those areas stay closed.'],
  ['Who can see my documents?', 'Only you, and the staff reviewers who need a file to decide your request. Every time a reviewer opens a file it is written to the audit log.'],
  ['Does funding mean money is paid through this platform?', 'No. Staff record a payment after it was made outside the platform. Approval, signing the agreement and recording the payment are separate steps done by different people.'],
  ['What does “self-reported” mean on a milestone?', 'Evidence you submit is self-reported until a reviewer verifies it. Only reviewer-verified milestones are counted as verified in reports.'],
  ['I did not receive an email.', 'Email sending only works when the organisation has configured an email provider. If it has not, the platform says so on the sign-up and reset pages. Use in-app notifications, or ask support to confirm your address.'],
  ['How do I ask for my data to be corrected or deleted?', 'Open Help & support, choose “My data and privacy”, and describe what you need. A staff member handles it and the request is recorded.'],
  ['My account is suspended. What can I do?', 'You can sign in and use Help & support to ask for a review. Nothing else is available while an account is suspended.'],
  ['How do I become a mentor?', 'Open Mentor application, fill in your details and upload a credential. Reviewers must approve you, and your identity must be verified first.'],
  ['How do I get a staff role?', 'Roles are never self-service. Verified members can send a request with a reason from “Request a staff role”; an administrator decides and the decision is recorded.'],
  ['What is not available yet?', 'No payment gateway, no SMS or WhatsApp, no calendar sync, no PDF export of reports, and no two-step sign-in. These are listed honestly in the project documentation.'],
];
route('/help', () => view('Help centre', h`<p class="muted">Short answers. If yours is not here, <a href="#/support">write to support</a>.</p>
  <div class="stack">${FAQ.map(([q, a]) => h`<details class="card"><summary><strong>${q}</strong></summary><p class="mt">${a}</p></details>`)}</div>`), { public: true });
