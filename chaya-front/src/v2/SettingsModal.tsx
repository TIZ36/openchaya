import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../utils/apiClient';
import {
  getLLMConfigs, createLLMConfig, updateLLMConfig, deleteLLMConfig,
  getLLMConfigApiKey, listAvailableModels, getSupportedProviders,
  type LLMConfigFromDB, type SupportedProvider,
} from '../services/llmApi';
import { mcpApi, oauthApi, type MCPServer, type McpDetectResult } from '../services/integrationsApi';
import {
  getSmartnoteApiKey, setSmartnoteApiKey,
  getSmartnoteBaseUrl, setSmartnoteBaseUrl,
  smartnoteProbe,
} from '../services/smartnoteApi';
import type { ClientSettings, ColorTheme, GlassZone } from '../components/SettingsPage';
import type { FontId } from '../components/SettingsPage';
import { type TypeSpeed } from './typewriter';
import { getBackendUrl } from '../utils/backendUrl';
import {
  isLocalAgentAvailable, localAgent, addProject as addLocalProject, addCodexImportedSessions,
  basename, type CodexSessionSummary,
} from './services/localAgent';
import { loadSkills, upsertSkill, deleteSkill, normalizeSkillName, syncCliSkills, SKILLS_CHANGED_EVENT, type LocalSkill } from './services/skills';
import {
  IconUser, IconGear, IconModel, IconPlug, IconCloud, IconTerminal, IconAppearance, IconSkill,
} from './icons';
import { useI18n, LANGS, type Lang } from '../i18n';

interface Props {
  settings: ClientSettings;
  updateSettings: (p: Partial<ClientSettings>) => void;
  onLogout: () => void;
  onClose: () => void;
  initialSection?: Tab;   // 打开时滚到指定分组（如从输入框「管理技能」直达 skills）
}

type Tab = 'account' | 'appearance' | 'prefs' | 'services' | 'models' | 'mcp' | 'skills' | 'localagent';

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
      { id: 'skills',  label: 'settings.tab.skills', icon: <IconSkill /> },
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

// 侧栏玻璃开关已移除(Pure 走窗口 vibrancy 常态)；保留默认 zones 供 ClientShell 引用。
export const GLASS_DEFAULT_ZONES: GlassZone[] = [];

// 独立 light/dark 切换已下线：明暗随主题绑定（anthropic=浅色 · Pure/Razer=深色）。
// surface = swatch canvas（直接预览该主题的真实明暗）；ramp = [tint, base, deep] accent。
const THEMES: { id: ColorTheme; label: string; sub: string; mode: 'light' | 'dark'; surface: string; ramp: [string, string, string] }[] = [
  { id: 'anthropic', label: 'Anthropic', sub: '象牙陶土', mode: 'light', surface: '#faf9f5', ramp: ['#f5e5de', '#d97757', '#c15f3c'] },
  { id: 'codex',     label: 'Pure',      sub: '纯净',     mode: 'dark',  surface: '#26272d', ramp: ['#33343c', '#8a8d98', '#3a3b44'] },
  { id: 'razer',     label: 'Razer',     sub: '暗夜霓绿', mode: 'dark',  surface: '#0a0a0a', ramp: ['#0e3300', '#35de12', '#5cff36'] },
];

// Flat, ordered section list (drives the single-page layout + scroll-spy).
const SETTINGS_SECTIONS = TAB_GROUPS.flatMap((g) => g.items.map((it) => ({ ...it, group: g.group })));

const SettingsModal: React.FC<Props> = ({ settings, updateSettings, onLogout, onClose, initialSection }) => {
  const { t: tr } = useI18n();
  // `active` is the section the nav highlights — set on click AND by scroll-spy.
  const [active, setActive] = useState<Tab>(initialSection || 'account');
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

  // 带 initialSection 打开 → 直接滚到该分组（如输入框「管理技能」直达）。
  useEffect(() => {
    if (!initialSection) return;
    lockRef.current = Date.now() + 700;
    requestAnimationFrame(() => secRefs.current[initialSection]?.scrollIntoView({ block: 'start' }));
  }, [initialSection]);

  const paneFor = (id: Tab): React.ReactNode => {
    switch (id) {
      case 'account':    return <AccountPane />;
      case 'appearance': return <AppearancePane settings={settings} updateSettings={updateSettings} />;
      case 'prefs':      return <PrefsPane settings={settings} updateSettings={updateSettings} />;
      case 'services':   return <ServicesPane settings={settings} updateSettings={updateSettings} />;
      case 'models':     return <ModelsPane settings={settings} updateSettings={updateSettings} />;
      case 'mcp':        return <McpPane />;
      case 'skills':     return <SkillsPane />;
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

/** 外观面板：明暗 · 主题 · 字体 — 从 偏好 抽出独立的左导航 tab。
 *  侧栏玻璃开关已移除：Pure 常态走窗口 vibrancy(mac)，统一一种样式,无需用户调。
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
      <Row label={tr('settings.theme.title')}>
        <div className="v2-theme-row">
          {THEMES.map((t) => {
            // Pure(codex) 是我们自己的配色：支持明/暗/自动，chip 上的明暗标签跟着用户选择走。
            // 其它(Anthropic/Razer)是品牌联动主题，只有一种固定配色。
            const appr = settings.appearance ?? 'dark';
            const modeKey = t.id === 'codex' ? appr : t.mode;
            return (
              <button
                key={t.id}
                className={`v2-theme-chip${(settings.theme ?? 'codex') === t.id ? ' active' : ''}`}
                onClick={() => updateSettings({ theme: t.id })}
                title={`${t.label} · ${tr(`settings.theme.sub.${t.id}`)} · ${tr(`settings.appearance.${modeKey}`)}`}
              >
                <span className="sw" style={{ background: t.surface }}>
                  {t.ramp.map((c, i) => <i key={i} style={{ background: c }} />)}
                </span>
                <span className="nm">{t.label}</span>
                <span className="md">{tr(`settings.appearance.${modeKey}`)}</span>
              </button>
            );
          })}
        </div>
      </Row>
      {/* Pure 专属：明 / 暗 / 自动（自动 = 跟随 macOS 实时切换）。其它主题为固定配色，不显示。 */}
      {(settings.theme ?? 'codex') === 'codex' && (
        <Row label={tr('settings.appearance.title')} sub={tr('settings.appearance.systemHint') || undefined}>
          <div className="v2-seg">
            {(['light', 'dark', 'system'] as const).map((m) => (
              <button
                key={m}
                className={`v2-seg-item${(settings.appearance ?? 'dark') === m ? ' active' : ''}`}
                onClick={() => updateSettings({ appearance: m })}
              >
                {tr(`settings.appearance.${m}`)}
              </button>
            ))}
          </div>
        </Row>
      )}
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
  { id: 'codex',  label: 'Codex',        vendor: 'OpenAI',       cli: 'codex',        live: true,  installUrl: 'https://platform.openai.com/docs/codex' },
  { id: 'gemini', label: 'Gemini',       vendor: 'Google',       cli: 'gemini',       live: true,  installUrl: 'https://github.com/google-gemini/gemini-cli' },
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

const CodexImportRow: React.FC = () => {
  const { t: tr } = useI18n();
  const [sessions, setSessions] = useState<CodexSessionSummary[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeCwd, setActiveCwd] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [scanning, setScanning] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const scan = async () => {
    setScanning(true); setMsg(null);
    try {
      const rows = await localAgent.scanCodexSessions();
      setSessions(rows);
      setSelected(new Set());
      setActiveCwd(rows[0]?.cwd || null);
      setMsg(rows.length ? tr('settings.localagent.codexScanFound', { n: rows.length }) : tr('settings.localagent.codexScanEmpty'));
    } catch (e: any) {
      setMsg(e?.message || tr('settings.localagent.codexScanFailed'));
    } finally {
      setScanning(false);
    }
  };

  const toggle = (id: string) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const rows = sessions || [];
  const projectGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, { cwd: string; count: number; latest: number; title: string | null }>();
    for (const s of rows) {
      if (q) {
        const hay = `${s.cwd} ${s.title || ''} ${s.preview || ''}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      const prev = map.get(s.cwd);
      if (!prev) map.set(s.cwd, { cwd: s.cwd, count: 1, latest: s.updatedAt || 0, title: s.title || s.preview || null });
      else {
        prev.count += 1;
        if ((s.updatedAt || 0) > prev.latest) { prev.latest = s.updatedAt || 0; prev.title = s.title || s.preview || prev.title; }
      }
    }
    return [...map.values()].sort((a, b) => b.latest - a.latest);
  }, [rows, query]);

  const activeSessions = useMemo(() => rows.filter((s) => s.cwd === activeCwd), [rows, activeCwd]);
  const selectedInProject = activeSessions.filter((s) => selected.has(s.sessionId));

  useEffect(() => {
    if (!activeCwd || !projectGroups.some((p) => p.cwd === activeCwd)) setActiveCwd(projectGroups[0]?.cwd || null);
  }, [projectGroups, activeCwd]);

  const importRows = (picked: CodexSessionSummary[]) => {
    if (!picked.length) return;
    const byCwd = new Map<string, string[]>();
    for (const s of picked) {
      if (!s.cwd || !s.sessionId) continue;
      if (!byCwd.has(s.cwd)) byCwd.set(s.cwd, []);
      byCwd.get(s.cwd)!.push(s.sessionId);
    }
    for (const [cwd, ids] of byCwd) {
      addLocalProject(cwd);
      addCodexImportedSessions(cwd, ids);
    }
    setMsg(tr('settings.localagent.codexImported', { sessions: picked.length, projects: byCwd.size }));
  };

  return (
    <div className="v2-codex-import">
      <div className="v2-codex-import-head">
        <div className="v2-codex-import-copy">
          <div className="v2-codex-import-title">{tr('settings.localagent.codexImport')}</div>
          <div className="v2-codex-import-sub">{tr('settings.localagent.codexImportSub')}</div>
        </div>
        {msg && <span className="v2-pill ok">{msg}</span>}
      </div>
      <div className="v2-codex-import-toolbar">
        <button className="v2-set-btn" disabled={scanning} onClick={() => void scan()}>{scanning ? tr('settings.localagent.codexScanning') : tr('settings.localagent.codexScan')}</button>
        <input
          className="v2-set-select v2-codex-import-search"
          placeholder={tr('settings.localagent.codexSearch')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="v2-set-btn primary" disabled={!selected.size} onClick={() => importRows(rows.filter((s) => selected.has(s.sessionId)))}>{tr('settings.localagent.codexImportSelected', { n: selected.size })}</button>
      </div>
      {rows.length > 0 && (
        <div className="v2-codex-import-grid">
          <div className="v2-codex-projects">
            {projectGroups.map((p) => {
              const on = p.cwd === activeCwd;
              return (
                <button key={p.cwd} className={`v2-codex-project${on ? ' on' : ''}`} onClick={() => setActiveCwd(p.cwd)}>
                  <span className="v2-codex-project-name">{basename(p.cwd)}</span>
                  <span className="v2-codex-project-path">{p.count} · {p.cwd}</span>
                </button>
              );
            })}
            {!projectGroups.length && <div className="v2-codex-empty">{tr('settings.localagent.codexNoProject')}</div>}
          </div>
          <div className="v2-codex-sessions">
            <div className="v2-codex-sessions-head">
              <div className="v2-codex-active-project">
                <div className="v2-codex-active-name">{activeCwd ? basename(activeCwd) : tr('settings.localagent.codexPickProject')}</div>
                <div className="v2-codex-active-path">{activeCwd || ''}</div>
              </div>
              <div className="v2-codex-import-actions">
                <button className="v2-set-btn" disabled={!activeSessions.length} onClick={() => importRows(activeSessions)}>{tr('settings.localagent.codexImportProject', { n: activeSessions.length })}</button>
                <button className="v2-set-btn primary" disabled={!selectedInProject.length} onClick={() => importRows(selectedInProject)}>{tr('settings.localagent.codexImportSelected', { n: selectedInProject.length })}</button>
              </div>
            </div>
            <div className="v2-codex-session-list">
              {activeSessions.map((s) => {
                const on = selected.has(s.sessionId);
                const title = s.title || s.preview || tr('local.untitledSession');
                return (
                  <label key={s.sessionId} className="v2-codex-session">
                    <input type="checkbox" checked={on} onChange={() => toggle(s.sessionId)} />
                    <span className="v2-codex-session-copy">
                      <span className="v2-codex-session-title">{title}</span>
                      <span className="v2-codex-session-meta">{s.turns || 0} turns · {s.updatedAt ? new Date(s.updatedAt).toLocaleString() : s.sessionId}</span>
                    </span>
                  </label>
                );
              })}
              {!activeSessions.length && <div className="v2-codex-empty">{tr('settings.localagent.codexNoSessions')}</div>}
            </div>
          </div>
        </div>
      )}
    </div>
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
          <>
            <Row label={tr('settings.localagent.status')} sub={tr('settings.localagent.codexSub')}>
              <a className="v2-set-btn" href={p.installUrl} target="_blank" rel="noreferrer">{tr('settings.localagent.learnMore')}</a>
            </Row>
            <CodexImportRow />
          </>
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

/* Chaya 技能：provider 无关的 prompt 模板。/技能名 在 composer 发送前展开，对 5 个 CLI 都生效。 */
const SkillsPane: React.FC = () => {
  const { t: tr } = useI18n();
  const [list, setList] = useState<LocalSkill[]>(() => loadSkills());
  const [editing, setEditing] = useState<null | { id?: string; name: string; description: string; body: string }>(null);

  // 打开技能面板时顺手同步一次 CLI 安装的技能（unified skill hub），并跟随外部变化刷新列表。
  useEffect(() => {
    void syncCliSkills();
    const onChanged = () => setList(loadSkills());
    window.addEventListener(SKILLS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(SKILLS_CHANGED_EVENT, onChanged);
  }, []);

  const onAdd = () => setEditing({ name: '', description: '', body: '{{input}}' });
  const onEdit = (s: LocalSkill) => setEditing({ id: s.id, name: s.name, description: s.description, body: s.body });
  const onDelete = (s: LocalSkill) => {
    if (!window.confirm(tr('settings.skills.deleteConfirm', { name: s.name }))) return;
    setList(deleteSkill(s.id));
  };
  const onSave = () => {
    if (!editing) return;
    const name = normalizeSkillName(editing.name);
    if (!name) { window.alert(tr('settings.skills.needName')); return; }
    if (!editing.body.trim()) { window.alert(tr('settings.skills.needBody')); return; }
    setList(upsertSkill({ id: editing.id, name, description: editing.description, body: editing.body }));
    setEditing(null);
  };

  return (
    <>
      <Section
        hint={tr('settings.skills.hint')}
        trailing={<button className="v2-set-btn primary" onClick={onAdd}>＋ {tr('settings.skills.add')}</button>}
      >
        {list.length === 0 && <div className="v2-mcp-empty">{tr('settings.skills.empty')}</div>}
        {list.length > 0 && (
          <div className="v2-skill-list">
            {list.map((s) => (
              <div key={s.id} className="v2-skill-row">
                <div className="v2-skill-row-l">
                  <div className="nm">
                    <code>/{s.name}</code>
                    {s.source === 'cli' && s.origin && (
                      <span className="v2-skill-cli" title={tr('settings.skills.cliTip', { origin: s.origin })}>{s.origin}</span>
                    )}
                  </div>
                  {s.description && <div className="ds">{s.description}</div>}
                </div>
                <div className="v2-skill-row-r">
                  <button className="v2-set-btn" onClick={() => onEdit(s)}>{tr('settings.skills.edit')}</button>
                  <button className="v2-set-danger" onClick={() => onDelete(s)}>{tr('settings.skills.delete')}</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {editing && (
        <Section title={editing.id ? tr('settings.skills.editTitle') : tr('settings.skills.newTitle')}>
          <div className="v2-skill-form">
            <label className="lab">{tr('settings.skills.name')}</label>
            <div className="v2-skill-name"><span>/</span>
              <input className="v2-set-input" value={editing.name} placeholder="refactor"
                onChange={(e) => setEditing((p) => p && { ...p, name: e.target.value })} />
            </div>
            <label className="lab">{tr('settings.skills.desc')}</label>
            <input className="v2-set-input" value={editing.description} placeholder={tr('settings.skills.descPlaceholder')}
              onChange={(e) => setEditing((p) => p && { ...p, description: e.target.value })} />
            <label className="lab">{tr('settings.skills.body')}</label>
            <textarea className="v2-set-input v2-skill-body" rows={7} value={editing.body}
              placeholder={tr('settings.skills.bodyPlaceholder')}
              onChange={(e) => setEditing((p) => p && { ...p, body: e.target.value })} />
            <div className="v2-skill-tip">{tr('settings.skills.bodyTip')}</div>
            <div className="v2-skill-actions">
              <button className="v2-set-btn" onClick={() => setEditing(null)}>{tr('common.cancel')}</button>
              <button className="v2-set-btn primary" onClick={onSave}>{tr('settings.skills.save')}</button>
            </div>
          </div>
        </Section>
      )}
    </>
  );
};

const McpPane: React.FC = () => {
  const { t: tr } = useI18n();
  const [list, setList] = useState<MCPServer[] | null>(null);
  const refresh = () => mcpApi.list().then((l) => setList(Array.isArray(l) ? l : [])).catch(() => setList([]));
  useEffect(() => { refresh(); }, []);
  const [editing, setEditing] = useState<null | { id?: string; name: string; url: string; type: 'http' | 'sse' | 'stdio'; enabled: boolean }>(null);

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
        {!list && <div className="v2-mcp-empty">{tr('settings.mcp.loading')}</div>}
        {list && list.length === 0 && <div className="v2-mcp-empty">{tr('settings.mcp.empty')}</div>}
        {list && list.length > 0 && (
          <div className="v2-mcp-list">
            {list.map((m) => (
              <McpRow
                key={m.id}
                m={m}
                onChanged={refresh}
                onToggle={onToggle}
                onEdit={onEdit}
                onDelete={onDelete}
              />
            ))}
          </div>
        )}
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

/* Bring-your-own-app OAuth credentials, cached per MCP URL in localStorage.
   Used when a server rejects anonymous Dynamic Client Registration (e.g.
   Facebook Ads) — the user supplies their own registered client_id/secret,
   shared between the edit form (proactive config + echo-back) and the
   authorize() fallback prompt. */
export const mcpOauthCredKey = (url: string) => `mcp_oauth_client::${url}`;
export const loadMcpOauthCred = (url: string): { client_id?: string; client_secret?: string } | null => {
  try { const r = localStorage.getItem(mcpOauthCredKey(url)); return r ? JSON.parse(r) : null; } catch { return null; }
};
export const saveMcpOauthCred = (url: string, c: { client_id: string; client_secret: string }) => {
  try {
    if (c.client_id) localStorage.setItem(mcpOauthCredKey(url), JSON.stringify(c));
    else localStorage.removeItem(mcpOauthCredKey(url));
  } catch { /* ignore quota */ }
};

/* A single MCP server row. Owns its OAuth state so the authorize/re-authorize
   button + status pill (已授权 / 已过期 / 未授权) live per-server. */
const McpRow: React.FC<{
  m: MCPServer;
  onChanged: () => void;
  onToggle: (m: MCPServer) => void | Promise<void>;
  onEdit: (m: MCPServer) => void;
  onDelete: (m: MCPServer) => void | Promise<void>;
}> = ({ m, onChanged, onToggle, onEdit, onDelete }) => {
  const { t: tr } = useI18n();
  // stdio servers run as a child process — no OAuth. http/sse may need it.
  const oauthEligible = m.type !== 'stdio';
  const [hasToken, setHasToken] = useState<boolean | null>(null);
  const [expired, setExpired] = useState(false);
  const [authBusy, setAuthBusy] = useState<'discover' | 'redirect' | 'polling' | null>(null);
  // Lightweight classification (skip_dcr) so the row knows whether this server
  // needs OAuth at all — token-in-URL / no-auth servers show "connect" instead
  // of "authorize".
  const [det, setDet] = useState<McpDetectResult | null>(null);
  // Inline expand / connect — replaces the old centered probe modal: tools,
  // URL and any connection error live in-place under the row.
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [conn, setConn] = useState<null | { ok: boolean; tools?: string[]; error?: string; tokenInUrl?: boolean; provider?: string }>(null);
  // Electron disables window.prompt(), so DCR-failure recovery collects the
  // bring-your-own-app client_id/secret through this in-app modal instead.
  // `resolve` bridges the async authorize() flow to the modal's confirm/cancel.
  const [credModal, setCredModal] = useState<null | {
    resolve: (v: { client_id: string; client_secret: string } | null) => void;
    cid: string;
    csecret: string;
  }>(null);
  const requestCreds = (initial: { client_id?: string; client_secret?: string }) =>
    new Promise<{ client_id: string; client_secret: string } | null>((resolve) =>
      setCredModal({ resolve, cid: initial.client_id || '', csecret: initial.client_secret || '' })
    );

  // Probe token status on mount + whenever the URL changes.
  useEffect(() => {
    if (!oauthEligible || !m.url) return;
    let cancelled = false;
    oauthApi.tokenStatus(m.url)
      .then((r) => { if (!cancelled) { setHasToken(!!r?.has_token); setExpired(!!r?.expired); } })
      .catch(() => { if (!cancelled) { setHasToken(null); setExpired(false); } });
    oauthApi.detect(m.url, true)
      .then((r) => { if (!cancelled) setDet(r); })
      .catch(() => { /* classification is best-effort */ });
    return () => { cancelled = true; };
  }, [oauthEligible, m.url]);

  const authorize = async () => {
    if (!m.url) return;
    setAuthBusy('discover');
    try {
      let meta: Awaited<ReturnType<typeof oauthApi.discover>>;
      try {
        meta = await oauthApi.discover(m.url);
      } catch (discErr) {
        // Discovery failed — this is often a token-in-URL server (e.g. Feishu
        // open MCP) that doesn't do OAuth at all. Confirm via detect and guide
        // the user to regenerate the URL instead of showing a cryptic error.
        const det = await oauthApi.detect(m.url).catch(() => null);
        if (det?.token_in_url) {
          window.alert(tr('settings.mcp.tokenInUrlNotice', {
            provider: det.provider_hint
              ? det.provider_hint.charAt(0).toUpperCase() + det.provider_hint.slice(1)
              : tr('settings.mcp.providerGeneric'),
          }));
          setAuthBusy(null);
          return;
        }
        throw discErr;
      }
      if (!meta?.authorization_endpoint || !meta?.token_endpoint) {
        window.alert(tr('settings.mcp.noOauth'));
        setAuthBusy(null);
        return;
      }
      // Some servers (e.g. Facebook Ads) advertise a registration_endpoint but
      // reject anonymous Dynamic Client Registration — you must bring your own
      // pre-registered app credentials. Cache them per-URL in localStorage so a
      // later re-auth (token expiry) doesn't re-prompt. DCR-capable servers are
      // unaffected: we only prompt after the backend reports a registration error.
      const saved = loadMcpOauthCred(m.url);
      const firstBody = saved
        ? { ...meta, client_id: meta.client_id || saved.client_id, client_secret: meta.client_secret || saved.client_secret }
        : meta;
      let auth: Awaited<ReturnType<typeof oauthApi.authorize>>;
      try {
        auth = await oauthApi.authorize({ ...firstBody, mcp_url: m.url });
      } catch (regErr: any) {
        const msg = String(regErr?.message || '');
        const dcrFailed = /动态注册|registration|client_id/i.test(msg);
        if (!dcrFailed) throw regErr;
        // Server rejects anonymous DCR (e.g. Facebook) — collect bring-your-own
        // app credentials via the in-app modal (window.prompt is unavailable in Electron).
        const creds = await requestCreds(saved || {});
        if (!creds || !creds.client_id) { setAuthBusy(null); return; }
        saveMcpOauthCred(m.url, creds);
        auth = await oauthApi.authorize({ ...meta, ...creds, mcp_url: m.url });
      }
      if (!auth?.authorization_url) {
        window.alert(tr('settings.mcp.noAuthUrl'));
        setAuthBusy(null);
        return;
      }
      setAuthBusy('redirect');
      // In Electron, setWindowOpenHandler opens the URL in the system browser
      // and denies the in-app popup, so window.open returns null — that's the
      // happy path, not a blocked popup. Only treat null as "blocked" on web.
      // Detect Electron robustly: the preload-exposed flag is the source of
      // truth (VITE_ELECTRON env isn't reliably set in dev), with a userAgent
      // fallback. Without this, the system-browser happy path (window.open
      // returns null because setWindowOpenHandler denied the in-app popup) was
      // misreported as "popup blocked".
      const isElectron =
        !!(window as any).chateeElectron?.isElectron ||
        (import.meta as any).env?.VITE_ELECTRON === 'true' ||
        /electron/i.test(navigator.userAgent);
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
            void connect(); // re-connect inline so tools light up
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

  // Token-in-URL (e.g. Feishu open MCP) and open/no-auth servers don't use our
  // OAuth flow — they just connect, so show "connect" not "authorize".
  const noOauthNeeded = !!det && (det.token_in_url || (det.reachable && !det.auth_required));
  const needsAuth = oauthEligible && !noOauthNeeded && !hasToken; // includes never-authed + expired

  // Connect = probe inline. Result (tools / error / guidance) renders under the row.
  const connect = async () => {
    setConnecting(true);
    setExpanded(true);
    try {
      const res = await mcpApi.probe(m.id);
      let tokenInUrl = false; let provider: string | undefined;
      if (!res.ok) {
        const d = await oauthApi.detect(m.url, true).catch(() => null);
        tokenInUrl = !!d?.token_in_url; provider = d?.provider_hint;
      }
      setConn({ ok: !!res.ok, tools: res.tools, error: res.error, tokenInUrl, provider });
      onChanged();
    } catch (e: any) {
      setConn({ ok: false, error: e?.message || tr('settings.mcp.probeFailed') });
    } finally {
      setConnecting(false);
    }
  };

  // One quiet status glyph + word, in place of the old pill soup.
  const status: { g: string; w: string; tone: 'ok' | 'warn' | 'busy' | 'mute' } = (() => {
    if (!m.enabled) return { g: '◌', w: tr('settings.mcp.disabled'), tone: 'mute' };
    if (connecting || authBusy) return { g: '◐', w: authBusy ? tr('settings.mcp.discovering') : tr('settings.mcp.stConnecting'), tone: 'busy' };
    if (m.healthy || conn?.ok) return { g: '●', w: tr('settings.mcp.online'), tone: 'ok' };
    if (det?.token_in_url && conn && !conn.ok) return { g: '○', w: tr('settings.mcp.stTokenInvalid'), tone: 'warn' };
    if (needsAuth) return { g: '○', w: expired ? tr('settings.mcp.expired') : tr('settings.mcp.stNeedsAuth'), tone: 'warn' };
    if (conn && !conn.ok) return { g: '○', w: tr('settings.mcp.stOffline'), tone: 'warn' };
    return { g: '○', w: tr('settings.mcp.stOffline'), tone: 'mute' };
  })();

  const host = m.url.replace(/^[a-z]+:\/\//i, '').replace(/\/$/, '');
  const toolCount = conn?.tools?.length;

  // The single contextual action shown on the row.
  const primary = needsAuth
    ? { label: authBusy ? (authBusy === 'polling' ? tr('settings.mcp.callback') : authBusy === 'redirect' ? tr('settings.mcp.redirecting') : tr('settings.mcp.discovering')) : (expired ? tr('settings.mcp.reauthorize') : tr('settings.mcp.authorize')), run: authorize, busy: !!authBusy, warn: true }
    : { label: connecting ? tr('settings.mcp.stConnecting') : (m.healthy || conn?.ok ? tr('settings.mcp.reconnect') : tr('settings.mcp.connect')), run: connect, busy: connecting, warn: false };

  return (
    <div className={`v2-mcp-row${!m.enabled ? ' is-off' : ''}`}>
      <div className="v2-mcp-head">
        <button className="v2-mcp-main" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
          <span className={`v2-mcp-glyph ${status.tone}`}>{status.g}</span>
          <span className="v2-mcp-txt">
            <span className="v2-mcp-nm">{m.name}</span>
            <span className="v2-mcp-meta" title={m.url}>
              {host}
              <span className="dot">·</span>
              <span className={`st${status.tone === 'warn' ? ' warn' : ''}`}>{status.w}</span>
              {toolCount != null && <><span className="dot">·</span>{tr('settings.mcp.toolsHead', { count: toolCount })}</>}
            </span>
          </span>
        </button>
        <div className="v2-mcp-acts">
          <Switch checked={m.enabled} onChange={() => void onToggle(m)} />
          {m.enabled && (
            <button className={`v2-mcp-link${primary.warn ? ' warn' : ''}`} onClick={() => void primary.run()} disabled={primary.busy}>
              {primary.label}
            </button>
          )}
          <div className="v2-mcp-menu-wrap">
            <button className={`v2-mcp-more${menuOpen ? ' open' : ''}`} onClick={() => setMenuOpen((v) => !v)} aria-label="more">⋯</button>
            {menuOpen && (
              <>
                <div style={{ position: 'fixed', inset: 0, zIndex: 29 }} onClick={() => setMenuOpen(false)} />
                <div className="v2-mcp-menu">
                  <button onClick={() => { setMenuOpen(false); onEdit(m); }}>{tr('settings.mcp.edit')}</button>
                  <button onClick={() => { setMenuOpen(false); setExpanded(true); void connect(); }}>{tr('settings.mcp.viewTools')}</button>
                  <button className="danger" onClick={() => { setMenuOpen(false); void onDelete(m); }}>{tr('common.delete')}</button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {expanded && (
        <div className="v2-mcp-detail">
          <div className="v2-mcp-rule" />
          {conn?.tokenInUrl && (
            <div className="v2-mcp-note">
              {tr('settings.mcp.tokenInUrlNotice', {
                provider: conn.provider ? conn.provider.charAt(0).toUpperCase() + conn.provider.slice(1) : tr('settings.mcp.providerGeneric'),
              })}
            </div>
          )}
          {conn && !conn.ok && !conn.tokenInUrl && conn.error && (
            <div className="v2-mcp-err">{conn.error}</div>
          )}
          {conn?.ok && conn.tools && conn.tools.length > 0 && (
            <>
              <div className="v2-mcp-toolhd">{tr('settings.mcp.toolsHead', { count: conn.tools.length })}</div>
              <div className="v2-mcp-tools">
                {conn.tools.map((t) => <span key={t} className="v2-mcp-tool">{t}</span>)}
              </div>
            </>
          )}
          {conn?.ok && (!conn.tools || conn.tools.length === 0) && (
            <div className="v2-mcp-err">{tr('settings.mcp.connectedNoTools')}</div>
          )}
          <div className="v2-mcp-url">{m.url}</div>
        </div>
      )}
      {credModal && createPortal(
        <div
          className="v2-modal-mask"
          style={{ zIndex: 120, background: 'var(--c-bg)', backdropFilter: 'none', WebkitBackdropFilter: 'none' }}
          onMouseDown={(e) => { if (e.target === e.currentTarget) { credModal.resolve(null); setCredModal(null); } }}
        >
          <div className="v2-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="v2-modal-hd">
              <h3>{tr('settings.mcp.oauthCredTitle')}</h3>
              <button className="x" onClick={() => { credModal.resolve(null); setCredModal(null); }}>✕</button>
            </div>
            <div className="v2-modal-body">
              <div className="v2-modal-sec">
                <div className="lab" style={{ fontWeight: 400, opacity: 0.7, lineHeight: 1.5 }}>{tr('settings.mcp.oauthCredHint')}</div>
              </div>
              <div className="v2-modal-sec">
                <div className="lab">{tr('settings.mcp.oauthClientId')}</div>
                <input
                  autoFocus
                  value={credModal.cid}
                  placeholder={tr('settings.mcp.oauthClientIdPlaceholder')}
                  onChange={(e) => setCredModal({ ...credModal, cid: e.target.value })}
                />
              </div>
              <div className="v2-modal-sec">
                <div className="lab">{tr('settings.mcp.oauthClientSecret')} <span style={{ opacity: 0.55, fontWeight: 400 }}>{tr('settings.mcp.oauthClientSecretHint')}</span></div>
                <input
                  type="password"
                  value={credModal.csecret}
                  onChange={(e) => setCredModal({ ...credModal, csecret: e.target.value })}
                />
              </div>
            </div>
            <div className="v2-modal-foot">
              <button className="v2-mbtn" onClick={() => { credModal.resolve(null); setCredModal(null); }}>{tr('common.cancel')}</button>
              <button
                className="v2-mbtn primary"
                disabled={!credModal.cid.trim()}
                onClick={() => {
                  credModal.resolve({ client_id: credModal.cid.trim(), client_secret: credModal.csecret.trim() });
                  setCredModal(null);
                }}
              >{tr('common.confirm')}</button>
            </div>
          </div>
        </div>,
        (typeof document !== 'undefined' && document.querySelector('.chaya-v2')) || document.body
      )}
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
  // Bring-your-own OAuth app credentials (only meaningful for http/sse servers
  // whose AS rejects anonymous DCR, e.g. Facebook). Echo back whatever was
  // cached for this URL so the user sees their saved client_id on re-open.
  const initialCred = loadMcpOauthCred(draft.url) || {};
  const [oauthClientId, setOauthClientId] = useState(initialCred.client_id || '');
  const [oauthClientSecret, setOauthClientSecret] = useState(initialCred.client_secret || '');
  // Auto-detection: transport + auth requirements, debounced on the URL. Lets
  // the user paste a URL/command and have type + OAuth fields + tags filled in.
  const [detect, setDetect] = useState<McpDetectResult | null>(null);
  const [detecting, setDetecting] = useState(false);
  const detectSeq = useRef(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => {
    const raw = d.url.trim();
    if (!raw) { setDetect(null); setDetecting(false); return; }
    const seq = ++detectSeq.current;
    const isUrl = /^https?:\/\//i.test(raw);
    // Non-URL (stdio command) is detected synchronously — no round-trip needed.
    if (!isUrl) {
      setDetect({ transport: 'stdio', reachable: false, auth_required: false, oauth: false, token_in_url: false, dcr_supported: false, needs_manual_client: false });
      if (d.type !== 'stdio') setD((p) => ({ ...p, type: 'stdio' }));
      setDetecting(false);
      return;
    }
    setDetecting(true);
    const timer = setTimeout(async () => {
      try {
        const res = await oauthApi.detect(raw);
        if (seq !== detectSeq.current) return; // stale
        setDetect(res);
        if (res.transport && res.transport !== d.type) setD((p) => ({ ...p, type: res.transport }));
      } catch {
        if (seq === detectSeq.current) setDetect(null);
      } finally {
        if (seq === detectSeq.current) setDetecting(false);
      }
    }, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.url]);
  const save = async () => {
    if (!d.name.trim() || !d.url.trim()) { window.alert(tr('settings.mcp.nameUrlRequired')); return; }
    setBusy(true);
    try {
      if (d.id) {
        await mcpApi.update(d.id, { name: d.name.trim(), url: d.url.trim(), type: d.type, enabled: d.enabled });
      } else {
        await mcpApi.create({ name: d.name.trim(), url: d.url.trim(), type: d.type, enabled: d.enabled });
      }
      // Persist OAuth creds against the (possibly edited) URL. Stored client-side
      // only — never sent to our backend except as the client_id/secret used in
      // the standard authorize → token exchange.
      if (d.type !== 'stdio') saveMcpOauthCred(d.url.trim(), { client_id: oauthClientId.trim(), client_secret: oauthClientSecret.trim() });
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
            {(detecting || detect) && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8, alignItems: 'center' }}>
                {detecting && <span className="v2-pill mute">{tr('settings.mcp.detecting')}</span>}
                {!detecting && detect && (
                  <>
                    <span className="v2-pill mute" style={{ textTransform: 'uppercase', letterSpacing: '0.04em' }}>{detect.transport}</span>
                    {detect.provider_hint && <span className="v2-pill mute" style={{ textTransform: 'capitalize' }}>{detect.provider_hint}</span>}
                    {detect.transport !== 'stdio' && !detect.reachable && <span className="v2-pill mute">{tr('settings.mcp.tagUnreachable')}</span>}
                    {detect.transport !== 'stdio' && detect.reachable && !detect.auth_required && <span className="v2-pill ok">{tr('settings.mcp.tagAuthNone')}</span>}
                    {detect.token_in_url && <span className="v2-pill warn">{tr('settings.mcp.tagTokenInUrl')}</span>}
                    {detect.auth_required && detect.oauth && !detect.needs_manual_client && <span className="v2-pill ok">{tr('settings.mcp.tagAuth')}{detect.dcr_supported ? ` · ${tr('settings.mcp.tagAutoRegister')}` : ''}</span>}
                    {detect.needs_manual_client && <span className="v2-pill warn">{tr('settings.mcp.tagManualClient')}</span>}
                  </>
                )}
              </div>
            )}
          </div>
          <div className="v2-modal-sec">
            <div className="lab">{tr('settings.mcp.transport')}</div>
            {/* Auto-filled & locked once detection succeeds — the transport is derived
                from the URL/probe, so manual editing only invites mistakes. */}
            <select
              className="v2-set-select"
              style={{ width: '100%', ...(detect ? { opacity: 0.7, cursor: 'not-allowed' } : {}) }}
              value={d.type}
              disabled={!!detect}
              onChange={(e) => setD({ ...d, type: e.target.value as any })}
            >
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
          {/* Token-in-URL servers (e.g. Feishu open MCP) don't use OAuth — guide
              the user to regenerate the token-bearing URL instead of authorizing. */}
          {detect?.token_in_url && (
            <div className="v2-modal-sec">
              <div style={{
                fontSize: 12, lineHeight: 1.55, color: 'var(--c-ink-2, var(--c-ink))',
                background: 'color-mix(in oklab, var(--c-warn, #c9803a) 12%, transparent)',
                border: '1px solid color-mix(in oklab, var(--c-warn, #c9803a) 32%, transparent)',
                borderRadius: 'var(--c-radius-md, 8px)', padding: '9px 11px',
              }}>
                {tr('settings.mcp.tokenInUrlNotice', {
                  provider: detect.provider_hint
                    ? detect.provider_hint.charAt(0).toUpperCase() + detect.provider_hint.slice(1)
                    : tr('settings.mcp.providerGeneric'),
                })}
              </div>
            </div>
          )}

          {/* Only append the credential fields when detection says the server
              rejects anonymous DCR — those servers require a pre-registered app. */}
          {d.type !== 'stdio' && detect?.needs_manual_client && (
            <>
              <div className="v2-modal-sec">
                <div style={{
                  fontSize: 12, lineHeight: 1.55, color: 'var(--c-ink-2, var(--c-ink))',
                  background: 'color-mix(in oklab, var(--c-warn, #c9803a) 12%, transparent)',
                  border: '1px solid color-mix(in oklab, var(--c-warn, #c9803a) 32%, transparent)',
                  borderRadius: 'var(--c-radius-md, 8px)', padding: '9px 11px',
                }}>
                  {tr('settings.mcp.manualClientNotice', {
                    provider: detect.provider_hint
                      ? detect.provider_hint.charAt(0).toUpperCase() + detect.provider_hint.slice(1)
                      : tr('settings.mcp.providerGeneric'),
                  })}
                </div>
              </div>
              <div className="v2-modal-sec">
                <div className="lab">{tr('settings.mcp.oauthClientId')}</div>
                <input
                  value={oauthClientId}
                  onChange={(e) => setOauthClientId(e.target.value)}
                  placeholder={tr('settings.mcp.oauthClientIdPlaceholder')}
                  style={!oauthClientId.trim() ? { borderColor: 'var(--c-warn, #c9803a)' } : undefined}
                />
              </div>
              <div className="v2-modal-sec">
                <div className="lab">{tr('settings.mcp.oauthClientSecret')} <span style={{ opacity: 0.55, fontWeight: 400 }}>{tr('settings.mcp.oauthClientSecretHint')}</span></div>
                <input type="password" value={oauthClientSecret} onChange={(e) => setOauthClientSecret(e.target.value)} />
              </div>
            </>
          )}
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
