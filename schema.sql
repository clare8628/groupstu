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
  deadline           TEXT NOT NULL DEFAULT '',
  deadline_triggered INTEGER NOT NULL DEFAULT 0,
  notice             TEXT NOT NULL DEFAULT '',
  notice_time        TEXT NOT NULL DEFAULT '',
  created_at         INTEGER NOT NULL
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
  password_hash TEXT NOT NULL DEFAULT '', -- SHA-256 雜湊，空值表示使用預設學號
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

-- 異動日誌：記錄組長挑選／釋出組員、身分變更、點名操作及老師操作
CREATE TABLE IF NOT EXISTS activity_logs (
  id          TEXT PRIMARY KEY,
  course_id   TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  operator    TEXT NOT NULL,        -- 操作者（如「組長 王小明 (410123)」或「老師」）
  action      TEXT NOT NULL,        -- 動作類型（pick, drop, attendance-mark, attendance-correct 等）
  details     TEXT NOT NULL,        -- 詳細說明
  created_at  INTEGER NOT NULL,     -- Unix timestamp (ms)
  time_str    TEXT NOT NULL DEFAULT '' -- 格式化時間 (YYYY-MM-DD HH:mm:ss)
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_course ON activity_logs(course_id, created_at DESC);

-- 點名時段表 (attendance_sessions)
CREATE TABLE IF NOT EXISTS attendance_sessions (
  id          TEXT NOT NULL,               -- 唯一鍵，例：'daily-2026-09-22' 或自建 ID
  course_id   TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  date        TEXT NOT NULL DEFAULT '',    -- 格式 'YYYY-MM-DD'
  time_slot   TEXT NOT NULL DEFAULT '',    -- 節次文字，例如「第3-4節」、「14:00-16:00」
  name        TEXT NOT NULL DEFAULT '',    -- 時段名稱，例如「一般日常點名」、「期末專題成果展」
  created_at  INTEGER NOT NULL,            -- 建立時間戳 (毫秒)
  PRIMARY KEY (course_id, id)
);

CREATE INDEX IF NOT EXISTS idx_attendance_sessions_course ON attendance_sessions(course_id, date DESC);

-- 點名紀錄明細表 (attendance_records)
CREATE TABLE IF NOT EXISTS attendance_records (
  course_id      TEXT NOT NULL,
  session_id     TEXT NOT NULL,            -- 關聯 attendance_sessions.id
  student_id     TEXT NOT NULL,            -- 學號
  group_id       TEXT NOT NULL DEFAULT '', -- 所屬組別 ID
  status         TEXT NOT NULL DEFAULT 'present', -- 'present'(出席) 或 'absent'(缺席)
  marked_by_id   TEXT NOT NULL DEFAULT '', -- 操作者學號 (組長/副組長/代理人)
  marked_by_name TEXT NOT NULL DEFAULT '', -- 操作者姓名
  created_at     INTEGER NOT NULL DEFAULT 0, -- 首次點名時間戳 (毫秒)
  updated_at     INTEGER NOT NULL,           -- 最後更新/修正時間戳 (毫秒)
  PRIMARY KEY (course_id, session_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_attendance_records_session ON attendance_records(course_id, session_id);

-- 補登權限解鎖表 (attendance_unlocks)
CREATE TABLE IF NOT EXISTS attendance_unlocks (
  course_id  TEXT NOT NULL,
  session_id TEXT NOT NULL,
  group_id   TEXT NOT NULL DEFAULT '',     -- 空字串 '' 代表全班所有組別皆開放
  deadline   TEXT NOT NULL DEFAULT '',     -- 補登截止時間 (ISO 格式或 YYYY-MM-DDTHH:mm)，空值代表不限期
  created_at INTEGER NOT NULL,
  PRIMARY KEY (course_id, session_id, group_id)
);

-- 跨組代理點名授權表 (attendance_delegates)
CREATE TABLE IF NOT EXISTS attendance_delegates (
  course_id     TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  group_id      TEXT NOT NULL,             -- 被代理點名的組別 ID
  delegate_id   TEXT NOT NULL,             -- 代理人學號（需具備組長或副組長身分）
  delegate_name TEXT NOT NULL DEFAULT '',  -- 代理人姓名
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (course_id, session_id, group_id, delegate_id)
);
