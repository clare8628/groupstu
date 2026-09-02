-- 學生分組系統 D1 schema
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS courses (
  id         TEXT PRIMARY KEY,
  year       TEXT NOT NULL DEFAULT '',
  subject    TEXT NOT NULL DEFAULT '',
  group_size INTEGER NOT NULL DEFAULT 4,
  tolerance  INTEGER NOT NULL DEFAULT 1,
  deadline   TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
  id        TEXT NOT NULL,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  seq       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (course_id, id)
);

CREATE TABLE IF NOT EXISTS students (
  course_id     TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,          -- 學號
  name          TEXT NOT NULL,
  group_id      TEXT,
  is_leader     INTEGER NOT NULL DEFAULT 0,
  is_vice       INTEGER NOT NULL DEFAULT 0,
  auto_assigned INTEGER NOT NULL DEFAULT 0,
  seq           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (course_id, id)
);

CREATE INDEX IF NOT EXISTS idx_students_group ON students(course_id, group_id);
