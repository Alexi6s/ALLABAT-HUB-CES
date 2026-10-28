// Entry point: boots the app and defines authentication, dashboard, notifications and policy pages.
import { h, html, raw, GET, POST, PUT, fld, formShell, notice, badge, label, fmtDateTime, empty, esc, toast } from './lib.js';
import { state, route, view, actions, forms, go, installEvents, render, refresh, takeNext, can, homePath, staffOnly } from './core.js';
import './pages-user.js';
import './pages-programmes.js';
import './pages-admin.js';
import './pages-ops.js';

const emailWorks = () => !!state.meta?.capabilities?.email_delivery;
const noEmailNote = () => emailWorks() ? '' : notice('warn', h`<strong>Email delivery is not configured on this installation.</strong> No message will be sent. An administrator can confirm your email address or help you reset your password.`);

const CATEGORY_OPTIONS = [
  ['student', 'Student'], ['lecturer', 'Lecturer / staff'], ['alumni', 'Alumnus / alumna'], ['external_entrepreneur', 'External entrepreneur'],
  ['external_participant', 'External participant'], ['partner', 'Partner organisation'], ['mentor_applicant', 'Mentor applicant'],
];

// ---------- authentication ----------
route('/login', () => view('Sign in', h`
  <p class="muted">Welcome to ALABATT-CES, the entrepreneurship support platform of ALABATT-HUB.</p>
  <form data-form="login" novalidate class="stack-sm">
    <div class="form-error notice bad" role="alert" tabindex="-1" hidden></div>
    ${fld('email', 'Email', { type: 'email', required: true, autocomplete: 'username' })}
    ${fld('password', 'Password', { type: 'password', required: true, autocomplete: 'current-password' })}
    <div class="row"><button class="btn" type="submit">Sign in</button><a href="#/forgot">Forgot password?</a></div>
  </form>
  <hr><p>New here? <a href="#/register">Create an account</a></p>`, { head: true }), { public: true, layout: 'auth', redirectIfAuthed: true });

forms.login = async (d) => {
  const r = await POST('/api/auth/login', d);
  state.user = r.user;
  const next = takeNext();
  go(next && !/^#\/(login|register|forgot)/.test(next) ? next.slice(1) : homePath());
};

route('/register', () => view('Create your account', h`
  <p class="muted">Your category decides what evidence we ask for. Access to programmes, funding and mentoring opens after your identity or affiliation is verified.</p>
  <form data-form="register" novalidate>
    <div class="form-error notice bad" role="alert" tabindex="-1" hidden></div>
    ${fld('full_name', 'Full name', { required: true, autocomplete: 'name', max: 120 })}
    ${fld('email', 'Email', { type: 'email', required: true, autocomplete: 'email' })}
    ${fld('password', 'Password', { type: 'password', required: true, autocomplete: 'new-password', hint: 'At least 10 characters, with a letter and a number.' })}
    ${fld('category', 'I am registering as', { type: 'select', required: true, options: CATEGORY_OPTIONS, blank: 'Choose…' })}
    ${fld('organization', 'Organisation', { hint: 'Required for partner organisations.', max: 160 })}
    ${fld('phone', 'Phone (optional)', { type: 'tel', autocomplete: 'tel', max: 30 })}
    ${fld('country', 'Country (optional)', { autocomplete: 'country-name', max: 80 })}
    ${fld('accept_terms', h`I have read the <a href="#/policies" target="_blank" rel="noopener">terms and privacy notice</a> (draft).`, { type: 'checkbox', required: true })}
    <div class="row"><button class="btn" type="submit">Create account</button><a href="#/login">I already have an account</a></div>
  </form>`), { public: true, layout: 'auth', redirectIfAuthed: true });

let lastRegistration = null;
forms.register = async (d) => {
  lastRegistration = await POST('/api/auth/register', d);
  go('/registered');
};
route('/registered', () => view('Account created', h`
  <p>Your account was created. The next step is to confirm your email address.</p>
  ${noEmailNote()}
  ${lastRegistration?.dev_verify_token ? notice('info', h`Development mode: <a href="#/verify-email?token=${lastRegistration.dev_verify_token}">confirm this email now</a>. This shortcut never appears in production.`) : ''}
  <p class="mt"><a class="btn" href="#/login">Go to sign in</a></p>`), { public: true, layout: 'auth' });

route('/verify-email', async ({ query }) => {
  const token = query.get('token');
  let body;
  if (!token) body = notice('bad', 'This confirmation link is incomplete.');
  else {
    try {
      await POST('/api/auth/verify-email', { token });
      if (state.user) state.user = (await GET('/api/auth/me')).user; // refresh the signed-in session's view of itself
      body = notice('ok', state.user ? 'Your email address is confirmed.' : 'Your email address is confirmed. You can sign in now.');
    } catch (e) { body = notice('bad', e.message); }
  }
  return view('Email confirmation', h`${body}<p class="mt"><a class="btn" href="${state.user ? '#/dashboard' : '#/login'}">${state.user ? 'Continue' : 'Sign in'}</a></p>`);
}, { public: true, layout: 'auth' });

route('/forgot', () => view('Reset your password', h`
  ${noEmailNote()}
  <form data-form="forgot" novalidate>
    <div class="form-error notice bad" role="alert" tabindex="-1" hidden></div>
    ${fld('email', 'Email', { type: 'email', required: true, autocomplete: 'email' })}
    <div class="row"><button class="btn" type="submit">Request reset link</button><a href="#/login">Back to sign in</a></div>
  </form><div id="forgot-result" class="mt"></div>`), { public: true, layout: 'auth' });
forms.forgot = async (d, form) => {
  const r = await POST('/api/auth/forgot-password', d);
  document.getElementById('forgot-result').innerHTML = html(h`${notice('ok', r.message)}${r.dev_reset_token ? notice('info', h`Development mode: <a href="#/reset-password?token=${r.dev_reset_token}">open the reset form</a>.`) : ''}`);
};

route('/reset-password', ({ query }) => view('Choose a new password', h`
  <form data-form="reset" novalidate>
    <input type="hidden" name="token" value="${query.get('token') ?? ''}">
    <div class="form-error notice bad" role="alert" tabindex="-1" hidden></div>
    ${fld('password', 'New password', { type: 'password', required: true, autocomplete: 'new-password', hint: 'At least 10 characters, with a letter and a number.' })}
    <button class="btn" type="submit">Save new password</button>
  </form>`), { public: true, layout: 'auth' });
forms.reset = async (d) => {
  await POST('/api/auth/reset-password', d);
  toast('Password updated. Please sign in.', 'ok');
  go('/login');
};

route('/policies', () => view('Terms and privacy notice (draft)', h`
  ${notice('warn', h`<strong>Draft for review.</strong> These summaries describe what this installation actually does. They are not legal advice and have not been reviewed by a lawyer or the organisation. The organisation must adopt its own final terms and privacy notice before launch (see <code>docs/POLICY-DRAFTS.md</code>).`)}
  <h2>What we collect</h2>
  <p>Account details you provide (name, email, optional phone and country), your affiliation details, verification and application documents you upload, and records of what you do on the platform (applications, registrations, milestones, messages to support).</p>
  <h2>Why</h2>
  <p>To verify who you are, run programmes, workshops, mentoring and funding fairly, and keep an audit trail of decisions.</p>
  <h2>Who can see it</h2>
  <p>Only you and the staff roles that need it for review. Verification and mentor documents are private and every reviewer access is logged. Partners see aggregate reports only, with small counts hidden.</p>
  <h2>Documents</h2>
  <p>Uploads are stored privately, checked for file type and basic active content, and are not shown publicly. No antivirus engine is connected to this installation.</p>
  <h2>Your choices</h2>
  <p>You can change notification preferences in your profile. Requests to correct or delete your data go through Help &amp; support. Retention periods and automated deletion are not configured yet.</p>
  <p class="mt"><a href="#/register">Back to registration</a></p>`), { public: true, layout: 'auth' });

// ---------- dashboard ----------
const QUEUE_LINKS = {
  verification: ['/admin/verification', 'Verification requests'], mentor_applications: ['/admin/mentors', 'Mentor applications'], ventures: ['/admin/ventures', 'Venture reviews'],
  milestones: ['/admin/milestones', 'Milestone evidence'], funding: ['/admin/funding', 'Funding applications'], programme_applications: ['/admin/programmes', 'Programme applications'], support: ['/admin/support', 'Support requests'],
};
const COUNT_LABELS = {
  ventures: 'My ventures', open_milestones: 'Open milestones', programme_applications: 'Programme applications', upcoming_workshops: 'Upcoming workshops',
};

// What a new member still has to do, derived from their own state. Each step links to where it is done.
const checklist = (u, counts) => [
  ['Confirm your email address', !!u.email_verified, '#/profile'],
  ['Get verified (affiliation details and evidence)', u.verification_status === 'verified', '#/verification'],
  ['Create your first venture', (counts.ventures ?? 0) > 0, '#/ventures'],
  ['Apply to a programme or ask a mentor for help', (counts.programme_applications ?? 0) > 0, '#/programmes'],
];

route('/dashboard', () => {
  if (staffOnly()) { go('/admin'); return view('', h``, { head: false }); }
  const u = state.user;
  const d = state.dash ?? { next_steps: [], counts: {}, queues: {} };
  const queues = Object.entries(d.queues ?? {}).filter(([k]) => QUEUE_LINKS[k]);
  return view(`Hello, ${u.full_name.split(' ')[0]}`, h`
    <div class="grid cols-2">
      <section class="card" aria-labelledby="h-status"><h2 id="h-status">Your account</h2>
        <p>Category: <strong>${label(u.category)}</strong></p>
        <p>Verification: ${badge(u.verification_status)} ${u.email_verified ? '' : badge('unverified')}</p>
        <p>${u.roles.length ? h`Roles: ${u.roles.map((r) => h`<span class="badge info">${label(r)}</span> `)}` : 'No roles yet. Roles are granted when your verification is approved.'}</p>
        ${u.verification_status !== 'verified' ? h`<a class="btn" href="#/verification">Continue verification</a>` : ''}
      </section>
      <section class="card" aria-labelledby="h-next"><h2 id="h-next">Next steps</h2>
        ${d.next_steps.length ? h`<ul>${d.next_steps.map((s) => h`<li><a href="#${s.link.replace('#', '')}">${s.text}</a></li>`)}</ul>` : h`<p class="muted">You are all caught up.</p>`}
      </section>
    </div>
    ${(() => { const steps = checklist(u, d.counts ?? {}); return steps.every((x) => x[1]) ? '' : h`<section class="card mt" aria-labelledby="h-start"><h2 id="h-start">Getting started</h2><ol class="plain stack-sm">${steps.map(([t, done, link]) => h`<li>${done ? h`<span class="badge ok">Done</span> ${t}` : h`<span class="badge warn">To do</span> <a href="${link}">${t}</a>`}</li>`)}</ol></section>`; })()}
    ${u.verification_status === 'verified' ? h`<h2 class="mt">At a glance</h2><div class="grid cols-3">${Object.entries(COUNT_LABELS).map(([k, t]) => h`<div class="card"><div class="kpi">${d.counts[k] ?? 0}</div><div class="kpi-label">${t}</div></div>`)}</div>` : ''}
    ${queues.length ? h`<h2 class="mt">Waiting for review</h2><div class="grid cols-3">${queues.map(([k, n]) => h`<a class="card" href="#${QUEUE_LINKS[k][0]}"><div class="kpi">${n}</div><div class="kpi-label">${QUEUE_LINKS[k][1]}</div></a>`)}</div>` : ''}
  `);
});

// ---------- notifications ----------
route('/notifications', async () => {
  const r = await GET('/api/notifications');
  return view('Notifications', h`
    ${r.notifications.length ? h`<div class="row mb"><button class="btn secondary small" data-action="read-all" type="button">Mark all as read</button></div>
      <ul class="stack-sm plain">${r.notifications.map((n) => h`<li class="card"><div class="row between"><strong>${n.read_at ? '' : h`<span class="badge info">new</span> `}${n.title}</strong><span class="small muted">${fmtDateTime(n.created_at)}</span></div>
        ${n.body ? h`<p class="pre">${n.body}</p>` : ''}
        <div class="row">${n.link ? h`<a href="#${n.link.replace('#', '')}" data-action="read" data-id="${n.id}">Open</a>` : ''}${n.read_at ? '' : h`<button class="linkbtn" data-action="read-stay" data-id="${n.id}" type="button">Mark as read</button>`}</div></li>`)}</ul>` : empty('No notifications yet.')}
    <p class="small muted mt">${emailWorks() ? 'Email copies of notifications are sent when you have email notifications switched on in your profile.' : 'Email copies are queued but not sent, because no email provider is configured on this installation.'}</p>`);
});
actions['read-all'] = async () => { await POST('/api/notifications/read-all'); await refresh(); };
actions.read = async (el) => { await POST(`/api/notifications/${el.dataset.id}/read`); go(el.getAttribute('href').slice(1)); };
actions['read-stay'] = async (el) => { await POST(`/api/notifications/${el.dataset.id}/read`); await refresh(); };

route('/', () => { go(state.user ? homePath() : '/login'); return view('', h``, { head: false }); }, { public: true });

// ---------- boot ----------
async function boot() {
  installEvents();
  state.meta = await GET('/api/meta').catch(() => ({ capabilities: {} }));
  try { state.user = (await GET('/api/auth/me')).user; } catch { state.user = null; }
  if (!location.hash || location.hash === '#') location.hash = state.user ? '#' + homePath() : '#/login';
  await render();
}
boot();
