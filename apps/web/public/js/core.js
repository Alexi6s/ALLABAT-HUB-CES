// Router, application shell, and delegated event handling. Pages register routes/actions/forms here.
import { h, html, raw, GET, POST, ApiError, toast, esc, formData, showFormErrors, notice, label } from './lib.js';

export const state = { user: null, meta: null, dash: null };
const table = [];
export const actions = {};
export const forms = {};

/** route('/ventures/:id', async ({params, query}) => view('Title', body), { public, layout, perm }) */
export function route(pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-z_]+)/gi, (_, k) => (keys.push(k), '([^/]+)')) + '/?$');
  table.push({ re, keys, handler, opts, pattern });
}
export const view = (title, body, o = {}) => ({ title, body, ...o });
export const pageHead = (title, o = {}) => h`${o.crumbs ? h`<nav class="crumbs" aria-label="Breadcrumb">${o.crumbs}</nav>` : ''}<div class="pagehead"><div><h1 tabindex="-1">${title}</h1>${o.sub ? h`<p>${o.sub}</p>` : ''}</div><div class="row">${o.actions ? o.actions : ''}</div></div>`;

export const parseHash = () => {
  const raw_ = location.hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = raw_.split('?');
  return { path: path || '/', query: new URLSearchParams(qs) };
};
export const go = (path) => { if (location.hash === '#' + path) render(); else location.hash = '#' + path; };
export const refresh = () => render({ keepScroll: true });
export const can = (perm) => !!state.user?.permissions?.includes(perm);
export const verified = () => state.user?.verification_status === 'verified';

// ---------- navigation model ----------
// Two workspaces share one shell. The member area is for building a venture and using programmes; the administration area is
// for staff. Which one you are in follows the page you are on, and the menu only ever lists what your permissions allow.
export const isStaff = () => can('portal.admin');
/** A staff account (registered as staff, or not verified as a member): it has no member work to show, so it lands in administration. */
export const staffOnly = () => isStaff() && (state.user?.category === 'staff' || !verified());
export const workspaceOf = (path) => (path === '/admin' || path.startsWith('/admin/') ? 'admin' : 'member');
export const homePath = () => (staffOnly() ? '/admin' : '/dashboard');

// Item: [href, text, count, permission, condition]. "Exact" hrefs highlight only on that page, never for pages below them.
const EXACT = new Set(['/dashboard', '/admin']);
const MEMBER_NAV = () => [
  { title: 'Me', items: [['/dashboard', 'Dashboard', undefined, undefined, () => !staffOnly()], ['/profile', 'Profile'], ['/verification', 'Verification', undefined, undefined, () => state.user?.category !== 'staff'], ['/notifications', 'Notifications', state.dash?.counts?.unread_notifications], ['/support', 'Help & support'], ['/help', 'Help centre'], ['/role-requests', 'Request a staff role', undefined, undefined, () => verified() && state.user?.category !== 'staff']] },
  { member: true, title: 'Build', items: [['/ventures', 'My ventures'], ['/milestones', 'Milestones', state.dash?.counts?.overdue_milestones], ['/resources', 'Resource library'], ['/my-resources', 'My resource drafts', undefined, 'resource.create']] },
  { member: true, title: 'Programmes', items: [['/programmes', 'Programmes'], ['/workshops', 'Workshops']] },
  { member: true, title: 'Funding', items: [['/funding', 'Funding']] },
  { member: true, title: 'Mentoring', items: [['/mentors', 'Find a mentor'], ['/mentorship', 'My mentorship', state.dash?.counts?.pending_mentor_requests], ['/mentor/apply', 'Mentor application']] },
];
const ADMIN_NAV = (q = {}) => [
  { title: 'Overview', items: [['/admin', 'Overview', undefined, 'portal.admin'], ['/notifications', 'Notifications', state.dash?.counts?.unread_notifications]] },
  { title: 'Review queues', items: [
    ['/admin/verification', 'Verification', q.verification, 'verification.review'],
    ['/admin/mentors', 'Mentor applications', q.mentor_applications, 'mentor.review'],
    ['/admin/ventures', 'Venture reviews', q.ventures, 'venture.review'],
    ['/admin/milestones', 'Milestone reviews', q.milestones, 'milestone.review'],
    ['/admin/programmes', 'Programme applications', q.programme_applications, 'programme.manage'],
    ['/admin/funding', 'Funding', q.funding, 'funding.manage'],
    ['/admin/support', 'Support inbox', q.support, 'support.manage'],
    ['/admin/mentoring', 'Mentoring oversight', undefined, 'mentor.review'],
  ] },
  { title: 'Manage', items: [['/admin/workshops', 'Workshops', undefined, 'workshop.manage'], ['/admin/resources', 'Resources', undefined, 'resource.publish'], ['/admin/reports', 'Reports', undefined, 'report.view']] },
  { title: 'Administration', items: [
    ['/admin/users', 'Users & roles', undefined, 'user.manage'], ['/admin/role-requests', 'Role requests', undefined, 'user.manage'], ['/admin/audit', 'Audit log', undefined, 'audit.view'], ['/admin/config', 'Settings', undefined, 'config.manage'],
  ] },
  { title: 'Account', items: [['/profile', 'Profile'], ['/support', 'Help & support'], ['/help', 'Help centre']] },
];

function nav(path) {
  const admin = workspaceOf(path) === 'admin';
  const q = state.dash?.queues ?? {};
  const allow = (i) => (!i[3] || can(i[3])) && (!i[4] || i[4]());
  const groups = (admin ? ADMIN_NAV(q) : MEMBER_NAV())
    .filter((g) => !(g.member && staffOnly()))
    .map((g) => ({ ...g, items: g.items.filter(allow) })).filter((g) => g.items.length);
  const here = (href) => path === href || (!EXACT.has(href) && path.startsWith(href + '/'));
  const switcher = admin
    ? (staffOnly() ? '' : h`<a class="switch" href="#/dashboard"><span>Switch to member area</span></a>`)
    : (isStaff() ? h`<a class="switch" href="#/admin"><span>Switch to administration</span></a>` : '');
  return h`<nav class="sidenav" id="sidenav" aria-label="${admin ? 'Administration' : 'Main'}"><button class="btn secondary small" id="closemenu" type="button">Close menu</button>${switcher}${groups.map((g) => h`<h2>${g.title}</h2>${g.items.map(([href, text, n]) => h`<a href="#${href}"${here(href) ? raw(' aria-current="page"') : ''}><span>${text}</span>${n ? h`<span class="count" aria-label="${n} waiting">${n}</span>` : ''}</a>`)}`)}</nav>`;
}

function shell(content, path) {
  const u = state.user;
  const unread = state.dash?.counts?.unread_notifications ?? 0;
  return h`<div class="shell">
    <header class="topbar">
      <button class="iconbtn" id="openmenu" type="button" aria-controls="sidenav" aria-expanded="false">Menu</button>
      <a class="brand" href="#${homePath()}" aria-label="ALABATT-CES home"><img src="/logo.png" alt="" width="36" height="36"><span class="brandtext">ALABATT-CES</span></a>
      <span class="spacer"></span>
      <a class="bell" href="#/notifications">Alerts${unread ? h`<span class="count" aria-label="${unread} unread">${unread}</span>` : ''}</a>
      <span class="small nowrap who" title="${u.email}">${u.full_name}</span>
      <button class="iconbtn" type="button" data-action="logout">Sign out</button>
    </header>
    ${nav(path)}
    <div class="scrim" data-action="closemenu"></div>
    <main id="main" tabindex="-1" data-route="${path}">${content}</main>
  </div>`;
}

const authLayout = (content, path = '') => h`<div class="authwrap"><main id="main" tabindex="-1" class="authcard card wide" data-route="${path}"><img class="authlogo" src="/logo.png" alt="Benue State University logo" width="96" height="96">${content}</main></div>`;

// ---------- rendering ----------
let renderToken = 0;
let loadingTimer = 0;
export async function render({ keepScroll = false } = {}) {
  const token = ++renderToken;
  const { path, query } = parseHash();
  const app = document.getElementById('app');
  document.body.classList.remove('nav-open');
  const match = table.map((r) => ({ r, m: r.re.exec(path) })).find((x) => x.m);
  if (!match) {
    app.innerHTML = html(state.user ? shell(h`<div class="empty"><h1>Page not found</h1><p>That page does not exist.</p><a class="btn" href="#${homePath()}">Go to my home page</a></div>`, path) : authLayout(h`<h1>Page not found</h1><a href="#/login">Sign in</a>`));
    return;
  }
  const { r, m } = match;
  const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
  if (!r.opts.public && !state.user) { sessionStorageSafe('next', location.hash); return go('/login'); }
  if (r.opts.public && state.user && r.opts.redirectIfAuthed) return go(homePath());
  // Only if the page is slow: show a loading state in place. Fast pages never flash it, and a newer render cancels it via the token.
  clearTimeout(loadingTimer);
  if (!keepScroll) loadingTimer = setTimeout(() => { if (token === renderToken) { const el = document.getElementById('main'); if (el) el.innerHTML = '<div class="loading" role="status">Loading…</div>'; } }, 250);
  let result;
  try {
    if (state.user && !r.opts.public) {
      // Keep the badges and queue counts current without blocking the page for long.
      state.dash = await GET('/api/dashboard').catch(() => state.dash);
      if (token !== renderToken) return;
    }
    if (state.user && !r.opts.public && state.user.account_status && state.user.account_status !== 'active' && !INACTIVE_OK.test(path)) {
      result = accountStatusView(state.user.account_status);
    } else if (r.opts.perm && !can(r.opts.perm)) {
      result = noAccessView(r.opts.perm);
    } else {
      result = await r.handler({ params, query, path });
    }
  } catch (e) {
    if (token !== renderToken) return;
    if (e instanceof ApiError && e.status === 401 && state.user) { state.user = null; return go('/login'); }
    result = errorView(e);
  }
  if (token !== renderToken) return;
  clearTimeout(loadingTimer);
  const body = result.body;
  const inner = result.head === false ? body : h`${result.title ? pageHead(result.title, result) : ''}${body}`;
  const page = r.opts.layout === 'auth' || !state.user ? authLayout(inner, path) : shell(inner, path);
  const y = window.scrollY;
  app.innerHTML = html(page);
  document.title = `${result.title ? result.title + ' · ' : ''}ALABATT-CES`;
  if (keepScroll) window.scrollTo(0, y);
  else { window.scrollTo(0, 0); (app.querySelector('main h1') ?? app.querySelector('main'))?.focus({ preventScroll: true }); }
}

// A suspended account can still sign in and reach support (that is how a person appeals), but nothing else.
const INACTIVE_OK = /^\/(support|help)(\/|$)/;
const STATUS_TEXT = {
  suspended: 'Your account is suspended. You cannot use programmes, funding or mentoring while it is suspended. You can still read your support requests and write to the support team to ask for a review.',
  disabled: 'Your account is disabled.', closed: 'Your account is closed.',
};
function accountStatusView(status) {
  return { title: `Your account is ${label(status)}`, body: h`${notice('bad', STATUS_TEXT[status] ?? `Your account is ${label(status)}.`)}
    <p class="mt"><a class="btn" href="#/support">Contact support</a> <button class="btn secondary" type="button" data-action="logout">Sign out</button></p>` };
}
/** The page exists but this role is not allowed to use it. Says so plainly and points somewhere useful. */
function noAccessView(perm) {
  const staffPage = perm !== 'resource.create';
  return { title: 'No access', body: h`<div class="empty"><h1 tabindex="-1">You do not have access to this page</h1>
    <p>${staffPage ? 'This area is for staff with a matching role. Your account does not have one, so nothing here is available to you.' : 'Your account does not have the role this page needs.'}</p>
    <p class="small muted">If you think this is a mistake, write to support from <a href="#/support">Help &amp; support</a>${verified() ? h` or <a href="#/role-requests">request a staff role</a>` : ''}. Access is checked on the server for every request, so hiding or showing a link does not change what you can do.</p>
    <a class="btn" href="#${homePath()}">Go to my home page</a></div>`, head: false };
}

function errorView(e) {
  if (e instanceof ApiError) {
    if (e.code === 'account_inactive') return accountStatusView(state.user?.account_status ?? 'suspended');
    if (e.code === 'email_unverified') return { title: 'Confirm your email first', body: notice('warn', h`Confirm your email address to use this feature. <a href="#/profile">Open your profile</a> to see how.`) };
    if (e.code === 'not_verified') return { title: 'Verification needed', body: notice('warn', h`This feature is open to verified members. <a href="#/verification">Complete your verification</a> to continue.`) };
    if (e.status === 403) return { title: 'No access', body: notice('bad', h`${e.message}`) };
    if (e.status === 404) return { title: 'Not found', body: notice('bad', h`${e.message} <a href="#/dashboard">Back to dashboard</a>`) };
    return { title: 'Something went wrong', body: h`${notice('bad', h`${e.message}`)}<p class="mt"><button class="btn secondary" type="button" data-action="reload">Try again</button></p>` };
  }
  console.error(e);
  return { title: 'Something went wrong', body: h`${notice('bad', 'Unexpected error while showing this page.')}<p class="mt"><button class="btn secondary" type="button" data-action="reload">Try again</button></p>` };
}

function sessionStorageSafe(k, v) { try { sessionStorage.setItem(k, v); } catch { /* storage unavailable */ } }
export const takeNext = () => { try { const v = sessionStorage.getItem('next'); sessionStorage.removeItem('next'); return v; } catch { return null; } };

// ---------- delegated events ----------
Object.assign(actions, {
  reload: () => refresh(),
  closemenu: () => document.body.classList.remove('nav-open'),
  logout: async () => { try { await POST('/api/auth/logout'); } finally { state.user = null; state.dash = null; go('/login'); } },
});

async function runBusy(el, fn) {
  const was = el.disabled;
  el.disabled = true;
  el.setAttribute('aria-busy', 'true');
  try { return await fn(); } finally { el.disabled = was; el.removeAttribute('aria-busy'); }
}

export function installEvents() {
  document.addEventListener('click', async (ev) => {
    const t = ev.target instanceof Element ? ev.target : null;
    if (!t) return;
    if (t.closest('#openmenu')) {
      const open = document.body.classList.toggle('nav-open');
      t.closest('#openmenu').setAttribute('aria-expanded', String(open));
      if (open) document.querySelector('#sidenav a, #closemenu')?.focus();
      return;
    }
    if (t.closest('#closemenu')) { document.body.classList.remove('nav-open'); document.getElementById('openmenu')?.focus(); return; }
    if (document.body.classList.contains('nav-open') && (t.closest('main') || t.closest('.sidenav a'))) document.body.classList.remove('nav-open');
    // Clicking a link to the page you are already on re-fetches it (no hashchange fires in that case).
    const link = t.closest('a[href^="#/"]');
    if (link && link.getAttribute('href') === (location.hash || '#/')) { render(); return; }
    const el = t.closest('[data-action]');
    if (!el) return;
    const fn = actions[el.dataset.action];
    if (!fn) return;
    if (el.tagName === 'A') ev.preventDefault();
    if (el.dataset.confirm && !window.confirm(el.dataset.confirm)) return;
    try { await runBusy(el, () => fn(el, ev)); } catch (e) { toast(e.message ?? 'Something went wrong.', 'bad'); }
  });
  document.addEventListener('submit', async (ev) => {
    const form = ev.target;
    if (!(form instanceof HTMLFormElement) || !form.dataset.form) return;
    ev.preventDefault();
    const fn = forms[form.dataset.form];
    if (!fn) return;
    const btn = form.querySelector('button[type="submit"]');
    showFormErrors(form, null);
    try { await runBusy(btn ?? form, () => fn(formData(form), form)); } catch (e) {
      if (e instanceof ApiError) showFormErrors(form, e); else { console.error(e); toast('Something went wrong.', 'bad'); }
    }
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && document.body.classList.contains('nav-open')) { document.body.classList.remove('nav-open'); document.getElementById('openmenu')?.focus(); }
  });
  window.addEventListener('hashchange', () => render());
}

// Generic GET-style filter form: <form data-form="filter" data-path="/admin/audit">
forms.filter = (data, form) => {
  const qs = new URLSearchParams(Object.entries(data).filter(([, v]) => v !== '' && v !== false).map(([k, v]) => [k, String(v)]));
  go(`${form.dataset.path}${qs.toString() ? '?' + qs : ''}`);
};

/** Helper for pages: perform a mutation, toast, then re-render. */
export async function act(fn, okMsg) {
  const r = await fn();
  await refresh();
  if (okMsg) toast(okMsg, 'ok');
  return r;
}
export const ctxLabel = label;
