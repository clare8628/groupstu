export const API_VERSION = 'v2.6.1 (2026.09.22-1442)';
import {
  json, bad, sha256, makeToken, readSession, sessionCookie, clearCookie,
  loadState, cap, minCap, membersOf, deadlinePassed, shuffle, teacherHash, nextSeq,
  applyDeadline, publicize, resolveStudent, canGroupLeaderEdit, DEFAULT_NOTICE, addLog,
  fetchCourseLogs,
  todayDateStr, isDailySession, attendanceUnlockFor, isAttendanceEditable,
  invalidateStateCache as invalidateLibCache,
  smartAutoAssign, saveSnapshot,
  parseGroupNumber, getNextAvailableGroupNumbers, cleanupDuplicateAndEmptyGroups,
} from './lib.js';

// 短暫記憶體快取防護（針對公開未登入/學生輪詢，有效緩解 D1 讀取消耗）
let _stateCache = null;
let _stateCacheExpiry = 0;
const CACHE_TTL_MS = 5000; // 5 秒防護期

export function invalidateStateCache() {
  _stateCache = null;
  _stateCacheExpiry = 0;
  if (typeof invalidateLibCache === 'function') invalidateLibCache();
}

/* GET /api/state — 公開讀取全部課程／名單／分組 */
export async function handleState(request, env, db) {
  const session = await readSession(db, env, request);
  const now = Date.now();

  // 若為未登入訪客且快取有效，直接回傳快取資料
  if (!session && _stateCache && now < _stateCacheExpiry) {
    return json({ courses: _stateCache, session: null, version: API_VERSION });
  }

  const courses = await applyDeadline(db, await loadState(db));
  const publicCourses = await publicize(db, env, courses, session);

  if (!session) {
    _stateCache = publicCourses;
    _stateCacheExpiry = now + CACHE_TTL_MS;
  }

  return json({ courses: publicCourses, session, version: API_VERSION });
}

/* POST /api/action — 所有異動，依角色驗證 */
export async function handleAction(request, env, db, body) {
  const action = body && body.action;
  if (!action) return bad('缺少 action');
  const session = await readSession(db, env, request);

  // 異動動作發生時清空狀態快取
  invalidateStateCache();

  // 針對按需取得日誌，不需全量重新 loadState
  if (action === 'teacher:get-logs') {
    if (!session || session.role !== 'teacher') return bad('需要老師權限 Teacher only', 403);
    const courseId = body.courseId;
    if (!courseId) return bad('缺少 courseId', 400);
    const logs = await fetchCourseLogs(db, courseId, 500);
    return json({ ok: true, logs });
  }

  const courses = await loadState(db);
  const course = id => courses.find(c => c.id === id);
  const ok = async (extra = {}, headers = {}) => {
    invalidateStateCache();
    const view = extra.session !== undefined ? extra.session : session;
    return json({ ok: true, courses: await publicize(db, env, await loadState(db), view), version: API_VERSION, ...extra }, 200, headers);
  };

  /* ---- 登入／登出 ---- */
  if (action === 'login-teacher') {
    if (await sha256(String(body.password || '')) !== await teacherHash(db)) return bad('密碼錯誤 Wrong password', 401);
    const token = await makeToken(db, env, { role: 'teacher' });
    return ok({ session: { role: 'teacher' } }, { 'set-cookie': sessionCookie(token) });
  }
  if (action === 'login-student') {
    const c = course(body.courseId);
    if (!c) return bad('課程不存在 Course not found', 404);
    const account = String(body.account || body.name || '').trim();
    const password = String(body.password || body.sid || '').trim();
    const s = c.students.find(x => x.id === account || x.name === account || (x.name === String(body.name || '').trim() && x.id === String(body.sid || '').trim()));
    if (!s) return bad('姓名或學號不正確，或不在本課程修課名單中', 401);

    // 比對密碼：若已自訂密碼則比對 SHA-256 雜湊，否則預設密碼為學號
    if (s.passwordHash) {
      const hashed = await sha256(password);
      if (hashed !== s.passwordHash) return bad('密碼錯誤 Wrong password', 401);
    } else {
      if (password !== s.id) return bad('密碼錯誤（預設為學號）Wrong password', 401);
    }

    const token = await makeToken(db, env, { role: 'student', id: s.id, courseId: c.id });
    return ok({ session: { role: 'student', id: s.id, courseId: c.id } }, { 'set-cookie': sessionCookie(token) });
  }
  if (action === 'logout') return ok({ session: null }, { 'set-cookie': clearCookie });

  /* ---- 老師 ---- */
  if (action.startsWith('teacher:')) {
    if (!session || session.role !== 'teacher') return bad('需要老師權限 Teacher only', 403);
    const op = action.slice(8);

    if (op === 'change-password') {
      if (await sha256(String(body.current || '')) !== await teacherHash(db)) return bad('目前密碼錯誤', 401);
      const next = String(body.next || '');
      if (next.length < 4) return bad('新密碼至少 4 碼');
      await db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
        .bind('teacher_password', await sha256(next)).run();
      return ok();
    }
    if (op === 'save-course') {
      const exists = course(body.id);
      const id = exists ? body.id : ('c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
      const args = [
        body.year || '',
        body.subject || '',
        Number(body.groupSize) || 4,
        Number(body.tolerance) || 0,
        body.deadline || '',
      ];
      if (exists) {
        await db.prepare('UPDATE courses SET year=?, subject=?, group_size=?, tolerance=?, deadline=?, deadline_triggered=0 WHERE id=?').bind(...args, id).run();
      } else {
        await db.prepare('INSERT INTO courses (id, year, subject, group_size, tolerance, deadline, deadline_triggered, created_at) VALUES (?,?,?,?,?,?,?,?)')
          .bind(id, ...args, 0, Date.now()).run();
        // 新課程預先建立一則預設公告，說明評分規則
        const nowStr = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
        const noticeId = 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        await db.prepare('INSERT INTO notices (id, course_id, content, created_at, time_str) VALUES (?,?,?,?,?)')
          .bind(noticeId, id, DEFAULT_NOTICE, Date.now(), nowStr).run();
      }
      return ok({ courseId: id });
    }
    if (op === 'add-notice') {
      const c = course(body.courseId);
      if (!c) return bad('課程不存在', 404);
      const content = String(body.content || '').trim();
      if (!content) return bad('公告內容不可為空', 400);
      const nowStr = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
      const id = 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      await db.prepare('INSERT INTO notices (id, course_id, content, created_at, time_str) VALUES (?,?,?,?,?)')
        .bind(id, c.id, content, Date.now(), nowStr).run();
      return ok();
    }
    if (op === 'del-notice') {
      const c = course(body.courseId);
      if (!c) return bad('課程不存在', 404);
      await db.prepare('DELETE FROM notices WHERE course_id=? AND id=?').bind(c.id, body.noticeId).run();
      return ok();
    }
    if (op === 'clear-logs') {
      const c = course(body.courseId);
      if (!c) return bad('課程不存在', 404);
      await db.prepare('DELETE FROM activity_logs WHERE course_id=?').bind(c.id).run();
      await addLog(db, c.id, '老師', 'teacher-clear-logs', '清空歷史異動日誌紀錄');
      return ok();
    }
    if (op === 'del-course') {
      await db.batch([
        db.prepare('DELETE FROM students WHERE course_id = ?').bind(body.courseId),
        db.prepare('DELETE FROM groups WHERE course_id = ?').bind(body.courseId),
        db.prepare('DELETE FROM courses WHERE id = ?').bind(body.courseId),
      ]);
      return ok();
    }
    if (op === 'del-groups') {
      const c = course(body.courseId);
      if (!c) return bad('課程不存在', 404);
      const groupIds = Array.isArray(body.groupIds) ? body.groupIds : [];
      if (!groupIds.length) return bad('請選擇欲刪除的組別', 400);

      const stmts = [];
      for (const gid of groupIds) {
        // 將該組成員重置為未分組
        stmts.push(db.prepare('UPDATE students SET group_id=NULL, is_leader=0, is_vice=0, auto_assigned=0 WHERE course_id=? AND group_id=?').bind(c.id, gid));
        stmts.push(db.prepare('DELETE FROM groups WHERE course_id=? AND id=?').bind(c.id, gid));
      }
      await db.batch(stmts);
      const deletedNames = c.groups.filter(g => groupIds.includes(g.id)).map(g => g.name);
      await addLog(db, c.id, '老師', 'teacher-del-groups', `刪除組別：${deletedNames.join('、')}，成員重置為未分組`);
      return ok();
    }
    if (op === 'add-students') {
      const c = course(body.courseId);
      if (!c) return bad('課程不存在', 404);
      let seq = await nextSeq(db, 'students', c.id);
      const seen = new Set(c.students.map(s => s.id));
      const rows = [];
      for (const x of (body.students || [])) {
        const id = String(x.id || '').trim(), name = String(x.name || '').trim();
        if (!id || !name || seen.has(id)) continue;
        seen.add(id);
        rows.push({ id, name });
      }
      if (!rows.length) return ok({ added: 0 });
      await db.batch(rows.map(x => db.prepare('INSERT INTO students (course_id, id, name, seq) VALUES (?,?,?,?)')
        .bind(c.id, x.id, x.name, seq++)));
      return ok({ added: rows.length });
    }
    if (op === 'del-student') {
      const cc = course(body.courseId);
      const victim = cc && await resolveStudent(db, env, cc, body.studentId);
      if (!victim) return bad('學生不存在', 404);
      await db.prepare('DELETE FROM students WHERE course_id = ? AND id = ?').bind(body.courseId, victim.id).run();
      return ok();
    }
    if (op === 'assign-student') {
      const c = course(body.courseId);
      if (!c) return bad('課程不存在', 404);
      const s = await resolveStudent(db, env, c, body.studentId);
      if (!s) return bad('學生不存在', 404);
      const gid = body.groupId || null;
      if (gid && s.groupId !== gid && membersOf(c, gid).length >= cap(c)) return bad(`該組已達上限 ${cap(c)} 人`);
      await db.prepare('UPDATE students SET group_id=?, auto_assigned=0, is_leader=CASE WHEN ? IS NULL THEN 0 ELSE is_leader END, is_vice=CASE WHEN ? IS NULL THEN 0 ELSE is_vice END WHERE course_id=? AND id=?')
        .bind(gid, gid, gid, c.id, s.id).run();
      const targetG = gid ? c.groups.find(x => x.id === gid) : null;
      const desc = targetG ? `將學生 ${s.name} (${s.id}) 分配至 ${targetG.name}` : `將學生 ${s.name} (${s.id}) 移出至未分組`;
      await addLog(db, c.id, '老師', 'teacher-assign', desc);
      return ok();
    }
    if (op === 'set-leader') {
      const c = course(body.courseId);
      const s = c && await resolveStudent(db, env, c, body.studentId);
      if (!s || !s.groupId) return bad('學生未分組', 400);
      const on = body.on ? 1 : 0;
      await db.batch([
        db.prepare('UPDATE students SET is_leader=0 WHERE course_id=? AND group_id=?').bind(c.id, s.groupId),
        db.prepare('UPDATE students SET is_leader=?, is_vice=CASE WHEN ?=1 THEN 0 ELSE is_vice END WHERE course_id=? AND id=?')
          .bind(on, on, c.id, s.id),
      ]);
      const g = c.groups.find(x => x.id === s.groupId);
      await addLog(db, c.id, '老師', 'teacher-set-leader', `將學生 ${s.name} (${s.id}) ${on ? '設為' : '取消'} ${g ? g.name : ''} 組長`);
      return ok();
    }
    if (op === 'make-groups') {
      const c = course(body.courseId);
      if (!c) return bad('課程不存在', 404);
      await saveSnapshot(db, c.id);
      const n = Math.max(1, Math.ceil(c.students.length / Math.max(1, c.groupSize)));
      const stmts = [
        db.prepare('DELETE FROM groups WHERE course_id = ?').bind(c.id),
        db.prepare('UPDATE students SET group_id=NULL, is_leader=0, is_vice=0, auto_assigned=0 WHERE course_id=?').bind(c.id),
      ];
      for (let i = 1; i <= n; i++) {
        stmts.push(db.prepare('INSERT INTO groups (id, course_id, name, seq) VALUES (?,?,?,?)')
          .bind('g' + i, c.id, '第 ' + i + ' 組', i));
      }
      await db.batch(stmts);
      invalidateStateCache();
      await addLog(db, c.id, '老師', 'teacher-make-groups', `依人數重建 ${n} 個預設空組別（已建立快照備份，清空原有分組分配）`);
      return ok({ createdGroups: n });
    }
    if (op === 'restore-groups-snapshot') {
      const c = course(body.courseId);
      if (!c) return bad('課程不存在', 404);
      const row = await db.prepare('SELECT snapshot FROM group_snapshots WHERE course_id = ?').bind(c.id).first();
      if (!row || !row.snapshot) return bad('目前無可復原的步驟紀錄', 400);

      let data = null;
      try {
        data = JSON.parse(row.snapshot);
      } catch (e) {
        return bad('快照資料損壞無法復原', 500);
      }

      const snapGroups = Array.isArray(data.groups) ? data.groups : [];
      const snapStudents = Array.isArray(data.students) ? data.students : [];

      const stmts = [
        db.prepare('DELETE FROM groups WHERE course_id = ?').bind(c.id),
        db.prepare('UPDATE students SET group_id=NULL, is_leader=0, is_vice=0, auto_assigned=0, peer_penalty=0, peer_comment=\'\' WHERE course_id=?').bind(c.id),
      ];

      for (const g of snapGroups) {
        stmts.push(db.prepare('INSERT INTO groups (id, course_id, name, seq, allow_edit, edit_deadline, peer_eval_open, peer_eval_deadline, peer_eval_submitted) VALUES (?,?,?,?,?,?,?,?,?)')
          .bind(g.id, c.id, g.name, g.seq || 0, g.allow_edit ? 1 : 0, g.edit_deadline || '', g.peer_eval_open ? 1 : 0, g.peer_eval_deadline || '', g.peer_eval_submitted ? 1 : 0));
      }

      for (const s of snapStudents) {
        stmts.push(db.prepare('UPDATE students SET group_id=?, is_leader=?, is_vice=?, auto_assigned=?, peer_penalty=?, peer_comment=? WHERE course_id=? AND id=?')
          .bind(s.group_id, s.is_leader ? 1 : 0, s.is_vice ? 1 : 0, s.auto_assigned ? 1 : 0, Number(s.peer_penalty) || 0, s.peer_comment || '', c.id, s.id));
      }

      stmts.push(db.prepare('DELETE FROM group_snapshots WHERE course_id = ?').bind(c.id));

      await db.batch(stmts);
      await addLog(db, c.id, '老師', 'teacher-restore-snapshot', '復原至上次分組快照狀態');
      return ok();
    }
    if (op === 'add-group') {
      const c = course(body.courseId);
      if (!c) return bad('課程不存在', 404);
      const nextNum = getNextAvailableGroupNumbers(c.groups, 1)[0];
      const seq = await nextSeq(db, 'groups', c.id);
      const newName = '第 ' + nextNum + ' 組';
      await db.prepare('INSERT INTO groups (id, course_id, name, seq) VALUES (?,?,?,?)')
        .bind('g' + Date.now().toString(36), c.id, newName, seq).run();
      invalidateStateCache();
      await addLog(db, c.id, '老師', 'teacher-add-group', `手動新增組別：${newName}`);
      return ok({ name: newName });
    }
    if (op === 'cleanup-groups') {
      const c = course(body.courseId);
      if (!c) return bad('課程不存在', 404);
      const res = await cleanupDuplicateAndEmptyGroups(db, c.id);
      await addLog(db, c.id, '老師', 'teacher-cleanup-groups', `清理重複與無人組別：共移除 ${res.totalRemoved} 個無成員之重複或空白組別（保留所有學生自組組別）`);
      return ok({ removed: res.totalRemoved });
    }
    if (op === 'clear-groups') {
      const c = course(body.courseId);
      if (c) {
        await saveSnapshot(db, c.id);
      }
      await db.batch([
        db.prepare('DELETE FROM groups WHERE course_id = ?').bind(body.courseId),
        db.prepare('UPDATE students SET group_id=NULL, is_leader=0, is_vice=0, auto_assigned=0 WHERE course_id=?').bind(body.courseId),
      ]);
      await addLog(db, body.courseId, '老師', 'teacher-clear-groups', '清除所有組別與學生分組分配');
      return ok();
    }
    if (op === 'toggle-group-edit') {
      const c = course(body.courseId);
      if (!c) return bad('課程不存在', 404);
      const g = c.groups.find(x => x.id === body.groupId);
      if (!g) return bad('組別不存在', 404);
      const allow = body.allowEdit ? 1 : 0;
      const editDeadline = allow ? (body.editDeadline !== undefined ? String(body.editDeadline) : '') : '';
      await db.prepare('UPDATE groups SET allow_edit=?, edit_deadline=? WHERE course_id=? AND id=?')
        .bind(allow, editDeadline, c.id, g.id).run();
      await addLog(db, c.id, '老師', 'teacher-toggle-group-edit', `${allow ? '重新開放' : '關閉'} ${g.name} 組長挑選組員權限${editDeadline ? '（新截止時間：' + editDeadline.replace('T', ' ') + '）' : ''}`);
      return ok();
    }
    if (op === 'set-peer-eval') {
      const c = course(body.courseId);
      if (!c) return bad('課程不存在', 404);
      const g = c.groups.find(x => x.id === body.groupId);
      if (!g) return bad('組別不存在', 404);
      const open = body.open ? 1 : 0;
      const deadline = body.deadline !== undefined ? String(body.deadline) : g.peerEvalDeadline;
      await db.prepare('UPDATE groups SET peer_eval_open=?, peer_eval_deadline=? WHERE course_id=? AND id=?')
        .bind(open, deadline, c.id, g.id).run();
      return ok();
    }
    if (op === 'set-all-peer-eval') {
      const c = course(body.courseId);
      if (!c) return bad('課程不存在', 404);
      const open = body.open ? 1 : 0;
      const deadline = body.deadline !== undefined ? String(body.deadline) : '';
      await db.prepare('UPDATE groups SET peer_eval_open=?, peer_eval_deadline=? WHERE course_id=?')
        .bind(open, deadline, c.id).run();
      return ok();
    }
    if (op === 'smart-auto-assign' || op === 'auto-assign') {
      const c = course(body.courseId);
      if (!c) return bad('課程不存在', 404);
      const res = await smartAutoAssign(db, c, '老師');
      if (!res.success) return bad(res.message, 400);
      return ok(res);
    }

    /* ---- 點名管理（老師） ---- */
    if (op === 'save-attendance-session') {
      const c = course(body.courseId);
      if (!c) return bad('課程不存在', 404);
      const now = Date.now();
      const id = body.id || ('sess_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
      const date = String(body.date || todayDateStr()).trim();
      const timeSlot = String(body.timeSlot || '').trim();
      const name = String(body.name || '').trim();
      if (!name) return bad('請填寫點名時段名稱', 400);

      await db.prepare(`
        INSERT OR REPLACE INTO attendance_sessions (id, course_id, date, time_slot, name, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(id, c.id, date, timeSlot, name, now).run();

      invalidateStateCache();
      await addLog(db, c.id, '老師', 'attendance-session-save', `儲存點名時段：「${name}」（日期：${date}${timeSlot ? '，' + timeSlot : ''}）`);
      return ok();
    }

    if (op === 'del-attendance-session') {
      const c = course(body.courseId);
      if (!c) return bad('課程不存在', 404);
      const sessionId = body.sessionId;
      if (!sessionId) return bad('缺少時段 ID', 400);

      const sess = (c.attendanceSessions || []).find(s => s.id === sessionId);
      const sessName = sess ? sess.name : sessionId;

      await db.batch([
        db.prepare('DELETE FROM attendance_records WHERE course_id = ? AND session_id = ?').bind(c.id, sessionId),
        db.prepare('DELETE FROM attendance_unlocks WHERE course_id = ? AND session_id = ?').bind(c.id, sessionId),
        db.prepare('DELETE FROM attendance_delegates WHERE course_id = ? AND session_id = ?').bind(c.id, sessionId),
        db.prepare('DELETE FROM attendance_sessions WHERE course_id = ? AND id = ?').bind(c.id, sessionId),
      ]);

      invalidateStateCache();
      await addLog(db, c.id, '老師', 'attendance-session-delete', `刪除點名時段：「${sessName}」及其相關紀錄`);
      return ok();
    }

    if (op === 'set-attendance-unlock') {
      const c = course(body.courseId);
      if (!c) return bad('課程不存在', 404);
      const { sessionId, groupId = '', allow, deadline = '' } = body;
      if (!sessionId) return bad('缺少時段 ID', 400);

      const sess = (c.attendanceSessions || []).find(s => s.id === sessionId);
      const sessName = sess ? sess.name : sessionId;
      const targetGroup = groupId ? c.groups.find(g => g.id === groupId) : null;
      const scopeLabel = targetGroup ? targetGroup.name : '全班所有組別';

      if (allow) {
        await db.prepare(`
          INSERT OR REPLACE INTO attendance_unlocks (course_id, session_id, group_id, deadline, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).bind(c.id, sessionId, groupId, String(deadline || ''), Date.now()).run();
        invalidateStateCache();
        await addLog(db, c.id, '老師', 'attendance-unlock', `開放「${sessName}」針對【${scopeLabel}】補登點名${deadline ? '（截止時間：' + deadline.replace('T', ' ') + '）' : ''}`);
      } else {
        await db.prepare('DELETE FROM attendance_unlocks WHERE course_id = ? AND session_id = ? AND group_id = ?')
          .bind(c.id, sessionId, groupId).run();
        invalidateStateCache();
        await addLog(db, c.id, '老師', 'attendance-unlock', `關閉「${sessName}」針對【${scopeLabel}】之補登權限`);
      }
      return ok();
    }

    if (op === 'set-attendance-delegate') {
      const c = course(body.courseId);
      if (!c) return bad('課程不存在', 404);
      const { sessionId, groupId, delegateId, allow } = body;
      if (!sessionId || !groupId || !delegateId) return bad('缺少參數', 400);

      const sess = (c.attendanceSessions || []).find(s => s.id === sessionId);
      const sessName = sess ? sess.name : sessionId;
      const group = c.groups.find(g => g.id === groupId);
      const groupName = group ? group.name : groupId;
      const delegateStudent = c.students.find(s => s.id === delegateId);
      const delegateName = delegateStudent ? delegateStudent.name : delegateId;

      if (allow) {
        await db.prepare(`
          INSERT OR REPLACE INTO attendance_delegates (course_id, session_id, group_id, delegate_id, delegate_name, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(c.id, sessionId, groupId, delegateId, delegateName, Date.now()).run();
        invalidateStateCache();
        await addLog(db, c.id, '老師', 'attendance-delegate', `於「${sessName}」指派 ${delegateName} (${delegateId}) 代理【${groupName}】點名`);
      } else {
        await db.prepare('DELETE FROM attendance_delegates WHERE course_id = ? AND session_id = ? AND group_id = ? AND delegate_id = ?')
          .bind(c.id, sessionId, groupId, delegateId).run();
        invalidateStateCache();
        await addLog(db, c.id, '老師', 'attendance-delegate', `於「${sessName}」撤銷 ${delegateName} 代理【${groupName}】點名`);
      }
      return ok();
    }

    if (op === 'change-student-password') {
      const c = course(body.courseId);
      if (!c) return bad('課程不存在', 404);
      const student = c.students.find(s => s.id === body.studentId);
      if (!student) return bad('學生不存在', 404);

      if (body.resetToDefault) {
        await db.prepare('UPDATE students SET password_hash = \'\' WHERE course_id = ? AND id = ?')
          .bind(c.id, student.id).run();
        invalidateStateCache();
        await addLog(db, c.id, '老師', 'password-reset', `將幹部 ${student.name} (${student.id}) 密碼重設為預設學號`);
      } else {
        const next = String(body.next || '');
        if (next.length < 4) return bad('密碼至少需 4 碼', 400);
        const hashed = await sha256(next);
        await db.prepare('UPDATE students SET password_hash = ? WHERE course_id = ? AND id = ?')
          .bind(hashed, c.id, student.id).run();
        invalidateStateCache();
        await addLog(db, c.id, '老師', 'password-reset', `為幹部 ${student.name} (${student.id}) 指派新密碼`);
      }
      return ok();
    }

    return bad('未知操作 Unknown action: ' + op, 400);
  }

  /* ---- 學生（組長） ---- */
  if (!session || session.role !== 'student') return bad('請先登入 Sign in first', 401);
  const c = course(session.courseId);
  if (!c) return bad('課程不存在', 404);
  const self = c.students.find(s => s.id === session.id);
  if (!self) return bad('學生不存在', 404);

  const myGroup = self.groupId ? c.groups.find(g => g.id === self.groupId) : null;
  const canEdit = canGroupLeaderEdit(c, myGroup);

  if (action === 'claim-leader') {
    if (deadlinePassed(c)) return bad('已超過分組截止時間，無法再登記為組長 Deadline passed', 403);
    let gid = self.groupId;
    let groupName = '';
    if (!gid) {
      const empty = c.groups.find(g => !membersOf(c, g.id).length);
      if (empty) {
        gid = empty.id;
        groupName = empty.name;
      } else {
        const nextNum = getNextAvailableGroupNumbers(c.groups, 1)[0];
        gid = 'g' + Date.now().toString(36);
        groupName = '第 ' + nextNum + ' 組';
        const seq = await nextSeq(db, 'groups', c.id);
        await db.prepare('INSERT INTO groups (id, course_id, name, seq) VALUES (?,?,?,?)')
          .bind(gid, c.id, groupName, seq).run();
      }
    } else {
      const g = c.groups.find(x => x.id === gid);
      groupName = g ? g.name : '該組';
    }
    if (membersOf(c, gid).some(m => m.isLeader && m.id !== self.id)) return bad('本組已有組長 This group already has a leader', 409);
    await db.prepare('UPDATE students SET group_id=?, is_leader=1, is_vice=0, auto_assigned=0 WHERE course_id=? AND id=?')
      .bind(gid, c.id, self.id).run();
    await addLog(db, c.id, `組長 ${self.name} (${self.id})`, 'claim-leader', `登記擔任 ${groupName} 組長`);
    return ok();
  }
  if (action === 'unclaim-leader') {
    if (!canEdit) return bad('已超過分組截止時間，無法取消組長身分 Deadline passed', 403);
    const vice = membersOf(c, self.groupId).find(m => m.isVice && m.id !== self.id);
    const groupName = myGroup ? myGroup.name : '該組';
    if (vice) {
      // 副組長自動晉級組長，原組長退為一般組員
      await db.batch([
        db.prepare('UPDATE students SET is_leader=0 WHERE course_id=? AND id=?').bind(c.id, self.id),
        db.prepare('UPDATE students SET is_leader=1, is_vice=0 WHERE course_id=? AND id=?').bind(c.id, vice.id),
      ]);
      await addLog(db, c.id, `組長 ${self.name} (${self.id})`, 'unclaim-leader', `取消 ${groupName} 組長身分，由副組長 ${vice.name} (${vice.id}) 晉任為組長`);
    } else {
      await db.prepare('UPDATE students SET is_leader=0 WHERE course_id=? AND id=?').bind(c.id, self.id).run();
      await addLog(db, c.id, `組長 ${self.name} (${self.id})`, 'unclaim-leader', `取消 ${groupName} 組長身分，退回為一般組員`);
    }
    return ok();
  }
  if (action === 'submit-peer-eval') {
    if (!self.isLeader) return bad('僅組長可進行評分 Leader only', 403);
    if (!myGroup) return bad('尚未加入組別', 400);
    if (!myGroup.peerEvalOpen) return bad('老師尚未開放本組組長評分權限 Peer evaluation is not open', 403);
    if (evalDeadlinePassed(myGroup)) return bad('組長評分截止時間已過，無法再提交評分 Deadline passed', 403);

    const evaluations = Array.isArray(body.evaluations) ? body.evaluations : [];
    const stmts = [];
    for (const ev of evaluations) {
      const target = await resolveStudent(db, env, c, ev.studentId);
      if (!target || target.groupId !== self.groupId || target.id === self.id) continue;
      const bonus = Math.max(0, Math.min(10, parseInt(ev.penalty) || 0));
      const comment = String(ev.comment || '').trim().slice(0, 100);
      stmts.push(db.prepare('UPDATE students SET peer_penalty=?, peer_comment=? WHERE course_id=? AND id=?')
        .bind(bonus, comment, c.id, target.id));
    }
    // 標記該組組長已完成送出評分
    stmts.push(db.prepare('UPDATE groups SET peer_eval_submitted=1 WHERE course_id=? AND id=?')
      .bind(c.id, self.groupId));
    if (stmts.length) await db.batch(stmts);
    const groupName = myGroup ? myGroup.name : '本組';
    await addLog(db, c.id, `組長 ${self.name} (${self.id})`, 'submit-peer-eval', `提交了 ${groupName} 的期末互評成績（共評定 ${evaluations.length} 位組員）`);
    return ok();
  }
  if (!self.isLeader) return bad('僅組長可操作 Leader only', 403);
  if (!canEdit) return bad('已超過分組截止時間，組長不得更換組員（需由老師個別開放權限或手動調整）Deadline passed', 403);

  if (action === 'pick') {
    const t = await resolveStudent(db, env, c, body.studentId);
    if (!t) return bad('學生不存在', 404);
    if (t.groupId) return bad('該生已被分組 Already assigned', 409);
    if (membersOf(c, self.groupId).length >= cap(c)) return bad(`本組已達上限 ${cap(c)} 人`, 409);
    await db.prepare('UPDATE students SET group_id=?, auto_assigned=0 WHERE course_id=? AND id=?')
      .bind(self.groupId, c.id, t.id).run();
    const groupName = myGroup ? myGroup.name : '本組';
    await addLog(db, c.id, `組長 ${self.name} (${self.id})`, 'pick', `將組員 ${t.name} (${t.id}) 加入 ${groupName}`);
    return ok();
  }
  if (action === 'drop') {
    const t = await resolveStudent(db, env, c, body.studentId);
    if (!t || t.groupId !== self.groupId || t.id === self.id) return bad('無法移出該學生', 400);
    await db.prepare('UPDATE students SET group_id=NULL, is_vice=0, auto_assigned=0 WHERE course_id=? AND id=?')
      .bind(c.id, t.id).run();
    const groupName = myGroup ? myGroup.name : '本組';
    await addLog(db, c.id, `組長 ${self.name} (${self.id})`, 'drop', `將組員 ${t.name} (${t.id}) 從 ${groupName} 釋出`);
    return ok();
  }
  if (action === 'toggle-vice') {
    const t = await resolveStudent(db, env, c, body.studentId);
    if (!t || t.groupId !== self.groupId || t.id === self.id) return bad('無法指定該學生', 400);
    const on = t.isVice ? 0 : 1;
    await db.batch([
      db.prepare('UPDATE students SET is_vice=0 WHERE course_id=? AND group_id=?').bind(c.id, self.groupId),
      db.prepare('UPDATE students SET is_vice=? WHERE course_id=? AND id=?').bind(on, c.id, t.id),
    ]);
    const groupName = myGroup ? myGroup.name : '本組';
    await addLog(db, c.id, `組長 ${self.name} (${self.id})`, 'toggle-vice', `將組員 ${t.name} (${t.id}) ${on ? '指定為' : '解除'} ${groupName} 副組長`);
    return ok();
  }
  if (action === 'change-student-password') {
    if (!self.isLeader && !self.isVice) return bad('僅組長或副組長可修改個人密碼 Leader or vice leader only', 403);
    const curPw = String(body.current || '');
    const nextPw = String(body.next || '');
    if (nextPw.length < 4) return bad('新密碼長度至少需 4 碼 Password at least 4 chars', 400);

    if (self.passwordHash) {
      if (await sha256(curPw) !== self.passwordHash) return bad('目前密碼錯誤 Incorrect current password', 401);
    } else {
      if (curPw !== self.id) return bad('目前密碼錯誤（預設為學號）Incorrect current password', 401);
    }

    const newHash = await sha256(nextPw);
    await db.prepare('UPDATE students SET password_hash = ? WHERE course_id = ? AND id = ?')
      .bind(newHash, c.id, self.id).run();
    invalidateStateCache();
    const roleLabel = self.isLeader ? '組長' : '副組長';
    await addLog(db, c.id, `${roleLabel} ${self.name} (${self.id})`, 'change-password', `${roleLabel} 自行更新了登入密碼`);
    return ok();
  }

  if (action === 'mark-attendance') {
    const { sessionId, groupId, records } = body;
    if (!sessionId || !groupId || !Array.isArray(records)) return bad('缺少必要點名參數 Missing params', 400);

    const now = Date.now();
    const today = todayDateStr();

    // 1. 驗證身分：操作者必須為組長、副組長，或被指派跨組代理
    let isDelegate = (c.attendanceDelegates || []).some(d =>
      d.sessionId === sessionId && d.groupId === groupId && d.delegateId === self.id
    );

    if (!isDelegate) {
      if (self.groupId !== groupId) return bad('您非該組成員，且未獲授權代理該組點名 Not authorized for this group', 403);
      if (!self.isLeader && !self.isVice) return bad('僅組長或副組長可執行點名 Leader or vice leader only', 403);
    }

    // 2. 檢驗時段與日常點名推導
    let sessionObj = (c.attendanceSessions || []).find(s => s.id === sessionId);
    if (!sessionObj && (sessionId === `daily-${today}` || sessionId === 'daily' || sessionId.startsWith('daily-'))) {
      const sessionDate = sessionId.startsWith('daily-') ? sessionId.slice(6) : today;
      sessionObj = {
        id: sessionId.startsWith('daily-') ? sessionId : `daily-${today}`,
        courseId: c.id,
        date: sessionDate,
        timeSlot: '',
        name: '一般日常點名',
        isDaily: true,
        createdAt: now,
      };
    }
    if (!sessionObj) return bad('點名時段不存在 Session not found', 404);

    // 3. 檢查時效性與補登解鎖
    if (!isDelegate) {
      if (!isAttendanceEditable(sessionObj, c.attendanceUnlocks || [], groupId)) {
        return bad('已超過當日，點名紀錄已鎖定，需老師開放補登權限 Locked, ask teacher to unlock', 403);
      }
    }

    // 4. 確保時段已持久化至 attendance_sessions (INSERT OR IGNORE)
    await db.prepare(`
      INSERT OR IGNORE INTO attendance_sessions (id, course_id, date, time_slot, name, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(sessionObj.id, c.id, sessionObj.date, sessionObj.timeSlot || '', sessionObj.name || '一般日常點名', sessionObj.createdAt || now).run();

    // 5. 比對現有紀錄以記錄雙時間戳與日誌
    const existingMap = new Map();
    (c.attendanceRecords || []).forEach(r => {
      if (r.sessionId === sessionObj.id && r.groupId === groupId) {
        existingMap.set(r.studentId, r);
      }
    });

    const stmts = [];
    const roleLabel = self.isLeader ? '組長' : (self.isVice ? '副組長' : '代理人');
    const delegateNote = isDelegate ? '（跨組代理）' : '';

    for (const rec of records) {
      const student = c.students.find(x => x.id === rec.studentId || x.ref === rec.studentId);
      if (!student || student.groupId !== groupId) continue;

      const status = rec.status === 'absent' ? 'absent' : 'present';
      const prior = existingMap.get(student.id);
      const createdAt = prior ? (prior.createdAt || now) : now;

      stmts.push(
        db.prepare(`
          INSERT OR REPLACE INTO attendance_records
          (course_id, session_id, student_id, group_id, status, marked_by_id, marked_by_name, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(c.id, sessionObj.id, student.id, groupId, status, self.id, self.name, createdAt, now)
      );

      // 異動日誌
      if (!prior) {
        const timeStr = new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
        const logId = 'log_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        stmts.push(
          db.prepare('INSERT INTO activity_logs (id, course_id, operator, action, details, created_at, time_str) VALUES (?,?,?,?,?,?,?)')
            .bind(
              logId,
              c.id,
              `${roleLabel} ${self.name} (${self.id})${delegateNote}`,
              'attendance-mark',
              `於「${sessionObj.name}」完成點名，標記 ${student.name} (${student.id}) 為「${status === 'absent' ? '缺席' : '出席'}」`,
              now,
              timeStr
            )
        );
      } else if (prior.status !== status) {
        const timeStr = new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
        const logId = 'log_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        stmts.push(
          db.prepare('INSERT INTO activity_logs (id, course_id, operator, action, details, created_at, time_str) VALUES (?,?,?,?,?,?,?)')
            .bind(
              logId,
              c.id,
              `${roleLabel} ${self.name} (${self.id})${delegateNote}`,
              'attendance-correct',
              `修正「${sessionObj.name}」點名，將 ${student.name} (${student.id}) 由「${prior.status === 'absent' ? '缺席' : '出席'}」改為「${status === 'absent' ? '缺席' : '出席'}」`,
              now,
              timeStr
            )
        );
      }
    }

    if (stmts.length) await db.batch(stmts);
    invalidateStateCache();
    return ok();
  }

  return bad('未知操作 Unknown action: ' + action, 400);
}
