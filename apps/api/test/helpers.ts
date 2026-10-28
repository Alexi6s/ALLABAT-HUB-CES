// Test harness: boots the real server on an ephemeral port with an in-memory database and drives it over HTTP.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ces-test-'));
process.env.NODE_ENV = 'test';

const core = await import('../src/core.ts');
const httpMod = await import('../src/http.ts');
await import('../src/server.ts'); // registers all routes; does not listen when imported
const policy = await import('../src/policy.ts');

core.openDb(':memory:');
const server = httpMod.createServer();
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
export const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
export const { q } = core;
export const closeApp = async () => {
  await new Promise((r) => server.close(r));
  server.closeAllConnections?.();
  core.closeDb();
};

export const PASSWORD = 'Passw0rd-test1';
export type Res = { status: number; body: any; headers: Headers; text: string };

export class Client {
  cookie = '';
  id = '';
  email = '';
  name = '';
  async req(method: string, url: string, body?: unknown, headers: Record<string, string> = {}, keepLimits = false): Promise<Res> {
    if (!keepLimits) httpMod.resetRateLimits();
    const isBin = body instanceof Uint8Array;
    const res = await fetch(base + url, {
      method,
      headers: {
        'X-Requested-With': 'ALABATT',
        ...(body !== undefined && !isBin ? { 'Content-Type': 'application/json' } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : isBin ? (body as unknown as BodyInit) : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie?.() ?? [];
    for (const sc of set) {
      const [pair] = sc.split(';');
      if (/Max-Age=0/i.test(sc)) this.cookie = '';
      else this.cookie = pair;
    }
    const text = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: parsed, headers: res.headers, text };
  }
  get = (u: string, h?: Record<string, string>) => this.req('GET', u, undefined, h);
  post = (u: string, b?: unknown, h?: Record<string, string>) => this.req('POST', u, b ?? {}, h);
  put = (u: string, b?: unknown) => this.req('PUT', u, b ?? {});
  patch = (u: string, b?: unknown) => this.req('PATCH', u, b ?? {});
  del = (u: string) => this.req('DELETE', u);
  upload(category: string, bytes: Uint8Array, name = 'evidence.pdf', extra: Record<string, string> = {}) {
    return this.req('POST', '/api/documents', bytes, { 'X-Category': category, 'X-Filename': encodeURIComponent(name), 'Content-Type': 'application/octet-stream', ...extra });
  }
}

export const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);

let counter = 0;
export async function signup(category = 'student', extra: Record<string, unknown> = {}): Promise<Client> {
  const c = new Client();
  c.email = `user${++counter}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  c.name = `Test User ${counter}`;
  const r = await c.post('/api/auth/register', {
    email: c.email, password: PASSWORD, full_name: c.name, category, accept_terms: true,
    ...(category === 'partner' ? { organization: 'Acme Partners' } : {}), ...extra,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const v = await c.post('/api/auth/verify-email', { token: r.body.dev_verify_token });
  assert.equal(v.status, 200);
  const l = await c.post('/api/auth/login', { email: c.email, password: PASSWORD });
  assert.equal(l.status, 200);
  c.id = l.body.user.id;
  return c;
}

/** Test shortcut: marks a user verified directly in the database (the real flow is covered in identity.test.ts). */
export function forceVerified(c: Client) {
  const u = q.get<any>('SELECT category FROM users WHERE id = ?', c.id)!;
  q.run("UPDATE users SET verification_status = 'verified' WHERE id = ?", c.id);
  const role = policy.categoryRole(u.category);
  if (role) q.run('INSERT OR IGNORE INTO user_roles(user_id, role, granted_at) VALUES (?,?,?)', c.id, role, new Date().toISOString());
  return c;
}
export async function verified(category = 'student', extra: Record<string, unknown> = {}) {
  return forceVerified(await signup(category, extra));
}
/** A verified account that holds the given staff roles (granted directly, as an administrator would). */
export async function staff(...roles: string[]) {
  const c = await verified('external_participant');
  q.run("UPDATE users SET category = 'staff' WHERE id = ?", c.id);
  for (const r of roles) q.run('INSERT OR IGNORE INTO user_roles(user_id, role, granted_at) VALUES (?,?,?)', c.id, r, new Date().toISOString());
  return c;
}
export const audits = (action: string) => q.all<any>('SELECT * FROM audit_events WHERE action = ?', action);

export async function mentorOf(...extraRoles: string[]) {
  const m = await verified('external_entrepreneur');
  q.run(`INSERT INTO mentor_applications(id,user_id,status,expertise,industries,venture_stages,languages,meeting_formats,capacity,coc_accepted,created_at,updated_at,bio,organization,position)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, `app-${m.id}`, m.id, 'approved', '["marketing","finance"]', '["fintech"]', '["idea","validation"]', '["English"]', '["online"]', 2, 1,
    new Date().toISOString(), new Date().toISOString(), 'Seasoned operator with fifteen years of experience mentoring founders.', 'Acme', 'Director');
  q.run("INSERT INTO user_roles(user_id, role, granted_at) VALUES (?, 'mentor', ?)", m.id, new Date().toISOString());
  for (const r of extraRoles) q.run('INSERT OR IGNORE INTO user_roles(user_id, role, granted_at) VALUES (?,?,?)', m.id, r, new Date().toISOString());
  return m;
}

export async function ventureFor(owner: Client, name = 'Greenfield Foods', extra: Record<string, unknown> = {}) {
  const r = await owner.post('/api/ventures', { name, description: 'Affordable cold chain for smallholders.', problem: 'Post-harvest losses.', solution: 'Shared solar cold rooms.', target_market: 'Smallholder farmers', value_proposition: 'Cut spoilage by half.', industry: 'agritech', ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.id as string;
}

// ---- funding fixtures shared by workflow tests ----
export async function openOpportunity(overrides: Record<string, unknown> = {}) {
  const officer = await staff('funding_officer');
  const o = await officer.post('/api/admin/funding/opportunities', {
    title: 'Seed Grant', description: 'Early-stage grant.', currency: 'NGN', min_amount: 100000, max_amount: 500000, total_budget: 5_000_000,
    eligible_categories: ['student', 'alumni', 'external_entrepreneur'], criteria: 'Traction and team.', conditions: 'Quarterly reporting.', ...overrides,
  });
  assert.equal(o.status, 201, JSON.stringify(o.body));
  assert.equal((await officer.post(`/api/admin/funding/opportunities/${o.body.id}/open`)).status, 200);
  return { officer, id: o.body.id as string };
}
export async function submittedVenture(category = 'student') {
  const owner = await verified(category);
  const ventureId = await ventureFor(owner);
  assert.equal((await owner.post(`/api/ventures/${ventureId}/submit`)).status, 200);
  return { owner, ventureId };
}
export async function submitFunding(oppId: string, owner: Client, ventureId: string, amount = 300000) {
  const a = await owner.post(`/api/funding/opportunities/${oppId}/applications`, {
    venture_id: ventureId, requested_amount: amount,
    justification: 'We need equipment to scale production to forty customers within six months.', use_of_funds: 'Equipment and working capital.',
    budget_items: [{ label: 'Equipment', amount: amount - 50000 }, { label: 'Working capital', amount: 50000 }],
  });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal((await owner.post(`/api/funding/applications/${a.body.id}/submit`)).status, 200);
  return a.body.id as string;
}
export async function startEvaluation(officer: Client, appId: string) {
  assert.equal((await officer.post(`/api/admin/funding/applications/${appId}/decide`, { decision: 'start_review' })).status, 200);
  assert.equal((await officer.post(`/api/admin/funding/applications/${appId}/decide`, { decision: 'advance' })).status, 200);
}
