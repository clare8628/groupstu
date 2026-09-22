/* 學生分組系統 — 共用工具（底線開頭不會成為路由） */

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

export const bad = (msg, status = 400) => json({ error: msg }, status);

const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let _cachedSecret = null;
let _cachedHmacKey = null;

export async function secret(db, env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (_cachedSecret) return _cachedSecret;
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind('session_secret').first();
  if (row) {
    _cachedSecret = row.value;
    return _cachedSecret;
  }
  const s = b64u(crypto.getRandomValues(new Uint8Array(32)));
  await db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind('session_secret', s).run();
  _cachedSecret = s;
  return s;
}

export async function getHmacKey(db, env) {
  if (_cachedHmacKey) return _cachedHmacKey;
  const sec = await secret(db, env);
  _cachedHmacKey = await crypto.subtle.importKey('raw', enc.encode(sec), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return _cachedHmacKey;
}

export async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}

export async function hmacWithKey(cryptoKey, msg) {
  return b64u(await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(msg)));
}

export async function sha256(text) {
  return b64u(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

export async function makeToken(db, env, payload) {
  const body = b64u(enc.encode(JSON.stringify({ ...payload, exp: Date.now() + 12 * 3600 * 1000 })));
  return `${body}.${await hmac(await secret(db, env), body)}`;
}

export async function readSession(db, env, request) {
  const m = (request.headers.get('cookie') || '').match(/(?:^|;\s*)gs_session=([^;]+)/);
  if (!m) return null;
  const [body, sig] = decodeURIComponent(m[1]).split('.');
  if (!body || !sig) return null;
  if (sig !== await hmac(await secret(db, env), body)) return null;
  try {
    const raw = Uint8Array.from(atob(body.replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0));
    const data = JSON.parse(new TextDecoder().decode(raw));
    return data.exp > Date.now() ? data : null;
  } catch (e) { return null; }
}

export const sessionCookie = (token, maxAge = 12 * 3600) =>
  `gs_session=${token}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAge}`;
export const clearCookie = 'gs_session=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0';

/* ===== 狀態讀取 ===== */
let _ensuredGroupSchema = false;
async function ensureGroupSchema(db) {
  if (_ensuredGroupSchema) return;
  try {
    await db.prepare('ALTER TABLE groups ADD COLUMN allow_edit INTEGER NOT NULL DEFAULT 0').run();
  } catch (_) {}
  try {
    await db.prepare('ALTER TABLE groups ADD COLUMN edit_deadline TEXT NOT NULL DEFAULT \'\'').run();
  } catch (_) {}
  try {
    await db.prepare('ALTER TABLE courses ADD COLUMN notice TEXT NOT NULL DEFAULT \'\'').run();
  } catch (_) {}
  try {
    await db.prepare('ALTER TABLE courses ADD COLUMN notice_time TEXT NOT NULL DEFAULT \'\'').run();
  } catch (_) {}
  try {
    await db.prepare('ALTER TABLE groups ADD COLUMN peer_eval_open INTEGER NOT NULL DEFAULT 0').run();
  } catch (_) {}
  try {
    await db.prepare('ALTER TABLE groups ADD COLUMN peer_eval_deadline TEXT NOT NULL DEFAULT \'\'').run();
  } catch (_) {}
  try {
    await db.prepare('ALTER TABLE groups ADD COLUMN peer_eval_submitted INTEGER NOT NULL DEFAULT 0').run();
  } catch (_) {}
  try {
    await db.prepare('ALTER TABLE students ADD COLUMN peer_penalty INTEGER NOT NULL DEFAULT 0').run();
  } catch (_) {}
  try {
    await db.prepare('ALTER TABLE students ADD COLUMN peer_comment TEXT NOT NULL DEFAULT \'\'').run();
  } catch (_) {}
  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS group_snapshots (course_id TEXT PRIMARY KEY, snapshot TEXT NOT NULL, created_at INTEGER NOT NULL)').run();
  } catch (_) {}
  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS notices (id TEXT PRIMARY KEY, course_id TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, time_str TEXT NOT NULL DEFAULT \'\')').run();
  } catch (_) {}
  try {
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_notices_course ON notices(course_id, created_at DESC)').run();
  } catch (_) {}
  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS activity_logs (id TEXT PRIMARY KEY, course_id TEXT NOT NULL, operator TEXT NOT NULL, action TEXT NOT NULL, details TEXT NOT NULL, created_at INTEGER NOT NULL, time_str TEXT NOT NULL DEFAULT \'\')').run();
  } catch (_) {}
  try {
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_activity_logs_course ON activity_logs(course_id, created_at DESC)').run();
  } catch (_) {}
  try {
    await db.prepare('ALTER TABLE students ADD COLUMN password_hash TEXT NOT NULL DEFAULT \'\'').run();
  } catch (_) {}
  try {
    await db.prepare('ALTER TABLE courses ADD COLUMN deadline_triggered INTEGER NOT NULL DEFAULT 0').run();
  } catch (_) {}
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS attendance_sessions (
      id          TEXT NOT NULL,
      course_id   TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      date        TEXT NOT NULL DEFAULT '',
      time_slot   TEXT NOT NULL DEFAULT '',
      name        TEXT NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (course_id, id)
    )`).run();
  } catch (_) {}
  try {
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_attendance_sessions_course ON attendance_sessions(course_id, date DESC)').run();
  } catch (_) {}
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS attendance_records (
      course_id      TEXT NOT NULL,
      session_id     TEXT NOT NULL,
      student_id     TEXT NOT NULL,
      group_id       TEXT NOT NULL DEFAULT '',
      status         TEXT NOT NULL DEFAULT 'present',
      marked_by_id   TEXT NOT NULL DEFAULT '',
      marked_by_name TEXT NOT NULL DEFAULT '',
      created_at     INTEGER NOT NULL DEFAULT 0,
      updated_at     INTEGER NOT NULL,
      PRIMARY KEY (course_id, session_id, student_id)
    )`).run();
  } catch (_) {}
  try {
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_attendance_records_session ON attendance_records(course_id, session_id)').run();
  } catch (_) {}
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS attendance_unlocks (
      course_id  TEXT NOT NULL,
      session_id TEXT NOT NULL,
      group_id   TEXT NOT NULL DEFAULT '',
      deadline   TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (course_id, session_id, group_id)
    )`).run();
  } catch (_) {}
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS attendance_delegates (
      course_id     TEXT NOT NULL,
      session_id    TEXT NOT NULL,
      group_id      TEXT NOT NULL,
      delegate_id   TEXT NOT NULL,
      delegate_name TEXT NOT NULL DEFAULT '',
      created_at    INTEGER NOT NULL,
      PRIMARY KEY (course_id, session_id, group_id, delegate_id)
    )`).run();
  } catch (_) {}
  try {
    await cleanupDuplicateAndEmptyGroups(db);
  } catch (_) {}
  _ensuredGroupSchema = true;
}

/* ===== 組別編號解析與連續性控制演算法 ===== */
export function parseGroupNumber(name) {
  if (!name) return null;
  const m = String(name).match(/(?:第\s*(\d+)\s*組|Group\s*(\d+)|^(\d+)$)/i);
  if (m) {
    return parseInt(m[1] || m[2] || m[3], 10);
  }
  return null;
}

/**
 * 取得填補空缺後的可用組別編號清單：
 * 檢查現有組別編號（如 [1, 2, 4, 5, 8]），從 1 開始由小至大尋找未被佔用的缺號（填補為 [3, 6, 7]），
 * 嚴格遵循「不更動既有學生組別編號」的最高原則，使組別編號平滑連續無空缺。
 */
export function getNextAvailableGroupNumbers(existingGroups, count = 1) {
  const occupied = new Set();
  (existingGroups || []).forEach(g => {
    const num = parseGroupNumber(g && g.name);
    if (num !== null && num > 0) occupied.add(num);
  });
  const result = [];
  let candidate = 1;
  while (result.length < count) {
    if (!occupied.has(candidate)) {
      result.push(candidate);
      occupied.add(candidate);
    }
    candidate++;
  }
  return result;
}

/**
 * 清理重複組名與無成員之空組別，並自動修正重名組別填補空缺：
 * 1. 移除所有完全沒有組員的空組別（0人空組）
 * 2. 同一名稱重複時：
 *    - 凡是有組長之組別（由學生自主建立），原有名稱 100% 完整保留（最高原則）
 *    - 無成員之副本直接刪除
 *    - 若同名重複組別皆有成員（先前自動建組產生重名），將無組長之重複組別自動重新命名為最低之缺號（如第 4 組、第 10 組）
 * 3. 確保組別既不重複、又填補缺號。
 */
export async function cleanupDuplicateAndEmptyGroups(db, specificCourseId = null) {
  const coursesQuery = specificCourseId 
    ? db.prepare('SELECT id FROM courses WHERE id = ?').bind(specificCourseId)
    : db.prepare('SELECT id FROM courses');
  const { results: courses } = await coursesQuery.all();
  if (!courses || !courses.length) return { totalRemoved: 0, totalRenamed: 0, details: [] };

  let totalRemoved = 0;
  let totalRenamed = 0;
  const details = [];

  for (const c of courses) {
    const [groupsRes, studentsRes] = await Promise.all([
      db.prepare('SELECT id, name, seq FROM groups WHERE course_id = ? ORDER BY seq ASC').bind(c.id).all(),
      db.prepare('SELECT id, group_id, is_leader FROM students WHERE course_id = ?').bind(c.id).all(),
    ]);
    const groups = groupsRes.results || [];
    const students = studentsRes.results || [];

    const memberCounts = {};
    const leaderCounts = {};
    groups.forEach(g => {
      memberCounts[g.id] = 0;
      leaderCounts[g.id] = 0;
    });
    students.forEach(s => {
      if (s.group_id && memberCounts[s.group_id] !== undefined) {
        memberCounts[s.group_id]++;
        if (s.is_leader) leaderCounts[s.group_id]++;
      }
    });

    const toDeleteIds = new Set();
    const nameMap = new Map();

    for (const g of groups) {
      if (!nameMap.has(g.name)) nameMap.set(g.name, []);
      nameMap.get(g.name).push(g);
    }

    const preservedGroups = [];
    const toRenameGroups = [];

    for (const [name, gList] of nameMap.entries()) {
      if (gList.length === 1) {
        const g = gList[0];
        if (memberCounts[g.id] === 0) {
          toDeleteIds.add(g.id);
        } else {
          preservedGroups.push(g);
        }
      } else {
        // 重複同名組別
        const withLeader = gList.filter(g => leaderCounts[g.id] > 0);
        const withMembersNoLeader = gList.filter(g => leaderCounts[g.id] === 0 && memberCounts[g.id] > 0);
        const empty = gList.filter(g => memberCounts[g.id] === 0);

        // 無成員之重複副本一律直接刪除
        empty.forEach(g => toDeleteIds.add(g.id));

        if (withLeader.length > 0) {
          // 有組長之組別優先保留原名（由學生自行組建之組別）
          preservedGroups.push(withLeader[0]);
          for (let i = 1; i < withLeader.length; i++) {
            preservedGroups.push(withLeader[i]);
          }
          // 其餘無組長但有成員之重複組別（先前系統分配產生的衝突組），重新命名填補缺號
          withMembersNoLeader.forEach(g => toRenameGroups.push(g));
        } else if (withMembersNoLeader.length > 0) {
          // 若重複組皆無組長，保留第一個，其餘重命名填補缺號
          preservedGroups.push(withMembersNoLeader[0]);
          for (let i = 1; i < withMembersNoLeader.length; i++) {
            toRenameGroups.push(withMembersNoLeader[i]);
          }
        }
      }
    }

    const stmts = [];
    // 刪除空組別
    const idsArray = Array.from(toDeleteIds);
    if (idsArray.length > 0) {
      for (const gid of idsArray) {
        stmts.push(db.prepare('DELETE FROM groups WHERE course_id = ? AND id = ?').bind(c.id, gid));
        stmts.push(db.prepare('DELETE FROM attendance_unlocks WHERE course_id = ? AND group_id = ?').bind(c.id, gid));
        stmts.push(db.prepare('DELETE FROM attendance_delegates WHERE course_id = ? AND group_id = ?').bind(c.id, gid));
      }
      totalRemoved += idsArray.length;
    }

    // 針對需重新命名的重複組別，計算可用的空缺編號並更新
    if (toRenameGroups.length > 0) {
      const availableNums = getNextAvailableGroupNumbers(preservedGroups, toRenameGroups.length);
      toRenameGroups.forEach((g, idx) => {
        const newName = `第 ${availableNums[idx]} 組`;
        stmts.push(db.prepare('UPDATE groups SET name = ? WHERE course_id = ? AND id = ?').bind(newName, c.id, g.id));
        g.name = newName;
        preservedGroups.push(g);
        totalRenamed++;
      });
    }

    if (stmts.length > 0) {
      for (let i = 0; i < stmts.length; i += 50) {
        await db.batch(stmts.slice(i, i + 50));
      }
      details.push({ courseId: c.id, removed: idsArray.length, renamed: toRenameGroups.length });
    }
  }

  if (totalRemoved > 0 || totalRenamed > 0) {
    invalidateStateCache();
  }
  return { totalRemoved, totalRenamed, details };
}

/**
 * 全體組號平滑緊縮連續化（1 ~ N）：
 * 將現有組別依自然順序重新命名為第 1 組、第 2 組 ... 第 N 組，消除因中途刪組留下的大號缺漏。
 */
export async function renumberGroupsSequentially(db, courseId) {
  const [groupsRes] = await Promise.all([
    db.prepare('SELECT id, name, seq FROM groups WHERE course_id = ? ORDER BY seq ASC').bind(courseId).all(),
  ]);
  const groups = groupsRes.results || [];
  if (!groups.length) return { updated: 0 };

  // 自然排序
  groups.sort((a, b) => {
    const na = parseGroupNumber(a.name);
    const nb = parseGroupNumber(b.name);
    if (na !== null && nb !== null) return na - nb;
    if (na !== null) return -1;
    if (nb !== null) return 1;
    return (a.seq || 0) - (b.seq || 0);
  });

  const stmts = [];
  let updated = 0;
  groups.forEach((g, idx) => {
    const targetName = `第 ${idx + 1} 組`;
    const targetSeq = idx + 1;
    if (g.name !== targetName || g.seq !== targetSeq) {
      stmts.push(db.prepare('UPDATE groups SET name = ?, seq = ? WHERE course_id = ? AND id = ?')
        .bind(targetName, targetSeq, courseId, g.id));
      updated++;
    }
  });

  if (stmts.length > 0) {
    for (let i = 0; i < stmts.length; i += 50) {
      await db.batch(stmts.slice(i, i + 50));
    }
    invalidateStateCache();
  }
  return { updated };
}

/* ===== 伺服器短暫記憶體快取與快取失效 ===== */
let _cachedRawCourses = null;
let _cachedRawTime = 0;
const RAW_CACHE_TTL = 4000; // 4 秒記憶體快取，收斂課堂尖峰瞬間連線

export function invalidateStateCache() {
  _cachedRawCourses = null;
  _cachedRawTime = 0;
}

/* ===== 點名核心輔助演算法 ===== */
export const todayDateStr = () => {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
};

export function isDailySession(session) {
  if (!session) return false;
  if (session.isDaily) return true;
  if (session.id && String(session.id).startsWith('daily-')) return true;
  if (session.name === '一般日常點名' || session.name === '日常點名') return true;
  return false;
}

export function attendanceUnlockFor(unlocks = [], sessionId, groupId) {
  const now = Date.now();
  return (unlocks || []).find(u =>
    u.sessionId === sessionId
    && (u.groupId === groupId || u.groupId === '')
    && (!u.deadline || new Date(u.deadline).getTime() > now)
  ) || null;
}

export function isAttendanceEditable(session, unlocks = [], groupId = '') {
  if (!session) return false;
  if (session.date === todayDateStr()) return true;
  return !!attendanceUnlockFor(unlocks, session.id, groupId);
}

export async function addLog(db, courseId, operator, action, details) {
  try {
    const id = 'log_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const now = Date.now();
    const timeStr = new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    await db.prepare('INSERT INTO activity_logs (id, course_id, operator, action, details, created_at, time_str) VALUES (?,?,?,?,?,?,?)')
      .bind(id, courseId, operator, action, details, now, timeStr).run();
  } catch (e) {
    console.error('Failed to record activity log:', e);
  }
}

export async function fetchCourseLogs(db, courseId, limit = 500) {
  try {
    const rows = await db.prepare('SELECT * FROM activity_logs WHERE course_id = ? ORDER BY created_at DESC LIMIT ?')
      .bind(courseId, limit).all();
    return (rows.results || []).map(l => ({
      id: l.id,
      operator: l.operator || '',
      action: l.action || '',
      details: l.details || '',
      time: l.time_str || (l.created_at ? new Date(l.created_at + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ') : ''),
      createdAt: l.created_at || 0,
    }));
  } catch (e) {
    console.error('Failed to fetch course logs:', e);
    return [];
  }
}

export const DEFAULT_NOTICE = `【期末考成績加減分與評分規定】：
1. 當老師開放組長評分權限時，組長可依據組員之貢獻或配合程度於期末時給予加分 (0 ~ 10 分)。
2. 組長在老師開放評分權限時進行評分，組長自己可獲得 10 分的加分。
3. 超過分組截止時間由系統自動分組造成沒有組長的組別，每位成員期末考成績扣 10 分。`;

/* 判斷組長評分是否逾時 */
export const evalDeadlinePassed = g => !!g.peerEvalDeadline && Date.now() > new Date(g.peerEvalDeadline).getTime();

/* 判斷組長重新挑選組員截止時間是否已逾時 */
export const editDeadlinePassed = g => !!g.editDeadline && Date.now() > new Date(g.editDeadline).getTime();

/* 判斷組長當前是否具備挑選／更換組員之權限 */
export function canGroupLeaderEdit(c, g) {
  if (!c) return false;
  if (!deadlinePassed(c)) return true;
  if (!g || !g.allowEdit) return false;
  if (g.editDeadline && editDeadlinePassed(g)) return false;
  return true;
}

/* 計算每位學生的期末考調分與原因 */
export function calcAdjustment(c, g, s) {
  if (!s.groupId || !g) {
    return { score: 0, tag: '未分組', reason: '尚未加入組別，無期末考調分', status: 'none' };
  }
  const lead = c.students.find(x => x.groupId === g.id && x.isLeader);

  // 情況 1：無組長組別（超過分組截止時間系統自動分組，且無組長）
  if (!lead) {
    return { score: -10, tag: '-10分', reason: '超過分組截止時間無組長，全員期末考扣 10 分', status: 'no-leader' };
  }

  // 情況 2：有組長組別
  const isEvalOpen = !!g.peerEvalOpen;
  const isSubmitted = !!g.peerEvalSubmitted;
  const isOverdue = isEvalOpen && evalDeadlinePassed(g) && !isSubmitted;

  if (isSubmitted) {
    // 組長已完成評分
    if (s.isLeader) {
      return { score: 10, tag: '+10分', reason: '組長於老師開放評分權限時完成評分，組長自己獲得加 10 分', status: 'leader-normal' };
    } else {
      const bonus = Math.max(0, Math.min(10, Number(s.peerPenalty) || 0));
      const commentMsg = s.peerComment ? ` [原因: ${s.peerComment}]` : '';
      return {
        score: bonus,
        penalty: bonus,
        tag: (bonus > 0 ? `+${bonus}` : `${bonus}`) + '分',
        reason: bonus > 0 ? `經組長依貢獻度評定加 ${bonus} 分${commentMsg}` : '組長評定加 0 分（無額外加分）',
        status: bonus > 0 ? 'member-bonus' : 'member-zero',
      };
    }
  }

  if (isOverdue) {
    // 開放後已逾時但組長未進行評分
    if (s.isLeader) {
      return { score: 0, tag: '±0分', reason: '組長未於評分截止時間前進行評分，無法獲得 10 分加分', status: 'leader-overdue' };
    } else {
      return { score: 0, tag: '±0分', reason: '組長逾時未進行評分，組員無法獲得加分', status: 'member-overdue' };
    }
  }

  // 評分開放中但尚未截止且尚未提交，或老師尚未開放評分
  if (isEvalOpen) {
    if (s.isLeader) {
      return { score: 0, tag: '評分中', reason: '組長評分進行中（完成評分後組長自己可獲得 10 分加分）', status: 'leader-pending' };
    } else {
      return { score: 0, tag: '評分中', reason: '組長評分進行中（組長可依貢獻度給予 0~10 分加分）', status: 'member-pending' };
    }
  }

  // 老師尚未開放評分
  if (s.isLeader) {
    return { score: 0, tag: '待開放', reason: '待老師開放評分權限並完成評分後，組長可獲得 10 分加分', status: 'leader-pending' };
  } else {
    return { score: 0, tag: '待開放', reason: '待老師開放評分權限後，組長可依貢獻度給予 0~10 分加分', status: 'member-pending' };
  }
}

export async function loadState(db) {
  const now = Date.now();
  if (_cachedRawCourses && (now - _cachedRawTime < RAW_CACHE_TTL)) {
    return structuredClone(_cachedRawCourses);
  }

  await ensureGroupSchema(db);
  const [courses, groups, students, snapshots, notices, attSessions, attRecords, attUnlocks, attDelegates] = await Promise.all([
    db.prepare('SELECT * FROM courses ORDER BY year DESC, created_at ASC').all(),
    db.prepare('SELECT * FROM groups ORDER BY seq ASC').all(),
    db.prepare('SELECT * FROM students ORDER BY seq ASC').all(),
    db.prepare('SELECT course_id FROM group_snapshots').all().catch(() => ({ results: [] })),
    db.prepare('SELECT * FROM notices ORDER BY created_at DESC').all().catch(() => ({ results: [] })),
    db.prepare('SELECT * FROM attendance_sessions ORDER BY date DESC, created_at DESC').all().catch(() => ({ results: [] })),
    db.prepare('SELECT * FROM attendance_records').all().catch(() => ({ results: [] })),
    db.prepare('SELECT * FROM attendance_unlocks').all().catch(() => ({ results: [] })),
  ]);

  // 自動檢測重複組別：若資料庫內存在同名重複組別，即時自動自癒修復
  const seenGroupKeys = new Set();
  let hasDuplicateGroups = false;
  for (const g of (groups.results || [])) {
    const k = g.course_id + '::' + g.name;
    if (seenGroupKeys.has(k)) {
      hasDuplicateGroups = true;
      break;
    }
    seenGroupKeys.add(k);
  }
  if (hasDuplicateGroups) {
    await cleanupDuplicateAndEmptyGroups(db);
    groups.results = (await db.prepare('SELECT * FROM groups ORDER BY seq ASC').all()).results || [];
  }

  const snapshotSet = new Set((snapshots.results || []).map(r => r.course_id));
  const result = courses.results.map(c => {
    const courseGroups = groups.results.filter(g => g.course_id === c.id).map(g => ({
      id: g.id,
      name: g.name,
      allowEdit: !!g.allow_edit,
      editDeadline: g.edit_deadline || '',
      peerEvalOpen: !!g.peer_eval_open,
      peerEvalDeadline: g.peer_eval_deadline || '',
      peerEvalSubmitted: !!g.peer_eval_submitted,
    }));
    courseGroups.sort((a, b) => {
      const na = parseGroupNumber(a.name);
      const nb = parseGroupNumber(b.name);
      if (na !== null && nb !== null) return na - nb;
      if (na !== null) return -1;
      if (nb !== null) return 1;
      return (a.seq || 0) - (b.seq || 0);
    });
    const courseStudents = students.results.filter(s => s.course_id === c.id).map(s => ({
      id: s.id, name: s.name, groupId: s.group_id,
      isLeader: !!s.is_leader, isVice: !!s.is_vice, autoAssigned: !!s.auto_assigned,
      peerPenalty: Number(s.peer_penalty) || 0,
      peerComment: s.peer_comment || '',
      passwordHash: s.password_hash || '',
      hasCustomPassword: !!s.password_hash,
    }));

    const courseNotices = (notices.results || [])
      .filter(n => n.course_id === c.id)
      .map(n => ({ id: n.id, content: n.content, time: n.time_str || '' }));

    const courseSessions = (attSessions.results || [])
      .filter(s => s.course_id === c.id)
      .map(s => ({
        id: s.id,
        date: s.date,
        timeSlot: s.time_slot || '',
        name: s.name || '',
        isDaily: s.id.startsWith('daily-') || s.name === '一般日常點名' || s.name === '日常點名',
        createdAt: s.created_at || 0,
      }));

    const courseRecords = (attRecords.results || [])
      .filter(r => r.course_id === c.id)
      .map(r => ({
        sessionId: r.session_id,
        studentId: r.student_id,
        groupId: r.group_id || '',
        status: r.status || 'present',
        markedById: r.marked_by_id || '',
        markedByName: r.marked_by_name || '',
        createdAt: r.created_at || 0,
        updatedAt: r.updated_at || r.created_at || 0,
      }));

    const courseUnlocks = (attUnlocks.results || [])
      .filter(u => u.course_id === c.id)
      .map(u => ({
        sessionId: u.session_id,
        groupId: u.group_id || '',
        deadline: u.deadline || '',
        createdAt: u.created_at || 0,
      }));

    const courseDelegates = (attDelegates.results || [])
      .filter(d => d.course_id === c.id)
      .map(d => ({
        sessionId: d.session_id,
        groupId: d.group_id,
        delegateId: d.delegate_id,
        delegateName: d.delegate_name || '',
        createdAt: d.created_at || 0,
      }));
    // 計算每位同學的調分結果
    const courseObj = {
      id: c.id, year: c.year, subject: c.subject,
      groupSize: c.group_size, tolerance: c.tolerance, deadline: c.deadline,
      deadlineTriggered: !!c.deadline_triggered,
      notices: courseNotices,
      logs: [], // 依需動態載入，避免每次常態輪詢浪費 D1 額度
      hasSnapshot: snapshotSet.has(c.id),
      groups: courseGroups,
      students: courseStudents,
      attendanceSessions: courseSessions,
      attendanceRecords: courseRecords,
      attendanceUnlocks: courseUnlocks,
      attendanceDelegates: courseDelegates,
    };

    courseStudents.forEach(s => {
      const g = courseGroups.find(x => x.id === s.groupId);
      s.adjustment = calcAdjustment(courseObj, g, s);
    });

    return courseObj;
  });

  _cachedRawCourses = structuredClone(result);
  _cachedRawTime = Date.now();
  return result;
}

export const cap = c => Number(c.groupSize) + Number(c.tolerance);
export const minCap = c => Math.max(1, Number(c.groupSize) - Number(c.tolerance));
export const membersOf = (c, gid) => c.students.filter(s => s.groupId === gid);
export const deadlinePassed = c => !!c.deadline && Date.now() > new Date(c.deadline).getTime();

export function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export async function teacherHash(db) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind('teacher_password').first();
  if (row) return row.value;
  const h = await sha256('teacher123');                       // 預設密碼
  await db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind('teacher_password', h).run();
  return h;
}

export const nextSeq = async (db, table, courseId) => {
  const r = await db.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM ${table} WHERE course_id = ?`).bind(courseId).first();
  return ((r && r.m) || 0) + 1;
};

export async function saveSnapshot(db, courseId) {
  const [snapGroups, snapStudents] = await Promise.all([
    db.prepare('SELECT id, course_id, name, seq, allow_edit, edit_deadline, peer_eval_open, peer_eval_deadline, peer_eval_submitted FROM groups WHERE course_id = ?').bind(courseId).all(),
    db.prepare('SELECT id, group_id, is_leader, is_vice, auto_assigned, peer_penalty, peer_comment FROM students WHERE course_id = ?').bind(courseId).all(),
  ]);
  const payload = JSON.stringify({
    groups: snapGroups.results || [],
    students: snapStudents.results || [],
  });
  await db.prepare('INSERT OR REPLACE INTO group_snapshots (course_id, snapshot, created_at) VALUES (?, ?, ?)')
    .bind(courseId, payload, Date.now()).run();
}

/**
 * 智慧自動補齊門檻並分配剩餘學生演算法：
 * 1. 取得未分組學生名單並隨機打散
 * 2. 第一階段：優先填補未達最低門檻 minCap 的現有組別，直到各未達門檻組別均達到 minCap（或未分組學生用罄）
 * 3. 第二階段：計算剩餘未分組學生人數，依每組人數 groupSize 計算需新建之組別數
 *    動態建立新組別，並將剩餘未分組學生輪流均衡分配加入新組別
 * 4. 批次寫入資料庫並記錄異動日誌
 */
export async function smartAutoAssign(db, c, operatorName = '老師') {
  // 先清理可能存在的重複組名或無成員之空組別，保留所有有成員之組別
  await cleanupDuplicateAndEmptyGroups(db, c.id);
  c.groups = c.groups.filter(g => membersOf(c, g.id).length > 0);

  const unassignedStudents = c.students.filter(x => !x.groupId);
  if (!unassignedStudents.length) {
    return { success: false, message: '目前沒有未分組學生 No unassigned students', filledCount: 0, addedGroups: 0, remainingCount: 0 };
  }

  // 自動備份快照，以便老師需要時可回到上一步復原
  await saveSnapshot(db, c.id);

  const min = minCap(c);
  const targetGroupSize = Math.max(1, Number(c.groupSize) || 4);

  // 1. 找出所有未達最低門檻的現有組別（皆為有組員之組別）
  const candidateGroups = c.groups.filter(g => membersOf(c, g.id).length < min);
  const shuffled = shuffle([...unassignedStudents]);

  const groupCounts = {};
  c.groups.forEach(g => {
    groupCounts[g.id] = membersOf(c, g.id).length;
  });

  const stmts = [];
  let filledCount = 0;

  // 2. 第一階段：依人數由少至多，優先填補未達門檻組別
  while (shuffled.length > 0) {
    const underMin = candidateGroups.filter(g => groupCounts[g.id] < min)
      .sort((a, b) => groupCounts[a.id] - groupCounts[b.id]);
    if (!underMin.length) break;

    const target = underMin[0];
    const s = shuffled.shift();
    s.groupId = target.id;
    s.autoAssigned = true;
    groupCounts[target.id]++;
    filledCount++;

    stmts.push(
      db.prepare('UPDATE students SET group_id = ?, auto_assigned = 1 WHERE course_id = ? AND id = ?')
        .bind(target.id, c.id, s.id)
    );
  }

  // 3. 第二階段：剩餘未分組學生自動建組並分配（優先填補空缺組號，絕不更動學生自組之組別）
  const remainingCount = shuffled.length;
  let addedGroups = 0;

  if (remainingCount > 0) {
    addedGroups = Math.max(1, Math.ceil(remainingCount / targetGroupSize));
    let seq = await nextSeq(db, 'groups', c.id);
    const availableNumbers = getNextAvailableGroupNumbers(c.groups, addedGroups);
    const newGroups = [];

    for (let i = 0; i < addedGroups; i++) {
      const newGid = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5) + i;
      const num = availableNumbers[i];
      const newName = '第 ' + num + ' 組';
      stmts.push(
        db.prepare('INSERT INTO groups (id, course_id, name, seq) VALUES (?,?,?,?)')
          .bind(newGid, c.id, newName, seq++)
      );
      const newG = { id: newGid, name: newName };
      newGroups.push(newG);
      c.groups.push(newG);
      groupCounts[newGid] = 0;
    }

    // 輪流分配（Round-Robin）將剩餘組員平均分入新組別中
    shuffled.forEach((s, idx) => {
      const targetGroup = newGroups[idx % newGroups.length];
      s.groupId = targetGroup.id;
      s.autoAssigned = true;
      groupCounts[targetGroup.id]++;

      stmts.push(
        db.prepare('UPDATE students SET group_id = ?, auto_assigned = 1 WHERE course_id = ? AND id = ?')
          .bind(targetGroup.id, c.id, s.id)
      );
    });
  }

  if (stmts.length) {
    for (let i = 0; i < stmts.length; i += 50) {
      await db.batch(stmts.slice(i, i + 50));
    }
  }

  invalidateStateCache();

  const logDesc = `一鍵自動分配未分組學生：優先填補 ${filledCount} 人至未達門檻組別` +
    (addedGroups > 0 ? `，並新建 ${addedGroups} 個組別（填補空缺組號）分配剩餘 ${remainingCount} 人` : '（所有未分組成員已全數填入現有組別）');
  await addLog(db, c.id, operatorName, 'teacher-smart-auto-assign', logDesc);

  return {
    success: true,
    filledCount,
    addedGroups,
    remainingCount,
  };
}

/* 截止時間到期自動觸發：
   當老師設定之分組截止時間到達時，系統自動觸發一次智慧分配，
   優先補齊未達門檻之組別，並為剩餘組員自動建立組別與分配入組。 */
export async function applyDeadline(db, courses) {
  for (const c of courses) {
    if (!deadlinePassed(c) || c.deadlineTriggered) continue;

    // 截止時間到達且尚未觸發過：自動執行一次智慧分配
    await smartAutoAssign(db, c, '系統 (分組截止時間到達)');

    // 標記該課程截止時間已觸發
    await db.prepare('UPDATE courses SET deadline_triggered = 1 WHERE id = ?').bind(c.id).run();
    c.deadlineTriggered = true;
    invalidateStateCache();
  }
  return courses;
}

/* ===== 對外遮蔽學號 =====
   學號同時是學生的登入密碼，因此非老師的回應一律遮蔽；
   組長操作改用 ref（以 session secret 推導的不可逆代號）。 */
const maskId = id => String(id).slice(0, 3) + '*'.repeat(Math.max(0, String(id).length - 3));

export async function studentRef(db, env, courseId, id, preloadedKey = null) {
  const k = preloadedKey || await getHmacKey(db, env);
  return (await hmacWithKey(k, 'ref:' + courseId + ':' + id)).slice(0, 16);
}

export async function publicize(db, env, courses, session) {
  if (session && session.role === 'teacher') return courses;
  const selfId = session && session.role === 'student' ? session.id : null;
  const selfCourse = session && session.courseId;
  const hmacKey = await getHmacKey(db, env);
  const out = [];
  for (const c of courses) {
    let leaderGroupId = null;
    let myGroupId = null;
    const delegatedGroupIds = new Set();

    if (selfId && c.id === selfCourse) {
      const selfRec = c.students.find(s => s.id === selfId);
      if (selfRec) {
        myGroupId = selfRec.groupId;
        if (selfRec.isLeader && selfRec.groupId) leaderGroupId = selfRec.groupId;
      }
      (c.attendanceDelegates || []).forEach(d => {
        if (d.delegateId === selfId) delegatedGroupIds.add(d.groupId);
      });
    }

    const students = [];
    for (const s of c.students) {
      const mine = selfId && s.id === selfId && c.id === selfCourse;
      const isMyGroupMember = leaderGroupId && s.groupId === leaderGroupId;
      const { adjustment, peerPenalty, peerComment, passwordHash, ...rest } = s;
      students.push({
        ...rest,
        ...(isMyGroupMember ? { peerPenalty, peerComment } : {}),
        id: mine ? s.id : maskId(s.id),
        ref: await studentRef(db, env, c.id, s.id, hmacKey),
      });
    }

    // 處理出缺席紀錄遮蔽：本人、所屬組別或被授權代理之組別可看見完整學號；其餘遮蔽以保障隱私
    const attendanceRecords = (c.attendanceRecords || []).map(r => {
      const canSeeRaw = (selfId && c.id === selfCourse) && (
        r.studentId === selfId ||
        (myGroupId && r.groupId === myGroupId) ||
        delegatedGroupIds.has(r.groupId)
      );
      return {
        ...r,
        studentId: canSeeRaw ? r.studentId : maskId(r.studentId),
      };
    });

    const { logs, ...courseWithoutLogs } = c;
    out.push({
      ...courseWithoutLogs,
      students,
      attendanceRecords,
    });
  }
  return out;
}

export async function resolveStudent(db, env, c, key) {
  const direct = c.students.find(s => s.id === key);
  if (direct) return direct;
  const hmacKey = await getHmacKey(db, env);
  for (const s of c.students) {
    if (await studentRef(db, env, c.id, s.id, hmacKey) === key) return s;
  }
  return null;
}
