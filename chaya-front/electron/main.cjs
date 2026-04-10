/**
 * Electron 主进程：加载 Vite 开发服务器或打包后的 dist，后端始终通过 HTTP 独立连接。
 */
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

const isDev = !app.isPackaged;
const DEV_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5177';
const IS_MAC = process.platform === 'darwin';

function createWindow() {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#000000',
    show: false,
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
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
    win.loadURL(DEV_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (!IS_MAC) app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
