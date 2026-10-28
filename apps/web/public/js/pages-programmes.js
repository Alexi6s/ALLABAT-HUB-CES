// Member pages: programmes, workshops, funding, mentoring.
import { h, html, raw, GET, POST, PUT, PATCH, DEL, fld, notice, badge, label, empty, table, kv, fmtDate, fmtDateTime, money, toast, safeUrl } from './lib.js';
import { state, route, view, forms, actions, go, refresh } from './core.js';
import { STAGES, docsTable, uploadForm, myVentures, lines, docLabel, form } from './shared.js';

const answersOf = (d) => Object.fromEntries(Object.entries(d).filter(([k]) => k.startsWith('q_')).map(([k, v]) => [k.slice(2), v]));
const questionFields = (qs, answers = {}) => qs.map((q) => fld(`q_${q.id}`, q.label, { type: 'textarea', rows: 3, max: 3000, required: q.required, value: answers[q.id] }));
const windowText = (x) => (x.opens_at || x.closes_at ? `${x.opens_at ? 'Opens ' + fmtDate(x.opens_at) : ''}${x.opens_at && x.closes_at ? ' · ' : ''}${x.closes_at ? 'Closes ' + fmtDate(x.closes_at) : ''}` : 'Open until closed');

// =====================================================================
// Programmes
// =====================================================================
route('/programmes', async () => {
  const { programmes } = await GET('/api/programmes');
  return view('Programmes', programmes.length ? h`<div class="grid cols-2">${programmes.map((p) => h`<article class="card"><div class="row between"><h2><a href="#/programmes/${p.id}">${p.title}</a></h2>${p.my_application_status ? badge(p.my_application_status) : p.applications_open ? badge('open') : badge('closed')}</div>
    <p>${p.description ?? ''}</p><p class="small muted">${windowText(p)} · ${p.seats_left} of ${p.capacity} seats left</p>
    ${p.eligible ? '' : notice('warn', 'Your registration category is not eligible for this programme.')}
    <a class="btn secondary" href="#/programmes/${p.id}">${p.my_application_status ? 'View my application' : 'View details'}</a></article>`)}</div>` : empty('No programmes are open right now. Check back soon.'));
});

route('/programmes/:id', async ({ params }) => {
  const [{ programme: p, application: a }, ventures, docs, mineApps] = await Promise.all([GET(`/api/programmes/${params.id}`), myVentures(), GET('/api/documents/mine'), GET('/api/programme-applications/mine')]);
  const timeline = (mineApps.applications.find((x) => x.id === a?.id)?.timeline) ?? [];
  const have = new Set(docs.documents.filter((d) => d.scan_status !== 'quarantined').map((d) => d.category));
  const missing = p.required_documents.filter((c) => !have.has(c));
  const canApply = p.eligible && p.applications_open && (!a || a.status === 'withdrawn');
  const venturePick = fld('venture_id', 'Venture this application is for (optional)', { type: 'select', options: ventures.map((v) => [v.id, v.name]), blank: 'None' });
  return view(p.title, h`
    <section class="card"><p class="pre">${p.description ?? ''}</p>${kv([['Window', windowText(p)], ['Seats left', `${p.seats_left} of ${p.capacity}`], ['Open to', p.eligible_categories.length ? p.eligible_categories.map(label).join(', ') : 'All verified members'], ['Required documents', p.required_documents.length ? p.required_documents.map(docLabel).join(', ') : 'None']])}</section>
    ${a && a.status !== 'withdrawn' ? h`<section class="card mt"><h2>Your application</h2><p>${badge(a.status)}</p>${a.decision_reason ? notice(['rejected'].includes(a.status) ? 'bad' : 'info', h`<strong>Programme team:</strong> ${a.decision_reason}`) : ''}
      ${timeline.length ? h`<h3>Progress</h3><ol class="timeline plain">${timeline.map((t) => h`<li><strong>${t.label}</strong> <span class="small muted">${fmtDateTime(t.created_at)}</span>${t.note ? h`<p class="small">${t.note}</p>` : ''}</li>`)}</ol>` : ''}
      ${a.status === 'more_info_required' ? form('prog-resubmit', h`${questionFields(p.questions, a.answers)}`, 'Resubmit', { id: a.id }) : kv(p.questions.map((q) => [q.label, lines(a.answers[q.id])]))}
      ${['submitted', 'under_review', 'more_info_required', 'waitlisted', 'accepted'].includes(a.status) ? h`<p class="mt"><button class="btn danger" type="button" data-action="prog-withdraw" data-id="${a.id}" data-confirm="Withdraw your application? Your seat, if any, will be released.">Withdraw application</button></p>` : ''}</section>` : ''}
    ${canApply ? h`<section class="card mt"><h2>Apply</h2>
      ${missing.length ? h`${notice('warn', h`Upload these documents first: <strong>${missing.map(docLabel).join(', ')}</strong>.`)}<div class="mt">${missing.map((c) => uploadForm([[c, docLabel(c)]], { id: c }))}</div>` : ''}
      ${form('prog-apply', h`${venturePick}${questionFields(p.questions)}`, 'Submit application', { id: p.id })}</section>` : ''}
    ${!a && !canApply ? notice('warn', p.eligible ? 'Applications are not open for this programme.' : 'Your registration category is not eligible for this programme.') : ''}`,
  { crumbs: h`<a href="#/programmes">Programmes</a> /` });
});
forms['prog-apply'] = async (d, f) => { await POST(`/api/programmes/${f.dataset.id}/apply`, { venture_id: d.venture_id, answers: answersOf(d) }); await refresh(); toast('Application submitted.', 'ok'); };
forms['prog-resubmit'] = async (d, f) => { await POST(`/api/programme-applications/${f.dataset.id}/resubmit`, { answers: answersOf(d) }); await refresh(); toast('Resubmitted.', 'ok'); };
actions['prog-withdraw'] = async (el) => { await POST(`/api/programme-applications/${el.dataset.id}/withdraw`); await refresh(); toast('Application withdrawn.', 'ok'); };

// =====================================================================
// Workshops
// =====================================================================
const workshopCard = (w) => {
  const past = w.status === 'completed' || w.starts_at < new Date().toISOString();
  return h`<article class="card"><div class="row between"><h2>${w.title}</h2>${w.my_status ? badge(w.my_status) : w.status === 'completed' ? badge('completed') : ''}</div>
    <p class="small muted">${fmtDateTime(w.starts_at)} – ${fmtDateTime(w.ends_at)} · ${label(w.mode)}${w.location ? ' · ' + w.location : ''}</p>
    <p>${w.description ?? ''}</p><p class="small muted">${w.seats_left} of ${w.capacity} seats left${w.seats_left === 0 && !w.my_status ? ' · a waitlist is available' : ''}</p>
    ${w.my_status === 'registered' && w.meeting_link ? h`<p>Meeting link: <a href="${safeUrl(w.meeting_link)}" target="_blank" rel="noopener noreferrer">${w.meeting_link}</a></p>` : ''}
    ${!w.eligible ? notice('warn', 'Your category is not eligible for this workshop.') : ''}
    <div class="row">${w.eligible && !past && w.status === 'published' && (!w.my_status || w.my_status === 'cancelled') ? h`<button class="btn" type="button" data-action="ws-register" data-id="${w.id}">${w.seats_left === 0 ? 'Join waitlist' : 'Register'}</button>` : ''}
    ${['registered', 'waitlisted'].includes(w.my_status) && !past ? h`<button class="btn secondary" type="button" data-action="ws-cancel" data-id="${w.id}" data-confirm="Cancel your registration?">Cancel registration</button>` : ''}</div>
    ${w.my_attended === 1 && !w.my_feedback ? h`<h3 class="mt">How was it?</h3>${form('ws-feedback', h`<div class="grid cols-2">${fld('rating', 'Rating', { type: 'select', required: true, options: [[5, '5 – Excellent'], [4, '4 – Good'], [3, '3 – Fair'], [2, '2 – Poor'], [1, '1 – Very poor']] })}${fld('comment', 'Comment (optional)', { max: 2000 })}</div>`, 'Send feedback', { id: w.id })}` : ''}
    ${w.my_feedback ? h`<p class="small muted">Thanks for your feedback (${w.my_feedback}/5).</p>` : ''}</article>`;
};
route('/workshops', async () => {
  const { workshops } = await GET('/api/workshops');
  const now = new Date().toISOString();
  const upcoming = workshops.filter((w) => w.status === 'published' && w.ends_at >= now);
  const past = workshops.filter((w) => !upcoming.includes(w)).reverse();
  return view('Workshops', h`<h2>Upcoming</h2>${upcoming.length ? h`<div class="grid cols-2">${upcoming.map(workshopCard)}</div>` : empty('No upcoming workshops.')}
    ${past.length ? h`<h2 class="mt">Past</h2><div class="grid cols-2">${past.map(workshopCard)}</div>` : ''}`);
});
actions['ws-register'] = async (el) => { const r = await POST(`/api/workshops/${el.dataset.id}/register`); await refresh(); toast(r.status === 'registered' ? 'You are registered.' : 'You are on the waitlist.', 'ok'); };
actions['ws-cancel'] = async (el) => { await DEL(`/api/workshops/${el.dataset.id}/register`); await refresh(); toast('Registration cancelled.', 'ok'); };
forms['ws-feedback'] = async (d, f) => { await POST(`/api/workshops/${f.dataset.id}/feedback`, d); await refresh(); toast('Thank you!', 'ok'); };

// =====================================================================
// Funding
// =====================================================================
const BUDGET_ROWS = 6;
const budgetRows = (items = []) => h`<fieldset><legend>Budget (the lines must add up to the amount you request)</legend>${Array.from({ length: BUDGET_ROWS }, (_, i) => h`<div class="grid cols-2">${fld(`bi_label_${i}`, `Line ${i + 1}`, { value: items[i]?.label, max: 120 })}${fld(`bi_amount_${i}`, 'Amount', { type: 'number', value: items[i]?.amount, min: 0 })}</div>`)}</fieldset>`;
const budgetOf = (d) => Array.from({ length: BUDGET_ROWS }, (_, i) => ({ label: d[`bi_label_${i}`], amount: d[`bi_amount_${i}`] })).filter((x) => x.label || x.amount !== undefined).map((x) => ({ label: x.label ?? 'Item', amount: x.amount ?? 0 }));
const fundingBody = (d) => ({ requested_amount: d.requested_amount, justification: d.justification, use_of_funds: d.use_of_funds, budget_items: budgetOf(d) });

route('/funding', async () => {
  const [{ opportunities }, mine] = await Promise.all([GET('/api/funding/opportunities'), GET('/api/funding/applications/mine')]);
  return view('Funding', h`
    <h2>Open opportunities</h2>
    ${opportunities.length ? h`<div class="grid cols-2">${opportunities.map((o) => h`<article class="card"><h2>${o.title}</h2><p>${o.description ?? ''}</p>
      <p class="small muted">Award range ${money(o.min_amount, o.currency)} – ${money(o.max_amount, o.currency)} · ${windowText(o)}</p>
      <p class="small muted">Remaining budget: ${money(o.remaining_budget, o.currency)}</p>${o.criteria ? h`<p><strong>Criteria:</strong> ${o.criteria}</p>` : ''}
      ${o.eligible ? (o.applications_open ? h`<a class="btn" href="#/funding/apply/${o.id}">Apply</a>` : badge('closed')) : notice('warn', 'Your category is not eligible.')}</article>`)}</div>` : empty('No funding opportunities are open right now.')}
    <h2 class="mt">My applications</h2>
    ${table([{ label: 'Opportunity', render: (a) => h`<a href="#/funding/applications/${a.id}">${a.opportunity}</a>` }, { label: 'Venture', key: 'venture' }, { label: 'Requested', render: (a) => money(a.requested_amount, a.currency) },
      { label: 'Approved', render: (a) => money(a.approved_amount, a.currency) }, { label: 'Status', render: (a) => badge(a.status) }, { label: 'Agreement', render: (a) => (a.status === 'approved' ? badge(a.agreement_status) : '—') },
      { label: 'Payment', render: (a) => (a.status === 'approved' || a.status === 'completed' ? badge(a.disbursement_status) : '—') }], mine.applications, 'You have not applied for funding yet.')}
    <p class="small muted mt">Approval and payment are separate steps. Payments are recorded by staff; this platform does not move money.</p>`);
});

route('/funding/apply/:id', async ({ params }) => {
  const [{ opportunities }, ventures] = await Promise.all([GET('/api/funding/opportunities'), myVentures()]);
  const o = opportunities.find((x) => x.id === params.id);
  if (!o) return view('Not found', notice('bad', 'That funding opportunity is not open.'));
  const eligible = ventures.filter((v) => !['draft', 'rejected'].includes(v.status));
  return view(`Apply: ${o.title}`, h`${notice('info', h`Award range ${money(o.min_amount, o.currency)} – ${money(o.max_amount, o.currency)}. You can save a draft and submit when ready.`)}
    ${eligible.length ? h`<section class="card mt">${form('fund-create', h`${fld('venture_id', 'Venture', { type: 'select', required: true, options: eligible.map((v) => [v.id, v.name]), blank: 'Choose…', hint: 'Ventures must be submitted for review first.' })}
      ${fld('requested_amount', `Amount requested (${o.currency})`, { type: 'number', required: true, min: 1 })}${fld('justification', 'Why do you need this funding?', { type: 'textarea', max: 5000, hint: 'At least 30 characters.' })}${fld('use_of_funds', 'How will you use it?', { type: 'textarea', max: 3000 })}${budgetRows()}`, 'Save draft', { id: o.id })}</section>`
    : notice('warn', h`You need a venture that has been submitted for review before you can apply. <a href="#/ventures">Go to my ventures</a>.`)}`, { crumbs: h`<a href="#/funding">Funding</a> /` });
});
forms['fund-create'] = async (d, f) => {
  const r = await POST(`/api/funding/opportunities/${f.dataset.id}/applications`, { venture_id: d.venture_id, ...fundingBody(d) });
  toast('Draft saved. Review it and submit when ready.', 'ok');
  go(`/funding/applications/${r.id}`);
};

route('/funding/applications/:id', async ({ params }) => {
  const { application: a, opportunity: o } = await GET(`/api/funding/applications/${params.id}`);
  const editable = ['draft', 'more_info_required'].includes(a.status);
  const total = a.budget_items.reduce((s, x) => s + x.amount, 0);
  const needsSignature = a.status === 'approved' && a.agreement_status === 'pending' && a.applicant_id === state.user.id;
  return view(o.title, h`
    <div class="row mb">${badge(a.status)}${a.status === 'approved' ? h`Agreement: ${badge(a.agreement_status)} Payment: ${badge(a.disbursement_status)}` : ''}</div>
    ${a.decision_reason && ['rejected', 'more_info_required', 'waitlisted', 'approved'].includes(a.status) ? notice(a.status === 'rejected' ? 'bad' : 'info', h`<strong>Funding team:</strong> ${a.decision_reason}`) : ''}
    ${a.disbursement_status === 'disbursed' ? notice('ok', h`Payment recorded on ${fmtDate(a.disbursed_at)} (reference ${a.disbursement_reference}). This platform records payments made by staff; it does not move money itself.`) : ''}
    <div class="grid cols-2"><section class="card"><h2>Request</h2>${kv([['Requested', money(a.requested_amount, o.currency)], ['Approved', money(a.approved_amount, o.currency)], ['Justification', lines(a.justification)], ['Use of funds', lines(a.use_of_funds)]])}
      <h3 class="mt">Budget</h3>${table([{ label: 'Line', key: 'label' }, { label: 'Amount', render: (x) => money(x.amount, o.currency) }], a.budget_items, 'No budget lines.')}<p class="small ${total === a.requested_amount ? 'muted' : 'err'}">Lines total ${money(total, o.currency)}${total === a.requested_amount ? '' : ' — does not match the amount requested'}.</p></section>
      <section class="card"><h2>History</h2><ol class="timeline plain">${a.events.map((e) => h`<li><strong>${label(e.to_status)}</strong> <span class="small muted">${fmtDateTime(e.created_at)} · ${e.actor}</span>${e.reason ? h`<p class="small">${e.reason}</p>` : ''}</li>`)}</ol></section></div>
    ${o.conditions && a.status === 'approved' ? h`<section class="card mt"><h2>Funding conditions</h2><p class="pre">${o.conditions}</p></section>` : ''}
    ${needsSignature ? h`<section class="card mt"><h2>Sign the funding agreement</h2><p>By typing your full name you confirm that you accept the funding conditions above. Payment can only be recorded after the agreement is signed.</p>
      ${form('fund-sign', h`${fld('typed_name', 'Type your full name', { required: true, hint: `Exactly as registered: ${state.user.full_name}` })}${fld('accept', 'I accept the funding conditions', { type: 'checkbox', required: true })}`, 'Sign agreement', { id: a.id })}</section>` : ''}
    ${editable ? h`<section class="card mt"><h2>Edit application</h2>${form('fund-edit', h`${fld('requested_amount', `Amount requested (${o.currency})`, { type: 'number', required: true, min: 1, value: a.requested_amount })}${fld('justification', 'Why do you need this funding?', { type: 'textarea', value: a.justification, max: 5000 })}${fld('use_of_funds', 'How will you use it?', { type: 'textarea', value: a.use_of_funds, max: 3000 })}${budgetRows(a.budget_items)}`, 'Save changes', { id: a.id })}
      <div class="row mt"><button class="btn" type="button" data-action="fund-submit" data-id="${a.id}" data-confirm="Submit this application? You cannot change it while it is being evaluated.">Submit application</button></div></section>` : ''}
    ${['draft', 'submitted', 'eligibility_review', 'under_evaluation', 'more_info_required', 'waitlisted'].includes(a.status) ? h`<p class="mt"><button class="btn danger" type="button" data-action="fund-withdraw" data-id="${a.id}" data-confirm="Withdraw this application?">Withdraw application</button></p>` : ''}`,
  { crumbs: h`<a href="#/funding">Funding</a> /` });
});
forms['fund-edit'] = async (d, f) => { await PUT(`/api/funding/applications/${f.dataset.id}`, fundingBody(d)); await refresh(); toast('Saved.', 'ok'); };
forms['fund-sign'] = async (d, f) => { await POST(`/api/funding/applications/${f.dataset.id}/sign-agreement`, d); await refresh(); toast('Agreement signed.', 'ok'); };
actions['fund-submit'] = async (el) => { await POST(`/api/funding/applications/${el.dataset.id}/submit`); await refresh(); toast('Application submitted.', 'ok'); };
actions['fund-withdraw'] = async (el) => { await POST(`/api/funding/applications/${el.dataset.id}/withdraw`); await refresh(); toast('Application withdrawn.', 'ok'); };

// =====================================================================
// Mentoring
// =====================================================================
const mentorCard = (m, extra = '') => h`<article class="card"><h2><a href="#/mentors/${m.mentor_id}">${m.full_name}</a></h2><p class="muted small">${[m.position, m.organization].filter(Boolean).join(' · ')}</p>
  <p>${(m.bio ?? '').slice(0, 220)}${(m.bio ?? '').length > 220 ? '…' : ''}</p>
  <p>${m.expertise.map((e) => h`<span class="badge info">${e}</span> `)}</p><p class="small muted">${m.industries.join(', ')}${m.industries.length ? ' · ' : ''}Stages: ${m.venture_stages.map(label).join(', ') || '—'} · ${m.open_slots} open slot${m.open_slots === 1 ? '' : 's'}</p>${extra}
  <a class="btn secondary" href="#/mentors/${m.mentor_id}">View profile</a></article>`;

route('/mentors', async ({ query }) => {
  const qs = new URLSearchParams([...query].filter(([k, v]) => v && !['rec_venture', 'rec_areas'].includes(k)));
  const recVenture = query.get('rec_venture'), recAreas = query.get('rec_areas');
  const [dir, ventures] = await Promise.all([GET(`/api/mentors?${qs}`), myVentures()]);
  const rec = recVenture || recAreas ? await GET(`/api/mentorship/recommendations?${new URLSearchParams({ ...(recVenture ? { venture_id: recVenture } : {}), ...(recAreas ? { areas: recAreas } : {}) })}`) : null;
  return view('Find a mentor', h`
    <section class="card"><h2>Suggested mentors</h2><p class="muted">Tell us what you need. Every suggestion lists why it was made, and a mentor must still accept your request.</p>
      <form data-form="rec" class="filters">${fld('rec_venture', 'Venture', { type: 'select', options: ventures.map((v) => [v.id, v.name]), blank: 'None', value: recVenture })}${fld('rec_areas', 'Areas of help (comma separated)', { value: recAreas, hint: 'For example marketing, finance.' })}<button class="btn" type="submit">Suggest mentors</button></form>
      ${rec ? (rec.recommendations.length ? h`<div class="grid cols-2">${rec.recommendations.map((m) => mentorCard(m, h`<ul>${m.reasons.map((r) => h`<li class="small">${r}</li>`)}</ul>`))}</div>` : empty('No suggestions matched. Try the directory below.')) : ''}</section>
    <h2 class="mt">Directory</h2>
    <form data-form="filter" data-path="/mentors" class="filters" role="search">${fld('expertise', 'Expertise', { value: query.get('expertise') })}${fld('industry', 'Industry', { value: query.get('industry') })}${fld('language', 'Language', { value: query.get('language') })}${fld('stage', 'Stage', { type: 'select', options: STAGES, blank: 'Any', value: query.get('stage') })}${fld('available', 'Open slots only', { type: 'select', options: [['true', 'Yes']], blank: 'No', value: query.get('available') })}<button class="btn secondary" type="submit">Filter</button></form>
    ${dir.mentors.length ? h`<div class="grid cols-2">${dir.mentors.map((m) => mentorCard(m))}</div>` : empty('No mentors match your filters.')}`);
});
forms.rec = (d) => forms.filter({ rec_venture: d.rec_venture ?? '', rec_areas: d.rec_areas ?? '' }, { dataset: { path: '/mentors' } });

route('/mentors/:id', async ({ params }) => {
  const [{ mentor: m }, ventures] = await Promise.all([GET(`/api/mentors/${params.id}`), myVentures()]);
  return view(m.full_name, h`<section class="card"><p class="muted">${[m.position, m.organization].filter(Boolean).join(' · ')}</p><p class="pre">${m.bio}</p>
    ${kv([['Expertise', m.expertise.join(', ')], ['Industries', m.industries.join(', ')], ['Stages', m.venture_stages.map(label).join(', ')], ['Languages', m.languages.join(', ')], ['Meeting formats', m.meeting_formats.map(label).join(', ')], ['Time zone', m.timezone], ['Availability', m.availability], ['Open slots', m.open_slots]])}</section>
    ${m.open_slots > 0 ? h`<section class="card mt"><h2>Request mentorship</h2>${form('mentor-request', h`${fld('goals', 'What do you want help with?', { type: 'textarea', required: true, max: 2000, hint: 'At least 20 characters. Be specific about your goals.' })}${fld('areas', 'Areas (comma separated)', { list: true })}${fld('venture_id', 'Venture (optional)', { type: 'select', options: ventures.map((v) => [v.id, v.name]), blank: 'None' })}`, 'Send request', { mentor: m.mentor_id })}</section>` : notice('warn', 'This mentor has no open slots right now.')}`, { crumbs: h`<a href="#/mentors">Find a mentor</a> /` });
});
forms['mentor-request'] = async (d, f) => { await POST('/api/mentorship/requests', { mentor_id: f.dataset.mentor, ...d }); toast('Request sent.', 'ok'); go('/mentorship'); };

route('/mentorship', async () => {
  const { requests } = await GET('/api/mentorship/requests');
  const started = requests.filter((r) => ['accepted', 'completed'].includes(r.status));
  const detail = Object.fromEntries(await Promise.all(started.map(async (r) => {
    const [sess, acts, conf] = await Promise.all([GET(`/api/mentorship/requests/${r.id}/sessions`), GET(`/api/mentorship/requests/${r.id}/actions`), GET(`/api/mentorship/requests/${r.id}/conflicts`)]);
    return [r.id, { sessions: sess.sessions, actions: acts.actions, conflicts: conf.conflicts }];
  })));
  const nowIso = new Date().toISOString();
  const sessionRow = (s, r, mentor) => h`<li class="mb"><strong>${fmtDateTime(s.scheduled_at)}</strong> ${badge(s.status)}${s.notes ? ' — ' + s.notes : ''}${s.outcome ? h` <em>(${s.outcome})</em>` : ''}${s.cancel_reason ? h` <span class="small muted">Reason: ${s.cancel_reason}</span>` : ''}
    ${s.status === 'scheduled' ? h`<details><summary class="small">Change this session</summary><div class="grid cols-2 mt">
      <div>${form('session-reschedule', fld('scheduled_at', 'New date and time', { type: 'datetime-local', required: true }), 'Reschedule', { id: s.id })}</div>
      <div>${form('session-cancel', fld('reason', 'Reason for cancelling', { required: true, max: 500, hint: 'At least 5 characters. The other person is told.' }), 'Cancel session', { id: s.id })}</div></div>
      ${mentor && s.scheduled_at <= nowIso ? h`<div class="mt"><strong>It has taken place. Record how it went:</strong>${form('session-complete', h`${fld('mentee_attended', 'The mentee attended', { type: 'checkbox', value: true })}${fld('mentor_attended', 'I attended', { type: 'checkbox', value: true })}${fld('outcome', 'Outcome / next steps', { max: 2000 })}`, 'Record session', { id: s.id })}</div>` : ''}</details>` : ''}</li>`;
  const actionRow = (x) => h`<li class="mb">${x.description} <span class="small muted">— ${x.owner}${x.due_date ? ', due ' + fmtDate(x.due_date) : ''}</span> ${badge(x.status)} ${x.overdue ? badge('overdue') : ''}
    ${x.status === 'open' ? h`<button class="btn secondary small" type="button" data-action="act-status" data-id="${x.id}" data-to="done">Mark done</button> <button class="btn secondary small" type="button" data-action="act-status" data-id="${x.id}" data-to="cancelled" data-confirm="Cancel this action item?">Cancel</button>` : h`<button class="btn secondary small" type="button" data-action="act-status" data-id="${x.id}" data-to="open">Reopen</button>`}</li>`;
  const card = (r) => {
    const mentor = r.as === 'mentor';
    const d = detail[r.id];
    return h`<article class="card mb"><div class="row between"><strong>${mentor ? r.mentee_name : r.mentor_name}</strong>${badge(r.status)}</div>
      <p class="small muted">${fmtDate(r.created_at)}${r.venture_name ? ' · ' + r.venture_name : ''}${r.areas.length ? ' · ' + r.areas.join(', ') : ''}</p><p class="pre">${r.goals}</p>${r.response_note ? h`<p class="small"><em>Note: ${r.response_note}</em></p>` : ''}
      ${mentor && r.status === 'pending' ? form('mentor-respond', h`<div class="grid cols-2">${fld('decision', 'Your answer', { type: 'select', required: true, options: [['accept', 'Accept'], ['decline', 'Decline']], blank: 'Choose…' })}${fld('note', 'Note to mentee (optional)', { max: 1000 })}</div>`, 'Send answer', { id: r.id }) : ''}
      ${!mentor && r.status === 'pending' ? h`<button class="btn secondary small" type="button" data-action="mr-cancel" data-id="${r.id}">Cancel request</button>` : ''}
      ${mentor && r.status === 'accepted' ? h`<button class="btn secondary small" type="button" data-action="mr-complete" data-id="${r.id}" data-confirm="Mark this mentorship as completed?">Mark completed</button>` : ''}
      ${d ? h`<h3 class="mt">Sessions</h3>${d.sessions.length ? h`<ul class="plain">${d.sessions.map((s) => sessionRow(s, r, mentor))}</ul>` : h`<p class="muted small">No sessions yet.</p>`}
        ${r.status === 'accepted' ? h`<details><summary>Schedule or record a session</summary>${form('mr-session', h`<div class="grid cols-2">${fld('scheduled_at', 'Date and time', { type: 'datetime-local', required: true, hint: 'A future time plans a session. A past time with an outcome records one that already happened.' })}${fld('notes', 'Notes', { max: 3000 })}</div>${fld('outcome', 'Outcome / next steps (only for a session that already happened)', { max: 2000 })}`, 'Save session', { id: r.id })}</details>` : ''}
        <h3 class="mt">Action items</h3>${d.actions.length ? h`<ul class="plain">${d.actions.map(actionRow)}</ul>` : h`<p class="muted small">None yet. Agree on next steps together and write them here.</p>`}
        <details><summary>Add an action item</summary>${form('act-add', h`${fld('description', 'What needs to happen', { required: true, max: 500 })}<div class="grid cols-2">${fld('owner_id', 'Who owns it', { type: 'select', required: true, options: [[r.mentee_id, mentor ? r.mentee_name : 'Me (mentee)'], [r.mentor_user_id, mentor ? 'Me (mentor)' : r.mentor_name]] })}${fld('due_date', 'Due date (optional)', { type: 'date' })}</div>`, 'Add action item', { id: r.id })}</details>
        <details><summary>Leave feedback</summary>${form('mr-feedback', h`<div class="grid cols-2">${fld('rating', 'Rating', { type: 'select', required: true, options: [[5, '5 – Excellent'], [4, '4 – Good'], [3, '3 – Fair'], [2, '2 – Poor'], [1, '1 – Very poor']] })}${fld('comment', 'Comment (optional)', { max: 2000 })}</div>`, 'Send feedback', { id: r.id })}</details>
        <details><summary>Report a problem with this mentorship</summary><p class="small muted mt">A reviewer who is not part of this mentorship reads it. The other person is not told that you reported.</p>${form('mr-conflict', fld('reason', 'What happened', { type: 'textarea', rows: 3, required: true, max: 2000, hint: 'At least 10 characters.' }), 'Send report', { id: r.id })}
          ${d.conflicts.length ? h`<ul class="plain mt">${d.conflicts.map((k) => h`<li class="small">Your report of ${fmtDate(k.created_at)} ${badge(k.status)}${k.resolution ? h`<br>Outcome: ${k.resolution}` : ''}</li>`)}</ul>` : ''}</details>` : ''}</article>`;
  };
  const asMentee = requests.filter((r) => r.as === 'mentee'), asMentor = requests.filter((r) => r.as === 'mentor');
  return view('My mentorship', h`${asMentor.length ? h`<h2>Requests to me as a mentor</h2>${asMentor.map(card)}` : ''}<h2>${asMentor.length ? 'My requests as a mentee' : 'My requests'}</h2>${asMentee.length ? asMentee.map(card) : empty('You have not requested a mentor yet.', h`<a class="btn" href="#/mentors">Find a mentor</a>`)}`);
});
forms['mentor-respond'] = async (d, f) => { await POST(`/api/mentorship/requests/${f.dataset.id}/respond`, d); await refresh(); toast('Answer sent.', 'ok'); };
forms['mr-session'] = async (d, f) => { await POST(`/api/mentorship/requests/${f.dataset.id}/sessions`, d); await refresh(); toast('Session saved.', 'ok'); };
forms['mr-feedback'] = async (d, f) => { await POST(`/api/mentorship/requests/${f.dataset.id}/feedback`, d); await refresh(); toast('Thank you for the feedback.', 'ok'); };
forms['mr-conflict'] = async (d, f) => { await POST(`/api/mentorship/requests/${f.dataset.id}/conflict`, d); await refresh(); toast('Report sent to a reviewer.', 'ok'); };
forms['session-reschedule'] = async (d, f) => { await POST(`/api/mentorship/sessions/${f.dataset.id}/reschedule`, d); await refresh(); toast('Session rescheduled. The other person was told.', 'ok'); };
forms['session-cancel'] = async (d, f) => { await POST(`/api/mentorship/sessions/${f.dataset.id}/cancel`, d); await refresh(); toast('Session cancelled.', 'ok'); };
forms['session-complete'] = async (d, f) => { await POST(`/api/mentorship/sessions/${f.dataset.id}/complete`, d); await refresh(); toast('Session recorded.', 'ok'); };
forms['act-add'] = async (d, f) => { await POST(`/api/mentorship/requests/${f.dataset.id}/actions`, d); await refresh(); toast('Action item added.', 'ok'); };
actions['act-status'] = async (el) => { await POST(`/api/mentorship/actions/${el.dataset.id}/status`, { status: el.dataset.to }); await refresh(); toast('Updated.', 'ok'); };
actions['mr-cancel'] = async (el) => { await POST(`/api/mentorship/requests/${el.dataset.id}/cancel`); await refresh(); toast('Cancelled.', 'ok'); };
actions['mr-complete'] = async (el) => { await POST(`/api/mentorship/requests/${el.dataset.id}/complete`); await refresh(); toast('Completed.', 'ok'); };

route('/mentor/apply', async () => {
  const { application: a, documents } = await GET('/api/mentor/application');
  const editable = !a || ['draft', 'more_info_required', 'withdrawn', 'rejected'].includes(a.status);
  const status = a?.status ?? 'not started';
  const banner = { approved: notice('ok', 'You are an approved mentor. Mentees can now find you in the directory.'), submitted: notice('info', 'Submitted. A reviewer will look at it.'), under_review: notice('info', 'Your application is under review.'),
    more_info_required: notice('warn', 'The reviewers asked for more information. Check your notifications, update the form and submit again.'), rejected: notice('bad', 'Your application was not approved. You may update it and apply again.'),
    suspended: notice('bad', 'Your mentor status is suspended.'), withdrawn: notice('info', 'You withdrew your application. You can reopen it by saving and submitting again.') }[status] ?? notice('info', 'Tell us about your experience. Identity verification is also required before approval.');
  return view('Mentor application', h`${banner}<p class="mt">Status: ${badge(status)}</p>
    ${editable ? h`<section class="card mt"><h2>Your details</h2>${form('mentor-app', h`
      <div class="grid cols-2">${fld('organization', 'Organisation', { value: a?.organization, max: 160 })}${fld('position', 'Position', { value: a?.position, max: 160 })}</div>
      ${fld('bio', 'Professional biography', { type: 'textarea', rows: 5, value: a?.bio, max: 3000, hint: 'At least 50 characters.' })}
      <div class="grid cols-2">${fld('expertise', 'Areas of expertise (comma separated)', { list: true, value: a?.expertise })}${fld('industries', 'Industries (comma separated)', { list: true, value: a?.industries })}${fld('languages', 'Languages (comma separated)', { list: true, value: a?.languages })}${fld('timezone', 'Time zone', { value: a?.timezone, max: 60 })}</div>
      ${fld('venture_stages', 'Venture stages you support', { type: 'checks', options: STAGES, value: a?.venture_stages ?? [] })}${fld('meeting_formats', 'Meeting formats', { type: 'checks', options: [['in_person', 'In person'], ['online', 'Online'], ['hybrid', 'Hybrid']], value: a?.meeting_formats ?? [] })}
      <div class="grid cols-2">${fld('availability', 'Availability', { value: a?.availability, max: 500 })}${fld('capacity', 'How many mentees at a time?', { type: 'number', min: 1, value: a?.capacity ?? 3, hint: '1 to 20.' })}</div>
      ${fld('references_text', 'References (optional)', { type: 'textarea', rows: 3, value: a?.references_text, max: 2000 })}
      ${fld('conflict_declaration', 'Conflict-of-interest declaration', { type: 'textarea', rows: 3, value: a?.conflict_declaration, max: 1000, hint: 'Write "None" if there is none.' })}
      ${fld('coc_accepted', 'I accept the mentor code of conduct (confidentiality, respect, no exploitation of mentees)', { type: 'checkbox', value: a?.coc_accepted })}`, 'Save draft')}</section>
      <section class="card mt"><h2>Credentials</h2>${uploadForm([['mentor_credential', 'CV / credential'], ['professional_certificate', 'Professional certificate'], ['reference', 'Reference letter']], { id: 'mentor' })}<div class="mt">${docsTable(documents)}</div></section>
      ${a ? h`<section class="card mt"><h2>Submit</h2><p>Submitting locks the form while reviewers decide.</p><button class="btn" type="button" data-action="mentor-submit">Submit application</button></section>` : ''}`
    : h`<section class="card mt">${kv([['Organisation', a.organization], ['Position', a.position], ['Biography', lines(a.bio)], ['Expertise', a.expertise.join(', ')], ['Industries', a.industries.join(', ')], ['Capacity', a.capacity]])}</section>`}
    ${a && !['draft', 'withdrawn', 'rejected'].includes(a.status) ? h`<p class="mt"><button class="btn danger" type="button" data-action="mentor-withdraw" data-confirm="Withdraw your mentor application? Pending requests to you will be cancelled.">Withdraw application</button></p>` : ''}`);
});
forms['mentor-app'] = async (d) => { await PUT('/api/mentor/application', { ...d, capacity: d.capacity ?? 3 }); await refresh(); toast('Draft saved.', 'ok'); };
actions['mentor-submit'] = async () => { await POST('/api/mentor/application/submit'); state.user = (await GET('/api/auth/me')).user; await refresh(); toast('Application submitted.', 'ok'); };
actions['mentor-withdraw'] = async () => { await POST('/api/mentor/application/withdraw'); state.user = (await GET('/api/auth/me')).user; await refresh(); toast('Application withdrawn.', 'ok'); };
