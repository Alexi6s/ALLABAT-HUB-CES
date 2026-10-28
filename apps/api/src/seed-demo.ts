// Demo data for local evaluation ONLY.
//
//   npm run seed:demo -- --confirm
//
// Safety rules:
//  - Refuses to run when NODE_ENV=production.
//  - Refuses to run without --confirm (NODE_ENV defaults to "development" when unset, so a forgotten variable must not be enough).
//  - Every account uses the reserved ".invalid" top-level domain (it can never receive real email) and a "[DEMO]" name prefix.
//  - No default password exists: a random one is generated per run and printed once to this terminal. It is not written anywhere else.
//  - Idempotent: if demo accounts already exist, nothing is changed.
//  - Creates no documents, no payments and no disbursements.
import { randomBytes } from 'node:crypto';
import { config, openDb, closeDb, q, tx, hashPassword, uid, now, audit } from './core.ts';
import type { Role } from './policy.ts';

export const DEMO_DOMAIN = 'demo.alabatt.invalid';

type Person = { key: string; name: string; category: string; roles: Role[] };
const PEOPLE: Person[] = [
  { key: 'admin', name: 'Admin', category: 'staff', roles: ['admin'] },
  { key: 'super', name: 'Super Admin', category: 'staff', roles: ['super_admin'] },
  { key: 'support', name: 'Support Officer', category: 'staff', roles: ['support_officer'] },
  { key: 'coordinator', name: 'Programme Coordinator', category: 'staff', roles: ['programme_coordinator'] },
  { key: 'funding', name: 'Funding Officer', category: 'staff', roles: ['funding_officer'] },
  { key: 'incubation', name: 'Incubation Manager', category: 'staff', roles: ['incubation_manager'] },
  { key: 'student', name: 'Student', category: 'student', roles: ['student'] },
  { key: 'lecturer', name: 'Lecturer', category: 'lecturer', roles: ['lecturer'] },
  { key: 'alumni', name: 'Alumnus', category: 'alumni', roles: ['alumni'] },
  { key: 'entrepreneur', name: 'External Entrepreneur', category: 'external_entrepreneur', roles: ['external_entrepreneur'] },
  { key: 'partner', name: 'Partner', category: 'partner', roles: ['partner'] },
  { key: 'mentor', name: 'Mentor', category: 'mentor_applicant', roles: ['mentor'] },
];

export const demoEmail = (key: string) => `${key}@${DEMO_DOMAIN}`;

export function seedDemo(opts: { password?: string } = {}) {
  if (config.env === 'production') throw new Error('Refusing to seed demo data: NODE_ENV is "production".');
  if (q.get('SELECT 1 FROM users WHERE email LIKE ?', `%@${DEMO_DOMAIN}`)) return { created: false as const, password: null };

  const password = opts.password ?? randomBytes(9).toString('base64url') + 'aA1!';
  const hash = hashPassword(password);
  const t = now();
  const ids: Record<string, string> = {};

  tx(() => {
    for (const p of PEOPLE) {
      const id = uid();
      ids[p.key] = id;
      q.run(`INSERT INTO users(id,email,password_hash,full_name,category,email_verified,verification_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        id, demoEmail(p.key), hash, `[DEMO] ${p.name}`, p.category, 1, 'verified', t, t);
      q.run('INSERT INTO affiliations(user_id, institution, organization, updated_at) VALUES (?,?,?,?)', id, 'Demo University (fictional)', 'Demo organisation (fictional)', t);
      q.run('INSERT INTO notification_preferences(user_id) VALUES (?)', id);
      for (const r of p.roles) q.run('INSERT INTO user_roles(user_id, role, granted_by, granted_at) VALUES (?,?,?,?)', id, r, null, t);
    }

    q.run(`INSERT INTO mentor_applications(id,user_id,status,organization,position,bio,expertise,industries,venture_stages,languages,meeting_formats,timezone,availability,capacity,coc_accepted,created_at,updated_at,submitted_at,decided_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      uid(), ids.mentor, 'approved', 'Demo organisation (fictional)', 'Advisor', '[DEMO] Fictional mentor profile for evaluating the matching screen.',
      JSON.stringify(['go-to-market', 'financial planning']), JSON.stringify(['agritech', 'fintech']), JSON.stringify(['idea', 'validation']),
      JSON.stringify(['English']), JSON.stringify(['online']), 'Africa/Lagos', 'Weekday evenings', 3, 1, t, t, t, t);

    const ventureId = uid();
    q.run(`INSERT INTO ventures(id,owner_id,name,description,problem,solution,target_market,value_proposition,industry,stage,status,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ventureId, ids.student, '[DEMO] Example Venture', 'Fictional venture used to show the workspace.', 'Fictional problem statement.', 'Fictional solution.',
      'Fictional target market.', 'Fictional value proposition.', 'agritech', 'idea', 'incubating', t, t);
    q.run('INSERT INTO venture_members(venture_id,user_id,member_role,added_at) VALUES (?,?,?,?)', ventureId, ids.student, 'owner', t);
    q.run(`INSERT INTO milestones(id,venture_id,title,description,completion_criteria,status,evidence_type,created_by,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
      uid(), ventureId, '[DEMO] Interview five potential customers', 'Fictional milestone.', 'Five written interview summaries.', 'not_started', 'self_reported', ids.coordinator, t, t);

    q.run(`INSERT INTO programmes(id,title,description,status,eligible_categories,requires_verification,capacity,created_by,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
      uid(), '[DEMO] Venture Accelerator (fictional cohort)', 'Fictional programme for evaluating applications and capacity.', 'published', '[]', 1, 10, ids.coordinator, t, t);

    const start = new Date(Date.now() + 7 * 864e5); start.setUTCHours(10, 0, 0, 0);
    const end = new Date(start.getTime() + 2 * 36e5);
    q.run(`INSERT INTO workshops(id,title,description,mode,meeting_link,starts_at,ends_at,capacity,eligible_categories,status,created_by,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      uid(), '[DEMO] Customer discovery basics (fictional session)', 'Fictional workshop.', 'online', 'https://meet.example.invalid/demo', start.toISOString(), end.toISOString(), 25, '[]', 'published', ids.coordinator, t);

    q.run(`INSERT INTO funding_opportunities(id,title,description,currency,min_amount,max_amount,total_budget,eligible_categories,criteria,status,created_by,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      uid(), '[DEMO] Example seed grant (no real money)', 'Fictional opportunity. No funds exist and none can be paid.', 'NGN', 0, 500000, 2000000, '[]', 'Fictional criteria.', 'open', ids.funding, t);

    audit(null, 'demo.seeded', 'system', null, { accounts: PEOPLE.length });
  });
  return { created: true as const, password };
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  if (config.env === 'production') { console.error('Refusing: NODE_ENV is "production". Demo data must never be created in production.'); process.exit(1); }
  if (!process.argv.includes('--confirm')) {
    console.error(`This creates clearly labelled DEMO accounts and records in:\n  ${config.dbFile}\nRe-run with --confirm to proceed:  npm run seed:demo -- --confirm`);
    process.exit(1);
  }
  openDb();
  const r = seedDemo();
  closeDb();
  if (!r.created) { console.log('Demo accounts already exist; nothing changed.'); process.exit(0); }
  console.log(`Demo data created in ${config.dbFile}`);
  console.log(`Password for every demo account (shown once, not stored anywhere else): ${r.password}`);
  console.log('Accounts (all fictional, ".invalid" addresses never receive email):');
  for (const p of PEOPLE) console.log(`  ${demoEmail(p.key).padEnd(34)} ${p.roles.join(', ')}`);
}
