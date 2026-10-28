// Mentor applications and governance, mentor directory, transparent matching, and the mentorship lifecycle.
import {
  Input, HttpError, audit, bad, conflict, forbidden, getConfigNumber, config, json, notFound, notify, now, parseJson, q, tx, uid,
} from '../core.ts';
import { get, post, put, Created } from '../http.ts';
import { can, requireVerified, type AuthUser } from '../policy.ts';

const STAGES = ['idea', 'validation', 'prototype', 'launch', 'growth'] as const;
const FORMATS = ['in_person', 'online', 'hybrid'] as const;

const hydrate = (a: any) => ({
  ...a,
  expertise: parseJson(a.expertise, []), industries: parseJson(a.industries, []), venture_stages: parseJson(a.venture_stages, []),
  languages: parseJson(a.languages, []), meeting_formats: parseJson(a.meeting_formats, []),
});

// ---------- applicant side ----------
get('/api/mentor/application', (c) => {
  const a = q.get<any>('SELECT * FROM mentor_applications WHERE user_id = ?', c.user.id);
  const docs = q.all("SELECT id, category, original_name, scan_status FROM documents WHERE owner_id = ? AND category IN ('mentor_credential','professional_certificate','reference')", c.user.id);
  return { application: a ? hydrate(a) : null, documents: docs };
});

put('/api/mentor/application', (c) => {
  if (!c.user.email_verified) throw new HttpError(403, 'email_unverified', 'Confirm your email address first.');
  const i = new Input(c.body);
  const organization = i.str('organization', { max: 160, required: false });
  const position = i.str('position', { max: 160, required: false });
  const bio = i.str('bio', { max: 3000, required: false });
  const expertise = i.list('expertise', { max: 15 });
  const industries = i.list('industries', { max: 15 });
  const stages = i.list('venture_stages', { allowed: STAGES });
  const languages = i.list('languages', { max: 10 });
  const formats = i.list('meeting_formats', { allowed: FORMATS });
  const timezone = i.str('timezone', { max: 60, required: false });
  const availability = i.str('availability', { max: 500, required: false });
  const capacity = i.int('capacity', { min: 1, max: 20, required: false }) ?? 3;
  const references = i.str('references_text', { max: 2000, required: false });
  const coc = i.bool('coc_accepted') ?? false;
  const conflictDecl = i.str('conflict_declaration', { max: 1000, required: false });
  i.done();
  tx(() => {
    const ex = q.get<any>('SELECT * FROM mentor_applications WHERE user_id = ?', c.user.id);
    if (ex && !['draft', 'more_info_required', 'withdrawn', 'rejected'].includes(ex.status)) throw conflict(`Your application is ${ex.status} and cannot be edited now.`);
    if (!ex) {
      q.run(`INSERT INTO mentor_applications(id,user_id,status,organization,position,bio,expertise,industries,venture_stages,languages,meeting_formats,timezone,availability,capacity,references_text,coc_accepted,conflict_declaration,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, uid(), c.user.id, 'draft', organization, position, bio, json(expertise), json(industries), json(stages), json(languages), json(formats), timezone, availability, capacity, references, coc, conflictDecl, now(), now());
    } else {
      q.run(`UPDATE mentor_applications SET status = CASE WHEN status IN ('withdrawn','rejected') THEN 'draft' ELSE status END, organization=?,position=?,bio=?,expertise=?,industries=?,venture_stages=?,languages=?,meeting_formats=?,timezone=?,availability=?,capacity=?,references_text=?,coc_accepted=?,conflict_declaration=?,updated_at=? WHERE user_id=?`,
        organization, position, bio, json(expertise), json(industries), json(stages), json(languages), json(formats), timezone, availability, capacity, references, coc, conflictDecl, now(), c.user.id);
    }
  });
  return { ok: true };
});

post('/api/mentor/application/submit', (c) => {
  tx(() => {
    const a = q.get<any>('SELECT * FROM mentor_applications WHERE user_id = ?', c.user.id);
    if (!a) throw notFound('Save your application first.');
    if (!['draft', 'more_info_required'].includes(a.status)) throw conflict(`Your application is ${a.status}.`);
    const problems: Record<string, string> = {};
    if (!a.bio || a.bio.length < 50) problems.bio = 'Write a professional biography of at least 50 characters.';
    if (parseJson<string[]>(a.expertise, []).length < 1) problems.expertise = 'List at least one area of expertise.';
    if (parseJson<string[]>(a.venture_stages, []).length < 1) problems.venture_stages = 'Choose at least one venture stage.';
    if (!a.coc_accepted) problems.coc_accepted = 'You must accept the mentor code of conduct.';
    if (!a.conflict_declaration) problems.conflict_declaration = 'Provide a conflict-of-interest declaration (write "None" if there is none).';
    if (!q.get("SELECT 1 FROM documents WHERE owner_id = ? AND category IN ('mentor_credential','professional_certificate') AND scan_status <> 'quarantined'", c.user.id)) problems.documents = 'Upload at least one credential document.';
    if (Object.keys(problems).length) throw new HttpError(422, 'validation_failed', 'Your application is incomplete.', problems);
    q.run("UPDATE mentor_applications SET status='submitted', submitted_at=?, updated_at=? WHERE id=?", now(), now(), a.id);
    audit(c.user.id, 'mentor.application_submitted', 'mentor_application', a.id, null, c.ip);
  });
  for (const r of q.all<any>("SELECT DISTINCT user_id FROM user_roles WHERE role IN ('incubation_manager','admin','super_admin')")) notify(r.user_id, 'review', 'New mentor application', `${c.user.full_name} applied to become a mentor.`, '#/admin/mentors');
  return { ok: true };
});

post('/api/mentor/application/withdraw', (c) => {
  const a = q.get<any>('SELECT * FROM mentor_applications WHERE user_id = ?', c.user.id);
  if (!a || a.status === 'withdrawn') throw notFound();
  tx(() => {
    q.run("UPDATE mentor_applications SET status='withdrawn', updated_at=? WHERE id=?", now(), a.id);
    q.run("DELETE FROM user_roles WHERE user_id=? AND role='mentor'", c.user.id);
    for (const r of q.all<any>("SELECT id, mentee_id FROM mentorship_requests WHERE mentor_user_id=? AND status='pending'", c.user.id)) {
      q.run("UPDATE mentorship_requests SET status='cancelled', responded_at=? WHERE id=?", now(), r.id);
      notify(r.mentee_id, 'mentorship', 'Mentorship request cancelled', 'The mentor is no longer available.', '#/mentorship');
    }
    audit(c.user.id, 'mentor.application_withdrawn', 'mentor_application', a.id, null, c.ip);
  });
  return { ok: true };
});

// ---------- reviewer side ----------
get('/api/admin/mentor-applications', (c) => {
  const status = c.query.get('status');
  return {
    applications: q.all(
      `SELECT a.id, a.status, a.submitted_at, a.organization, a.position, u.full_name, u.email, u.verification_status,
              (SELECT COUNT(*) FROM mentor_reviews r WHERE r.application_id = a.id AND r.decision = 'approve') AS approvals
       FROM mentor_applications a JOIN users u ON u.id = a.user_id WHERE a.status <> 'draft' AND (? IS NULL OR a.status = ?) ORDER BY a.submitted_at ASC LIMIT 200`, status, status),
  };
}, { perm: 'mentor.review' });

get('/api/admin/mentor-applications/:id', (c) => {
  const a = q.get<any>('SELECT a.*, u.full_name, u.email, u.verification_status FROM mentor_applications a JOIN users u ON u.id = a.user_id WHERE a.id = ?', c.params.id);
  if (!a) throw notFound();
  if (a.status === 'draft') throw notFound();
  const documents = q.all("SELECT id, category, original_name, mime, size, scan_status FROM documents WHERE owner_id = ? AND category IN ('mentor_credential','professional_certificate','reference')", a.user_id);
  const reviews = q.all('SELECT r.decision, r.notes, r.created_at, u.full_name AS reviewer FROM mentor_reviews r JOIN users u ON u.id = r.reviewer_id WHERE r.application_id = ? ORDER BY r.created_at', a.id);
  audit(c.user.id, 'mentor.application_viewed', 'mentor_application', a.id, null, c.ip);
  return { application: hydrate(a), documents, reviews, approvals_required: getConfigNumber('mentor_approvals_required', config.mentorApprovalsRequired) };
}, { perm: 'mentor.review' });

post('/api/admin/mentor-applications/:id/review', (c) => {
  const i = new Input(c.body);
  const decision = i.oneOf('decision', ['approve', 'reject', 'more_info', 'suspend', 'recuse'] as const);
  const notes = i.str('notes', { min: 5, max: 2000 });
  i.done();
  tx(() => {
    const a = q.get<any>('SELECT * FROM mentor_applications WHERE id = ?', c.params.id);
    if (!a || a.status === 'draft') throw notFound();
    if (a.user_id === c.user.id) throw forbidden('You cannot review your own application.');
    if (q.get("SELECT 1 FROM mentor_reviews WHERE application_id=? AND reviewer_id=? AND decision='recuse'", a.id, c.user.id)) throw forbidden('You recused yourself from this application.');
    try {
      q.run('INSERT INTO mentor_reviews(id,application_id,reviewer_id,decision,notes,created_at) VALUES (?,?,?,?,?,?)', uid(), a.id, c.user.id, decision, notes, now());
    } catch {
      throw conflict('You have already recorded this decision.');
    }
    if (decision === 'recuse') {
      audit(c.user.id, 'mentor.reviewer_recused', 'mentor_application', a.id, { notes }, c.ip);
      return;
    }
    const from = a.status as string;
    const allowed: Record<string, string[]> = {
      approve: ['submitted', 'under_review', 'suspended'], reject: ['submitted', 'under_review'], more_info: ['submitted', 'under_review'], suspend: ['approved'],
    };
    if (!allowed[decision!].includes(from)) throw conflict(`An application that is ${from} cannot receive "${decision}".`);
    let next = from;
    if (decision === 'approve') {
      const applicant = q.get<any>('SELECT verification_status FROM users WHERE id = ?', a.user_id)!;
      if (applicant.verification_status !== 'verified') throw conflict('The applicant must complete identity verification before approval.');
      const approvals = q.get<{ n: number }>("SELECT COUNT(DISTINCT reviewer_id) AS n FROM mentor_reviews WHERE application_id=? AND decision='approve'", a.id)!.n;
      const needed = getConfigNumber('mentor_approvals_required', config.mentorApprovalsRequired);
      next = from === 'suspended' || approvals >= needed ? 'approved' : 'under_review';
    } else next = decision === 'reject' ? 'rejected' : decision === 'more_info' ? 'more_info_required' : 'suspended';
    q.run('UPDATE mentor_applications SET status=?, decided_at=CASE WHEN ? IN (\'approved\',\'rejected\',\'suspended\') THEN ? ELSE decided_at END, updated_at=? WHERE id=?', next, next, now(), now(), a.id);
    if (next === 'approved') q.run('INSERT OR IGNORE INTO user_roles(user_id, role, granted_by, granted_at) VALUES (?,?,?,?)', a.user_id, 'mentor', c.user.id, now());
    if (next === 'suspended' || next === 'rejected') q.run("DELETE FROM user_roles WHERE user_id=? AND role='mentor'", a.user_id);
    if (next === 'suspended') {
      for (const r of q.all<any>("SELECT id, mentee_id FROM mentorship_requests WHERE mentor_user_id=? AND status='pending'", a.user_id)) {
        q.run("UPDATE mentorship_requests SET status='cancelled', responded_at=? WHERE id=?", now(), r.id);
        notify(r.mentee_id, 'mentorship', 'Mentorship request cancelled', 'The mentor is temporarily unavailable.', '#/mentorship');
      }
    }
    audit(c.user.id, `mentor.${decision}`, 'mentor_application', a.id, { notes, from, to: next }, c.ip);
    if (next !== from) notify(a.user_id, 'mentor', `Mentor application: ${next.replace(/_/g, ' ')}`, notes ?? undefined, '#/mentor/apply');
  });
  return { ok: true };
}, { perm: 'mentor.review' });

// ---------- directory & matching ----------
const slots = (mentorUserId: string, capacity: number) => capacity - q.get<{ n: number }>("SELECT COUNT(*) AS n FROM mentorship_requests WHERE mentor_user_id=? AND status='accepted'", mentorUserId)!.n;

function mentorCard(a: any) {
  const h = hydrate(a);
  return {
    mentor_id: a.user_id, full_name: a.full_name, organization: a.organization, position: a.position, bio: a.bio,
    expertise: h.expertise, industries: h.industries, venture_stages: h.venture_stages, languages: h.languages,
    meeting_formats: h.meeting_formats, timezone: a.timezone, availability: a.availability, open_slots: Math.max(0, slots(a.user_id, a.capacity)),
  };
}
const approvedMentors = () =>
  q.all<any>(`SELECT a.*, u.full_name FROM mentor_applications a JOIN users u ON u.id = a.user_id
              WHERE a.status = 'approved' AND u.account_status = 'active' AND EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = a.user_id AND r.role='mentor')`);

get('/api/mentors', (c) => {
  requireVerified(c.user);
  const f = (k: string) => c.query.get(k)?.toLowerCase();
  const [exp, ind, lang, stage] = [f('expertise'), f('industry'), f('language'), f('stage')];
  const onlyOpen = c.query.get('available') === 'true';
  const has = (list: string[], needle?: string) => !needle || list.some((x) => x.toLowerCase().includes(needle));
  const mentors = approvedMentors().map(mentorCard).filter((m) => has(m.expertise, exp) && has(m.industries, ind) && has(m.languages, lang) && (!stage || m.venture_stages.includes(stage)) && (!onlyOpen || m.open_slots > 0));
  return { mentors };
});

get('/api/mentors/:id', (c) => {
  requireVerified(c.user);
  const a = approvedMentors().find((m) => m.user_id === c.params.id);
  if (!a) throw notFound('Mentor not found.');
  return { mentor: mentorCard(a) };
});

/** Transparent matching: every point of score comes with a human-readable reason. Recommendations never bypass mentor consent. */
export function recommend(user: AuthUser, ventureId: string | null, areas: string[]) {
  const venture = ventureId ? q.get<any>('SELECT v.* FROM ventures v JOIN venture_members m ON m.venture_id = v.id WHERE v.id = ? AND m.user_id = ?', ventureId, user.id) : null;
  if (ventureId && !venture) throw notFound('Venture not found.');
  const taken = new Set(q.all<any>("SELECT mentor_user_id FROM mentorship_requests WHERE mentee_id=? AND status IN ('pending','accepted')", user.id).map((r) => r.mentor_user_id));
  const teammates = venture ? new Set(q.all<any>('SELECT user_id FROM venture_members WHERE venture_id=?', venture.id).map((r) => r.user_id)) : new Set<string>();
  const wanted = areas.map((a) => a.toLowerCase());
  const scored = approvedMentors().filter((m) => m.user_id !== user.id && !taken.has(m.user_id) && !teammates.has(m.user_id)).map((m) => {
    const card = mentorCard(m);
    const reasons: string[] = [];
    let score = 0;
    if (card.open_slots <= 0) return { ...card, score: -1, reasons: ['No open mentoring slots right now.'] };
    if (venture?.industry && card.industries.some((x: string) => x.toLowerCase() === venture.industry.toLowerCase())) { score += 3; reasons.push(`Works in your industry (${venture.industry}).`); }
    if (venture && card.venture_stages.includes(venture.stage)) { score += 2; reasons.push(`Supports ventures at the ${venture.stage} stage.`); }
    for (const w of wanted) if (card.expertise.some((x: string) => x.toLowerCase().includes(w))) { score += 2; reasons.push(`Expertise matches "${w}".`); }
    score += 1; reasons.push(`${card.open_slots} open slot${card.open_slots === 1 ? '' : 's'}.`);
    return { ...card, score, reasons };
  });
  return scored.filter((m) => m.score > 1).sort((a, b) => b.score - a.score).slice(0, 10);
}

get('/api/mentorship/recommendations', (c) => {
  requireVerified(c.user);
  const areas = (c.query.get('areas') ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 10);
  return { recommendations: recommend(c.user, c.query.get('venture_id'), areas), note: 'Recommendations are suggestions based on the listed criteria. The mentor must still accept your request.' };
});

// ---------- mentorship lifecycle ----------
post('/api/mentorship/requests', (c) => {
  requireVerified(c.user);
  const i = new Input(c.body);
  const mentorId = i.str('mentor_id', { max: 60 });
  const ventureId = i.str('venture_id', { max: 60, required: false });
  const goals = i.str('goals', { min: 20, max: 2000 });
  const areas = i.list('areas', { max: 10 });
  i.done();
  if (mentorId === c.user.id) throw bad('You cannot request yourself as a mentor.');
  const id = uid();
  tx(() => {
    const m = approvedMentors().find((x) => x.user_id === mentorId);
    if (!m) throw notFound('Mentor not found or not currently available.');
    if (ventureId && !q.get('SELECT 1 FROM venture_members WHERE venture_id=? AND user_id=?', ventureId, c.user.id)) throw forbidden('That venture is not yours.');
    if (ventureId && q.get('SELECT 1 FROM venture_members WHERE venture_id=? AND user_id=?', ventureId, mentorId)) throw bad('A mentor cannot also be a member of the venture (conflict of interest).');
    if (slots(mentorId!, m.capacity) <= 0) throw conflict('This mentor has no open slots.');
    try {
      q.run('INSERT INTO mentorship_requests(id,mentee_id,mentor_user_id,venture_id,goals,areas,status,created_at) VALUES (?,?,?,?,?,?,?,?)', id, c.user.id, mentorId, ventureId, goals, json(areas), 'pending', now());
    } catch {
      throw conflict('You already have an active request with this mentor.');
    }
    audit(c.user.id, 'mentorship.requested', 'mentorship_request', id, { mentor: mentorId }, c.ip);
    notify(mentorId!, 'mentorship', 'New mentorship request', `${c.user.full_name} asked you to mentor them.`, '#/mentorship');
  });
  return new Created({ id });
});

get('/api/mentorship/requests', (c) => {
  const rows = q.all<any>(
    `SELECT r.*, mentee.full_name AS mentee_name, mentor.full_name AS mentor_name, v.name AS venture_name
     FROM mentorship_requests r JOIN users mentee ON mentee.id = r.mentee_id JOIN users mentor ON mentor.id = r.mentor_user_id
     LEFT JOIN ventures v ON v.id = r.venture_id WHERE r.mentee_id = ? OR r.mentor_user_id = ? ORDER BY r.created_at DESC`, c.user.id, c.user.id);
  return { requests: rows.map((r) => ({ ...r, areas: parseJson(r.areas, []), as: r.mentee_id === c.user.id ? 'mentee' : 'mentor' })) };
});

const involved = (c: { user: AuthUser }, id: string) => {
  const r = q.get<any>('SELECT * FROM mentorship_requests WHERE id = ?', id);
  if (!r || (r.mentee_id !== c.user.id && r.mentor_user_id !== c.user.id)) throw notFound('Request not found.');
  return r;
};

post('/api/mentorship/requests/:id/respond', (c) => {
  const i = new Input(c.body);
  const decision = i.oneOf('decision', ['accept', 'decline'] as const);
  const note = i.str('note', { max: 1000, required: false });
  i.done();
  tx(() => {
    const r = involved(c, c.params.id);
    if (r.mentor_user_id !== c.user.id) throw forbidden('Only the requested mentor can respond.');
    if (r.status !== 'pending') throw conflict(`This request is already ${r.status}.`);
    if (!c.user.roles.includes('mentor')) throw forbidden('Your mentor approval is not active.');
    if (decision === 'accept') {
      const a = q.get<any>('SELECT capacity FROM mentor_applications WHERE user_id = ?', c.user.id)!;
      if (slots(c.user.id, a.capacity) <= 0) throw conflict('You have reached your mentoring capacity.');
    }
    const next = decision === 'accept' ? 'accepted' : 'declined';
    q.run('UPDATE mentorship_requests SET status=?, response_note=?, responded_at=? WHERE id=?', next, note, now(), r.id);
    audit(c.user.id, `mentorship.${next}`, 'mentorship_request', r.id, null, c.ip);
    notify(r.mentee_id, 'mentorship', `Mentorship request ${next}`, note ?? undefined, '#/mentorship');
  });
  return { ok: true };
});

post('/api/mentorship/requests/:id/cancel', (c) => {
  const r = involved(c, c.params.id);
  if (r.mentee_id !== c.user.id) throw forbidden('Only the requester can cancel.');
  if (r.status !== 'pending') throw conflict(`This request is already ${r.status}.`);
  q.run("UPDATE mentorship_requests SET status='cancelled', responded_at=? WHERE id=?", now(), r.id);
  audit(c.user.id, 'mentorship.cancelled', 'mentorship_request', r.id, null, c.ip);
  return { ok: true };
});

post('/api/mentorship/requests/:id/complete', (c) => {
  const r = involved(c, c.params.id);
  if (r.mentor_user_id !== c.user.id) throw forbidden('Only the mentor can close a mentorship.');
  if (r.status !== 'accepted') throw conflict('Only accepted mentorships can be completed.');
  q.run("UPDATE mentorship_requests SET status='completed', responded_at=? WHERE id=?", now(), r.id);
  audit(c.user.id, 'mentorship.completed', 'mentorship_request', r.id, null, c.ip);
  notify(r.mentee_id, 'mentorship', 'Mentorship completed', 'Please leave feedback on your mentorship.', '#/mentorship');
  return { ok: true };
});

post('/api/mentorship/requests/:id/sessions', (c) => {
  const i = new Input(c.body);
  const when = i.date('scheduled_at', true);
  const notes = i.str('notes', { max: 3000, required: false });
  const outcome = i.str('outcome', { max: 2000, required: false });
  i.done();
  const r = involved(c, c.params.id);
  if (r.status !== 'accepted') throw conflict('Sessions can only be recorded for accepted mentorships.');
  const id = uid();
  // A session in the past with an outcome is a record of something that happened; anything else is a plan.
  const status = when! <= now() && outcome ? 'completed' : 'scheduled';
  q.run('INSERT INTO mentorship_sessions(id,request_id,scheduled_at,notes,outcome,recorded_by,created_at,status) VALUES (?,?,?,?,?,?,?,?)', id, r.id, when, notes, outcome, c.user.id, now(), status);
  audit(c.user.id, 'mentorship.session_recorded', 'mentorship_request', r.id, { status }, c.ip);
  const other = r.mentee_id === c.user.id ? r.mentor_user_id : r.mentee_id;
  if (status === 'scheduled') notify(other, 'mentorship', 'Mentoring session scheduled', `A session was scheduled for ${when}.`, '#/mentorship');
  return new Created({ id, status });
});

get('/api/mentorship/requests/:id/sessions', (c) => {
  const r = involved(c, c.params.id);
  return { sessions: q.all('SELECT id, scheduled_at, notes, outcome, recorded_by, created_at, status, cancel_reason, mentee_attended, mentor_attended FROM mentorship_sessions WHERE request_id = ? ORDER BY scheduled_at', r.id) };
});

post('/api/mentorship/requests/:id/feedback', (c) => {
  const i = new Input(c.body);
  const rating = i.int('rating', { min: 1, max: 5 });
  const comment = i.str('comment', { max: 2000, required: false });
  i.done();
  const r = involved(c, c.params.id);
  if (!['accepted', 'completed'].includes(r.status)) throw conflict('Feedback is available once a mentorship has started.');
  try {
    q.run('INSERT INTO mentorship_feedback(id,request_id,author_id,rating,comment,created_at) VALUES (?,?,?,?,?,?)', uid(), r.id, c.user.id, rating, comment, now());
  } catch {
    throw conflict('You have already left feedback.');
  }
  return new Created({ ok: true });
});

get('/api/admin/mentorship', (c) => ({
  requests: q.all(`SELECT r.id, r.status, r.created_at, a.full_name AS mentee, b.full_name AS mentor FROM mentorship_requests r JOIN users a ON a.id = r.mentee_id JOIN users b ON b.id = r.mentor_user_id ORDER BY r.created_at DESC LIMIT 200`),
}), { perm: 'mentor.review' });
