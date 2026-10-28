-- 002_upgrade: forward-only, additive. Nothing is dropped or rebuilt; existing rows keep their meaning.
-- Adds: reviewer assignment, review scores, funding recommendation step, support threads, milestone priority,
-- venture location/archive, mentoring session lifecycle + action items + conflict reports, role requests,
-- governance records with versions, notification de-duplication, email delivery bookkeeping, indexes for the new queues.

-- ---------- reviewer assignment and review records ----------
ALTER TABLE programme_applications ADD COLUMN assigned_to TEXT REFERENCES users(id);
ALTER TABLE programme_applications ADD COLUMN assigned_at TEXT;
ALTER TABLE programme_applications ADD COLUMN review_score INTEGER CHECK (review_score IS NULL OR review_score BETWEEN 0 AND 100);
ALTER TABLE programme_applications ADD COLUMN review_notes TEXT;

ALTER TABLE funding_applications ADD COLUMN assigned_to TEXT REFERENCES users(id);
ALTER TABLE funding_applications ADD COLUMN assigned_at TEXT;
ALTER TABLE funding_applications ADD COLUMN recommendation TEXT CHECK (recommendation IS NULL OR recommendation IN ('approve','reject','more_info'));
ALTER TABLE funding_applications ADD COLUMN recommended_amount INTEGER;
ALTER TABLE funding_applications ADD COLUMN recommendation_note TEXT;
ALTER TABLE funding_applications ADD COLUMN recommended_by TEXT REFERENCES users(id);
ALTER TABLE funding_applications ADD COLUMN recommended_at TEXT;

-- ---------- ventures and milestones ----------
ALTER TABLE ventures ADD COLUMN location TEXT;
ALTER TABLE ventures ADD COLUMN archived_at TEXT;
ALTER TABLE milestones ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high'));

-- ---------- support: tickets become threads ----------
ALTER TABLE support_requests ADD COLUMN category TEXT NOT NULL DEFAULT 'general';
ALTER TABLE support_requests ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent'));
ALTER TABLE support_requests ADD COLUMN assigned_to TEXT REFERENCES users(id);
ALTER TABLE support_requests ADD COLUMN assigned_at TEXT;
ALTER TABLE support_requests ADD COLUMN resolved_at TEXT;

CREATE TABLE support_messages (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES support_requests(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('user','staff','internal')),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_support_messages_req ON support_messages(request_id, created_at);

-- carry existing tickets over: the original message is the requester's first post, a stored response is a staff reply
INSERT INTO support_messages(id, request_id, author_id, kind, body, created_at)
  SELECT lower(hex(randomblob(16))), id, user_id, 'user', message, created_at FROM support_requests;
INSERT INTO support_messages(id, request_id, author_id, kind, body, created_at)
  SELECT lower(hex(randomblob(16))), id, responder_id, 'staff', response, updated_at FROM support_requests WHERE response IS NOT NULL AND responder_id IS NOT NULL;
UPDATE support_requests SET resolved_at = updated_at WHERE status = 'resolved' AND resolved_at IS NULL;

-- ---------- mentoring: session lifecycle, action items, conflict reports ----------
ALTER TABLE mentorship_sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled','missed'));
ALTER TABLE mentorship_sessions ADD COLUMN cancelled_by TEXT REFERENCES users(id);
ALTER TABLE mentorship_sessions ADD COLUMN cancel_reason TEXT;
ALTER TABLE mentorship_sessions ADD COLUMN mentee_attended INTEGER;
ALTER TABLE mentorship_sessions ADD COLUMN mentor_attended INTEGER;
UPDATE mentorship_sessions SET status = 'completed' WHERE outcome IS NOT NULL AND scheduled_at < strftime('%Y-%m-%dT%H:%M:%fZ','now');

CREATE TABLE mentorship_actions (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES mentorship_requests(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES mentorship_sessions(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_mentorship_actions_req ON mentorship_actions(request_id, status);

CREATE TABLE mentorship_conflicts (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES mentorship_requests(id) ON DELETE CASCADE,
  reported_by TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolution TEXT,
  resolved_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE UNIQUE INDEX uq_mentorship_conflict_open ON mentorship_conflicts(request_id, reported_by) WHERE status = 'open';

-- ---------- privileged role requests (approved by an administrator, never self-granted) ----------
CREATE TABLE role_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  organisation TEXT,
  justification TEXT NOT NULL,
  evidence_document_id TEXT REFERENCES documents(id),
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','withdrawn')),
  decided_by TEXT REFERENCES users(id),
  decision_reason TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE UNIQUE INDEX uq_role_request_open ON role_requests(user_id, role) WHERE status = 'pending';
CREATE INDEX idx_role_requests_status ON role_requests(status, created_at);

-- ---------- governance records: policies, procedures, decisions, with versions and recorded approval ----------
CREATE TABLE governance_records (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('policy','procedure','role_definition','decision','declaration')),
  title TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('public','members','staff','admins')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','retired')),
  current_version INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE governance_versions (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL REFERENCES governance_records(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  change_note TEXT,
  evidence_document_id TEXT REFERENCES documents(id),
  author_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  approved_by TEXT REFERENCES users(id),
  approved_at TEXT,
  UNIQUE (record_id, version)
);
CREATE INDEX idx_governance_status ON governance_records(status, visibility);

-- ---------- notifications: de-duplication that does not depend on user preferences ----------
CREATE TABLE notification_dedupe (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, dedupe_key)
);

-- ---------- email delivery bookkeeping (a provider adapter fills these in; without one rows stay queued_no_provider) ----------
ALTER TABLE email_outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_outbox ADD COLUMN last_error TEXT;
ALTER TABLE email_outbox ADD COLUMN sent_at TEXT;
ALTER TABLE email_outbox ADD COLUMN next_attempt_at TEXT;
CREATE INDEX idx_email_outbox_status ON email_outbox(status, next_attempt_at);

-- ---------- indexes for the new queues, filters and dashboards ----------
CREATE INDEX idx_programme_apps_assigned ON programme_applications(assigned_to, status);
CREATE INDEX idx_funding_assigned ON funding_applications(assigned_to, status);
CREATE INDEX idx_support_status ON support_requests(status, assigned_to);
CREATE INDEX idx_support_user ON support_requests(user_id, created_at);
CREATE INDEX idx_users_created ON users(created_at);
CREATE INDEX idx_notifications_created ON notifications(user_id, created_at);
CREATE INDEX idx_audit_actor ON audit_events(actor_id, created_at);
CREATE INDEX idx_milestones_due ON milestones(due_date, status);
CREATE INDEX idx_sessions_sched ON mentorship_sessions(scheduled_at, status);
