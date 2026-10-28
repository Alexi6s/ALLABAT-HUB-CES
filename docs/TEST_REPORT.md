# Test report

Every result below comes from a command that was run in this workspace on 2026-10-28 (Node v22.23.4, Linux). Nothing is
listed that was not run. Output is not edited; commands can be repeated from the README.

| Check | Command | Result |
|---|---|---|
| Strict type check of the API | `tsc -p apps/api/tsconfig.json` (TypeScript 6.0.3) | exit 0, no errors |
| API and database tests | `npm test` | 90 tests, 90 passed, 0 failed, 0 skipped, about 36 s |
| Web client static check | `npm run check:web` | passed: 8 modules, 58 routes, 32 actions, 64 forms |
| Generated docs are current | `node scripts/gen-api-docs.ts --check` and `node scripts/gen-db-docs.ts --check` | both exit 0 |
| Browser test (Chromium) | `npm run test:e2e` | 27 steps, 27 passed, 0 failed |

## What the API tests cover (90 tests, 12 files)

admin (9), analytics (5), funding (10), governance (8), identity (12), mentoring (4), migration (2), ops (4),
programmes (10), security (16), support (4), workflow (6). They start the real server and call it over HTTP with a fresh
in-memory database per file. They include: permission and ownership checks (other people's records answer 404), step-up
password checks, separation of duties, lockout, CSRF and origin guard, upload safety, privacy of internal review fields,
small-group suppression in reports, migrations applied once and recorded, and a freshness test for the generated docs.

## What the browser test covers

Desktop and a 390 px mobile viewport in Chromium: registration and sign-in, member and administration workspaces, the
administration overview, role requests, support threads, programme and funding queues, mentoring (accept, plan, cancel,
record, conflict report), reports with charts, access-denied views, mobile menu behaviour, a loading state, sign-out. It
also checks that each main screen has one `h1`, a landmark, a page title and labelled controls, and that no console error,
page error or Content-Security-Policy violation occurs across the whole run.

## Not tested

- The Dockerfile and `.github/workflows/ci.yml` were never executed.
- No test of sending email (no sender exists yet).
- No load or volume measurement.
- Browsers other than Chromium; screen readers; real phones.
- Anything on a hosted environment: nothing has been deployed.
- Dependency vulnerability audit: not possible without registry access, and there is no lockfile.
