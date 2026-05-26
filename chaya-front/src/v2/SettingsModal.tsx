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

type Tab = 'account' | 'prefs' | 'rag' | 'models' | 'mcp' | 'localagent';

const TAB_GROUPS: { group: string; hint: string; items: { id: Tab; label: string }[] }[] = [
  {
    group: '基础设置',
    hint: '对闲聊和 agent 都生效',
    items: [
      { id: 'account',  label: '账号' },
      { id: 'prefs',    label: '偏好' },
      { id: 'models',   label: '模型录入' },
      ...(isLocalAgentAvailable() ? [{ id: 'localagent' as Tab, label: 'Local Agents' }] : []),
    ],
  },
  {
    group: 'Agent 设置',
    hint: '仅 agent 配置后生效',
    items: [
      { id: 'rag',      label: '知识 / RAG' },
      { id: 'mcp',      label: 'MCP 工具' },
    ],
  },
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
  { id: 'default',   label: '极简',      sub: '纯白单色',   surface: '#ffffff', ramp: ['#e6e6e6', '#6e6e6e', '#0d0d0d'] },
  { id: 'anthropic', label: 'Anthropic', sub: '象牙陶土',   surface: '#faf6f1', ramp: ['#f5e5de', '#d97757', '#c15f3c'] },
  { id: 'warm',      label: 'Warm',      sub: '纸感琥珀',   surface: '#faf6ee', ramp: ['#f0e1c6', '#c8923f', '#8a5824'] },
  { id: 'cursor',    label: 'Cursor',    sub: '极夜石墨青', surface: '#181818', ramp: ['#3a6f6a', '#82d2ce', '#c2ece9'] },
  { id: 'linear',    label: 'Linear',    sub: '极夜靛蓝',   surface: '#08090a', ramp: ['#3a3f7a', '#5e6ad2', '#8299ff'] },
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
                  <span className="hint">{g.hint}</span>
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
            {tab === 'account'  && <AccountPane onLogout={onLogout} />}
            {tab === 'prefs'    && <PrefsPane settings={settings} updateSettings={updateSettings} />}
            {tab === 'rag'      && <RagPane settings={settings} updateSettings={updateSettings} />}
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

  const saved = (typeof window !== 'undefined' && localStorage.getItem('chatee_backend_url')) || '';
  const [endpoint, setEndpoint] = useState(saved);
  const [probe, setProbe] = useState<{ ok: boolean; text: string } | null>(null);
  const [probing, setProbing] = useState(false);

  const effective = getBackendUrl();
  const trimmed = endpoint.trim();
  const dirty = trimmed !== saved;

  const onProbe = async () => {
    const base = (trimmed || effective).replace(/\/+$/, '');
    setProbing(true);
    setProbe(null);
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch(`${base}/health`, { signal: ctrl.signal });
      clearTimeout(t);
      setProbe(r.ok ? { ok: true, text: `连接正常 · ${r.status}` } : { ok: false, text: `响应 ${r.status}` });
    } catch (e: any) {
      setProbe({ ok: false, text: e?.name === 'AbortError' ? '超时' : '连不上' });
    } finally {
      setProbing(false);
    }
  };

  const onSave = () => {
    if (trimmed) localStorage.setItem('chatee_backend_url', trimmed);
    else localStorage.removeItem('chatee_backend_url');
    (window as any).__cachedBackendUrl = trimmed;
    if (window.confirm('服务端点已保存，需要刷新页面才能生效。现在刷新？')) window.location.reload();
  };

  return (
    <>
      <Section title="账号">
        <Row label="邮箱"><div className="v2-set-val">{u?.email || '—'}</div></Row>
        <Row label="名字"><div className="v2-set-val">{u?.name || '—'}</div></Row>
        <Row label="套餐"><div className="v2-set-val"><span className="v2-pill">{String(plan).toUpperCase()}</span></div></Row>
        {u?.tenant?.name && <Row label="租户"><div className="v2-set-val">{u.tenant.name}</div></Row>}
      </Section>
      <Section title="服务端点" hint="后端 API / WebSocket 的地址，所有请求都走这里；改完需刷新生效">
        <Row label="后端地址" sub={`留空则自动推断 · 当前实际使用：${effective}`}>
          <input
            className="v2-set-select"
            style={{ minWidth: 260 }}
            value={endpoint}
            onChange={(e) => { setEndpoint(e.target.value); setProbe(null); }}
            placeholder="http://localhost:3002"
          />
        </Row>
        <Row label="">
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {probe && (
              <span className={`v2-pill ${probe.ok ? 'ok' : 'mute'}`} style={!probe.ok ? { background: '#fff7ed', color: '#c2410c' } : undefined}>
                {probe.text}
              </span>
            )}
            <button className="v2-set-btn" onClick={() => void onProbe()} disabled={probing}>
              {probing ? '探测中…' : '探测连接'}
            </button>
            <button className="v2-set-btn primary" onClick={onSave} disabled={!dirty}>保存并刷新</button>
          </div>
        </Row>
      </Section>
      <Section title="登出">
        <Row label="退出当前账号" sub="会清掉本机的 token，回到登入界面">
          <button className="v2-set-danger" onClick={() => { if (window.confirm('退出当前账号？')) onLogout(); }}>退出</button>
        </Row>
      </Section>
    </>
  );
};

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

const PrefsPane: React.FC<{ settings: ClientSettings; updateSettings: (p: Partial<ClientSettings>) => void }> = ({ settings, updateSettings }) => (
  <>
    <Section title="外观" hint="明暗与配色立即生效，整个界面跟随切换">
      <Row label="明暗" sub="深色模式护眼；跟随系统会随 macOS 外观自动切换">
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
      <Row label="颜色主题" sub="只换配色，不动排版字体">
        <div className="v2-theme-row">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={`v2-theme-chip${(settings.theme ?? 'default') === t.id ? ' active' : ''}`}
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
    <Section title="出字速度" hint="模型 token 是突发到达的（一坨一坨蹦）。开启后逐字匀速显示，更像打字机。对话与 CLI 分别控制。">
      <Row label="对话匀速出字" sub="闲聊 + agent 的流式回复按匀速吐字；关闭则到达即显示">
        <Switch checked={settings.chatStreamSmooth ?? true} onChange={(v) => updateSettings({ chatStreamSmooth: v })} />
      </Row>
      {(settings.chatStreamSmooth ?? true) && (
        <Row label="对话速度" sub="慢 = 明显打字机感；快 = 几乎贴近实时">
          <SpeedSeg value={settings.chatStreamSpeed ?? 'normal'} onChange={(sp) => updateSettings({ chatStreamSpeed: sp })} />
        </Row>
      )}
      <Row label="CLI 匀速出字" sub="Local Agents（本地 CLI）的流式回复按匀速吐字">
        <Switch checked={settings.cliStreamSmooth ?? true} onChange={(v) => updateSettings({ cliStreamSmooth: v })} />
      </Row>
      {(settings.cliStreamSmooth ?? true) && (
        <Row label="CLI 速度" sub="慢 = 明显打字机感；快 = 几乎贴近实时">
          <SpeedSeg value={settings.cliStreamSpeed ?? 'normal'} onChange={(sp) => updateSettings({ cliStreamSpeed: sp })} />
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

const LA_PROVIDERS: { id: 'claude' | 'codex' | 'gemini'; label: string; live: boolean }[] = [
  { id: 'claude', label: 'Claude Code', live: true },
  { id: 'codex', label: 'Codex', live: false },
  { id: 'gemini', label: 'Gemini', live: false },
];

const LocalAgentPane: React.FC<{ settings: ClientSettings; updateSettings: (p: Partial<ClientSettings>) => void }> = ({ settings, updateSettings }) => {
  const cur = settings.localAgentProvider ?? 'claude';
  return (
    <>
      <Section title="Local Agents" hint="在你机器上跑本地 CLI Agent（仅桌面版）。对话与文件都留在本地，与 Chaya 服务无关。">
        <Row label="默认 Provider" sub="侧栏徽标即显示当前选择。目前仅 Claude Code 支持实时对话，Codex / Gemini 即将接入。">
          <div className="v2-seg v2-la-set-seg">
            {LA_PROVIDERS.map((p) => (
              <button
                key={p.id}
                className={`v2-seg-item${cur === p.id ? ' active' : ''}`}
                onClick={() => updateSettings({ localAgentProvider: p.id })}
                title={p.live ? '已支持实时对话' : '即将支持'}
              >
                <span className={`v2-la-setdot prov-${p.id}`} />{p.label}
                {!p.live && <span className="v2-la-soon">soon</span>}
              </button>
            ))}
          </div>
        </Row>
      </Section>
      <Section title="权限模式" hint="对话框里按 Tab 键即时切换（Default / Plan / Accept Edits / Bypass）。">
        <Row label="说明" sub="Plan = 只读规划；Accept Edits = 自动改文件；Bypass = 全自动执行。每次对话用当前选择的模式。">
          <div className="v2-set-val">在对话输入框右下角查看与切换</div>
        </Row>
      </Section>
    </>
  );
};

const RagPane: React.FC<{ settings: ClientSettings; updateSettings: (p: Partial<ClientSettings>) => void }> = ({ settings, updateSettings }) => {
  const [snKey, setSnKey] = useState(getSmartnoteApiKey());
  const [snBase, setSnBase] = useState(getSmartnoteBaseUrl());
  const [probing, setProbing] = useState(false);
  const [probeMsg, setProbeMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const onSaveSn = () => {
    setSmartnoteBaseUrl(snBase.trim());
    setSmartnoteApiKey(snKey.trim());
    setProbeMsg(null);
  };
  const onProbeSn = async () => {
    setSmartnoteBaseUrl(snBase.trim());
    setSmartnoteApiKey(snKey.trim());
    setProbing(true);
    setProbeMsg(null);
    try {
      const r = await smartnoteProbe();
      setProbeMsg(r.ok ? { ok: true, text: '通了' } : { ok: false, text: r.error || '失败' });
    } catch (e: any) {
      setProbeMsg({ ok: false, text: e?.message || '失败' });
    } finally { setProbing(false); }
  };

  return (
    <>
      <Section title="Smartnote 凭据" hint="知识库 / 记忆 / RAG 的后端，输入这里之后整个 v2 都能用">
        <Row label="Smartnote API Key" sub="登录 Smartnote Cloud 后台 → API Keys 创建">
          <input
            className="v2-set-select"
            style={{ minWidth: 260 }}
            type="password"
            value={snKey}
            onChange={(e) => setSnKey(e.target.value)}
            placeholder="sn_…"
          />
        </Row>
        <Row label="Smartnote Base URL" sub="留空使用默认服务">
          <input
            className="v2-set-select"
            style={{ minWidth: 260 }}
            value={snBase}
            onChange={(e) => setSnBase(e.target.value)}
            placeholder="https://api.smartnote.cloud"
          />
        </Row>
        <Row label="">
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {probeMsg && (
              <span className={`v2-pill ${probeMsg.ok ? 'ok' : 'mute'}`} style={!probeMsg.ok ? { background: '#fff7ed', color: '#c2410c' } : undefined}>
                {probeMsg.text}
              </span>
            )}
            <button className="v2-set-btn" onClick={() => void onProbeSn()} disabled={probing || !snKey.trim()}>
              {probing ? '探测中…' : '探测连接'}
            </button>
            <button className="v2-set-btn primary" onClick={onSaveSn}>保存</button>
          </div>
        </Row>
      </Section>

      <Section title="RAG / 知识检索" hint="发送前先到记忆库里捞相关上下文，拼到消息顶部">
        <Row label="启用 RAG"><Switch checked={!!settings.ragEnabled} onChange={(v) => updateSettings({ ragEnabled: v })} /></Row>
        <Row label="召回数量 topK" sub="一次取多少条最相关的">
          <select className="v2-set-select" value={settings.ragTopK ?? 5} onChange={(e) => updateSettings({ ragTopK: Number(e.target.value) })}>
            {[3, 5, 8, 12, 20].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </Row>
        <Row label="检索范围" sub="auto 让 AI 自己挑；agent 仅本 agent；workspace 整个 workspace">
          <select className="v2-set-select" value={settings.ragScope ?? 'auto'} onChange={(e) => updateSettings({ ragScope: e.target.value as ClientSettings['ragScope'] })}>
            <option value="auto">auto</option>
            <option value="agent">agent</option>
            <option value="workspace">workspace</option>
          </select>
        </Row>
      </Section>
    </>
  );
};

/* ============ models pane (v2 native) ============ */

interface ModelEditDraft {
  config_id?: string;       // present when editing
  provider: LLMConfigFromDB['provider'];
  name: string;
  shortname?: string;
  api_key?: string;
  api_url?: string;
  model?: string;
  enabled: boolean;
  media_visible?: boolean;
}

const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI', deepseek: 'DeepSeek', anthropic: 'Anthropic',
  gemini: 'Gemini', ollama: 'Ollama', local: 'Local', custom: 'Custom',
};

const ModelsPane: React.FC<{ settings: ClientSettings; updateSettings: (p: Partial<ClientSettings>) => void }> = ({ settings, updateSettings }) => {
  const [list, setList] = useState<LLMConfigFromDB[] | null>(null);
  const [editing, setEditing] = useState<ModelEditDraft | null>(null);
  const refresh = () => getLLMConfigs().then((l) => setList(Array.isArray(l) ? l : [])).catch(() => setList([]));
  useEffect(() => { refresh(); }, []);

  const defaultId = settings.defaultLLMConfigId;
  const setDefault = (id?: string) => updateSettings({ defaultLLMConfigId: id });

  const groups = useMemo(() => {
    if (!list) return null;
    const map = new Map<string, LLMConfigFromDB[]>();
    for (const c of list) {
      const k = c.provider || 'custom';
      const arr = map.get(k) || [];
      arr.push(c);
      map.set(k, arr);
    }
    return Array.from(map.entries()).map(([provider, configs]) => ({ provider, configs }));
  }, [list]);

  const onToggle = async (c: LLMConfigFromDB, key: 'enabled' | 'media_visible') => {
    try {
      await updateLLMConfig(c.config_id, { [key]: !c[key] } as any);
      refresh();
    } catch (e: any) { window.alert(e?.message || '失败'); }
  };
  const onDelete = async (c: LLMConfigFromDB) => {
    if (!window.confirm(`删除模型「${c.name}」？`)) return;
    try { await deleteLLMConfig(c.config_id); refresh(); } catch (e: any) { window.alert(e?.message || '失败'); }
  };
  const onEdit = async (c: LLMConfigFromDB) => {
    let api_key = '';
    try { api_key = await getLLMConfigApiKey(c.config_id); } catch {/* */}
    setEditing({
      config_id: c.config_id, provider: c.provider, name: c.name, shortname: c.shortname,
      api_key, api_url: c.api_url, model: c.model, enabled: c.enabled !== false, media_visible: !!c.media_visible,
    });
  };
  const onAdd = () => setEditing({
    provider: 'openai', name: '', api_key: '', api_url: '', model: '', enabled: true, media_visible: false,
  });

  return (
    <>
      <Section
        title="模型录入"
        hint="管理 LLM 配置 — agent / 茶话 / 创作都从这里挑；点「设为默认」指定新会话默认用哪个"
        trailing={<button className="v2-set-btn primary" onClick={onAdd}>＋ 添加</button>}
      >
        {!list && <div className="v2-set-empty">加载中…</div>}
        {list && list.length === 0 && <div className="v2-set-empty">还没有模型配置 — 点右上角「添加」</div>}
        {groups && groups.map((g) => (
          <div key={g.provider} className="v2-set-group">
            <div className="v2-set-group-hd">{PROVIDER_LABELS[g.provider] || g.provider}</div>
            {g.configs.map((c) => {
              const isDefault = defaultId === c.config_id;
              const isEnabled = c.enabled !== false;
              return (
                <div key={c.config_id} className={`v2-set-card-row${isDefault ? ' is-default' : ''}`}>
                  <div className="l">
                    <div className="t">{c.shortname || c.name} <small>{c.model || '—'}</small></div>
                    <div className="s">
                      {isDefault && <span className="v2-pill solid">★ 默认</span>}
                      {isEnabled ? <span className="v2-pill ok">启用</span> : <span className="v2-pill mute">停用</span>}
                      {c.media_visible && <span className="v2-pill">创作可见</span>}
                      {c.api_url && <span className="v2-pill mute" title={c.api_url}>自定义 URL</span>}
                    </div>
                  </div>
                  <div className="r">
                    {isDefault ? (
                      <button className="v2-set-btn" onClick={() => setDefault(undefined)}>取消默认</button>
                    ) : (
                      <button className="v2-set-btn" onClick={() => setDefault(c.config_id)} disabled={!isEnabled} title={isEnabled ? '' : '停用的模型不能设为默认'}>设为默认</button>
                    )}
                    <button className="v2-set-btn" onClick={() => onToggle(c, 'enabled')}>{isEnabled ? '停用' : '启用'}</button>
                    <button className="v2-set-btn" onClick={() => onToggle(c, 'media_visible')}>{c.media_visible ? '从创作隐藏' : '设为创作可见'}</button>
                    <button className="v2-set-btn" onClick={() => void onEdit(c)}>编辑</button>
                    <button className="v2-set-danger" onClick={() => void onDelete(c)}>删除</button>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </Section>

      {editing && (
        <ModelEditModal
          draft={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh(); }}
        />
      )}
    </>
  );
};

const ModelEditModal: React.FC<{
  draft: ModelEditDraft;
  onClose: () => void;
  onSaved: () => void;
}> = ({ draft, onClose, onSaved }) => {
  const [d, setD] = useState<ModelEditDraft>(draft);
  const [providers, setProviders] = useState<SupportedProvider[] | null>(null);
  const [discoverList, setDiscoverList] = useState<{ id: string; name: string }[] | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => { getSupportedProviders().then(setProviders).catch(() => setProviders([])); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const set = (patch: Partial<ModelEditDraft>) => setD((p) => ({ ...p, ...patch }));

  const discover = async () => {
    if (!d.api_key?.trim()) { window.alert('先填 API Key'); return; }
    setDiscovering(true);
    try {
      const ms = await listAvailableModels(d.provider, d.api_key.trim(), d.api_url?.trim() || undefined);
      setDiscoverList(ms);
    } catch (e: any) {
      window.alert(e?.message || '拉模型失败');
    } finally { setDiscovering(false); }
  };

  const save = async () => {
    if (!d.name.trim()) { window.alert('名字不能空'); return; }
    setBusy(true);
    try {
      if (d.config_id) {
        const updates: any = {
          name: d.name.trim(), shortname: d.shortname,
          api_url: d.api_url || undefined, model: d.model || undefined,
          enabled: d.enabled, media_visible: d.media_visible,
        };
        if (d.api_key && d.api_key.trim()) updates.api_key = d.api_key.trim();
        await updateLLMConfig(d.config_id, updates);
      } else {
        await createLLMConfig({
          provider: d.provider, name: d.name.trim(), shortname: d.shortname,
          api_key: d.api_key?.trim() || undefined,
          api_url: d.api_url?.trim() || undefined,
          model: d.model?.trim() || undefined,
          enabled: d.enabled, media_visible: d.media_visible,
        });
      }
      onSaved();
    } catch (e: any) {
      window.alert(e?.message || '保存失败');
    } finally { setBusy(false); }
  };

  return (
    <div className="v2-modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} style={{ zIndex: 110 }}>
      <div className="v2-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="v2-modal-hd">
          <h3>{d.config_id ? '编辑模型' : '添加模型'}</h3>
          <button className="x" onClick={onClose}>✕</button>
        </div>
        <div className="v2-modal-body">
          <div className="v2-modal-sec">
            <div className="lab">Provider</div>
            <select className="v2-set-select" style={{ width: '100%' }} value={d.provider} onChange={(e) => set({ provider: e.target.value as any })}>
              {(providers && providers.length > 0
                ? providers.map((p) => p.provider_type)
                : ['openai', 'deepseek', 'anthropic', 'gemini', 'ollama', 'custom']
              ).map((pt) => (
                <option key={pt} value={pt}>{PROVIDER_LABELS[pt] || pt}</option>
              ))}
            </select>
          </div>
          <div className="v2-modal-sec">
            <div className="lab">名字 (在 UI 显示)</div>
            <input value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="如：GPT-4o · 工作号" />
          </div>
          <div className="v2-modal-sec">
            <div className="lab">短名 (可选，chip 上显示)</div>
            <input value={d.shortname || ''} onChange={(e) => set({ shortname: e.target.value })} placeholder="如：4o" />
          </div>
          <div className="v2-modal-sec">
            <div className="lab">API Key {d.config_id && <span style={{ color: 'var(--c-ink-4)' }}>(不改就留空)</span>}</div>
            <input type="password" value={d.api_key || ''} onChange={(e) => set({ api_key: e.target.value })} placeholder="sk-…" />
          </div>
          <div className="v2-modal-sec">
            <div className="lab">API URL (可选 — 自托管 / proxy)</div>
            <input value={d.api_url || ''} onChange={(e) => set({ api_url: e.target.value })} placeholder="https://api.openai.com/v1" />
          </div>
          <div className="v2-modal-sec">
            <div className="lab" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>模型</span>
              <button className="v2-set-btn" style={{ marginLeft: 'auto' }} onClick={() => void discover()} disabled={discovering}>
                {discovering ? '拉取中…' : '从 API 列出'}
              </button>
            </div>
            <input value={d.model || ''} onChange={(e) => set({ model: e.target.value })} placeholder="如：gpt-4o" />
            {discoverList && discoverList.length > 0 && (
              <div className="v2-ctxpop-list" style={{ marginTop: 8, maxHeight: 200, overflowY: 'auto' }}>
                {discoverList.map((m) => (
                  <div
                    key={m.id}
                    className={`v2-ctxpop-item${d.model === m.id ? ' active' : ''}`}
                    onClick={() => set({ model: m.id })}
                  >
                    <div className="nm">{m.name}<small>{m.id}</small></div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="v2-modal-sec">
            <div className="v2-set-row" style={{ padding: 0 }}>
              <div className="v2-set-row-l"><div className="lab">启用</div></div>
              <Switch checked={d.enabled} onChange={(v) => set({ enabled: v })} />
            </div>
            <div className="v2-set-row" style={{ padding: 0 }}>
              <div className="v2-set-row-l"><div className="lab">在创作面板可选</div><div className="sub">用于生图/视频；通常仅给媒体能力的模型开</div></div>
              <Switch checked={!!d.media_visible} onChange={(v) => set({ media_visible: v })} />
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
