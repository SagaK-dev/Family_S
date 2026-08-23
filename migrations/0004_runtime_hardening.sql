PRAGMA foreign_keys = ON;

CREATE INDEX IF NOT EXISTS idx_auth_limits_window_started_at
ON auth_limits(window_started_at);

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
