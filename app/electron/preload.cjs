const { contextBridge, ipcRenderer, webUtils } = require('electron');

// 启动期同步拿到配置/凭证全量快照 → 渲染层 configStore 可同步读取（保持现有同步调用点不变）。
let CONFIG_SNAPSHOT = { kv: {}, secrets: {} };
try { CONFIG_SNAPSHOT = ipcRenderer.sendSync('config:snapshot') || CONFIG_SNAPSHOT; }
catch { /* 主进程未就绪/未 rebuild：留空快照，写入仍会异步落库 */ }

contextBridge.exposeInMainWorld('chateeElectron', {
  // 本地 SQLite 配置库：启动快照（同步）+ 读写（异步 invoke）。
  configSnapshot: CONFIG_SNAPSHOT,
  config: {
    get: (key) => ipcRenderer.invoke('config:get', { key }),
    set: (key, value) => ipcRenderer.invoke('config:set', { key, value }),
    del: (key) => ipcRenderer.invoke('config:del', { key }),
  },
  secret: {
    get: (name) => ipcRenderer.invoke('secret:get', { name }),
    set: (name, value, meta) => ipcRenderer.invoke('secret:set', { name, value, meta }),
    del: (name) => ipcRenderer.invoke('secret:del', { name }),
  },

  // 自进化引擎桥（升格 agent 会话专用）：post-turn 反思 + 草稿认可/否决/修订 + 记忆文件。
  evolve: {
    reflect: (args) => ipcRenderer.invoke('evolve:reflect', args),
    listSkills: (agentId) => ipcRenderer.invoke('evolve:listSkills', { agentId }),
    listMemory: (agentId) => ipcRenderer.invoke('evolve:listMemory', { agentId }),
    approveSkill: (agentId, name) => ipcRenderer.invoke('evolve:approveSkill', { agentId, name }),
    vetoSkill: (agentId, name, reason) => ipcRenderer.invoke('evolve:vetoSkill', { agentId, name, reason }),
    reviseSkill: (agentId, name, patch) => ipcRenderer.invoke('evolve:reviseSkill', { agentId, name, patch }),
    deleteSkill: (agentId, name) => ipcRenderer.invoke('evolve:deleteSkill', { agentId, name }),
    consolidate: (agentId, promoteAt) => ipcRenderer.invoke('evolve:consolidate', { agentId, promoteAt }),
    writeMemoryFile: (agentId, cwd) => ipcRenderer.invoke('evolve:writeMemoryFile', { agentId, cwd }),
    memoryMarkdown: (agentId) => ipcRenderer.invoke('evolve:memoryMarkdown', { agentId }),
  },

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
    usage: (cwd) => ipcRenderer.invoke('localAgent:usage', { cwd }),
    busyKeys: () => ipcRenderer.invoke('localAgent:busyKeys'),
    send: (payload) => ipcRenderer.invoke('localAgent:send', payload),
    warm: (payload) => ipcRenderer.invoke('localAgent:warm', payload),
    permissionRespond: (permId, decision) => ipcRenderer.invoke('localAgent:permissionRespond', { permId, decision }),
    elicitationRespond: (elicitId, result) => ipcRenderer.invoke('localAgent:elicitationRespond', { elicitId, result }),
    interrupt: (cwd, lane) => ipcRenderer.invoke('localAgent:interrupt', { cwd, lane }),
    sessionClose: (cwd, lane) => ipcRenderer.invoke('localAgent:sessionClose', { cwd, lane }),
    setPermMode: (cwd, permMode, lane) => ipcRenderer.invoke('localAgent:setPermMode', { cwd, permMode, lane }),
    setModel: (cwd, model, lane) => ipcRenderer.invoke('localAgent:setModel', { cwd, model, lane }),
    setReasoning: (cwd, reasoning, lane) => ipcRenderer.invoke('localAgent:setReasoning', { cwd, reasoning, lane }),
    listMcp: (cwd, provider) => ipcRenderer.invoke('localAgent:listMcp', { cwd, provider }),
    listAllMcp: (cwd) => ipcRenderer.invoke('localAgent:listAllMcp', { cwd }),
    getMcpConfig: (provider, name, cwd) => ipcRenderer.invoke('localAgent:getMcpConfig', { provider, name, cwd }),
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
    gitCommit: (dir, message) => ipcRenderer.invoke('localAgent:gitCommit', { dir, message }),
    gitPush: (dir) => ipcRenderer.invoke('localAgent:gitPush', { dir }),
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
    // 会话互问（Phase 2）：agent 通过 ask_session 工具发起 → 主进程请求渲染层执行 →
    // 渲染层用 sessionBridge 跑完后把答复回传。onAgentAsk 订阅请求，agentAskResult 回结果。
    onAgentAsk: (cb) => {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on('localAgent:agentAskRequest', handler);
      return () => ipcRenderer.removeListener('localAgent:agentAskRequest', handler);
    },
    agentAskResult: (requestId, text) => ipcRenderer.invoke('localAgent:agentAskResult', { requestId, text }),
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

  // 定时任务桥（provider 无关：扫的是 OS crontab，与任何 CLI 无关；可选 launchd 睡眠补跑）
  cron: {
    list: (cwd) => ipcRenderer.invoke('cron:list', { cwd }),
    delete: (id) => ipcRenderer.invoke('cron:delete', { id }),
    offline: (id, on) => ipcRenderer.invoke('cron:offline', { id, on }),
    runNow: (id) => ipcRenderer.invoke('cron:runNow', { id }),
    openLog: (id) => ipcRenderer.invoke('cron:openLog', { id }),
    tailLog: (id, lines) => ipcRenderer.invoke('cron:tailLog', { id, lines }),
    openDir: () => ipcRenderer.invoke('cron:openDir'),
    onEvent: (cb) => {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on('cron:event', handler);
      return () => ipcRenderer.removeListener('cron:event', handler);
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
