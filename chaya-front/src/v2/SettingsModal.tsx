import React, { useEffect, useMemo, useRef, useState } from 'react';
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
import { type TypeSpeed } from './typewriter';
import { getBackendUrl } from '../utils/backendUrl';
import { isLocalAgentAvailable } from './services/localAgent';
import {
  IconUser, IconGear, IconModel, IconPlug, IconCloud, IconTerminal, IconAppearance,
} from './icons';
import { useI18n, LANGS, type Lang } from '../i18n';

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
// `group` / `label` hold i18n keys (see i18n/dictionaries.ts), translated at render.
const TAB_GROUPS: { group: string; items: { id: Tab; label: string; icon: React.ReactNode }[] }[] = [
  {
    group: 'settings.group.personal',
    items: [
      { id: 'account',    label: 'settings.tab.account',    icon: <IconUser /> },
      { id: 'appearance', label: 'settings.tab.appearance', icon: <IconAppearance /> },
      { id: 'prefs',      label: 'settings.tab.prefs',      icon: <IconGear /> },
    ],
  },
  {
    group: 'settings.group.capability',
    items: [
      { id: 'models',  label: 'settings.tab.models', icon: <IconModel /> },
      { id: 'mcp',     label: 'settings.tab.mcp',    icon: <IconPlug /> },
    ],
  },
  {
    group: 'settings.group.external',
    items: [
      { id: 'services', label: 'settings.tab.services', icon: <IconCloud /> },
    ],
  },
  ...(isLocalAgentAvailable() ? [{
    group: 'settings.group.desktop',
    items: [
      { id: 'localagent' as Tab, label: 'settings.tab.localagent', icon: <IconTerminal /> },
    ],
  }] : []),
];

// Minimal picker — only three faces, each card self-demos in its own font.
// Other FontId slots remain valid for storage/back-compat but aren't offered.
const FONTS: { id: FontId; sampleStyle: React.CSSProperties }[] = [
  { id: 'default',  sampleStyle: { fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", system-ui, sans-serif' } },
  { id: 'terminal', sampleStyle: { fontFamily: '"JetBrains Mono", ui-monospace, monospace' } },
  { id: 'firacode', sampleStyle: { fontFamily: '"Fira Code", ui-monospace, monospace', fontFeatureSettings: '"liga" 1, "calt" 1' } },
];

const APPEARANCES: { id: AppearanceMode; label: string; icon: string }[] = [
  { id: 'light',  label: '浅色',     icon: '☀' },
  { id: 'dark',   label: '深色',     icon: '☾' },
  { id: 'system', label: '跟随系统', icon: '⌣' },
];

// 侧栏透明度的三档预设（id 复用 GlassIntensity，越「通透」越透明）。
const GLASS_INTENSITIES: { id: GlassIntensity; label: string }[] = [
  { id: 'subtle',   label: '通透' },
  { id: 'standard', label: '标准' },
  { id: 'strong',   label: '厚实' },
];
// 简化后默认侧栏不开玻璃；输入框/菜单/抽屉/用户气泡的磨砂由 CSS 无条件常开。
export const GLASS_DEFAULT_ZONES: GlassZone[] = [];

// surface = swatch canvas (dark-first brands show their dark bg);
// ramp = [tint, base, deep] accent layers shown as chips
const THEMES: { id: ColorTheme; label: string; sub: string; surface: string; ramp: [string, string, string] }[] = [
  { id: 'anthropic', label: 'Anthropic', sub: '象牙陶土',   surface: '#faf9f5', ramp: ['#f5e5de', '#d97757', '#c15f3c'] },
  { id: 'cursor',    label: 'Cursor',    sub: '极夜石墨青', surface: '#0e0f12', ramp: ['#162e2b', '#7eede0', '#b4f0e7'] },
  { id: 'xcode',     label: 'Xcode',     sub: '石墨蓝',     surface: '#292a30', ramp: ['#1e3a5f', '#3c93fd', '#6fb0ff'] },
  { id: 'razer',     label: 'Razer',     sub: '暗夜霓绿',   surface: '#0a0a0a', ramp: ['#0e3300', '#35de12', '#5cff36'] },
];

// Flat, ordered section list (drives the single-page layout + scroll-spy).
const SETTINGS_SECTIONS = TAB_GROUPS.flatMap((g) => g.items.map((it) => ({ ...it, group: g.group })));

const SettingsModal: React.FC<Props> = ({ settings, updateSettings, onLogout, onClose }) => {
  const { t: tr } = useI18n();
  // `active` is the section the nav highlights — set on click AND by scroll-spy.
  const [active, setActive] = useState<Tab>('account');
  const paneRef = useRef<HTMLDivElement>(null);
  const secRefs = useRef<Partial<Record<Tab, HTMLElement | null>>>({});
  // Suppress scroll-spy briefly while a click-driven smooth scroll is animating,
  // so the highlight lands on the clicked item instead of flickering through.
  const lockRef = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Scroll-spy: highlight the last section whose top has crossed a trigger line
  // near the top of the scroll pane.
  useEffect(() => {
    const root = paneRef.current;
    if (!root) return;
    const onScroll = () => {
      if (Date.now() < lockRef.current) return;
      const rootTop = root.getBoundingClientRect().top;
      let current: Tab = SETTINGS_SECTIONS[0].id;
      for (const s of SETTINGS_SECTIONS) {
        const el = secRefs.current[s.id];
        if (!el) continue;
        if (el.getBoundingClientRect().top - rootTop <= 72) current = s.id;
      }
      setActive((prev) => (prev === current ? prev : current));
    };
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => root.removeEventListener('scroll', onScroll);
  }, []);

  const jump = (id: Tab) => {
    setActive(id);
    lockRef.current = Date.now() + 700;   // hold the highlight through the animation
    secRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const paneFor = (id: Tab): React.ReactNode => {
    switch (id) {
      case 'account':    return <AccountPane />;
      case 'appearance': return <AppearancePane settings={settings} updateSettings={updateSettings} />;
      case 'prefs':      return <PrefsPane settings={settings} updateSettings={updateSettings} />;
      case 'services':   return <ServicesPane settings={settings} updateSettings={updateSettings} />;
      case 'models':     return <ModelsPane settings={settings} updateSettings={updateSettings} />;
      case 'mcp':        return <McpPane />;
      case 'localagent': return <LocalAgentPane settings={settings} updateSettings={updateSettings} />;
    }
  };

  return (
    <div className="v2-modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="v2-modal v2-modal-settings" onMouseDown={(e) => e.stopPropagation()}>
        <div className="v2-modal-hd">
          <h3>{tr('settings.title')}</h3>
          <button className="x" onClick={onClose}>✕</button>
        </div>
        <div className="v2-settings-body">
          <nav className="v2-settings-nav">
            {TAB_GROUPS.map((g) => (
              <div key={g.group} className="v2-settings-nav-group">
                <div className="v2-settings-nav-head">
                  <span className="grp">{tr(g.group)}</span>
                </div>
                {g.items.map((t) => (
                  <button
                    key={t.id}
                    className={`v2-settings-nav-item${active === t.id ? ' active' : ''}`}
                    onClick={() => jump(t.id)}
                  >
                    <span className="ic" aria-hidden>{t.icon}</span>
                    <span className="lab">{tr(t.label)}</span>
                  </button>
                ))}
              </div>
            ))}
            <NavUserFoot onLogout={onLogout} />
          </nav>
          {/* Single scrollable page — every pane stacked; nav items are anchors. */}
          <div className="v2-settings-pane" ref={paneRef}>
            {SETTINGS_SECTIONS.map((s) => (
              <section
                key={s.id}
                id={`set-sec-${s.id}`}
                ref={(el) => { secRefs.current[s.id] = el; }}
                className="v2-settings-sec"
              >
                <div className="v2-settings-sec-hd">
                  <span className="ic" aria-hidden>{s.icon}</span>
                  <span className="t">{tr(s.label)}</span>
                </div>
                {paneFor(s.id)}
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

/* ============ helpers ============ */

const Section: React.FC<React.PropsWithChildren<{ title?: string; hint?: string; trailing?: React.ReactNode }>> = ({ title, hint, trailing, children }) => (
  <div className="v2-set-sec">
    {(title || hint || trailing) && (
      <div className={`v2-set-sec-hd${title ? '' : ' bare'}`}>
        <div>
          {title && <div className="t">{title}</div>}
          {hint && <div className="h">{hint}</div>}
        </div>
        {trailing && <div className="v2-set-sec-trail">{trailing}</div>}
      </div>
    )}
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

/** Avatar initials + display name from the current user — shared by the Account
 *  pane (full detail) and the nav footer (compact identity beside sign-out). */
function accountIdentity() {
  const u = api.getUser();
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
  return { u, displayName, initials, plan: u?.tenant?.plan || 'free' };
}

const AccountPane: React.FC = () => {
  const { t: tr } = useI18n();
  const { u, displayName, initials, plan } = accountIdentity();

  return (
    <div className="v2-acc">
      {/* Identity card — avatar + name with email/plan/tenant inline as
          icon+text meta. Sign-out now lives at the bottom of the left nav. */}
      <div className="v2-acc-id">
        <div className="v2-acc-av">{initials}</div>
        <div className="v2-acc-id-r">
          <div className="v2-acc-nm">{displayName}</div>
          <div className="v2-acc-meta">
            <span className="v2-acc-meta-i" title={tr('settings.account.email')}><AccIconMail />{u?.email || '—'}</span>
            <span className="v2-acc-meta-pill" title={tr('settings.account.plan')}>{String(plan).toUpperCase()}</span>
            {u?.tenant?.name && (
              <span className="v2-acc-meta-i" title={tr('settings.account.tenant')}><AccIconBuilding />{u.tenant.name}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

/** Pinned to the bottom of the settings left nav: current user (avatar + name,
 *  left-aligned) with a sign-out button. Keeps the account identity always in
 *  view and gives sign-out a stable home away from the scrolling panes. */
const NavUserFoot: React.FC<{ onLogout: () => void }> = ({ onLogout }) => {
  const { t: tr } = useI18n();
  const { displayName, initials } = accountIdentity();
  return (
    <div className="v2-settings-nav-foot">
      <div className="v2-settings-nav-user" title={displayName}>
        <span className="av">{initials}</span>
        <span className="nm">{displayName}</span>
      </div>
      <button
        className="v2-settings-nav-signout"
        title={tr('settings.account.logout')}
        aria-label={tr('settings.account.logout')}
        onClick={() => { if (window.confirm(tr('settings.account.logoutConfirm'))) onLogout(); }}
      >
        <AccIconPower />
      </button>
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
  // 简化后只剩「侧栏」一个可调项：开关 + 透明度。其余区域（输入框/菜单/抽屉/用户气泡）
  // 默认常开磨砂、弹框/顶栏/主界面一律不加玻璃，均由 CSS 固定，无需用户操心。
  const { t: tr } = useI18n();
  const sidebarOn = (settings.glassZones ?? GLASS_DEFAULT_ZONES).includes('sidebar');
  return (
    <>
      <Row label={tr('settings.glass.sidebar')} sub={tr('settings.glass.sidebarSub')}>
        <Switch checked={sidebarOn} onChange={(v) => updateSettings({ glassZones: v ? ['sidebar'] : [] })} />
      </Row>
      <Row label={tr('settings.glass.opacity')} sub={tr('settings.glass.opacitySub')}>
        <div className="v2-seg">
          {GLASS_INTENSITIES.map((i) => (
            <button
              key={i.id}
              className={`v2-seg-item${(settings.glassIntensity ?? 'standard') === i.id ? ' active' : ''}`}
              onClick={() => updateSettings({ glassIntensity: i.id })}
              disabled={!sidebarOn}
            >
              {tr(`settings.glass.intensity.${i.id}`)}
            </button>
          ))}
        </div>
      </Row>
    </>
  );
};

/** 外观面板：明暗 · 主题 · 毛玻璃 · 字体 — 从 偏好 抽出独立的左导航 tab。
 *  独立后用户更容易找到也更容易做"换皮"动作；旧的 偏好 现在专注对话行为
 *  与出字速度。注意：所有 setting key 都不变，对外行为 / 持久化无影响。 */
const AppearancePane: React.FC<{ settings: ClientSettings; updateSettings: (p: Partial<ClientSettings>) => void }> = ({ settings, updateSettings }) => {
  const { t: tr, lang, setLang } = useI18n();
  return (
  <>
    {/* 三个"换皮"项压成一组贴齐的 label · 控件行 —— 标题在左、控件在右，
        不再用"小节标题 + 远处灰副标题 + 更远的控件"那种三段拉空的排版。 */}
    <Section>
      <Row label={tr('settings.language')}>
        <div className="v2-seg">
          {LANGS.map((l) => (
            <button
              key={l.key}
              className={`v2-seg-item${lang === l.key ? ' active' : ''}`}
              onClick={() => setLang(l.key as Lang)}
            >
              {l.native}
            </button>
          ))}
        </div>
      </Row>
      <Row label={tr('settings.appearance.title')}>
        <div className="v2-seg">
          {APPEARANCES.map((a) => (
            <button
              key={a.id}
              className={`v2-seg-item${(settings.appearance ?? 'system') === a.id ? ' active' : ''}`}
              onClick={() => updateSettings({ appearance: a.id })}
            >
              <span className="ic">{a.icon}</span>{tr(`settings.appearance.${a.id}`)}
            </button>
          ))}
        </div>
      </Row>
      <Row label={tr('settings.theme.title')}>
        <div className="v2-theme-row">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={`v2-theme-chip${(settings.theme ?? 'anthropic') === t.id ? ' active' : ''}`}
              onClick={() => updateSettings({ theme: t.id })}
              title={`${t.label} · ${tr(`settings.theme.sub.${t.id}`)}`}
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
    <Section title={tr('settings.glass.title')} hint={tr('settings.glass.hint')}>
      <GlassControl settings={settings} updateSettings={updateSettings} />
    </Section>
    <Section title={tr('settings.font.title')} hint={tr('settings.font.hint')}>
      <div className="v2-set-grid">
        {FONTS.map((f) => (
          <button
            key={f.id}
            className={`v2-set-card${settings.font === f.id ? ' active' : ''}`}
            onClick={() => updateSettings({ font: f.id })}
          >
            <span className="t" style={f.sampleStyle}>{tr(`settings.font.${f.id}`)}</span>
          </button>
        ))}
      </div>
    </Section>
  </>
  );
};

const PrefsPane: React.FC<{ settings: ClientSettings; updateSettings: (p: Partial<ClientSettings>) => void }> = ({ settings, updateSettings }) => {
  const { t: tr } = useI18n();
  return (
  <>
    <Section title={tr('settings.prefs.chat')}>
      <Row label={tr('settings.prefs.enterToSend')} sub={tr('settings.prefs.enterToSendSub')}>
        <Switch checked={settings.cmdEnterToSend ?? true} onChange={(v) => updateSettings({ cmdEnterToSend: v })} />
      </Row>
      <Row label={tr('settings.prefs.toolCalling')} sub={tr('settings.prefs.toolCallingSub')}>
        <Switch checked={settings.enableToolCalling} onChange={(v) => updateSettings({ enableToolCalling: v })} />
      </Row>
      <Row label={tr('settings.prefs.tokenCost')} sub={tr('settings.prefs.tokenCostSub')}>
        <Switch checked={!!settings.showTokenCost} onChange={(v) => updateSettings({ showTokenCost: v })} />
      </Row>
      <Row label={tr('settings.prefs.autoTTS')} sub={tr('settings.prefs.autoTTSSub')}>
        <Switch checked={!!settings.autoTTS} onChange={(v) => updateSettings({ autoTTS: v })} />
      </Row>
    </Section>
    <Section title={tr('settings.prefs.typeSpeed')} hint={tr('settings.prefs.typeSpeedHint')}>
      <Row label={tr('settings.prefs.steadyType')} sub={tr('settings.prefs.steadyTypeSub')}>
        <Switch checked={settings.chatStreamSmooth ?? true} onChange={(v) => updateSettings({ chatStreamSmooth: v })} />
      </Row>
      {(settings.chatStreamSmooth ?? true) && (
        <Row label={tr('settings.prefs.speed')} sub={tr('settings.prefs.speedSub')}>
          <SpeedSeg value={settings.chatStreamSpeed ?? 'normal'} onChange={(sp) => updateSettings({ chatStreamSpeed: sp })} />
        </Row>
      )}
    </Section>
  </>
  );
};

/** 三档速度的分段控件（慢 / 适中 / 快）。 */
const SpeedSeg: React.FC<{ value: TypeSpeed; onChange: (v: TypeSpeed) => void }> = ({ value, onChange }) => {
  const { t: tr } = useI18n();
  return (
  <div className="v2-seg">
    {(['slow', 'normal', 'fast'] as TypeSpeed[]).map((sp) => (
      <button
        key={sp}
        className={`v2-seg-item${value === sp ? ' active' : ''}`}
        onClick={() => onChange(sp)}
      >
        {tr(`settings.prefs.speed.${sp}`)}
      </button>
    ))}
  </div>
  );
};

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
  const { t: tr } = useI18n();
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
      setMasked(r?.api_key || null); setInput(''); setMsg(tr('settings.localagent.cursorSaved'));
    } catch (e: any) { setMsg(e?.message || tr('settings.localagent.saveFailed')); }
    finally { setSaving(false); }
  };

  return (
    <Row label={tr('settings.localagent.cursorKey')} sub={masked ? tr('settings.localagent.cursorKeySubSaved', { masked }) : tr('settings.localagent.cursorKeySub')}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          type="password"
          className="v2-set-select"
          style={{ minWidth: 240 }}
          placeholder={masked ? tr('settings.localagent.cursorKeyOverride') : 'crsr_…'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void onSave(); }}
        />
        <button className="v2-set-btn primary" disabled={saving || !input.trim()} onClick={() => void onSave()}>{saving ? tr('settings.localagent.saving') : tr('common.save')}</button>
        {msg && <span className="v2-pill ok">{msg}</span>}
      </div>
    </Row>
  );
};

const LocalAgentPane: React.FC<{ settings: ClientSettings; updateSettings: (p: Partial<ClientSettings>) => void }> = ({ settings, updateSettings }) => {
  const { t: tr } = useI18n();
  const cur = settings.localAgentProvider ?? 'claude';
  return (
    <>
      <Section hint={tr('settings.localagent.hint')}>
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
      <Section title={tr('settings.localagent.permTitle')} hint={tr('settings.localagent.permHint')}>
        <Row label={tr('settings.localagent.permLabel')} sub={tr('settings.localagent.permSub')}>
          <div className="v2-set-val">{tr('settings.localagent.permVal')}</div>
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
  const { t: tr } = useI18n();
  return (
    <div className={`v2-la-prov${isDefault ? ' is-default' : ''}${!p.live ? ' is-soon' : ''}`}>
      <div className="v2-la-prov-hd"
        role={p.live ? 'button' : undefined}
        tabIndex={p.live ? 0 : -1}
        onClick={p.live ? onSetDefault : undefined}
        onKeyDown={p.live ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSetDefault(); } } : undefined}
        title={p.live ? tr('settings.localagent.clickSetDefault') : tr('settings.localagent.comingSoon')}
      >
        <span className={`v2-la-setdot prov-${p.id}`} />
        <div className="v2-la-prov-meta">
          <div className="nm">{p.label}{isDefault && <span className="v2-la-prov-def">{tr('settings.localagent.default')}</span>}</div>
          <div className="sub">{p.vendor} · <code>{p.cli}</code></div>
        </div>
        <span className={`v2-pill ${p.live ? 'ok' : 'mute'}`}>{p.live ? tr('settings.localagent.ready') : 'soon'}</span>
      </div>
      <div className="v2-la-prov-body">
        {p.id === 'claude' && (
          <Row label="CLI" sub={tr('settings.localagent.claudeSub')}>
            <a className="v2-set-btn" href={p.installUrl} target="_blank" rel="noreferrer">{tr('settings.localagent.installGuide')}</a>
          </Row>
        )}
        {p.id === 'cursor' && <CursorKeyRow />}
        {p.id === 'codex' && (
          <Row label={tr('settings.localagent.status')} sub={tr('settings.localagent.codexSub')}>
            <a className="v2-set-btn" href={p.installUrl} target="_blank" rel="noreferrer">{tr('settings.localagent.learnMore')}</a>
          </Row>
        )}
        {p.id === 'gemini' && (
          <Row label={tr('settings.localagent.status')} sub={tr('settings.localagent.geminiSub')}>
            <a className="v2-set-btn" href={p.installUrl} target="_blank" rel="noreferrer">{tr('settings.localagent.learnMore')}</a>
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
  const { t: tr } = useI18n();
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
      setChayaProbe(r.ok ? { ok: true, text: tr('settings.services.probeOk', { status: r.status }) } : { ok: false, text: tr('settings.services.probeResp', { status: r.status }) });
    } catch (e: any) {
      setChayaProbe({ ok: false, text: e?.name === 'AbortError' ? tr('settings.services.probeTimeout') : tr('settings.services.probeUnreachable') });
    } finally { setChayaProbing(false); }
  };
  const onSaveChaya = () => {
    if (trimmedChaya) localStorage.setItem('chatee_backend_url', trimmedChaya);
    else localStorage.removeItem('chatee_backend_url');
    (window as any).__cachedBackendUrl = trimmedChaya;
    if (window.confirm(tr('settings.services.savedRefresh'))) window.location.reload();
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
      setSnProbe(r.ok ? { ok: true, text: tr('settings.services.connected') } : { ok: false, text: r.error || tr('settings.services.failed') });
    } catch (e: any) {
      setSnProbe({ ok: false, text: e?.message || tr('settings.services.failed') });
    } finally { setSnProbing(false); }
  };

  return (
    <div className="v2-acc">
      {/* ── Chaya 服务器 ── */}
      <div className="v2-acc-block">
        <div className="v2-acc-block-hd"><AccIconServer /><span>{tr('settings.services.chayaServer')}</span></div>
        <div className="v2-acc-endpoint">
          <input
            className="v2-set-select v2-acc-input"
            value={chayaUrl}
            onChange={(e) => { setChayaUrl(e.target.value); setChayaProbe(null); }}
            placeholder="http://localhost:3002"
            aria-label={tr('settings.services.chayaUrlLabel')}
          />
          <button
            className="v2-set-btn v2-acc-btn"
            onClick={() => void onProbeChaya()}
            disabled={chayaProbing}
            title={tr('settings.services.probeTitle')}
          >
            <AccIconRadar /><span>{chayaProbing ? tr('settings.services.probing') : tr('settings.services.probe')}</span>
          </button>
          <button
            className="v2-set-btn primary v2-acc-btn"
            onClick={onSaveChaya}
            disabled={!chayaDirty}
            title={tr('settings.services.saveRefreshTitle')}
          >
            <AccIconSave /><span>{tr('common.save')}</span>
          </button>
        </div>
        <div className="v2-acc-endpoint-meta">
          {chayaProbe && (
            <span className={`v2-pill ${chayaProbe.ok ? 'ok' : 'mute'}`} style={!chayaProbe.ok ? { background: '#fff7ed', color: '#c2410c' } : undefined}>
              {chayaProbe.text}
            </span>
          )}
          <span className="v2-acc-endpoint-current" title={effectiveChaya}>{tr('settings.services.current')} · {effectiveChaya}</span>
        </div>
      </div>

      {/* ── Smartnote 云知识 ── */}
      <div className="v2-acc-block">
        <div className="v2-acc-block-hd"><AccIconCloud /><span>{tr('settings.services.smartnote')}</span></div>
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
            title={tr('settings.services.probeTitle')}
          >
            <AccIconRadar /><span>{snProbing ? tr('settings.services.probing') : tr('settings.services.probe')}</span>
          </button>
          <button
            className="v2-set-btn primary v2-acc-btn"
            onClick={onSaveSn}
            disabled={!snKey.trim()}
            title={tr('settings.services.saveCredTitle')}
          >
            <AccIconSave /><span>{tr('common.save')}</span>
          </button>
        </div>
        <div className="v2-acc-endpoint">
          <input
            className="v2-set-select v2-acc-input"
            value={snBase}
            onChange={(e) => { setSnBase(e.target.value); setSnProbe(null); }}
            placeholder={tr('settings.services.baseUrlPlaceholder')}
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
              <span className="v2-acc-rag-lab">{tr('settings.services.ragRetrieval')}</span>
              <Switch checked={!!settings.ragEnabled} onChange={(v) => updateSettings({ ragEnabled: v })} />
              <span className="v2-acc-rag-sub">{tr('settings.services.ragRetrievalSub')}</span>
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
                  <span className="v2-acc-rag-sub">{tr('settings.services.ragTopKSub')}</span>
                </div>
                <div className="v2-acc-rag-row">
                  <span className="v2-acc-rag-lab">{tr('settings.services.ragScope')}</span>
                  <select
                    className="v2-set-select v2-acc-rag-sel"
                    value={settings.ragScope ?? 'auto'}
                    onChange={(e) => updateSettings({ ragScope: e.target.value as ClientSettings['ragScope'] })}
                  >
                    <option value="auto">auto</option>
                    <option value="agent">agent</option>
                    <option value="workspace">workspace</option>
                  </select>
                  <span className="v2-acc-rag-sub">{tr('settings.services.ragScopeSub')}</span>
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
  const { t: tr } = useI18n();
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
    catch (e: any) { window.alert(e?.message || tr('settings.models.failed')); }
  };
  const onDeleteModel = async (c: LLMConfigFromDB) => {
    try { await deleteLLMConfig(c.config_id); if (defaultId === c.config_id) setDefault(undefined); refresh(); }
    catch (e: any) { window.alert(e?.message || tr('settings.models.failed')); }
  };
  const onDeleteCred = async (provider: string, configs: LLMConfigFromDB[]) => {
    if (!window.confirm(tr('settings.models.removeCredConfirm', { provider: PROVIDER_LABELS[provider] || provider, count: configs.length }))) return;
    try {
      await Promise.all(configs.map((c) => deleteLLMConfig(c.config_id)));
      if (configs.some((c) => c.config_id === defaultId)) setDefault(undefined);
      refresh();
    } catch (e: any) { window.alert(e?.message || tr('settings.models.failed')); }
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
        hint={tr('settings.models.hint')}
        trailing={<button className="v2-set-btn primary" onClick={onAddCred}>＋ {tr('settings.models.connect')}</button>}
      >
        {!list && <div className="v2-set-empty">{tr('settings.models.loading')}</div>}
        {list && list.length === 0 && <div className="v2-set-empty">{tr('settings.models.empty')}</div>}
        {groups && groups.length > 0 && (
          <div className="v2-cred-count">{tr('settings.models.count', { providers: groups.length, enabled: enabledCount })}</div>
        )}
        {groups && groups.map((g) => (
          <div key={g.provider} className="v2-cred">
            <div className="v2-cred-hd">
              <span className="av" data-p={g.provider}>{(PROVIDER_LABELS[g.provider] || g.provider).charAt(0)}</span>
              <div className="meta">
                <div className="nm">{PROVIDER_LABELS[g.provider] || g.provider}</div>
                <div className="sub">
                  <span className="v2-pill ok">{tr('settings.models.connected')}</span>
                  <span className="cnt">{tr('settings.models.modelCount', { count: g.configs.length })}</span>
                  {g.configs[0]?.api_url && <span className="v2-pill mute" title={g.configs[0].api_url}>{tr('settings.models.customUrl')}</span>}
                </div>
              </div>
              <div className="acts">
                <button className="v2-set-btn" onClick={() => void onManage(g.provider, g.configs)}>{tr('settings.models.manage')}</button>
                <button className="v2-set-danger" onClick={() => void onDeleteCred(g.provider, g.configs)}>{tr('settings.models.remove')}</button>
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
                      title={isDefault ? tr('settings.models.starDefault') : isEnabled ? tr('settings.models.starSetDefault') : tr('settings.models.starDisabled')}
                      disabled={!isEnabled && !isDefault}
                      onClick={() => setDefault(isDefault ? undefined : c.config_id)}
                    >{isDefault ? '★' : '☆'}</button>
                    <code className="mid" title={c.model}>{c.model || '—'}</code>
                    <div className="grow" />
                    <label className="tg" title={tr('settings.models.mediaTitle')}>
                      <span>{tr('settings.models.media')}</span>
                      <Switch checked={!!c.media_visible} onChange={() => void onToggle(c, 'media_visible')} />
                    </label>
                    <label className="tg" title={tr('settings.models.enabledTitle')}>
                      <span>{tr('settings.models.enabled')}</span>
                      <Switch checked={isEnabled} onChange={() => void onToggle(c, 'enabled')} />
                    </label>
                    <button className="del" title={tr('settings.models.deleteModel')} onClick={() => void onDeleteModel(c)}>✕</button>
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
  const { t: tr } = useI18n();
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
    if (!key.trim()) { setErr(tr('settings.models.needKey')); return; }
    setErr(''); setFetching(true);
    try {
      const ms = await listAvailableModels(prov, key.trim(), url.trim() || undefined);
      // 已启用的模型即便没在返回里也并进来，避免「拉取后旧模型消失」。
      const ids = new Set(ms.map((m) => m.id));
      const merged = [...ms, ...draft.existing.filter((c) => !!c.model && !ids.has(c.model)).map((c) => ({ id: c.model as string, name: c.model as string }))];
      setModels(merged);
    } catch (e: any) { setErr(e?.message || tr('settings.models.fetchFailed')); setModels([]); }
    finally { setFetching(false); }
  };

  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const save = async () => {
    if (sel.size === 0) { setErr(tr('settings.models.pickOne')); return; }
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
    } catch (e: any) { setErr(e?.message || tr('settings.models.saveFailed')); }
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
          <h3>{editMode ? `${PROVIDER_LABELS[provider] || provider} · ${tr('settings.models.credAndModels')}` : tr('settings.models.connectProvider')}</h3>
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
            <div className="lab">API Key {editMode && <span style={{ color: 'var(--c-ink-4)' }}>({tr('settings.models.keepBlank')})</span>}</div>
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" />
          </div>
          <div className="v2-modal-sec">
            <div className="lab">Base URL <span style={{ color: 'var(--c-ink-4)' }}>({tr('settings.models.baseUrlOptional')})</span></div>
            <input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder="https://api.openai.com/v1" />
          </div>
          <div className="v2-modal-sec">
            <div className="lab" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>{tr('settings.models.availableModels')} {sel.size > 0 && <span style={{ color: 'var(--c-ink-4)' }}>· {tr('settings.models.selected', { count: sel.size })}</span>}</span>
              <button className="v2-set-btn" style={{ marginLeft: 'auto' }} onClick={() => void fetchModels()} disabled={fetching}>
                {fetching ? tr('settings.models.fetching') : models ? tr('settings.models.refetch') : tr('settings.models.fetch')}
              </button>
            </div>
            {!models && !fetching && <div className="v2-set-empty" style={{ margin: 0 }}>{tr('settings.models.fetchHint', { provider: PROVIDER_LABELS[provider] || provider })}</div>}
            {models && models.length === 0 && !fetching && <div className="v2-set-empty" style={{ margin: 0 }}>{tr('settings.models.noModels')}</div>}
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
          <button className="v2-mbtn" onClick={onClose} disabled={busy}>{tr('common.cancel')}</button>
          <button className="v2-mbtn primary" onClick={() => void save()} disabled={busy}>{busy ? tr('settings.models.saving') : tr('common.save')}</button>
        </div>
      </div>
    </div>
  );
};

/* ============ MCP pane (v2 native) ============ */

const McpPane: React.FC = () => {
  const { t: tr } = useI18n();
  const [list, setList] = useState<MCPServer[] | null>(null);
  const refresh = () => mcpApi.list().then((l) => setList(Array.isArray(l) ? l : [])).catch(() => setList([]));
  useEffect(() => { refresh(); }, []);
  const [editing, setEditing] = useState<null | { id?: string; name: string; url: string; type: 'http' | 'sse' | 'stdio'; enabled: boolean }>(null);

  const onProbe = async (m: MCPServer) => {
    try {
      const res = await mcpApi.probe(m.id);
      window.alert(res.ok
        ? tr('settings.mcp.probeOk', { count: res.tool_count }) + (res.tools ? `\n${res.tools.slice(0, 12).join(', ')}` : '')
        : tr('settings.mcp.probeFail', { error: res.error || tr('settings.mcp.unknown') }));
      refresh();
    } catch (e: any) { window.alert(e?.message || tr('settings.mcp.probeFailed')); }
  };
  const onToggle = async (m: MCPServer) => {
    try { await mcpApi.update(m.id, { enabled: !m.enabled }); refresh(); }
    catch (e: any) { window.alert(e?.message || tr('settings.mcp.failed')); }
  };
  const onDelete = async (m: MCPServer) => {
    if (!window.confirm(tr('settings.mcp.deleteConfirm', { name: m.name }))) return;
    try { await mcpApi.remove(m.id); refresh(); } catch (e: any) { window.alert(e?.message || tr('settings.mcp.failed')); }
  };
  const onEdit = (m: MCPServer) => setEditing({
    id: m.id, name: m.name, url: m.url, type: (m.type as any) || 'http', enabled: !!m.enabled,
  });
  const onAdd = () => setEditing({ name: '', url: '', type: 'http', enabled: true });

  return (
    <>
      <Section
        hint={tr('settings.mcp.hint')}
        trailing={<button className="v2-set-btn primary" onClick={onAdd}>＋ {tr('settings.mcp.add')}</button>}
      >
        {!list && <div className="v2-set-empty">{tr('settings.mcp.loading')}</div>}
        {list && list.length === 0 && <div className="v2-set-empty">{tr('settings.mcp.empty')}</div>}
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
  const { t: tr } = useI18n();
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
        window.alert(tr('settings.mcp.noOauth'));
        setAuthBusy(null);
        return;
      }
      const auth = await oauthApi.authorize({ ...meta, mcp_url: m.url });
      if (!auth?.authorization_url) {
        window.alert(tr('settings.mcp.noAuthUrl'));
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
        window.alert(tr('settings.mcp.popupBlocked'));
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
          window.alert(tr('settings.mcp.authTimeout'));
          return;
        }
        setTimeout(() => void tick(), POLL_MS);
      };
      void tick();
    } catch (e: any) {
      window.alert(e?.message || tr('settings.mcp.authFailed'));
      setAuthBusy(null);
    }
  };

  const authPill = () => {
    if (!oauthEligible) return null;
    if (authBusy === 'polling') return <span className="v2-pill warn">{tr('settings.mcp.awaitingCallback')}</span>;
    if (hasToken === true) return <span className="v2-pill ok">{tr('settings.mcp.authorized')}</span>;
    if (expired) return <span className="v2-pill warn">{tr('settings.mcp.expired')}</span>;
    if (hasToken === false) return <span className="v2-pill mute">{tr('settings.mcp.unauthorized')}</span>;
    return null;
  };

  const authLabel =
    authBusy === 'discover' ? tr('settings.mcp.discovering')
    : authBusy === 'redirect' ? tr('settings.mcp.redirecting')
    : authBusy === 'polling' ? tr('settings.mcp.callback')
    : (hasToken || expired ? tr('settings.mcp.reauthorize') : tr('settings.mcp.authorize'));

  return (
    <div className="v2-set-card-row">
      <div className="l">
        <div className="t">{m.name} <small>{m.type}</small></div>
        <div className="s">
          {m.enabled ? <span className="v2-pill ok">{tr('settings.mcp.enabled')}</span> : <span className="v2-pill mute">{tr('settings.mcp.disabled')}</span>}
          {m.healthy ? <span className="v2-pill ok">{tr('settings.mcp.online')}</span> : <span className="v2-pill mute">{tr('settings.mcp.unprobed')}</span>}
          {authPill()}
          <span className="v2-pill mute" title={m.url}>{m.url.length > 40 ? m.url.slice(0, 38) + '…' : m.url}</span>
        </div>
      </div>
      <div className="r">
        <button className="v2-set-btn" onClick={() => void onProbe(m)}>{tr('settings.mcp.probe')}</button>
        {oauthEligible && (
          <button className="v2-set-btn" onClick={() => void authorize()} disabled={!!authBusy || !m.enabled}>
            {authLabel}
          </button>
        )}
        <button className="v2-set-btn" onClick={() => void onToggle(m)}>{m.enabled ? tr('settings.mcp.disable') : tr('settings.mcp.enable')}</button>
        <button className="v2-set-btn" onClick={() => onEdit(m)}>{tr('settings.mcp.edit')}</button>
        <button className="v2-set-danger" onClick={() => void onDelete(m)}>{tr('common.delete')}</button>
      </div>
    </div>
  );
};

const McpEditModal: React.FC<{
  draft: { id?: string; name: string; url: string; type: 'http' | 'sse' | 'stdio'; enabled: boolean };
  onClose: () => void;
  onSaved: () => void;
}> = ({ draft, onClose, onSaved }) => {
  const { t: tr } = useI18n();
  const [d, setD] = useState(draft);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const save = async () => {
    if (!d.name.trim() || !d.url.trim()) { window.alert(tr('settings.mcp.nameUrlRequired')); return; }
    setBusy(true);
    try {
      if (d.id) {
        await mcpApi.update(d.id, { name: d.name.trim(), url: d.url.trim(), type: d.type, enabled: d.enabled });
      } else {
        await mcpApi.create({ name: d.name.trim(), url: d.url.trim(), type: d.type, enabled: d.enabled });
      }
      onSaved();
    } catch (e: any) { window.alert(e?.message || tr('settings.mcp.saveFailed')); }
    finally { setBusy(false); }
  };
  return (
    <div className="v2-modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} style={{ zIndex: 110 }}>
      <div className="v2-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="v2-modal-hd">
          <h3>{d.id ? tr('settings.mcp.editMcp') : tr('settings.mcp.addMcp')}</h3>
          <button className="x" onClick={onClose}>✕</button>
        </div>
        <div className="v2-modal-body">
          <div className="v2-modal-sec">
            <div className="lab">{tr('settings.mcp.name')}</div>
            <input autoFocus value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder={tr('settings.mcp.namePlaceholder')} />
          </div>
          <div className="v2-modal-sec">
            <div className="lab">{tr('settings.mcp.urlCommand')}</div>
            <input value={d.url} onChange={(e) => setD({ ...d, url: e.target.value })} placeholder={tr('settings.mcp.urlPlaceholder')} />
          </div>
          <div className="v2-modal-sec">
            <div className="lab">{tr('settings.mcp.transport')}</div>
            <select className="v2-set-select" style={{ width: '100%' }} value={d.type} onChange={(e) => setD({ ...d, type: e.target.value as any })}>
              <option value="http">http</option>
              <option value="sse">sse</option>
              <option value="stdio">stdio</option>
            </select>
          </div>
          <div className="v2-modal-sec">
            <div className="v2-set-row" style={{ padding: 0 }}>
              <div className="v2-set-row-l"><div className="lab">{tr('settings.mcp.enable')}</div></div>
              <Switch checked={d.enabled} onChange={(v) => setD({ ...d, enabled: v })} />
            </div>
          </div>
        </div>
        <div className="v2-modal-foot">
          <button className="v2-mbtn" onClick={onClose} disabled={busy}>{tr('common.cancel')}</button>
          <button className="v2-mbtn primary" onClick={() => void save()} disabled={busy}>{busy ? tr('settings.models.saving') : tr('common.save')}</button>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;
