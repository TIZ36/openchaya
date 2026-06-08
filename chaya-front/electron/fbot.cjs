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
const os = require('os');

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

// ---------- 提问白名单（ACL）：按 open_id 放行 + 寒暄；不在名单则婉拒 ----------
// 飞书无可靠的「open_id→姓名」应用级接口（受通讯录数据范围限制），故名单直接存 {openId,name}：
// 提交记录里能看到提交人 ou_*，复制进名单 + 填姓名即可。匹配按 open_id，寒暄用存的姓名。
function aclPath() {
  try { return path.join(electron.app.getPath('userData'), 'fbotAcl.json'); }
  catch { return path.join(__dirname, '.fbotAcl.json'); }
}
function loadAcl() {
  try {
    const o = JSON.parse(fs.readFileSync(aclPath(), 'utf8'));
    if (o && Array.isArray(o.entries)) return { enabled: !!o.enabled, entries: o.entries, greetTemplate: o.greetTemplate || '', denyMessage: o.denyMessage || '' };
  } catch { /* */ }
  return { enabled: false, entries: [], greetTemplate: '', denyMessage: '' };
}
async function saveAcl(next) {
  const data = {
    enabled: !!next.enabled,
    entries: (Array.isArray(next.entries) ? next.entries : []).filter((e) => e && e.openId).map((e) => ({ openId: String(e.openId).trim(), name: String(e.name || '').trim() })),
    greetTemplate: next.greetTemplate || '', denyMessage: next.denyMessage || '',
  };
  acl = data;
  try { await fsp.writeFile(aclPath(), JSON.stringify(data, null, 2), 'utf8'); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err && err.message || err) }; }
}
let acl = loadAcl();
function aclFind(openId) { return openId ? (acl.entries || []).find((e) => e.openId === openId) || null : null; }
// open_id → 姓名：先查白名单，再 best-effort 调飞书通讯录（受通讯录数据范围限制，查不到返回 null）。结果缓存。
const nameCache = new Map();
async function resolveUserName(openId) {
  if (!openId) return null;
  const hit = aclFind(openId);
  if (hit && hit.name) return hit.name;
  if (nameCache.has(openId)) return nameCache.get(openId);
  if (!state.client) return null;
  try {
    const res = await state.client.contact.v3.user.get({ path: { user_id: openId }, params: { user_id_type: 'open_id' } });
    const data = (res && res.data) || res;                         // 兼容信封/解包两种返回
    const u = data && data.user;
    const name = (u && (u.name || u.en_name)) || null;
    if (name) { nameCache.set(openId, name); return name; }
    // 查到了但没名字 / code!=0 —— 多半是缺 contact:user.base:readonly 或通讯录数据范围没圈到这人。
    log('error', '通讯录查姓名无结果（多半缺 contact:user.base:readonly 或通讯录数据范围）', JSON.stringify({ code: res && res.code, msg: res && res.msg, openId }).slice(0, 200));
    nameCache.set(openId, null);   // 明确无结果才缓存
    return null;
  } catch (err) {
    log('error', '通讯录查姓名失败（检查 contact:user.base:readonly + 通讯录数据范围 + 是否发版）', String((err && (err.message || err.msg)) || err).slice(0, 200));
    return null;   // 报错不缓存：开通权限/发版后下次自动重试
  }
}
// 取「提问」文本：优先第一个有值的多行/单行字段，否则拼所有非空值。
function summarizeQuestion(formKey, values) {
  const f = spec.forms[formKey] || { fields: [] };
  const prefer = (f.fields || []).find((fl) => (fl.kind === 'multiline' || fl.kind === 'input') && values[fl.name]);
  if (prefer) return String(values[prefer.name]);
  const vals = Object.values(values || {}).filter((v) => v && String(v).trim());
  return vals.join('；') || (f.title || '你的问题');
}
function buildDenyCard(msg) {
  return { schema: '2.0', config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: '暂无提问权限' }, template: 'orange' },
    body: { elements: [{ tag: 'markdown', content: msg || '不好意思，你需要先开通提问权限。' }] } };
}
function buildGreetCard(name, question, tpl) {
  const t = (tpl && tpl.trim()) || '好的，「{name}」，我这就去帮你查询问题：「{question}」';
  const content = t.replace(/\{name\}/g, name || '').replace(/\{question\}/g, question || '');
  return { schema: '2.0', config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: '已收到，正在处理' }, template: 'blue' },
    body: { elements: [{ tag: 'markdown', content }] } };
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
    replyTo: (ctx && ctx.openMessageId) || null,   // 原 @ 消息 id，供「答复回原会话」用
    userName: (ctx && ctx.userName) || null,       // 白名单解析出的姓名（如启用门禁）
  };
  list.push(item);
  if (list.length > 500) list.splice(0, list.length - 500);   // 只留最近 500 条
  try { fs.writeFileSync(submissionsPath(), JSON.stringify(list, null, 2), 'utf8'); } catch { /* */ }
  emit({ type: 'submission', item });
  return item;
}

// ---------- 运行态 ----------
const state = {
  client: null, wsClient: null, running: false, botName: '', botOpenId: '',
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
  const head = (result && result.title) || '已提交';
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
  // 群聊：只有 @ 了本 bot 才弹菜单（否则群里随便说话都触发，太吵）；私聊：任何消息都响应。
  if (msg.chat_type === 'group') {
    const mentions = msg.mentions || [];
    const atBot = mentions.some((m) =>
      (m && m.id && m.id.open_id && state.botOpenId && m.id.open_id === state.botOpenId)
      || (state.botName && m && m.name === state.botName));
    if (!atBot) return;
  }
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
    // Grafana 报表：异步出图（渲染+上传可能 >3s），先回「生成中」卡，出图后 patch 同一张卡。
    if (opt.route && opt.route.kind === 'http') {
      const msgId = ctx.openMessageId;
      (async () => { try { const card = await runGrafana(opt); if (msgId) await patchRawCard(msgId, card); } catch (err) { log('error', 'Grafana 动作异常', String(err && err.message || err)); } })();
      const loading = { schema: '2.0', config: { update_multi: true },
        header: { title: { tag: 'plain_text', content: opt.text || 'Grafana 报表' }, template: 'blue' },
        body: { elements: [{ tag: 'markdown', content: '报表生成中，请稍候…' }] } };
      return { toast: { type: 'info', content: '生成中…' }, card: { type: 'raw', data: loading } };
    }
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
    const operatorId = ctx.operator && (ctx.operator.open_id || ctx.operator.openId);
    // —— 提问白名单门禁 ——（不在名单：婉拒，不落库、不派发）
    if (acl.enabled) {
      const hit = aclFind(operatorId);
      if (!hit) {
        log('info', `拦截非白名单提交 open_id=${operatorId}`);
        return { toast: { type: 'warning', content: '暂无提问权限' }, card: { type: 'raw', data: buildDenyCard(acl.denyMessage) } };
      }
      ctx.userName = hit.name || '';   // 命中：把姓名带进 ctx（记录 + 寒暄用）
    }
    let result = { ok: true };
    try {
      if (typeof spec.onSubmit === 'function') result = await spec.onSubmit(formKey, formValue, ctx) || { ok: true };
    } catch (err) {
      log('error', 'onSubmit 业务异常', String(err && err.message || err));
      return { toast: { type: 'error', content: '处理失败，请重试' } };
    }
    if (result.ok === false) return { toast: { type: 'error', content: result.message || '校验未通过' } };
    recordSubmission(formKey, formValue, ctx);   // 落盘 + 推 UI（提交记录可回看）
    // 命中白名单 → 先寒暄一句（真正答复随后由 #4 reply 回贴）；否则走常规回执。
    const card = acl.enabled
      ? buildGreetCard(ctx.userName, summarizeQuestion(formKey, formValue), acl.greetTemplate)
      : (result.card || buildReceiptCard(formKey, formValue, result));
    return { toast: { type: 'success', content: result.toast || '已收到' }, card: { type: 'raw', data: card } };
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
      state.botOpenId = (info && info.bot && info.bot.open_id) || '';   // 用于判断群消息是否 @ 了本 bot
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

// 答复卡：把本地 CLI 会话跑出来的结果回贴到原 @ 消息（reply-in-thread）。
function buildAnswerCard(text, title, template) {
  return {
    schema: '2.0', config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: title || '助手答复' }, template: template || 'blue' },
    body: { elements: [{ tag: 'markdown', content: String(text || '正在处理…').slice(0, 9000) }] },
  };
}
// 回贴答复到原消息（messageId = 提交时记下的 openMessageId）。
async function reply(messageId, text, title) {
  if (!state.client) return { ok: false, error: '未启动' };
  if (!messageId) return { ok: false, error: '缺少 message_id' };
  try {
    const res = await state.client.im.v1.message.reply({
      path: { message_id: messageId },
      data: { msg_type: 'interactive', content: JSON.stringify(buildAnswerCard(text, title)) },
    });
    log('info', `已答复回原会话 (${messageId})`);
    return { ok: true, messageId: res && res.data && res.data.message_id };
  } catch (err) { const e = String(err && err.message || err); log('error', '答复失败', e); return { ok: false, error: e }; }
}

/* ============================================================
   Feishu AI 流式卡（cardkit）——「打字机」效果 + 历史全量保留。
   流程：create 卡实体(streaming_mode) → reply 发到原会话 → cardElement.content
   覆盖式推全量文本(飞书自动 diff 出打字机) → settings 关流式定稿。
   ============================================================ */
const STREAM_EL = 'answer';   // 流式 markdown 组件的 element_id
function buildStreamingCard(title, template) {
  return {
    schema: '2.0',
    config: { streaming_mode: true, summary: { content: '正在生成回答…' } },
    header: { title: { tag: 'plain_text', content: title || '正在处理' }, template: template || 'blue' },
    body: { elements: [{ tag: 'markdown', element_id: STREAM_EL, content: '' }] },
  };
}
// 起一张流式卡：create 卡实体 → reply 发到原会话。返回 {ok, cardId, messageId}。
async function streamStart(replyTo, title, template) {
  if (!state.client) return { ok: false, error: '未启动' };
  if (!replyTo) return { ok: false, error: '缺少 message_id' };
  try {
    const created = await state.client.cardkit.v1.card.create({ data: { type: 'card_json', data: JSON.stringify(buildStreamingCard(title, template)) } });
    const cardId = created && created.data && created.data.card_id;
    if (!cardId) return { ok: false, error: '创建卡片失败' };
    const res = await state.client.im.v1.message.reply({
      path: { message_id: replyTo },
      data: { msg_type: 'interactive', content: JSON.stringify({ type: 'card', data: { card_id: cardId } }) },
    });
    return { ok: true, cardId, messageId: res && res.data && res.data.message_id };
  } catch (err) { const e = String(err && err.message || err); log('error', '流式卡创建失败', e); return { ok: false, error: e }; }
}
// 覆盖式推全量文本（sequence 必须递增）。飞书自动识别增量 → 打字机。
async function streamPush(cardId, text, sequence) {
  if (!state.client || !cardId) return { ok: false };
  try {
    await state.client.cardkit.v1.cardElement.content({
      path: { card_id: cardId, element_id: STREAM_EL },
      data: { content: String(text == null ? '' : text).slice(0, 9500), sequence },
    });
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
}
// 定稿：推最终全量 + 关流式 + 更新标题/配色。
async function streamSettle(cardId, finalText, sequence, title, template) {
  if (!state.client || !cardId) return { ok: false };
  try {
    if (finalText != null) await streamPush(cardId, finalText, sequence);
    await state.client.cardkit.v1.card.settings({
      path: { card_id: cardId },
      data: {
        settings: JSON.stringify({ config: { streaming_mode: false }, header: { title: { tag: 'plain_text', content: title || '答复' }, template: template || 'green' } }),
        sequence: (sequence || 0) + 1,
      },
    });
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
}

// 流式更新已发出的卡片（按 message_id patch 内容）—— 非流式回退用。
async function patchCard(messageId, text, title) {
  if (!state.client) return { ok: false, error: '未启动' };
  if (!messageId) return { ok: false, error: '缺少 message_id' };
  try {
    await state.client.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(buildAnswerCard(text, title)) },
    });
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
}

/* ============================================================
   Grafana 报表动作（#5）：点菜单选项 → 渲染看板 PNG → 传飞书 → 卡片(图+链接)。
   渲染/上传可能 >3s（飞书卡回调超时），故先回「生成中」卡，异步出图后 patch 同一张卡。
   ============================================================ */
function deriveRenderUrl(linkUrl, width, height) {
  try {
    const u = new URL(linkUrl);
    u.pathname = u.pathname.replace(/^\/d\//, '/render/d/');   // /d/<uid>/.. → /render/d/<uid>/..
    u.searchParams.set('width', String(width || 1200));
    u.searchParams.set('height', String(height || 800));
    if (!u.searchParams.has('kiosk')) u.searchParams.set('kiosk', '');
    return u.toString();
  } catch { return ''; }
}
async function fetchGrafanaImage(renderUrl, token) {
  try {
    const resp = await fetch(renderUrl, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const ct = resp.headers.get('content-type') || '';
    if (!resp.ok || !ct.startsWith('image/')) {
      const body = await resp.text().catch(() => '');
      return { ok: false, reason: `HTTP ${resp.status} · ${ct} · ${body.slice(0, 140)}` };
    }
    return { ok: true, buffer: Buffer.from(await resp.arrayBuffer()) };
  } catch (err) { return { ok: false, reason: String(err && err.message || err) }; }
}
async function uploadFeishuImage(buffer) {
  if (!state.client) return { key: null, error: '未启动' };
  const tmp = path.join(os.tmpdir(), `fbot-grafana-${Date.now()}.png`);
  try {
    fs.writeFileSync(tmp, buffer);
    const res = await state.client.im.v1.image.create({ data: { image_type: 'message', image: fs.createReadStream(tmp) } });
    // image.create 返回的是「解包后的 data」（{image_key} 在顶层），不像 message.* 在 res.data 下 —— 两种都兜住。
    const key = res && (res.image_key || (res.data && res.data.image_key));
    if (!key) { const dump = JSON.stringify((res && (res.data || res)) || {}).slice(0, 200); log('error', '飞书上传图片无 image_key', dump); return { key: null, error: `无 image_key ${dump}` }; }
    return { key };
  } catch (err) {
    const e = String((err && (err.message || err.msg)) || err);
    log('error', '飞书上传图片失败', e);
    return { key: null, error: e };
  } finally { try { fs.unlinkSync(tmp); } catch { /* */ } }
}
function buildGrafanaCard(title, imageKey, linkUrl, buttonText, note) {
  const elements = [];
  if (imageKey) elements.push({ tag: 'img', img_key: imageKey, alt: { tag: 'plain_text', content: title || '报表' }, mode: 'fit_horizontal', preview: true });
  if (note) elements.push({ tag: 'markdown', content: `<font color='grey'>${note}</font>` });
  if (linkUrl) elements.push({ tag: 'markdown', content: `[${buttonText || '在 Grafana 打开完整看板 ↗'}](${linkUrl})` });
  return { schema: '2.0', config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: title || 'Grafana 报表' }, template: imageKey ? 'green' : 'blue' },
    body: { elements: elements.length ? elements : [{ tag: 'markdown', content: '（无内容）' }] } };
}
async function runGrafana(opt) {
  const r = opt.route || {};
  const linkUrl = r.linkUrl || '';
  const renderUrl = r.renderUrl || deriveRenderUrl(linkUrl, r.width, r.height);
  let imageKey = null, note = '';
  if (renderUrl) {
    const img = await fetchGrafanaImage(renderUrl, r.token);
    if (img.ok) { const up = await uploadFeishuImage(img.buffer); imageKey = up.key; if (!imageKey) note = `图片上传飞书失败（${up.error || ''}）。多半是缺「上传图片」权限，点下方链接查看。`; }
    else { note = '看板图片渲染暂不可用（可能未装 image-renderer 插件），点下方链接查看。'; log('error', 'Grafana 渲染失败', img.reason); }
  } else { note = '未配置渲染地址，仅给链接。'; }
  return buildGrafanaCard(opt.text || 'Grafana 报表', imageKey, linkUrl, r.buttonText, note);
}
// 用任意卡片对象覆盖已发消息（Grafana 异步出图后定稿用）。
async function patchRawCard(messageId, card) {
  if (!state.client || !messageId) return { ok: false };
  try { await state.client.im.v1.message.patch({ path: { message_id: messageId }, data: { content: JSON.stringify(card) } }); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err && err.message || err) }; }
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
  ipcMain.handle('fbot:reply', (_e, { messageId, text, title }) => reply(messageId, text, title));
  ipcMain.handle('fbot:patchCard', (_e, { messageId, text, title }) => patchCard(messageId, text, title));
  ipcMain.handle('fbot:streamStart', (_e, { replyTo, title, template }) => streamStart(replyTo, title, template));
  ipcMain.handle('fbot:streamPush', (_e, { cardId, text, sequence }) => streamPush(cardId, text, sequence));
  ipcMain.handle('fbot:streamSettle', (_e, { cardId, text, sequence, title, template }) => streamSettle(cardId, text, sequence, title, template));
  // 提问白名单（ACL）读写。
  ipcMain.handle('fbot:getAcl', () => acl);
  ipcMain.handle('fbot:setAcl', (_e, data) => saveAcl(data || {}));
  ipcMain.handle('fbot:resolveUser', async (_e, { openId }) => ({ name: await resolveUserName(openId) }));
  // 卡片配置（菜单/表单）读写 + 复位。
  ipcMain.handle('fbot:getSpec', () => getSpecData());
  ipcMain.handle('fbot:setSpec', (_e, data) => setSpecData(data));
  ipcMain.handle('fbot:resetSpec', () => resetSpecData());
  // 提交记录读取 / 清空。
  ipcMain.handle('fbot:listSubmissions', () => loadSubmissions().slice().reverse());  // 新的在前
  ipcMain.handle('fbot:clearSubmissions', () => { try { fs.writeFileSync(submissionsPath(), '[]', 'utf8'); } catch { /* */ } return { ok: true }; });
}

module.exports = { registerFbot, configure, setSpec, getSpecData, setSpecData, start, stop, sendCard, reply, patchCard, streamStart, streamPush, streamSettle };
