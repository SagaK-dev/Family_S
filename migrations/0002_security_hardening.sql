PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS blocked_users (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  disabled_at INTEGER NOT NULL,
  disabled_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_blocked_users_disabled_at ON blocked_users(disabled_at);
