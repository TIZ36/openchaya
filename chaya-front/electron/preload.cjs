const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('chateeElectron', {
  // Electron 32+ 删除了 File.path → 拖拽/选取的文件拿不到本地路径。用 webUtils 取回，
  // 否则非图片附件(文本文件等)会因无路径被丢弃，输入框上不显示。
  getPathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  isElectron: true,
  platform: process.platform,

  // 外观桥：渲染层把目标明暗('light'|'dark'|'system')推给主进程，主进程设 nativeTheme.themeSource。
  // 'system' = 交回 macOS 实时跟随；具体明暗 = 同时锁定 prefers-color-scheme 与窗口 vibrancy 的明暗。
  appearance: {
    set: (mode) => ipcRenderer.invoke('appearance:set', mode),
  },

  // 本地 Agent 桥（纯本地，与 Chaya 后端无关）
  localAgent: {
    detect: (only) => ipcRenderer.invoke('localAgent:detect', only),
    pickFolder: () => ipcRenderer.invoke('localAgent:pickFolder'),
    pickFiles: () => ipcRenderer.invoke('localAgent:pickFiles'),
    listModels: (provider, apiKey) => ipcRenderer.invoke('localAgent:listModels', { provider, apiKey }),
    listSessions: (provider, cwd) => ipcRenderer.invoke('localAgent:listSessions', { provider, cwd }),
    scanCodexSessions: () => ipcRenderer.invoke('localAgent:scanCodexSessions'),
    readSession: (provider, cwd, sessionId) => ipcRenderer.invoke('localAgent:readSession', { provider, cwd, sessionId }),
    deleteSession: (provider, cwd, sessionId) => ipcRenderer.invoke('localAgent:deleteSession', { provider, cwd, sessionId }),
    listCommands: (provider, cwd) => ipcRenderer.invoke('localAgent:listCommands', { provider, cwd }),
    scanCliSkills: () => ipcRenderer.invoke('localAgent:scanCliSkills'),
    send: (payload) => ipcRenderer.invoke('localAgent:send', payload),
    warm: (payload) => ipcRenderer.invoke('localAgent:warm', payload),
    permissionRespond: (permId, decision) => ipcRenderer.invoke('localAgent:permissionRespond', { permId, decision }),
    interrupt: (cwd, lane) => ipcRenderer.invoke('localAgent:interrupt', { cwd, lane }),
    sessionClose: (cwd, lane) => ipcRenderer.invoke('localAgent:sessionClose', { cwd, lane }),
    setPermMode: (cwd, permMode, lane) => ipcRenderer.invoke('localAgent:setPermMode', { cwd, permMode, lane }),
    setModel: (cwd, model, lane) => ipcRenderer.invoke('localAgent:setModel', { cwd, model, lane }),
    setReasoning: (cwd, reasoning, lane) => ipcRenderer.invoke('localAgent:setReasoning', { cwd, reasoning, lane }),
    listMcp: (cwd) => ipcRenderer.invoke('localAgent:listMcp', { cwd }),
    setMcp: (cwd, mcp, lane) => ipcRenderer.invoke('localAgent:setMcp', { cwd, mcp, lane }),
    mcpStatus: (cwd, lane) => ipcRenderer.invoke('localAgent:mcpStatus', { cwd, lane }),
    reconnectMcp: (cwd, name, lane) => ipcRenderer.invoke('localAgent:reconnectMcp', { cwd, name, lane }),
    // 外部编辑器：检测本机装了哪些 / 把工作目录甩给 VSCode / Cursor 打开。
    detectEditors: () => ipcRenderer.invoke('localAgent:detectEditors'),
    openInEditor: (editor, dir) => ipcRenderer.invoke('localAgent:openInEditor', { editor, dir }),
    // git 工作区改动（文件夹事实，跨 session）：列改动文件 / 懒取单文件 diff。
    gitStatus: (dir) => ipcRenderer.invoke('localAgent:gitStatus', { dir }),
    gitDiffFile: (dir, file, untracked) => ipcRenderer.invoke('localAgent:gitDiffFile', { dir, file, untracked }),
    gitRevertFile: (dir, file, untracked) => ipcRenderer.invoke('localAgent:gitRevertFile', { dir, file, untracked }),
    gitRevertAll: (dir) => ipcRenderer.invoke('localAgent:gitRevertAll', { dir }),
    // CLI 登录 pty：起会话 / 键入 / 杀 / 查状态 + 订阅按 id 路由的输出事件。
    loginStart: (provider, cols, rows) => ipcRenderer.invoke('localAgent:loginStart', { provider, cols, rows }),
    loginInput: (id, data) => ipcRenderer.invoke('localAgent:loginInput', { id, data }),
    loginResize: (id, cols, rows) => ipcRenderer.invoke('localAgent:loginResize', { id, cols, rows }),
    loginKill: (id) => ipcRenderer.invoke('localAgent:loginKill', { id }),
    loginStatus: (provider) => ipcRenderer.invoke('localAgent:loginStatus', { provider }),
    onLogin: (cb) => {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on('localAgent:login', handler);
      return () => ipcRenderer.removeListener('localAgent:login', handler);
    },
    // 订阅流式事件；返回取消订阅函数。
    onEvent: (cb) => {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on('localAgent:event', handler);
      return () => ipcRenderer.removeListener('localAgent:event', handler);
    },
  },

  // 自动化任务桥（纯本地，存 userData；调度仅在 App 运行期间）
  automation: {
    list: (cwd) => ipcRenderer.invoke('automation:list', { cwd }),
    save: (task) => ipcRenderer.invoke('automation:save', { task }),
    delete: (id) => ipcRenderer.invoke('automation:delete', { id }),
    setEnabled: (id, enabled) => ipcRenderer.invoke('automation:setEnabled', { id, enabled }),
    runNow: (id) => ipcRenderer.invoke('automation:runNow', { id }),
    cancel: (id) => ipcRenderer.invoke('automation:cancel', { id }),
    runs: (id) => ipcRenderer.invoke('automation:runs', { id }),
    graph: () => ipcRenderer.invoke('automation:graph'),
    branches: (cwd) => ipcRenderer.invoke('automation:branches', { cwd }),
    onEvent: (cb) => {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on('automation:event', handler);
      return () => ipcRenderer.removeListener('automation:event', handler);
    },
  },

  // 代码评审桥（纯本地，存 userData；只看 git 工作区改动，自由选 provider 跑只读评审）
  review: {
    list: (cwd) => ipcRenderer.invoke('review:list', { cwd }),
    sessions: (cwd) => ipcRenderer.invoke('review:sessions', { cwd }),
    resetSession: (cwd, provider) => ipcRenderer.invoke('review:resetSession', { cwd, provider }),
    preview: (cwd) => ipcRenderer.invoke('review:preview', { cwd }),
    run: (payload) => ipcRenderer.invoke('review:run', payload),
    cancel: (id) => ipcRenderer.invoke('review:cancel', { id }),
    delete: (cwd, id) => ipcRenderer.invoke('review:delete', { cwd, id }),
    clear: (cwd) => ipcRenderer.invoke('review:clear', { cwd }),
    onEvent: (cb) => {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on('review:event', handler);
      return () => ipcRenderer.removeListener('review:event', handler);
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
    defaultNote: () => ipcRenderer.invoke('notes:defaultNote'),
    append: (p, text) => ipcRenderer.invoke('notes:append', { path: p, text }),
    chooseDefault: () => ipcRenderer.invoke('notes:chooseDefault'),
    pickDefault: () => ipcRenderer.invoke('notes:pickDefault'),
  },

  // 录入飞书助手桥（长连接 bot；启停 + 配置 + 事件订阅）
  fbot: {
    getConfig: () => ipcRenderer.invoke('fbot:getConfig'),
    setConfig: (cfg) => ipcRenderer.invoke('fbot:setConfig', cfg),   // {appId, appSecret?, testChatId?}
    start: () => ipcRenderer.invoke('fbot:start'),
    stop: () => ipcRenderer.invoke('fbot:stop'),
    status: () => ipcRenderer.invoke('fbot:status'),
    sendCard: (chatId, kind) => ipcRenderer.invoke('fbot:sendCard', { chatId, kind }),  // kind: 'menu' | 'form'
    reply: (messageId, text, title) => ipcRenderer.invoke('fbot:reply', { messageId, text, title }),  // 回贴答复到原 @ 消息
    patchCard: (messageId, text, title) => ipcRenderer.invoke('fbot:patchCard', { messageId, text, title }),  // 非流式回退
    streamStart: (replyTo, title, template) => ipcRenderer.invoke('fbot:streamStart', { replyTo, title, template }),  // AI 流式卡：create+发卡 → {cardId,messageId}
    streamPush: (cardId, text, sequence) => ipcRenderer.invoke('fbot:streamPush', { cardId, text, sequence }),       // 覆盖式推全量(打字机)
    streamSettle: (cardId, text, sequence, title, template) => ipcRenderer.invoke('fbot:streamSettle', { cardId, text, sequence, title, template }),  // 定稿关流式
    getAcl: () => ipcRenderer.invoke('fbot:getAcl'),            // 提问白名单 {enabled, entries:[{openId,name}], greetTemplate, denyMessage}
    setAcl: (data) => ipcRenderer.invoke('fbot:setAcl', data),
    resolveUser: (openId) => ipcRenderer.invoke('fbot:resolveUser', { openId }),  // open_id→{name}（白名单/通讯录，best-effort）
    getSpec: () => ipcRenderer.invoke('fbot:getSpec'),          // 读卡片配置 {menu, forms}
    setSpec: (data) => ipcRenderer.invoke('fbot:setSpec', data),// 存卡片配置(热更新)
    resetSpec: () => ipcRenderer.invoke('fbot:resetSpec'),      // 恢复默认
    listSubmissions: () => ipcRenderer.invoke('fbot:listSubmissions'),  // 提交记录(新→旧)
    clearSubmissions: () => ipcRenderer.invoke('fbot:clearSubmissions'),
    // 订阅 bot 事件（log/message/card_action/status）；返回取消订阅函数。
    onEvent: (cb) => {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on('fbot:event', handler);
      return () => ipcRenderer.removeListener('fbot:event', handler);
    },
  },
});

// 在 DOM 就绪前尽早标记，不依赖 React
document.addEventListener('DOMContentLoaded', () => {
  document.documentElement.setAttribute('data-electron', 'true');
  document.documentElement.setAttribute('data-electron-platform', process.platform);
});
