-- ALABATT-CES initial schema (SQLite dialect; see docs/ARCHITECTURE.md for PostgreSQL porting notes)
PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  phone TEXT,
  country TEXT,
  organization TEXT,
  category TEXT NOT NULL CHECK (category IN ('student','lecturer','alumni','external_entrepreneur','external_participant','partner','mentor_applicant','staff')),
  account_status TEXT NOT NULL DEFAULT 'active' CHECK (account_status IN ('active','suspended','disabled','closed')),
  email_verified INTEGER NOT NULL DEFAULT 0,
  verification_status TEXT NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified','pending','under_review','more_info_required','verified','rejected')),
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE user_roles (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  granted_by TEXT REFERENCES users(id),
  granted_at TEXT NOT NULL,
  PRIMARY KEY (user_id, role)
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ip TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE auth_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('email_verify','password_reset')),
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE email_outbox (
  id TEXT PRIMARY KEY,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued_no_provider',
  created_at TEXT NOT NULL
);

CREATE TABLE consents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document TEXT NOT NULL,
  version TEXT NOT NULL,
  accepted_at TEXT NOT NULL
);

CREATE TABLE affiliations (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  institution TEXT,
  id_number TEXT,
  department TEXT,
  faculty TEXT,
  programme_of_study TEXT,
  level TEXT,
  graduation_year INTEGER,
  position TEXT,
  organization TEXT,
  institutional_email TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  scan_status TEXT NOT NULL CHECK (scan_status IN ('basic_checks_passed','scanned_clean','quarantined')),
  context TEXT NOT NULL DEFAULT 'general',
  context_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_documents_owner ON documents(owner_id);

CREATE TABLE verification_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('submitted','under_review','more_info_required','approved','rejected')),
  snapshot TEXT NOT NULL,
  reviewer_id TEXT REFERENCES users(id),
  decision_reason TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX idx_vr_status ON verification_requests(status);
CREATE UNIQUE INDEX uq_vr_open ON verification_requests(user_id) WHERE status IN ('submitted','under_review');

CREATE TABLE mentor_applications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('draft','submitted','under_review','more_info_required','approved','rejected','suspended','withdrawn')),
  organization TEXT,
  position TEXT,
  bio TEXT,
  expertise TEXT NOT NULL DEFAULT '[]',
  industries TEXT NOT NULL DEFAULT '[]',
  venture_stages TEXT NOT NULL DEFAULT '[]',
  languages TEXT NOT NULL DEFAULT '[]',
  meeting_formats TEXT NOT NULL DEFAULT '[]',
  timezone TEXT,
  availability TEXT,
  capacity INTEGER NOT NULL DEFAULT 3,
  references_text TEXT,
  coc_accepted INTEGER NOT NULL DEFAULT 0,
  conflict_declaration TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  submitted_at TEXT,
  decided_at TEXT
);

CREATE TABLE mentor_reviews (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES mentor_applications(id) ON DELETE CASCADE,
  reviewer_id TEXT NOT NULL REFERENCES users(id),
  decision TEXT NOT NULL CHECK (decision IN ('approve','reject','more_info','suspend','recuse')),
  notes TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_mentor_review_once ON mentor_reviews(application_id, reviewer_id, decision);

CREATE TABLE ventures (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  description TEXT,
  problem TEXT,
  solution TEXT,
  target_market TEXT,
  value_proposition TEXT,
  business_model TEXT,
  industry TEXT,
  stage TEXT NOT NULL DEFAULT 'idea' CHECK (stage IN ('idea','validation','prototype','launch','growth')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','under_review','changes_requested','incubating','rejected','graduated')),
  risks TEXT,
  review_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE venture_members (
  venture_id TEXT NOT NULL REFERENCES ventures(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_role TEXT NOT NULL DEFAULT 'member' CHECK (member_role IN ('owner','member')),
  title TEXT,
  added_at TEXT NOT NULL,
  PRIMARY KEY (venture_id, user_id)
);

CREATE TABLE mentorship_requests (
  id TEXT PRIMARY KEY,
  mentee_id TEXT NOT NULL REFERENCES users(id),
  mentor_user_id TEXT NOT NULL REFERENCES users(id),
  venture_id TEXT REFERENCES ventures(id),
  goals TEXT NOT NULL,
  areas TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','declined','cancelled','completed')),
  response_note TEXT,
  match_explanation TEXT,
  created_at TEXT NOT NULL,
  responded_at TEXT
);
CREATE UNIQUE INDEX uq_mentorship_active ON mentorship_requests(mentee_id, mentor_user_id) WHERE status IN ('pending','accepted');

CREATE TABLE mentorship_sessions (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES mentorship_requests(id) ON DELETE CASCADE,
  scheduled_at TEXT NOT NULL,
  notes TEXT,
  outcome TEXT,
  recorded_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE mentorship_feedback (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES mentorship_requests(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (request_id, author_id)
);

CREATE TABLE programmes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','closed','archived')),
  eligible_categories TEXT NOT NULL DEFAULT '[]',
  requires_verification INTEGER NOT NULL DEFAULT 1,
  opens_at TEXT,
  closes_at TEXT,
  capacity INTEGER NOT NULL DEFAULT 30,
  required_documents TEXT NOT NULL DEFAULT '[]',
  questions TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE programme_applications (
  id TEXT PRIMARY KEY,
  programme_id TEXT NOT NULL REFERENCES programmes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  venture_id TEXT REFERENCES ventures(id),
  status TEXT NOT NULL CHECK (status IN ('draft','submitted','under_review','more_info_required','accepted','waitlisted','rejected','withdrawn','completed')),
  answers TEXT NOT NULL DEFAULT '{}',
  decision_reason TEXT,
  decided_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  submitted_at TEXT,
  decided_at TEXT,
  UNIQUE (programme_id, user_id)
);

CREATE TABLE workshops (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('in_person','online','hybrid')),
  location TEXT,
  meeting_link TEXT,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  capacity INTEGER NOT NULL,
  eligible_categories TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','cancelled','completed')),
  programme_id TEXT REFERENCES programmes(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE workshop_registrations (
  workshop_id TEXT NOT NULL REFERENCES workshops(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('registered','waitlisted','cancelled')),
  attended INTEGER,
  feedback_rating INTEGER CHECK (feedback_rating BETWEEN 1 AND 5),
  feedback_comment TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workshop_id, user_id)
);

CREATE TABLE funding_opportunities (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  currency TEXT NOT NULL DEFAULT 'NGN',
  min_amount INTEGER NOT NULL DEFAULT 0,
  max_amount INTEGER NOT NULL,
  total_budget INTEGER NOT NULL,
  opens_at TEXT,
  closes_at TEXT,
  eligible_categories TEXT NOT NULL DEFAULT '[]',
  criteria TEXT,
  conditions TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','closed')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE funding_applications (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES funding_opportunities(id),
  applicant_id TEXT NOT NULL REFERENCES users(id),
  venture_id TEXT NOT NULL REFERENCES ventures(id),
  requested_amount INTEGER NOT NULL,
  approved_amount INTEGER,
  justification TEXT,
  use_of_funds TEXT,
  status TEXT NOT NULL CHECK (status IN ('draft','submitted','eligibility_review','under_evaluation','more_info_required','approved','rejected','waitlisted','withdrawn','completed')),
  agreement_status TEXT NOT NULL DEFAULT 'not_started' CHECK (agreement_status IN ('not_started','pending','signed')),
  disbursement_status TEXT NOT NULL DEFAULT 'not_started' CHECK (disbursement_status IN ('not_started','pending','disbursed')),
  disbursement_reference TEXT,
  disbursed_by TEXT REFERENCES users(id),
  disbursed_at TEXT,
  decided_by TEXT REFERENCES users(id),
  decision_reason TEXT,
  created_at TEXT NOT NULL,
  submitted_at TEXT,
  decided_at TEXT,
  UNIQUE (opportunity_id, venture_id)
);

CREATE TABLE funding_budget_items (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES funding_applications(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount >= 0)
);

CREATE TABLE funding_events (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES funding_applications(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES users(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE milestones (
  id TEXT PRIMARY KEY,
  venture_id TEXT NOT NULL REFERENCES ventures(id) ON DELETE CASCADE,
  programme_id TEXT REFERENCES programmes(id),
  title TEXT NOT NULL,
  description TEXT,
  due_date TEXT,
  owner_id TEXT REFERENCES users(id),
  completion_criteria TEXT,
  status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started','in_progress','submitted','changes_requested','completed','blocked','cancelled')),
  evidence_text TEXT,
  evidence_document_id TEXT REFERENCES documents(id),
  evidence_type TEXT NOT NULL DEFAULT 'self_reported' CHECK (evidence_type IN ('self_reported','verified')),
  outcome_metric TEXT,
  outcome_value REAL,
  reviewer_id TEXT REFERENCES users(id),
  review_comment TEXT,
  completed_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE resources (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  topic TEXT,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('document','link','template','video')),
  external_url TEXT,
  document_id TEXT REFERENCES documents(id),
  audience_categories TEXT NOT NULL DEFAULT '[]',
  venture_stage TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  published_at TEXT
);

CREATE TABLE resource_downloads (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  day TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (resource_id, user_id, day)
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_notifications_user ON notifications(user_id, read_at);

CREATE TABLE notification_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email_enabled INTEGER NOT NULL DEFAULT 1,
  in_app_enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE support_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved')),
  response TEXT,
  responder_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  actor_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  details TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_created ON audit_events(created_at);
CREATE INDEX idx_audit_entity ON audit_events(entity, entity_id);

CREATE TABLE system_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_programme_apps_prog ON programme_applications(programme_id, status);
CREATE INDEX idx_workshop_regs ON workshop_registrations(workshop_id, status);
CREATE INDEX idx_funding_status ON funding_applications(status);
CREATE INDEX idx_milestones_venture ON milestones(venture_id, status);
