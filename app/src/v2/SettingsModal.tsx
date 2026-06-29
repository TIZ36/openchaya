import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  getSmartnoteApiKey, setSmartnoteApiKey,
  getSmartnoteBaseUrl, setSmartnoteBaseUrl,
  smartnoteProbe,
} from '../services/smartnoteApi';
import type { ClientSettings, ColorTheme, GlassZone, FontId } from '../components/settingsTypes';
import { type TypeSpeed } from './typewriter';
import { getSecret, setSecret, SECRET_KEYS, getDisplayName, setDisplayName } from '../services/configStore';
import {
  isLocalAgentAvailable, localAgent, addProject as addLocalProject, addCodexImportedSessions,
  basename, type CodexSessionSummary,
} from './services/localAgent';
import { loadSkills, upsertSkill, deleteSkill, normalizeSkillName, syncCliSkills, SKILLS_CHANGED_EVENT, type LocalSkill } from './services/skills';
import {
  IconUser, IconGear, IconCloud, IconTerminal, IconAppearance, IconSkill,
} from './icons';
import { useI18n, LANGS, type Lang } from '../i18n';

interface Props {
  settings: ClientSettings;
  updateSettings: (p: Partial<ClientSettings>) => void;
  onClose: () => void;
  initialSection?: Tab;   // 打开时滚到指定分组（如从输入框「管理技能」直达 skills）
}

type Tab = 'account' | 'appearance' | 'prefs' | 'services' | 'skills' | 'localagent';

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

const SettingsModal: React.FC<Props> = ({ settings, updateSettings, onClose, initialSection }) => {
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
            <NavUserFoot />
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
  const name = getDisplayName();
  const displayName = name || '—';
  const initials = (() => {
    const n = displayName;
    if (!n || n === '—') return '?';
    if (/[a-zA-Z]/.test(n[0])) {
      const parts = n.split(/[^a-zA-Z]/).filter(Boolean);
      return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || n[0].toUpperCase();
    }
    return n.slice(0, 1).toUpperCase();
  })();
  return { displayName, initials };
}

const AccountPane: React.FC = () => {
  const { t: tr } = useI18n();
  const [name, setName] = useState(getDisplayName());
  const [saved, setSaved] = useState(false);
  const { initials } = accountIdentity();
  const onSave = () => { setDisplayName(name.trim()); setSaved(true); setTimeout(() => setSaved(false), 1500); };

  // 纯客户端：无账号、无邮箱/套餐/租户。账户页 = 「你的称呼」编辑（仅个性化用）。
  return (
    <div className="v2-acc">
      <div className="v2-acc-id">
        <div className="v2-acc-av">{initials}</div>
        <div className="v2-acc-id-r">
          <div className="v2-acc-nm">{name.trim() || tr('shell.notSignedIn')}</div>
          <div className="v2-acc-meta"><span className="v2-acc-meta-i">{tr('shell.acct.localOnly')}</span></div>
        </div>
      </div>
      <Row label={tr('name.title')} sub={tr('name.desc')}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input className="v2-set-select" style={{ minWidth: 200 }} value={name}
            placeholder={tr('name.placeholder')} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onSave(); }} />
          <button className="v2-set-btn primary" onClick={onSave}>{tr('common.save')}</button>
          {saved && <span className="v2-pill ok">{tr('common.saved') || 'OK'}</span>}
        </div>
      </Row>
    </div>
  );
};

/** Pinned to the bottom of the settings left nav: current user (avatar + name,
 *  left-aligned) with a sign-out button. Keeps the account identity always in
 *  view and gives sign-out a stable home away from the scrolling panes. */
const NavUserFoot: React.FC = () => {
  const { displayName, initials } = accountIdentity();
  return (
    <div className="v2-settings-nav-foot">
      <div className="v2-settings-nav-user" title={displayName}>
        <span className="av">{initials}</span>
        <span className="nm">{displayName}</span>
      </div>
    </div>
  );
};

/* AccountPane-local 14px line icons. Inline so polish doesn't pollute the
   shared icons.tsx, which is curated for surface-wide patterns. */
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
 *  纯客户端：存本地 SQLite 凭证库（configStore），驱动起进程时注入 CURSOR_API_KEY。 */
const maskKey = (k: string): string => (k && k.length > 8 ? `${k.slice(0, 4)}…${k.slice(-4)}` : (k ? '••••' : ''));
const CursorKeyRow: React.FC = () => {
  const { t: tr } = useI18n();
  const [masked, setMasked] = useState<string | null>(() => { const k = getSecret(SECRET_KEYS.cursorApiKey); return k ? maskKey(k) : null; });
  const [input, setInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const onSave = async () => {
    const key = input.trim();
    if (!key) return;
    setSaving(true); setMsg(null);
    try {
      setSecret(SECRET_KEYS.cursorApiKey, key);
      setMasked(maskKey(key)); setInput(''); setMsg(tr('settings.localagent.cursorSaved'));
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


export default SettingsModal;
