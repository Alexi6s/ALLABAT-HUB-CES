# Operations guide

Who this is for: the person who installs, configures, backs up and updates ALABATT-CES. Nothing in this file has been run
against a public host; every command was run locally except where a line says so.

## Requirements

- Node.js 22.18 or newer. No runtime npm packages.
- A persistent, backed-up folder for `DATA_DIR` (SQLite database and private uploads).
- HTTPS in front of the app (a reverse proxy such as nginx or Caddy). The app speaks plain HTTP itself.

## Configuration

The server reads real environment variables. `.env.example` lists them; load it with your process manager or
`node --env-file=.env apps/api/src/server.ts`. **Never commit `.env`.** Secrets stay on the server; the browser receives none.

| Variable | Default | Meaning |
|---|---|---|
| `NODE_ENV` | `development` | `production` turns on the `Secure` cookie flag and HSTS, and removes the on-screen email links. |
| `PORT` | `8787` | Listening port. |
| `APP_URL` | `http://localhost:8787` | Public address, used in links. |
| `DATA_DIR` | `./data` | Database and uploads. Must persist across restarts. |
| `DB_FILE` | `DATA_DIR/alabatt-ces.sqlite` | Override the database path. |
| `SESSION_HOURS` | `12` | Session lifetime. |
| `MAX_UPLOAD_BYTES` | `5242880` | Upload size limit (5 MB). |
| `MENTOR_APPROVALS_REQUIRED` | `1` | Initial number of distinct reviewer approvals for a mentor. A super administrator can change it in Settings. |
| `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD` | empty | Create the first super administrator at start-up, only if both are set and the email is new. Remove them after the first start. There is no default account. |
| `EXPOSE_DEV_TOKENS` | on outside production | Shows confirmation and reset links on screen. Always off in production. |
| `SMTP_*`, `MAIL_FROM` | empty | Outbound email settings. See "Email" below for what is and is not implemented. |

## First start

1. Set `NODE_ENV=production`, `APP_URL`, `DATA_DIR`, and the two bootstrap variables.
2. Start: `node apps/api/src/server.ts`. Migrations run automatically and are recorded in `schema_migrations`.
3. Check `GET /api/health` returns `{"status":"ok","time":...}`.
4. Sign in as the bootstrap administrator, change nothing else yet, then **remove the two bootstrap variables** and restart.
5. In Users and roles, create no accounts by hand: people register themselves; staff roles are granted from the user page
   (administrator password required) or through a member's role request.

The Dockerfile is provided. **It was never built or run** (no container daemon was available). Build it and check the
health endpoint before depending on it.

## Backup and recovery

```
npm run backup                               # writes a timestamped folder under ./backups (or BACKUP_DIR)
npm run backup -- --verify <backup-dir>      # checks file hashes and PRAGMA integrity_check
npm run backup -- --restore <backup-dir>     # stop the server first; add --force to replace existing data
```

A backup contains personal data and private documents. Encrypt it, copy it off the host, and rotate it yourself: the script
does none of that. Test a restore on a spare machine before you need it.

## Updating and rolling back

1. Stop the server. Take a backup and verify it.
2. Replace the application files. Start the server; any new migration runs once and is recorded.
3. Check `/api/health` and sign in.
4. Rolling back the code is safe only if no new migration ran. If one did, restore the backup taken in step 1 as well.
   Migrations are forward-only; there are no down-migrations.

## Reverse proxy and client addresses

Run the app behind HTTPS. Rate limits and the sign-in lockout use the client address. Until the `TRUST_PROXY` setting is
added (see `docs/KNOWN_LIMITATIONS.md`), the app reads the first `X-Forwarded-For` entry in production, so **never expose
the app port directly to the internet**; expose only the proxy, and make the proxy overwrite that header.

## Security headers and rate limits

Set by the app: strict Content-Security-Policy (no inline script or style), `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, a restrictive `Permissions-Policy`, and HSTS in
production. Rate limiting is in memory per process: 600 requests per minute per address, plus tighter limits on sign-in,
registration and similar routes. With more than one instance you would need a shared store; none is provided.

## Smoke test after a deploy

1. `GET /api/health` is OK.
2. Register a throwaway account, confirm it, sign in, sign out.
3. Sign in as the administrator; the overview opens; open Reports.
4. Check the audit log contains your sign-ins.
5. Delete the throwaway account's data through support if it is real production data.

## Email

Email sending is **not implemented yet in this build**. Notifications appear in the app and a copy is written to an outbox
table with status `queued_no_provider`; nothing leaves the server. The platform says so on the registration, reset and
notification screens. Until sending exists, an administrator can confirm a member's email address manually (audited).
