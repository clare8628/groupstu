#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

// 取得台灣時間 (UTC+8)
const now = new Date(Date.now() + 8 * 3600 * 1000);
const pad = n => String(n).padStart(2, '0');
const yyyy = now.getUTCFullYear();
const mm = pad(now.getUTCMonth() + 1);
const dd = pad(now.getUTCDate());
const hh = pad(now.getUTCHours());
const min = pad(now.getUTCMinutes());

const verDate = `${yyyy}.${mm}.${dd}-${hh}${min}`;
const verNum = `${yyyy}${mm}${dd}${hh}${min}`;
const appVerString = `v2.6.3 (${verDate})`;

console.log(`[bump-version] 更新版本號為: ${appVerString} (快取標籤: ${verNum})`);

// 1. 更新 public/js/script.js
const scriptPath = path.join(root, 'public', 'js', 'script.js');
if (fs.existsSync(scriptPath)) {
  let content = fs.readFileSync(scriptPath, 'utf8');
  content = content.replace(/const APP_VERSION = '[^']+';/, `const APP_VERSION = '${appVerString}';`);
  fs.writeFileSync(scriptPath, content, 'utf8');
  console.log(`  ✓ 已更新 public/js/script.js`);
}

// 2. 更新 public/index.html
const indexPath = path.join(root, 'public', 'index.html');
if (fs.existsSync(indexPath)) {
  let content = fs.readFileSync(indexPath, 'utf8');
  content = content.replace(/href="css\/styles\.css(\?v=[^"]+)?"/, `href="css/styles.css?v=${verNum}"`);
  content = content.replace(/src="js\/script\.js(\?v=[^"]+)?"/, `src="js/script.js?v=${verNum}"`);
  fs.writeFileSync(indexPath, content, 'utf8');
  console.log(`  ✓ 已更新 public/index.html`);
}

// 3. 更新 src/api.js
const apiPath = path.join(root, 'src', 'api.js');
if (fs.existsSync(apiPath)) {
  let content = fs.readFileSync(apiPath, 'utf8');
  if (content.includes('const API_VERSION =')) {
    content = content.replace(/const API_VERSION = '[^']+';/, `const API_VERSION = '${appVerString}';`);
  } else {
    content = `export const API_VERSION = '${appVerString}';\n` + content;
  }
  fs.writeFileSync(apiPath, content, 'utf8');
  console.log(`  ✓ 已更新 src/api.js`);
}
