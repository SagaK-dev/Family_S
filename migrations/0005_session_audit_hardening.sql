PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS invite_claims (
  code_hash TEXT PRIMARY KEY REFERENCES invites(code_hash) ON DELETE CASCADE,
  claim_token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_created ON sessions(user_id, created_at DESC, token_hash DESC);
CREATE INDEX IF NOT EXISTS idx_invites_created_by ON invites(created_by);
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_pinned_by ON messages(pinned_by);
CREATE INDEX IF NOT EXISTS idx_reactions_user ON reactions(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_subject ON audit_events(subject_user_id, created_at DESC);

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
