// Shared client library: escaping template tag, API client, form helpers, formatting, toasts.
// Everything dynamic is HTML-escaped by `h`; only values wrapped with raw() or produced by h itself are trusted.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(String(s));
const part = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(part).join('') : v === null || v === undefined || v === false ? '' : esc(v));
export const h = (strings, ...vals) => new Raw(strings.reduce((out, s, i) => out + s + (i < vals.length ? part(vals[i]) : ''), ''));
export const html = (v) => part(v);

/** Only http(s) links and in-app hashes may be placed in href attributes. */
export const safeUrl = (u) => (/^(https?:\/\/|#\/)/i.test(String(u ?? '')) ? String(u) : '#/');

// ---------- API ----------
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? `Request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code ?? 'error';
    this.details = body?.error?.details;
  }
}
export async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method, credentials: 'same-origin',
      headers: { 'X-Requested-With': 'ALABATT', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, { error: { code: 'network', message: 'Cannot reach the server. Check your connection and try again.' } });
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}
export const GET = (p) => api('GET', p);
export const POST = (p, b = {}) => api('POST', p, b);
export const PUT = (p, b = {}) => api('PUT', p, b);
export const PATCH = (p, b = {}) => api('PATCH', p, b);
export const DEL = (p) => api('DELETE', p);

export async function uploadFile(file, category, extra = {}) {
  if (!file || !file.size) throw new ApiError(0, { error: { message: 'Choose a file first.' } });
  const res = await fetch('/api/documents', {
    method: 'POST', credentials: 'same-origin', body: file,
    headers: { 'X-Requested-With': 'ALABATT', 'Content-Type': 'application/octet-stream', 'X-Category': category, 'X-Filename': encodeURIComponent(file.name), ...extra },
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// ---------- formatting ----------
export const label = (s) => String(s ?? '').replace(/_/g, ' ');
export const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
export const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
export const money = (n, cur = 'NGN') => (n === null || n === undefined ? '—' : `${cur} ${Number(n).toLocaleString()}`);
export const toInputDateTime = (iso) => { if (!iso) return ''; const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
export const toInputDate = (iso) => (iso ? toInputDateTime(iso).slice(0, 10) : '');

const TONE = {
  ok: ['verified', 'approved', 'accepted', 'completed', 'published', 'open', 'registered', 'incubating', 'active', 'signed', 'disbursed', 'resolved', 'graduated', 'basic_checks_passed', 'scanned_clean', 'in_progress', 'done'],
  warn: ['pending', 'submitted', 'under_review', 'under_evaluation', 'eligibility_review', 'more_info_required', 'changes_requested', 'waitlisted', 'draft', 'blocked', 'unverified', 'suspended', 'self_reported', 'not_started', 'high', 'scheduled'],
  bad: ['rejected', 'quarantined', 'disabled', 'closed', 'cancelled', 'declined', 'withdrawn', 'overdue', 'urgent', 'missed'],
  info: ['verified_by_reviewer'],
};
export const badge = (s) => {
  const tone = Object.keys(TONE).find((k) => TONE[k].includes(s)) ?? '';
  return h`<span class="badge ${tone}">${label(s)}</span>`;
};

// ---------- UI pieces ----------
export const toast = (msg, kind = '') => {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  box.append(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 8000 : 4500);
};
export const empty = (msg, action = '') => h`<div class="empty"><p>${msg}</p>${raw(html(action))}</div>`;
export const notice = (kind, body) => h`<div class="notice ${kind}" role="${kind === 'bad' ? 'alert' : 'note'}">${body}</div>`;
export const table = (cols, rows, emptyMsg = 'Nothing here yet.') =>
  rows.length
    ? h`<div class="table-wrap"><table><thead><tr>${cols.map((c) => h`<th scope="col">${c.label}</th>`)}</tr></thead><tbody>${rows.map((r) => h`<tr>${cols.map((c) => h`<td>${c.render ? c.render(r) : r[c.key]}</td>`)}</tr>`)}</tbody></table></div>`
    : empty(emptyMsg);
export const kv = (pairs) => h`<dl class="kv">${pairs.filter(([, v]) => v !== undefined).map(([k, v]) => h`<dt>${k}</dt><dd>${v ?? '—'}</dd>`)}</dl>`;

/**
 * Form field builder. opts: type, value, required, options [[value,label]], hint, rows, max, list (comma separated), checks (multi-select values), autocomplete
 */
let fieldSeq = 0;
export function fld(name, text, o = {}) {
  const id = `f-${name}-${++fieldSeq}`; // unique per rendered field, even when the same name appears in several forms on one page
  const common = raw(`id="${id}" name="${esc(name)}"${o.required ? ' required' : ''}${o.max ? ` maxlength="${Number(o.max)}"` : ''}${o.autocomplete ? ` autocomplete="${esc(o.autocomplete)}"` : ''} aria-describedby="${id}-hint ${id}-err"`);
  const v = o.value ?? '';
  let control;
  switch (o.type) {
    case 'textarea': control = h`<textarea ${common} rows="${o.rows ?? 4}">${v}</textarea>`; break;
    case 'select': control = h`<select ${common}>${(o.blank ? [['', o.blank]] : []).concat(o.options ?? []).map(([val, t]) => h`<option value="${val}"${String(val) === String(v) ? raw(' selected') : ''}>${t}</option>`)}</select>`; break;
    case 'checkbox': return h`<div class="field"><label><input type="checkbox" id="${id}" name="${name}"${v ? raw(' checked') : ''}${o.required ? raw(' required') : ''} aria-describedby="${id}-err">${text}${o.required ? raw('<span class="req"></span>') : ''}</label><div class="hint" id="${id}-hint">${o.hint ?? ''}</div><div class="err" id="${id}-err" data-err="${name}"></div></div>`;
    case 'checks': return h`<fieldset class="field"><legend>${text}</legend><div class="checks" data-checks="${name}">${(o.options ?? []).map(([val, t]) => h`<label><input type="checkbox" name="${name}" value="${val}"${(o.value ?? []).includes(val) ? raw(' checked') : ''}>${t}</label>`)}</div><div class="hint" id="${id}-hint">${o.hint ?? ''}</div><div class="err" id="${id}-err" data-err="${name}"></div></fieldset>`;
    default: control = h`<input type="${o.type ?? 'text'}" ${common} value="${o.list && Array.isArray(v) ? v.join(', ') : v}"${o.list ? raw(' data-list="1"') : ''}${o.min !== undefined ? raw(` min="${Number(o.min)}"`) : ''}${o.step ? raw(` step="${Number(o.step)}"`) : ''}>`;
  }
  return h`<div class="field"><label for="${id}"${o.required ? raw(' class="req"') : ''}>${text}</label>${control}<div class="hint" id="${id}-hint">${o.hint ?? ''}</div><div class="err" id="${id}-err" data-err="${name}"></div></div>`;
}

/** Collects a form into a plain object; empty values are left out so the server treats them as "not provided". */
export function formData(form) {
  const out = {};
  const seenChecks = new Set();
  for (const el of form.elements) {
    if (!el.name || el.disabled || el.type === 'submit' || el.type === 'button' || el.type === 'file') continue;
    if (el.closest('[data-checks]')) {
      if (!seenChecks.has(el.name)) { seenChecks.add(el.name); out[el.name] = []; }
      if (el.checked) out[el.name].push(el.value);
      continue;
    }
    if (el.type === 'checkbox') { out[el.name] = el.checked; continue; }
    const v = el.value.trim();
    if (v === '') continue;
    if (el.type === 'number') out[el.name] = Number(v);
    else if (el.type === 'datetime-local' || (el.type === 'date' && el.dataset.iso)) out[el.name] = new Date(v).toISOString();
    else if (el.type === 'date') out[el.name] = new Date(`${v}T12:00:00`).toISOString();
    else if (el.dataset.list) out[el.name] = v.split(',').map((s) => s.trim()).filter(Boolean);
    else out[el.name] = v;
  }
  return out;
}

export function showFormErrors(form, err) {
  for (const e of form.querySelectorAll('.err')) e.textContent = '';
  for (const i of form.querySelectorAll('[aria-invalid]')) i.removeAttribute('aria-invalid');
  const box = form.querySelector('.form-error');
  if (box) { box.textContent = ''; box.hidden = true; }
  if (!err) return;
  let placed = false;
  if (err.details && typeof err.details === 'object') {
    for (const [k, msg] of Object.entries(err.details)) {
      const key = form.querySelector(`[data-err="${CSS.escape(k)}"]`) ? k : `q_${k}`; // programme questions are named q_<id>
      const target = form.querySelector(`[data-err="${CSS.escape(key)}"]`);
      if (target) {
        target.textContent = String(msg);
        form.querySelector(`[name="${CSS.escape(key)}"]`)?.setAttribute('aria-invalid', 'true');
        placed = true;
      }
    }
  }
  if (box) {
    box.hidden = false;
    box.textContent = placed ? 'Please fix the highlighted fields.' : err.message;
  }
  const first = form.querySelector('[aria-invalid="true"]') ?? box;
  first?.focus?.();
}
export const formShell = (inner, submit = 'Save', extra = '') => h`${raw('')}<div class="form-error notice bad" role="alert" tabindex="-1" hidden></div>${inner}<div class="row"><button class="btn" type="submit">${submit}</button>${raw(html(extra))}</div>`;
