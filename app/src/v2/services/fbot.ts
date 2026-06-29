/**
 * 录入飞书助手（fbot）—— renderer 侧对 Electron 桥的类型化封装。
 *
 * 纯本地功能：在桌面版主进程里跑一个飞书长连接机器人，把
 * 「@机器人 → 能力菜单 → 选项 → 表单 → 提交」闭环跑通。
 * 卡片（菜单/表单）可在 Chaya 里可视化配置；业务处理（onSubmit/onAction）在
 * electron/fbotMenu.cjs 代码里。非 Electron 环境下整组 API 不可用。
 */

import type { ProviderId, PermMode } from './localAgent';

// ---- 卡片配置数据模型（与 electron/fbotMenu.cjs 的 spec 数据部分对齐）----
export type FieldKind = 'input' | 'multiline' | 'select';

/**
 * 表单/选项的「派发路由」—— 把飞书提交接到本地能力。
 *  · kind='agent'：提单 → 本地 CLI 会话（按工作目录），让 agent 自动改代码。
 *  · kind='http' ：动作 → 调外部 HTTP（如 Grafana 面板渲染），回执卡展示结果。（#5，后续）
 * 路由是「数据」，随 spec 一起持久化；真正派发在 renderer（fbotDispatch.ts）执行。
 */
export interface SpecRoute {
  kind?: 'agent' | 'http';
  // ---- kind='agent' ----
  intent?: 'answer' | 'change';            // answer=只读问答(锁 plan 权限+回答类提示词) / change=改代码(默认)
  cwd?: string;                            // 关联工作目录（同本地 CLI 的项目目录）
  provider?: ProviderId;                   // claude / cursor / codex / gemini
  permMode?: PermMode;                     // 权限档（auto 改代码常用 acceptEdits / bypassPermissions）
  sessionMode?: 'reuse' | 'fresh';         // reuse=每目录复用一条常驻会话；fresh=每次提交起新会话
  trigger?: 'auto' | 'manual';            // auto=提交即派发；manual=落到提交记录，人工点「派发」
  promptTemplate?: string;                 // {field} 占位；留空=自动按字段标签拼 prompt
  // ---- kind='http' / Grafana（#5）----
  linkUrl?: string;                        // 看板快捷链接（卡片里给跳转）
  renderUrl?: string;                      // 出图 PNG 端点；留空=从 linkUrl 自动推导(/d/→/render/d/)
  token?: string;                          // Grafana service account token（Bearer）；存 userData，不入库
  buttonText?: string;                     // 链接按钮文案
  width?: number;                          // 渲染图宽（默认 1200）
  height?: number;                         // 渲染图高（默认 800）
}
export interface SpecField {
  name: string;
  kind: FieldKind;
  label: string;
  placeholder?: string;
  required?: boolean;
  default?: string;
  rows?: number;
  options?: [string, string][];   // select 用：[value, label]
}
export interface SpecForm {
  title: string;
  template?: string;
  submitText?: string;
  fields: SpecField[];
  route?: SpecRoute;          // 提交后把这张表单派发到本地能力（CLI 会话 / HTTP）
}
export interface SpecMenuOption {
  key: string;
  text: string;
  type?: 'primary' | 'default' | 'danger';
  form?: string;      // 指向 forms[form]
  action?: string;    // 自定义动作（如 'query'），由代码 onAction 处理
  route?: SpecRoute;  // kind='http'：点选项直接出 Grafana 报表卡（#5，菜单直接触发）
}
export interface SpecMenu {
  title: string;
  template?: string;
  intro?: string;
  options: SpecMenuOption[];
}
export interface SpecData { menu: SpecMenu; forms: Record<string, SpecForm>; }

// ---- 提交记录 ----
export interface Submission {
  id: string;
  ts: number;
  formKey: string;
  formTitle: string;
  values: Record<string, string>;
  operator: { open_id?: string; [k: string]: unknown } | null;
  replyTo?: string | null;        // 原 @ 消息 id —— 派发结果可 reply-in-thread 回原会话
  userName?: string | null;       // 白名单解析出的姓名（启用提问门禁时）
}

// ---- 提问白名单（ACL）----
export interface AclEntry { openId: string; name: string; }
export interface FbotAcl {
  enabled: boolean;
  entries: AclEntry[];
  greetTemplate?: string;        // {name} / {question} 占位；空=默认寒暄语
  denyMessage?: string;          // 婉拒语；空=默认
}

// ---- 运行事件（主进程 emit 过来）----
export type FbotEvent =
  | { type: 'log'; level: 'info' | 'error'; msg: string; extra?: unknown; ts: number }
  | { type: 'message'; chatId: string; chatType: string; text: string; ts: number }
  | { type: 'card_action'; value: unknown; formValue: unknown; operator?: unknown; ts: number }
  | { type: 'status'; running: boolean; botName?: string }
  | { type: 'spec'; menu: SpecMenu; forms: Record<string, SpecForm> }
  | { type: 'submission'; item: Submission };

export interface FbotConfig { appId: string; hasSecret: boolean; testChatId: string; running: boolean; botName: string; }

interface FbotBridge {
  getConfig(): Promise<FbotConfig>;
  setConfig(cfg: { appId?: string; appSecret?: string; testChatId?: string }): Promise<{ ok: boolean }>;
  start(): Promise<{ ok: boolean; error?: string; botName?: string }>;
  stop(): Promise<{ ok: boolean }>;
  status(): Promise<{ running: boolean; botName: string; appId: string }>;
  sendCard(chatId: string, kind: 'menu' | 'form'): Promise<{ ok: boolean; error?: string; messageId?: string }>;
  reply(messageId: string, text: string, title?: string): Promise<{ ok: boolean; error?: string; messageId?: string }>;
  patchCard(messageId: string, text: string, title?: string): Promise<{ ok: boolean; error?: string }>;
  streamStart(replyTo: string, title?: string, template?: string): Promise<{ ok: boolean; cardId?: string; messageId?: string; error?: string }>;
  streamPush(cardId: string, text: string, sequence: number): Promise<{ ok: boolean; error?: string }>;
  streamSettle(cardId: string, text: string, sequence: number, title?: string, template?: string): Promise<{ ok: boolean; error?: string }>;
  getAcl(): Promise<FbotAcl>;
  setAcl(data: FbotAcl): Promise<{ ok: boolean; error?: string }>;
  resolveUser(openId: string): Promise<{ name: string | null }>;
  getSpec(): Promise<SpecData>;
  setSpec(data: SpecData): Promise<{ ok: boolean; error?: string }>;
  resetSpec(): Promise<{ ok: boolean; menu?: SpecMenu; forms?: Record<string, SpecForm> }>;
  listSubmissions(): Promise<Submission[]>;
  clearSubmissions(): Promise<{ ok: boolean }>;
  onEvent(cb: (e: FbotEvent) => void): () => void;
}

function bridge(): FbotBridge | null {
  const w = window as any;
  return w?.chateeElectron?.fbot ?? null;
}

export function isFbotAvailable(): boolean { return !!bridge(); }

export const fbot = {
  available: isFbotAvailable,
  getConfig: () => bridge()?.getConfig() ?? Promise.resolve(null),
  setConfig: (cfg: { appId?: string; appSecret?: string; testChatId?: string }) => bridge()?.setConfig(cfg) ?? Promise.resolve({ ok: false }),
  start: () => bridge()?.start() ?? Promise.resolve({ ok: false, error: '非桌面版' }),
  stop: () => bridge()?.stop() ?? Promise.resolve({ ok: false }),
  status: () => bridge()?.status() ?? Promise.resolve({ running: false, botName: '', appId: '' }),
  sendCard: (chatId: string, kind: 'menu' | 'form') => bridge()?.sendCard(chatId, kind) ?? Promise.resolve({ ok: false, error: '非桌面版' }),
  reply: (messageId: string, text: string, title?: string) => bridge()?.reply(messageId, text, title) ?? Promise.resolve({ ok: false, error: '非桌面版' }),
  patchCard: (messageId: string, text: string, title?: string) => bridge()?.patchCard(messageId, text, title) ?? Promise.resolve({ ok: false, error: '非桌面版' }),
  streamStart: (replyTo: string, title?: string, template?: string) => bridge()?.streamStart(replyTo, title, template) ?? Promise.resolve({ ok: false, error: '非桌面版' }),
  streamPush: (cardId: string, text: string, sequence: number) => bridge()?.streamPush(cardId, text, sequence) ?? Promise.resolve({ ok: false }),
  streamSettle: (cardId: string, text: string, sequence: number, title?: string, template?: string) => bridge()?.streamSettle(cardId, text, sequence, title, template) ?? Promise.resolve({ ok: false }),
  getAcl: () => bridge()?.getAcl() ?? Promise.resolve({ enabled: false, entries: [] } as FbotAcl),
  setAcl: (data: FbotAcl) => bridge()?.setAcl(data) ?? Promise.resolve({ ok: false, error: '非桌面版' }),
  resolveUser: (openId: string) => bridge()?.resolveUser(openId) ?? Promise.resolve({ name: null }),
  getSpec: () => bridge()?.getSpec() ?? Promise.resolve(null),
  setSpec: (data: SpecData) => bridge()?.setSpec(data) ?? Promise.resolve({ ok: false, error: '非桌面版' }),
  resetSpec: () => bridge()?.resetSpec() ?? Promise.resolve({ ok: false }),
  listSubmissions: () => bridge()?.listSubmissions() ?? Promise.resolve([] as Submission[]),
  clearSubmissions: () => bridge()?.clearSubmissions() ?? Promise.resolve({ ok: false }),
  onEvent: (cb: (e: FbotEvent) => void) => bridge()?.onEvent(cb) ?? (() => {}),
};
