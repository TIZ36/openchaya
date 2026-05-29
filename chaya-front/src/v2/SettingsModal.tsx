import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../utils/apiClient';
import {
  getLLMConfigs, createLLMConfig, updateLLMConfig, deleteLLMConfig,
  getLLMConfigApiKey, listAvailableModels, getSupportedProviders,
  type LLMConfigFromDB, type SupportedProvider,
} from '../services/llmApi';
import { mcpApi, oauthApi, type MCPServer } from '../services/integrationsApi';
import {
  getSmartnoteApiKey, setSmartnoteApiKey,
  getSmartnoteBaseUrl, setSmartnoteBaseUrl,
  smartnoteProbe,
} from '../services/smartnoteApi';
import type { ClientSettings, AppearanceMode, ColorTheme, GlassZone, GlassIntensity } from '../components/SettingsPage';
import type { FontId } from '../components/SettingsPage';
import { TYPE_SPEED_LABELS, type TypeSpeed } from './typewriter';
import { getBackendUrl } from '../utils/backendUrl';
import { isLocalAgentAvailable } from './services/localAgent';

interface Props {
  settings: ClientSettings;
  updateSettings: (p: Partial<ClientSettings>) => void;
  onLogout: () => void;
  onClose: () => void;
}

type Tab = 'account' | 'appearance' | 'prefs' | 'services' | 'models' | 'mcp' | 'localagent';

/** 三段分组，按"范围"而不是"对谁生效"分：
 *  · 个人 — 你的账号与本机偏好
 *  · 能力 — 跨闲聊 / agent 共用的模型与外部能力
 *  · 桌面 — 仅桌面版（Electron）才有的本机 agent
 *  比之前的"基础设置 / Agent 设置"语义更准（RAG/MCP 闲聊也会用到，不只是 agent）。
 *  Hint 行去掉 —— label 已自明，多一行只是噪声，让 nav 高度更安静。
 */
const TAB_GROUPS: { group: string; items: { id: Tab; label: string }[] }[] = [
  {
    group: '个人',
    items: [
      { id: 'account',    label: '账号' },
      { id: 'appearance', label: '外观' },
      { id: 'prefs',      label: '偏好' },
    ],
  },
  {
    group: '能力',
    items: [
      { id: 'models',  label: '模型' },
      { id: 'mcp',     label: 'MCP 工具' },
    ],
  },
  {
    group: '外部',
    items: [
      { id: 'services', label: '服务' },
    ],
  },
  ...(isLocalAgentAvailable() ? [{
    group: '桌面',
    items: [
      { id: 'localagent' as Tab, label: 'Local Agents' },
    ],
  }] : []),
];

// FontId slots are kept for storage compatibility; mapping:
//   default    → 系统  (SF/PingFang/system)
//   rounded    → 现代  (Inter)
//   pixel      → 衬线  (Source Serif 4)
//   terminal   → 等宽  (JetBrains Mono)
//   dotgothic  → 经典  (Crimson Pro)
//   silkscreen → 优雅  (Playfair Display)
const FONTS: { id: FontId; label: string; tag: string; sampleStyle: React.CSSProperties }[] = [
  { id: 'default',    label: '系统', tag: 'SYSTEM',          sampleStyle: { fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", system-ui, sans-serif' } },
  { id: 'rounded',    label: '现代', tag: 'INTER',           sampleStyle: { fontFamily: '"Inter", "PingFang SC", system-ui, sans-serif' } },
  { id: 'pixel',      label: '衬线', tag: 'SOURCE SERIF',    sampleStyle: { fontFamily: '"Source Serif 4", "Noto Serif SC", serif' } },
  { id: 'terminal',   label: '等宽', tag: 'JETBRAINS MONO',  sampleStyle: { fontFamily: '"JetBrains Mono", ui-monospace, monospace' } },
  { id: 'dotgothic',  label: '经典', tag: 'CRIMSON PRO',     sampleStyle: { fontFamily: '"Crimson Pro", "Noto Serif SC", serif' } },
  { id: 'silkscreen', label: '优雅', tag: 'PLAYFAIR',        sampleStyle: { fontFamily: '"Playfair Display", "Noto Serif SC", serif' } },
];

const APPEARANCES: { id: AppearanceMode; label: string; icon: string }[] = [
  { id: 'light',  label: '浅色',     icon: '☀' },
  { id: 'dark',   label: '深色',     icon: '☾' },
  { id: 'system', label: '跟随系统', icon: '⌣' },
];

const GLASS_ZONES: { id: GlassZone; label: string; sub: string }[] = [
  { id: 'composer', label: '输入框',     sub: '最推荐：消息从输入框背后透出、被柔化' },
  { id: 'menu',     label: '菜单 / 抽屉', sub: '右键菜单、侧边抽屉浮层' },
  { id: 'modal',    label: '弹窗背景',    sub: '打开设置等弹窗时，背后界面磨砂下沉' },
  { id: 'sidebar',  label: '侧栏',        sub: '会自动叠加微弱环境层，玻璃才显现' },
  { id: 'main',     label: '主界面',      sub: '白卡片本体磨砂；与侧栏一起开效果最佳' },
  { id: 'topbar',   label: '顶栏',        sub: '消息从标题栏下方滚过、被柔化' },
  { id: 'bubble',   label: '用户气泡',    sub: '慎用：正文区加玻璃可能影响可读性' },
];
const GLASS_INTENSITIES: { id: GlassIntensity; label: string }[] = [
  { id: 'subtle',   label: '轻' },
  { id: 'standard', label: '标准' },
  { id: 'strong',   label: '强' },
];
export const GLASS_DEFAULT_ZONES: GlassZone[] = ['composer', 'menu', 'modal'];

// surface = swatch canvas (dark-first brands show their dark bg);
// ramp = [tint, base, deep] accent layers shown as chips
const THEMES: { id: ColorTheme; label: string; sub: string; surface: string; ramp: [string, string, string] }[] = [
  { id: 'anthropic', label: 'Anthropic', sub: '象牙陶土',   surface: '#faf9f5', ramp: ['#f5e5de', '#d97757', '#c15f3c'] },
  { id: 'cursor',    label: 'Cursor',    sub: '极夜石墨青', surface: '#0e0f12', ramp: ['#162e2b', '#7eede0', '#b4f0e7'] },
];

const SettingsModal: React.FC<Props> = ({ settings, updateSettings, onLogout, onClose }) => {
  const [tab, setTab] = useState<Tab>('account');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="v2-modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="v2-modal v2-modal-settings" onMouseDown={(e) => e.stopPropagation()}>
        <div className="v2-modal-hd">
          <h3>设置</h3>
          <button className="x" onClick={onClose}>✕</button>
        </div>
        <div className="v2-settings-body">
          <nav className="v2-settings-nav">
            {TAB_GROUPS.map((g) => (
              <div key={g.group} className="v2-settings-nav-group">
                <div className="v2-settings-nav-head">
                  <span className="grp">{g.group}</span>
                </div>
                {g.items.map((t) => (
                  <button
                    key={t.id}
                    className={`v2-settings-nav-item${tab === t.id ? ' active' : ''}`}
                    onClick={() => setTab(t.id)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <div className="v2-settings-pane">
            {tab === 'account'    && <AccountPane onLogout={onLogout} />}
            {tab === 'appearance' && <AppearancePane settings={settings} updateSettings={updateSettings} />}
            {tab === 'prefs'      && <PrefsPane settings={settings} updateSettings={updateSettings} />}
            {tab === 'services' && <ServicesPane settings={settings} updateSettings={updateSettings} />}
            {tab === 'models'   && <ModelsPane settings={settings} updateSettings={updateSettings} />}
            {tab === 'mcp'      && <McpPane />}
            {tab === 'localagent' && <LocalAgentPane settings={settings} updateSettings={updateSettings} />}
          </div>
        </div>
      </div>
    </div>
  );
};

/* ============ helpers ============ */

const Section: React.FC<React.PropsWithChildren<{ title: string; hint?: string; trailing?: React.ReactNode }>> = ({ title, hint, trailing, children }) => (
  <div className="v2-set-sec">
    <div className="v2-set-sec-hd">
      <div>
        <div className="t">{title}</div>
        {hint && <div className="h">{hint}</div>}
      </div>
      {trailing && <div className="v2-set-sec-trail">{trailing}</div>}
    </div>
    <div className="v2-set-sec-body">{children}</div>
  </div>
);

const Row: React.FC<React.PropsWithChildren<{ label: string; sub?: string; trailing?: React.ReactNode }>> = ({ label, sub, trailing, children }) => (
  <div className="v2-set-row">
    <div className="v2-set-row-l">
      <div className="lab">{label}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
    <div className="v2-set-row-r">{trailing ?? children}</div>
  </div>
);

const Switch: React.FC<{ checked: boolean; onChange: (b: boolean) => void }> = ({ checked, onChange }) => (
  <button className={`v2-switch${checked ? ' on' : ''}`} onClick={() => onChange(!checked)} aria-pressed={checked}>
    <span className="thumb" />
  </button>
);

/* ============ account / prefs / defaults / rag ============ */

const AccountPane: React.FC<{ onLogout: () => void }> = ({ onLogout }) => {
  const u = api.getUser();
  const plan = u?.tenant?.plan || 'free';
  const displayName = u?.name || u?.email?.split('@')[0] || '—';
  const initials = (() => {
    const n = displayName;
    if (!n || n === '—') return '?';
    if (/[a-zA-Z]/.test(n[0])) {
      const parts = n.split(/[^a-zA-Z]/).filter(Boolean);
      return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || n[0].toUpperCase();
    }
    return n.slice(0, 1).toUpperCase();
  })();

  return (
    <div className="v2-acc">
      {/* Identity card — avatar + name with email/plan/tenant inline as
          icon+text meta. */}
      <div className="v2-acc-id">
        <div className="v2-acc-av">{initials}</div>
        <div className="v2-acc-id-r">
          <div className="v2-acc-nm">{displayName}</div>
          <div className="v2-acc-meta">
            <span className="v2-acc-meta-i" title="邮箱"><AccIconMail />{u?.email || '—'}</span>
            <span className="v2-acc-meta-pill" title="套餐">{String(plan).toUpperCase()}</span>
            {u?.tenant?.name && (
              <span className="v2-acc-meta-i" title="租户"><AccIconBuilding />{u.tenant.name}</span>
            )}
          </div>
        </div>
      </div>

      {/* Logout — single icon+text danger button. window.confirm carries
          the warning. The previous endpoint/probe block was promoted out
          of 账号 into the 外部 · 服务 tab. */}
      <div className="v2-acc-foot">
        <button
          className="v2-set-danger v2-acc-btn"
          onClick={() => { if (window.confirm('退出当前账号？')) onLogout(); }}
        >
          <AccIconPower /><span>退出账号</span>
        </button>
      </div>
    </div>
  );
};

/* AccountPane-local 14px line icons. Inline so polish doesn't pollute the
   shared icons.tsx, which is curated for surface-wide patterns. */
const AccIconMail = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3 7l9 6 9-6" />
  </svg>
);
const AccIconBuilding = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="5" y="3" width="14" height="18" rx="1.5" />
    <path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2" />
  </svg>
);
const AccIconServer = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="5" width="18" height="6" rx="1.5" />
    <rect x="3" y="13" width="18" height="6" rx="1.5" />
    <circle cx="7" cy="8" r="0.6" fill="currentColor" />
    <circle cx="7" cy="16" r="0.6" fill="currentColor" />
  </svg>
);
const AccIconRadar = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M5 17a8 8 0 1 1 14 0" />
    <path d="M8 17a5 5 0 1 1 8 0" />
    <circle cx="12" cy="17" r="1.2" fill="currentColor" />
  </svg>
);
const AccIconSave = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M5 5h11l3 3v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" />
    <path d="M8 5v5h7V5M8 20v-6h8v6" />
  </svg>
);
const AccIconCloud = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M7 18a4 4 0 0 1 0-8 5 5 0 0 1 9.6-1.4A4 4 0 0 1 17 18H7z" />
  </svg>
);
const AccIconPower = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 4v8" />
    <path d="M7 7a7 7 0 1 0 10 0" />
  </svg>
);

const GlassControl: React.FC<{ settings: ClientSettings; updateSettings: (p: Partial<ClientSettings>) => void }> = ({ settings, updateSettings }) => {
  const zones = settings.glassZones ?? GLASS_DEFAULT_ZONES;
  const has = (z: GlassZone) => zones.includes(z);
  const toggle = (z: GlassZone, on: boolean) =>
    updateSettings({ glassZones: on ? Array.from(new Set([...zones, z])) : zones.filter((x) => x !== z) });
  const anyOn = zones.length > 0;
  return (
    <>
      <Row label="强度" sub="整体模糊与透明度；对下面所有开启的区域生效">
        <div className="v2-seg">
          {GLASS_INTENSITIES.map((i) => (
            <button
              key={i.id}
              className={`v2-seg-item${(settings.glassIntensity ?? 'standard') === i.id ? ' active' : ''}`}
              onClick={() => updateSettings({ glassIntensity: i.id })}
              disabled={!anyOn}
            >
              {i.label}
            </button>
          ))}
        </div>
      </Row>
      {GLASS_ZONES.map((z) => (
        <Row key={z.id} label={z.label} sub={z.sub}>
          <Switch checked={has(z.id)} onChange={(v) => toggle(z.id, v)} />
        </Row>
      ))}
    </>
  );
};

/** 外观面板：明暗 · 主题 · 毛玻璃 · 字体 — 从 偏好 抽出独立的左导航 tab。
 *  独立后用户更容易找到也更容易做"换皮"动作；旧的 偏好 现在专注对话行为
 *  与出字速度。注意：所有 setting key 都不变，对外行为 / 持久化无影响。 */
const AppearancePane: React.FC<{ settings: ClientSettings; updateSettings: (p: Partial<ClientSettings>) => void }> = ({ settings, updateSettings }) => (
  <>
    <Section title="明暗">
      <Row label="" sub="跟随系统会随 macOS / Windows 外观自动切换">
        <div className="v2-seg">
          {APPEARANCES.map((a) => (
            <button
              key={a.id}
              className={`v2-seg-item${(settings.appearance ?? 'system') === a.id ? ' active' : ''}`}
              onClick={() => updateSettings({ appearance: a.id })}
            >
              <span className="ic">{a.icon}</span>{a.label}
            </button>
          ))}
        </div>
      </Row>
    </Section>
    <Section title="主题">
      <Row label="" sub="只换配色，不动排版字体">
        <div className="v2-theme-row">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={`v2-theme-chip${(settings.theme ?? 'anthropic') === t.id ? ' active' : ''}`}
              onClick={() => updateSettings({ theme: t.id })}
              title={`${t.label} · ${t.sub}`}
            >
              <span className="sw" style={{ background: t.surface }}>
                {t.ramp.map((c, i) => <i key={i} style={{ background: c }} />)}
              </span>
              <span className="nm">{t.label}</span>
            </button>
          ))}
        </div>
      </Row>
    </Section>
    <Section title="毛玻璃" hint="半透明质感，逐个区域开关；开侧栏 / 顶栏会自动叠一层微弱环境色让玻璃显现">
      <GlassControl settings={settings} updateSettings={updateSettings} />
    </Section>
    <Section title="字体" hint="对话内容、输入框、UI 文字全部跟随切换；中日韩字符自动 fallback 到 PingFang / Songti / Noto Serif SC">
      <div className="v2-set-grid">
        {FONTS.map((f) => (
          <button
            key={f.id}
            className={`v2-set-card${settings.font === f.id ? ' active' : ''}`}
            onClick={() => updateSettings({ font: f.id })}
          >
            <span className="t" style={f.sampleStyle}>{f.label}</span>
            <span className="s" style={{ ...f.sampleStyle, fontSize: 11, marginTop: 2 }}>
              茶话 · Quick fox
            </span>
            <span style={{ fontSize: 8.5, color: 'var(--c-ink-4)', letterSpacing: '0.06em', marginTop: 2 }}>{f.tag}</span>
          </button>
        ))}
      </div>
    </Section>
  </>
);

const PrefsPane: React.FC<{ settings: ClientSettings; updateSettings: (p: Partial<ClientSettings>) => void }> = ({ settings, updateSettings }) => (
  <>
    <Section title="对话">
      <Row label="Enter 发送" sub="关闭后：Enter 换行，⌘/⌃+Enter 发送">
        <Switch checked={settings.cmdEnterToSend ?? true} onChange={(v) => updateSettings({ cmdEnterToSend: v })} />
      </Row>
      <Row label="启用工具调用" sub="允许 assistant 调用 MCP / 技能包">
        <Switch checked={settings.enableToolCalling} onChange={(v) => updateSettings({ enableToolCalling: v })} />
      </Row>
      <Row label="显示 token 消耗" sub="每条助手回复底下展示 token 数">
        <Switch checked={!!settings.showTokenCost} onChange={(v) => updateSettings({ showTokenCost: v })} />
      </Row>
      <Row label="自动 TTS" sub="助手回复完成后自动朗读">
        <Switch checked={!!settings.autoTTS} onChange={(v) => updateSettings({ autoTTS: v })} />
      </Row>
    </Section>
    <Section title="出字速度" hint="模型 token 是突发到达的（一坨一坨蹦）。开启后逐字匀速显示，更像打字机。闲聊 / agent对话 / Local Agents 共用此速度。">
      <Row label="匀速出字" sub="关闭则到达即显示">
        <Switch checked={settings.chatStreamSmooth ?? true} onChange={(v) => updateSettings({ chatStreamSmooth: v })} />
      </Row>
      {(settings.chatStreamSmooth ?? true) && (
        <Row label="速度" sub="慢 = 明显打字机感；快 = 几乎贴近实时">
          <SpeedSeg value={settings.chatStreamSpeed ?? 'normal'} onChange={(sp) => updateSettings({ chatStreamSpeed: sp })} />
        </Row>
      )}
    </Section>
  </>
);

/** 三档速度的分段控件（慢 / 适中 / 快）。 */
const SpeedSeg: React.FC<{ value: TypeSpeed; onChange: (v: TypeSpeed) => void }> = ({ value, onChange }) => (
  <div className="v2-seg">
    {(['slow', 'normal', 'fast'] as TypeSpeed[]).map((sp) => (
      <button
        key={sp}
        className={`v2-seg-item${value === sp ? ' active' : ''}`}
        onClick={() => onChange(sp)}
      >
        {TYPE_SPEED_LABELS[sp]}
      </button>
    ))}
  </div>
);

type LAProviderId = 'claude' | 'cursor' | 'codex' | 'gemini';
interface LAProvider {
  id: LAProviderId;
  label: string;
  /** 一句话说明：是谁、谁做的 */
  vendor: string;
  /** CLI 命令名（用户校验是否安装） */
  cli: string;
  /** 是否已支持实时对话 */
  live: boolean;
  /** 安装链接（hover title） */
  installUrl: string;
}
const LA_PROVIDERS: LAProvider[] = [
  { id: 'claude', label: 'Claude Code', vendor: 'Anthropic',     cli: 'claude',       live: true,  installUrl: 'https://docs.anthropic.com/claude/docs/claude-code' },
  { id: 'cursor', label: 'Cursor',       vendor: 'Cursor.com',   cli: 'cursor-agent', live: true,  installUrl: 'https://docs.cursor.com/cli' },
  { id: 'codex',  label: 'Codex',        vendor: 'OpenAI',       cli: 'codex',        live: false, installUrl: 'https://platform.openai.com/docs/codex' },
  { id: 'gemini', label: 'Gemini',       vendor: 'Google',       cli: 'gemini',       live: false, installUrl: 'https://github.com/google-gemini/gemini-cli' },
];

/** Cursor headless 模式需要 API Key（cursor-agent 的交互式登录态不被 -p 模式认）。
 *  存后端（/api/local-agent/credentials），驱动起进程时注入 CURSOR_API_KEY。 */
const CursorKeyRow: React.FC = () => {
  const [masked, setMasked] = useState<string | null>(null);   // 已存的（打码）
  const [input, setInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    api.get<Array<{ provider: string; api_key?: string }>>('/api/local-agent/credentials')
      .then((list) => { const c = (list || []).find((x) => x.provider === 'cursor'); setMasked(c?.api_key || null); })
      .catch(() => {});
  }, []);

  const onSave = async () => {
    const key = input.trim();
    if (!key) return;
    setSaving(true); setMsg(null);
    try {
      const r = await api.put<{ api_key?: string }>('/api/local-agent/credentials/cursor', { api_key: key });
      setMasked(r?.api_key || null); setInput(''); setMsg('已保存');
    } catch (e: any) { setMsg(e?.message || '保存失败'); }
    finally { setSaving(false); }
  };

  return (
    <Row label="Cursor API Key" sub={masked ? `当前：${masked}（headless 模式必需；cursor.com 控制台获取）` : 'headless 模式必需 —— cursor.com 控制台获取后填入'}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          type="password"
          className="v2-set-select"
          style={{ minWidth: 240 }}
          placeholder={masked ? '输入新 Key 覆盖' : 'crsr_…'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void onSave(); }}
        />
        <button className="v2-set-btn primary" disabled={saving || !input.trim()} onClick={() => void onSave()}>{saving ? '保存中…' : '保存'}</button>
        {msg && <span className="v2-pill ok">{msg}</span>}
      </div>
    </Row>
  );
};

const LocalAgentPane: React.FC<{ settings: ClientSettings; updateSettings: (p: Partial<ClientSettings>) => void }> = ({ settings, updateSettings }) => {
  const cur = settings.localAgentProvider ?? 'claude';
  return (
    <>
      <Section title="Local Agents" hint="在你机器上跑本地 CLI Agent（仅桌面版）。对话与文件都留在本地，与 Chaya 服务无关。点卡片即可设为默认；侧栏徽标随选择切换。">
        <div className="v2-la-prov-grid">
          {LA_PROVIDERS.map((p) => (
            <LAProviderCard
              key={p.id}
              p={p}
              isDefault={cur === p.id}
              onSetDefault={() => p.live && updateSettings({ localAgentProvider: p.id })}
            />
          ))}
        </div>
      </Section>
      <Section title="权限模式" hint="对话框里按 Tab 键即时切换。Claude：Default / Plan / Accept Edits / Bypass；Cursor：Plan / Ask / Force。">
        <Row label="说明" sub="Plan = 只读规划；Ask = 只读问答；Accept Edits = 自动改文件；Bypass / Force = 全自动执行。每次对话用当前选择的模式。">
          <div className="v2-set-val">在对话输入框右下角查看与切换</div>
        </Row>
      </Section>
    </>
  );
};

/** 单个 provider 卡片：头（dot + 名 + 厂商 + 状态 pill + 「默认」徽标）+ 配置体。
 *  Live provider 才能被设为默认；soon 卡片置灰、不可点击但展示安装链接。 */
const LAProviderCard: React.FC<{
  p: LAProvider;
  isDefault: boolean;
  onSetDefault: () => void;
}> = ({ p, isDefault, onSetDefault }) => {
  return (
    <div className={`v2-la-prov${isDefault ? ' is-default' : ''}${!p.live ? ' is-soon' : ''}`}>
      <div className="v2-la-prov-hd"
        role={p.live ? 'button' : undefined}
        tabIndex={p.live ? 0 : -1}
        onClick={p.live ? onSetDefault : undefined}
        onKeyDown={p.live ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSetDefault(); } } : undefined}
        title={p.live ? '点击设为默认' : '即将接入'}
      >
        <span className={`v2-la-setdot prov-${p.id}`} />
        <div className="v2-la-prov-meta">
          <div className="nm">{p.label}{isDefault && <span className="v2-la-prov-def">默认</span>}</div>
          <div className="sub">{p.vendor} · <code>{p.cli}</code></div>
        </div>
        <span className={`v2-pill ${p.live ? 'ok' : 'mute'}`}>{p.live ? '已就绪' : 'soon'}</span>
      </div>
      <div className="v2-la-prov-body">
        {p.id === 'claude' && (
          <Row label="CLI" sub="安装后 chaya 自动探测；首次使用按提示登录 Anthropic 账号">
            <a className="v2-set-btn" href={p.installUrl} target="_blank" rel="noreferrer">安装指南</a>
          </Row>
        )}
        {p.id === 'cursor' && <CursorKeyRow />}
        {p.id === 'codex' && (
          <Row label="状态" sub="OpenAI Codex CLI 接入中；目前可先安装观望">
            <a className="v2-set-btn" href={p.installUrl} target="_blank" rel="noreferrer">了解</a>
          </Row>
        )}
        {p.id === 'gemini' && (
          <Row label="状态" sub="Google Gemini CLI 接入中；目前可先安装观望">
            <a className="v2-set-btn" href={p.installUrl} target="_blank" rel="noreferrer">了解</a>
          </Row>
        )}
      </div>
    </div>
  );
};

/** 外部 · 服务 —— Chaya 主后端 + Smartnote 云知识。两个独立后端集中一页，
 *  各自一行式凭据 + 探测 + 保存；Smartnote 下方紧跟检索行为开关。
 *  描述压到副标题级别（11.5px ink-4），不让段落 hint 抢走焦点。 */
const ServicesPane: React.FC<{ settings: ClientSettings; updateSettings: (p: Partial<ClientSettings>) => void }> = ({ settings, updateSettings }) => {
  // ── Chaya 主后端 ────────────────────────────────────────────
  const savedChaya = (typeof window !== 'undefined' && localStorage.getItem('chatee_backend_url')) || '';
  const [chayaUrl, setChayaUrl] = useState(savedChaya);
  const [chayaProbe, setChayaProbe] = useState<{ ok: boolean; text: string } | null>(null);
  const [chayaProbing, setChayaProbing] = useState(false);
  const effectiveChaya = getBackendUrl();
  const trimmedChaya = chayaUrl.trim();
  const chayaDirty = trimmedChaya !== savedChaya;
  const onProbeChaya = async () => {
    const base = (trimmedChaya || effectiveChaya).replace(/\/+$/, '');
    setChayaProbing(true); setChayaProbe(null);
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch(`${base}/health`, { signal: ctrl.signal });
      clearTimeout(t);
      setChayaProbe(r.ok ? { ok: true, text: `通了 · ${r.status}` } : { ok: false, text: `响应 ${r.status}` });
    } catch (e: any) {
      setChayaProbe({ ok: false, text: e?.name === 'AbortError' ? '超时' : '连不上' });
    } finally { setChayaProbing(false); }
  };
  const onSaveChaya = () => {
    if (trimmedChaya) localStorage.setItem('chatee_backend_url', trimmedChaya);
    else localStorage.removeItem('chatee_backend_url');
    (window as any).__cachedBackendUrl = trimmedChaya;
    if (window.confirm('已保存，需要刷新页面才能生效。现在刷新？')) window.location.reload();
  };

  // ── Smartnote 云知识 ─────────────────────────────────────────
  const [snKey, setSnKey] = useState(getSmartnoteApiKey());
  const [snBase, setSnBase] = useState(getSmartnoteBaseUrl());
  const [snProbing, setSnProbing] = useState(false);
  const [snProbe, setSnProbe] = useState<{ ok: boolean; text: string } | null>(null);
  const onSaveSn = () => {
    setSmartnoteBaseUrl(snBase.trim());
    setSmartnoteApiKey(snKey.trim());
    setSnProbe(null);
  };
  const onProbeSn = async () => {
    setSmartnoteBaseUrl(snBase.trim());
    setSmartnoteApiKey(snKey.trim());
    setSnProbing(true); setSnProbe(null);
    try {
      const r = await smartnoteProbe();
      setSnProbe(r.ok ? { ok: true, text: '通了' } : { ok: false, text: r.error || '失败' });
    } catch (e: any) {
      setSnProbe({ ok: false, text: e?.message || '失败' });
    } finally { setSnProbing(false); }
  };

  return (
    <div className="v2-acc">
      {/* ── Chaya 服务器 ── */}
      <div className="v2-acc-block">
        <div className="v2-acc-block-hd"><AccIconServer /><span>Chaya 服务器</span></div>
        <div className="v2-acc-endpoint">
          <input
            className="v2-set-select v2-acc-input"
            value={chayaUrl}
            onChange={(e) => { setChayaUrl(e.target.value); setChayaProbe(null); }}
            placeholder="http://localhost:3002"
            aria-label="Chaya 后端地址"
          />
          <button
            className="v2-set-btn v2-acc-btn"
            onClick={() => void onProbeChaya()}
            disabled={chayaProbing}
            title="探测连接"
          >
            <AccIconRadar /><span>{chayaProbing ? '探测中' : '探测'}</span>
          </button>
          <button
            className="v2-set-btn primary v2-acc-btn"
            onClick={onSaveChaya}
            disabled={!chayaDirty}
            title="保存并刷新"
          >
            <AccIconSave /><span>保存</span>
          </button>
        </div>
        <div className="v2-acc-endpoint-meta">
          {chayaProbe && (
            <span className={`v2-pill ${chayaProbe.ok ? 'ok' : 'mute'}`} style={!chayaProbe.ok ? { background: '#fff7ed', color: '#c2410c' } : undefined}>
              {chayaProbe.text}
            </span>
          )}
          <span className="v2-acc-endpoint-current" title={effectiveChaya}>当前 · {effectiveChaya}</span>
        </div>
      </div>

      {/* ── Smartnote 云知识 ── */}
      <div className="v2-acc-block">
        <div className="v2-acc-block-hd"><AccIconCloud /><span>Smartnote 云知识</span></div>
        <div className="v2-acc-endpoint">
          <input
            className="v2-set-select v2-acc-input"
            type="password"
            value={snKey}
            onChange={(e) => { setSnKey(e.target.value); setSnProbe(null); }}
            placeholder="API Key (sn_…)"
            aria-label="Smartnote API Key"
          />
          <button
            className="v2-set-btn v2-acc-btn"
            onClick={() => void onProbeSn()}
            disabled={snProbing || !snKey.trim()}
            title="探测连接"
          >
            <AccIconRadar /><span>{snProbing ? '探测中' : '探测'}</span>
          </button>
          <button
            className="v2-set-btn primary v2-acc-btn"
            onClick={onSaveSn}
            disabled={!snKey.trim()}
            title="保存凭据"
          >
            <AccIconSave /><span>保存</span>
          </button>
        </div>
        <div className="v2-acc-endpoint">
          <input
            className="v2-set-select v2-acc-input"
            value={snBase}
            onChange={(e) => { setSnBase(e.target.value); setSnProbe(null); }}
            placeholder="Base URL · 留空使用默认 https://api.smartnote.cloud"
            aria-label="Smartnote Base URL"
          />
        </div>
        {snProbe && (
          <div className="v2-acc-endpoint-meta">
            <span className={`v2-pill ${snProbe.ok ? 'ok' : 'mute'}`} style={!snProbe.ok ? { background: '#fff7ed', color: '#c2410c' } : undefined}>
              {snProbe.text}
            </span>
          </div>
        )}

        {/* RAG 行为 —— 仅在 key 输入后展示，没配凭据这些开关也没意义。 */}
        {snKey.trim() && (
          <div className="v2-acc-rag">
            <div className="v2-acc-rag-row">
              <span className="v2-acc-rag-lab">检索</span>
              <Switch checked={!!settings.ragEnabled} onChange={(v) => updateSettings({ ragEnabled: v })} />
              <span className="v2-acc-rag-sub">发送前自动捞相关上下文拼到消息顶</span>
            </div>
            {!!settings.ragEnabled && (
              <>
                <div className="v2-acc-rag-row">
                  <span className="v2-acc-rag-lab">topK</span>
                  <select
                    className="v2-set-select v2-acc-rag-sel"
                    value={settings.ragTopK ?? 5}
                    onChange={(e) => updateSettings({ ragTopK: Number(e.target.value) })}
                  >
                    {[3, 5, 8, 12, 20].map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                  <span className="v2-acc-rag-sub">一次召回多少条</span>
                </div>
                <div className="v2-acc-rag-row">
                  <span className="v2-acc-rag-lab">范围</span>
                  <select
                    className="v2-set-select v2-acc-rag-sel"
                    value={settings.ragScope ?? 'auto'}
                    onChange={(e) => updateSettings({ ragScope: e.target.value as ClientSettings['ragScope'] })}
                  >
                    <option value="auto">auto</option>
                    <option value="agent">agent</option>
                    <option value="workspace">workspace</option>
                  </select>
                  <span className="v2-acc-rag-sub">auto · 让 AI 选 · agent · 仅本 agent · workspace · 整库</span>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

/* ============ models pane — 以 API Key 为中心的「凭证 + 动态模型」 ============ *
 * 每接入一个 provider = 一份凭证（一个 api_key + base_url）；其下的「可用模型」
 * 从 provider API 动态拉取，启用哪些就建哪些 LLMConfig（共享该 key）。复用现有后端：
 * 一份凭证 = 该 provider 下共享 key 的一组 config。 */

const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI', deepseek: 'DeepSeek', anthropic: 'Anthropic',
  gemini: 'Gemini', ollama: 'Ollama', local: 'Local', custom: 'Custom',
};

/** 接入/管理凭证的草稿：provider + key(+url) + 该 provider 现有的 config（编辑态）。 */
interface CredDraft {
  provider: string;
  api_key: string;   // 编辑态留空 = 不改 key
  api_url: string;
  existing: LLMConfigFromDB[];
}

const ModelsPane: React.FC<{ settings: ClientSettings; updateSettings: (p: Partial<ClientSettings>) => void }> = ({ settings, updateSettings }) => {
  const [list, setList] = useState<LLMConfigFromDB[] | null>(null);
  const [cred, setCred] = useState<CredDraft | null>(null);
  const refresh = () => getLLMConfigs().then((l) => setList(Array.isArray(l) ? l : [])).catch(() => setList([]));
  useEffect(() => { refresh(); }, []);

  const defaultId = settings.defaultLLMConfigId;
  const setDefault = (id?: string) => updateSettings({ defaultLLMConfigId: id });

  // 一个 provider = 一份凭证；其下 config = 已启用的模型。
  const groups = useMemo(() => {
    if (!list) return null;
    const map = new Map<string, LLMConfigFromDB[]>();
    for (const c of list) {
      const k = c.provider || 'custom';
      (map.get(k) || map.set(k, []).get(k)!).push(c);
    }
    return Array.from(map.entries()).map(([provider, configs]) => ({ provider, configs }));
  }, [list]);
  const enabledCount = (list || []).filter((c) => c.enabled !== false).length;

  const onToggle = async (c: LLMConfigFromDB, key: 'enabled' | 'media_visible') => {
    try { await updateLLMConfig(c.config_id, { [key]: !c[key] } as any); refresh(); }
    catch (e: any) { window.alert(e?.message || '失败'); }
  };
  const onDeleteModel = async (c: LLMConfigFromDB) => {
    try { await deleteLLMConfig(c.config_id); if (defaultId === c.config_id) setDefault(undefined); refresh(); }
    catch (e: any) { window.alert(e?.message || '失败'); }
  };
  const onDeleteCred = async (provider: string, configs: LLMConfigFromDB[]) => {
    if (!window.confirm(`移除 ${PROVIDER_LABELS[provider] || provider} 凭证？其下 ${configs.length} 个模型都会删除。`)) return;
    try {
      await Promise.all(configs.map((c) => deleteLLMConfig(c.config_id)));
      if (configs.some((c) => c.config_id === defaultId)) setDefault(undefined);
      refresh();
    } catch (e: any) { window.alert(e?.message || '失败'); }
  };
  const onManage = async (provider: string, configs: LLMConfigFromDB[]) => {
    let api_key = '';
    if (configs[0]) { try { api_key = await getLLMConfigApiKey(configs[0].config_id); } catch {/* */} }
    setCred({ provider, api_key, api_url: configs[0]?.api_url || '', existing: configs });
  };
  const onAddCred = () => setCred({ provider: 'openai', api_key: '', api_url: '', existing: [] });

  return (
    <>
      <Section
        title="模型"
        hint="以 API Key 为单位接入 provider —— 填一次 key，动态拉取它的可用模型，按需启用。agent / 茶话 / 创作都从这里挑模型。"
        trailing={<button className="v2-set-btn primary" onClick={onAddCred}>＋ 接入</button>}
      >
        {!list && <div className="v2-set-empty">加载中…</div>}
        {list && list.length === 0 && <div className="v2-set-empty">还没接入任何 provider — 点右上角「接入」，填 API Key 即可拉取模型</div>}
        {groups && groups.length > 0 && (
          <div className="v2-cred-count">{groups.length} 家 · {enabledCount} 款已启用</div>
        )}
        {groups && groups.map((g) => (
          <div key={g.provider} className="v2-cred">
            <div className="v2-cred-hd">
              <span className="av" data-p={g.provider}>{(PROVIDER_LABELS[g.provider] || g.provider).charAt(0)}</span>
              <div className="meta">
                <div className="nm">{PROVIDER_LABELS[g.provider] || g.provider}</div>
                <div className="sub">
                  <span className="v2-pill ok">已连</span>
                  <span className="cnt">{g.configs.length} 款</span>
                  {g.configs[0]?.api_url && <span className="v2-pill mute" title={g.configs[0].api_url}>自定义 URL</span>}
                </div>
              </div>
              <div className="acts">
                <button className="v2-set-btn" onClick={() => void onManage(g.provider, g.configs)}>管理模型</button>
                <button className="v2-set-danger" onClick={() => void onDeleteCred(g.provider, g.configs)}>移除</button>
              </div>
            </div>
            <div className="v2-cred-models">
              {g.configs.map((c) => {
                const isDefault = defaultId === c.config_id;
                const isEnabled = c.enabled !== false;
                return (
                  <div key={c.config_id} className={`v2-cred-model${isDefault ? ' is-default' : ''}`}>
                    <button
                      className={`star${isDefault ? ' on' : ''}`}
                      title={isDefault ? '当前默认（点击取消）' : isEnabled ? '设为新会话默认' : '停用的模型不能设为默认'}
                      disabled={!isEnabled && !isDefault}
                      onClick={() => setDefault(isDefault ? undefined : c.config_id)}
                    >{isDefault ? '★' : '☆'}</button>
                    <code className="mid" title={c.model}>{c.model || '—'}</code>
                    <div className="grow" />
                    <label className="tg" title="在创作面板可选（生图/视频）">
                      <span>创作</span>
                      <Switch checked={!!c.media_visible} onChange={() => void onToggle(c, 'media_visible')} />
                    </label>
                    <label className="tg" title="启用后可被 agent/会话选用">
                      <span>启用</span>
                      <Switch checked={isEnabled} onChange={() => void onToggle(c, 'enabled')} />
                    </label>
                    <button className="del" title="删除该模型" onClick={() => void onDeleteModel(c)}>✕</button>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </Section>

      {cred && (
        <CredentialModal
          draft={cred}
          onClose={() => setCred(null)}
          onSaved={() => { setCred(null); refresh(); }}
        />
      )}
    </>
  );
};

/* 接入/管理一份凭证：选 provider、填 key+url、动态拉取可用模型、勾选启用。
 * 勾选 = 建/留 config（共享该 key）；取消勾选已有 = 删该 config。改了 key/url 则同步到该凭证全部模型。 */
const CredentialModal: React.FC<{
  draft: CredDraft;
  onClose: () => void;
  onSaved: () => void;
}> = ({ draft, onClose, onSaved }) => {
  const editMode = draft.existing.length > 0;
  const [provider, setProvider] = useState(draft.provider);
  const [apiKey, setApiKey] = useState(draft.api_key);
  const [apiUrl, setApiUrl] = useState(draft.api_url);
  const [providers, setProviders] = useState<SupportedProvider[] | null>(null);
  const [models, setModels] = useState<{ id: string; name: string }[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(() => new Set(draft.existing.map((c) => c.model).filter((m): m is string => !!m)));
  const [fetching, setFetching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { getSupportedProviders().then(setProviders).catch(() => setProviders([])); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // 编辑态进来若已有 key，自动拉一次模型，省一次点击。
  useEffect(() => { if (editMode && draft.api_key.trim()) void fetchModels(draft.api_key, draft.provider, draft.api_url); /* eslint-disable-next-line */ }, []);

  const fetchModels = async (key = apiKey, prov = provider, url = apiUrl) => {
    if (!key.trim()) { setErr('先填 API Key'); return; }
    setErr(''); setFetching(true);
    try {
      const ms = await listAvailableModels(prov, key.trim(), url.trim() || undefined);
      // 已启用的模型即便没在返回里也并进来，避免「拉取后旧模型消失」。
      const ids = new Set(ms.map((m) => m.id));
      const merged = [...ms, ...draft.existing.filter((c) => !!c.model && !ids.has(c.model)).map((c) => ({ id: c.model as string, name: c.model as string }))];
      setModels(merged);
    } catch (e: any) { setErr(e?.message || '拉取模型失败'); setModels([]); }
    finally { setFetching(false); }
  };

  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const save = async () => {
    if (sel.size === 0) { setErr('至少选一个模型'); return; }
    setBusy(true); setErr('');
    const key = apiKey.trim();
    const url = apiUrl.trim();
    try {
      const existingByModel = new Map(draft.existing.map((c) => [c.model, c]));
      // 1) 新勾选且无 config → 建。
      for (const model of sel) {
        const cur = existingByModel.get(model);
        if (!cur) {
          await createLLMConfig({ provider: provider as LLMConfigFromDB['provider'], name: model, shortname: model, model, api_key: key || undefined, api_url: url || undefined, enabled: true });
        } else if (key || url !== (cur.api_url || '')) {
          // 仍勾选但凭证(key/url)变了 → 同步。
          await updateLLMConfig(cur.config_id, { api_key: key || undefined, api_url: url || undefined });
        }
      }
      // 2) 原有但取消勾选 → 删。
      for (const c of draft.existing) {
        if (c.model && !sel.has(c.model)) await deleteLLMConfig(c.config_id);
      }
      onSaved();
    } catch (e: any) { setErr(e?.message || '保存失败'); }
    finally { setBusy(false); }
  };

  // 后端 providers 列表是 LLM 配置数（同一 provider_type 可能有多条 —— 不同 key），
  // 这里只用来填 <select>，要 dedupe 一下，否则 React 会抱怨重复 key。
  const provTypes = providers && providers.length > 0
    ? Array.from(new Set(providers.map((p) => p.provider_type)))
    : ['openai', 'deepseek', 'anthropic', 'gemini', 'ollama', 'custom'];

  return (
    <div className="v2-modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} style={{ zIndex: 110 }}>
      <div className="v2-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="v2-modal-hd">
          <h3>{editMode ? `${PROVIDER_LABELS[provider] || provider} · 凭证与模型` : '接入 provider'}</h3>
          <button className="x" onClick={onClose}>✕</button>
        </div>
        <div className="v2-modal-body">
          <div className="v2-modal-sec">
            <div className="lab">Provider</div>
            <select className="v2-set-select" style={{ width: '100%' }} value={provider} disabled={editMode} onChange={(e) => { setProvider(e.target.value); setModels(null); }}>
              {provTypes.map((pt) => <option key={pt} value={pt}>{PROVIDER_LABELS[pt] || pt}</option>)}
            </select>
          </div>
          <div className="v2-modal-sec">
            <div className="lab">API Key {editMode && <span style={{ color: 'var(--c-ink-4)' }}>(不改就留空)</span>}</div>
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" />
          </div>
          <div className="v2-modal-sec">
            <div className="lab">Base URL <span style={{ color: 'var(--c-ink-4)' }}>(可选 — 自托管 / proxy)</span></div>
            <input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder="https://api.openai.com/v1" />
          </div>
          <div className="v2-modal-sec">
            <div className="lab" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>可用模型 {sel.size > 0 && <span style={{ color: 'var(--c-ink-4)' }}>· 选了 {sel.size}</span>}</span>
              <button className="v2-set-btn" style={{ marginLeft: 'auto' }} onClick={() => void fetchModels()} disabled={fetching}>
                {fetching ? '拉取中…' : models ? '重新拉取' : '拉取模型'}
              </button>
            </div>
            {!models && !fetching && <div className="v2-set-empty" style={{ margin: 0 }}>填好 Key 后点「拉取模型」从 {PROVIDER_LABELS[provider] || provider} 动态获取</div>}
            {models && models.length === 0 && !fetching && <div className="v2-set-empty" style={{ margin: 0 }}>没拉到模型 — 检查 Key / URL</div>}
            {models && models.length > 0 && (
              <div className="v2-cred-pick">
                {models.map((m) => (
                  <label key={m.id} className={`v2-cred-pick-row${sel.has(m.id) ? ' on' : ''}`}>
                    <input type="checkbox" checked={sel.has(m.id)} onChange={() => toggle(m.id)} />
                    <code>{m.id}</code>
                    {m.name && m.name !== m.id && <span className="nm">{m.name}</span>}
                  </label>
                ))}
              </div>
            )}
          </div>
          {err && <div className="v2-set-empty" style={{ color: 'var(--c-danger)', margin: 0 }}>{err}</div>}
        </div>
        <div className="v2-modal-foot">
          <button className="v2-mbtn" onClick={onClose} disabled={busy}>取消</button>
          <button className="v2-mbtn primary" onClick={() => void save()} disabled={busy}>{busy ? '保存中…' : '保存'}</button>
        </div>
      </div>
    </div>
  );
};

/* ============ MCP pane (v2 native) ============ */

const McpPane: React.FC = () => {
  const [list, setList] = useState<MCPServer[] | null>(null);
  const refresh = () => mcpApi.list().then((l) => setList(Array.isArray(l) ? l : [])).catch(() => setList([]));
  useEffect(() => { refresh(); }, []);
  const [editing, setEditing] = useState<null | { id?: string; name: string; url: string; type: 'http' | 'sse' | 'stdio'; enabled: boolean }>(null);

  const onProbe = async (m: MCPServer) => {
    try {
      const res = await mcpApi.probe(m.id);
      window.alert(res.ok ? `通：${res.tool_count} 个工具${res.tools ? `\n${res.tools.slice(0, 12).join(', ')}` : ''}` : `不通：${res.error || '未知'}`);
      refresh();
    } catch (e: any) { window.alert(e?.message || '探测失败'); }
  };
  const onToggle = async (m: MCPServer) => {
    try { await mcpApi.update(m.id, { enabled: !m.enabled }); refresh(); }
    catch (e: any) { window.alert(e?.message || '失败'); }
  };
  const onDelete = async (m: MCPServer) => {
    if (!window.confirm(`删除 MCP「${m.name}」？所有 agent 上的绑定都会失效。`)) return;
    try { await mcpApi.remove(m.id); refresh(); } catch (e: any) { window.alert(e?.message || '失败'); }
  };
  const onEdit = (m: MCPServer) => setEditing({
    id: m.id, name: m.name, url: m.url, type: (m.type as any) || 'http', enabled: !!m.enabled,
  });
  const onAdd = () => setEditing({ name: '', url: '', type: 'http', enabled: true });

  return (
    <>
      <Section
        title="MCP 工具服务"
        hint="集成第三方工具 — agent 上单独绑定使用"
        trailing={<button className="v2-set-btn primary" onClick={onAdd}>＋ 添加</button>}
      >
        {!list && <div className="v2-set-empty">加载中…</div>}
        {list && list.length === 0 && <div className="v2-set-empty">还没有 MCP 服务器 — 点右上角「添加」</div>}
        {list && list.map((m) => (
          <McpRow
            key={m.id}
            m={m}
            onProbe={onProbe}
            onToggle={onToggle}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        ))}
      </Section>

      {editing && (
        <McpEditModal
          draft={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh(); }}
        />
      )}
    </>
  );
};

/* A single MCP server row. Owns its OAuth state so the authorize/re-authorize
   button + status pill (已授权 / 已过期 / 未授权) live per-server. */
const McpRow: React.FC<{
  m: MCPServer;
  onProbe: (m: MCPServer) => void | Promise<void>;
  onToggle: (m: MCPServer) => void | Promise<void>;
  onEdit: (m: MCPServer) => void;
  onDelete: (m: MCPServer) => void | Promise<void>;
}> = ({ m, onProbe, onToggle, onEdit, onDelete }) => {
  // stdio servers run as a child process — no OAuth. http/sse may need it.
  const oauthEligible = m.type !== 'stdio';
  const [hasToken, setHasToken] = useState<boolean | null>(null);
  const [expired, setExpired] = useState(false);
  const [authBusy, setAuthBusy] = useState<'discover' | 'redirect' | 'polling' | null>(null);

  // Probe token status on mount + whenever the URL changes.
  useEffect(() => {
    if (!oauthEligible || !m.url) return;
    let cancelled = false;
    oauthApi.tokenStatus(m.url)
      .then((r) => { if (!cancelled) { setHasToken(!!r?.has_token); setExpired(!!r?.expired); } })
      .catch(() => { if (!cancelled) { setHasToken(null); setExpired(false); } });
    return () => { cancelled = true; };
  }, [oauthEligible, m.url]);

  const authorize = async () => {
    if (!m.url) return;
    setAuthBusy('discover');
    try {
      const meta = await oauthApi.discover(m.url);
      if (!meta?.authorization_endpoint || !meta?.token_endpoint) {
        window.alert('这个服务器不需要 OAuth（没发现 authorization_endpoint）');
        setAuthBusy(null);
        return;
      }
      const auth = await oauthApi.authorize({ ...meta, mcp_url: m.url });
      if (!auth?.authorization_url) {
        window.alert('没拿到授权 URL');
        setAuthBusy(null);
        return;
      }
      setAuthBusy('redirect');
      // In Electron, setWindowOpenHandler opens the URL in the system browser
      // and denies the in-app popup, so window.open returns null — that's the
      // happy path, not a blocked popup. Only treat null as "blocked" on web.
      const isElectron = (import.meta as any).env?.VITE_ELECTRON === 'true';
      const popup = window.open(auth.authorization_url, 'mcp-oauth', 'width=520,height=720,menubar=no,toolbar=no');
      if (!popup && !isElectron) {
        window.alert('浏览器拦了弹窗，允许弹窗后重试');
        setAuthBusy(null);
        return;
      }
      // Poll token-status until the backend stores the token (it does so
      // server-side on callback, so this works whether auth happens in an
      // in-app popup or the external browser). Give up after 3 min so a
      // cancelled flow doesn't spin forever.
      setAuthBusy('polling');
      const start = Date.now();
      const POLL_MS = 1500;
      const TIMEOUT_MS = 3 * 60 * 1000;
      const tick = async (): Promise<void> => {
        try {
          const st = await oauthApi.tokenStatus(m.url);
          if (st?.has_token) {
            setHasToken(true);
            setExpired(false);
            setAuthBusy(null);
            if (popup) popup.close();
            void onProbe(m); // re-probe so tools light up
            return;
          }
        } catch { /* ignore one-off poll errors */ }
        if (popup && popup.closed) { setAuthBusy(null); return; }
        if (Date.now() - start > TIMEOUT_MS) {
          setAuthBusy(null);
          window.alert('授权超时（3 分钟没完成），重试一下');
          return;
        }
        setTimeout(() => void tick(), POLL_MS);
      };
      void tick();
    } catch (e: any) {
      window.alert(e?.message || '授权失败');
      setAuthBusy(null);
    }
  };

  const authPill = () => {
    if (!oauthEligible) return null;
    if (authBusy === 'polling') return <span className="v2-pill warn">等回调…</span>;
    if (hasToken === true) return <span className="v2-pill ok">已授权</span>;
    if (expired) return <span className="v2-pill warn">已过期</span>;
    if (hasToken === false) return <span className="v2-pill mute">未授权</span>;
    return null;
  };

  const authLabel =
    authBusy === 'discover' ? '探…'
    : authBusy === 'redirect' ? '跳…'
    : authBusy === 'polling' ? '等回调'
    : (hasToken || expired ? '重授权' : '授权');

  return (
    <div className="v2-set-card-row">
      <div className="l">
        <div className="t">{m.name} <small>{m.type}</small></div>
        <div className="s">
          {m.enabled ? <span className="v2-pill ok">启用</span> : <span className="v2-pill mute">停用</span>}
          {m.healthy ? <span className="v2-pill ok">在线</span> : <span className="v2-pill mute">未探测</span>}
          {authPill()}
          <span className="v2-pill mute" title={m.url}>{m.url.length > 40 ? m.url.slice(0, 38) + '…' : m.url}</span>
        </div>
      </div>
      <div className="r">
        <button className="v2-set-btn" onClick={() => void onProbe(m)}>探测</button>
        {oauthEligible && (
          <button className="v2-set-btn" onClick={() => void authorize()} disabled={!!authBusy || !m.enabled}>
            {authLabel}
          </button>
        )}
        <button className="v2-set-btn" onClick={() => void onToggle(m)}>{m.enabled ? '停用' : '启用'}</button>
        <button className="v2-set-btn" onClick={() => onEdit(m)}>编辑</button>
        <button className="v2-set-danger" onClick={() => void onDelete(m)}>删除</button>
      </div>
    </div>
  );
};

const McpEditModal: React.FC<{
  draft: { id?: string; name: string; url: string; type: 'http' | 'sse' | 'stdio'; enabled: boolean };
  onClose: () => void;
  onSaved: () => void;
}> = ({ draft, onClose, onSaved }) => {
  const [d, setD] = useState(draft);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const save = async () => {
    if (!d.name.trim() || !d.url.trim()) { window.alert('名字和 URL 必填'); return; }
    setBusy(true);
    try {
      if (d.id) {
        await mcpApi.update(d.id, { name: d.name.trim(), url: d.url.trim(), type: d.type, enabled: d.enabled });
      } else {
        await mcpApi.create({ name: d.name.trim(), url: d.url.trim(), type: d.type, enabled: d.enabled });
      }
      onSaved();
    } catch (e: any) { window.alert(e?.message || '保存失败'); }
    finally { setBusy(false); }
  };
  return (
    <div className="v2-modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} style={{ zIndex: 110 }}>
      <div className="v2-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="v2-modal-hd">
          <h3>{d.id ? '编辑 MCP' : '添加 MCP'}</h3>
          <button className="x" onClick={onClose}>✕</button>
        </div>
        <div className="v2-modal-body">
          <div className="v2-modal-sec">
            <div className="lab">名字</div>
            <input autoFocus value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="如：feishu / gitlab" />
          </div>
          <div className="v2-modal-sec">
            <div className="lab">URL / 命令</div>
            <input value={d.url} onChange={(e) => setD({ ...d, url: e.target.value })} placeholder="https://… 或 stdio 启动命令" />
          </div>
          <div className="v2-modal-sec">
            <div className="lab">传输</div>
            <select className="v2-set-select" style={{ width: '100%' }} value={d.type} onChange={(e) => setD({ ...d, type: e.target.value as any })}>
              <option value="http">http</option>
              <option value="sse">sse</option>
              <option value="stdio">stdio</option>
            </select>
          </div>
          <div className="v2-modal-sec">
            <div className="v2-set-row" style={{ padding: 0 }}>
              <div className="v2-set-row-l"><div className="lab">启用</div></div>
              <Switch checked={d.enabled} onChange={(v) => setD({ ...d, enabled: v })} />
            </div>
          </div>
        </div>
        <div className="v2-modal-foot">
          <button className="v2-mbtn" onClick={onClose} disabled={busy}>取消</button>
          <button className="v2-mbtn primary" onClick={() => void save()} disabled={busy}>{busy ? '保存中…' : '保存'}</button>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;
