/**
 * Electron 主进程：加载 Vite 开发服务器或打包后的 dist，后端始终通过 HTTP 独立连接。
 */
const { app, BrowserWindow, shell, ipcMain, dialog, nativeImage } = require('electron');
const path = require('path');
const { registerLocalAgent } = require('./localAgent.cjs');

const isDev = !app.isPackaged;
const DEV_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5177';
// v2 is the only shell now; root renders it directly (no router).
const ENTRY_PATH = process.env.CHAYA_ENTRY || '/';
const IS_MAC = process.platform === 'darwin';
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
    // Lights are 12px circles → center y = 16+6 = 22. The in-app shell-toggle
    // and topbar crumb are both sized so their optical centers land on the
    // same y=22 axis. (Default y avoided so we don't need an Electron restart
    // to see correct alignment.)
    trafficLightPosition: IS_MAC ? { x: 14, y: 16 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  // 页面加载后：标记 Electron 环境 + macOS 红绿灯避让
  win.webContents.on('did-finish-load', () => {
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
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[main] render-process-gone:', details && details.reason);
    if (!win.isDestroyed()) { try { win.webContents.reload(); } catch { /* */ } }
  });
  win.webContents.on('unresponsive', () => console.warn('[main] renderer unresponsive'));
}

// 本地 Agent 桥：纯本地功能，与后端无关。仅注册一次。
registerLocalAgent(ipcMain, dialog);

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

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
