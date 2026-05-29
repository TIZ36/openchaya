const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chateeElectron', {
  isElectron: true,
  platform: process.platform,

  // 本地 Agent 桥（纯本地，与 Chaya 后端无关）
  localAgent: {
    detect: () => ipcRenderer.invoke('localAgent:detect'),
    pickFolder: () => ipcRenderer.invoke('localAgent:pickFolder'),
    pickFiles: () => ipcRenderer.invoke('localAgent:pickFiles'),
    listSessions: (provider, cwd) => ipcRenderer.invoke('localAgent:listSessions', { provider, cwd }),
    readSession: (provider, cwd, sessionId) => ipcRenderer.invoke('localAgent:readSession', { provider, cwd, sessionId }),
    deleteSession: (provider, cwd, sessionId) => ipcRenderer.invoke('localAgent:deleteSession', { provider, cwd, sessionId }),
    listCommands: (provider, cwd) => ipcRenderer.invoke('localAgent:listCommands', { provider, cwd }),
    send: (payload) => ipcRenderer.invoke('localAgent:send', payload),
    warm: (payload) => ipcRenderer.invoke('localAgent:warm', payload),
    permissionRespond: (permId, decision) => ipcRenderer.invoke('localAgent:permissionRespond', { permId, decision }),
    interrupt: (cwd) => ipcRenderer.invoke('localAgent:interrupt', { cwd }),
    sessionClose: (cwd) => ipcRenderer.invoke('localAgent:sessionClose', { cwd }),
    setPermMode: (cwd, permMode) => ipcRenderer.invoke('localAgent:setPermMode', { cwd, permMode }),
    setModel: (cwd, model) => ipcRenderer.invoke('localAgent:setModel', { cwd, model }),
    listMcp: (cwd) => ipcRenderer.invoke('localAgent:listMcp', { cwd }),
    setMcp: (cwd, mcp) => ipcRenderer.invoke('localAgent:setMcp', { cwd, mcp }),
    mcpStatus: (cwd) => ipcRenderer.invoke('localAgent:mcpStatus', { cwd }),
    reconnectMcp: (cwd, name) => ipcRenderer.invoke('localAgent:reconnectMcp', { cwd, name }),
    // 订阅流式事件；返回取消订阅函数。
    onEvent: (cb) => {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on('localAgent:event', handler);
      return () => ipcRenderer.removeListener('localAgent:event', handler);
    },
  },

  // 本地笔记文件桥（平铺管理；从任意目录导入；同步到 sncloud 在渲染层做）
  notes: {
    pickFiles: () => ipcRenderer.invoke('notes:pickFiles'),
    createFile: (defaultName) => ipcRenderer.invoke('notes:createFile', { defaultName }),
    stat: (p) => ipcRenderer.invoke('notes:stat', { path: p }),
    read: (p) => ipcRenderer.invoke('notes:read', { path: p }),
    write: (p, content) => ipcRenderer.invoke('notes:write', { path: p, content }),
    rename: (p, name) => ipcRenderer.invoke('notes:rename', { path: p, name }),
    delete: (p) => ipcRenderer.invoke('notes:delete', { path: p }),
  },
});

// 在 DOM 就绪前尽早标记，不依赖 React
document.addEventListener('DOMContentLoaded', () => {
  document.documentElement.setAttribute('data-electron', 'true');
  document.documentElement.setAttribute('data-electron-platform', process.platform);
});
