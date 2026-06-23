/**
 * Electron 主进程：加载 Vite 开发服务器或打包后的 dist，后端始终通过 HTTP 独立连接。
 */
const { app, BrowserWindow, shell, ipcMain, dialog, nativeImage, nativeTheme } = require('electron');
const path = require('path');
const { registerLocalAgent, killAllSessions } = require('./localAgent.cjs');
const { registerNotes } = require('./notes.cjs');
const { registerAutomation } = require('./automation.cjs');
const { registerReview } = require('./review.cjs');
const { registerFbot, stop: stopFbot } = require('./fbot.cjs');

const isDev = !app.isPackaged;
// Dev 下 Electron 默认把应用名(dock hover 提示、菜单)显示成 "Electron"。锁成产品名，
// 让 dock 悬停/关于面板都显示 "Chaya"。打包版由 Info.plist 的 productName 决定，不受影响。
try { app.setName('Chaya'); } catch { /* */ }
// Vite dev 服务器需要 inline/eval 脚本与 ws HMR，无法配严格 CSP；Electron 因此打印
// "Insecure Content-Security-Policy" 警告（仅开发期，打包版用 file:// 不触发）。关掉这条
// 噪声警告，避免和真实日志混淆。打包版本不受影响。
if (isDev) process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
const DEV_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5177';
// v2 is the only shell now; root renders it directly (no router).
const ENTRY_PATH = process.env.CHAYA_ENTRY || '/';
const IS_MAC = process.platform === 'darwin';
// 全局 UI 缩放档位（1 = 原始，0.9 ≈ 小一号）。整体瘦身，分屏能显示更多单会话内容。
const UI_ZOOM = Number(process.env.CHAYA_UI_ZOOM || 0.9);
// Master PNG (transparent corners, black squircle, white triangle). Packaged
// macOS builds use build/icon.icns via electron-builder; this drives the dev
// dock icon and the win/linux window icon.
const ICON_PNG = path.join(__dirname, '../build/icon.png');
const ICON_PNG_DARK = path.join(__dirname, '../build/icon-dark.png');

// macOS dock 图标无法随系统主题自动切换(静态 icns)，但运行期可以用 setIcon 主动换。
// 按 nativeTheme 的明暗挑 light/dark 两张，避免奶白图标在 dark dock 里发白。
function applyDockIcon() {
  if (!(IS_MAC && isDev && app.dock)) return;   // 打包版用 bundle 内 icns
  try {
    const p = nativeTheme.shouldUseDarkColors ? ICON_PNG_DARK : ICON_PNG;
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) app.dock.setIcon(img);
  } catch { /* non-fatal */ }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 420,
    minHeight: 560,
    // mac：开启窗口 vibrancy(NSVisualEffectView)，让透明区域透出「模糊的桌面/它窗」。
    // backgroundColor 给透明值,否则会盖住 vibrancy；非透明主题用各自不透明的 CSS 底
    // 覆盖它,所以只有 Pure 把侧栏/底色调成半透时才会真的透出来。
    backgroundColor: IS_MAC ? '#00000000' : '#000000',
    vibrancy: IS_MAC ? 'under-window' : undefined,
    visualEffectState: IS_MAC ? 'active' : undefined,
    show: false,
    // macOS ignores the window icon (it uses the dock/bundle icon); win/linux
    // take it for the title bar / taskbar.
    icon: IS_MAC ? undefined : ICON_PNG,
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    // Lights are 12px circles; the in-app shell-toggle and topbar crumb optical
    // centers sit on the y=22 content axis (x≈14 inset). But the OS-drawn lights
    // do NOT scale with the page zoom (UI_ZOOM) — content scales from the origin,
    // so the y=22 axis lands at device 22*UI_ZOOM. Pre-scale the light position by
    // UI_ZOOM so lights re-center on the zoomed in-app row:
    //   y = (content center 22) * UI_ZOOM − radius 6 ;  x = inset 14 * UI_ZOOM.
    trafficLightPosition: IS_MAC
      ? { x: Math.round(14 * UI_ZOOM), y: Math.round(22 * UI_ZOOM - 6) }
      : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  // 页面加载后：标记 Electron 环境 + macOS 红绿灯避让
  win.webContents.on('did-finish-load', () => {
    // 整体 UX 缩小一档（页面级缩放，等价 Cmd+-）：分屏视图能塞下更多单会话内容。
    // 用页面缩放而非 CSS zoom —— 后者会让按 getBoundingClientRect 定位的 fixed 菜单
    // （侧栏 ⋯ 菜单、模式指示器等）二次缩放而错位；页面缩放则保持坐标系一致、无视口空隙。
    try { win.webContents.setZoomFactor(UI_ZOOM); } catch { /* */ }

    win.webContents.executeJavaScript(`
      document.documentElement.setAttribute('data-electron', 'true');
      document.documentElement.setAttribute('data-electron-platform', '${process.platform}');
      ${IS_MAC ? "document.documentElement.setAttribute('data-vibrancy', 'on');" : ''}
    `).catch(() => {});

    if (IS_MAC) {
      win.webContents.insertCSS(`
        .app-darwin-titlebar {
          display: flex !important;
          height: 38px !important;
          flex-shrink: 0;
          align-items: center;
          justify-content: center;
          -webkit-app-region: drag;
          user-select: none;
        }
        .app-frame { margin-top: 0 !important; }
        .electron-titlebar-drag { -webkit-app-region: drag; }
        .app-no-drag, .app-bubble-tab, .app-rail-btn, .app-rail-theme-btn { -webkit-app-region: no-drag; }
      `).catch(() => {});
    }
  });

  if (isDev) {
    win.loadURL(DEV_URL.replace(/\/$/, '') + ENTRY_PATH);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    // Packaged build uses HashRouter (file://), so the entry must live in the hash.
    win.loadFile(path.join(__dirname, '../dist/index.html'), { hash: ENTRY_PATH });
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 渲染进程崩溃（OOM 等）→ 别留黑屏，自动重载恢复（标签/分组/分屏从 localStorage 回显）。
  // 记全 details（reason + exitCode）：reason='oom' → 内存爆掉（大代码块 Shiki/超大输出渲染）；
  // 'crashed' → V8 abort/原生崩溃。连续短时间内反复崩则不再自动重载，避免崩溃循环。
  let lastGoneAt = 0;
  let goneStreak = 0;
  win.webContents.on('render-process-gone', (_e, details) => {
    const now = Date.now();
    goneStreak = (now - lastGoneAt < 8000) ? goneStreak + 1 : 1;
    lastGoneAt = now;
    console.error('[main] render-process-gone:', JSON.stringify(details), `streak=${goneStreak}`);
    try { killAllSessions(); } catch { /* */ }   // 旧渲染没了 → 它开的 claude 常驻进程全成孤儿，回收
    if (goneStreak >= 3) { console.error('[main] renderer crashed 3× in a row — stopping auto-reload to break the loop'); return; }
    if (!win.isDestroyed()) { try { win.webContents.reload(); } catch { /* */ } }
  });
  win.webContents.on('unresponsive', () => console.warn('[main] renderer unresponsive'));
  // 整页重载（Cmd+R / HMR full reload）也会让旧会话进程变孤儿：导航开始即回收。
  // 首屏加载时 sessions 为空 → 无副作用；in-place(SPA pushState) 不触发。
  win.webContents.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) { try { killAllSessions(); } catch { /* */ } }
  });
}

// 本地 Agent 桥：纯本地功能，与后端无关。仅注册一次。
registerLocalAgent(ipcMain, dialog);
registerNotes(ipcMain, dialog);
// 自动化任务引擎（纯本地，存 userData；调度仅在 App 运行期间）。
registerAutomation(ipcMain);
// 代码评审引擎（纯本地，存 userData；只看 git 工作区改动，自由选 provider 跑只读评审）。
registerReview(ipcMain);
// 录入飞书助手桥（长连接 bot，纯本地；启停由渲染层控制，不自动启）。
registerFbot(ipcMain);

// 外观桥：渲染层（Pure 主题）推送目标明暗。设 nativeTheme.themeSource —
//   'system' → 交回 macOS 实时跟随（自动模式）；'light'/'dark' → 锁定，
//   同时让 prefers-color-scheme 与 under-window vibrancy 的明暗都跟着走。
ipcMain.handle('appearance:set', (_e, mode) => {
  nativeTheme.themeSource = (mode === 'light' || mode === 'dark') ? mode : 'system';
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
});

app.whenReady().then(() => {
  // Dev dock icon (packaged macOS uses build/icon.icns from the bundle).
  // 跟随系统/应用外观切换 light/dark 图标(themeSource 变化也会触发 'updated')。
  applyDockIcon();
  nativeTheme.on('updated', applyDockIcon);
  createWindow();
});

app.on('window-all-closed', () => {
  if (!IS_MAC) app.quit();
});

// 退出前回收所有常驻 claude 会话，别留孤儿进程在系统里。
app.on('before-quit', () => {
  try { killAllSessions(); } catch { /* */ }
  try { stopFbot(); } catch { /* */ }   // 关掉飞书长连接，别留 WS 在后台
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
