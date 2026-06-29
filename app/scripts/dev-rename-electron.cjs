#!/usr/bin/env node
/**
 * Dev-only: macOS 下 dock 悬停名/菜单名来自正在运行的 Electron.app bundle 的
 * CFBundleName，而不是 app.setName()。所以 dev 跑 `electron .` 时 dock 显示
 * "Electron"。这里把 node_modules 里那个 Electron.app 的 Info.plist 名字改成
 * "Chaya"，并刷新 LaunchServices，让 dev 启动就显示 Chaya。
 *
 * 幂等：已是 Chaya 就跳过。每次 dev 启动 + postinstall 都会跑（重装后会被重置，
 * 所以要在启动前重新打）。非 macOS 直接 no-op。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

if (process.platform !== 'darwin') process.exit(0);

const APP_NAME = 'Chaya';

function electronAppContents() {
  // require('electron') 导出 Electron 可执行文件路径：…/Electron.app/Contents/MacOS/Electron
  let bin;
  try { bin = require('electron'); } catch { bin = null; }
  if (typeof bin === 'string' && bin.includes('.app/Contents/MacOS/')) {
    return bin.split('/Contents/MacOS/')[0] + '/Contents';
  }
  // 兜底：在 node_modules 里找
  const found = execFileSync('find', [
    path.join(__dirname, '..', 'node_modules'),
    '-path', '*dist/Electron.app/Contents/Info.plist', '-print', '-quit',
  ], { encoding: 'utf8' }).trim().split('\n')[0];
  return found ? path.dirname(found) : null;
}

try {
  const contents = electronAppContents();
  if (!contents) { console.warn('[dev-rename] Electron.app 未找到，跳过'); process.exit(0); }
  const plist = path.join(contents, 'Info.plist');
  if (!fs.existsSync(plist)) { console.warn('[dev-rename] Info.plist 不存在，跳过'); process.exit(0); }

  const cur = (() => {
    try { return execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleName', plist], { encoding: 'utf8' }).trim(); }
    catch { return ''; }
  })();
  if (cur === APP_NAME) process.exit(0);   // 已改过

  for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
    try { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${APP_NAME}`, plist]); }
    catch { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${APP_NAME}`, plist]); }
  }
  // 让 LaunchServices 注意到改名（dock 名字有缓存）。
  const appDir = path.dirname(contents);
  try { fs.utimesSync(appDir, new Date(), new Date()); } catch { /* */ }
  try {
    execFileSync('/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister',
      ['-f', appDir], { stdio: 'ignore' });
  } catch { /* best-effort */ }
  console.log(`[dev-rename] Electron.app → "${APP_NAME}"`);
} catch (e) {
  console.warn('[dev-rename] 跳过：', e && e.message);
  process.exit(0);   // 永不阻塞启动
}
