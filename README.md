# 學生分組系統 Student Grouping

課堂分組系統：老師管理課程與名單，學生自行擔任組長並挑選組員，前台即時顯示分組現況。

- 前端：原生 HTML / CSS / JavaScript（無框架）
- 後端：Cloudflare Pages Functions + D1（SQLite）
- 資料共用：所有使用者連到同一個 D1 資料庫，任何人的異動其他人皆可看到（前台每 5 秒輪詢）

## 功能

**前台（訪客／學生）**
- 左側樹狀清單依「學年度 → 科目」選擇課程
- 各組獨立卡片呈現，組長置頂、副組長次之，另闢「未分組名單」區
- 學生以「姓名（帳號）+ 學號（密碼）」登入
- 學生可自行標示為組長（未分組者自動開一組）、挑選組員、標記副組長、移出組員

**後台（老師）**
- 左側課程樹：切換／新增／刪除課程
- 課程設定：學年度、科目、每組人數、誤差人數 ±、分組時限
- 修課名單：匯入 .txt/.csv（標題列自動略過、重複學號略過）、手動增刪、指定組別與組長
- 分組管理：建立空組別、新增單組、隨機分配剩餘、清除本科目所有分組
- 逾時未被挑選者自動隨機分配並標示「自動」
- 匯出 JSON / CSV（含 BOM，Excel 中文不亂碼）
- 可修改老師登入密碼（預設 `teacher123`，以 SHA-256 存於 D1）

## 安全性

- 老師密碼雜湊後存於 D1，登入後以 HMAC 簽章 cookie 維持 12 小時工作階段
- 學號同時是學生密碼，因此**對非老師一律遮蔽**（顯示 `410***`）；組長操作改用不可逆代號 `ref`
- 所有權限在伺服器端驗證：老師操作需老師 session，挑選組員需該組組長身分，逾時後一律拒絕
- 已知限制：姓名公開可見、學號可被暴力猜測，正式對外使用建議改用校方 SSO 或一次性驗證碼

## 架構

```
index.html            外殼，掛載 #app
js/script.js          前端全部邏輯（事件委派 + 每 5 秒輪詢）
css/styles.css        樣式，支援 RWD
functions/api/state.js   GET  /api/state   讀取全部課程／名單／分組
functions/api/action.js  POST /api/action  所有異動，依角色驗證
functions/api/_lib.js    共用工具：session、雜湊、遮蔽、逾時自動分配
schema.sql            D1 資料表
wrangler.toml         Pages 設定與 D1 binding
```

## 部署（Cloudflare Pages）

1. 建立 D1 資料庫並套用 schema：

```bash
npx wrangler d1 create groupstu
npx wrangler d1 execute groupstu --remote --file=schema.sql
```

2. 把 `wrangler.toml` 內的 `database_id` 換成上一步輸出的 ID。
3. Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git，
   選擇本 repo，專案名稱 `groupstu`，Production branch `main`，
   Framework preset **None**、Build command 留空、Build output directory `/`。
   `wrangler.toml` 內的 D1 binding（`DB`）會自動套用。

## 本機開發

```bash
npx wrangler d1 execute groupstu --local --file=schema.sql
npx wrangler pages dev
# http://localhost:8788
```

> 注意：本版需要 Pages Functions 才能運作，直接開啟 `index.html` 或用靜態伺服器會無法讀取資料。
