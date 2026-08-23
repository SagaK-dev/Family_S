PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_single_owner ON users(role) WHERE role = 'owner';

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user_created ON sessions(user_id, created_at DESC, token_hash DESC);

CREATE TABLE IF NOT EXISTS blocked_users (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  disabled_at INTEGER NOT NULL,
  disabled_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_blocked_users_disabled_at ON blocked_users(disabled_at);

CREATE TABLE IF NOT EXISTS invites (
  code_hash TEXT PRIMARY KEY,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_invites_expiry ON invites(expires_at);
CREATE INDEX IF NOT EXISTS idx_invites_created_by ON invites(created_by);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  reply_to TEXT REFERENCES messages(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER,
  pinned_at INTEGER,
  pinned_by TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_timeline ON messages(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_reply ON messages(reply_to);
CREATE INDEX IF NOT EXISTS idx_messages_pinned ON messages(pinned_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_pinned_by ON messages(pinned_by);

CREATE TABLE IF NOT EXISTS reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_reactions_user ON reactions(user_id);

CREATE TABLE IF NOT EXISTS reads (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_message_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TRIGGER IF NOT EXISTS trg_reads_clamp_insert
AFTER INSERT ON reads
WHEN NEW.last_message_at > COALESCE((SELECT MAX(created_at) FROM messages WHERE deleted_at IS NULL), 0)
BEGIN
  UPDATE reads
  SET last_message_at = COALESCE((SELECT MAX(created_at) FROM messages WHERE deleted_at IS NULL), 0)
  WHERE user_id = NEW.user_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_reads_clamp_update
AFTER UPDATE OF last_message_at ON reads
WHEN NEW.last_message_at > COALESCE((SELECT MAX(created_at) FROM messages WHERE deleted_at IS NULL), 0)
BEGIN
  UPDATE reads
  SET last_message_at = COALESCE((SELECT MAX(created_at) FROM messages WHERE deleted_at IS NULL), 0)
  WHERE user_id = NEW.user_id;
END;

CREATE TABLE IF NOT EXISTS auth_limits (
  bucket_hash TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  window_started_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_limits_window_started_at ON auth_limits(window_started_at);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  subject_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events(actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_subject ON audit_events(subject_user_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_audit_events_type_insert
BEFORE INSERT ON audit_events
WHEN NEW.event_type NOT IN (
  'password_changed',
  'account_deleted',
  'member_deleted',
  'sessions_revoked_all',
  'member_disabled',
  'member_enabled',
  'invite_created',
  'invite_revoked',
  'message_deleted',
  'message_pin_changed'
)
BEGIN
  SELECT RAISE(ABORT, 'invalid audit event type');
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_events_type_update
BEFORE UPDATE OF event_type ON audit_events
WHEN NEW.event_type != OLD.event_type
BEGIN
  SELECT RAISE(ABORT, 'audit event type is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_events_guard_update
BEFORE UPDATE ON audit_events
WHEN NEW.id != OLD.id
  OR NEW.event_type != OLD.event_type
  OR NEW.created_at != OLD.created_at
  OR NOT (
    NEW.actor_user_id IS OLD.actor_user_id
    OR (OLD.actor_user_id IS NOT NULL AND NEW.actor_user_id IS NULL)
  )
  OR NOT (
    NEW.subject_user_id IS OLD.subject_user_id
    OR (OLD.subject_user_id IS NOT NULL AND NEW.subject_user_id IS NULL)
  )
BEGIN
  SELECT RAISE(ABORT, 'audit event is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_events_guard_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit event deletion is not allowed');
END;
