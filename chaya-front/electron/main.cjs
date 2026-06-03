/**
 * Electron 主进程：加载 Vite 开发服务器或打包后的 dist，后端始终通过 HTTP 独立连接。
 */
const { app, BrowserWindow, shell, ipcMain, dialog, nativeImage } = require('electron');
const path = require('path');
const { registerLocalAgent, killAllSessions } = require('./localAgent.cjs');
const { registerNotes } = require('./notes.cjs');

const isDev = !app.isPackaged;
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

function createWindow() {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 420,
    minHeight: 560,
    backgroundColor: '#000000',
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

app.whenReady().then(() => {
  // Dev dock icon (packaged macOS uses build/icon.icns from the bundle).
  if (IS_MAC && isDev && app.dock) {
    try {
      const img = nativeImage.createFromPath(ICON_PNG);
      if (!img.isEmpty()) app.dock.setIcon(img);
    } catch { /* non-fatal */ }
  }
  createWindow();
});

app.on('window-all-closed', () => {
  if (!IS_MAC) app.quit();
});

// 退出前回收所有常驻 claude 会话，别留孤儿进程在系统里。
app.on('before-quit', () => { try { killAllSessions(); } catch { /* */ } });

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
