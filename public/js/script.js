/* 學生分組程式 Student Grouping — 單頁前端，狀態存於 localStorage */
const APP_NAME = '學生分組系統';
const APP_VERSION = 'v2.5.0 (2026.09.22-1324)';   // 顯示於前台標題列（v2 = Cloudflare D1 共用資料）

const CURRENT_KEY = 'groupstu_current_course';   // 僅記住「目前檢視哪一門課」，其餘資料都在伺服器
const PREVIEW_KEY = 'groupstu_teacher_preview_mode'; // 記住老師切換之視角模式，重新整理不遺失
const POLL_MS = 15000;   // 輪詢延長為 15 秒，降低 D1 消耗

let state = {
  courses: [],
  session: null,
  currentId: localStorage.getItem(CURRENT_KEY) || null,
};
let loginMode = null;   // 前台登入區：null | 'student' | 'teacher'
let teacherView = 'course';   // 後台主區：'course' | 'settings' | 'eval' | 'logs'
let teacherPreviewMode = localStorage.getItem(PREVIEW_KEY) || 'admin';  // 老師預覽模式：'admin' | 'public' | 'leader'
let busy = false;
let lastSig = '';
let courseLogsCache = {};   // 依課程快取異動日誌：{ [courseId]: logsArray }
let logsLoading = false;    // 日誌讀取中狀態

/* 按需載入課程異動日誌 */
async function loadLogsForCourse(courseId, force = false) {
  if (!courseId) return;
  if (!force && courseLogsCache[courseId]) return;
  logsLoading = true;
  render();
  try {
    const res = await apiPost('teacher:get-logs', { courseId });
    if (res && res.ok && Array.isArray(res.logs)) {
      courseLogsCache[courseId] = res.logs;
    }
  } catch (err) {
    console.error('載入日誌失敗:', err);
  } finally {
    logsLoading = false;
    render();
  }
}

/* ===== API ===== */
async function apiGet() {
  const r = await fetch('/api/state', { credentials: 'same-origin', headers: { 'cache-control': 'no-cache' } });
  if (!r.ok) throw new Error('讀取資料失敗 (' + r.status + ')');
  return r.json();
}

async function apiPost(action, payload = {}) {
  const r = await fetch('/api/action', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ('操作失敗 (' + r.status + ')'));
  return data;
}

/* 套用伺服器回傳的資料 */
function apply(data) {
  if (data.courses) state.courses = data.courses;
  if (data.session !== undefined) state.session = data.session;
  if (data.version) state.version = data.version;
  if (state.session && state.session.role === 'student') state.currentId = state.session.courseId;
  if (!state.courses.some(c => c.id === state.currentId)) {
    state.currentId = state.courses.length ? state.courses[0].id : null;
  }
  if (state.currentId) localStorage.setItem(CURRENT_KEY, state.currentId);
  lastSig = JSON.stringify(data.courses || []);
}

/* 送出一個動作，成功後重繪 */
async function act(action, payload = {}, opts = {}) {
  if (busy) return null;
  busy = true;
  try {
    const data = await apiPost(action, payload);
    apply(data);
    if (opts.after) opts.after(data);
    render();
    return data;
  } catch (err) {
    alert(err.message);
    return null;
  } finally {
    busy = false;
  }
}

/* 背景輪詢：其他人的異動會自動出現 */
async function poll() {
  if (busy || document.hidden) return;
  try {
    const data = await apiGet();
    const sig = JSON.stringify(data.courses || []);
    const sessionChanged = JSON.stringify(data.session || null) !== JSON.stringify(state.session || null);
    if (sig !== lastSig || sessionChanged) { apply(data); render(); }
  } catch (e) { /* 網路暫時失敗就略過這輪 */ }
}

/* ===== Course helpers ===== */
const courseById = id => state.courses.find(c => c.id === id) || null;
function cur() {   // 目前檢視中的課程
  if (state.session && state.session.role === 'student') return courseById(state.session.courseId);
  return courseById(state.currentId);
}
const courseLabel = c => [c.year, c.subject].filter(Boolean).join(' · ') || '（未命名課程）';

/* ===== Helpers（皆以某課程為範圍） ===== */
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cap = c => Number(c.groupSize) + Number(c.tolerance);
const minCap = c => Math.max(1, Number(c.groupSize) - Number(c.tolerance));
const rank = s => s.isLeader ? 0 : s.isVice ? 1 : 2;
/* 組長排最前、副組長次之，其餘維持名單順序 */
const members = (c, gid) => c.students.filter(s => s.groupId === gid)
  .map((s, i) => ({ s, i }))
  .sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i)
  .map(x => x.s);
const unassigned = c => c.students.filter(s => !s.groupId);
const findStudent = (c, id) => c.students.find(s => s.id === id || s.ref === id);
const keyOf = s => s.ref || s.id;   // 送給後端的識別碼
const leaderOf = (c, gid) => members(c, gid).find(s => s.isLeader);
function me() {
  const c = cur();
  if (!c) return null;
  if (state.session && state.session.role === 'student') return findStudent(c, state.session.id);
  // 若老師處於組長預覽模式，模擬當前課程的第一位組長或成員
  if (state.session && state.session.role === 'teacher' && teacherPreviewMode === 'leader') {
    const lead = c.students.find(s => s.isLeader && s.groupId);
    if (lead) return lead;
    // 若尚未有組長，則找任一有組別的學生或第一位學生模擬
    const anyStudent = c.students.find(s => s.groupId) || c.students[0];
    if (anyStudent) return { ...anyStudent, isLeader: true };
    return { id: 'preview-lead', name: '預覽組長(測試)', isLeader: true, groupId: c.groups[0]?.id || null };
  }
  return null;
}
const teacherPasswordHint = '預設 teacher123，可於後台修改';

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const deadlinePassed = c => !!c.deadline && Date.now() > new Date(c.deadline).getTime();
const evalDeadlinePassed = g => !!g.peerEvalDeadline && Date.now() > new Date(g.peerEvalDeadline).getTime();
const editDeadlinePassed = g => !!g.editDeadline && Date.now() > new Date(g.editDeadline).getTime();
function canGroupLeaderEdit(c, g) {
  if (!c) return false;
  if (!deadlinePassed(c)) return true;
  if (!g || !g.allowEdit) return false;
  if (g.editDeadline && editDeadlinePassed(g)) return false;
  return true;
}

/* 計算每位同學的期末考調分 */
function calcAdjustment(c, g, s) {
  if (s.adjustment) return s.adjustment;
  if (!s.groupId || !g) return { score: 0, tag: '未分組', reason: '尚未加入組別，無期末考調分', status: 'none' };
  const lead = c.students.find(x => x.groupId === g.id && x.isLeader);

  if (!lead) {
    return { score: -10, tag: '-10分', reason: '超過分組截止時間無組長，全員期末考扣 10 分', status: 'no-leader' };
  }

  const isEvalOpen = !!g.peerEvalOpen;
  const isSubmitted = !!g.peerEvalSubmitted;
  const isOverdue = isEvalOpen && evalDeadlinePassed(g) && !isSubmitted;

  if (isSubmitted) {
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
    if (s.isLeader) {
      return { score: 0, tag: '±0分', reason: '組長未於評分截止時間前進行評分，無法獲得 10 分加分', status: 'leader-overdue' };
    } else {
      return { score: 0, tag: '±0分', reason: '組長逾時未進行評分，組員無法獲得加分', status: 'member-overdue' };
    }
  }

  if (isEvalOpen) {
    if (s.isLeader) {
      return { score: 0, tag: '評分中', reason: '組長評分進行中（完成評分後組長自己可獲得 10 分加分）', status: 'leader-pending' };
    } else {
      return { score: 0, tag: '評分中', reason: '組長評分進行中（組長可依貢獻度給予 0~10 分加分）', status: 'member-pending' };
    }
  }

  if (s.isLeader) {
    return { score: 0, tag: '待開放', reason: '待老師開放評分權限並完成評分後，組長可獲得 10 分加分', status: 'leader-pending' };
  } else {
    return { score: 0, tag: '待開放', reason: '待老師開放評分權限後，組長可依貢獻度給予 0~10 分加分', status: 'member-pending' };
  }
}

function scoreBadge(adj) {
  if (!adj || adj.status === 'none') return '';
  const cls = adj.score > 0 ? 'positive' : adj.score < 0 ? 'negative' : 'neutral';
  return `<span class="score-pill ${cls}" title="${esc(adj.reason)}">期末 ${esc(adj.tag)}</span>`;
}

/* ===== 點名系統前端輔助演算法與狀態 ===== */
let activeAbsenceModal = null; // 當前彈出的缺席明細彈窗狀態
let publicAbsenceFilter = 'all'; // 一般前台缺席排行榜篩選：'all' | 'today'
let teacherAbsenceDate = ''; // 老師當日點名查看日期
let teacherAbsenceRange = 'all'; // 老師缺席排行榜範圍：'all' | 'today'
let teacherIncompleteSessionId = ''; // 老師未完成組別篩選時段

const todayDateStr = () => {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
};

function isDailySession(session) {
  if (!session) return false;
  if (session.isDaily) return true;
  if (session.id && String(session.id).startsWith('daily-')) return true;
  if (session.name === '一般日常點名' || session.name === '日常點名') return true;
  return false;
}

function attendanceUnlockFor(unlocks = [], sessionId, groupId) {
  const now = Date.now();
  return (unlocks || []).find(u =>
    u.sessionId === sessionId
    && (u.groupId === groupId || u.groupId === '')
    && (!u.deadline || new Date(u.deadline).getTime() > now)
  ) || null;
}

function isAttendanceEditable(session, unlocks = [], groupId = '') {
  if (!session) return false;
  if (session.date === todayDateStr()) return true;
  return !!attendanceUnlockFor(unlocks, session.id, groupId);
}

/**
 * 統計學生缺席次數
 */
function attendanceAbsentCounts(course, date = null, filterStudentIds = null) {
  if (!course) return {};
  const targetSessionIds = (course.attendanceSessions || [])
    .filter(s => !date || s.date === date)
    .map(s => s.id);

  const counts = {};
  const filterSet = filterStudentIds ? new Set(filterStudentIds) : null;

  (course.attendanceRecords || []).forEach(r => {
    if (r.status !== 'absent') return;
    if (targetSessionIds.length && !targetSessionIds.includes(r.sessionId)) return;
    const studentKey = r.studentId;
    if (!studentKey) return;
    if (filterSet && !filterSet.has(studentKey)) return;
    counts[studentKey] = (counts[studentKey] || 0) + 1;
  });

  return counts;
}

/**
 * 取得特定學生的所有缺席活動歷程明細
 */
function getStudentAbsenceList(course, studentId, date = null) {
  if (!course) return [];
  const sessions = course.attendanceSessions || [];
  const sessionMap = new Map(sessions.map(s => [s.id, s]));

  const list = [];
  (course.attendanceRecords || []).forEach(r => {
    if (r.status !== 'absent' || r.studentId !== studentId) return;
    const session = sessionMap.get(r.sessionId) || {
      id: r.sessionId,
      date: r.sessionId.startsWith('daily-') ? r.sessionId.slice(6) : '',
      name: r.sessionId.startsWith('daily-') ? '一般日常點名' : '重要集會點名',
      isDaily: r.sessionId.startsWith('daily-'),
    };
    if (date && session.date !== date) return;

    const isDaily = isDailySession(session);
    const activityName = isDaily
      ? '一般日常點名 Daily Attendance'
      : (session.name || '重要集會 Special Session');
    const timeSlotStr = session.timeSlot ? `（${session.timeSlot}）` : '';

    list.push({
      sessionId: session.id,
      date: session.date || todayDateStr(),
      activityName: `${activityName}${timeSlotStr}`,
      isDaily,
      updatedAt: r.updatedAt || r.createdAt || 0,
      markedByName: r.markedByName || '',
    });
  });

  return list.sort((a, b) => b.date.localeCompare(a.date) || (b.updatedAt - a.updatedAt));
}

/**
 * 缺席明細互動彈窗 (Modal Dialog)
 */
function renderAbsenceModalHtml(modalState) {
  if (!modalState) return '';
  const { studentName, studentId, details } = modalState;

  return `
  <div class="absence-modal-overlay" data-act="close-absence-modal-bg">
    <div class="absence-modal-content" onclick="event.stopPropagation()">
      <div class="absence-modal-header">
        <h3><span>📋</span> 缺席明細 Absence Details</h3>
        <button class="absence-modal-close-btn" type="button" data-act="close-absence-modal">✕</button>
      </div>
      <div class="absence-modal-body">
        <div class="absence-modal-summary">
          <div>
            <strong style="font-size:1.1rem;color:var(--text);">${esc(studentName)}</strong>
            <span class="text-muted" style="margin-left:0.4rem;font-size:0.9rem;">(${esc(studentId)})</span>
          </div>
          <span class="absence-total-pill">共計缺席 ${details.length} 次</span>
        </div>
        ${details.length ? `
          <div class="absence-detail-list">
            ${details.map(d => `
              <div class="absence-detail-item">
                <span class="absence-detail-date">📅 ${esc(d.date)}</span>
                <div class="absence-detail-info">
                  <div class="absence-detail-name">${esc(d.activityName)}</div>
                  <div class="absence-detail-sub">
                    <span class="absence-detail-tag ${d.isDaily ? 'daily' : 'special'}">
                      ${d.isDaily ? '日常點名 Daily' : '重要集會 Special'}
                    </span>
                    ${d.markedByName ? `<span class="marked-by">點名幹部：${esc(d.markedByName)}</span>` : ''}
                  </div>
                </div>
              </div>
            `).join('')}
          </div>
        ` : '<p style="color:var(--accent);font-weight:600;margin:1rem 0;">✅ 該學生目前無任何缺席紀錄 No absence records.</p>'}
      </div>
      <div class="absence-modal-footer">
        <button class="btn btn-secondary" type="button" data-act="close-absence-modal">關閉 Close</button>
      </div>
    </div>
  </div>`;
}

/**
 * 前台缺席排行榜卡片 (全班前 15 名 · 個資遮罩)
 */
function renderPublicAbsenceCard(c) {
  if (!c || !c.students.length) return '';
  const isToday = publicAbsenceFilter === 'today';
  const today = todayDateStr();
  const counts = attendanceAbsentCounts(c, isToday ? today : null);

  const absentList = c.students
    .map(s => ({
      student: s,
      count: counts[s.id] || 0,
      group: c.groups.find(g => g.id === s.groupId),
    }))
    .filter(x => x.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  return `
  <section class="block-section public-absence-card" style="margin-top:2rem;">
    <div class="panel-header" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.75rem;">
      <h3 style="margin:0;display:flex;align-items:center;gap:0.4rem;">
        <span>🏆</span> 出勤缺席排行榜 Absence Leaderboard <small style="font-weight:normal;color:var(--text-muted);">（前 15 名 · 個資保護遮罩）</small>
      </h3>
      <div class="pill-group">
        <button class="pill-tab ${!isToday ? 'active' : ''}" data-act="filter-public-absence" data-filter="all">全學期累計</button>
        <button class="pill-tab ${isToday ? 'active' : ''}" data-act="filter-public-absence" data-filter="today">今日缺席</button>
      </div>
    </div>
    <div style="margin-top:0.75rem;">
      ${absentList.length ? `
        <div class="table-wrap">
          <table class="roster" style="width:100%;">
            <thead>
              <tr>
                <th style="width:60px;text-align:center;">排名</th>
                <th>學生姓名 Name</th>
                <th>學號 Student ID</th>
                <th>所屬組別 Group</th>
                <th style="text-align:center;">缺席次數 Absences</th>
              </tr>
            </thead>
            <tbody>
              ${absentList.map((item, idx) => `
                <tr>
                  <td style="text-align:center;">
                    <span class="rank-badge ${idx < 3 ? 'top3' : ''}">${idx + 1}</span>
                  </td>
                  <td><b>${esc(item.student.name)}</b></td>
                  <td><code>${esc(item.student.id)}</code></td>
                  <td>${item.group ? esc(item.group.name) : '<span class="text-muted">未分組</span>'}</td>
                  <td style="text-align:center;">
                    <button class="absence-badge-btn" data-act="view-absence-detail" data-id="${esc(item.student.id)}" data-name="${esc(item.student.name)}" title="點擊檢視歷次缺席明細">
                      ⚠️ ${item.count} 次缺席
                    </button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : `
        <div style="padding:1.2rem;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;color:#166534;display:flex;align-items:center;gap:0.5rem;">
          <span>✅</span>
          <span><b>出席表現良好：</b>${isToday ? '今日全班無任何缺席紀錄！' : '全班學生目前無任何缺席紀錄！'}</span>
        </div>
      `}
    </div>
  </section>`;
}

/**
 * 組長與副組長點名專屬面板
 */
function renderLeaderAttendancePanel(c, s, g, mates) {
  if (!c) return '';
  const today = todayDateStr();
  const unlocks = c.attendanceUnlocks || [];
  const records = c.attendanceRecords || [];
  const sessions = c.attendanceSessions || [];
  const delegates = c.attendanceDelegates || [];

  const isLeaderOrVice = s.isLeader || s.isVice;
  const myDelegations = delegates.filter(d => d.delegateId === s.id);

  if (!isLeaderOrVice && !myDelegations.length) return '';

  let html = `
  <div class="attendance-section" style="margin-top:2rem;">
    <div class="block-header">
      <div class="block-title-wrap">
        <span class="step-badge" style="background:#0284c7;color:#fff;">點名</span>
        <h2 style="margin:0;">📋 點名面板 Attendance（Điểm danh）</h2>
      </div>
      <span class="file-path" style="margin:0;">組長／副組長可於當天直接進行日常點名；特殊集會可於下方進行額外點名。</span>
    </div>`;

  // 1. 今日一般日常點名 Daily Attendance (藍色卡片)
  if (g && isLeaderOrVice) {
    const dailySessId = `daily-${today}`;
    const dailyRecords = records.filter(r => r.sessionId === dailySessId && r.groupId === g.id);
    const recMap = new Map(dailyRecords.map(r => [r.studentId, r.status]));
    const checkedCount = mates.filter(m => recMap.has(m.id)).length;
    const isCompleted = mates.length > 0 && checkedCount === mates.length;

    html += `
    <div class="attendance-card daily" style="margin-top:1rem;">
      <div class="panel-header" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;">
        <div>
          <h3 style="margin:0;color:#0369a1;">📅 【今日一般日常點名 Daily Attendance】</h3>
          <span style="font-size:0.85rem;color:#0284c7;">日期 Date：<b>${today}</b>（系統自動識別，免老師預建時段）</span>
        </div>
        <div>
          ${isCompleted
            ? `<span class="status-badge meets-threshold">✅ 今日點名已完成 (${checkedCount}/${mates.length})</span>`
            : checkedCount > 0
            ? `<span class="status-badge under-threshold">⚠️ 點名進行中 (${checkedCount}/${mates.length})</span>`
            : `<span class="status-badge is-locked">⏳ 今日尚未點名 (0/${mates.length})</span>`}
        </div>
      </div>
      <div style="margin:0.75rem 0;font-size:0.88rem;color:#334155;">
        💡 <b>防弊說明：</b>本系統無「一鍵全員到齊」按鈕，請逐一為每位組員單獨確認出缺席後送出。
      </div>
      <form data-act="mark-attendance" data-session="${dailySessId}" data-group="${g.id}">
        <div class="table-wrap">
          <table class="roster" style="width:100%;">
            <thead>
              <tr>
                <th>組員 Member</th>
                <th>身分 Role</th>
                <th style="text-align:center;">出缺席狀態 Attendance Status（逐一單選確認）</th>
              </tr>
            </thead>
            <tbody>
              ${mates.map(m => {
                const curVal = recMap.get(m.id) || '';
                return `
                <tr>
                  <td><b>${esc(m.name)}</b> <small>(${esc(m.id)})</small></td>
                  <td>${m.isLeader ? '👑 組長 Leader' : m.isVice ? '⭐ 副組長 Vice' : '組員 Member'}</td>
                  <td style="text-align:center;">
                    <div class="att-radio-group">
                      <label class="att-radio-pill ${curVal === 'present' ? 'checked-present' : ''}">
                        <input type="radio" name="att_${esc(m.id)}" value="present" ${curVal === 'present' ? 'checked' : ''}>
                        <span>✅ 出席 Present</span>
                      </label>
                      <label class="att-radio-pill ${curVal === 'absent' ? 'checked-absent' : ''}">
                        <input type="radio" name="att_${esc(m.id)}" value="absent" ${curVal === 'absent' ? 'checked' : ''}>
                        <span>❌ 缺席 Absent</span>
                      </label>
                    </div>
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
        <div style="margin-top:1rem;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.75rem;">
          <button class="btn btn-primary" type="submit" style="padding:0.5rem 1.4rem;">
            ${isCompleted ? '🔄 重新更新今日日常點名 Update Daily Attendance' : '📋 送出今日日常點名 Submit Daily Attendance'}
          </button>
          <span style="font-size:0.82rem;color:var(--text-muted);">
            當日課堂內組長可隨時重新更新修正；午夜過後系統將自動強制鎖定。
          </span>
        </div>
      </form>
    </div>`;
  }

  // 2. 重要集會與額外點名 Special Sessions (橙色卡片)
  const specialSessions = sessions.filter(sess => !sess.isDaily);
  if (g && specialSessions.length > 0 && isLeaderOrVice) {
    html += `
    <div class="attendance-card special" style="margin-top:1.5rem;">
      <div class="panel-header">
        <h3 style="margin:0;color:#c2410c;">📌 【重要集會與額外點名 Special Sessions】</h3>
        <span style="font-size:0.85rem;color:#ea580c;">授課教師開設之重要專題展、系週會或成果發表點名時段</span>
      </div>
      <div style="margin-top:1rem;display:flex;flex-direction:column;gap:1.25rem;">
        ${specialSessions.map(sess => {
          const editable = isAttendanceEditable(sess, unlocks, g.id);
          const sessRecords = records.filter(r => r.sessionId === sess.id && r.groupId === g.id);
          const sessRecMap = new Map(sessRecords.map(r => [r.studentId, r.status]));
          const sChecked = mates.filter(m => sessRecMap.has(m.id)).length;
          const sCompleted = mates.length > 0 && sChecked === mates.length;

          return `
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:1rem;">
            <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;margin-bottom:0.75rem;">
              <div>
                <strong style="font-size:1.05rem;color:var(--text);">${esc(sess.name)}</strong>
                <span class="text-muted" style="margin-left:0.5rem;">📅 ${esc(sess.date)}${sess.timeSlot ? ' · ' + esc(sess.timeSlot) : ''}</span>
              </div>
              <div style="display:flex;align-items:center;gap:0.5rem;">
                ${sCompleted
                  ? `<span class="status-badge meets-threshold">✅ 已完成點名 (${sChecked}/${mates.length})</span>`
                  : sChecked > 0
                  ? `<span class="status-badge under-threshold">⚠️ 點名中 (${sChecked}/${mates.length})</span>`
                  : `<span class="status-badge is-locked">⏳ 尚未點名</span>`}
                ${editable
                  ? '<span class="status-badge can-edit">可編輯 Open</span>'
                  : '<span class="status-badge is-locked">🔒 已鎖定 Locked</span>'}
              </div>
            </div>
            ${editable ? `
              <form data-act="mark-attendance" data-session="${sess.id}" data-group="${g.id}">
                <div class="table-wrap">
                  <table class="roster" style="width:100%;">
                    <thead><tr><th>組員 Member</th><th style="text-align:center;">出缺席狀態 Attendance</th></tr></thead>
                    <tbody>
                      ${mates.map(m => {
                        const curVal = sessRecMap.get(m.id) || '';
                        return `
                        <tr>
                          <td><b>${esc(m.name)}</b> <small>(${esc(m.id)})</small></td>
                          <td style="text-align:center;">
                            <div class="att-radio-group">
                              <label class="att-radio-pill ${curVal === 'present' ? 'checked-present' : ''}">
                                <input type="radio" name="att_${esc(m.id)}" value="present" ${curVal === 'present' ? 'checked' : ''}>
                                <span>✅ 出席 Present</span>
                              </label>
                              <label class="att-radio-pill ${curVal === 'absent' ? 'checked-absent' : ''}">
                                <input type="radio" name="att_${esc(m.id)}" value="absent" ${curVal === 'absent' ? 'checked' : ''}>
                                <span>❌ 缺席 Absent</span>
                              </label>
                            </div>
                          </td>
                        </tr>`;
                      }).join('')}
                    </tbody>
                  </table>
                </div>
                <div style="margin-top:0.85rem;">
                  <button class="btn btn-primary" type="submit">
                    ${sCompleted ? '🔄 重新更新點名 Update' : '📋 送出本時段點名 Submit'}
                  </button>
                </div>
              </form>
            ` : `
              <p class="file-path" style="margin:0;color:#94a3b8;">
                此時段非今日且尚未獲得老師開放補登權限。如需補點名請聯絡老師開放補登。
              </p>
            `}
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }

  // 3. 跨組代理點名專區 Cross-Group Delegation (紫色卡片)
  if (myDelegations.length > 0) {
    html += `
    <div class="attendance-card delegated" style="margin-top:1.5rem;">
      <div class="panel-header">
        <h3 style="margin:0;color:#7e22ce;">🔁 【跨組代理點名 Cross-group Delegate】</h3>
        <span style="font-size:0.85rem;color:#9333ea;">因他組幹部缺席未到，老師已特別授權您代理點名（Điểm danh hộ nhóm khác）</span>
      </div>
      <div style="margin-top:1rem;display:flex;flex-direction:column;gap:1.25rem;">
        ${myDelegations.map(del => {
          const targetGroup = c.groups.find(x => x.id === del.groupId);
          const targetMates = targetGroup ? members(c, targetGroup.id) : [];
          const sess = sessions.find(x => x.id === del.sessionId) || { id: del.sessionId, name: '日常點名' };
          const delRecords = records.filter(r => r.sessionId === del.sessionId && r.groupId === del.groupId);
          const delRecMap = new Map(delRecords.map(r => [r.studentId, r.status]));
          const dChecked = targetMates.filter(m => delRecMap.has(m.id)).length;
          const dCompleted = targetMates.length > 0 && dChecked === targetMates.length;

          return `
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:1rem;">
            <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;margin-bottom:0.75rem;">
              <div>
                <strong style="font-size:1.05rem;color:#7e22ce;">代理組別：${targetGroup ? esc(targetGroup.name) : del.groupId}</strong>
                <span class="text-muted" style="margin-left:0.5rem;">時段：${esc(sess.name)}</span>
              </div>
              <div>
                ${dCompleted
                  ? `<span class="status-badge meets-threshold">✅ 代理點名已完成 (${dChecked}/${targetMates.length})</span>`
                  : `<span class="status-badge under-threshold">⚠️ 代理點名進行中 (${dChecked}/${targetMates.length})</span>`}
              </div>
            </div>
            <form data-act="mark-attendance" data-session="${del.sessionId}" data-group="${del.groupId}">
              <div class="table-wrap">
                <table class="roster" style="width:100%;">
                  <thead><tr><th>該組組員 Member</th><th style="text-align:center;">出缺席狀態 Attendance</th></tr></thead>
                  <tbody>
                    ${targetMates.map(m => {
                      const curVal = delRecMap.get(m.id) || '';
                      return `
                      <tr>
                        <td><b>${esc(m.name)}</b> <small>(${esc(m.id)})</small>${m.isLeader ? ' (原組長)' : m.isVice ? ' (原副組長)' : ''}</td>
                        <td style="text-align:center;">
                          <div class="att-radio-group">
                            <label class="att-radio-pill ${curVal === 'present' ? 'checked-present' : ''}">
                              <input type="radio" name="att_${esc(m.id)}" value="present" ${curVal === 'present' ? 'checked' : ''}>
                              <span>✅ 出席 Present</span>
                            </label>
                            <label class="att-radio-pill ${curVal === 'absent' ? 'checked-absent' : ''}">
                              <input type="radio" name="att_${esc(m.id)}" value="absent" ${curVal === 'absent' ? 'checked' : ''}>
                              <span>❌ 缺席 Absent</span>
                            </label>
                          </div>
                        </td>
                      </tr>`;
                    }).join('')}
                  </tbody>
                </table>
              </div>
              <div style="margin-top:0.85rem;">
                <button class="btn btn-primary" type="submit" style="background:#7e22ce;border-color:#7e22ce;">
                  ${dCompleted ? '🔄 重新更新代理點名 Update Proxy Attendance' : '📋 送出代理點名 Submit Proxy Attendance'}
                </button>
              </div>
            </form>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }

  // 4. 本組組員缺席排行榜 (Leader View)
  if (g && mates.length > 0) {
    const groupAbsentCounts = attendanceAbsentCounts(c, null, mates.map(m => m.id));
    html += `
    <div class="attendance-card history" style="margin-top:1.5rem;">
      <div class="panel-header">
        <h3 style="margin:0;">📊 本組組員出勤與缺席統計 Group Absence Roster</h3>
        <span class="file-path" style="margin:0;">組長與副組長可掌握組員學習投入狀況，點擊次數可查看歷次缺席時段</span>
      </div>
      <div class="table-wrap" style="margin-top:0.75rem;">
        <table class="roster" style="width:100%;">
          <thead>
            <tr>
              <th>組員 Member</th>
              <th>身分 Role</th>
              <th style="text-align:center;">累計缺席次數</th>
            </tr>
          </thead>
          <tbody>
            ${mates.map(m => {
              const absCount = groupAbsentCounts[m.id] || 0;
              return `
              <tr>
                <td><b>${esc(m.name)}</b> <small>(${esc(m.id)})</small></td>
                <td>${m.isLeader ? '👑 組長' : m.isVice ? '⭐ 副組長' : '組員'}</td>
                <td style="text-align:center;">
                  ${absCount > 0 ? `
                    <button class="absence-badge-btn" data-act="view-absence-detail" data-id="${esc(m.id)}" data-name="${esc(m.name)}">
                      ⚠️ ${absCount} 次缺席
                    </button>
                  ` : '<span style="color:var(--accent);font-weight:600;">全勤 0 次</span>'}
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
  }

  html += '</div>';
  return html;
}

/**
 * 幹部自主密碼修改卡片
 */
function renderLeaderPasswordCard(s) {
  if (!s || (!s.isLeader && !s.isVice)) return '';
  return `
  <div class="leader-pw-card" style="margin-top:1.5rem;padding:1.25rem;background:var(--surface);border:1px solid var(--border);border-radius:10px;">
    <div class="panel-header" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;">
      <h3 style="margin:0;">🔐 幹部自主密碼管理 Officer Password</h3>
      <span class="tag-inline">${s.hasCustomPassword ? '🔐 已自訂密碼' : 'ℹ️ 目前為預設學號'}</span>
    </div>
    <p class="file-path" style="margin:0.4rem 0 0.8rem 0;">
      組長與副組長可自行設定登入密碼（預設為學號，至少 4 碼）。若忘記密碼可請老師在後台協助重設。
    </p>
    <form data-act="change-student-password" class="inline-form" style="display:flex;gap:0.75rem;flex-wrap:wrap;align-items:flex-end;">
      <div class="form-group" style="margin:0;">
        <label style="font-size:0.82rem;">目前密碼 Current</label>
        <input type="password" name="current" placeholder="預設為學號" required autocomplete="off" style="padding:0.4rem 0.6rem;">
      </div>
      <div class="form-group" style="margin:0;">
        <label style="font-size:0.82rem;">新密碼 New（至少 4 碼）</label>
        <input type="password" name="next" placeholder="請輸入新密碼" required minlength="4" autocomplete="off" style="padding:0.4rem 0.6rem;">
      </div>
      <button class="btn btn-secondary" type="submit" style="padding:0.45rem 1rem;font-size:0.88rem;">變更密碼 Update</button>
    </form>
  </div>`;
}

/**
 * 一般學生個人出缺席狀態查看卡片
 */
function renderStudentAbsencePersonalCard(c, s) {
  if (!s) return '';
  const myAbsences = getStudentAbsenceList(c, s.id);
  return `
  <div class="student-personal-absence-card" style="margin-top:1.5rem;padding:1.25rem;background:var(--surface);border:1px solid var(--border);border-radius:10px;">
    <div class="panel-header" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;">
      <h3 style="margin:0;">📋 個人出缺席狀況 My Attendance</h3>
      ${myAbsences.length > 0
        ? `<button class="absence-badge-btn" data-act="view-absence-detail" data-id="${esc(s.id)}" data-name="${esc(s.name)}">⚠️ 累計缺席 ${myAbsences.length} 次</button>`
        : `<span class="status-badge meets-threshold">✅ 本學期全勤 (0次缺席)</span>`}
    </div>
    <p class="file-path" style="margin:0.4rem 0 0 0;">
      出缺席由各組幹部於課堂點名。點擊上方缺席按鈕可檢視詳細缺席日期與活動紀錄。
    </p>
  </div>`;
}

/**
 * 老師後台 5 維度全方位點名監控儀表板 (Teacher Attendance Dashboard)
 */
function teacherAttendanceDashboard(c) {
  if (!c) {
    return `
    <div class="teacher-section">
      <h2>📝 點名管理儀表板 Attendance Dashboard</h2>
      <p class="file-path">請先從左側選擇或建立課程，即可檢視與管理該課程的點名作業。</p>
    </div>`;
  }

  const today = todayDateStr();
  const sessions = c.attendanceSessions || [];
  const records = c.attendanceRecords || [];
  const unlocks = c.attendanceUnlocks || [];
  const delegates = c.attendanceDelegates || [];

  const selectedDate = teacherAbsenceDate || today;

  // 所有幹部清單（供跨組代理下拉選單使用）
  const allOfficers = [];
  c.groups.forEach(g => {
    const gMembers = members(c, g.id);
    gMembers.forEach(m => {
      if (m.isLeader || m.isVice) {
        allOfficers.push({
          id: m.id,
          name: m.name,
          role: m.isLeader ? '組長' : '副組長',
          groupId: g.id,
          groupName: g.name,
        });
      }
    });
  });

  return `
  <div class="teacher-section">
    <div class="block-header">
      <div class="block-title-wrap">
        <h2>📝 點名管理與出勤監控儀表板 <small>Attendance Management</small></h2>
      </div>
    </div>
    <p class="file-path">本科目：<b>${esc(courseLabel(c))}</b> · 學生 ${c.students.length} 人 · ${c.groups.length} 組</p>

    <!-- 看板 1: 點名時段維護與補登解鎖 (Sessions & Unlock Control) -->
    <div class="dashboard-panel" style="margin-top:1.5rem;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:1.25rem;">
      <div class="panel-header" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.75rem;">
        <h3 style="margin:0;display:flex;align-items:center;gap:0.4rem;">
          <span>📅</span> [看板 1] 點名時段維護與補登解鎖 Sessions &amp; Unlock
        </h3>
        <button class="btn btn-primary" data-act="add-attendance-session-btn" style="padding:0.4rem 0.9rem;font-size:0.85rem;">
          ＋ 新增重要集會時段 Add Session
        </button>
      </div>
      <div class="info-alert" style="margin:0.75rem 0;padding:0.65rem 0.9rem;background:#e0f2fe;border:1px solid #bae6fd;border-radius:6px;font-size:0.85rem;color:#0369a1;">
        💡 <b>日常點名零設定：</b>系統已自動啟用當日日常點名（<code>daily-${today}</code>），組長登入即可開點，送出時自動持久化。若有成果發表會、系週會或補課，可於此新增獨立集會時段。
      </div>

      <div class="table-wrap" style="margin-top:0.75rem;">
        <table class="roster" style="width:100%;">
          <thead>
            <tr>
              <th>日期 Date</th>
              <th>時段名稱 Session Name</th>
              <th>類型 Type</th>
              <th>節次 Slot</th>
              <th>補登解鎖狀態 Unlock Status</th>
              <th style="text-align:right;">操作 Actions</th>
            </tr>
          </thead>
          <tbody>
            ${sessions.length ? sessions.map(sess => {
              const sessUnlocks = unlocks.filter(u => u.sessionId === sess.id);
              const allUnlocked = sessUnlocks.some(u => !u.groupId && (!u.deadline || new Date(u.deadline).getTime() > Date.now()));
              const groupUnlocks = sessUnlocks.filter(u => u.groupId && (!u.deadline || new Date(u.deadline).getTime() > Date.now()));

              return `
              <tr>
                <td><b>${esc(sess.date)}</b></td>
                <td>${esc(sess.name)}</td>
                <td><span class="absence-detail-tag ${sess.isDaily ? 'daily' : 'special'}">${sess.isDaily ? '日常點名' : '重要集會'}</span></td>
                <td>${esc(sess.timeSlot || '—')}</td>
                <td>
                  ${allUnlocked
                    ? '<span class="status-badge meets-threshold">🔓 全班補登中</span>'
                    : groupUnlocks.length
                    ? `<span class="status-badge under-threshold">🔓 已開放 ${groupUnlocks.length} 組補登</span>`
                    : '<span class="status-badge is-locked">🔒 鎖定</span>'}
                </td>
                <td style="text-align:right;">
                  <div style="display:inline-flex;gap:0.35rem;align-items:center;flex-wrap:wrap;justify-content:flex-end;">
                    ${allUnlocked ? `
                      <button class="tab-btn" data-act="lock-all-attendance" data-session="${sess.id}">🔒 關閉補登</button>
                    ` : `
                      <button class="tab-btn on" data-act="unlock-all-attendance" data-session="${sess.id}">🔓 開放全班補登</button>
                    `}
                    <select class="tab-btn" data-act="teacher-unlock-group-select" data-session="${sess.id}" style="padding:0.25rem 0.5rem;font-size:0.8rem;">
                      <option value="">指定組別補登...</option>
                      ${c.groups.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}
                    </select>
                    ${!sess.isDaily ? `
                      <button class="tab-btn" data-act="edit-attendance-session-btn" data-session="${sess.id}" data-name="${esc(sess.name)}" data-date="${esc(sess.date)}" data-slot="${esc(sess.timeSlot || '')}">✏️ 編輯</button>
                      <button class="tab-btn" data-act="del-attendance-session-btn" data-session="${sess.id}" style="color:#ef4444;">🗑️ 刪除</button>
                    ` : ''}
                  </div>
                </td>
              </tr>`;
            }).join('') : `
              <tr>
                <td colspan="6" style="text-align:center;color:var(--text-muted);padding:1rem;">
                  目前尚未有時段紀錄。當組長今日送出點名後，系統將自動在此建立今日日常點名紀錄。
                </td>
              </tr>
            `}
          </tbody>
        </table>
      </div>
    </div>

    <!-- 看板 2: 各組組長／副組長名冊與密碼管理 (Leaders & Passwords) -->
    <div class="dashboard-panel" style="margin-top:1.5rem;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:1.25rem;">
      <div class="panel-header">
        <h3 style="margin:0;display:flex;align-items:center;gap:0.4rem;">
          <span>🔑</span> [看板 2] 目前各組組長／副組長名冊與密碼管理 Leaders &amp; Passwords
        </h3>
        <span class="file-path" style="margin:0;">支援幹部密碼救援：若學生忘記密碼，老師可協助一鍵重設為學號或直接指派新密碼</span>
      </div>

      <div class="table-wrap" style="margin-top:0.75rem;">
        <table class="roster" style="width:100%;">
          <thead>
            <tr>
              <th>組別 Group</th>
              <th>組長 Leader</th>
              <th>副組長 Vice Leader</th>
              <th style="text-align:right;">幹部密碼維護 Actions</th>
            </tr>
          </thead>
          <tbody>
            ${c.groups.map(g => {
              const lead = members(c, g.id).find(m => m.isLeader);
              const vice = members(c, g.id).find(m => m.isVice);

              return `
              <tr>
                <td><b>${esc(g.name)}</b></td>
                <td>
                  ${lead ? `
                    <span>${esc(lead.name)} (${esc(lead.id)})</span>
                    ${lead.hasCustomPassword ? '<span class="tag-inline">🔐 自訂密碼</span>' : '<span class="tag-inline auto">ℹ️ 預設學號</span>'}
                  ` : '<span class="text-muted">（尚未指派組長）</span>'}
                </td>
                <td>
                  ${vice ? `
                    <span>${esc(vice.name)} (${esc(vice.id)})</span>
                    ${vice.hasCustomPassword ? '<span class="tag-inline">🔐 自訂密碼</span>' : '<span class="tag-inline auto">ℹ️ 預設學號</span>'}
                  ` : '<span class="text-muted">（無副組長）</span>'}
                </td>
                <td style="text-align:right;">
                  <div style="display:inline-flex;gap:0.35rem;flex-wrap:wrap;justify-content:flex-end;">
                    ${lead ? `
                      <button class="tab-btn" data-act="teacher-set-student-password" data-id="${lead.id}" data-name="${esc(lead.name)}">
                        ✏️ 設組長密碼
                      </button>
                      ${lead.hasCustomPassword ? `
                        <button class="tab-btn" data-act="teacher-reset-student-password" data-id="${lead.id}" data-name="${esc(lead.name)}">
                          🔄 重設組長為學號
                        </button>
                      ` : ''}
                    ` : ''}
                    ${vice ? `
                      <button class="tab-btn" data-act="teacher-set-student-password" data-id="${vice.id}" data-name="${esc(vice.name)}">
                        ✏️ 設副組長密碼
                      </button>
                      ${vice.hasCustomPassword ? `
                        <button class="tab-btn" data-act="teacher-reset-student-password" data-id="${vice.id}" data-name="${esc(vice.name)}">
                          🔄 重設副組長為學號
                        </button>
                      ` : ''}
                    ` : ''}
                  </div>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- 看板 3: 各組出缺席紀錄查看 (Daily Absence Roster) -->
    <div class="dashboard-panel" style="margin-top:1.5rem;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:1.25rem;">
      <div class="panel-header" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.75rem;">
        <h3 style="margin:0;display:flex;align-items:center;gap:0.4rem;">
          <span>📋</span> [看板 3] 各組當日出缺席名冊 Daily Absence Roster
        </h3>
        <div style="display:flex;align-items:center;gap:0.5rem;">
          <span style="font-size:0.85rem;color:var(--text-muted);">查詢日期：</span>
          <input type="date" value="${selectedDate}" data-act="pick-teacher-absence-date" style="padding:0.3rem 0.6rem;border:1px solid var(--border);border-radius:6px;font-size:0.85rem;">
        </div>
      </div>

      <div class="table-wrap" style="margin-top:0.75rem;">
        <table class="roster" style="width:100%;">
          <thead>
            <tr>
              <th>組別 Group</th>
              <th style="width:80px;text-align:center;">應到</th>
              <th style="width:80px;text-align:center;">實到</th>
              <th style="width:80px;text-align:center;">缺席</th>
              <th>出缺席組員明細 Status Breakdown</th>
            </tr>
          </thead>
          <tbody>
            ${c.groups.map(g => {
              const gMembers = members(c, g.id);
              const daySessIds = sessions.filter(s => s.date === selectedDate).map(s => s.id);
              if (selectedDate === today && !daySessIds.includes(`daily-${today}`)) {
                daySessIds.push(`daily-${today}`);
              }
              const gRecords = records.filter(r => r.groupId === g.id && daySessIds.includes(r.sessionId));
              const recMap = new Map(gRecords.map(r => [r.studentId, r]));

              const presentList = gMembers.filter(m => recMap.get(m.id)?.status === 'present');
              const absentList = gMembers.filter(m => recMap.get(m.id)?.status === 'absent');
              const unmarkedList = gMembers.filter(m => !recMap.has(m.id));

              return `
              <tr>
                <td><b>${esc(g.name)}</b></td>
                <td style="text-align:center;">${gMembers.length}</td>
                <td style="text-align:center;color:var(--accent);font-weight:700;">${presentList.length}</td>
                <td style="text-align:center;color:#ef4444;font-weight:700;">${absentList.length}</td>
                <td>
                  <div style="display:flex;gap:0.4rem;flex-wrap:wrap;align-items:center;">
                    ${absentList.map(m => {
                      const r = recMap.get(m.id);
                      const timeTip = r ? `點名幹部：${r.markedByName || '幹部'} (最後更新: ${new Date(r.updatedAt + 8*3600*1000).toISOString().slice(11, 16)})` : '';
                      return `<span class="absent-tag" title="${esc(timeTip)}">❌ ${esc(m.name)} (缺席)</span>`;
                    }).join('')}
                    ${presentList.map(m => `<span class="present-tag">✅ ${esc(m.name)}</span>`).join('')}
                    ${unmarkedList.map(m => `<span class="unmarked-tag">⏳ ${esc(m.name)} (未點名)</span>`).join('')}
                  </div>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- 看板 4: 尚未完成點名組別進度與跨組代理 (Incomplete Progress & Delegates) -->
    <div class="dashboard-panel" style="margin-top:1.5rem;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:1.25rem;">
      <div class="panel-header" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.75rem;">
        <h3 style="margin:0;display:flex;align-items:center;gap:0.4rem;">
          <span>⏳</span> [看板 4] 尚未完成點名組別進度與跨組代理 Incomplete Progress &amp; Delegation
        </h3>
        <div style="display:flex;align-items:center;gap:0.5rem;">
          <span style="font-size:0.85rem;color:var(--text-muted);">監控時段：</span>
          <select data-act="pick-teacher-incomplete-session" style="padding:0.3rem 0.6rem;border:1px solid var(--border);border-radius:6px;font-size:0.85rem;">
            ${sessions.map(s => `
              <option value="${s.id}" ${(teacherIncompleteSessionId ? teacherIncompleteSessionId === s.id : s.date === today) ? 'selected' : ''}>
                ${esc(s.name)} (${esc(s.date)})
              </option>
            `).join('')}
            ${!sessions.some(s => s.date === today) ? `
              <option value="daily-${today}" selected>一般日常點名 (${today})</option>
            ` : ''}
          </select>
        </div>
      </div>

      ${(() => {
        const targetSessId = teacherIncompleteSessionId || (sessions.find(s => s.date === today)?.id || `daily-${today}`);
        const incompleteGroups = [];

        c.groups.forEach(g => {
          const gMembers = members(c, g.id);
          const gRecords = records.filter(r => r.sessionId === targetSessId && r.groupId === g.id);
          if (gMembers.length > 0 && gRecords.length < gMembers.length) {
            const unmarked = gMembers.filter(m => !gRecords.some(r => r.studentId === m.id));
            const lead = gMembers.find(m => m.isLeader);
            const vice = gMembers.find(m => m.isVice);
            const leaderAbsent = lead && gRecords.some(r => r.studentId === lead.id && r.status === 'absent');
            const viceAbsent = vice && gRecords.some(r => r.studentId === vice.id && r.status === 'absent');
            const noOfficerAvailable = (!lead || leaderAbsent || unmarked.some(m => m.id === lead?.id)) && (!vice || viceAbsent || unmarked.some(m => m.id === vice?.id));

            incompleteGroups.push({
              group: g,
              total: gMembers.length,
              done: gRecords.length,
              unmarked,
              noOfficerAvailable,
              delegates: delegates.filter(d => d.sessionId === targetSessId && d.groupId === g.id),
            });
          }
        });

        if (!incompleteGroups.length) {
          return `
          <div style="margin-top:1rem;padding:1.2rem;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;color:#166534;display:flex;align-items:center;gap:0.5rem;">
            <span>🎉</span>
            <span><b>全員完成：</b>該時段全班所有組別皆已 100% 完成點名！</span>
          </div>`;
        }

        return `
        <div class="table-wrap" style="margin-top:0.75rem;">
          <table class="roster" style="width:100%;">
            <thead>
              <tr>
                <th>未完成組別 Group</th>
                <th style="width:120px;text-align:center;">完成進度 Progress</th>
                <th>未點名組員與幹部狀態 Unmarked Members</th>
                <th style="text-align:right;">跨組代理指派 Delegation</th>
              </tr>
            </thead>
            <tbody>
              ${incompleteGroups.map(item => `
                <tr>
                  <td><b>${esc(item.group.name)}</b></td>
                  <td style="text-align:center;">
                    <span class="status-badge under-threshold">${item.done}/${item.total} 人完成</span>
                  </td>
                  <td>
                    <div>
                      ${item.noOfficerAvailable ? '<span class="tag-status overdue" style="margin-right:0.4rem;">⚠️ 幹部未到校或未點名</span>' : ''}
                      <span>未確認：${item.unmarked.map(m => esc(m.name)).join('、')}</span>
                    </div>
                  </td>
                  <td style="text-align:right;">
                    <div style="display:inline-flex;gap:0.4rem;align-items:center;flex-wrap:wrap;justify-content:flex-end;">
                      ${item.delegates.map(d => `
                        <span class="tag-inline" style="background:#faf5ff;border-color:#c084fc;color:#7e22ce;">
                          🔁 代理人：${esc(d.delegateName)}
                          <button class="tab-btn" data-act="revoke-delegate" data-session="${targetSessId}" data-group="${item.group.id}" data-delegate="${d.delegateId}" style="margin-left:0.3rem;padding:0 0.3rem;font-size:0.75rem;" title="撤銷代理">✕</button>
                        </span>
                      `).join('')}
                      <select class="tab-btn" data-act="assign-delegate-select" data-session="${targetSessId}" data-group="${item.group.id}" style="padding:0.25rem 0.5rem;font-size:0.8rem;">
                        <option value="">＋ 指派跨組代理人...</option>
                        ${allOfficers.filter(o => o.groupId !== item.group.id).map(o => `
                          <option value="${o.id}">${esc(o.name)} (${esc(o.id)}) - ${esc(o.groupName)}${o.role}</option>
                        `).join('')}
                      </select>
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>`;
      })()}
    </div>

    <!-- 看板 5: 全班組員缺席排行榜 (Absence Leaderboard) -->
    <div class="dashboard-panel" style="margin-top:1.5rem;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:1.25rem;">
      <div class="panel-header" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.75rem;">
        <h3 style="margin:0;display:flex;align-items:center;gap:0.4rem;">
          <span>🏆</span> [看板 5] 全班缺席排行榜 Absence Leaderboard
        </h3>
        <div class="pill-group">
          <button class="pill-tab ${teacherAbsenceRange !== 'today' ? 'active' : ''}" data-act="filter-teacher-absence-range" data-range="all">整個學期 Whole Semester</button>
          <button class="pill-tab ${teacherAbsenceRange === 'today' ? 'active' : ''}" data-act="filter-teacher-absence-range" data-range="today">今日缺席 Today</button>
        </div>
      </div>

      ${(() => {
        const counts = attendanceAbsentCounts(c, teacherAbsenceRange === 'today' ? today : null);
        const ranked = c.students
          .map(s => ({
            student: s,
            count: counts[s.id] || 0,
            group: c.groups.find(g => g.id === s.groupId),
          }))
          .filter(x => x.count > 0)
          .sort((a, b) => b.count - a.count);

        if (!ranked.length) {
          return `
          <div style="margin-top:1rem;padding:1.2rem;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;color:#166534;display:flex;align-items:center;gap:0.5rem;">
            <span>✅</span>
            <span><b>全勤優良：</b>${teacherAbsenceRange === 'today' ? '今日全班無人缺席。' : '本學期全班學生目前無任何缺席紀錄。'}</span>
          </div>`;
        }

        return `
        <div class="table-wrap" style="margin-top:0.75rem;">
          <table class="roster" style="width:100%;">
            <thead>
              <tr>
                <th style="width:60px;text-align:center;">排名</th>
                <th>學生姓名 Name</th>
                <th>學號 Student ID</th>
                <th>所屬組別 Group</th>
                <th style="text-align:center;">缺席次數 Absences</th>
                <th>缺席歷程詳情</th>
              </tr>
            </thead>
            <tbody>
              ${ranked.map((item, idx) => `
                <tr>
                  <td style="text-align:center;">
                    <span class="rank-badge ${idx < 3 ? 'top3' : ''}">${idx + 1}</span>
                  </td>
                  <td><b>${esc(item.student.name)}</b></td>
                  <td><code>${esc(item.student.id)}</code></td>
                  <td>${item.group ? esc(item.group.name) : '<span class="text-muted">未分組</span>'}</td>
                  <td style="text-align:center;">
                    <button class="absence-badge-btn" data-act="view-absence-detail" data-id="${esc(item.student.id)}" data-name="${esc(item.student.name)}" title="點擊檢視歷次缺席明細">
                      ⚠️ ${item.count} 次缺席
                    </button>
                  </td>
                  <td>
                    <span style="font-size:0.82rem;color:var(--text-muted);">
                      點擊次數 Badge 彈出每次缺席日期、活動與點名幹部
                    </span>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>`;
      })()}
    </div>
  </div>`;
}

/* ===== 前台分組現況 ===== */
function unassignedList(c) {
  const pool = unassigned(c);
  return `<div class="pick-list">${pool.length
    ? pool.map(s => `<div class="student">${esc(s.name)} (${esc(s.id)})</div>`).join('')
    : '<p class="file-path">全部學生皆已分組 Everyone is assigned.</p>'}</div>`;
}

function publicBoard({ withUnassigned = true } = {}) {
  const c = cur();
  const pool = c ? unassigned(c) : [];
  const self = me();
  const closed = c ? deadlinePassed(c) : false;
  const myGroup = (c && self && self.groupId) ? c.groups.find(x => x.id === self.groupId) : null;
  const canEdit = canGroupLeaderEdit(c, myGroup);
  // 若為組長且已截止且老師未開放調整權限，則隱藏未分組名單區塊
  const isLeader = self && self.isLeader;
  const hideUnassignedForLeader = isLeader && closed && !canEdit;

  // 若為組長登入狀態（或老師切換至組長預覽模式），因為組長已登入挑選，故移除「Step 2」步驟標籤
  const isLeaderView = isLeader || (state.session && state.session.role === 'teacher' && teacherPreviewMode === 'leader');

  return `
  <section class="block-section group-status-section" id="group-status-block">
    <div class="block-header">
      <div class="block-title-wrap">
        ${!isLeaderView ? '<span class="step-badge">Step 2</span>' : ''}
        <h2>分組現況 Group status</h2>
      </div>
      ${!state.session ? `
        <div class="board-actions">
          <button class="btn btn-primary student-login-btn ${loginMode === 'student' ? 'active' : ''}" data-act="show-student-login">
            <span class="btn-icon">🎓</span> 擔任組長之學生登入 Student login
          </button>
        </div>` : ''}
    </div>

    <!-- 顯眼呈顯目前選取的學年度科目 -->
    <div class="current-course-banner">
      <div class="banner-badge">目前選擇科目 Current Course</div>
      <div class="banner-content">
        <div class="banner-main">
          <div class="course-year-tag">${esc(c ? (c.year || '未設學年度') : '尚未選擇學年度')}</div>
          <div class="course-subject-title">${esc(c ? (c.subject || '（未命名科目）') : '請先於左側課程列表選擇課程')}</div>
        </div>
        ${c ? `
          <div class="course-meta-tags">
            <span class="meta-pill">👥 每組 ${c.groupSize || 4} ± ${c.tolerance || 0} 人（門檻 ${minCap(c)} 人，上限 ${cap(c)} 人）</span>
            <span class="meta-pill">📊 總學生數 ${c.students.length} 人 · ${c.groups.length} 組</span>
            ${c.deadline ? `<span class="meta-pill ${deadlinePassed(c) ? 'expired' : 'active'}">⏳ 全體分組截止時間: ${esc(c.deadline.replace('T', ' '))} ${deadlinePassed(c) ? '(已截止)' : ''}</span>` : ''}
          </div>` : ''}
      </div>
    </div>

    <!-- 學生登入區塊嵌入於此 -->
    ${loginMode === 'student' ? loginCard() : ''}

    ${!c ? `<p class="file-path empty-notice">請先於左側「課程選擇」樹狀清單中點選欲查看分組的學年度與科目。</p>` : ''}

    ${c ? (c.groups.length ? `<div class="group-grid">${c.groups.map(g => {
      const list = members(c, g.id);
      const lead = leaderOf(c, g.id);
      const autoCount = list.filter(s => s.autoAssigned).length;
      const full = list.length >= cap(c);
      const isTeacher = state.session && state.session.role === 'teacher' && teacherPreviewMode === 'admin';
      const isEvalOpen = !!g.peerEvalOpen;
      const isSubmitted = !!g.peerEvalSubmitted;
      const isOverdue = isEvalOpen && evalDeadlinePassed(g) && !isSubmitted;
      const isGroupEditActive = g.allowEdit && !editDeadlinePassed(g);

      let evalStatusTag = '';
      if (!lead) {
        evalStatusTag = `<span class="tag-status no-leader">無組長 (全員-10)</span>`;
      } else if (isSubmitted) {
        evalStatusTag = `<span class="tag-status submitted">✅ 組長已完成加分評定 (組長+10)</span>`;
      } else if (isOverdue) {
        evalStatusTag = `<span class="tag-status overdue">⚠️ 評分逾時 (無加分)</span>`;
      } else if (isEvalOpen) {
        evalStatusTag = `<span class="tag-status open">📝 評分開放中${g.peerEvalDeadline ? ` (${esc(g.peerEvalDeadline.replace('T', ' '))}截止)` : ''}</span>`;
      }

      return `<div class="group-card ${self && self.groupId === g.id ? 'mine' : ''} ${isGroupEditActive ? 'reopened' : ''}">
        <div class="group-card-top-tags">
          ${autoCount ? `<span class="tag">自動 ${autoCount}</span>` : ''}
          ${evalStatusTag}
        </div>
        <h3>${esc(g.name)} <small>${list.length}/${cap(c)} 人${full ? ' · 已滿' : ''}</small></h3>
        <p class="file-path">組長 Leader: ${lead ? esc(lead.name) : '尚未產生 — none'}</p>
        ${g.allowEdit ? `
          <div class="group-badge-reopened">
            ${isGroupEditActive ? '🔓 老師已重新開放本組挑選' : '⏳ 重新開放挑選已逾時截止'}
            ${g.editDeadline ? `<span style="font-size:0.75rem;opacity:0.9;">（截止：${esc(g.editDeadline.replace('T', ' '))}）</span>` : ''}
          </div>` : ''}
        <div class="students">${list.length ? list.map(s => {
          // 期末組長評分僅老師看得到分數，一般同學看不到組長的給分
          return `<div class="student ${s.isLeader ? 'leader' : ''} ${s.isVice ? 'vice-leader' : ''}">
            <span class="student-info-col">
              ${esc(s.name)} (${esc(s.id)})${s.isLeader ? ' — 組長' : s.isVice ? ' — 副組長' : ''}${s.autoAssigned ? ' <span class="tag-inline auto">自動</span>' : ''}
            </span>
            ${isTeacher ? scoreBadge(calcAdjustment(c, g, s)) : ''}
          </div>`;
        }).join('') : '<div class="student">（尚無成員 Empty）</div>'}</div>
        ${isTeacher ? `
          <div class="group-teacher-ctrls">
            <button class="tab-btn ${g.allowEdit ? 'on' : ''}" data-act="toggle-group-edit" data-id="${g.id}" data-allow="${g.allowEdit ? '0' : '1'}">
              ${g.allowEdit ? '🔒 取消開放挑選' : '🔓 重新開放組長挑選'}
            </button>
            ${g.allowEdit && g.editDeadline ? `<span style="font-size:0.75rem;color:#d97706;margin-top:0.25rem;display:block;">截止: ${esc(g.editDeadline.replace('T', ' '))}</span>` : ''}
          </div>` : ''}
      </div>`;
    }).join('')}</div>` : '<p class="file-path empty-notice">老師尚未建立組別，或由學生自行擔任組長開組。No groups yet.</p>') : ''}
  </section>

  ${c ? renderPublicAbsenceCard(c) : ''}

  ${withUnassigned && c && !hideUnassignedForLeader ? `
  <section class="block-section unassigned-section" id="unassigned-block">
    <div class="block-header">
      <div class="block-title-wrap">
        <h2>未分組名單 Unassigned <span class="badge-count">${pool.length}</span></h2>
      </div>
    </div>
    <div class="unassigned-body">
      ${unassignedList(c)}
    </div>
  </section>` : ''}`;
}

/* ===== Screens ===== */
function nav() {
  const c = cur();
  let right = '';
  if (state.session) {
    if (state.session.role === 'teacher') {
      right = `
        <div class="preview-mode-switch">
          <span class="preview-switch-label">👁️ 檢視模式：</span>
          <div class="preview-btn-group">
            <button class="mode-btn ${teacherPreviewMode === 'admin' ? 'active' : ''}" data-act="switch-preview" data-mode="admin" title="進入完整老師後台管理介面">
              ⚙️ 老師後台
            </button>
            <button class="mode-btn ${teacherPreviewMode === 'public' ? 'active' : ''}" data-act="switch-preview" data-mode="public" title="模擬一般訪客或未登入組員看到的前台畫面">
              👀 一般學生前台
            </button>
            <button class="mode-btn ${teacherPreviewMode === 'leader' ? 'active' : ''}" data-act="switch-preview" data-mode="leader" title="模擬擔任組長的學生登入後看到的完整挑選與管理畫面">
              🎓 組長登入模式
            </button>
          </div>
        </div>
        <span class="who">老師 Teacher</span>
        <button class="tab-btn" data-act="logout">登出 Logout</button>
      `;
    } else {
      const who = esc((me() || {}).name || '');
      right = `<span class="who">${who}</span><button class="tab-btn" data-act="logout">登出 Logout</button>`;
    }
  } else {
    right = `<a href="#login" class="teacher-link ${loginMode === 'teacher' ? 'on' : ''}" data-act="show-teacher-login">老師登入 Teacher login</a>`;
  }
  return `<nav>
    <span class="brand">
      <span class="logo">${APP_NAME}</span>
      <span class="ver">${APP_VERSION}</span>
    </span>
    ${c ? `<span class="course-tag">${esc(courseLabel(c))}</span>` : ''}
    <span class="tabs">${right}</span>
  </nav>`;
}

function loginCard() {
  if (loginMode === 'student') {
    const c = cur();
    return `<div class="login-bar embedded" id="login">
      <div class="login-header">
        <strong>擔任組長之學生登入 Student login</strong>
        <button class="tab-btn close" type="button" data-act="close-login" title="關閉 Close">✕</button>
      </div>
      <form data-act="login-student" class="inline-form">
        <div class="form-group"><label>姓名 Name（帳號）</label><input name="name" placeholder="王小明" required autocomplete="off"></div>
        <div class="form-group"><label>學號 Student ID（密碼）</label><input type="password" name="sid" placeholder="410001" required autocomplete="off"></div>
        <button class="btn btn-primary" type="submit">登入 Sign in</button>
      </form>
      <p class="file-path">目前登入課程：<b>${esc(c ? courseLabel(c) : '請先於左側選擇課程')}</b>。登入後可擔任組長並挑選組員。</p>
    </div>`;
  }
  if (loginMode === 'teacher') {
    return `<div class="login-bar teacher" id="login">
      <div class="login-header">
        <strong>老師後台登入 Teacher login</strong>
        <button class="tab-btn close" type="button" data-act="close-login" title="關閉 Close">✕</button>
      </div>
      <form data-act="login-teacher" class="inline-form">
        <div class="form-group pw"><label>老師密碼 Teacher password</label><input type="password" name="password" required autocomplete="off"></div>
        <button class="btn btn-secondary" type="submit">老師登入 Teacher login</button>
      </form>
    </div>`;
  }
  return '';
}

/* ---- 目前選取的課程展示區塊（與左側 Step 1 樹狀區塊產生連動感） ---- */
function courseSelectionBlock() {
  const c = cur();
  return `<section class="block-section courses-overview-section" id="courses-block">
    <div class="block-header">
      <div class="block-title-wrap">
        <span class="step-badge">Step 1 選擇結果</span>
        <h2>課程選擇 Courses</h2>
      </div>
      <div class="courses-link-indicator">
        <span class="link-pulse-dot"></span>
        <span class="link-label">連動自左側課程樹</span>
      </div>
    </div>
    <div class="course-selection-card">
      <div class="selection-accent-connector"></div>
      ${c ? `
        <div class="selected-course-details">
          <div class="selected-meta">
            <span class="selected-year-badge">${esc(c.year || '未分類')} 學年度</span>
            <span class="selected-status-tag">目前已選中 Selected</span>
          </div>
          <h3 class="selected-subject-name">${esc(c.subject || '（未命名科目）')}</h3>
          <div class="selected-specs">
            <div class="spec-item"><span class="spec-label">學生總數</span><span class="spec-val">${c.students.length} 人</span></div>
            <div class="spec-item"><span class="spec-label">組別設定</span><span class="spec-val">${c.groups.length} 組（每組 ${c.groupSize} ± ${c.tolerance} 人，門檻 ${minCap(c)} ~ 上限 ${cap(c)} 人）</span></div>
            <div class="spec-item"><span class="spec-label">分組進度</span><span class="spec-val">${c.students.filter(s => s.groupId).length} 人已分組 / ${unassigned(c).length} 人待分組</span></div>
          </div>
        </div>
      ` : `
        <div class="empty-selection-guide">
          <div class="guide-arrow">👈</div>
          <div class="guide-text">
            <strong>請點選左側樹狀列表選擇課程</strong>
            <p>點選任一學年度下的科目，即可在此立即載入該科目的分組設定與現況。</p>
          </div>
        </div>
      `}
    </div>
  </section>`;
}

function bulletinBlock(c) {
  const notices = (c && Array.isArray(c.notices)) ? c.notices : [];

  return `
  <section class="block-section bulletin-section" id="bulletin-block">
    <div class="bulletin-badge-tag">📢 重要公告 BULLETIN</div>
    <div class="bulletin-header">
      <div class="bulletin-title-wrap">
        <h2>分組注意事項與評分規定</h2>
        ${c ? `<span class="bulletin-course-pill">${esc(courseLabel(c))}</span>` : ''}
      </div>
    </div>
    <div class="bulletin-list">
      ${notices.length ? notices.map(n => `
        <div class="bulletin-item">
          <div class="bulletin-item-content">${esc(n.content).replace(/\n/g, '<br>')}</div>
          ${n.time ? `<div class="bulletin-item-time">🕒 ${esc(n.time)}</div>` : ''}
        </div>`).join('') : '<p class="file-path">目前尚無公告。No announcements yet.</p>'}
    </div>
  </section>`;
}

function authScreen() {
  const c = cur();
  return `
  ${loginMode === 'teacher' ? loginCard() : ''}
  <div class="home-flow">
    ${bulletinBlock(c)}
    ${howto()}
    <div class="home-main-layout">
      ${courseTreePublic()}
      <div class="flow-main">
        ${courseSelectionBlock()}
        ${publicBoard()}
      </div>
    </div>
  </div>`;
}

/* ---- 前台：使用說明 ---- */
function howto() {
  const c = cur();
  const deadlineStr = c && c.deadline ? esc(c.deadline.replace('T', ' ')) : '';
  const isExpired = c && deadlinePassed(c);

  return `<section class="block-section howto-section" id="howto-block">
    <div class="block-header">
      <div class="block-title-wrap">
        <h2>使用方式 How it works</h2>
      </div>
    </div>
    <div class="howto-steps">
      <div class="howto-step-card">
        <div class="step-num">1</div>
        <div class="step-info">
          <strong>選擇學年度與科目</strong>
          <p>在左側樹狀區塊中點選欲分組的<b>學年度 → 科目</b>，右側將即時載入該科目資料。</p>
        </div>
      </div>
      <div class="howto-step-card">
        <div class="step-num">2</div>
        <div class="step-info">
          <strong>學生登入開組</strong>
          <p>想當<b>組長</b>請至「分組現況」點選<b>擔任組長之學生登入</b>（姓名+學號），並按下「我要當組長」。</p>
        </div>
      </div>
      <div class="howto-step-card">
        <div class="step-num">3</div>
        <div class="step-info">
          <strong>挑選組員與指定副組長</strong>
          <p>組長可從未分組名單挑選組員、設定副組長。<b>欲加入尚未額滿的各組組員，請一律透過組長加入</b>；被挑選同學不需額外動作。</p>
        </div>
      </div>
      <div class="howto-step-card">
        <div class="step-num">4</div>
        <div class="step-info">
          <strong>截止後自動分配</strong>
          <p>超過分組截止時間未被挑選者由系統隨機分配至未滿組別，並標示為「自動」。${deadlineStr ? `<br><span style="display:inline-block;margin-top:0.35rem;padding:0.15rem 0.5rem;background:${isExpired ? '#fee2e2' : '#fef3c7'};color:${isExpired ? '#991b1b' : '#92400e'};border-radius:4px;font-weight:600;font-size:0.85rem;">⏳ 本科目分組截止時間：${deadlineStr} ${isExpired ? '(已截止)' : ''}</span>` : '<br><span style="color:#64748b;font-size:0.85rem;">（本科目尚未設定分組截止時間）</span>'}</p>
        </div>
      </div>
    </div>
  </section>`;
}

/* ---- 前台：左側課程樹狀結構區塊（學年度 → 科目） ---- */
function courseTreePublic() {
  const byYear = {};
  state.courses.forEach(c => {
    const y = c.year || '未分類 Unfiled';
    (byYear[y] = byYear[y] || []).push(c);
  });
  const years = Object.keys(byYear).sort().reverse();
  return `<aside class="block-section tree-section" id="courses-tree-block">
    <div class="block-header tree-header">
      <div class="block-title-wrap">
        <span class="step-badge">Step 1</span>
        <h2>課程清單</h2>
      </div>
      <p class="block-desc">選擇學年度與科目</p>
    </div>
    <div class="tree-content">
      ${years.length ? years.map(y => `
        <div class="tree-year">
          <div class="tree-year-label">${esc(y)} 學年度</div>
          <ul class="tree-list">${byYear[y].map(c => {
            const active = state.currentId === c.id;
            return `
            <li class="${active ? 'active' : ''}">
              <button class="tree-node-btn" data-act="pick-course-node" data-id="${c.id}">
                <div class="node-main">
                  <span class="node-icon">${active ? '👉' : '📘'}</span>
                  <span class="node-name">${esc(c.subject || '（未命名科目）')}</span>
                </div>
                <span class="node-badge">${c.students.length}人·${c.groups.length}組</span>
              </button>
              ${active ? `<div class="tree-active-pointer" title="連接至右方課程選擇區塊"></div>` : ''}
            </li>`;
          }).join('')}</ul>
        </div>`).join('') : '<p class="file-path empty-notice">老師尚未建立任何課程。No courses yet.</p>'}
    </div>
  </aside>`;
}

/* ---- 後台：左側課程樹 ---- */
function courseTree() {
  const byYear = {};
  state.courses.forEach(c => {
    const y = c.year || '未分類 Unfiled';
    (byYear[y] = byYear[y] || []).push(c);
  });
  const years = Object.keys(byYear).sort().reverse();
  const activeCourse = cur();

  return `<aside class="tree">
    <h3>課程 Courses</h3>
    ${years.length ? years.map(y => `
      <div class="tree-year">
        <div class="tree-year-label">${esc(y)}</div>
        <ul>${byYear[y].map(c => {
          const isSelected = state.currentId === c.id;
          const cached = courseLogsCache && courseLogsCache[c.id];
          return `
          <li class="${isSelected && (teacherView === 'course' || teacherView === 'attendance' || teacherView === 'logs') ? 'active' : ''}">
            <button data-act="pick-course-node" data-id="${c.id}" class="tree-course-main-btn">
              ${esc(c.subject || '（未命名科目）')}
              <span class="count">${c.students.length} 人 / ${c.groups.length} 組</span>
            </button>
            ${isSelected ? `
              <div class="tree-sub-links">
                <button class="tree-sub-btn ${teacherView === 'course' ? 'on' : ''}" data-act="goto-course-setup" data-id="${c.id}" title="進入課程與分組管理">
                  <span>⚙️ 課程與分組</span>
                </button>
                <button class="tree-sub-btn ${teacherView === 'attendance' ? 'on' : ''}" data-act="goto-course-attendance" data-id="${c.id}" title="點名時段與出勤監控">
                  <span>📝 點名管理</span>
                </button>
                <button class="tree-sub-btn ${teacherView === 'logs' ? 'on' : ''}" data-act="goto-course-logs" data-id="${c.id}" title="檢視本科目異動日誌">
                  <span>📋 異動日誌</span>
                  ${cached ? `<span class="sub-count">${cached.length}</span>` : ''}
                </button>
              </div>
            ` : ''}
          </li>`;
        }).join('')}</ul>
      </div>`).join('') : '<p class="file-path">尚無課程，請於右側「課程設定」建立。</p>'}
    <button class="btn btn-secondary" data-act="new-course">＋ 新增課程 New course</button>
    <div class="tree-year tree-sys">
      <div class="tree-year-label">日誌與系統設定 System & Logs</div>
      <ul>
        <li class="${teacherView === 'attendance' ? 'active' : ''}">
          <button data-act="sys-attendance">
            📝 點名時段與出勤監控
            <span class="count">${activeCourse ? `${esc(activeCourse.subject)}` : 'Attendance'}</span>
          </button>
        </li>
        <li class="${teacherView === 'logs' ? 'active' : ''}">
          <button data-act="sys-logs">
            📋 分組異動日誌
            <span class="count">${activeCourse ? `${esc(activeCourse.subject)}` : 'Activity logs'}</span>
          </button>
        </li>
        <li class="${teacherView === 'eval' ? 'active' : ''}">
          <button data-act="sys-peer-eval">學期成績加減分與組長評分控制<span class="count">Peer evaluation</span></button>
        </li>
        <li class="${teacherView === 'settings' ? 'active' : ''}">
          <button data-act="sys-password">更改管理者密碼<span class="count">Change admin password</span></button>
        </li>
      </ul>
    </div>
  </aside>`;
}

function teacherScreen() {
  const c = cur();
  let main;
  if (teacherView === 'settings') {
    main = teacherPasswordBlock();
  } else if (teacherView === 'eval') {
    main = teacherPeerEvalBlock(c);
  } else if (teacherView === 'logs') {
    main = teacherLogsScreen(c);
  } else if (teacherView === 'attendance') {
    main = teacherAttendanceDashboard(c);
  } else {
    main = c ? teacherCourse(c) : teacherNoCourse();
  }
  return `<div class="layout">${courseTree()}<main>${main}</main></div>`;
}

function teacherLogsScreen(c) {
  if (!c) {
    return `
    <div class="teacher-section">
      <h2>📋 分組異動日誌 <small>Activity Log</small></h2>
      <p class="file-path">請先從左側選擇或建立課程，即可檢視該課程的分組異動日誌。</p>
    </div>`;
  }
  return `
  <div class="teacher-section" style="padding:1.2rem 1.5rem;margin-bottom:1rem;background:#fff;border-radius:8px;border:1px solid #e2e8f0;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.75rem;">
    <div>
      <h2 style="margin:0 0 0.35rem 0;">📋 分組異動日誌 <small>${esc(courseLabel(c))}</small></h2>
      <p class="file-path" style="margin:0;">目前檢視：<b>${esc(c.year)} ${esc(c.subject)}</b> 的分組異動紀錄</p>
    </div>
    <div style="display:flex;gap:0.5rem;align-items:center;">
      <button class="btn btn-secondary" data-act="goto-course-setup" data-id="${c.id}" style="margin:0;padding:0.45rem 1rem;font-size:0.88rem;">
        ⚙️ 前往課程與分組管理
      </button>
    </div>
  </div>
  ${activityLogsBlock(c)}`;
}

function teacherNoCourse() {
  return `
  <div class="teacher-section">
    <h2>課程設定 Course setup</h2>
    <p class="file-path">建立新課程：填寫學年度與科目名稱後儲存，會出現在左側樹狀清單。</p>
    ${courseForm({ year: '', subject: '', groupSize: 4, tolerance: 1, deadline: '', notice: '' })}
  </div>`;
}

function courseForm(c) {
  return `<form data-act="save-course">
    <div class="form-row">
      <div class="form-group"><label>學年度 Academic year</label><input name="year" value="${esc(c.year)}" placeholder="114-1" required></div>
      <div class="form-group"><label>科目名稱 Subject</label><input name="subject" value="${esc(c.subject)}" placeholder="資料結構" required></div>
      <div class="form-group"><label>每組人數 Group size</label><input type="number" min="1" name="groupSize" value="${c.groupSize}"></div>
      <div class="form-group"><label>誤差人數 ± Tolerance</label><input type="number" min="0" name="tolerance" value="${c.tolerance}"></div>
    </div>
    <button class="btn btn-primary" type="submit">儲存 Save</button>
  </form>`;
}

/* ---- 後台：公佈欄管理（每則公告獨立發布，各自附帶時間） ---- */
function bulletinAdminBlock(c) {
  const notices = Array.isArray(c.notices) ? c.notices : [];
  return `
  <div class="teacher-section">
    <h2>公佈欄管理 <small>Bulletin management (顯示於前台最上方)</small></h2>
    <form data-act="add-notice" class="form-row">
      <div class="form-group full">
        <label>發布新公告 New announcement</label>
        <textarea name="content" rows="3" style="width:100%;padding:0.6rem;border:1px solid #ddd;border-radius:4px;font:inherit;" placeholder="輸入公告內容，發布後將附上目前時間顯示於公佈欄最右側" required></textarea>
      </div>
      <div class="form-group full"><button class="btn btn-primary" type="submit">📢 發布公告 Publish</button></div>
    </form>
    <div class="bulletin-admin-list" style="margin-top:0.75rem">
      ${notices.length ? notices.map(n => `
        <div class="bulletin-admin-item">
          <div class="bulletin-item-content">${esc(n.content).replace(/\n/g, '<br>')}</div>
          <div class="bulletin-admin-item-side">
            ${n.time ? `<span class="bulletin-item-time">🕒 ${esc(n.time)}</span>` : ''}
            <button class="tab-btn" data-act="del-notice" data-id="${esc(n.id)}">刪除</button>
          </div>
        </div>`).join('') : '<p class="file-path">目前尚無公告，請於上方發布第一則。</p>'}
    </div>
  </div>`;
}

/* ---- 後台：學期成績加減分與組長評分控制面板 ---- */
function teacherPeerEvalBlock(c) {
  if (!c) {
    return `
    <div class="teacher-section peer-eval-admin-box">
      <h2>⚖️ 學期成績加減分與組長評分控制 <small>Peer Evaluation Management</small></h2>
      <p class="file-path">請先從左側點選或建立課程，即可進行該課程的學期成績加減分與組長評分控制。</p>
    </div>`;
  }
  return `
  <div class="teacher-section peer-eval-admin-box">
    <h2>⚖️ 學期成績加減分與組長評分控制 <small>${esc(courseLabel(c))}</small></h2>
    <p class="file-path">規則：開放評分後組長可依組員貢獻度給予加分(0~10分)；組長進行評分自身可獲得10分加分；超過分組截止時間由系統自動分組造成沒有組長的組別，每位成員期末考成績扣10分。</p>
    
    <div class="peer-eval-global-bar">
      <form data-act="set-all-eval" style="display:flex;align-items:center;flex-wrap:wrap;gap:0.75rem;background:#f8fafc;padding:0.9rem 1.2rem;border:1px solid #e2e8f0;border-radius:8px;">
        <label style="font-weight:600;font-size:0.9rem;">全體組長評分截止時間：</label>
        <input type="datetime-local" name="evalDeadline" style="padding:0.35rem 0.6rem;font-size:0.85rem;" required>
        <button class="btn btn-primary" type="submit" style="padding:0.4rem 1rem;font-size:0.85rem;margin:0;">一鍵開放全體組長評分</button>
        <button class="btn btn-secondary" type="button" data-act="close-all-eval" style="padding:0.4rem 1rem;font-size:0.85rem;margin:0;">一鍵關閉全體評分</button>
      </form>
    </div>

    ${c.groups.length ? `
    <div class="table-wrap" style="margin-top:1rem">
      <table class="roster eval-status-table">
        <thead>
          <tr>
            <th>組別</th>
            <th>組長</th>
            <th>評分權限狀態</th>
            <th>組長評分截止時間</th>
            <th>組長評分進度</th>
            <th>個別操作</th>
          </tr>
        </thead>
        <tbody>
          ${c.groups.map(g => {
            const lead = leaderOf(c, g.id);
            const isOver = evalDeadlinePassed(g);
            return `
            <tr>
              <td><b>${esc(g.name)}</b></td>
              <td>${lead ? `<span style="color:#16a34a;font-weight:600;">${esc(lead.name)} (${esc(lead.id)})</span>` : '<span style="color:#dc2626;">（無組長）</span>'}</td>
              <td>
                ${g.peerEvalOpen
                  ? `<span class="status-badge can-edit">開放中 Open</span>`
                  : `<span class="status-badge is-locked">未開放 Closed</span>`}
              </td>
              <td>${g.peerEvalDeadline ? esc(g.peerEvalDeadline.replace('T', ' ')) : '<span style="color:#94a3b8">未設定</span>'}</td>
              <td>
                ${!lead ? '<span style="color:#64748b">無組長免評分</span>'
                  : g.peerEvalSubmitted ? '<span style="color:#16a34a;font-weight:600;">✅ 組長已完成評分</span>'
                  : (g.peerEvalOpen && isOver) ? '<span style="color:#dc2626;font-weight:600;">⚠️ 逾時未評分 (全組-5/組長-10)</span>'
                  : g.peerEvalOpen ? '<span style="color:#f59e0b;font-weight:600;">⏳ 評分進行中</span>'
                  : '<span style="color:#94a3b8">尚未開放</span>'}
              </td>
              <td>
                ${lead ? `
                  <button class="tab-btn ${g.peerEvalOpen ? 'on' : ''}" data-act="toggle-single-eval" data-id="${g.id}" data-open="${g.peerEvalOpen ? '0' : '1'}">
                    ${g.peerEvalOpen ? '🔒 關閉該組評分' : '🔓 開放該組評分'}
                  </button>` : '<span style="color:#94a3b8">-</span>'}
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>` : '<p class="file-path">尚未建立組別。</p>'}
  </div>`;
}

/* ---- 後台：分組異動日誌管理 ---- */
function logActionBadge(action) {
  if (action === 'pick') return '<span class="log-badge log-badge-pick">➕ 加入組員</span>';
  if (action === 'drop') return '<span class="log-badge log-badge-drop">➖ 釋出組員</span>';
  if (action === 'claim-leader' || action === 'unclaim-leader') return '<span class="log-badge log-badge-leader">👑 組長變更</span>';
  if (action === 'toggle-vice' || action === 'vice') return '<span class="log-badge log-badge-vice">⭐ 副組長變更</span>';
  if (action === 'submit-peer-eval' || action === 'peer-eval') return '<span class="log-badge log-badge-eval">📝 期末評分</span>';
  if (action && (action.startsWith('teacher') || action === 'clear-groups' || action === 'del-groups' || action === 'auto-assign')) {
    return '<span class="log-badge log-badge-teacher">⚙️ 老師操作</span>';
  }
  return `<span class="log-badge log-badge-default">${esc(action || '其他')}</span>`;
}

function activityLogsBlock(c) {
  const logs = (courseLogsCache && courseLogsCache[c.id]) || [];
  const isLoaded = courseLogsCache && Object.prototype.hasOwnProperty.call(courseLogsCache, c.id);

  return `
  <div class="teacher-section activity-logs-section">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.75rem;margin-bottom:0.75rem;">
      <div style="display:flex;align-items:baseline;gap:0.5rem;flex-wrap:wrap;">
        <h2 style="margin:0;">📋 分組異動日誌 <small>Activity Log</small></h2>
        <span class="log-count-pill" id="log-count-display">${logsLoading ? '⏳ 載入中...' : `共 ${logs.length} 筆紀錄`}</span>
      </div>
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
        <button class="btn btn-secondary" style="padding:0.4rem 0.9rem;font-size:0.85rem;margin:0;" data-act="refresh-course-logs" data-id="${c.id}" title="重新向資料庫載入最新日誌">
          🔄 重新整理日誌
        </button>
        <button class="btn btn-secondary" style="padding:0.4rem 0.9rem;font-size:0.85rem;margin:0;" data-act="export-logs-csv" title="匯出異動日誌為 CSV 檔">
          📥 匯出日誌 CSV
        </button>
        ${logs.length ? `
          <button class="btn btn-danger" style="padding:0.4rem 0.9rem;font-size:0.85rem;margin:0;" data-act="clear-course-logs" title="清空本科目所有異動紀錄">
            🗑️ 清空日誌
          </button>
        ` : ''}
      </div>
    </div>
    <p class="file-path" style="margin:0 0 0.85rem 0;">
      系統即時記錄組長挑選／釋出組員、登記／取消組長身分與老師分組調整之詳細操作。為節省系統資源，日誌採「按需讀取」，可點擊「重新整理日誌」取得最新紀錄。
    </p>

    <!-- 篩選與搜尋工具列 -->
    <div class="log-toolbar">
      <div style="display:flex;align-items:center;gap:0.4rem;flex:1;min-width:220px;">
        <span style="font-size:0.9rem;color:#64748b;">🔍 搜尋:</span>
        <input type="text" id="log-search-input" placeholder="輸入學號、姓名或組別關鍵字..." style="width:100%;padding:0.35rem 0.65rem;font-size:0.88rem;">
      </div>
      <div style="display:flex;align-items:center;gap:0.4rem;">
        <span style="font-size:0.9rem;color:#64748b;white-space:nowrap;">🏷️ 動作類別:</span>
        <select id="log-filter-action" style="padding:0.35rem 0.65rem;font-size:0.88rem;">
          <option value="">全部動作 All</option>
          <option value="pick">➕ 加入組員</option>
          <option value="drop">➖ 釋出組員</option>
          <option value="leader">👑 組長變更</option>
          <option value="vice">⭐ 副組長變更</option>
          <option value="eval">📝 期末評分</option>
          <option value="teacher">⚙️ 老師操作</option>
        </select>
      </div>
    </div>

    <!-- 日誌表格 -->
    <div class="table-wrap log-table-wrap">
      <table class="roster log-table" id="activity-log-table">
        <thead>
          <tr>
            <th style="width:160px;">🕒 時間 Timestamp</th>
            <th style="width:160px;">👤 操作者 Operator</th>
            <th style="width:120px;">🏷️ 動作類別</th>
            <th>📝 異動詳細說明 Details</th>
          </tr>
        </thead>
        <tbody>
          ${logsLoading ? `
            <tr class="no-log-row">
              <td colspan="4" style="text-align:center;padding:2rem;color:#64748b;">
                ⏳ 正在向雲端資料庫按需載入日誌紀錄，請稍候...
              </td>
            </tr>
          ` : logs.length ? logs.map(l => {
            let cat = 'other';
            if (l.action === 'pick') cat = 'pick';
            else if (l.action === 'drop') cat = 'drop';
            else if (l.action === 'claim-leader' || l.action === 'unclaim-leader') cat = 'leader';
            else if (l.action === 'toggle-vice' || l.action === 'vice') cat = 'vice';
            else if (l.action === 'submit-peer-eval' || l.action === 'peer-eval') cat = 'eval';
            else if (l.action && (l.action.startsWith('teacher') || l.action === 'clear-groups' || l.action === 'del-groups' || l.action === 'auto-assign')) cat = 'teacher';

            return `
            <tr data-cat="${esc(cat)}" data-search="${esc((l.time + ' ' + l.operator + ' ' + l.details).toLowerCase())}">
              <td style="font-family:monospace;font-size:0.85rem;color:#475569;white-space:nowrap;">${esc(l.time)}</td>
              <td><strong>${esc(l.operator)}</strong></td>
              <td>${logActionBadge(l.action)}</td>
              <td style="word-break:break-word;">${esc(l.details)}</td>
            </tr>`;
          }).join('') : `
            <tr class="no-log-row">
              <td colspan="4" style="text-align:center;padding:2rem;color:#94a3b8;">
                ${isLoaded ? '目前尚無分組異動紀錄。當組長挑選、釋出組員或進行分組調整時，將即時留存日誌。' : '尚未載入日誌紀錄，請點擊上方「🔄 重新整理日誌」載入。'}
              </td>
            </tr>
          `}
        </tbody>
      </table>
    </div>
  </div>`;
}

function exportLogsCSV(c) {
  const logs = (courseLogsCache && courseLogsCache[c.id]) || [];
  if (!logs.length) return alert('目前尚無日誌資料可供匯出，請先點擊「🔄 重新整理日誌」載入資料。');
  const rows = [['時間', '操作者', '動作代碼', '異動詳細說明']];
  logs.forEach(l => {
    rows.push([
      l.time || '',
      l.operator || '',
      l.action || '',
      l.details || '',
    ]);
  });
  const csv = '﻿' + rows.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\n');
  download(csv, `${c.year || 'grouping'}_${c.subject || 'data'}_分組異動日誌.csv`);
}

function filterLogRows() {
  const searchInput = document.getElementById('log-search-input');
  const filterSelect = document.getElementById('log-filter-action');
  const table = document.getElementById('activity-log-table');
  const countDisplay = document.getElementById('log-count-display');
  if (!table) return;

  const query = (searchInput ? searchInput.value : '').trim().toLowerCase();
  const cat = filterSelect ? filterSelect.value : '';

  const rows = table.querySelectorAll('tbody tr:not(.no-log-row)');
  let visibleCount = 0;
  rows.forEach(row => {
    const rowCat = row.getAttribute('data-cat') || '';
    const rowSearch = row.getAttribute('data-search') || '';
    const matchCat = !cat || rowCat === cat;
    const matchQuery = !query || rowSearch.includes(query);
    if (matchCat && matchQuery) {
      row.style.display = '';
      visibleCount++;
    } else {
      row.style.display = 'none';
    }
  });

  if (countDisplay) {
    countDisplay.textContent = (query || cat) ? `顯示 ${visibleCount} / ${rows.length} 筆紀錄` : `共 ${rows.length} 筆紀錄`;
  }
}

function teacherCourse(c) {
  const total = c.students.length;
  const assigned = c.students.filter(s => s.groupId).length;
  return `
  <div class="teacher-section">
    <h2>課程設定 Course setup <small>${esc(courseLabel(c))}</small></h2>
    ${courseForm(c)}
    <div class="btn-row" style="margin-top:1rem">
      <button class="btn btn-warning" data-act="clear-groups" title="只清除所有組別與學生組別分配，保留修課名單與課程">刪除分組（不刪名單與課程）Delete groups only</button>
      ${c.hasSnapshot ? `
        <button class="btn btn-undo" data-act="restore-snapshot" title="復原至上次清空或建立組別前的分組狀態">↩️ 回到上一步 (復原分組) Undo</button>
      ` : ''}
      <button class="btn btn-danger" data-act="del-course" data-id="${c.id}" title="完全刪除本科目所有資料">刪除整個科目（含名單與分組）Delete course</button>
    </div>
  </div>

  ${bulletinAdminBlock(c)}

  <div class="teacher-section">
    <h2>分組管理 Grouping</h2>

    <!-- 分組截止時間設定 (置於分組管理區塊開頭) -->
    <form data-act="set-course-deadline" class="grouping-deadline-bar">
      <label>⏳ 分組截止時間 Deadline：</label>
      <input type="datetime-local" name="deadline" value="${esc(c.deadline || '')}">
      <button class="btn btn-primary" type="submit" style="padding:0.4rem 1rem;font-size:0.85rem;margin:0;">儲存截止時間</button>
      ${c.deadline ? `
        <span class="deadline-status-tag ${deadlinePassed(c) ? 'closed' : 'open'}">
          ${deadlinePassed(c) ? '🚫 已截止（未選學生已自動分配）Closed' : '🟢 分組進行中 Open'}
        </span>
      ` : '<span style="font-size:0.82rem;color:#64748b;">(尚未設定截止時間)</span>'}
    </form>

    <div class="stats">
      <div class="stat"><div class="value">${total}</div><div class="label">總學生數 Students</div></div>
      <div class="stat"><div class="value">${c.groups.length}</div><div class="label">組別數 Groups</div></div>
      <div class="stat"><div class="value">${assigned}</div><div class="label">已分組 Assigned</div></div>
      <div class="stat"><div class="value">${total - assigned}</div><div class="label">未分組 Unassigned</div></div>
    </div>
    <div class="btn-row">
      <button class="btn btn-primary" data-act="make-groups" title="將重設並清空現有所有分組">建立空組別（清空現有）Create groups</button>
      <button class="btn btn-success" data-act="make-remaining-groups" title="只針對未分組成員依規定人數建立新組別，現有組別與成員不變">針對剩餘組員建立組別 Create for unassigned</button>
      <button class="btn btn-secondary" data-act="add-group">新增一組 Add group</button>
      <button class="btn btn-secondary" data-act="auto-assign" title="隨機分配未分組學生，避開已完成編組的組別，不新增或刪減已完成分組的組別成員">隨機分配剩餘 Auto-assign</button>
      <button class="btn btn-danger" data-act="clear-groups">清除本科目所有分組 Clear all groups</button>
      ${c.hasSnapshot ? `
        <button class="btn btn-undo" data-act="restore-snapshot" title="復原至上次清空或建立組別前的分組狀態">↩️ 回到上一步 (復原分組) Undo</button>
      ` : ''}
      <button class="btn btn-secondary" data-act="goto-course-logs" data-id="${c.id}" title="前往本科目分組異動日誌">📋 分組異動日誌${courseLogsCache && courseLogsCache[c.id] ? ` (${courseLogsCache[c.id].length})` : ''}</button>
      <button class="btn btn-secondary" data-act="export-json">匯出 JSON</button>
      <button class="btn btn-secondary" data-act="export-csv" title="匯出全體學生期末評分結果，依學號由小到大排序">匯出評分成績 CSV（依學號排序）</button>
    </div>

    <!-- 勾選要刪除的分組組別 -->
    ${c.groups.length ? `
      <div class="select-del-groups-box" style="margin-top:1.5rem;padding:1.2rem;background:#fffaf0;border:1.5px solid #fdebd0;border-radius:8px;">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;margin-bottom:0.75rem;">
          <strong style="color:#d35400;">🗑️ 勾選刪除特定分組組別 Select groups to delete</strong>
          <div style="display:flex;gap:0.5rem;">
            <button class="tab-btn" type="button" data-act="select-all-del-groups">全選 All</button>
            <button class="tab-btn" type="button" data-act="unselect-all-del-groups">取消全選 None</button>
            <button class="btn btn-danger" type="button" data-act="del-selected-groups" style="padding:0.4rem 0.9rem;font-size:0.85rem;margin:0;">刪除勾選組別</button>
          </div>
        </div>
        <p class="file-path" style="margin:0 0 0.75rem 0;">勾選欲刪除的組別並點擊「刪除勾選組別」，被刪組別之組員將退回未分組名單，其餘組別與名單不受影響。</p>
        <div class="del-groups-grid" style="display:grid;grid-template-columns:repeat(auto-fill, minmax(180px, 1fr));gap:0.5rem;">
          ${c.groups.map(g => {
            const count = members(c, g.id).length;
            return `
            <label style="display:flex;align-items:center;gap:0.4rem;background:#fff;padding:0.5rem 0.75rem;border:1px solid #ebd4b9;border-radius:6px;cursor:pointer;font-size:0.9rem;">
              <input type="checkbox" name="del_group_cb" value="${esc(g.id)}">
              <span><b>${esc(g.name)}</b> (${count}人)</span>
            </label>`;
          }).join('')}
        </div>
      </div>` : ''}

    <!-- 特定組別重新開放挑選組員控制面板 -->
    ${c.groups.length ? `
      <div class="reopen-groups-box" style="margin-top:1.5rem;padding:1.2rem;background:#f0fdf4;border:1.5px solid #bbf7d0;border-radius:8px;">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;margin-bottom:0.75rem;">
          <strong style="color:#166534;">🔓 特定組別重新開放組長挑選組員（可設定新截止時間）</strong>
        </div>
        <p class="file-path" style="margin:0 0 0.75rem 0;">
          即便全體分組截止時間已過，老師仍可在此為特定組別重新開放組長挑選組員權限，並指定「該組專屬之新截止時間」。逾時後將自動鎖定。
        </p>
        <div class="table-wrap">
          <table class="roster" style="background:#fff;">
            <thead>
              <tr>
                <th>組別</th>
                <th>組長</th>
                <th>目前成員</th>
                <th>挑選權限狀態</th>
                <th>專屬新截止時間</th>
                <th>操作（設定新時限並開放）</th>
              </tr>
            </thead>
            <tbody>
              ${c.groups.map(g => {
                const lead = leaderOf(c, g.id);
                const count = members(c, g.id).length;
                const isGroupEditActive = g.allowEdit && !editDeadlinePassed(g);
                return `
                <tr>
                  <td><b>${esc(g.name)}</b></td>
                  <td>${lead ? `<span style="color:#16a34a;font-weight:600;">${esc(lead.name)} (${esc(lead.id)})</span>` : '<span style="color:#94a3b8">（尚未產生組長）</span>'}</td>
                  <td>${count} / ${cap(c)} 人</td>
                  <td>
                    ${!g.allowEdit ? '<span class="status-badge is-locked">未開放（依全體時限）</span>'
                      : isGroupEditActive ? '<span class="status-badge can-edit">開放挑選中 Open</span>'
                      : '<span class="status-badge under-threshold">已逾專屬截止時間 Closed</span>'}
                  </td>
                  <td>
                    ${g.editDeadline ? `<span style="font-weight:600;color:${isGroupEditActive ? '#166534' : '#991b1b'};">${esc(g.editDeadline.replace('T', ' '))}</span>` : (g.allowEdit ? '<span style="color:#64748b;">永久開放（無期限）</span>' : '<span style="color:#94a3b8">-</span>')}
                  </td>
                  <td>
                    ${g.allowEdit ? `
                      <div style="display:flex;align-items:center;gap:0.4rem;flex-wrap:wrap;">
                        <button class="tab-btn on" data-act="toggle-group-edit" data-id="${g.id}" data-allow="0">
                          🔒 關閉開放
                        </button>
                        <button class="tab-btn" data-act="reopen-group-modal" data-id="${g.id}" title="更改該組新截止時間">
                          ⏱️ 更改截止時間
                        </button>
                      </div>
                    ` : `
                      <button class="btn btn-primary" style="padding:0.35rem 0.85rem;font-size:0.85rem;margin:0;" data-act="reopen-group-modal" data-id="${g.id}">
                        🔓 重新開放並設定新時限
                      </button>
                    `}
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>` : ''}
  </div>

  ${activityLogsBlock(c)}

  <div class="roster-row">
    <div class="teacher-section">
      <h2>修課名單 Roster</h2>
      <div class="form-group">
        <label>匯入文字檔 Import .txt / .csv（每行：學號 姓名）</label>
        <input type="file" accept=".txt,.csv" data-act="import-file">
        <div class="file-path">格式範例 Format: <code>410123 王小明</code> 或 <code>410123,王小明</code>；標題列（學號 / 姓名）會自動略過。</div>
      </div>
      <form data-act="add-student" class="form-row">
        <div class="form-group"><label>學號 ID</label><input name="id" required></div>
        <div class="form-group"><label>姓名 Name</label><input name="name" required></div>
        <div class="form-group full"><button class="btn btn-primary" type="submit">新增學生 Add student</button></div>
      </form>
      ${rosterTable(c)}
    </div>

    <div class="teacher-section unassigned-panel">
      <h2>未分組名單 Unassigned (${total - assigned})</h2>
      ${unassignedList(c)}
    </div>
  </div>
  ${publicBoard({ withUnassigned: false })}`;
}

function teacherPasswordBlock() {
  return `
  <div class="teacher-section">
    <h2>更改管理者密碼 <small>Change admin password</small></h2>
    <form data-act="change-password" class="pw-form">
      <div class="form-group"><label>目前密碼 Current</label><input type="password" name="current" required autocomplete="off"></div>
      <div class="form-group"><label>新密碼 New（至少 4 碼）</label><input type="password" name="next" required minlength="4" autocomplete="off"></div>
      <button class="btn btn-primary" type="submit">更新密碼 Update password</button>
    </form>
    <p class="file-path">學生登入固定為「姓名 + 學號」，不需另設密碼。Students sign in with name + student ID.</p>
  </div>`;
}

function rosterTable(c) {
  if (!c.students.length) return '<p class="file-path">尚無學生 No students yet.</p>';
  const opts = s => ['<option value="">未分組 —</option>']
    .concat(c.groups.map(g => `<option value="${g.id}" ${s.groupId === g.id ? 'selected' : ''}>${esc(g.name)}</option>`))
    .join('');
  return `<div class="table-wrap"><table class="roster">
    <thead><tr><th>學號 ID</th><th>姓名 Name</th><th>組別 Group</th><th>組長 Leader</th><th>期末考調分</th><th></th></tr></thead>
    <tbody>${c.students.map(s => {
      const g = c.groups.find(x => x.id === s.groupId);
      const adj = calcAdjustment(c, g, s);
      return `
      <tr>
        <td>${esc(s.id)}</td>
        <td>${esc(s.name)}${s.autoAssigned ? ' <span class="tag-inline auto">自動</span>' : ''}${s.isVice ? ' <span class="tag-inline">副組長</span>' : ''}</td>
        <td><select data-act="assign-student" data-id="${esc(keyOf(s))}">${opts(s)}</select></td>
        <td><input type="checkbox" data-act="set-leader" data-id="${esc(keyOf(s))}" ${s.isLeader ? 'checked' : ''} ${s.groupId ? '' : 'disabled'}></td>
        <td>${scoreBadge(adj)}</td>
        <td><button class="tab-btn" data-act="del-student" data-id="${esc(keyOf(s))}">刪除</button></td>
      </tr>`;
    }).join('')}
    </tbody></table></div>`;
}

function studentScreen() {
  const c = cur(), s = me();
  if (!c || !s) { state.session = null; return authScreen(); }
  const g = c.groups.find(x => x.id === s.groupId);
  const mates = g ? members(c, g.id) : [];
  const closed = deadlinePassed(c);
  const canEdit = canGroupLeaderEdit(c, g);
  const otherLeader = g ? mates.find(m => m.isLeader && m.id !== s.id) : null;
  const isPreview = state.session && state.session.role === 'teacher';

  let html = `
  <div class="student-section">
    <h2>${esc(courseLabel(c))}</h2>
    <div class="student-info">
      <strong>學生 Student:</strong> ${esc(s.name)} (${esc(s.id)})<br>
      <strong>角色 Role:</strong> ${s.isLeader ? '組長 Leader' : s.isVice ? '副組長 Vice leader' : '組員 Member'}<br>
      <strong>組別 Group:</strong> ${g ? esc(g.name) : '未分組 Unassigned'}${s.autoAssigned ? '（自動分配 Auto-assigned）' : ''}
    </div>`;

  if (s.isLeader) {
    if (closed && !canEdit) {
      html += `
        <div class="deadline-alert locked">
          <span class="alert-icon">⏳</span>
          <div>
            <strong>已超過分組截止時間，組長無法更換組員 Deadline passed</strong>
            <p>目前分組截止時間已過${(g && g.editDeadline) ? `（本組專屬截止時間 ${esc(g.editDeadline.replace('T', ' '))} 亦已截止）` : ''}，組員名單已鎖定。如需更換，請聯絡老師個別重新開放挑選權限，或由老師於後台手動調整。</p>
          </div>
        </div>`;
    } else if (closed && canEdit) {
      html += `
        <div class="deadline-alert unlocked">
          <span class="alert-icon">🔓</span>
          <div>
            <strong>老師已重新開放本科目本組挑選權限 Permission re-opened</strong>
            <p>授課老師已特別為本組開放重新挑選權限，您現在可以更換組員或調整副組長。${(g && g.editDeadline) ? `<br><b style="color:#92400e;">⏳ 本組專屬截止時間為：${esc(g.editDeadline.replace('T', ' '))}，逾時將自動鎖定。</b>` : ''}</p>
          </div>
        </div>
        ${!isPreview ? `<button class="btn btn-secondary" data-act="unclaim-leader">取消組長身分 Step down</button>` : ''}`;
    } else {
      html += !isPreview ? `<button class="btn btn-secondary" data-act="unclaim-leader">取消組長身分 Step down</button>` : '';
    }
  } else if (closed) {
    html += '<p class="file-path">已超過分組截止時間，無法再變更。Deadline passed.</p>';
  } else if (otherLeader) {
    html += `<p class="file-path">本組組長為 ${esc(otherLeader.name)}，無法重複擔任。Group already has a leader.</p>`;
  } else {
    html += `
      <div class="leader-actions-row">
        <button class="btn btn-primary" data-act="claim-leader">我要當組長 Become leader</button>
        <button class="btn btn-neutral" data-act="logout">不願意擔任組長，返回首頁</button>
      </div>
      <p class="file-path">${g ? '成為本組組長後即可挑選組員。' : '將自動為你開一組並擔任組長。'}</p>`;
  }

  /* 組長專用成員管理區塊 */
  if (s.isLeader && g) {
    const min = minCap(c);
    const needed = Math.max(0, min - mates.length);
    const meetsThreshold = mates.length >= min;

    /* 1. 已挑選成員（顯示在挑選組員區塊上方） */
    html += `
    <div class="selected-members-panel">
      <div class="panel-header">
        <h3 style="margin:0">已挑選成員 Selected members <small>（門檻 ${min} 人，上限 ${cap(c)} 人，目前 ${mates.length} 人${mates.length >= cap(c) ? ' · 已滿' : ''}）</small></h3>
        <div class="header-badges">
          ${meetsThreshold
            ? `<span class="status-badge meets-threshold">✅ 已達門檻（${mates.length}/${min}）</span>`
            : `<span class="status-badge under-threshold">⚠️ 尚缺 ${needed} 位成員達門檻</span>`}
          ${canEdit ? '<span class="status-badge can-edit">可更換組員</span>' : '<span class="status-badge is-locked">已鎖定</span>'}
        </div>
      </div>
      ${!meetsThreshold ? `
        <div class="threshold-notice">
          <strong>⚠️ 本組目前人數（${mates.length} 人）尚未達分組最低門檻（${min} 人）</strong>
          <p>請於分組截止時間前再挑選至少 <b>${needed}</b> 位成員。若超過分組截止時間仍未達門檻，本組將<b>無法完成建立並會自動解散</b>，成員將由系統重新隨機分配。</p>
        </div>` : ''}
      <div class="pick-list" style="margin-top:0.75rem">${mates.map(m => `
        <div class="student ${m.isLeader ? 'leader' : ''} ${m.isVice ? 'vice-leader' : ''}">
          <span class="student-name-tag">
            ${esc(m.name)} (${esc(m.id)})${m.isLeader ? ' — 組長' : m.isVice ? ' — 副組長' : ''}${m.autoAssigned ? ' <span class="tag-inline auto">自動</span>' : ''}
          </span>
          ${(canEdit && m.id !== s.id) ? `
            <button class="tab-btn ${m.isVice ? 'on' : ''}" data-act="toggle-vice" data-id="${esc(keyOf(m))}">
              ${m.isVice ? '取消副組長' : '設為副組長'}</button>
            <button class="tab-btn" data-act="drop" data-id="${esc(keyOf(m))}">移出</button>` : ''}
        </div>`).join('')}</div>
      <p class="file-path">每組僅能有一位副組長，重新指定會自動取代前一位。若組長取消身分，副組長將自動晉級為組長。</p>
    </div>`;

    /* 2. 挑選組員（顯示在已挑選成員區塊下方） */
    if (canEdit) {
      const pool = unassigned(c);
      const isFull = mates.length >= cap(c);
      html += `
      <div class="pick-members-panel" style="margin-top:1.5rem">
        <div class="panel-header">
          <h3 style="margin:0">挑選組員 Pick members</h3>
          ${isFull ? '<span class="badge-full">本組人數已達上限，無法再挑選</span>' : ''}
        </div>
        <div class="pick-list" style="margin-top:0.75rem">${pool.length ? pool.map(p => `
          <label class="student ${isFull ? 'disabled' : ''}">
            <input type="checkbox" data-act="pick" data-id="${esc(keyOf(p))}" ${isFull ? 'disabled' : ''}>
            ${esc(p.name)} (${esc(p.id)})
          </label>`).join('')
          : '<p class="file-path">目前沒有未分組的學生 No unassigned students.</p>'}</div>
      </div>`;
    }

    /* 3. 組長專屬：期末成員貢獻度評分面板（當老師開放權限時顯示） */
    const isEvalOpen = !!g.peerEvalOpen;
    const isSubmitted = !!g.peerEvalSubmitted;
    const isOverdue = isEvalOpen && evalDeadlinePassed(g) && !isSubmitted;
    const otherMembers = mates.filter(m => m.id !== s.id);

    html += `
    <div class="leader-eval-panel" style="margin-top:1.5rem;padding:1.25rem;background:#f0fdf4;border:2px solid #bbf7d0;border-radius:10px;">
      <div class="panel-header" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;">
        <h3 style="margin:0;color:#166534;">📝 期末組員貢獻度評分 Peer Evaluation</h3>
        ${isSubmitted
          ? '<span class="status-badge meets-threshold">✅ 您已完成評分提交</span>'
          : isOverdue
          ? '<span class="status-badge under-threshold">⚠️ 已超過評分截止時間 (逾時懲罰生效)</span>'
          : isEvalOpen
          ? '<span class="status-badge can-edit">開放評分中 Open</span>'
          : '<span class="status-badge is-locked">老師尚未開放評分</span>'}
      </div>

      <div style="margin:0.75rem 0;font-size:0.88rem;color:#14532d;line-height:1.6;">
        <p style="margin:0 0 0.4rem 0;"><b>說明：</b>在老師開放評分期間，組長可依據組員之貢獻與配合程度給予<b>加分 (0 ~ 10 分)</b>。</p>
        <p style="margin:0;color:#166534;font-weight:600;"><b>🎁 組長獎勵：</b>組長在老師開放評分權限時進行評分，<b>組長自己可獲得 10 分的加分</b>！</p>
        ${g.peerEvalDeadline ? `<p style="margin:0.4rem 0 0 0;font-weight:600;">⏳ 本組評分截止時間：${esc(g.peerEvalDeadline.replace('T', ' '))}</p>` : ''}
      </div>

      ${!isEvalOpen ? `
        <div style="padding:0.75rem;background:#fff;border-radius:6px;border:1px dashed #86efac;color:#4b5563;font-size:0.88rem;">
          授課老師尚未開放本組評分權限。待老師開放並公告評分截止時間後，您可在此進行評分。
        </div>` : isOverdue ? `
        <div style="padding:0.75rem;background:#fef2f2;border-radius:6px;border:1px solid #fecaca;color:#991b1b;font-size:0.88rem;">
          已超過老師規定的評分截止時間，組長評分權限已關閉。因未在時限內進行評分，組長無法獲得 10 分加分，組員亦無法獲得加分。
        </div>` : !otherMembers.length ? `
        <div style="padding:0.75rem;background:#fff;border-radius:6px;border:1px dashed #86efac;color:#4b5563;font-size:0.88rem;">
          目前組內尚無其他成員。您可直接送出評分以獲得組長專屬的 10 分加分：
          <form data-act="submit-peer-eval" style="margin-top:0.6rem;">
            <button class="btn btn-primary" type="submit" style="padding:0.45rem 1.2rem;">確認並領取組長 10 分加分</button>
          </form>
        </div>` : `
        <form data-act="submit-peer-eval" style="margin-top:1rem;">
          <div class="table-wrap">
            <table class="roster" style="background:#fff;">
              <thead>
                <tr>
                  <th>組員姓名 (學號)</th>
                  <th>角色</th>
                  <th>期末考加分 (0 ~ 10 分)</th>
                  <th>加分原因 / 貢獻說明 (選填)</th>
                </tr>
              </thead>
              <tbody>
                ${otherMembers.map(m => `
                  <tr>
                    <td><b>${esc(m.name)}</b> (${esc(m.id)})</td>
                    <td>${m.isVice ? '<span class="tag-inline">副組長</span>' : '組員'}</td>
                    <td>
                      <select name="penalty_${esc(keyOf(m))}" style="padding:0.35rem 0.5rem;font-size:0.9rem;border:1.5px solid #cbd5e1;border-radius:4px;" ${isSubmitted ? 'disabled' : ''}>
                        <option value="0" ${m.peerPenalty === 0 ? 'selected' : ''}>+0 分（無額外加分）</option>
                        <option value="1" ${m.peerPenalty === 1 ? 'selected' : ''}>+1 分</option>
                        <option value="2" ${m.peerPenalty === 2 ? 'selected' : ''}>+2 分</option>
                        <option value="3" ${m.peerPenalty === 3 ? 'selected' : ''}>+3 分</option>
                        <option value="4" ${m.peerPenalty === 4 ? 'selected' : ''}>+4 分</option>
                        <option value="5" ${m.peerPenalty === 5 ? 'selected' : ''}>+5 分</option>
                        <option value="6" ${m.peerPenalty === 6 ? 'selected' : ''}>+6 分</option>
                        <option value="7" ${m.peerPenalty === 7 ? 'selected' : ''}>+7 分</option>
                        <option value="8" ${m.peerPenalty === 8 ? 'selected' : ''}>+8 分</option>
                        <option value="9" ${m.peerPenalty === 9 ? 'selected' : ''}>+9 分</option>
                        <option value="10" ${m.peerPenalty === 10 ? 'selected' : ''}>+10 分（重大貢獻 / 表現優異）</option>
                      </select>
                    </td>
                    <td>
                      <input type="text" name="comment_${esc(keyOf(m))}" value="${esc(m.peerComment || '')}" placeholder="若有加分可填寫貢獻事蹟" style="width:100%;max-width:260px;padding:0.35rem 0.5rem;font-size:0.85rem;" ${isSubmitted ? 'disabled' : ''}>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
          <div style="margin-top:0.85rem;display:flex;align-items:center;gap:0.75rem;">
            ${isSubmitted ? `
              <span style="color:#166534;font-weight:600;font-size:0.9rem;">✅ 評分已送出完成（您已獲得組長 10 分加分）。如需調整請直接修改並重新送出：</span>
              <button class="btn btn-primary" type="submit" style="padding:0.45rem 1.1rem;font-size:0.9rem;">重新更新評分 Update</button>
            ` : `
              <button class="btn btn-primary" type="submit" style="padding:0.5rem 1.4rem;font-size:0.95rem;">送出評分（組長即獲 +10 分）Submit Evaluation</button>
              <span style="font-size:0.82rem;color:#64748b;">提交後組長自身立即獲得 10 分加分，截止前仍可重複調整組員分數。</span>
            `}
          </div>
        </form>`}
    </div>`;
  }
  html += renderLeaderAttendancePanel(c, s, g, mates);
  html += renderStudentAbsencePersonalCard(c, s);
  html += renderLeaderPasswordCard(s);
  return html + '</div>' + publicBoard();
}

/* ===== 老師切換預覽模式專用提示橫幅 ===== */
function teacherPreviewBanner() {
  if (!state.session || state.session.role !== 'teacher' || teacherPreviewMode === 'admin') return '';
  const isLeader = teacherPreviewMode === 'leader';
  const c = cur();
  return `
  <div class="teacher-preview-floating-bar">
    <div class="preview-bar-left">
      <span class="preview-pulse-icon">${isLeader ? '🎓' : '👀'}</span>
      <span class="preview-text">
        目前為<b>【${isLeader ? '擔任組長之學生登入' : '一般學生看到的前台'}】</b>視角預覽模式
        ${c ? `（課程：${esc(courseLabel(c))}）` : ''}
      </span>
    </div>
    <div class="preview-bar-right">
      <button class="btn btn-secondary" data-act="switch-preview" data-mode="${isLeader ? 'public' : 'leader'}" style="padding:0.35rem 0.8rem;font-size:0.85rem;margin:0;">
        切換為${isLeader ? '一般學生視角' : '組長登入視角'}
      </button>
      <button class="btn btn-primary" data-act="switch-preview" data-mode="admin" style="padding:0.35rem 0.9rem;font-size:0.85rem;margin:0;">
        ⚙️ 返回老師後台 Exit Preview
      </button>
    </div>
  </div>`;
}

/* ===== Render ===== */
function render() {
  const isTeacher = state.session && state.session.role === 'teacher';
  const isStudent = state.session && state.session.role === 'student';

  let body = '';
  if (!state.session) {
    body = authScreen();
  } else if (isTeacher) {
    if (teacherPreviewMode === 'public') {
      body = authScreen();
    } else if (teacherPreviewMode === 'leader') {
      body = studentScreen();
    } else {
      body = teacherScreen();
    }
  } else {
    body = studentScreen();
  }

  const showHowto = isStudent || (isTeacher && teacherPreviewMode === 'leader');

  document.getElementById('app').innerHTML =
    nav() + teacherPreviewBanner() + '<div class="container">' + (showHowto ? howto() : '') + body + '</div>' + renderAbsenceModalHtml(activeAbsenceModal);
  if (!state.session && loginMode) {
    const first = document.querySelector('#login input');
    if (first) first.focus();
  }
}

/* ===== Export ===== */
function exportJSON(c) {
  download(JSON.stringify({ year: c.year, subject: c.subject, groups: c.groups, students: c.students, exportedAt: new Date().toISOString() }, null, 2),
    'application/json', `${c.year || 'grouping'}_${c.subject || 'data'}.json`);
}

function exportCSV(c) {
  const rows = [['學號', '姓名', '組別', '角色', '自動分組', '期末考調分', '調分原因說明', '組長加分評定']];
  const sortedStudents = c.students.slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id), 'zh-Hant', { numeric: true }));
  sortedStudents.forEach(s => {
    const g = c.groups.find(x => x.id === s.groupId);
    const adj = calcAdjustment(c, g, s);
    rows.push([
      s.id,
      s.name,
      g ? g.name : '',
      s.isLeader ? '組長' : s.isVice ? '副組長' : '組員',
      s.autoAssigned ? 'Y' : 'N',
      adj.score,
      adj.reason,
      s.peerPenalty ? `+${s.peerPenalty}分` : '0分',
    ]);
  });
  const csv = '﻿' + rows.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\n');
  download(csv, `${c.year || 'grouping'}_${c.subject || 'data'}_grading.csv`);
}

function download(content, typeOrFilename, maybeFilename) {
  const type = maybeFilename ? typeOrFilename : 'text/plain;charset=utf-8';
  const filename = maybeFilename || typeOrFilename;
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* 標題列（學號 / 姓名 / ID / Name）自動略過 */
const isHeaderLine = line => /學號|學生證號|姓名|名字|student\s*(id|no)|^\s*id\b|\bname\b/i.test(line);

function parseRoster(text) {
  const rows = [];
  let skipped = 0;
  text.replace(/^\ufeff/, '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).forEach(line => {
    if (isHeaderLine(line)) { skipped++; return; }
    const [id, name] = line.split(/\s*[,\t|]\s*|\s+/).filter(Boolean);
    if (id && name) rows.push({ id, name });
  });
  return { rows, skipped };
}

async function importText(c, text) {
  const { rows, skipped } = parseRoster(text);
  if (!rows.length) return alert('檔案沒有可匯入的資料 Nothing to import');
  const res = await act('teacher:add-students', { courseId: c.id, students: rows });
  if (!res) return;
  const dup = rows.length - res.added;
  alert(`已匯入 ${res.added} 位學生${skipped ? `（略過標題列 ${skipped} 行）` : ''}${dup > 0 ? `，${dup} 筆學號重複已略過` : ''}`);
}

/* ===== Event delegation ===== */
const app = document.getElementById('app');
const needCourse = () => { const c = cur(); if (!c) { alert('請先選擇或建立課程 Select a course first'); return null; } return c; };

app.addEventListener('submit', e => {
  const a = e.target.dataset.act;
  if (!a) return;
  e.preventDefault();
  const f = e.target;

  if (a === 'login-teacher') {
    return act('login-teacher', { password: f.password.value }, { after: () => { loginMode = null; teacherPreviewMode = 'admin'; } });
  }
  if (a === 'login-student') {
    const c = cur();
    if (!c) return alert('請先選擇課程 Select a course');
    return act('login-student', { courseId: c.id, name: f.name.value.trim(), sid: f.sid.value.trim() },
      { after: () => { loginMode = null; } });
  }
  if (a === 'change-password') {
    const next = f.next.value;
    return act('teacher:change-password', { current: f.current.value, next },
      { after: () => alert('密碼已更新 Password updated') });
  }
  if (a === 'save-course') {
    const c = cur();
    return act('teacher:save-course', {
      id: c ? c.id : null,
      year: f.year.value.trim(), subject: f.subject.value.trim(),
      groupSize: Math.max(1, parseInt(f.groupSize.value) || 4),
      tolerance: Math.max(0, parseInt(f.tolerance.value) || 0),
      deadline: f.deadline ? f.deadline.value : (c ? (c.deadline || '') : ''),
    }).then(data => {
      if (!data) return;
      if (data.courseId && data.courseId !== state.currentId) {
        state.currentId = data.courseId;
        localStorage.setItem(CURRENT_KEY, data.courseId);
        render();
      }
      alert('課程設定已儲存 ✅ Course settings saved');
    });
  }
  if (a === 'add-notice') {
    const c = needCourse(); if (!c) return;
    const content = f.content.value.trim();
    if (!content) return alert('請輸入公告內容 Content required');
    return act('teacher:add-notice', { courseId: c.id, content },
      { after: () => { f.reset(); alert('公告已發布 ✅ Notice published'); } });
  }
  if (a === 'set-course-deadline') {
    const c = cur();
    if (!c) return;
    const deadlineVal = f.deadline ? f.deadline.value : '';
    return act('teacher:save-course', {
      id: c.id,
      year: c.year,
      subject: c.subject,
      groupSize: c.groupSize,
      tolerance: c.tolerance,
      deadline: deadlineVal,
    }, {
      after: () => alert('分組截止時間已更新 Grouping deadline updated'),
    });
  }
  if (a === 'set-all-eval') {
    const c = cur();
    if (!c) return;
    const deadline = f.evalDeadline.value;
    if (!deadline) return alert('請選擇評分截止時間');
    return act('teacher:set-all-peer-eval', { courseId: c.id, open: true, deadline },
      { after: () => alert('已成功為全體組長開放評分權限！') });
  }
  if (a === 'submit-peer-eval') {
    const c = cur(), s = me();
    if (!c || !s || !s.groupId) return;
    const g = c.groups.find(x => x.id === s.groupId);
    if (!g) return;
    const mates = members(c, g.id).filter(m => m.id !== s.id);
    const evaluations = mates.map(m => {
      const key = keyOf(m);
      const sel = f[`penalty_${key}`];
      const inp = f[`comment_${key}`];
      return {
        studentId: key,
        penalty: sel ? parseInt(sel.value) || 0 : 0,
        comment: inp ? inp.value.trim() : '',
      };
    });
    if (!confirm('確定送出組員貢獻度評分？送出後您（組長）將獲得 10 分加分，組員加分也將即時生效。')) return;
    return act('submit-peer-eval', { evaluations },
      { after: () => alert('期末評分已成功送出！組長已獲得 10 分加分，組員加分亦已同步更新。') });
  }
  if (a === 'add-student') {
    const c = needCourse(); if (!c) return;
    return act('teacher:add-students', { courseId: c.id, students: [{ id: f.id.value.trim(), name: f.name.value.trim() }] });
  }
  if (a === 'mark-attendance') {
    const c = cur();
    if (!c) return;
    const sessionId = f.dataset.session;
    const groupId = f.dataset.group;
    if (!sessionId || !groupId) return;

    const group = c.groups.find(x => x.id === groupId);
    const targetMates = group ? members(c, group.id) : [];

    const missingNames = [];
    const records = [];

    for (const m of targetMates) {
      const checked = f.querySelector(`input[name="att_${CSS && CSS.escape ? CSS.escape(m.id) : m.id}"]:checked`);
      if (!checked) {
        missingNames.push(m.name);
      } else {
        records.push({ studentId: m.id, status: checked.value });
      }
    }

    if (missingNames.length > 0) {
      alert(`請為所有成員點名！以下成員尚未選擇出缺席狀態：\n\n${missingNames.join('、')}\n\nPlease record attendance for all members!\nVui lòng điểm danh cho tất cả thành viên!`);
      return;
    }

    return act('mark-attendance', {
      courseId: c.id,
      sessionId,
      groupId,
      records,
    }, {
      after: () => alert('點名紀錄已成功儲存！✅ Attendance saved'),
    });
  }
  if (a === 'change-student-password') {
    const current = f.current.value;
    const next = f.next.value;
    if (next.length < 4) return alert('新密碼長度至少需 4 碼 Password at least 4 chars');
    return act('change-student-password', { current, next }, {
      after: () => {
        f.reset();
        alert('幹部密碼修改成功！下次登入請使用新密碼。✅ Password updated');
      },
    });
  }
});

app.addEventListener('click', e => {
  const btn = e.target.closest('[data-act]');
  if (!btn || btn.tagName === 'INPUT' || btn.tagName === 'SELECT' || btn.tagName === 'FORM') return;
  const a = btn.dataset.act, id = btn.dataset.id;
  const c = cur();

  if (a === 'switch-preview') {
    teacherPreviewMode = btn.dataset.mode || 'admin';
    localStorage.setItem(PREVIEW_KEY, teacherPreviewMode);
    return render();
  }
  if (a === 'logout') {
    return act('logout', {}, {
      after: () => {
        loginMode = null;
        teacherView = 'course';
        teacherPreviewMode = 'admin';
        localStorage.removeItem(PREVIEW_KEY);
      }
    });
  }
  if (a === 'show-teacher-login') { e.preventDefault(); loginMode = loginMode === 'teacher' ? null : 'teacher'; return render(); }
  if (a === 'show-student-login') { e.preventDefault(); loginMode = loginMode === 'student' ? null : 'student'; return render(); }
  if (a === 'close-login') { loginMode = null; return render(); }
  if (a === 'sys-password') { teacherView = 'settings'; return render(); }
  if (a === 'sys-attendance') { teacherView = 'attendance'; return render(); }
  if (a === 'sys-peer-eval') { teacherView = 'eval'; return render(); }
  if (a === 'sys-logs') {
    teacherView = 'logs';
    if (c) loadLogsForCourse(c.id);
    return render();
  }
  if (a === 'goto-course-setup') {
    if (id) state.currentId = id;
    teacherView = 'course';
    localStorage.setItem(CURRENT_KEY, state.currentId);
    return render();
  }
  if (a === 'goto-course-attendance') {
    if (id) state.currentId = id;
    teacherView = 'attendance';
    localStorage.setItem(CURRENT_KEY, state.currentId);
    return render();
  }
  if (a === 'goto-course-logs') {
    if (id) state.currentId = id;
    teacherView = 'logs';
    localStorage.setItem(CURRENT_KEY, state.currentId);
    loadLogsForCourse(state.currentId);
    return render();
  }
  if (a === 'pick-course-node' || a === 'pick-course') {
    state.currentId = id || btn.value;
    if (teacherView !== 'eval' && teacherView !== 'logs' && teacherView !== 'attendance') {
      teacherView = 'course';
    } else if (teacherView === 'logs') {
      loadLogsForCourse(state.currentId);
    }
    localStorage.setItem(CURRENT_KEY, state.currentId);
    return render();
  }
  if (a === 'new-course') { state.currentId = null; teacherView = 'course'; return render(); }

  if (a === 'del-course') {
    const target = state.courses.find(x => x.id === id);
    if (!target || !confirm(`確定刪除「${courseLabel(target)}」及其名單與分組？`)) return;
    return act('teacher:del-course', { courseId: id });
  }
  if (a === 'del-notice') {
    if (!c) return;
    if (!confirm('確定刪除此則公告？')) return;
    return act('teacher:del-notice', { courseId: c.id, noticeId: id });
  }
  if (a === 'del-student') {
    if (!c) return;
    return act('teacher:del-student', { courseId: c.id, studentId: id });
  }
  if (a === 'make-groups') {
    if (!c) return;
    if (!c.students.length) return alert('請先匯入學生名單 Import roster first');
    if (!confirm('將重建組別並清空現有分組，確定？\n\n系統將自動備份當前狀態，稍後如有需要可點擊「回到上一步」復原。')) return;
    return act('teacher:make-groups', { courseId: c.id });
  }
  if (a === 'make-remaining-groups') {
    if (!c) return;
    const unassigned = c.students.filter(s => !s.groupId);
    if (!unassigned.length) return alert('目前所有學生皆已分組，無未分組學生 No unassigned students');
    const needCount = Math.max(1, Math.ceil(unassigned.length / Math.max(1, c.groupSize)));
    if (!confirm(`目前有 ${unassigned.length} 位未分組學生，預計依每組 ${c.groupSize} 人建立 ${needCount} 個新組別。\n\n已建立之現有組別與成員將完全保留，確定建立？`)) return;
    return act('teacher:make-remaining-groups', { courseId: c.id });
  }
  if (a === 'restore-snapshot') {
    if (!c) return;
    if (!confirm(`確定要回到上一步？\n\n這將會復原上次清空或建立組別前的所有組別、組長與分組狀態！`)) return;
    return act('teacher:restore-groups-snapshot', { courseId: c.id },
      { after: () => alert('已成功回到上一步，分組狀態已復原！') });
  }
  if (a === 'add-group') { if (!c) return; return act('teacher:add-group', { courseId: c.id }); }
  if (a === 'clear-groups') {
    if (!c) return;
    if (!c.groups.length) return alert('本科目尚無分組 No groups to clear');
    if (!confirm(`確定刪除「${courseLabel(c)}」的所有分組？\n\n注意：學生名單與課程設定皆會完整保留，僅清空組別與組別分配。\n系統將自動備份，稍後如有需要可點擊「回到上一步」復原。`)) return;
    return act('teacher:clear-groups', { courseId: c.id });
  }
  if (a === 'select-all-del-groups') {
    document.querySelectorAll('input[name="del_group_cb"]').forEach(cb => { cb.checked = true; });
    return;
  }
  if (a === 'unselect-all-del-groups') {
    document.querySelectorAll('input[name="del_group_cb"]').forEach(cb => { cb.checked = false; });
    return;
  }
  if (a === 'del-selected-groups') {
    if (!c) return;
    const checked = Array.from(document.querySelectorAll('input[name="del_group_cb"]:checked')).map(cb => cb.value);
    if (!checked.length) return alert('請先勾選欲刪除的組別 Please select at least one group');
    if (!confirm(`確定要刪除勾選的 ${checked.length} 個組別？\n\n被刪組別的組員將退回未分組名單，其餘組別與修課名單不受影響。`)) return;
    return act('teacher:del-groups', { courseId: c.id, groupIds: checked });
  }
  if (a === 'auto-assign') {
    if (!c) return;
    const unassignedList = c.students.filter(s => !s.groupId);
    if (!unassignedList.length) return alert('目前所有學生皆已分組，無未分組學生 No unassigned students');
    const min = minCap(c);
    const completedCount = c.groups.filter(g => members(c, g.id).length >= min).length;
    const incompleteCount = c.groups.length - completedCount;
    if (!confirm(`確定要隨機分配剩餘的 ${unassignedList.length} 位未分組學生？\n\n📌 規則說明：\n• 系統將嚴格避開已達門檻（${min}人）的 ${completedCount} 個已完成組別，絕不更動其成員與名單。\n• 僅分配至未達門檻的 ${incompleteCount} 個組別；若現有組別皆已完成，系統將自動為剩餘組員建立新組別收納。`)) return;
    return act('teacher:auto-assign', { courseId: c.id },
      { after: () => alert('已成功完成剩餘學生隨機分配！已完成編組的組別成員完全保持不變。') });
  }
  if (a === 'toggle-group-edit') {
    if (!c) return;
    const allowEdit = btn.dataset.allow === '1';
    return act('teacher:toggle-group-edit', { courseId: c.id, groupId: id, allowEdit });
  }
  if (a === 'reopen-group-modal') {
    if (!c) return;
    const targetGroup = c.groups.find(x => x.id === id);
    if (!targetGroup) return;
    const defaultTime = targetGroup.editDeadline || new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 16);
    const newDeadline = prompt(`請設定【${targetGroup.name}】組長重新挑選組員的新截止時間：\n(格式: YYYY-MM-DDTHH:mm，例如 ${defaultTime}；若不設期限請按確定保留空值或取消)`, defaultTime);
    if (newDeadline === null) return; // 使用者按取消
    return act('teacher:toggle-group-edit', {
      courseId: c.id,
      groupId: id,
      allowEdit: true,
      editDeadline: newDeadline.trim(),
    }, {
      after: () => alert(`已成功重新開放【${targetGroup.name}】組長挑選組員！${newDeadline ? `\n新截止時間為：${newDeadline.replace('T', ' ')}` : ''}`),
    });
  }
  if (a === 'close-all-eval') {
    if (!c) return;
    if (!confirm('確定關閉全體組長的評分權限？')) return;
    return act('teacher:set-all-peer-eval', { courseId: c.id, open: false },
      { after: () => alert('已關閉全體組長評分權限。') });
  }
  if (a === 'toggle-single-eval') {
    if (!c) return;
    const open = btn.dataset.open === '1';
    const targetGroup = c.groups.find(x => x.id === id);
    let deadline = targetGroup ? targetGroup.peerEvalDeadline : '';
    if (open && !deadline) {
      deadline = prompt('請輸入該組評分截止時間 (格式: YYYY-MM-DDTHH:mm，例如 2026-06-30T23:59)：', new Date(Date.now() + 7*86400000).toISOString().slice(0, 16));
      if (!deadline) return;
    }
    return act('teacher:set-peer-eval', { courseId: c.id, groupId: id, open, deadline });
  }
  if (a === 'refresh-course-logs') {
    if (!c) return;
    return loadLogsForCourse(c.id, true);
  }
  if (a === 'export-json') return c && exportJSON(c);
  if (a === 'export-csv') return c && exportCSV(c);
  if (a === 'export-logs-csv') return c && exportLogsCSV(c);
  if (a === 'clear-course-logs') {
    if (!c) return;
    if (!confirm(`確定清空「${courseLabel(c)}」的所有分組異動日誌紀錄？\n\n注意：此操作無法復原。`)) return;
    return act('teacher:clear-logs', { courseId: c.id },
      { after: () => {
        delete courseLogsCache[c.id];
        loadLogsForCourse(c.id, true);
        alert('分組異動日誌已清空 ✅ Activity logs cleared');
      }});
  }

  if (a === 'claim-leader') return act('claim-leader');
  if (a === 'unclaim-leader') return act('unclaim-leader');
  if (a === 'toggle-vice') return act('toggle-vice', { studentId: id });
  if (a === 'drop') return act('drop', { studentId: id });

  // 缺席明細彈窗互動
  if (a === 'view-absence-detail') {
    if (!c) return;
    const targetStudent = (c.students || []).find(s => s.id === id || s.sid === id);
    if (targetStudent) {
      activeAbsenceModal = { course: c, student: targetStudent };
      return render();
    }
  }
  if (a === 'close-absence-modal') {
    activeAbsenceModal = null;
    return render();
  }
  if (a === 'close-absence-modal-bg') {
    if (!e.target.closest('.absence-modal-content')) {
      activeAbsenceModal = null;
      return render();
    }
  }

  // 出缺席看板過濾
  if (a === 'filter-public-absence') {
    publicAbsenceFilter = btn.dataset.filter || 'all';
    return render();
  }
  if (a === 'filter-teacher-absence-range') {
    teacherAbsenceRange = btn.dataset.range || 'all';
    return render();
  }

  // 老師點名時段管理
  if (a === 'add-attendance-session-btn') {
    if (!c) return;
    const title = prompt('請輸入集會/點名時段名稱 (例: 期中成果發表會點名、系週會):');
    if (!title || !title.trim()) return;
    const date = prompt('請輸入點名日期 (格式: YYYY-MM-DD):', todayDateStr());
    if (!date || !date.trim()) return;
    const slot = prompt('請輸入節次或時間備註 (選填，例如: 第 3-4 節、14:00-16:00):', '');
    return act('teacher:save-attendance-session', {
      courseId: c.id,
      name: title.trim(),
      date: date.trim(),
      timeSlot: slot ? slot.trim() : '',
    }, {
      after: () => alert('點名時段已新增 ✅ Session added'),
    });
  }
  if (a === 'edit-attendance-session-btn') {
    if (!c) return;
    const sessId = btn.dataset.session;
    const oldName = btn.dataset.name || '';
    const oldDate = btn.dataset.date || '';
    const oldSlot = btn.dataset.slot || '';

    const name = prompt('修改時段名稱:', oldName);
    if (!name || !name.trim()) return;
    const date = prompt('修改點名日期 (格式: YYYY-MM-DD):', oldDate);
    if (!date || !date.trim()) return;
    const timeSlot = prompt('修改節次或時間備註 (選填):', oldSlot);

    return act('teacher:save-attendance-session', {
      courseId: c.id,
      id: sessId,
      name: name.trim(),
      date: date.trim(),
      timeSlot: timeSlot ? timeSlot.trim() : '',
    }, {
      after: () => alert('點名時段已更新 ✅ Session updated'),
    });
  }
  if (a === 'del-attendance-session-btn') {
    if (!c) return;
    const sessId = btn.dataset.session;
    if (!confirm('確定刪除此點名時段？該時段之所有組員出缺席紀錄亦將一併刪除且無法復原。')) return;
    return act('teacher:del-attendance-session', {
      courseId: c.id,
      sessionId: sessId,
    }, {
      after: () => alert('點名時段已刪除 ✅ Session deleted'),
    });
  }

  // 老師全班補登控制
  if (a === 'unlock-all-attendance') {
    if (!c) return;
    const sessId = btn.dataset.session;
    const defaultDeadline = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 16);
    const deadline = prompt('請設定開放補登截止時間 (格式: YYYY-MM-DDTHH:mm，例如 2026-09-30T23:59)：\n留空表示不設截止時間。', defaultDeadline);
    if (deadline === null) return;
    return act('teacher:set-attendance-unlock', {
      courseId: c.id,
      sessionId: sessId,
      groupId: '',
      allow: true,
      deadline: deadline ? deadline.trim() : '',
    }, {
      after: () => alert('已為全班開放補登點名權限！🔓'),
    });
  }
  if (a === 'lock-all-attendance') {
    if (!c) return;
    const sessId = btn.dataset.session;
    if (!confirm('確定關閉全班該時段的補登權限？關閉後組長無法再修改紀錄。')) return;
    return act('teacher:set-attendance-unlock', {
      courseId: c.id,
      sessionId: sessId,
      groupId: '',
      allow: false,
    }, {
      after: () => alert('已關閉全班補登權限 🔒'),
    });
  }

  // 幹部密碼救援與設定
  if (a === 'teacher-set-student-password') {
    if (!c) return;
    const sName = btn.dataset.name || '';
    const newPass = prompt(`為「${sName} (${id})」設定新密碼（至少 4 碼）：`);
    if (!newPass) return;
    if (newPass.trim().length < 4) return alert('密碼長度至少需 4 碼！');
    return act('teacher:change-student-password', {
      courseId: c.id,
      studentId: id,
      next: newPass.trim(),
    }, {
      after: () => alert(`已成功為 ${sName} 設定新密碼 ✅`),
    });
  }
  if (a === 'teacher-reset-student-password') {
    if (!c) return;
    const sName = btn.dataset.name || '';
    if (!confirm(`確定將「${sName} (${id})」的登入密碼重設為其預設學號？`)) return;
    return act('teacher:change-student-password', {
      courseId: c.id,
      studentId: id,
      resetToDefault: true,
    }, {
      after: () => alert(`已將 ${sName} 密碼重設為預設學號 ✅`),
    });
  }

  // 撤銷跨組代理
  if (a === 'revoke-delegate') {
    if (!c) return;
    const sessId = btn.dataset.session;
    const groupId = btn.dataset.group;
    const delegateId = btn.dataset.delegate;
    if (!confirm('確定撤銷此跨組代理權限？')) return;
    return act('teacher:set-attendance-delegate', {
      courseId: c.id,
      sessionId: sessId,
      groupId,
      delegateId,
      allow: false,
    }, {
      after: () => alert('已撤銷該代理人 ✅'),
    });
  }
});

app.addEventListener('input', e => {
  if (e.target && e.target.id === 'log-search-input') {
    filterLogRows();
  }
});

app.addEventListener('change', e => {
  const t = e.target;
  if (t && t.id === 'log-filter-action') {
    return filterLogRows();
  }

  // 點名單選按鈕即時動態樣式切換
  if (t.type === 'radio' && t.name && t.name.startsWith('att_')) {
    const parent = t.closest('.att-radio-group');
    if (parent) {
      parent.querySelectorAll('.att-radio-pill').forEach(pill => {
        pill.classList.remove('checked-present', 'checked-absent');
      });
      const currentPill = t.closest('.att-radio-pill');
      if (currentPill) {
        currentPill.classList.add(t.value === 'present' ? 'checked-present' : 'checked-absent');
      }
    }
  }

  const a = t.dataset.act;
  if (!a) return;
  const id = t.dataset.id;
  const c = cur();

  // 老師針對指定組別開放補登
  if (a === 'teacher-unlock-group-select') {
    if (!c) return;
    const groupId = t.value;
    if (!groupId) return;
    const sessId = t.dataset.session;
    const grp = c.groups.find(g => g.id === groupId);
    const grpName = grp ? grp.name : groupId;
    const defaultDeadline = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 16);
    const deadline = prompt(`請設定為【${grpName}】開放補登的截止時間 (YYYY-MM-DDTHH:mm)：\n留空表示不設截止時間。`, defaultDeadline);
    if (deadline === null) {
      t.value = '';
      return;
    }
    return act('teacher:set-attendance-unlock', {
      courseId: c.id,
      sessionId: sessId,
      groupId,
      allow: true,
      deadline: deadline ? deadline.trim() : '',
    }, {
      after: () => alert(`已為【${grpName}】開放補登權限！🔓`),
    });
  }

  // 老師指派跨組代理人
  if (a === 'assign-delegate-select') {
    if (!c) return;
    const delegateId = t.value;
    if (!delegateId) return;
    const sessId = t.dataset.session;
    const groupId = t.dataset.group;
    const grp = c.groups.find(g => g.id === groupId);
    const grpName = grp ? grp.name : groupId;
    const officer = c.students.find(s => s.id === delegateId);
    const officerName = officer ? officer.name : delegateId;
    if (!confirm(`確定指派 ${officerName} (${delegateId}) 代理【${grpName}】點名？`)) {
      t.value = '';
      return;
    }
    return act('teacher:set-attendance-delegate', {
      courseId: c.id,
      sessionId: sessId,
      groupId,
      delegateId,
      allow: true,
    }, {
      after: () => alert(`已成功指派 ${officerName} 代理點名！✅`),
    });
  }

  // 看板 3: 日期切換
  if (a === 'pick-teacher-absence-date') {
    teacherAbsenceDate = t.value || todayDateStr();
    return render();
  }

  // 看板 4: 監控時段切換
  if (a === 'pick-teacher-incomplete-session') {
    teacherIncompleteSessionId = t.value;
    return render();
  }

  if (a === 'pick-course') {
    state.currentId = t.value;
    localStorage.setItem(CURRENT_KEY, state.currentId);
    return render();
  }
  if (a === 'import-file') {
    if (!needCourse()) return;
    const file = t.files[0];
    if (!file) return;
    const r = new FileReader();
    r.onload = ev => importText(cur(), ev.target.result);
    return r.readAsText(file);
  }
  if (!c) return;
  if (a === 'assign-student') return act('teacher:assign-student', { courseId: c.id, studentId: id, groupId: t.value || null });
  if (a === 'set-leader') return act('teacher:set-leader', { courseId: c.id, studentId: id, on: t.checked });
  if (a === 'pick') return act('pick', { studentId: id });
});

/* ===== 啟動 ===== */
(async function start() {
  try {
    apply(await apiGet());
  } catch (err) {
    document.getElementById('app').innerHTML =
      `<div class="container"><div class="teacher-section"><h2>連線失敗 Connection error</h2>
       <p class="file-path">${String(err.message)}　請重新整理頁面。</p></div></div>`;
    return;
  }
  render();
  setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
})();
