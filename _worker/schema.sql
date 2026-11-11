CREATE TABLE IF NOT EXISTS schedule (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS password_resets (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  requested_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS password_resets_expiry ON password_resets (expires_at);

CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL CHECK (ends_at > starts_at),
  meeting_url TEXT NOT NULL DEFAULT '',
  cancelled_at INTEGER
);

CREATE INDEX IF NOT EXISTS lessons_student ON lessons (user_id, starts_at);
CREATE INDEX IF NOT EXISTS lessons_active ON lessons (starts_at, ends_at) WHERE cancelled_at IS NULL;

CREATE TABLE IF NOT EXISTS homework (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  resource_url TEXT NOT NULL DEFAULT '',
  due_date TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS homework_student ON homework (user_id, created_at);

CREATE TABLE IF NOT EXISTS teacher_sessions (
  token_hash TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS teacher_sessions_expiry ON teacher_sessions (expires_at);

CREATE TABLE IF NOT EXISTS booking_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  contact TEXT NOT NULL,
  goal TEXT NOT NULL,
  message TEXT NOT NULL,
  lesson_type TEXT NOT NULL,
  duration INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  starts_at INTEGER,
  ends_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'declined', 'cancelled')),
  created_at INTEGER NOT NULL,
  lesson_id TEXT REFERENCES lessons(id) ON DELETE SET NULL,
  notified_at INTEGER,
  notification_lease_until INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS booking_requests_student ON booking_requests (user_id, created_at);
CREATE INDEX IF NOT EXISTS booking_requests_pending ON booking_requests (starts_at, ends_at) WHERE status = 'pending';
