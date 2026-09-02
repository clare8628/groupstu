/* 學生分組程式 Student Grouping — 單頁前端，狀態存於 localStorage */
const APP_NAME = '學生分組系統';
const APP_VERSION = 'v1.2.0';   // 顯示於前台標題列
const KEY = 'student_grouping_v2';
const OLD_KEY = 'student_grouping_v1';

const newCourse = (year, subject) => ({
  id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
  year: year || '', subject: subject || '',
  groupSize: 4, tolerance: 1, deadline: '',
  students: [], groups: [],
});

const defaultState = () => ({
  teacherPassword: 'teacher123',
  courses: [],
  currentId: null,      // 後台/前台目前檢視的課程
  session: null,        // {role:'teacher'} | {role:'student', id, courseId}
});

let state = load();
let loginMode = null;   // 前台登入區：null | 'student' | 'teacher'

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = Object.assign(defaultState(), JSON.parse(raw));
      if (!s.teacherPassword) s.teacherPassword = 'teacher123';
      s.courses.forEach(c => c.students.forEach(x => delete x.email));
      return s;
    }
    const old = JSON.parse(localStorage.getItem(OLD_KEY) || 'null');   // 舊版單一課程資料搬移
    if (old && (old.students || []).length) {
      const s = defaultState();
      s.teacherPassword = old.teacherPassword || 'teacher123';
      const c = Object.assign(newCourse(old.year, old.subject), {
        groupSize: old.groupSize || 4, tolerance: old.tolerance || 1, deadline: old.deadline || '',
        students: old.students.map(x => { delete x.email; return x; }), groups: old.groups || [],
      });
      s.courses = [c]; s.currentId = c.id;
      return s;
    }
  } catch (e) { /* fallthrough */ }
  return defaultState();
}
function save() { localStorage.setItem(KEY, JSON.stringify(state)); }

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
const rank = s => s.isLeader ? 0 : s.isVice ? 1 : 2;
/* 組長排最前、副組長次之，其餘維持名單順序 */
const members = (c, gid) => c.students.filter(s => s.groupId === gid)
  .map((s, i) => ({ s, i }))
  .sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i)
  .map(x => x.s);
const unassigned = c => c.students.filter(s => !s.groupId);
const findStudent = (c, id) => c.students.find(s => s.id === id);
const leaderOf = (c, gid) => members(c, gid).find(s => s.isLeader);
function me() {
  const c = cur();
  return (c && state.session && state.session.role === 'student') ? findStudent(c, state.session.id) : null;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const deadlinePassed = c => !!c.deadline && Date.now() > new Date(c.deadline).getTime();

/* 超過時限：未被挑選的學生自動隨機分配，並標示自動分組 */
function checkDeadlines() {
  state.courses.forEach(c => {
    if (deadlinePassed(c) && c.groups.length && unassigned(c).length) autoAssign(c, true);
  });
}

function autoAssign(c, markAuto) {
  if (!c.groups.length) return;
  shuffle(unassigned(c).slice()).forEach(s => {
    const target = c.groups.slice().sort((a, b) => members(c, a.id).length - members(c, b.id).length)[0];
    if (!target || members(c, target.id).length >= cap(c)) return;
    s.groupId = target.id;
    s.autoAssigned = !!markAuto;
  });
  save();
}

function makeGroups(c) {
  const n = Math.max(1, Math.ceil(c.students.length / Math.max(1, c.groupSize)));
  c.groups = Array.from({ length: n }, (_, i) => ({ id: 'g' + (i + 1), name: '第 ' + (i + 1) + ' 組' }));
  c.students.forEach(s => { s.groupId = null; s.isLeader = false; s.isVice = false; s.autoAssigned = false; });
  save();
}

function addGroup(c) {
  const g = { id: 'g' + Date.now().toString(36), name: '第 ' + (c.groups.length + 1) + ' 組' };
  c.groups.push(g);
  return g;
}

/* ===== 前台分組現況 ===== */
function publicBoard() {
  const c = cur();
  if (!c) return `<div class="board"><h2>分組現況 Group status</h2><p class="file-path">請先選擇課程。Select a course above.</p></div>`;
  const pool = unassigned(c);
  const self = me();
  return `
  <div class="board">
    <h2>分組現況 Group status <small>${esc(courseLabel(c))}</small></h2>
    ${c.groups.length ? `<div class="group-grid">${c.groups.map(g => {
      const list = members(c, g.id);
      const lead = leaderOf(c, g.id);
      const autoCount = list.filter(s => s.autoAssigned).length;
      const full = list.length >= cap(c);
      return `<div class="group-card ${self && self.groupId === g.id ? 'mine' : ''}">
        ${autoCount ? `<span class="tag">自動 ${autoCount}</span>` : ''}
        <h3>${esc(g.name)} <small>${list.length}/${cap(c)} 人${full ? ' · 已滿' : ''}</small></h3>
        <p class="file-path">組長 Leader: ${lead ? esc(lead.name) : '尚未產生 — none'}</p>
        <div class="students">${list.length ? list.map(s => `
          <div class="student ${s.isLeader ? 'leader' : ''} ${s.isVice ? 'vice-leader' : ''}">
            ${esc(s.name)} (${esc(s.id)})${s.isLeader ? ' — 組長' : s.isVice ? ' — 副組長' : ''}${s.autoAssigned ? ' · 自動' : ''}
          </div>`).join('') : '<div class="student">（尚無成員 Empty）</div>'}</div>
      </div>`;
    }).join('')}</div>` : '<p class="file-path">老師尚未建立組別，或由學生自行擔任組長開組。No groups yet.</p>'}

    <h2 style="margin-top:2rem">未分組名單 Unassigned (${pool.length})</h2>
    <div class="pick-list">${pool.length
      ? pool.map(s => `<div class="student">${esc(s.name)} (${esc(s.id)})</div>`).join('')
      : '<p class="file-path">全部學生皆已分組 Everyone is assigned.</p>'}</div>
  </div>`;
}

/* ===== Screens ===== */
function nav() {
  const c = cur();
  let center = '', right = '';
  if (state.session) {
    const who = state.session.role === 'teacher' ? '老師 Teacher' : esc((me() || {}).name || '');
    right = `<span class="who">${who}</span><button class="tab-btn" data-act="logout">登出 Logout</button>`;
  } else {
    center = `<a href="#login" class="student-link ${loginMode === 'student' ? 'on' : ''}" data-act="show-student-login">學生登入 Student login</a>`;
    right = `<a href="#login" class="teacher-link ${loginMode === 'teacher' ? 'on' : ''}" data-act="show-teacher-login">老師登入 Teacher login</a>`;
  }
  return `<nav>
    <span class="brand">
      <span class="logo">${APP_NAME}</span>
      <span class="ver">${APP_VERSION}</span>
    </span>
    ${c ? `<span class="course-tag">${esc(courseLabel(c))}</span>` : ''}
    <span class="center">${center}</span>
    <span class="tabs">${right}</span>
  </nav>`;
}

function loginCard() {
  if (loginMode === 'student') {
    const c = cur();
    return `<div class="login-bar" id="login">
      <form data-act="login-student" class="inline-form">
        <div class="form-group"><label>姓名 Name（帳號）</label><input name="name" placeholder="王小明" required autocomplete="off"></div>
        <div class="form-group"><label>學號 Student ID（密碼）</label><input type="password" name="sid" placeholder="410001" required autocomplete="off"></div>
        <button class="btn btn-primary" type="submit">登入 Sign in</button>
        <button class="tab-btn close" type="button" data-act="close-login" title="關閉 Close">✕</button>
      </form>
      <p class="file-path">登入課程：<b>${esc(c ? courseLabel(c) : '請先於左側選擇課程')}</b>　登入後可按「我要當組長」並挑選組員。</p>
    </div>`;
  }
  if (loginMode === 'teacher') {
    return `<div class="login-bar teacher" id="login">
      <form data-act="login-teacher" class="inline-form">
        <div class="form-group"><label>老師密碼 Teacher password</label><input type="password" name="password" required autocomplete="off"></div>
        <button class="btn btn-secondary" type="submit">老師登入 Teacher login</button>
        <button class="tab-btn close" type="button" data-act="close-login" title="關閉 Close">✕</button>
      </form>
    </div>`;
  }
  return '';
}

function authScreen() {
  return `${loginCard()}
  <div class="layout">${courseTreePublic()}<main>${publicBoard()}</main></div>`;
}

/* ---- 前台：使用說明 ---- */
function howto() {
  return `<div class="howto">
    <strong>使用方式 How it works</strong>
    <ol>
      <li>左側點選<b>學年度 → 科目</b>，即可查看該科目目前的分組狀態與未分組名單。</li>
      <li>想擔任<b>組長</b>者：輸入<b>姓名（帳號）</b>與<b>學號（密碼）</b>登入 → 按「我要當組長」→ 從未分組名單<b>挑選組員</b>、指定副組長。</li>
      <li>被挑選的同學不必操作；分組結果會即時顯示在下方各組卡片中。</li>
      <li>超過老師設定的<b>分組時限</b>仍未被挑選者，系統會隨機分配並標示「自動」。</li>
    </ol>
  </div>`;
}

/* ---- 前台：左側課程樹（學年度 → 科目） ---- */
function courseTreePublic() {
  const byYear = {};
  state.courses.forEach(c => {
    const y = c.year || '未分類 Unfiled';
    (byYear[y] = byYear[y] || []).push(c);
  });
  const years = Object.keys(byYear).sort().reverse();
  return `<aside class="tree">
    <h3>課程 Courses</h3>
    <p class="file-path">選擇學年度與科目查看分組</p>
    ${years.length ? years.map(y => `
      <div class="tree-year">
        <div class="tree-year-label">${esc(y)}</div>
        <ul>${byYear[y].map(c => `
          <li class="${state.currentId === c.id ? 'active' : ''}">
            <button data-act="pick-course-node" data-id="${c.id}">
              ${esc(c.subject || '（未命名科目）')}
              <span class="count">${c.students.length} 人 / ${c.groups.length} 組</span>
            </button>
          </li>`).join('')}</ul>
      </div>`).join('') : '<p class="file-path">老師尚未建立任何課程。No courses yet.</p>'}
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
  return `<aside class="tree">
    <h3>課程 Courses</h3>
    ${years.length ? years.map(y => `
      <div class="tree-year">
        <div class="tree-year-label">${esc(y)}</div>
        <ul>${byYear[y].map(c => `
          <li class="${state.currentId === c.id ? 'active' : ''}">
            <button data-act="pick-course-node" data-id="${c.id}">
              ${esc(c.subject || '（未命名科目）')}
              <span class="count">${c.students.length} 人 / ${c.groups.length} 組</span>
            </button>
          </li>`).join('')}</ul>
      </div>`).join('') : '<p class="file-path">尚無課程，請於右側「課程設定」建立。</p>'}
    <button class="btn btn-secondary" data-act="new-course">＋ 新增課程 New course</button>
  </aside>`;
}

function teacherScreen() {
  const c = cur();
  return `<div class="layout">${courseTree()}<main>${c ? teacherCourse(c) : teacherNoCourse()}${teacherPasswordBlock()}</main></div>`;
}

function teacherNoCourse() {
  return `
  <div class="teacher-section">
    <h2>課程設定 Course setup</h2>
    <p class="file-path">建立新課程：填寫學年度與科目名稱後儲存，會出現在左側樹狀清單。</p>
    ${courseForm(newCourse())}
  </div>`;
}

function courseForm(c) {
  return `<form data-act="save-course">
    <div class="form-row">
      <div class="form-group"><label>學年度 Academic year</label><input name="year" value="${esc(c.year)}" placeholder="114-1" required></div>
      <div class="form-group"><label>科目名稱 Subject</label><input name="subject" value="${esc(c.subject)}" placeholder="資料結構" required></div>
      <div class="form-group"><label>每組人數 Group size</label><input type="number" min="1" name="groupSize" value="${c.groupSize}"></div>
      <div class="form-group"><label>誤差人數 ± Tolerance</label><input type="number" min="0" name="tolerance" value="${c.tolerance}"></div>
      <div class="form-group full"><label>分組時限 Deadline</label><input type="datetime-local" name="deadline" value="${esc(c.deadline)}"></div>
    </div>
    <button class="btn btn-primary" type="submit">儲存 Save</button>
  </form>`;
}

function teacherCourse(c) {
  const total = c.students.length;
  const assigned = c.students.filter(s => s.groupId).length;
  return `
  <div class="teacher-section">
    <h2>課程設定 Course setup <small>${esc(courseLabel(c))}</small></h2>
    ${courseForm(c)}
    <button class="btn btn-danger" data-act="del-course" data-id="${c.id}">刪除整個科目（含名單與分組）Delete course</button>
  </div>

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

  <div class="teacher-section">
    <h2>分組管理 Grouping</h2>
    <div class="stats">
      <div class="stat"><div class="value">${total}</div><div class="label">總學生數 Students</div></div>
      <div class="stat"><div class="value">${c.groups.length}</div><div class="label">組別數 Groups</div></div>
      <div class="stat"><div class="value">${assigned}</div><div class="label">已分組 Assigned</div></div>
      <div class="stat"><div class="value">${total - assigned}</div><div class="label">未分組 Unassigned</div></div>
    </div>
    <div class="btn-row">
      <button class="btn btn-primary" data-act="make-groups">建立空組別 Create groups</button>
      <button class="btn btn-secondary" data-act="add-group">新增一組 Add group</button>
      <button class="btn btn-secondary" data-act="auto-assign">隨機分配剩餘 Auto-assign</button>
      <button class="btn btn-danger" data-act="clear-groups">清除本科目所有分組 Clear all groups</button>
      <button class="btn btn-secondary" data-act="export-json">匯出 JSON</button>
      <button class="btn btn-secondary" data-act="export-csv">匯出 CSV</button>
    </div>
    ${c.deadline ? `<p class="file-path">時限 Deadline: ${esc(c.deadline.replace('T', ' '))} — ${deadlinePassed(c) ? '已截止（未選學生已自動分配）Closed' : '進行中 Open'}</p>` : ''}
  </div>
  ${publicBoard()}`;
}

function teacherPasswordBlock() {
  return `
  <div class="teacher-section">
    <h2>登入密碼 Teacher password</h2>
    <form data-act="change-password" class="form-row">
      <div class="form-group"><label>目前密碼 Current</label><input type="password" name="current" required autocomplete="off"></div>
      <div class="form-group"><label>新密碼 New</label><input type="password" name="next" required minlength="4" autocomplete="off"></div>
      <div class="form-group full"><button class="btn btn-primary" type="submit">更新密碼 Update password</button></div>
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
    <thead><tr><th>學號 ID</th><th>姓名 Name</th><th>組別 Group</th><th>組長 Leader</th><th></th></tr></thead>
    <tbody>${c.students.map(s => `
      <tr>
        <td>${esc(s.id)}</td>
        <td>${esc(s.name)}${s.autoAssigned ? ' <span class="tag-inline auto">自動</span>' : ''}${s.isVice ? ' <span class="tag-inline">副組長</span>' : ''}</td>
        <td><select data-act="assign-student" data-id="${esc(s.id)}">${opts(s)}</select></td>
        <td><input type="checkbox" data-act="set-leader" data-id="${esc(s.id)}" ${s.isLeader ? 'checked' : ''} ${s.groupId ? '' : 'disabled'}></td>
        <td><button class="tab-btn" data-act="del-student" data-id="${esc(s.id)}">刪除</button></td>
      </tr>`).join('')}
    </tbody></table></div>`;
}

function studentScreen() {
  const c = cur(), s = me();
  if (!c || !s) { state.session = null; save(); return authScreen(); }
  const g = c.groups.find(x => x.id === s.groupId);
  const mates = g ? members(c, g.id) : [];
  const closed = deadlinePassed(c);
  const otherLeader = g ? mates.find(m => m.isLeader && m.id !== s.id) : null;

  let html = `
  <div class="student-section">
    <h2>${esc(courseLabel(c))}</h2>
    <div class="student-info">
      <strong>學生 Student:</strong> ${esc(s.name)} (${esc(s.id)})<br>
      <strong>角色 Role:</strong> ${s.isLeader ? '組長 Leader' : s.isVice ? '副組長 Vice leader' : '組員 Member'}<br>
      <strong>組別 Group:</strong> ${g ? esc(g.name) : '未分組 Unassigned'}${s.autoAssigned ? '（自動分配 Auto-assigned）' : ''}
    </div>`;

  if (closed) {
    html += '<p class="file-path">已超過分組時限，無法再變更。Deadline passed.</p>';
  } else if (s.isLeader) {
    html += `<button class="btn btn-secondary" data-act="unclaim-leader">取消組長身分 Step down</button>`;
  } else if (otherLeader) {
    html += `<p class="file-path">本組組長為 ${esc(otherLeader.name)}，無法重複擔任。Group already has a leader.</p>`;
  } else {
    html += `<button class="btn btn-primary" data-act="claim-leader">我要當組長 Become leader</button>
             <p class="file-path">${g ? '成為本組組長後即可挑選組員。' : '將自動為你開一組並擔任組長。'}</p>`;
  }

  if (s.isLeader && g && !closed) {
    const pool = unassigned(c);
    html += `
    <h3 style="margin-top:1.5rem">挑選組員 Pick members（上限 ${cap(c)} 人，目前 ${mates.length}）</h3>
    <div class="pick-list">${pool.length ? pool.map(p => `
      <label class="student"><input type="checkbox" data-act="pick" data-id="${esc(p.id)}"> ${esc(p.name)} (${esc(p.id)})</label>`).join('')
        : '<p class="file-path">目前沒有未分組的學生 No unassigned students.</p>'}</div>

    <h3 style="margin-top:1.5rem">本組成員 My members <small>（可標記副組長 Mark a vice leader）</small></h3>
    <div class="pick-list">${mates.map(m => `
      <div class="student ${m.isLeader ? 'leader' : ''} ${m.isVice ? 'vice-leader' : ''}">
        ${esc(m.name)} (${esc(m.id)})${m.isLeader ? ' — 組長' : m.isVice ? ' — 副組長' : ''}
        ${m.id !== s.id ? `
          <button class="tab-btn ${m.isVice ? 'on' : ''}" data-act="toggle-vice" data-id="${esc(m.id)}">
            ${m.isVice ? '取消副組長' : '設為副組長'}</button>
          <button class="tab-btn" data-act="drop" data-id="${esc(m.id)}">移出</button>` : ''}
      </div>`).join('')}</div>
    <p class="file-path">每組僅能有一位副組長，重新指定會自動取代前一位。One vice leader per group.</p>`;
  }
  return html + '</div>' + publicBoard();
}

/* ===== Render ===== */
function render() {
  checkDeadlines();
  const isFront = !state.session || state.session.role === 'student';
  const body = !state.session ? authScreen()
    : state.session.role === 'teacher' ? teacherScreen()
    : studentScreen();
  document.getElementById('app').innerHTML =
    nav() + '<div class="container">' + (isFront ? howto() : '') + body + '</div>';
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
  const rows = [['學號', '姓名', '組別', '角色', '自動分組']];
  c.students.forEach(s => {
    const g = c.groups.find(x => x.id === s.groupId);
    rows.push([s.id, s.name, g ? g.name : '', s.isLeader ? '組長' : s.isVice ? '副組長' : '組員', s.autoAssigned ? 'Y' : 'N']);
  });
  const csv = '﻿' + rows.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\n');
  download(csv, 'text/csv', `${c.year || 'grouping'}_${c.subject || 'data'}.csv`);
}

function download(content, type, filename) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* 標題列（學號 / 姓名 / ID / Name）自動略過 */
const isHeaderLine = line => /學號|學生證號|姓名|名字|student\s*(id|no)|^\s*id\b|\bname\b/i.test(line);

function importText(c, text) {
  let added = 0, skipped = 0;
  text.replace(/^﻿/, '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).forEach(line => {
    if (isHeaderLine(line)) { skipped++; return; }
    const [id, name] = line.split(/\s*[,\t|]\s*|\s+/).filter(Boolean);
    if (!id || !name || findStudent(c, id)) return;
    c.students.push({ id, name, groupId: null, isLeader: false, isVice: false, autoAssigned: false });
    added++;
  });
  save(); render();
  alert(`已匯入 ${added} 位學生${skipped ? `（略過標題列 ${skipped} 行）` : ''}\nImported ${added} students${skipped ? `, ${skipped} header line(s) skipped` : ''}`);
}

/* ===== Event delegation ===== */
const app = document.getElementById('app');
const needCourse = () => { const c = cur(); if (!c) alert('請先於左側選擇或建立課程 Select a course first'); return c; };

app.addEventListener('submit', e => {
  const act = e.target.dataset.act;
  if (!act) return;
  e.preventDefault();
  const f = e.target;
  if (act === 'login-teacher') {
    if (f.password.value !== state.teacherPassword) return alert('密碼錯誤 Wrong password');
    state.session = { role: 'teacher' }; loginMode = null;
  } else if (act === 'login-student') {
    const c = cur();
    if (!c) return alert('請先選擇課程 Select a course');
    const name = f.name.value.trim(), sid = f.sid.value.trim();
    const s = c.students.find(x => x.name === name && x.id === sid);
    if (!s) return alert('姓名或學號不正確，或不在本課程修課名單中\nName / student ID not found in this course');
    state.session = { role: 'student', id: s.id, courseId: c.id }; loginMode = null;
  } else if (act === 'change-password') {
    if (f.current.value !== state.teacherPassword) return alert('目前密碼錯誤 Current password is wrong');
    state.teacherPassword = f.next.value;
    save(); render();
    return alert('密碼已更新 Password updated');
  } else if (act === 'save-course') {
    const year = f.year.value.trim(), subject = f.subject.value.trim();
    let c = cur();
    if (!c) {
      c = state.courses.find(x => x.year === year && x.subject === subject) || newCourse();
      if (!state.courses.includes(c)) state.courses.push(c);
      state.currentId = c.id;
    }
    c.year = year; c.subject = subject;
    c.groupSize = Math.max(1, parseInt(f.groupSize.value) || 4);
    c.tolerance = Math.max(0, parseInt(f.tolerance.value) || 0);
    c.deadline = f.deadline.value;
  } else if (act === 'add-student') {
    const c = needCourse(); if (!c) return;
    const id = f.id.value.trim(), name = f.name.value.trim();
    if (findStudent(c, id)) return alert('學號已存在 Duplicate ID');
    c.students.push({ id, name, groupId: null, isLeader: false, isVice: false, autoAssigned: false });
  }
  save(); render();
});

app.addEventListener('click', e => {
  const btn = e.target.closest('[data-act]');
  if (!btn || btn.tagName === 'INPUT' || btn.tagName === 'SELECT' || btn.tagName === 'FORM') return;
  const act = btn.dataset.act, id = btn.dataset.id;
  const c = cur();
  if (act === 'logout') { state.session = null; loginMode = null; }
  else if (act === 'show-teacher-login') { e.preventDefault(); loginMode = loginMode === 'teacher' ? null : 'teacher'; }
  else if (act === 'show-student-login') { e.preventDefault(); loginMode = loginMode === 'student' ? null : 'student'; }
  else if (act === 'close-login') { loginMode = null; }
  else if (act === 'pick-course-node') { state.currentId = id; }
  else if (act === 'new-course') { state.currentId = null; }
  else if (act === 'del-course') {
    const target = courseById(id);
    if (!target || !confirm(`確定刪除「${courseLabel(target)}」及其名單與分組？`)) return;
    state.courses = state.courses.filter(x => x.id !== id);
    state.currentId = state.courses.length ? state.courses[0].id : null;
  }
  else if (act === 'del-student') { if (!c) return; c.students = c.students.filter(s => s.id !== id); }
  else if (act === 'make-groups') {
    if (!c) return;
    if (!c.students.length) return alert('請先匯入學生名單 Import roster first');
    if (!confirm('將重建組別並清空現有分組，確定？')) return;
    makeGroups(c);
  }
  else if (act === 'add-group') { if (!c) return; addGroup(c); }
  else if (act === 'clear-groups') {
    if (!c) return;
    if (!c.groups.length) return alert('本科目尚無分組 No groups to clear');
    if (!confirm(`確定清除「${courseLabel(c)}」的所有分組？學生名單會保留。`)) return;
    c.groups = [];
    c.students.forEach(x => { x.groupId = null; x.isLeader = false; x.isVice = false; x.autoAssigned = false; });
  }
  else if (act === 'auto-assign') {
    if (!c) return;
    if (!c.groups.length) return alert('請先建立組別 Create groups first');
    autoAssign(c, true);
  }
  else if (act === 'export-json') { return c && exportJSON(c); }
  else if (act === 'export-csv') { return c && exportCSV(c); }
  else if (act === 'claim-leader') {
    const s = me(); if (!s || !c) return;
    if (!s.groupId) {                                   // 未分組：自行開一組
      const empty = c.groups.find(g => !members(c, g.id).length) || addGroup(c);
      s.groupId = empty.id;
      s.autoAssigned = false;
    }
    if (leaderOf(c, s.groupId)) return alert('本組已有組長 This group already has a leader');
    s.isLeader = true; s.isVice = false;
  }
  else if (act === 'unclaim-leader') { const s = me(); if (s) s.isLeader = false; }
  else if (act === 'toggle-vice') {
    const self = me(); if (!self || !self.isLeader || !c) return;
    const target = findStudent(c, id);
    if (!target || target.groupId !== self.groupId) return;
    const wasVice = target.isVice;
    members(c, self.groupId).forEach(m => { m.isVice = false; });   // 每組僅一位副組長
    target.isVice = !wasVice;
  }
  else if (act === 'drop') {
    if (!c) return;
    const s = findStudent(c, id);
    if (s) { s.groupId = null; s.isVice = false; s.autoAssigned = false; }
  }
  else return;
  save(); render();
});

app.addEventListener('change', e => {
  const t = e.target;
  const act = t.dataset.act;
  if (!act) return;
  const id = t.dataset.id;
  const c = cur();
  if (act === 'pick-course') { state.currentId = t.value; save(); return render(); }
  if (act === 'import-file') {
    if (!needCourse()) return;
    const file = t.files[0];
    if (!file) return;
    const r = new FileReader();
    r.onload = ev => importText(cur(), ev.target.result);
    return r.readAsText(file);
  }
  if (!c) return;
  if (act === 'assign-student') {
    const s = findStudent(c, id);
    if (!s) return;
    if (t.value && members(c, t.value).length >= cap(c) && s.groupId !== t.value) { alert(`該組已達上限 ${cap(c)} 人`); }
    else { s.groupId = t.value || null; s.autoAssigned = false; if (!t.value) { s.isLeader = false; s.isVice = false; } }
  }
  else if (act === 'set-leader') {
    const s = findStudent(c, id);
    if (!s || !s.groupId) return;
    members(c, s.groupId).forEach(m => { if (m.id !== id) m.isLeader = false; });
    s.isLeader = t.checked;
    if (t.checked) s.isVice = false;
  }
  else if (act === 'pick') {
    const self = me(), s = findStudent(c, id);
    if (!self || !s) return;
    if (members(c, self.groupId).length >= cap(c)) { alert(`本組已達上限 ${cap(c)} 人`); }
    else { s.groupId = self.groupId; s.autoAssigned = false; }
  }
  else return;
  save(); render();
});

/* 其他分頁更新時，前台即時同步 */
window.addEventListener('storage', e => {
  if (e.key !== KEY) return;
  const session = state.session, currentId = state.currentId;
  state = load();
  state.session = session; state.currentId = currentId;
  render();
});

render();
