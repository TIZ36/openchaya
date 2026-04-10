const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('chateeElectron', {
  isElectron: true,
  platform: process.platform,
});

// 在 DOM 就绪前尽早标记，不依赖 React
document.addEventListener('DOMContentLoaded', () => {
  document.documentElement.setAttribute('data-electron', 'true');
  document.documentElement.setAttribute('data-electron-platform', process.platform);
});
