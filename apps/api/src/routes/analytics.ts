// Reports, part 2: trends over time, review turnaround and reviewer workload for a chosen period.
// Everything is aggregated on the server. Viewers who only get suppressed counts (partners, report viewers) see no cell below the
// small-group threshold and never see who reviewed what.
import { HttpError, now, q } from '../core.ts';
import { get } from '../http.ts';
import { can, hasRole, type AuthUser, type Permission } from '../policy.ts';

const SMALL = 5;
const exactCounts = (u: AuthUser) => hasRole(u, 'programme_coordinator', 'incubation_manager', 'funding_officer', 'admin', 'super_admin');
const DAY = 864e5;

function parseDay(raw: string | null, field: string): string | null {
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) throw new HttpError(422, 'validation_failed', 'Some fields need attention.', { [field]: 'Use a date like 2026-01-31.' });
  return raw;
}

/** Month keys (YYYY-MM) covered by [from, to), oldest first. */
function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from.slice(0, 7)}-01T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d < end) {
    out.push(d.toISOString().slice(0, 7));
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round1 = (n: number) => Math.round(n * 10) / 10;

get('/api/reports/analytics', (c) => {
  const exact = exactCounts(c.user);
  const today = now().slice(0, 10);
  const defaultFrom = (() => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 11); return d.toISOString().slice(0, 10); })();
  const from = parseDay(c.query.get('from'), 'from') ?? defaultFrom;
  const toDay = parseDay(c.query.get('to'), 'to') ?? today;
  if (toDay < from) throw new HttpError(422, 'validation_failed', 'Some fields need attention.', { to: 'The end date must not be before the start date.' });
  const endExclusive = new Date(Date.parse(`${toDay}T00:00:00Z`) + DAY).toISOString();
  const startIso = `${from}T00:00:00.000Z`;
  const months = monthsBetween(from, endExclusive.slice(0, 10));
  if (months.length > 36) throw new HttpError(422, 'validation_failed', 'Some fields need attention.', { from: 'Choose a period of at most 36 months.' });

  // A cell below the threshold is hidden (null) for viewers who only get suppressed counts. 0 is a real, safe zero.
  const cell = (n: number): number | null => (exact || n === 0 || n >= SMALL ? n : null);

  const series = (label: string, key: string, sql: string, link: string | null, perm: Permission | null) => {
    const byMonth = new Map(q.all<{ m: string; n: number }>(sql, startIso, endExclusive).map((r) => [r.m, r.n]));
    const values = months.map((m) => cell(byMonth.get(m) ?? 0));
    const total = [...byMonth.values()].reduce((a, b) => a + b, 0);
    return { key, label, values, total: cell(total), link: link && (!perm || can(c.user, perm)) ? link : null };
  };

  const trends = [
    series('New accounts', 'registrations', "SELECT substr(created_at,1,7) AS m, COUNT(*) AS n FROM users WHERE created_at >= ? AND created_at < ? GROUP BY m", can(c.user, 'user.manage') ? '#/admin/users' : null, null),
    series('Programme applications submitted', 'programme_applications', "SELECT substr(submitted_at,1,7) AS m, COUNT(*) AS n FROM programme_applications WHERE submitted_at >= ? AND submitted_at < ? GROUP BY m", '#/admin/programmes', 'programme.manage'),
    series('Funding applications submitted', 'funding_applications', "SELECT substr(submitted_at,1,7) AS m, COUNT(*) AS n FROM funding_applications WHERE submitted_at >= ? AND submitted_at < ? GROUP BY m", '#/admin/funding', 'funding.manage'),
    series('Milestones verified complete', 'milestones_completed', "SELECT substr(completed_at,1,7) AS m, COUNT(*) AS n FROM milestones WHERE status = 'completed' AND evidence_type = 'verified' AND completed_at >= ? AND completed_at < ? GROUP BY m", '#/admin/milestones', 'milestone.review'),
    series('Mentoring sessions held', 'mentoring_sessions', "SELECT substr(scheduled_at,1,7) AS m, COUNT(*) AS n FROM mentorship_sessions WHERE status = 'completed' AND scheduled_at >= ? AND scheduled_at < ? GROUP BY m", '#/admin/mentoring', 'mentor.review'),
    series('Support tickets opened', 'support_tickets', "SELECT substr(created_at,1,7) AS m, COUNT(*) AS n FROM support_requests WHERE created_at >= ? AND created_at < ? GROUP BY m", '#/admin/support', 'support.manage'),
  ];

  // Review turnaround: how long people wait for a decision. Only decided items in the period count.
  const turn = (key: string, label: string, sql: string, link: string, perm: Permission) => {
    const rows = q.all<{ a: string; b: string }>(sql, startIso, endExclusive);
    const days = rows.map((r) => (Date.parse(r.b) - Date.parse(r.a)) / DAY).filter((d) => Number.isFinite(d) && d >= 0);
    const hide = !exact && days.length < SMALL;
    return {
      key, label, decided: hide && days.length ? null : days.length,
      average_days: days.length && !hide ? round1(mean(days)) : null, median_days: days.length && !hide ? round1(median(days)) : null,
      link: can(c.user, perm) ? link : null,
    };
  };
  const turnaround = [
    turn('verification', 'Verification requests', "SELECT created_at AS a, decided_at AS b FROM verification_requests WHERE decided_at IS NOT NULL AND created_at >= ? AND created_at < ? LIMIT 5000", '#/admin/verification', 'verification.review'),
    turn('mentor_applications', 'Mentor applications', "SELECT submitted_at AS a, decided_at AS b FROM mentor_applications WHERE decided_at IS NOT NULL AND submitted_at >= ? AND submitted_at < ? LIMIT 5000", '#/admin/mentors', 'mentor.review'),
    turn('programme_applications', 'Programme applications', "SELECT submitted_at AS a, decided_at AS b FROM programme_applications WHERE decided_at IS NOT NULL AND submitted_at >= ? AND submitted_at < ? LIMIT 5000", '#/admin/programmes', 'programme.manage'),
    turn('funding_applications', 'Funding applications', "SELECT submitted_at AS a, decided_at AS b FROM funding_applications WHERE decided_at IS NOT NULL AND submitted_at >= ? AND submitted_at < ? LIMIT 5000", '#/admin/funding', 'funding.manage'),
    turn('support_tickets', 'Support tickets (time to resolve)', "SELECT created_at AS a, resolved_at AS b FROM support_requests WHERE resolved_at IS NOT NULL AND created_at >= ? AND created_at < ? LIMIT 5000", '#/admin/support', 'support.manage'),
  ].filter((t) => t.link !== null);

  // Reviewer workload names people, so it is shown only to roles that already see exact counts.
  let workload: unknown[] | null = null;
  if (exact) {
    const rows = new Map<string, { user_id: string; name: string; verification: number; programme: number; funding: number; support: number }>();
    const add = (key: 'verification' | 'programme' | 'funding' | 'support', sql: string) => {
      for (const r of q.all<{ id: string; name: string; n: number }>(sql, startIso, endExclusive)) {
        const row = rows.get(r.id) ?? { user_id: r.id, name: r.name, verification: 0, programme: 0, funding: 0, support: 0 };
        row[key] = r.n;
        rows.set(r.id, row);
      }
    };
    add('verification', "SELECT u.id AS id, u.full_name AS name, COUNT(*) AS n FROM verification_requests r JOIN users u ON u.id = r.reviewer_id WHERE r.decided_at >= ? AND r.decided_at < ? GROUP BY u.id");
    add('programme', "SELECT u.id AS id, u.full_name AS name, COUNT(*) AS n FROM programme_applications r JOIN users u ON u.id = r.decided_by WHERE r.decided_at >= ? AND r.decided_at < ? GROUP BY u.id");
    add('funding', "SELECT u.id AS id, u.full_name AS name, COUNT(*) AS n FROM funding_applications r JOIN users u ON u.id = r.decided_by WHERE r.decided_at >= ? AND r.decided_at < ? GROUP BY u.id");
    add('support', "SELECT u.id AS id, u.full_name AS name, COUNT(*) AS n FROM support_requests r JOIN users u ON u.id = r.responder_id WHERE r.resolved_at >= ? AND r.resolved_at < ? GROUP BY u.id");
    workload = [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  return {
    range: { from, to: toDay },
    generated_at: now(),
    suppression: exact ? 'none' : `Monthly counts below ${SMALL} are hidden to protect individuals.`,
    months, trends, turnaround, workload,
  };
}, { perm: 'report.view' });
