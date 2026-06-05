/**
 * 录入飞书助手（fbot）—— renderer 侧对 Electron 桥的类型化封装。
 *
 * 纯本地功能：在桌面版主进程里跑一个飞书长连接机器人，把
 * 「@机器人 → 能力菜单 → 选项 → 表单 → 提交」闭环跑通。
 * 卡片（菜单/表单）可在 Chaya 里可视化配置；业务处理（onSubmit/onAction）在
 * electron/fbotMenu.cjs 代码里。非 Electron 环境下整组 API 不可用。
 */

// ---- 卡片配置数据模型（与 electron/fbotMenu.cjs 的 spec 数据部分对齐）----
export type FieldKind = 'input' | 'multiline' | 'select';
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
}
export interface SpecMenuOption {
  key: string;
  text: string;
  type?: 'primary' | 'default' | 'danger';
  form?: string;      // 指向 forms[form]
  action?: string;    // 自定义动作（如 'query'），由代码 onAction 处理
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
  getSpec: () => bridge()?.getSpec() ?? Promise.resolve(null),
  setSpec: (data: SpecData) => bridge()?.setSpec(data) ?? Promise.resolve({ ok: false, error: '非桌面版' }),
  resetSpec: () => bridge()?.resetSpec() ?? Promise.resolve({ ok: false }),
  listSubmissions: () => bridge()?.listSubmissions() ?? Promise.resolve([] as Submission[]),
  clearSubmissions: () => bridge()?.clearSubmissions() ?? Promise.resolve({ ok: false }),
  onEvent: (cb: (e: FbotEvent) => void) => bridge()?.onEvent(cb) ?? (() => {}),
};
