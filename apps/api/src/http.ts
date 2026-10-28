// Minimal dependency-free HTTP layer: routing, sessions, CSRF guard, rate limiting, security headers, static files.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError, config, q, sha256, now, forbidden } from './core.ts';
import { can, type AuthUser, type Permission, type Role } from './policy.ts';

export type Ctx = {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
  raw: Buffer | null;
  user: AuthUser;
  ip: string;
  setCookie: (name: string, value: string, maxAgeSec: number) => void;
  clearCookie: (name: string) => void;
};
export type Result = unknown;
export const HANDLED = Symbol('handled');
export class Created {
  data: unknown;
  constructor(data: unknown) {
    this.data = data;
  }
}
type Opts = { auth?: boolean; perm?: Permission; raw?: boolean; limit?: number; allowInactive?: boolean };
type Handler = (c: Ctx) => Result | Promise<Result>;
type Route = { method: string; re: RegExp; keys: string[]; handler: Handler; opts: Opts; pathPattern: string };

const routes: Route[] = [];
export const listRoutes = () => routes.map((r) => ({ method: r.method, path: r.pathPattern, ...r.opts }));
export const route = (method: string, p: string, handler: Handler, opts: Opts = {}) => {
  const keys: string[] = [];
  const re = new RegExp('^' + p.replace(/:([a-zA-Z_]+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$');
  routes.push({ method, re, keys, handler, opts, pathPattern: p });
};
export const get = (p: string, h: Handler, o?: Opts) => route('GET', p, h, o);
export const post = (p: string, h: Handler, o?: Opts) => route('POST', p, h, o);
export const put = (p: string, h: Handler, o?: Opts) => route('PUT', p, h, o);
export const patch = (p: string, h: Handler, o?: Opts) => route('PATCH', p, h, o);
export const del = (p: string, h: Handler, o?: Opts) => route('DELETE', p, h, o);

// ---------- rate limiting (in-memory; replace with a shared store when running multiple instances) ----------
const hits = new Map<string, { n: number; reset: number }>();
export function rateLimit(key: string, max: number, windowMs: number) {
  const t = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < t) {
    hits.set(key, { n: 1, reset: t + windowMs });
    return;
  }
  h.n++;
  if (h.n > max) throw new HttpError(429, 'rate_limited', 'Too many requests. Please wait and try again.');
}
export const resetRateLimits = () => hits.clear();
setInterval(() => {
  const t = Date.now();
  for (const [k, v] of hits) if (v.reset < t) hits.delete(k);
}, 60_000).unref();

// ---------- sessions ----------
export const SESSION_COOKIE = 'ces_session';
function parseCookies(h: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (h ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function loadUser(userId: string): AuthUser | null {
  const u = q.get<any>('SELECT id,email,full_name,category,account_status,email_verified,verification_status FROM users WHERE id = ?', userId);
  if (!u) return null;
  const roles = q.all<{ role: Role }>('SELECT role FROM user_roles WHERE user_id = ?', userId).map((r) => r.role);
  return { ...u, roles };
}

function sessionUser(req: http.IncomingMessage): AuthUser | null {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  const s = q.get<{ user_id: string; expires_at: string }>('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?', sha256(token));
  if (!s) return null;
  if (s.expires_at < now()) {
    q.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
    return null;
  }
  return loadUser(s.user_id);
}

// ---------- request handling ----------
function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        // Stop buffering but keep draining so the client receives a proper 413 instead of a reset connection.
        tooLarge = true;
        chunks.length = 0;
        if (size > limit * 4) req.destroy(); // refuse to drain absurd uploads
        return;
      }
      if (!tooLarge) chunks.push(c);
    });
    req.on('end', () => (tooLarge ? reject(new HttpError(413, 'payload_too_large', 'The request is too large.')) : resolve(Buffer.concat(chunks))));
    req.on('error', () => reject(new HttpError(413, 'payload_too_large', 'The request is too large.')));
  });
}

function securityHeaders(res: http.ServerResponse) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (config.env === 'production') res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };
export const webRoot = path.resolve(import.meta.dirname, '../../web/public');

function serveStatic(url: URL, res: http.ServerResponse) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.includes('\0')) rel = '/';
  let file = path.join(webRoot, path.normalize(rel));
  if (!file.startsWith(webRoot)) {
    res.writeHead(403).end();
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(webRoot, 'index.html'); // SPA fallback
  if (!fs.existsSync(file)) {
    res.writeHead(404).end('Web client not built.');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': file.endsWith('.html') ? 'no-cache' : 'public, max-age=300' });
  fs.createReadStream(file).pipe(res);
}

export function sendJson(res: http.ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

export async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  securityHeaders(res);
  const ip = (config.env === 'production' ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '') || req.socket.remoteAddress || 'unknown';
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405).end();
      return serveStatic(url, res);
    }
    const method = req.method ?? 'GET';
    let match: { r: Route; params: Record<string, string> } | null = null;
    let pathMatched = false;
    for (const r of routes) {
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      match = { r, params };
      break;
    }
    if (!match) throw pathMatched ? new HttpError(405, 'method_not_allowed', 'Method not allowed.') : new HttpError(404, 'not_found', 'Unknown endpoint.');
    const { r, params } = match;
    rateLimit(`g:${ip}`, 600, 60_000);
    if (r.opts.limit) rateLimit(`r:${r.method}:${r.re.source}:${ip}`, r.opts.limit, 15 * 60_000);

    // CSRF guard: state-changing requests must carry a custom header (cannot be sent cross-site without a CORS preflight, which we never approve) and a same-origin Origin.
    if (method !== 'GET' && method !== 'HEAD') {
      if (req.headers['x-requested-with'] !== 'ALABATT') throw new HttpError(403, 'csrf', 'Missing request header.');
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'csrf', 'Cross-origin request rejected.');
    }

    let user: AuthUser | null = null;
    if (r.opts.auth !== false) {
      user = sessionUser(req);
      if (!user) throw new HttpError(401, 'unauthenticated', 'Please sign in.');
      if (user.account_status !== 'active' && !r.opts.allowInactive) throw new HttpError(403, 'account_inactive', `This account is ${user.account_status}.`);
      if (r.opts.perm && !can(user, r.opts.perm)) throw forbidden();
    }

    let body: any = null;
    let rawBuf: Buffer | null = null;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      if (r.opts.raw) rawBuf = await readBody(req, config.maxUploadBytes);
      else {
        const buf = await readBody(req, 1_000_000);
        if (buf.length) {
          try {
            body = JSON.parse(buf.toString('utf8'));
          } catch {
            throw new HttpError(400, 'bad_json', 'Request body is not valid JSON.');
          }
        }
      }
    }

    const cookies: string[] = [];
    const ctx: Ctx = {
      req, res, params, query: url.searchParams, body, raw: rawBuf, user: user as AuthUser, ip,
      setCookie: (name, value, maxAge) =>
        cookies.push(`${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.env === 'production' ? '; Secure' : ''}`),
      clearCookie: (name) => cookies.push(`${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`),
    };
    const out = await r.handler(ctx);
    if (out === HANDLED) return;
    if (cookies.length) res.setHeader('Set-Cookie', cookies);
    if (out instanceof Created) return sendJson(res, 201, out.data);
    return sendJson(res, 200, out ?? { ok: true });
  } catch (e) {
    if (e instanceof HttpError) return sendJson(res, e.status, { error: { code: e.code, message: e.message, details: e.details } });
    // Never leak internals to clients; log a redacted line server-side.
    console.error(JSON.stringify({ level: 'error', msg: (e as Error).message, path: url.pathname, t: now() }));
    return sendJson(res, 500, { error: { code: 'internal', message: 'Something went wrong on our side.' } });
  }
}

export function createServer() {
  return http.createServer((req, res) => void handle(req, res));
}
