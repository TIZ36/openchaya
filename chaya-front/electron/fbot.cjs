/* ============================================================
   fbot —— 录入飞书助手（独立功能模块，类比 localAgent/notes）

   定位：纯客户端、长连接（WebSocket）的飞书机器人。把
   「@机器人 → 能力菜单 → 选项 → 表单 → 提交回执」这条交互闭环跑通；
   具体「有哪些菜单、每个菜单填什么表单、提交后干什么」全部由
   **业务规格（spec）** 描述，见 electron/fbotMenu.cjs —— 接真实业务只改那个文件。

   架构：
     lark.Client    —— 调 OpenAPI（发/回/更新卡片）
     lark.WSClient  —— 长连接收事件（im.message.receive_v1 / card.action.trigger）
     spec           —— 数据驱动的菜单/表单/提交处理

   两种跑法：
     1) Electron 主进程：main.cjs 调 registerFbot(ipcMain)，渲染层启停。
     2) 独立进程：node electron/fbotRun.cjs（用环境变量配凭证）。
   electron 依赖做成可选，所以脱离 Electron 也能 require。

   ⚠️ 同一个 app 只建议跑一个长连接；多开会让事件被分流。
   ============================================================ */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

// electron 可选：独立进程里没有它，照样能跑（只是少了 userData 持久化 / 窗口广播）。
let electron = null;
try { electron = require('electron'); } catch { /* standalone */ }

// SDK 懒加载：没装也不让宿主崩，给清晰报错。
let lark = null;
function loadLark() { if (!lark) lark = require('@larksuiteoapi/node-sdk'); return lark; }

// 业务菜单规格：
//   · 数据部分（menu / forms）—— 可被 UI 覆盖，持久化到 userData/fbotSpec.json
//   · 函数部分（onSubmit / onAction）—— 业务逻辑，永远来自 fbotMenu.cjs 代码
// 这样「卡片长啥样」在 UI 配，「提交后干啥」在代码里写，互不打架。
const defaultSpec = require('./fbotMenu.cjs');
function specPath() {
  try { return path.join(electron.app.getPath('userData'), 'fbotSpec.json'); }
  catch { return path.join(__dirname, '.fbotSpec.json'); }
}
function loadSpecData() {
  try { const o = JSON.parse(fs.readFileSync(specPath(), 'utf8')); if (o && o.menu && o.forms) return o; } catch { /* */ }
  return null;
}
function buildSpec() {
  const override = loadSpecData();
  return {
    menu: (override && override.menu) || defaultSpec.menu,
    forms: (override && override.forms) || defaultSpec.forms,
    onSubmit: defaultSpec.onSubmit,
    onAction: defaultSpec.onAction,
  };
}
let spec = buildSpec();
function setSpec(s) { if (s && s.menu) spec = s; }
// UI 读：只给数据部分。
function getSpecData() { return { menu: spec.menu, forms: spec.forms }; }
// UI 写：持久化数据部分 + 热更新到运行中的 bot。
async function setSpecData(data) {
  if (!data || !data.menu || !data.forms) return { ok: false, error: 'spec 缺 menu/forms' };
  try { await fsp.writeFile(specPath(), JSON.stringify({ menu: data.menu, forms: data.forms }, null, 2), 'utf8'); }
  catch (err) { return { ok: false, error: String(err && err.message || err) }; }
  spec = { menu: data.menu, forms: data.forms, onSubmit: defaultSpec.onSubmit, onAction: defaultSpec.onAction };
  emit({ type: 'spec', menu: spec.menu, forms: spec.forms });
  return { ok: true };
}
// 恢复默认（清掉覆盖）。
async function resetSpecData() {
  try { await fsp.unlink(specPath()); } catch { /* 没有就算了 */ }
  spec = buildSpec();
  emit({ type: 'spec', menu: spec.menu, forms: spec.forms });
  return { ok: true, menu: spec.menu, forms: spec.forms };
}

// ---------- 配置持久化（electron 下存 userData；独立进程走内存/env）----------
function configPath() {
  try { return path.join(electron.app.getPath('userData'), 'fbot.json'); }
  catch { return path.join(__dirname, '.fbot.json'); }
}
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); }
  catch { return { appId: '', appSecret: '', testChatId: '' }; }
}
async function saveConfig(cfg) {
  try { await fsp.writeFile(configPath(), JSON.stringify(cfg, null, 2), 'utf8'); return true; }
  catch { return false; }
}

// ---------- 提交记录收集（把每次表单提交落盘，UI 可回看）----------
function submissionsPath() {
  try { return path.join(electron.app.getPath('userData'), 'fbotSubmissions.json'); }
  catch { return path.join(__dirname, '.fbotSubmissions.json'); }
}
function loadSubmissions() {
  try { const a = JSON.parse(fs.readFileSync(submissionsPath(), 'utf8')); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
function recordSubmission(formKey, values, ctx) {
  const list = loadSubmissions();
  const item = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    ts: Date.now(),
    formKey,
    formTitle: (spec.forms[formKey] && spec.forms[formKey].title) || formKey,
    values: values || {},
    operator: (ctx && ctx.operator) || null,
  };
  list.push(item);
  if (list.length > 500) list.splice(0, list.length - 500);   // 只留最近 500 条
  try { fs.writeFileSync(submissionsPath(), JSON.stringify(list, null, 2), 'utf8'); } catch { /* */ }
  emit({ type: 'submission', item });
  return item;
}

// ---------- 运行态 ----------
const state = {
  client: null, wsClient: null, running: false, botName: '',
  config: loadConfig(),
};
// 独立进程直接注入凭证用。
function configure(cfg) { Object.assign(state.config, cfg || {}); }

// 事件广播：electron 下发给所有渲染窗口；独立进程只打日志。
function emit(evt) {
  try {
    if (electron && electron.BrowserWindow) {
      for (const w of electron.BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('fbot:event', evt);
      }
    }
  } catch { /* */ }
}
function log(level, msg, extra) {
  emit({ type: 'log', level, msg, extra, ts: Date.now() });
  (level === 'error' ? console.error : console.log)(`[fbot] ${msg}`, extra != null ? extra : '');
}

/* ============================================================
   卡片构造（从 spec 生成；都是实测可渲染的 v2 schema）
   ============================================================ */

// 能力菜单卡：@机器人后回这张。每个选项一个 callback 按钮。
function buildMenuCard() {
  const m = spec.menu;
  const cols = (m.options || []).map((opt) => ({
    tag: 'column', width: 'weighted', weight: 1, elements: [
      { tag: 'button', text: { tag: 'plain_text', content: opt.text }, type: opt.type || 'default', width: 'fill',
        behaviors: [{ type: 'callback', value: { action: 'menu', key: opt.key } }] },
    ],
  }));
  const elements = [{ tag: 'markdown', content: m.intro || '请选择👇' }];
  // 一行最多放不下太多按钮，超过 3 个就分行（每行最多 3 列）。
  for (let i = 0; i < cols.length; i += 3) {
    elements.push({ tag: 'column_set', columns: cols.slice(i, i + 3) });
  }
  return {
    schema: '2.0', config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: m.title || '助手' }, template: m.template || 'blue' },
    body: { elements },
  };
}

// 表单卡：点某个带 form 的选项后就地更新成这张。
function buildFormCard(formKey) {
  const f = spec.forms[formKey];
  if (!f) return buildMenuCard();
  const els = [];
  for (const field of f.fields || []) {
    if (field.kind === 'select') {
      els.push({ tag: 'markdown', content: `**${field.label}**${field.required ? ' *' : ''}` });
      els.push({
        tag: 'select_static', name: field.name,
        placeholder: { tag: 'plain_text', content: field.placeholder || '请选择' },
        options: (field.options || []).map(([value, label]) => ({ text: { tag: 'plain_text', content: label }, value })),
      });
    } else if (field.kind === 'multiline') {
      els.push({ tag: 'input', name: field.name, label: { tag: 'plain_text', content: field.label },
        placeholder: { tag: 'plain_text', content: field.placeholder || '' }, required: !!field.required,
        default_value: field.default || '', input_type: 'multiline_text', rows: field.rows || 3 });
    } else { // input
      els.push({ tag: 'input', name: field.name, label: { tag: 'plain_text', content: field.label },
        placeholder: { tag: 'plain_text', content: field.placeholder || '' }, required: !!field.required,
        default_value: field.default || '' });
    }
  }
  els.push({ tag: 'button', text: { tag: 'plain_text', content: f.submitText || '提交' }, type: 'primary',
    form_action_type: 'submit', name: 'submit',
    behaviors: [{ type: 'callback', value: { action: 'submit', form: formKey } }] });
  return {
    schema: '2.0', config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: f.title || '表单' }, template: f.template || 'wathet' },
    body: { elements: [{ tag: 'form', name: `form_${formKey}`, elements: els }] },
  };
}

// 默认回执卡：列出提交字段。业务可在 onSubmit 返回 {card} 覆盖。
function buildReceiptCard(formKey, values, result) {
  const f = spec.forms[formKey] || { fields: [] };
  const lines = (f.fields || []).map((fl) => `- **${fl.label}**：${values[fl.name] || '(空)'}`);
  const head = (result && result.title) || '✅ 已提交';
  const note = (result && result.message) || '';
  const elements = [{ tag: 'markdown', content: lines.join('\n') || '(无字段)' }];
  // v2 卡片不支持 note 标签，用浅色 markdown 代替小字注脚。
  if (note) elements.push({ tag: 'markdown', content: `<font color='grey'>${note}</font>` });
  return {
    schema: '2.0', config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: head }, template: (result && result.template) || 'green' },
    body: { elements },
  };
}

/* ============================================================
   事件处理
   ============================================================ */
function extractText(message) {
  try {
    const c = JSON.parse(message.content || '{}');
    return (c.text || '').replace(/@_user_\d+/g, '').replace(/@_all/g, '').trim();
  } catch { return ''; }
}

async function onMessage(data) {
  const msg = data && data.message;
  if (!msg) return;
  const text = extractText(msg);
  emit({ type: 'message', chatId: msg.chat_id, chatType: msg.chat_type, text, ts: Date.now() });
  log('info', `收到消息 [${msg.chat_type}] "${text}"`);
  try {
    await state.client.im.v1.message.reply({
      path: { message_id: msg.message_id },
      data: { msg_type: 'interactive', content: JSON.stringify(buildMenuCard()) },
    });
  } catch (err) { log('error', '回复菜单卡失败', String(err && err.message || err)); }
}

async function onCardAction(data) {
  const action = (data && data.action) || {};
  const value = action.value || {};
  const formValue = action.form_value || {};
  const ctx = { operator: data && data.operator, openMessageId: data && data.context && data.context.open_message_id };
  emit({ type: 'card_action', value, formValue, operator: ctx.operator, ts: Date.now() });
  log('info', `卡片动作 ${JSON.stringify(value)}`, formValue);

  // 1) 菜单选项
  if (value.action === 'menu') {
    const opt = (spec.menu.options || []).find((o) => o.key === value.key);
    if (!opt) return { toast: { type: 'warning', content: '未知选项' } };
    if (opt.form) return { toast: { type: 'info', content: '请填写信息' }, card: { type: 'raw', data: buildFormCard(opt.form) } };
    if (opt.action && typeof spec.onAction === 'function') {
      const r = await spec.onAction(opt.action, ctx);   // 业务自定义动作（如查询）
      if (r && r.card) return { toast: r.toast, card: { type: 'raw', data: r.card } };
      return { toast: r && r.toast ? r.toast : { type: 'info', content: '已处理' } };
    }
    return { toast: { type: 'info', content: '已处理' } };
  }

  // 2) 表单提交
  if (value.action === 'submit') {
    const formKey = value.form;
    let result = { ok: true };
    try {
      if (typeof spec.onSubmit === 'function') result = await spec.onSubmit(formKey, formValue, ctx) || { ok: true };
    } catch (err) {
      log('error', 'onSubmit 业务异常', String(err && err.message || err));
      return { toast: { type: 'error', content: '处理失败，请重试' } };
    }
    if (result.ok === false) return { toast: { type: 'error', content: result.message || '校验未通过' } };
    recordSubmission(formKey, formValue, ctx);   // 落盘 + 推 UI（提交记录可回看）
    const card = result.card || buildReceiptCard(formKey, formValue, result);
    return { toast: { type: 'success', content: result.toast || '已提交' }, card: { type: 'raw', data: card } };
  }

  return { toast: { type: 'warning', content: '未识别的操作' } };
}

/* ============================================================
   启停
   ============================================================ */
async function start() {
  if (state.running) return { ok: true, already: true };
  const { appId, appSecret } = state.config;
  if (!appId || !appSecret) return { ok: false, error: '未配置 appId/appSecret' };
  let L;
  try { L = loadLark(); } catch (err) { return { ok: false, error: 'SDK 未安装: ' + String(err && err.message || err) }; }
  try {
    state.client = new L.Client({ appId, appSecret });
    try {
      const info = await state.client.request({ method: 'GET', url: '/open-apis/bot/v3/info' });
      state.botName = (info && info.bot && info.bot.app_name) || '';
    } catch { /* 非致命 */ }
    const eventDispatcher = new L.EventDispatcher({}).register({
      'im.message.receive_v1': onMessage,
      'card.action.trigger': onCardAction,
    });
    state.wsClient = new L.WSClient({ appId, appSecret, loggerLevel: L.LoggerLevel.warn });
    state.wsClient.start({ eventDispatcher });
    state.running = true;
    log('info', `已启动长连接 bot=${state.botName || appId}`);
    emit({ type: 'status', running: true, botName: state.botName });
    return { ok: true, botName: state.botName };
  } catch (err) {
    state.running = false;
    const e = String(err && err.message || err);
    log('error', '启动失败', e);
    return { ok: false, error: e };
  }
}

async function stop() {
  try { if (state.wsClient && state.wsClient.close) state.wsClient.close(); } catch { /* */ }
  state.wsClient = null; state.running = false;
  log('info', '已停止长连接');
  emit({ type: 'status', running: false });
  return { ok: true };
}

// 主动发卡（UI/测试用）。
async function sendCard(chatId, kind) {
  if (!state.client) return { ok: false, error: '未启动' };
  const card = kind === 'form' ? buildFormCard((spec.menu.options.find((o) => o.form) || {}).form) : buildMenuCard();
  try {
    const res = await state.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) },
    });
    return { ok: true, messageId: res && res.data && res.data.message_id };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
}

/* ============================================================
   IPC 注册（main.cjs 调）
   ============================================================ */
function registerFbot(ipcMain) {
  ipcMain.handle('fbot:getConfig', () => ({
    appId: state.config.appId || '', hasSecret: !!state.config.appSecret,
    testChatId: state.config.testChatId || '', running: state.running, botName: state.botName,
  }));
  ipcMain.handle('fbot:setConfig', async (_e, { appId, appSecret, testChatId }) => {
    if (appId != null) state.config.appId = appId;
    if (appSecret != null && appSecret !== '') state.config.appSecret = appSecret; // 空串不覆盖
    if (testChatId != null) state.config.testChatId = testChatId;
    await saveConfig(state.config);
    return { ok: true };
  });
  ipcMain.handle('fbot:start', () => start());
  ipcMain.handle('fbot:stop', () => stop());
  ipcMain.handle('fbot:status', () => ({ running: state.running, botName: state.botName, appId: state.config.appId || '' }));
  ipcMain.handle('fbot:sendCard', (_e, { chatId, kind }) => sendCard(chatId, kind));
  // 卡片配置（菜单/表单）读写 + 复位。
  ipcMain.handle('fbot:getSpec', () => getSpecData());
  ipcMain.handle('fbot:setSpec', (_e, data) => setSpecData(data));
  ipcMain.handle('fbot:resetSpec', () => resetSpecData());
  // 提交记录读取 / 清空。
  ipcMain.handle('fbot:listSubmissions', () => loadSubmissions().slice().reverse());  // 新的在前
  ipcMain.handle('fbot:clearSubmissions', () => { try { fs.writeFileSync(submissionsPath(), '[]', 'utf8'); } catch { /* */ } return { ok: true }; });
}

module.exports = { registerFbot, configure, setSpec, getSpecData, setSpecData, start, stop, sendCard };
