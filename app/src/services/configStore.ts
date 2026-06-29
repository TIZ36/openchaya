/* configStore —— 渲染层访问本地 SQLite 配置库的统一入口（取代凭证类 localStorage）。
 *
 * 纯客户端化后，用户 API 信息 / SmartNote 凭证 / cursor 凭证 / MCP OAuth 凭证的真源都在
 * 主进程的 chaya.db。本模块在启动时从 preload 注入的同步快照（window.chateeElectron.configSnapshot）
 * 读出全量，挂在内存 cache 里 —— 因此读取保持**同步**语义（现有 getSmartnoteApiKey 等调用点无需改异步）。
 * 写入更新 cache 后异步落库（invoke）。
 *
 * 非 Electron 环境（理论上不再有，保险起见）退回 localStorage，行为不变。
 */

type Secret = { value: string; meta: Record<string, unknown> };
type Snapshot = { kv: Record<string, string>; secrets: Record<string, Secret> };

interface ConfigBridge {
  config: { get(k: string): Promise<string | null>; set(k: string, v: string): Promise<boolean>; del(k: string): Promise<boolean> };
  secret: { get(n: string): Promise<Secret | null>; set(n: string, v: string, meta?: Record<string, unknown>): Promise<boolean>; del(n: string): Promise<boolean> };
  configSnapshot?: Snapshot;
}

function bridge(): ConfigBridge | null {
  const b = (typeof window !== 'undefined' ? (window as unknown as { chateeElectron?: ConfigBridge }).chateeElectron : null) || null;
  return b && b.config && b.secret ? b : null;
}

// 内存 cache：启动快照填充；之后读这里（同步），写时一并更新。
const snap: Snapshot = (() => {
  const b = bridge();
  const s = b?.configSnapshot;
  return { kv: { ...(s?.kv || {}) }, secrets: { ...(s?.secrets || {}) } };
})();

// ── kv（普通配置）──────────────────────────────────────────────────────────────
export function getConfig(key: string): string | null {
  if (key in snap.kv) return snap.kv[key];
  if (!bridge()) { try { return localStorage.getItem(key); } catch { return null; } }
  return null;
}

export function getConfigJSON<T>(key: string, fallback: T): T {
  const raw = getConfig(key);
  if (raw == null) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

export function setConfig(key: string, value: string): void {
  snap.kv[key] = value;
  const b = bridge();
  if (b) void b.config.set(key, value);
  else { try { localStorage.setItem(key, value); } catch { /* quota */ } }
}

export function setConfigJSON(key: string, value: unknown): void {
  setConfig(key, JSON.stringify(value));
}

export function delConfig(key: string): void {
  delete snap.kv[key];
  const b = bridge();
  if (b) void b.config.del(key);
  else { try { localStorage.removeItem(key); } catch { /* */ } }
}

// ── secrets（凭证）─────────────────────────────────────────────────────────────
export function getSecret(name: string): string {
  return snap.secrets[name]?.value ?? '';
}

export function getSecretMeta(name: string): Record<string, unknown> {
  return snap.secrets[name]?.meta ?? {};
}

export function setSecret(name: string, value: string, meta?: Record<string, unknown>): void {
  const m = meta ?? snap.secrets[name]?.meta ?? {};
  snap.secrets[name] = { value, meta: m };
  const b = bridge();
  if (b) void b.secret.set(name, value, m);
}

export function delSecret(name: string): void {
  delete snap.secrets[name];
  const b = bridge();
  if (b) void b.secret.del(name);
}

export function hasSecret(name: string): boolean {
  return !!snap.secrets[name]?.value;
}

/** 命名常量：集中管理键名，避免散落字符串拼写漂移。 */
export const CONFIG_KEYS = {
  smartnoteBase: 'smartnote_cloud_base',
  displayName: 'user_display_name',
} as const;

/** 用户称呼（纯客户端，无账号）。空 = 尚未填写 → 首启引导。 */
export function getDisplayName(): string {
  return (getConfig(CONFIG_KEYS.displayName) || '').trim();
}
export function setDisplayName(name: string): void {
  const t = (name || '').trim();
  if (t) setConfig(CONFIG_KEYS.displayName, t);
  else delConfig(CONFIG_KEYS.displayName);
}

export const SECRET_KEYS = {
  smartnoteApiKey: 'smartnote_api_key',
  smartnoteJwt: 'smartnote_jwt',         // meta.exp 存过期时间戳
  cursorApiKey: 'cursor_api_key',
} as const;

/** MCP OAuth 凭证按 url 命名的 secret 键。 */
export function mcpOauthSecretKey(url: string): string {
  return `mcp_oauth:${url}`;
}

/* ── 一次性迁移：把旧 localStorage 里的凭证搬进 SQLite ──────────────────────────
 * 主进程读不到渲染层 localStorage，故迁移只能在渲染层做。幂等：迁移完打标记。 */
const MIGRATED_FLAG = '__creds_migrated_v1';

export function migrateLegacyCreds(): void {
  if (!bridge()) return;                       // 非 Electron：无需迁移
  if (getConfig(MIGRATED_FLAG) === '1') return;
  const ls = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };

  // SmartNote：base / api_key / jwt(+exp)
  const snBase = ls('chaya_smartnote_cloud_base');
  if (snBase) setConfig(CONFIG_KEYS.smartnoteBase, snBase);
  const snKey = ls('chaya_smartnote_cloud_api_key');
  if (snKey) setSecret(SECRET_KEYS.smartnoteApiKey, snKey);
  const snJwt = ls('chaya_smartnote_cloud_jwt');
  const snExp = ls('chaya_smartnote_cloud_jwt_exp');
  if (snJwt) setSecret(SECRET_KEYS.smartnoteJwt, snJwt, { exp: Number(snExp || 0) });

  // MCP OAuth 凭证：旧键形如 mcp_oauth_client::<url>
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('mcp_oauth_client::')) {
        const url = k.slice('mcp_oauth_client::'.length);
        const v = ls(k);
        if (v) setSecret(mcpOauthSecretKey(url), v);
      }
    }
  } catch { /* */ }

  setConfig(MIGRATED_FLAG, '1');
}
