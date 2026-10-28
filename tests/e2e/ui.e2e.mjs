// Browser end-to-end test. Boots the real server, drives the real UI with Chromium (desktop and mobile),
// and fails on any console error, page error or CSP violation.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.resolve(import.meta.dirname, '../..');
const shots = process.env.SCREENSHOT_DIR ?? path.join(root, 'tests/e2e/screenshots');
fs.mkdirSync(shots, { recursive: true });

const port = 21000 + Math.floor(Math.random() * 15000);
const base = `http://127.0.0.1:${port}`;
const ADMIN = { email: 'owner@example.test', password: 'Owner-pass-12345' };
const STUDENT = { name: 'Ada Student', email: 'ada@example.test', password: 'Student-pass-12345' };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);

const server = spawn(process.execPath, [path.join(root, 'apps/api/src/server.ts')], {
  env: { ...process.env, NODE_ENV: 'development', PORT: String(port), DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'ces-e2e-')), BOOTSTRAP_ADMIN_EMAIL: ADMIN.email, BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('server did not start')), 20000);
  server.stdout.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(t); resolve(); } });
  server.on('exit', (c) => reject(new Error(`server exited (${c})`)));
});

const browser = await chromium.launch();
const problems = [];
let passed = 0;
const consoleErrors = [];
const pages = {};
const step = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok   ${name}`); } catch (e) {
    problems.push(`${name}: ${e.message.split('\n')[0]}`);
    console.log(`  FAIL ${name}\n       ${e.message.split('\n').slice(0, 3).join(' | ')}`);
    // Diagnostics: what each page was showing when the step failed.
    for (const [who, pg] of Object.entries(pages)) {
      try {
        const text = (await pg.locator('main').first().innerText({ timeout: 1500 })).replace(/\s+/g, ' ').slice(0, 260);
        console.log(`       [${who}] ${pg.url().replace(base, '')} :: ${text}`);
        await pg.screenshot({ path: path.join(shots, `fail-${who}-${name.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}.png`) });
      } catch { /* page closed */ }
    }
  }
};
const watch = (page, who) => {
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`[${who}] ${m.text()}`); });
  page.on('pageerror', (e) => consoleErrors.push(`[${who}] pageerror: ${e.message}`));
  page.on('dialog', (d) => d.accept());
};
const newPage = async (who, viewport = { width: 1280, height: 860 }) => {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);
  watch(page, who);
  return page;
};
/** Click a real button or link by its visible text (never a paragraph that merely contains the words). */
const clickBtn = (page, text) => page.locator('button, a', { hasText: text }).filter({ visible: true }).first().click();
const toastSeen = (page, re) => page.locator('#toasts .toast').filter({ hasText: re }).first().waitFor({ timeout: 8000 });
/** Call the API from inside a signed-in page (same cookies, same CSRF header the app sends). Used only to set up state quickly. */
const api = (page, method, p, body) => page.evaluate(async ([method, p, body]) => {
  const res = await fetch(p, { method, credentials: 'same-origin', headers: { 'X-Requested-With': 'ALABATT', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: data };
}, [method, p, body]);
const upload = (page, category, name) => page.evaluate(async ([category, name, bytes]) => {
  const res = await fetch('/api/documents', { method: 'POST', credentials: 'same-origin', body: new Uint8Array(bytes), headers: { 'X-Requested-With': 'ALABATT', 'Content-Type': 'application/octet-stream', 'X-Category': category, 'X-Filename': encodeURIComponent(name) } });
  return { status: res.status, body: await res.json().catch(() => null) };
}, [category, name, [...PNG]]);
const must = (r, what, ok = [200, 201]) => { assert.ok(ok.includes(r.status), `${what}: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const go = async (page, hash) => {
  // A hash-only navigation to the current hash fires no hashchange, so reload to be sure the data is fresh.
  const same = await page.evaluate((h) => location.hash === `#${h}`, hash).catch(() => false);
  await page.goto(`${base}/#${hash}`);
  if (same) await page.reload();
  await page.waitForSelector(`main[data-route="${hash}"] h1`, { timeout: 8000 }); };
const login = async (page, who) => {
  await page.goto(`${base}/#/login`);
  await page.fill('[name=\"email\"]', who.email);
  await page.fill('[name=\"password\"]', who.password);
  await page.click('button[type=submit]');
  await page.waitForSelector('text=Verification', { timeout: 8000 });
};
const a11y = async (page, label) => {
  const issues = await page.evaluate(() => {
    const out = [];
    const mains = document.querySelectorAll('main');
    if (mains.length !== 1) out.push(`${mains.length} <main> landmarks`);
    const h1s = document.querySelectorAll('main h1');
    if (h1s.length !== 1) out.push(`${h1s.length} <h1> elements`);
    if (!document.title.trim()) out.push('empty <title>');
    for (const el of document.querySelectorAll('input:not([type=hidden]), select, textarea')) {
      if (!el.labels?.length && !el.getAttribute('aria-label')) out.push(`unlabelled control #${el.id || el.name}`);
    }
    for (const b of document.querySelectorAll('button, a')) if (!b.textContent.trim() && !b.getAttribute('aria-label')) out.push('control without a name');
    const seen = new Set();
    for (const el of document.querySelectorAll('[id]')) { if (seen.has(el.id)) out.push(`duplicate id #${el.id}`); seen.add(el.id); }
    for (const i of document.querySelectorAll('img')) if (!i.hasAttribute('alt')) out.push('image without alt');
    return out;
  });
  assert.deepEqual(issues, [], `${label}: ${issues.join('; ')}`);
};

try {
  const admin = await newPage('admin');
  const student = await newPage('student');
  pages.admin = admin;
  pages.student = student;

  console.log('Member journey');
  await step('registration, email confirmation and sign-in', async () => {
    await student.goto(`${base}/`);
    await student.waitForSelector('text=Sign in');
    await clickBtn(student, 'Create an account');
    await student.fill('[name=\"full_name\"]', STUDENT.name);
    await student.fill('[name=\"email\"]', STUDENT.email);
    await student.fill('[name=\"password\"]', STUDENT.password);
    await student.selectOption('[name=\"category\"]', 'student');
    await student.check('[name=\"accept_terms\"]');
    await student.click('button[type=submit]');
    await student.waitForSelector('text=Account created');
    assert.ok(await student.locator('text=Email delivery is not configured').count(), 'honest email notice is shown');
    await clickBtn(student, 'confirm this email now');
    await student.waitForSelector('text=Your email address is confirmed');
    await clickBtn(student, 'Sign in');
    await student.fill('[name=\"email\"]', STUDENT.email);
    await student.fill('[name=\"password\"]', STUDENT.password);
    await student.click('button[type=submit]');
    await student.waitForSelector('h1:has-text("Hello, Ada")');
    await student.screenshot({ path: path.join(shots, '01-dashboard.png') });
  });

  await step('validation errors are shown next to the field', async () => {
    await student.goto(`${base}/#/support`);
    await student.waitForSelector('main h1');
    await student.fill('[name=\"subject\"]', 'Hi');
    await student.fill('[name=\"message\"]', 'short');
    await student.click('button[type=submit]');
    await student.waitForSelector('[data-err="message"]:not(:empty)');
    assert.equal(await student.locator('[name="message"]').getAttribute('aria-invalid'), 'true');
  });

  await step('verification: affiliation, upload, submit', async () => {
    await go(student, '/verification');
    for (const [k, v] of [['institution', 'ALABATT University'], ['id_number', 'ST/2024/001'], ['department', 'Business'], ['programme_of_study', 'BSc Entrepreneurship'], ['level', '300']]) await student.fill(`main [name="${k}"]`, v);
    await clickBtn(student, 'Save details');
    await toastSeen(student, /Details saved/);
    await student.setInputFiles('#f-file-verify', { name: 'id.png', mimeType: 'image/png', buffer: PNG });
    await student.click('form[data-form="upload-doc"] button[type=submit]');
    await toastSeen(student, /File uploaded/);
    await clickBtn(student, 'Submit for verification');
    await student.waitForSelector('text=waiting for a reviewer');
  });

  await step('staff sign in and approve the verification', async () => {
    await login(admin, ADMIN);
    await go(admin, '/admin/verification');
    await admin.click(`a:has-text("${STUDENT.name}")`);
    await admin.waitForSelector('text=Evidence');
    await admin.selectOption('[name=\"decision\"]', 'approve');
    await clickBtn(admin, 'Record decision');
    await admin.waitForSelector('text=The queue is empty');
    await admin.screenshot({ path: path.join(shots, '02-admin-queue.png') });
  });

  await step('student is verified and the member areas open', async () => {
    await student.reload();
    await student.goto(`${base}/#/verification`);
    await student.waitForSelector('text=You are verified');
    await go(student, '/programmes');
    assert.ok(await student.locator('text=No programmes are open').count());
  });

  console.log('Ventures');
  await step('create a venture and submit it for review', async () => {
    await go(student, '/ventures');
    await student.fill('[name=\"name\"]', 'Greenfield Foods');
    await student.fill('[name=\"industry\"]', 'agritech');
    for (const k of ['description', 'problem', 'solution', 'target_market', 'value_proposition']) await student.fill(`main [name="${k}"]`, `Detailed ${k.replace('_', ' ')} for the venture.`);
    await clickBtn(student, 'Create venture');
    await student.waitForSelector('h1:has-text("Greenfield Foods")');
    await clickBtn(student, 'Submit for review');
    await student.waitForSelector('.badge:has-text("submitted")');
    await student.screenshot({ path: path.join(shots, '03-venture.png') });
  });
  await step('milestone: add, start, submit evidence with a file', async () => {
    await student.click('summary:has-text("Add a milestone")');
    await student.fill('form[data-form="milestone-create"] [name="title"]', 'Sign five pilot customers');
    await clickBtn(student, 'Add milestone');
    await toastSeen(student, /Milestone added/);
    await student.click('a:has-text("Sign five pilot customers")');
    await clickBtn(student, 'Start work');
    await student.waitForSelector('text=Submit evidence');
    await student.fill('[name="evidence_text"]', 'Five letters of intent collected.');
    await student.setInputFiles('#f-file-ms', { name: 'loi.png', mimeType: 'image/png', buffer: PNG });
    await clickBtn(student, 'Submit for review');
    await student.waitForSelector('text=self-reported until a reviewer verifies');
  });
  await step('reviewer verifies the milestone and approves the venture', async () => {
    await go(admin, '/admin/milestones');
    await admin.click('a:has-text("Sign five pilot customers")');
    await admin.selectOption('[name=\"decision\"]', 'verify');
    await admin.fill('[name=\"comment\"]', 'Checked the letters.');
    await clickBtn(admin, 'Record review');
    await admin.waitForSelector('text=Nothing waiting for review');
    await go(admin, '/admin/ventures');
    await admin.click('a:has-text("Greenfield Foods")');
    await admin.selectOption('[name=\"decision\"]', 'approve');
    await clickBtn(admin, 'Record decision');
    await toastSeen(admin, /Decision recorded/);
    await student.goto(`${base}/#/milestones`);
    await student.waitForSelector('.badge:has-text("verified")');
  });

  console.log('Programmes and workshops');
  await step('staff publish a programme; the student applies', async () => {
    await go(admin, '/admin/programmes');
    await admin.click('summary:has-text("Create a programme")');
    await admin.fill('[name=\"title\"]', 'Venture Accelerator Cohort 1');
    await admin.fill('[name=\"capacity\"]', '10');
    await admin.fill('[name=\"questions_text\"]', 'Why do you want to join?\n(optional) Anything else?');
    await clickBtn(admin, 'Create draft');
    await admin.waitForSelector('h1:has-text("Venture Accelerator Cohort 1")');
    await admin.click('button:has-text("Publish")');
    await admin.waitForSelector('.badge:has-text("published")');
    await go(student, '/programmes');
    await student.click('a:has-text("Venture Accelerator Cohort 1")');
    await student.fill('[name=\"q_q1\"]', 'I want to validate my pricing with mentors.');
    await clickBtn(student, 'Submit application');
    await student.waitForSelector('h2:has-text("Your application")');
    await go(admin, '/admin/programmes');
    await admin.click('a:has-text("Venture Accelerator Cohort 1")');
    await admin.selectOption('form[data-form="prog-decide"] [name=\"decision\"]', 'accept');
    await admin.fill('form[data-form="prog-decide"] [name=\"reason\"]', 'Strong application.');
    await admin.click('form[data-form="prog-decide"] button[type=submit]');
    await toastSeen(admin, /Recorded/);
    await student.reload();
    await student.waitForSelector('.badge:has-text("accepted")');
  });
  await step('staff publish a workshop; the student registers and sees the link', async () => {
    await go(admin, '/admin/workshops');
    await admin.click('summary:has-text("Create a workshop")');
    await admin.fill('[name=\"title\"]', 'Pitch Clinic');
    await admin.fill('[name=\"capacity\"]', '25');
    await admin.fill('[name=\"starts_at\"]', '2035-03-10T10:00');
    await admin.fill('[name=\"ends_at\"]', '2035-03-10T12:00');
    await admin.fill('[name=\"meeting_link\"]', 'https://meet.example.org/pitch');
    await clickBtn(admin, 'Create draft');
    await admin.waitForSelector('h1:has-text("Pitch Clinic")');
    await admin.click('button:has-text("Publish")');
    await admin.waitForSelector('.badge:has-text("published")');
    await go(student, '/workshops');
    assert.equal(await student.locator('a[href="https://meet.example.org/pitch"]').count(), 0, 'link hidden before registering');
    await student.click('button:has-text("Register")');
    await student.waitForSelector('a[href="https://meet.example.org/pitch"]');
  });

  console.log('Funding');
  await step('opportunity, application, evaluation, approval and signature', async () => {
    await go(admin, '/admin/funding');
    await admin.click('summary:has-text("Create an opportunity")');
    await admin.fill('[name=\"title\"]', 'Seed Grant 2035');
    await admin.fill('[name=\"total_budget\"]', '1000000');
    await admin.fill('[name=\"max_amount\"]', '500000');
    await clickBtn(admin, 'Create draft');
    await toastSeen(admin, /Draft created/);
    await admin.click('button:has-text("Open")');
    await toastSeen(admin, /Updated/);
    await go(student, '/funding');
    await student.click('a:has-text("Apply")');
    const opt = await student.locator('[name="venture_id"] option', { hasText: 'Greenfield Foods' }).first().getAttribute('value');
    await student.selectOption('[name=\"venture_id\"]', opt);
    await student.fill('[name=\"requested_amount\"]', '300000');
    await student.fill('[name=\"justification\"]', 'We need equipment to scale production to forty customers within six months.');
    await student.fill('[name=\"use_of_funds\"]', 'Equipment and working capital.');
    await student.fill('[name=\"bi_label_0\"]', 'Equipment');
    await student.fill('[name=\"bi_amount_0\"]', '250000');
    await student.fill('[name=\"bi_label_1\"]', 'Working capital');
    await student.fill('[name=\"bi_amount_1\"]', '50000');
    await clickBtn(student, 'Save draft');
    await student.waitForSelector('text=Edit application');
    await student.click('button:has-text("Submit application")');
    await student.waitForSelector('.badge:has-text("submitted")');

    await go(admin, '/admin/funding');
    await admin.click('a:has-text("Greenfield Foods")');
    for (const d of ['start_review', 'advance']) {
      await admin.selectOption('form[data-form="fund-decide"] [name=\"decision\"]', d);
      await admin.click('form[data-form="fund-decide"] button[type=submit]');
      await toastSeen(admin, /Decision recorded/);
    }
    await admin.selectOption('form[data-form="fund-decide"] [name=\"decision\"]', 'approve');
    await admin.fill('[name=\"approved_amount\"]', '250000');
    await admin.fill('[name=\"reason\"]', 'Meets the criteria and budget is available.');
    await admin.click('form[data-form="fund-decide"] button[type=submit]');
    await admin.waitForSelector('.badge:has-text("approved")');

    await student.reload();
    await student.waitForSelector('h2:has-text("Sign the funding agreement")');
    await student.fill('[name=\"typed_name\"]', STUDENT.name);
    await student.check('[name=\"accept\"]');
    await clickBtn(student, 'Sign agreement');
    await toastSeen(student, /Agreement signed/);
  });
  await step('the approver cannot also release the payment', async () => {
    await admin.reload();
    await admin.waitForSelector('h2:has-text("Record disbursement")');
    await admin.fill('[name=\"reference\"]', 'TRF-0001');
    // Step-up: a wrong password is refused next to the field, before anything else is checked.
    await admin.fill('form[data-form="fund-pay"] [name="confirm_password"]', 'not-my-password');
    await admin.click('form[data-form="fund-pay"] button[type=submit]');
    await admin.waitForSelector('form[data-form="fund-pay"] [data-err="confirm_password"]:not(:empty)');
    assert.equal(await admin.locator('form[data-form="fund-pay"] [name="confirm_password"]').getAttribute('aria-invalid'), 'true');
    // With the right password the separation-of-duties rule still stops the approver from releasing the payment.
    await admin.fill('form[data-form="fund-pay"] [name="confirm_password"]', ADMIN.password);
    await admin.click('form[data-form="fund-pay"] button[type=submit]');
    await admin.waitForSelector('.form-error:not([hidden])');
    assert.match(await admin.locator('form[data-form="fund-pay"] .form-error').innerText(), /cannot also release/);
  });

  console.log('Staff areas, accessibility and mobile');
  await step('reports, audit log and users load for staff', async () => {
    await go(admin, '/admin/reports');
    await admin.waitForSelector('text=Verified members');
    await go(admin, '/admin/audit');
    await admin.waitForSelector('code:has-text("funding.")');
    await go(admin, '/admin/users');
    await admin.waitForSelector(`a:has-text("${STUDENT.name}")`);
    await admin.screenshot({ path: path.join(shots, '04-admin-users.png') });
  });
  console.log('Administration portal');
  await step('a staff-only account lands on the overview and sees no member menu', async () => {
    await go(admin, '/admin');
    await admin.waitForSelector('h1:has-text("Administration overview")');
    await admin.waitForSelector('text=Verification requests waiting');
    await go(admin, '/profile');
    assert.equal(await admin.locator('#sidenav h2', { hasText: 'Build' }).count(), 0, 'no member groups for a staff-only account');
    await admin.waitForSelector('#sidenav a:has-text("Switch to administration")');
    await admin.screenshot({ path: path.join(shots, '07-admin-overview.png') });
  });
  await step('support: a request is a conversation; internal notes never reach the requester', async () => {
    await go(student, '/support');
    await student.fill('form[data-form="support"] [name="subject"]', 'Cannot find my certificate');
    await student.selectOption('form[data-form="support"] [name="category"]', 'programme');
    await student.fill('form[data-form="support"] [name="message"]', 'I attended the workshop but see no certificate anywhere.');
    await student.click('form[data-form="support"] button[type=submit]');
    await student.waitForSelector('h1:has-text("Cannot find my certificate")');
    await go(admin, '/admin/support');
    await admin.click('a:has-text("Cannot find my certificate")');
    await admin.waitForSelector('h2:has-text("Conversation")');
    await admin.selectOption('form[data-form="assign"] [name="assignee_id"]', { index: 1 });
    await admin.click('form[data-form="assign"] button[type=submit]');
    await toastSeen(admin, /Assigned/);
    await admin.fill('form[data-form="support-note"] [name="body"]', 'Check with the registrar first. Internal only.');
    await admin.click('form[data-form="support-note"] button[type=submit]');
    await toastSeen(admin, /Note saved/);
    await admin.fill('form[data-form="support-reply"] [name="response"]', 'Certificates are issued within five working days.');
    await admin.selectOption('form[data-form="support-reply"] [name="status"]', 'resolved');
    await admin.click('form[data-form="support-reply"] button[type=submit]');
    await toastSeen(admin, /Reply sent/);
    await student.reload();
    await student.waitForSelector('text=Certificates are issued within five working days');
    assert.equal(await student.locator('text=Internal only').count(), 0, 'internal note is not shown to the requester');
    assert.equal(await student.locator('text=Support team').count() > 0, true);
  });
  await step('role request: a verified member asks; an administrator needs their own password to approve', async () => {
    await go(student, '/role-requests');
    await student.selectOption('[name="role"]', 'support_officer');
    await student.fill('[name="justification"]', 'I help run the campus entrepreneurship desk and need to answer support requests.');
    await student.click('form[data-form="role-request"] button[type=submit]');
    await toastSeen(student, /Request sent/);
    await go(admin, '/admin/role-requests');
    await admin.waitForSelector(`article:has-text("${STUDENT.name}")`);
    await admin.selectOption('form[data-form="role-decide"] [name="decision"]', 'approve');
    await admin.fill('form[data-form="role-decide"] [name="reason"]', 'Confirmed with the desk lead.');
    await admin.click('form[data-form="role-decide"] button[type=submit]');
    await admin.waitForSelector('form[data-form="role-decide"] [data-err="confirm_password"]:not(:empty)');
    await admin.fill('form[data-form="role-decide"] [name="confirm_password"]', ADMIN.password);
    await admin.click('form[data-form="role-decide"] button[type=submit]');
    await toastSeen(admin, /Decision recorded/);
    await student.reload();
    await student.waitForSelector('#sidenav a:has-text("Switch to administration")');
    await go(student, '/admin/support');
    await student.waitForSelector('h1:has-text("Support inbox")');
  });
  await step('reports show accessible charts with a table for each', async () => {
    await go(admin, '/admin/reports');
    await admin.waitForSelector('h2:has-text("Trends over time")');
    assert.ok(await admin.locator('svg.chart[role="img"]').count() >= 6, 'one chart per trend');
    assert.ok(await admin.locator('svg.chart title').first().textContent(), 'each chart has an accessible name');
    await admin.click('section.card:has(svg.chart) details summary >> nth=0');
    await admin.waitForSelector('details[open] table');
    await admin.screenshot({ path: path.join(shots, '08-reports.png'), fullPage: true });
    await admin.fill('[name="from"]', '2026-01-01');
    await admin.fill('[name="to"]', '2026-03-31');
    await admin.click('form[data-form="report-range"] button[type=submit]');
    await admin.waitForSelector('text=Period 2026-01-01 to 2026-03-31');
  });

  console.log('Mentoring');
  const bola = await newPage('bola');
  pages.bola = bola;
  await step('set up a second member and an approved mentor (through the API, as the app itself would)', async () => {
    must(await api(admin, 'PUT', '/api/admin/config', { key: 'mentor_approvals_required', value: 1, confirm_password: ADMIN.password }), 'config');
    await bola.goto(`${base}/`);
    await bola.waitForSelector('text=Sign in');
    const reg = must(await api(bola, 'POST', '/api/auth/register', { full_name: 'Bola Mentee', email: 'bola@example.test', password: 'Mentee-pass-12345', category: 'student', accept_terms: true }), 'register');
    must(await api(bola, 'POST', '/api/auth/verify-email', { token: reg.dev_verify_token }), 'verify email');
    must(await api(bola, 'POST', '/api/auth/login', { email: 'bola@example.test', password: 'Mentee-pass-12345' }), 'login');
    must(await api(bola, 'PUT', '/api/me/affiliation', { institution: 'ALABATT University', id_number: 'ST/2024/002', department: 'Business', programme_of_study: 'BSc Entrepreneurship', level: '200' }), 'affiliation');
    const doc = must(await upload(bola, 'student_id', 'id.png'), 'upload');
    must(await api(bola, 'POST', '/api/verification/submit', { document_ids: [doc.id] }), 'submit verification');
    const queue = must(await api(admin, 'GET', '/api/admin/verification?status=open'), 'queue');
    const vr = queue.requests.find((r) => r.email === 'bola@example.test');
    assert.ok(vr, 'Bola is in the verification queue');
    must(await api(admin, 'POST', `/api/admin/verification/${vr.id}/decide`, { decision: 'approve' }), 'approve verification');
    must(await api(student, 'PUT', '/api/mentor/application', { organization: 'Greenfield Foods', position: 'Founder', bio: 'Founder with several years of experience building and selling an agricultural food business to local retailers.', expertise: ['pricing', 'sales'], industries: ['agritech'], languages: ['English'], timezone: 'Africa/Lagos', venture_stages: ['idea', 'validation'], meeting_formats: ['online'], availability: 'Weekday evenings', capacity: 2, conflict_declaration: 'None', coc_accepted: true }), 'mentor application');
    must(await upload(student, 'mentor_credential', 'cv.png'), 'credential upload');
    must(await api(student, 'POST', '/api/mentor/application/submit'), 'submit mentor application');
    const apps = must(await api(admin, 'GET', '/api/admin/mentor-applications?status=submitted'), 'mentor queue');
    const ma = apps.applications.find((a) => a.email === STUDENT.email);
    assert.ok(ma, 'Ada is in the mentor queue');
    must(await api(admin, 'POST', `/api/admin/mentor-applications/${ma.id}/review`, { decision: 'approve', notes: 'Credentials checked.' }), 'approve mentor');
    await bola.reload();
    await bola.waitForSelector('h1:has-text("Hello, Bola")');
    const dir = must(await api(bola, 'GET', '/api/mentors'), 'directory');
    const m = dir.mentors.find((x) => x.full_name === STUDENT.name);
    assert.ok(m, 'Ada is listed as a mentor');
    must(await api(bola, 'POST', '/api/mentorship/requests', { mentor_id: m.mentor_id, goals: 'I want help validating pricing for my first customers.' }), 'mentorship request');
  });
  await step('mentoring: accept, plan, move and cancel a session', async () => {
    await go(student, '/mentorship');
    await student.waitForSelector('h2:has-text("Requests to me as a mentor")');
    await student.selectOption('form[data-form="mentor-respond"] [name="decision"]', 'accept');
    await student.click('form[data-form="mentor-respond"] button[type=submit]');
    await toastSeen(student, /Answer sent/);
    await go(bola, '/mentorship');
    await bola.click('summary:has-text("Schedule or record a session")');
    await bola.fill('form[data-form="mr-session"] [name="scheduled_at"]', '2035-05-01T10:00');
    await bola.click('form[data-form="mr-session"] button[type=submit]');
    await toastSeen(bola, /Session saved/);
    await bola.click('summary:has-text("Change this session")');
    await bola.fill('form[data-form="session-reschedule"] [name="scheduled_at"]', '2035-05-08T10:00');
    await bola.click('form[data-form="session-reschedule"] button[type=submit]');
    await toastSeen(bola, /rescheduled/);
    await bola.click('summary:has-text("Change this session")');
    await bola.fill('form[data-form="session-cancel"] [name="reason"]', 'Travelling that week.');
    await bola.click('form[data-form="session-cancel"] button[type=submit]');
    await toastSeen(bola, /Session cancelled/);
    await bola.waitForSelector('li:has-text("Travelling that week") .badge:has-text("cancelled")');
  });
  await step('mentoring: the mentor records sessions that took place and agrees action items', async () => {
    await go(student, '/mentorship');
    await student.click('summary:has-text("Schedule or record a session")');
    await student.fill('form[data-form="mr-session"] [name="scheduled_at"]', '2026-01-05T10:00');
    await student.fill('form[data-form="mr-session"] [name="outcome"]', 'Agreed on three price points.');
    await student.click('form[data-form="mr-session"] button[type=submit]');
    await toastSeen(student, /Session saved/);
    await student.waitForSelector('li:has-text("Agreed on three price points") .badge:has-text("completed")');
    await student.click('summary:has-text("Schedule or record a session")');
    await student.fill('form[data-form="mr-session"] [name="scheduled_at"]', '2026-02-05T10:00');
    await student.click('form[data-form="mr-session"] button[type=submit]');
    await toastSeen(student, /Session saved/);
    await student.click('summary:has-text("Change this session")');
    await student.fill('form[data-form="session-complete"] [name="outcome"]', 'Reviewed the pitch deck.');
    await student.click('form[data-form="session-complete"] button[type=submit]');
    await toastSeen(student, /Session recorded/);
    await student.waitForSelector('li:has-text("Reviewed the pitch deck") .badge:has-text("completed")');
    await student.click('summary:has-text("Add an action item")');
    await student.fill('form[data-form="act-add"] [name="description"]', 'Interview five customers');
    await student.selectOption('form[data-form="act-add"] [name="owner_id"]', { label: 'Bola Mentee' });
    await student.click('form[data-form="act-add"] button[type=submit]');
    await toastSeen(student, /Action item added/);
    await student.click('button:has-text("Mark done")');
    await toastSeen(student, /Updated/);
    await student.waitForSelector('li:has-text("Interview five customers") .badge:has-text("done")');
    await a11y(student, 'mentor /mentorship');
    await go(bola, '/mentorship');
    await bola.waitForSelector('li:has-text("Interview five customers")');
    await a11y(bola, 'mentee /mentorship');
  });
  await step('mentoring: a conflict report goes to a reviewer who is not involved', async () => {
    await go(bola, '/mentorship');
    await bola.click('summary:has-text("Report a problem")');
    await bola.fill('form[data-form="mr-conflict"] [name="reason"]', 'The mentor keeps steering me towards their own company.');
    await bola.click('form[data-form="mr-conflict"] button[type=submit]');
    await toastSeen(bola, /Report sent/);
    await go(student, '/mentorship');
    assert.equal(await student.locator('text=steering me towards').count(), 0, 'the other party never sees the report');
    await go(admin, '/admin/mentoring');
    await admin.waitForSelector('article:has-text("Bola Mentee with Ada Student")');
    await admin.selectOption('form[data-form="conflict-resolve"] [name="outcome"]', 'no_action');
    await admin.fill('form[data-form="conflict-resolve"] [name="resolution"]', 'Spoke with both people; no action needed.');
    await admin.click('form[data-form="conflict-resolve"] button[type=submit]');
    await toastSeen(admin, /Report resolved/);
    await admin.waitForSelector('text=No open reports');
    await admin.screenshot({ path: path.join(shots, '09-mentoring-oversight.png') });
  });

  await step('a member cannot reach staff pages', async () => {
    await go(student, '/admin/users');
    await student.waitForSelector('text=You do not have access');
    const res = await student.evaluate(() => fetch('/api/admin/users').then((r) => r.status));
    assert.equal(res, 403);
    assert.equal(await student.locator('a[href="#/admin/users"]').count(), 0, 'staff links are not in the member menu');
  });
  await step('every main screen has one h1, a landmark, a title and labelled controls', async () => {
    for (const r of ['/dashboard', '/profile', '/verification', '/ventures', '/milestones', '/programmes', '/workshops', '/funding', '/mentors', '/mentorship', '/mentor/apply', '/resources', '/notifications', '/support', '/help', '/role-requests']) { await go(student, r); await a11y(student, `member ${r}`); }
    for (const r of ['/admin/verification', '/admin/mentors', '/admin/ventures', '/admin/milestones', '/admin/programmes', '/admin/workshops', '/admin/funding', '/admin/resources', '/admin/support', '/admin/users', '/admin/audit', '/admin/reports', '/admin/config', '/my-resources', '/admin', '/admin/role-requests', '/admin/mentoring', '/help']) { await go(admin, r); await a11y(admin, `staff ${r}`); }
    for (const r of ['/login', '/register', '/forgot', '/policies']) { const p = await newPage('anon'); await go(p, r); await a11y(p, `public ${r}`); await p.context().close(); }
  });

  await step('mobile layout: menu opens, navigates, closes with link, Escape and outside click', async () => {
    const m = await newPage('mobile', { width: 390, height: 844 });
    await login(m, { email: STUDENT.email, password: STUDENT.password });
    await m.waitForSelector('h1:has-text("Hello")');
    const hOverflow = await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    assert.equal(hOverflow, false, 'no horizontal page scroll');
    await m.click('#openmenu');
    await m.waitForFunction(() => document.body.classList.contains('nav-open'));
    // the drawer slides in; wait until it is actually inside the viewport, not just flagged open
    await m.waitForFunction(() => { const r = document.getElementById('sidenav')?.getBoundingClientRect(); return !!r && r.left >= 0 && r.right <= window.innerWidth; });
    await m.screenshot({ path: path.join(shots, '05-mobile-menu.png') });
    await m.click('#sidenav a[href="#/profile"]');
    await m.waitForSelector('h1:has-text("Your profile")');
    assert.equal(await m.evaluate(() => document.body.classList.contains('nav-open')), false);
    await m.click('#openmenu');
    await m.keyboard.press('Escape');
    assert.equal(await m.evaluate(() => document.body.classList.contains('nav-open')), false);
    await m.click('#openmenu');
    await m.click('#closemenu');
    assert.equal(await m.evaluate(() => document.body.classList.contains('nav-open')), false);
    for (const r of ['/ventures', '/funding', '/workshops']) { await go(m, r); assert.equal(await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, `${r} overflows`); }
    await m.screenshot({ path: path.join(shots, '06-mobile-workshops.png') });
  });

  await step('a slow page shows a loading state, then the real page', async () => {
    await go(student, '/dashboard');
    await student.route('**/api/ventures', async (route) => { await new Promise((r) => setTimeout(r, 900)); await route.continue(); });
    await student.evaluate(() => { location.hash = '#/ventures'; });
    await student.waitForSelector('main .loading[role="status"]', { timeout: 3000 });
    await student.waitForSelector('main[data-route="/ventures"] h1', { timeout: 8000 });
    assert.equal(await student.locator('main .loading').count(), 0, 'loading state is gone once the page renders');
    await student.unroute('**/api/ventures');
  });
  await step('sign out ends the session', async () => {
    await clickBtn(student, 'Sign out');
    await student.waitForSelector('text=Welcome to ALABATT-CES');
    const status = await student.evaluate(() => fetch('/api/auth/me').then((r) => r.status));
    assert.equal(status, 401);
  });

  await step('no console errors, page errors or CSP violations during the whole run', async () => {
    assert.deepEqual(consoleErrors.filter((e) => !/status of 40[134]|status of 409|status of 422/.test(e)), []);
  });
} finally {
  await browser.close();
  server.kill('SIGTERM');
}

console.log(`\n${passed} passed, ${problems.length} failed`);
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
