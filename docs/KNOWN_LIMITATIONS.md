# Known limitations and what has not been verified

Written to be read before use. Facts are stated as facts; anything not tested is marked as such.

## Not built

- **Email sending.** Notifications are in-app; email copies are queued and never sent (no sender is implemented yet).
- **Reminders** (milestones due, workshop tomorrow, sessions, overdue actions) and **automatic data retention/deletion**.
- **Data export for the person** ("download my data").
- **Governance records** (versioned organisational documents with approval) and the live Terms and Privacy pages. The pages
  shown are drafts, marked as drafts, and have not been reviewed by a lawyer.
- **Network / alumni directory and messaging.** There is no member-to-member messaging.
- **Mentor access to a mentee's venture plan.** Mentors see the goals the mentee wrote in the request, not the venture itself.
- **PDF export** of reports (CSV export exists), guided product tour, SMS or WhatsApp, calendar sync, online payments or
  any bank/payment integration, AI recommendations, two-step (MFA) sign-in.
- **Pagination everywhere.** The staff queues for support, role requests, programme applications, funding, mentoring and
  analytics are paged. Some other lists (users, audit log, verification, mentor applications, ventures, milestones,
  workshops, resources) still use fixed limits or cursors.

## Different from the upgrade plan

- The upgrade plan assumes an earlier ZIP and a Supabase project. **Neither was supplied.** This is a new build on SQLite
  (built-in `node:sqlite`) with the access rules enforced in the API, not in database row-level-security policies.
  Plan items F-01 to F-05, E-01, E-02, DP-04 and "preserve applied migrations" cannot be verified and are reported as such.
- There is no antivirus engine. Uploads are checked for type, size, ownership and obvious active content only. Files are
  labelled "basic checks passed", never "virus free".
- No lockfile: the npm registry was unreachable while building, so dependency versions for the dev tools are pinned in
  `package.json` but unlocked, and no vulnerability audit of dependencies was run. The app itself has no runtime packages.

## Not verified

- The **Dockerfile** and the **GitHub Actions file** were written but never executed.
- **Nothing was deployed** to a host, so HTTPS, redirect settings and production variables are untested.
- **Performance** at realistic volumes was not measured.
- **Browser coverage**: the browser test ran in Chromium only (desktop and a 390 px mobile viewport). Other browsers and a
  screen reader were not tried; the accessibility checks are automated basics (landmarks, labels, headings, unique ids).
- **Sessions and rate limits** are in memory / single-process.

## Security notes you should know

- Behind a proxy the client address comes from `X-Forwarded-For` in production. Do not expose the app port directly.
- Single-use confirmation and reset links are stored in the email outbox in clear text until they are used or expire.
- The registration form tells a visitor when an email address already has an account (needed to tell people why sign-up
  failed). Sign-in and "forgot password" give the same answer whether or not the account exists. Registration is rate
  limited; this trade-off is deliberate and recorded here.
- When no email provider is configured, the "forgot password" API response still reads "a reset link has been sent". The
  sign-up and reset screens carry a separate warning that nothing is sent, but the API wording is misleading until a
  mailer exists.
- Passwords are hashed with scrypt; session tokens are stored hashed. Step-up password checks guard role changes, status
  changes, settings, role-request approval and payment records.

## Legal and policy

The Terms and Privacy text is a **draft for review** and makes no compliance claim (for example under the Nigeria Data
Protection Act). The organisation must adopt its own final text and retention periods.
