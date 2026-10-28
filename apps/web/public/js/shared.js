// Helpers shared by several page modules: document upload/list, venture picker, common option lists.
import { h, raw, esc, fld, formShell, GET, POST, DEL, uploadFile, table, badge, label, fmtDate, fmtDateTime, toast } from './lib.js';
import { actions, forms, refresh } from './core.js';

export const STAGES = [['idea', 'Idea'], ['validation', 'Validation'], ['prototype', 'Prototype'], ['launch', 'Launch'], ['growth', 'Growth']];
export const CATEGORIES = [
  ['student', 'Student'], ['lecturer', 'Lecturer / staff'], ['alumni', 'Alumni'], ['external_entrepreneur', 'External entrepreneur'],
  ['external_participant', 'External participant'], ['partner', 'Partner'], ['mentor_applicant', 'Mentor applicant'],
];
export const DOC_LABELS = {
  student_id: 'Student ID', staff_id: 'Staff ID', enrollment_evidence: 'Enrollment evidence', alumni_evidence: 'Alumni evidence', identity_document: 'Identity document',
  organization_evidence: 'Organisation evidence', professional_certificate: 'Professional certificate', mentor_credential: 'Mentor credential / CV', reference: 'Reference letter',
  business_registration: 'Business registration', venture_document: 'Venture document', funding_attachment: 'Funding attachment', milestone_evidence: 'Milestone evidence', resource_file: 'Resource file',
};
export const docLabel = (c) => DOC_LABELS[c] ?? label(c);
export const SUPPORT_CATEGORIES = [['general', 'General'], ['account', 'My account'], ['verification', 'Verification'], ['programme', 'Programmes'], ['funding', 'Funding'], ['mentoring', 'Mentoring'], ['technical', 'Something is not working'], ['privacy', 'My data and privacy']];

/** Upload form. `categories` is [[value,label]]; context headers are carried in data attributes. */
export const uploadForm = (categories, o = {}) => h`<form data-form="upload-doc" class="inline-form" data-context="${o.context ?? ''}" data-context-id="${o.contextId ?? ''}" novalidate>
  <div class="form-error notice bad" role="alert" tabindex="-1" hidden></div>
  ${categories.length > 1 ? fld('category', 'Document type', { type: 'select', options: categories, required: true }) : h`<input type="hidden" name="category" value="${categories[0][0]}">`}
  <div class="field"><label for="f-file-${o.id ?? 'x'}" class="req">${o.label ?? 'File (PDF, PNG or JPEG, up to 5 MB)'}</label><input id="f-file-${o.id ?? 'x'}" name="file" type="file" accept="application/pdf,image/png,image/jpeg" required></div>
  <button class="btn secondary" type="submit">Upload</button></form>`;

forms['upload-doc'] = async (d, form) => {
  const file = form.elements.file.files[0];
  const extra = {};
  if (form.dataset.context) extra['X-Context'] = form.dataset.context;
  if (form.dataset.contextId) extra['X-Context-Id'] = form.dataset.contextId;
  const r = await uploadFile(file, d.category, extra);
  toast(r.scan_status === 'quarantined' ? 'The file failed safety checks and was quarantined. Upload a clean copy.' : 'File uploaded.', r.scan_status === 'quarantined' ? 'bad' : 'ok');
  await refresh();
};

export const docsTable = (docs, { deletable = true } = {}) => table([
  { label: 'File', render: (d) => h`<a href="/api/documents/${d.id}/download">${d.original_name}</a>` },
  { label: 'Type', render: (d) => docLabel(d.category) },
  { label: 'Size', render: (d) => `${Math.max(1, Math.round(d.size / 1024))} KB` },
  { label: 'Safety check', render: (d) => (d.scan_status === 'quarantined' ? badge('quarantined') : h`<span class="badge ok">basic checks passed</span>`) },
  { label: 'Uploaded', render: (d) => fmtDate(d.created_at) },
  ...(deletable ? [{ label: '', render: (d) => h`<button class="btn secondary small" type="button" data-action="delete-doc" data-id="${d.id}" data-confirm="Delete this file?">Delete</button>` }] : []),
], docs, 'No files uploaded yet.');

actions['delete-doc'] = async (el) => {
  await DEL(`/api/documents/${el.dataset.id}`);
  toast('File deleted.', 'ok');
  await refresh();
};

export const myVentures = async () => (await GET('/api/ventures')).ventures;
export const ventureSelect = (ventures, o = {}) => fld(o.name ?? 'venture_id', o.label ?? 'Venture', { type: 'select', options: ventures.map((v) => [v.id, `${v.name} (${label(v.status)})`]), blank: o.blank ?? 'Choose a venture…', required: o.required, value: o.value, hint: o.hint });
export const optionsOf = (list) => list.map((x) => (Array.isArray(x) ? x : [x, label(x)]));
export const lines = (text) => (text ? h`<p class="pre">${text}</p>` : h`<p class="muted">—</p>`);

/** Step-up confirmation: high-impact actions ask for the person's own password again. The server checks it. */
export const stepUp = (hint = 'Re-enter your password to confirm this action. It is checked on the server.') =>
  fld('confirm_password', 'Your password', { type: 'password', required: true, autocomplete: 'current-password', hint });

/** Previous / next links for a paged list. `page` is the API's { total, limit, offset, has_more }; `path` and `query` rebuild the URL. */
export const pager = (page, path, query) => {
  if (!page || (page.offset === 0 && !page.has_more)) return page ? h`<p class="small muted mt">${page.total} ${page.total === 1 ? 'result' : 'results'}.</p>` : '';
  const link = (offset) => { const qs = new URLSearchParams([...query].filter(([k, v]) => v && k !== 'offset')); if (offset > 0) qs.set('offset', String(offset)); return `#${path}${qs.toString() ? '?' + qs : ''}`; };
  const from = page.total === 0 ? 0 : page.offset + 1, to = Math.min(page.offset + page.limit, page.total);
  return h`<nav class="pager row between mt" aria-label="Pages"><span class="small muted">Showing ${from}–${to} of ${page.total}</span><span class="row">
    ${page.offset > 0 ? h`<a class="btn secondary small" href="${link(Math.max(0, page.offset - page.limit))}">Previous</a>` : ''}${page.has_more ? h`<a class="btn secondary small" href="${link(page.offset + page.limit)}">Next</a>` : ''}</span></nav>`;
};

/** Query string for a list page: keeps only the keys the page understands, so a hand-edited URL cannot add anything else. */
export const keep = (query, keys) => new URLSearchParams(keys.filter((k) => query.get(k)).map((k) => [k, query.get(k)]));

/** Staff who can take an assignment, for a picker. Loaded lazily once per render by the pages that need it. */
export const staffFor = async (permission) => (await GET(`/api/admin/staff?permission=${encodeURIComponent(permission)}`)).staff;

/** <form data-form="name" data-xyz="..."> with every data attribute value escaped. */
export const form = (name, inner, submit = 'Save', data = {}) =>
  h`<form data-form="${name}" novalidate ${raw(Object.entries(data).map(([k, v]) => `data-${esc(k)}="${esc(v)}"`).join(' '))}>${formShell(inner, submit)}</form>`;

/** A support conversation. Internal notes are only ever present in staff responses and are labelled as such. */
export const thread = (messages) => h`<ol class="thread plain" aria-label="Conversation">${messages.map((m) => h`<li class="msg ${m.kind}"><div class="row between"><strong>${m.author}${m.kind === 'internal' ? ' (internal note, hidden from the requester)' : ''}</strong><span class="small muted">${fmtDateTime(m.created_at)}</span></div><p class="pre">${m.body}</p></li>`)}</ol>`;

const ASSIGN_PATH = { programme: (id) => `/api/admin/programme-applications/${id}/assign`, funding: (id) => `/api/admin/funding/applications/${id}/assign`, support: (id) => `/api/admin/support/${id}/assign` };
/** One small form to set or clear the person a review item is assigned to. `staff` comes from staffFor(permission). */
export const assignForm = (kind, id, staff, current) => form('assign', fld('assignee_id', 'Assigned to', { type: 'select', options: staff.map((s) => [s.id, s.full_name]), blank: 'Unassigned', value: current ?? '' }), 'Save assignment', { id, kind });
forms.assign = async (d, f) => { await POST(ASSIGN_PATH[f.dataset.kind](f.dataset.id), { assignee_id: d.assignee_id }); await refresh(); toast(d.assignee_id ? 'Assigned.' : 'Assignment cleared.', 'ok'); };
