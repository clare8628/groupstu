-- 學生分組系統 D1 schema
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS courses (
  id          TEXT PRIMARY KEY,
  year        TEXT NOT NULL DEFAULT '',
  subject     TEXT NOT NULL DEFAULT '',
  group_size  INTEGER NOT NULL DEFAULT 4,
  tolerance   INTEGER NOT NULL DEFAULT 1,
  deadline    TEXT NOT NULL DEFAULT '',
  notice      TEXT NOT NULL DEFAULT '',
  notice_time TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
  id                  TEXT NOT NULL,
  course_id           TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  seq                 INTEGER NOT NULL DEFAULT 0,
  allow_edit          INTEGER NOT NULL DEFAULT 0,
  edit_deadline       TEXT NOT NULL DEFAULT '',
  peer_eval_open      INTEGER NOT NULL DEFAULT 0,
  peer_eval_deadline  TEXT NOT NULL DEFAULT '',
  peer_eval_submitted INTEGER NOT NULL DEFAULT 0,
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
  peer_penalty  INTEGER NOT NULL DEFAULT 0,  -- 加分 (0 到 10)
  peer_comment  TEXT NOT NULL DEFAULT '',    -- 加分原因與貢獻說明
  seq           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (course_id, id)
);

CREATE INDEX IF NOT EXISTS idx_students_group ON students(course_id, group_id);

CREATE TABLE IF NOT EXISTS group_snapshots (
  course_id  TEXT PRIMARY KEY REFERENCES courses(id) ON DELETE CASCADE,
  snapshot   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- 公佈欄：每則公告獨立一筆，各自附帶發布時間
CREATE TABLE IF NOT EXISTS notices (
  id         TEXT PRIMARY KEY,
  course_id  TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  time_str   TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_notices_course ON notices(course_id, created_at DESC);

-- 異動日誌：記錄組長挑選／釋出組員、身分變更及老師操作
CREATE TABLE IF NOT EXISTS activity_logs (
  id          TEXT PRIMARY KEY,
  course_id   TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  operator    TEXT NOT NULL,        -- 操作者（如「組長 王小明 (410123)」或「老師」）
  action      TEXT NOT NULL,        -- 動作類型（pick, drop, claim-leader, unclaim-leader 等）
  details     TEXT NOT NULL,        -- 詳細說明
  created_at  INTEGER NOT NULL,     -- Unix timestamp (ms)
  time_str    TEXT NOT NULL DEFAULT '' -- 格式化時間 (YYYY-MM-DD HH:mm:ss)
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_course ON activity_logs(course_id, created_at DESC);
