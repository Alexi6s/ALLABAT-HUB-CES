// Server entry point: loads every route module, bootstraps the first super administrator from the environment, and starts listening.
import { config, openDb, q, hashPassword, checkPassword, uid, now, audit } from './core.ts';
import { createServer } from './http.ts';
import './routes/identity.ts';
import './routes/mentors.ts';
import './routes/programmes.ts';
import './routes/funding.ts';
import './routes/platform.ts';
import './routes/admin.ts';
import './routes/support.ts';
import './routes/mentoring-ops.ts';
import './routes/analytics.ts';

/** Creates the first super administrator only when BOTH variables are set and that email does not exist yet. Never creates default credentials. */
export function bootstrapAdmin() {
  const email = config.bootstrapEmail.trim().toLowerCase();
  if (!email || !config.bootstrapPassword) return null;
  checkPassword(config.bootstrapPassword);
  if (q.get('SELECT 1 FROM users WHERE email = ?', email)) return null;
  const id = uid();
  q.run(`INSERT INTO users(id,email,password_hash,full_name,category,email_verified,verification_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    id, email, hashPassword(config.bootstrapPassword), 'Platform Administrator', 'staff', 1, 'verified', now(), now());
  q.run('INSERT INTO affiliations(user_id, updated_at) VALUES (?,?)', id, now());
  q.run('INSERT INTO notification_preferences(user_id) VALUES (?)', id);
  q.run("INSERT INTO user_roles(user_id, role, granted_by, granted_at) VALUES (?, 'super_admin', NULL, ?)", id, now());
  audit(null, 'bootstrap.super_admin_created', 'user', id, { email });
  return id;
}

export function start() {
  openDb();
  const created = bootstrapAdmin();
  const server = createServer();
  server.listen(config.port, () => {
    console.log(JSON.stringify({ level: 'info', msg: 'ALABATT-CES listening', port: config.port, env: config.env, bootstrap_admin_created: !!created }));
    if (!q.get("SELECT 1 FROM user_roles WHERE role = 'super_admin'"))
      console.log(JSON.stringify({ level: 'warn', msg: 'No super administrator exists. Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD, then restart.' }));
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return server;
}

if (process.argv[1] && import.meta.filename === process.argv[1]) start();
