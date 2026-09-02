---
name: mydeploy
description: 把 groupstu（學生分組系統）推上 GitHub 並部署到 Cloudflare Worker，含前置檢查與上線驗證。Use when the user asks to deploy, ship, publish, 推上去, 部署, 上線 this project.
---

一次完成：檢查 → commit → push GitHub → deploy Cloudflare → 驗證線上。

## 專案座標

- 工作目錄：`/Users/clare/cowork/develop/groupstu`
- GitHub：`clare8628/groupstu`（分支 `main`）
- Cloudflare Worker：`groupstu` → https://groupstu.clare8628.workers.dev
- D1 資料庫：`groupstu`（binding `DB`），schema 在 `schema.sql`

## 硬性規則

1. **所有 git 指令都要帶 `-C /Users/clare/cowork/develop/groupstu`**，或先確認 `git rev-parse --show-toplevel` 等於該路徑。
   `/Users/clare` 本身是另一個 git repo（家目錄，含 `.ssh`、`.netrc`），**絕對不可以推送**。
2. **不要建立 Cloudflare Pages 專案**。帳號中已有同名 Worker，本專案一律走 Worker + static assets。
3. `schema.sql` 有異動時，**先套用到 remote D1 再部署**，否則線上會 500。
4. 不要把密碼、token 寫進 repo。老師密碼以 SHA-256 存於 D1，不進版本控制。

## 步驟

### 1. 前置檢查

```bash
cd /Users/clare/cowork/develop/groupstu
git rev-parse --show-toplevel          # 必須是本專案路徑
git status --short
node --check src/index.js && node --check src/api.js && node --check src/lib.js && node --check public/js/script.js
```

語法檢查沒過就停下來修，不要硬推。

### 2. schema 有改才做

```bash
npx wrangler d1 execute groupstu --remote --file=schema.sql -y
```

只加欄位／資料表；要刪改既有欄位，先確認線上資料可以捨棄再動手。

### 3. commit

沒有變更就跳過本步。commit 訊息用繁體中文，第一行摘要，空行後條列重點，結尾加：

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

### 4. push GitHub

```bash
git push origin main
```

### 5. 部署 Cloudflare

```bash
npx wrangler deploy
```

輸出會給網址與 Version ID，兩個都記下來回報。

### 6. 線上驗證（必做）

```bash
curl -s -o /dev/null -w "page:%{http_code}\n" https://groupstu.clare8628.workers.dev/
curl -s https://groupstu.clare8628.workers.dev/api/state | head -c 200
```

`page:200` 且 `/api/state` 回得出 JSON（`{"courses":[...],"session":null}`）才算成功。
若 `/api/state` 回 500，多半是 D1 binding 或 schema 沒同步 —— 回到步驟 2。

## 回報格式

給使用者：commit hash、GitHub 網址、Worker 網址與 Version ID、驗證結果（HTTP 狀態與 `/api/state` 是否正常）。
有跳過的步驟（例如沒有變更所以未 commit）要明講。
