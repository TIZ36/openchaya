import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CurrentUser, TenantPlan } from '../utils/themeAccess';
import { getBackendUrl } from '../utils/backendUrl';
import {
  getSmartnoteBaseUrl, setSmartnoteBaseUrl,
  getSmartnoteApiKey, setSmartnoteApiKey, smartnoteProbe,
} from '../services/smartnoteApi';
import { getMe, listMemberships, updateMembership, type MembershipItem } from '../services/adminApi';
import { getLLMConfigs, type LLMConfigFromDB } from '../services/llmApi';
import type { TypeSpeed } from '../v2/typewriter';
import { toast } from './ui/use-toast';
import {
  PaperPage, PaperTopbar, PaperContent, PaperSplit, PaperTOC,
  PaperButton, PaperInput, PaperSwitch, PaperDanger,
} from './paper';

/* ============================================================
   设置 / Preferences — aligned with mockups/a-settings.html
   Seven sections (+ optional admin) with left TOC sidebar.
   ============================================================ */

export type FontId = 'default' | 'pixel' | 'terminal' | 'firacode' | 'rounded' | 'dotgothic' | 'silkscreen';

export type { TypeSpeed };

export type AppearanceMode = 'light' | 'dark' | 'system';
export type ColorTheme = 'default' | 'anthropic' | 'razer' | 'codex';
/** 可单独开启毛玻璃的界面区域。 */
export type GlassZone = 'composer' | 'sidebar' | 'topbar' | 'menu' | 'modal' | 'bubble' | 'main';
/** 毛玻璃整体强度（模糊+透明度）：subtle 轻 · standard 标准 · strong 强。 */
export type GlassIntensity = 'subtle' | 'standard' | 'strong';

export interface ClientSettings {
  font: FontId;
  appearance?: AppearanceMode;
  theme?: ColorTheme;
  /** 开启了毛玻璃的区域列表。默认 composer / menu / modal。 */
  glassZones?: GlassZone[];
  /** 毛玻璃整体强度。默认 standard。 */
  glassIntensity?: GlassIntensity;
  enableToolCalling: boolean;
  density?: 'relaxed' | 'normal' | 'compact';
  handRule?: boolean;
  cmdEnterToSend?: boolean;
  showTokenCost?: boolean;
  autoTTS?: boolean;
  ragEnabled?: boolean;
  ragTopK?: number;
  ragScope?: 'auto' | 'agent' | 'workspace';
  defaultLLMConfigId?: string;
  /** Local Agents 默认 provider（本地功能，桌面版）。 */
  localAgentProvider?: 'claude' | 'cursor' | 'codex' | 'gemini';
  /** 对话(闲聊 + agent) 出字平滑：开关 + 速度档。默认开 / 适中。 */
  chatStreamSmooth?: boolean;
  chatStreamSpeed?: TypeSpeed;
  /** CLI(本地 Agent) 出字平滑：开关 + 速度档。默认开 / 适中。 */
  cliStreamSmooth?: boolean;
  cliStreamSpeed?: TypeSpeed;
}

interface SettingsPageProps {
  user: CurrentUser | null;
  settings: ClientSettings;
  onUpdateSettings: (s: Partial<ClientSettings>) => void;
  onLogout: () => void;
}

type SectionId =
  | 'account' | 'appearance' | 'typography' | 'defaults'
  | 'chat' | 'knowledge' | 'data' | 'about' | 'advanced';

const TOC: Array<{ id: SectionId; label: string; founderOnly?: boolean }> = [
  { id: 'account',     label: '账号' },
  { id: 'appearance',  label: '长相' },
  { id: 'typography',  label: '字' },
  { id: 'defaults',    label: '默认模型' },
  { id: 'chat',        label: '对话' },
  { id: 'knowledge',   label: '知识' },
  { id: 'data',        label: '数据' },
  { id: 'about',       label: '关于' },
  { id: 'advanced',    label: '高级', founderOnly: true },
];

const SettingsPage: React.FC<SettingsPageProps> = ({
  user, settings, onUpdateSettings, onLogout,
}) => {
  const [active, setActive] = useState<SectionId>('account');
  const pagesRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Record<SectionId, HTMLElement | null>>({} as any);

  const [backendUrl, setBackendUrl] = useState<string>(getBackendUrl());

  // Smartnote config
  const [snBase, setSnBase] = useState<string>(getSmartnoteBaseUrl());
  const [snKey, setSnKey] = useState<string>(getSmartnoteApiKey());
  const [snReveal, setSnReveal] = useState(false);
  const [snProbing, setSnProbing] = useState(false);
  const [snStatus, setSnStatus] = useState<'unknown' | 'ok' | 'down'>('unknown');
  const [snErr, setSnErr] = useState<string | null>(null);
  const [name, setName] = useState<string>(user?.name || '');
  const [email, setEmail] = useState<string>(user?.email || '');

  const [configs, setConfigs] = useState<LLMConfigFromDB[]>([]);
  const [memberships, setMemberships] = useState<MembershipItem[]>([]);
  const [membershipLoading, setMembershipLoading] = useState(false);
  const [membershipSavingTenantId, setMembershipSavingTenantId] = useState<string | null>(null);
  const [isFounder, setIsFounder] = useState(!!user?.is_founder);

  useEffect(() => { setName(user?.name || ''); setEmail(user?.email || ''); setIsFounder(!!user?.is_founder); }, [user]);

  useEffect(() => {
    void (async () => {
      try {
        const list = await getLLMConfigs();
        setConfigs(list);
      } catch {/* */}
    })();
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const me = await getMe();
        if (!alive) return;
        setIsFounder(me.is_founder === true);
        if (me.is_founder) {
          setMembershipLoading(true);
          const items = await listMemberships();
          if (!alive) return;
          setMemberships(items);
        }
      } catch {
        /* */
      } finally {
        if (alive) setMembershipLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const visibleToc = useMemo(() => TOC.filter((t) => !t.founderOnly || isFounder), [isFounder]);

  const handleSaveBackendUrl = () => {
    localStorage.setItem('chatee_backend_url', backendUrl);
    (window as any).__cachedBackendUrl = backendUrl;
    toast({ title: '已保存', description: '后端地址改了，刷新页面就生效' });
  };

  const handleSaveSmartnote = async () => {
    setSmartnoteBaseUrl(snBase.trim());
    setSmartnoteApiKey(snKey.trim());
    toast({ title: '已保存' });
    // Immediately probe
    setSnProbing(true);
    const r = await smartnoteProbe();
    setSnProbing(false);
    if (r.ok) {
      setSnStatus('ok');
      setSnErr(null);
      toast({ title: '连上了', variant: 'success' });
    } else {
      setSnStatus('down');
      setSnErr(r.error || null);
      toast({ title: '连不上', description: r.error || '', variant: 'destructive' });
    }
  };

  const handleProbeSmartnote = async () => {
    setSnProbing(true);
    const r = await smartnoteProbe();
    setSnProbing(false);
    if (r.ok) { setSnStatus('ok'); setSnErr(null); }
    else { setSnStatus('down'); setSnErr(r.error || null); }
  };

  const exportConversations = () => {
    toast({ title: '下次再做', description: '对话导出在下一版里' });
  };

  const exportPersonas = () => {
    toast({ title: '下次再做', description: 'Persona + 记忆导出在下一版里' });
  };

  const forgetAllMemory = () => {
    if (!confirm('真的要让所有 agent 忘掉吗？做了没法撤销。')) return;
    toast({ title: '下次再做', description: '这个按钮还没接后端', variant: 'destructive' });
  };

  const handleMembershipChange = async (tenantId: string, plan: TenantPlan) => {
    setMembershipSavingTenantId(tenantId);
    try {
      const tenant = await updateMembership(tenantId, plan);
      setMemberships((prev) =>
        prev.map((it) => (it.tenant_id === tenantId ? { ...it, plan: tenant.plan as TenantPlan } : it)),
      );
      toast({ title: '已切换', description: `${tenant.name} 切到 ${tenant.plan}`, variant: 'success' });
    } catch (error) {
      toast({ title: '改不动', description: error instanceof Error ? error.message : String(error), variant: 'destructive' });
    } finally {
      setMembershipSavingTenantId(null);
    }
  };

  // Scroll spy — update active TOC as user scrolls
  useEffect(() => {
    const el = pagesRef.current;
    if (!el) return;
    const onScroll = () => {
      const top = el.scrollTop;
      let current: SectionId = active;
      for (const item of visibleToc) {
        const section = sectionRefs.current[item.id];
        if (section && section.offsetTop - 80 <= top) current = item.id;
      }
      if (current !== active) setActive(current);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [active, visibleToc]);

  const handleTocSelect = (id: SectionId) => {
    setActive(id);
    const sect = sectionRefs.current[id];
    const pages = pagesRef.current;
    if (sect && pages) {
      pages.scrollTo({ top: sect.offsetTop - 12, behavior: 'smooth' });
    }
  };

  const sectRef = (id: SectionId) => (el: HTMLElement | null) => {
    sectionRefs.current[id] = el;
  };

  const enabledConfigs = useMemo(() => configs.filter((c) => c.enabled), [configs]);
  const currentDefaultId = useMemo(() => {
    if (settings.defaultLLMConfigId &&
        enabledConfigs.some((c) => c.config_id === settings.defaultLLMConfigId)) {
      return settings.defaultLLMConfigId;
    }
    // Fallback preference when nothing picked yet.
    return enabledConfigs.find((c) => c.provider === 'openai')?.config_id
      || enabledConfigs[0]?.config_id
      || '';
  }, [enabledConfigs, settings.defaultLLMConfigId]);

  return (
    <PaperPage>
      <PaperTopbar
        crumb="Chapter Seven · Preferences"
        title="设置"
        subtitle="你的账号、长相、喜欢的字、数据备份、以及一些关于这个 app 的小事。"
        meta="v1 · handmade"
      />

      <PaperContent noPad>
        <PaperSplit>
          <PaperTOC
            label="目录"
            items={visibleToc.map((t) => ({ id: t.id, label: t.label }))}
            activeId={active}
            onSelect={(id) => handleTocSelect(id as SectionId)}
          />

          <div className="paper-pages" ref={pagesRef}>
            {/* 01 ACCOUNT */}
            <section className="paper-sect" ref={sectRef('account')}>
              <Head n="01" title="账号" cap="Account" />
              <Lead>是你，就是你。</Lead>
              <Row title="名字" desc="agents 会用这个叫你。改了之后它们下次对话就知道。">
                <PaperInput
                  align="right"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  style={{ minWidth: 200 }}
                />
              </Row>
              <Row title="邮箱" desc="你登入用的邮箱。">
                <PaperInput
                  align="right"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  readOnly
                  style={{ minWidth: 240 }}
                />
              </Row>
              <Row title="密码" desc={user ? `上次改 · ${formatRelative((user as any).updated_at)}` : '—'}>
                <PaperButton variant="link">改一个</PaperButton>
              </Row>
              <Row title="登出" desc="退出当前账号，回到登入页。">
                <PaperButton variant="link" danger onClick={onLogout}>登出</PaperButton>
              </Row>
            </section>

            {/* 02 APPEARANCE */}
            <section className="paper-sect" ref={sectRef('appearance')}>
              <Head n="02" title="长相" cap="Appearance" />
              <Lead>纸与墨，一套就够。</Lead>
              <Row title="手绘装饰线" desc="就是侧栏 wordmark 下面那根不太直的线。">
                <PaperSwitch
                  checked={settings.handRule !== false}
                  onChange={(v) => onUpdateSettings({ handRule: v })}
                />
              </Row>
            </section>

            {/* 03 TYPOGRAPHY */}
            <section className="paper-sect" ref={sectRef('typography')}>
              <Head n="03" title="字" cap="Typography" />
              <Lead>挑一套你愿意读一下午的字。</Lead>
              <div style={sx.fontOpts}>
                <FontOpt
                  sel={settings.font === 'default'}
                  sample="Young Serif · 霁月光风"
                  sampleStyle={{ fontFamily: "'Young Serif', 'LXGW WenKai', serif" }}
                  label="DEFAULT · 手作"
                  onClick={() => onUpdateSettings({ font: 'default' })}
                />
                <FontOpt
                  sel={settings.font === 'rounded'}
                  sample="Commissioner · 霁月光风"
                  sampleStyle={{ fontFamily: "'Commissioner', 'LXGW WenKai', sans-serif", fontWeight: 500 }}
                  label="ALT · 轻盈"
                  onClick={() => onUpdateSettings({ font: 'rounded' })}
                />
                <FontOpt
                  sel={settings.font === 'dotgothic'}
                  sample="手写体 · 霁月光风"
                  sampleStyle={{ fontFamily: "'LXGW WenKai', serif" }}
                  label="CJK · 霞鹜文楷"
                  onClick={() => onUpdateSettings({ font: 'dotgothic' })}
                />
              </div>
            </section>

            {/* 04 DEFAULTS */}
            <section className="paper-sect" ref={sectRef('defaults')}>
              <Head n="04" title="默认模型" cap="Defaults" />
              <Lead>新 agent 开局用哪款模型。</Lead>
              <Row
                title="新 agent 默认用"
                desc={
                  enabledConfigs.length === 0
                    ? '一个可用模型都没有。先去「模型」里接一个 provider 并启用。'
                    : '下次创建 agent 会自动选这个。现有 agent 不受影响——要改单只的模型去「人设」那页。'
                }
              >
                <select
                  value={currentDefaultId}
                  disabled={enabledConfigs.length === 0}
                  onChange={(e) => onUpdateSettings({ defaultLLMConfigId: e.target.value })}
                  style={{
                    background: 'transparent', border: 0,
                    borderBottom: '1px solid var(--rule-strong)',
                    padding: '5px 2px',
                    fontFamily: "'Commissioner', sans-serif",
                    fontSize: 14, color: 'var(--ink)',
                    outline: 'none',
                    cursor: enabledConfigs.length === 0 ? 'not-allowed' : 'pointer',
                    minWidth: 220, textAlign: 'right',
                    opacity: enabledConfigs.length === 0 ? 0.5 : 1,
                  }}
                >
                  {enabledConfigs.length === 0 ? (
                    <option value="">— 没有可用模型 —</option>
                  ) : (
                    enabledConfigs.map((c) => (
                      <option key={c.config_id} value={c.config_id}>
                        {(c.shortname || c.name)} · {c.provider}
                      </option>
                    ))
                  )}
                </select>
              </Row>
              <Row title="管理模型" desc="在「模型」那章配置每个 provider 的 API key。">
                <PaperButton
                  variant="ghost"
                  size="small"
                  onClick={() => { window.location.hash = '#/models'; }}
                >
                  去管理 →
                </PaperButton>
              </Row>
            </section>

            {/* 05 CHAT */}
            <section className="paper-sect" ref={sectRef('chat')}>
              <Head n="05" title="对话" cap="Chat" />
              <Lead>聊天时的那些小开关。</Lead>
              <Row title="⌘+回车 发送" desc="关了就是单独按 回车 发送，回车是换行。">
                <PaperSwitch
                  checked={settings.cmdEnterToSend !== false}
                  onChange={(v) => onUpdateSettings({ cmdEnterToSend: v })}
                />
              </Row>
              <Row title="启用工具调用" desc="允许 agent 在回答中调用 MCP 工具、查数据、搜网等。">
                <PaperSwitch
                  checked={settings.enableToolCalling}
                  onChange={(v) => onUpdateSettings({ enableToolCalling: v })}
                />
              </Row>
              <Row title="显示 token 统计" desc="每条消息旁边显示用了多少 tokens / 多少钱。">
                <PaperSwitch
                  checked={!!settings.showTokenCost}
                  onChange={(v) => onUpdateSettings({ showTokenCost: v })}
                />
              </Row>
              <Row title="自动朗读" desc="agent 回复后自动念出来。默认关着。">
                <PaperSwitch
                  checked={!!settings.autoTTS}
                  onChange={(v) => onUpdateSettings({ autoTTS: v })}
                />
              </Row>
              <Row
                title="发送前查一下知识 (RAG)"
                desc={
                  <>
                    每句话寄出前先到 Smartnote 里按 <code style={sx.code}>agent:&lt;id&gt;</code> scope 检索相关 memory，
                    拼成前情提要塞进消息顶部。没配 API key / key 连不上会自动跳过。
                  </>
                }
              >
                <PaperSwitch
                  checked={!!settings.ragEnabled}
                  onChange={(v) => onUpdateSettings({ ragEnabled: v })}
                />
              </Row>
              {settings.ragEnabled && (
                <>
                  <Row title="RAG 取几条" desc="每轮取几条最相关的。默认 5。">
                    <select
                      value={settings.ragTopK ?? 5}
                      onChange={(e) => onUpdateSettings({ ragTopK: Number(e.target.value) })}
                      style={{ background: 'transparent', border: 0, borderBottom: '1px solid var(--rule-strong)', padding: '5px 2px', fontFamily: "'Commissioner', sans-serif", fontSize: 14, color: 'var(--ink)', outline: 'none', cursor: 'pointer', minWidth: 100, textAlign: 'right' }}
                    >
                      <option value={3}>3 条</option>
                      <option value={5}>5 条</option>
                      <option value={8}>8 条</option>
                      <option value={12}>12 条</option>
                    </select>
                  </Row>
                  <Row
                    title="检索范围"
                    desc={
                      <>
                        Smartnote 按 API key 隔离 workspace——同一把 key = 同一个人 / 同一组织的共享空间。
                        <br />
                        <b>智能</b>（推荐）：同时查"此 agent"和"整个 workspace"，让检索分数自己选——该私房话时走 agent，该调组织共识时走 workspace，不用手动拨。
                        <br />
                        <b>只此 agent</b>：硬隔离。scope=agent:&lt;id&gt;，别的 agent 存的东西碰不到。
                        <br />
                        <b>整个 workspace</b>：不加过滤，直接全库检索。
                      </>
                    }
                  >
                    <select
                      value={settings.ragScope ?? 'auto'}
                      onChange={(e) => onUpdateSettings({ ragScope: e.target.value as 'auto' | 'agent' | 'workspace' })}
                      style={{ background: 'transparent', border: 0, borderBottom: '1px solid var(--rule-strong)', padding: '5px 2px', fontFamily: "'Commissioner', sans-serif", fontSize: 14, color: 'var(--ink)', outline: 'none', cursor: 'pointer', minWidth: 180, textAlign: 'right' }}
                    >
                      <option value="auto">智能（让 AI 自己选）</option>
                      <option value="agent">只此 agent</option>
                      <option value="workspace">整个 workspace</option>
                    </select>
                  </Row>
                </>
              )}
            </section>

            {/* 06 KNOWLEDGE / SMARTNOTE */}
            <section className="paper-sect" ref={sectRef('knowledge')}>
              <Head n="06" title="知识" cap="Smartnote" />
              <Lead>
                知识 / memory 走 Smartnote Cloud。记忆、偏好、文档都在它那边，chaya 做 UI 和检索。
              </Lead>

              <Row
                title="Base URL"
                desc={
                  <>
                    默认 <code style={sx.code}>https://api.smartnote.cloud</code>。自建可改成
                    {' '}<code style={sx.code}>http://localhost:8000</code>。
                  </>
                }
              >
                <PaperInput
                  mono
                  align="right"
                  type="text"
                  value={snBase}
                  onChange={(e) => setSnBase(e.target.value)}
                  placeholder="https://api.smartnote.cloud"
                  style={{ minWidth: 260 }}
                />
              </Row>

              <Row
                title="API Key"
                desc={
                  <>
                    格式 <code style={sx.code}>sn_live_...</code>。在 Smartnote workspace 里生成。
                    本地只存 localStorage，交换出来的 JWT 接近过期会自动 refresh。
                  </>
                }
              >
                <PaperInput
                  mono
                  align="right"
                  type={snReveal ? 'text' : 'password'}
                  value={snKey}
                  onChange={(e) => setSnKey(e.target.value)}
                  placeholder="sn_live_..."
                  style={{ minWidth: 260 }}
                />
              </Row>

              <Row title="查看 / 隐藏" desc="key 默认隐藏">
                <PaperButton variant="ghost" size="small" onClick={() => setSnReveal((v) => !v)}>
                  {snReveal ? '隐藏' : '看一眼'}
                </PaperButton>
              </Row>

              <Row
                title="连接状态"
                desc={
                  snStatus === 'ok' ? 'health 通了 · token 换到了 · 没问题。'
                    : snStatus === 'down' ? (snErr ? `失败：${snErr}` : '连不上。')
                    : '还没试。按下「测试」看看。'
                }
              >
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{
                    width: 6, height: 6, borderRadius: '50%',
                    background: snStatus === 'ok' ? 'var(--status-success)'
                      : snStatus === 'down' ? 'var(--status-error)' : 'var(--pencil-soft)',
                    display: 'inline-block',
                  }} />
                  <PaperButton variant="ghost" size="small" onClick={handleProbeSmartnote} disabled={snProbing}>
                    {snProbing ? '…' : '测试'}
                  </PaperButton>
                </div>
              </Row>

              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12, gap: 8 }}>
                <PaperButton size="small" onClick={handleSaveSmartnote} disabled={snProbing}>保存 &amp; 测试</PaperButton>
              </div>
            </section>

            {/* 07 DATA */}
            <section className="paper-sect" ref={sectRef('data')}>
              <Head n="07" title="数据" cap="Your Stuff" />
              <Lead>你给它们喂过的所有东西，都还是你的。</Lead>
              <Row title="导出所有对话" desc="打包成一个 .zip，按 agent / 按月份 的 Markdown。">
                <PaperButton variant="link" onClick={exportConversations}>导出</PaperButton>
              </Row>
              <Row title="导出人设 + 记忆" desc="每个 agent 一个 .json。可以在别处重新养一份一样的它。">
                <PaperButton variant="link" onClick={exportPersonas}>导出</PaperButton>
              </Row>
              <div style={{ marginTop: 20 }}>
                <PaperDanger title="清空所有 agent 的记忆">
                  它们还在、还能用，但会忘掉所有关于你的事情。这件事做了就没了。
                  <div style={{ marginTop: 10 }}>
                    <PaperButton variant="link" danger onClick={forgetAllMemory}>我要让它们忘掉</PaperButton>
                  </div>
                </PaperDanger>
              </div>
            </section>

            {/* 08 ABOUT */}
            <section className="paper-sect" ref={sectRef('about')}>
              <Head n="08" title="关于" cap="About" />
              <Lead>Chaya 是一个人写的。</Lead>
              <p style={sx.aboutProse}>
                这是一个 <em style={sx.aboutEm}>我希望自己能用一辈子</em> 的 AI 助手。
                不急着做成 SaaS，没有团队，没有 A 轮。<br /><br />
                如果你觉得它哪里别扭，写信告诉我：
                <a href="mailto:hello@chaya.app" style={sx.aboutMail}>hello@chaya.app</a>
              </p>
              <div style={sx.aboutFoot}>
                <span>© 2026 Chaya Engine</span>
                <span>v1.0.0 · handmade</span>
              </div>
            </section>

            {/* 09 ADVANCED (founder-only) */}
            {isFounder && (
              <section className="paper-sect" ref={sectRef('advanced')}>
                <Head n="09" title="高级" cap="Admin" />
                <Lead>只有你能看到这里。</Lead>

                <Row title="后端地址" desc="Chaya 前端连到哪个后端。">
                  <PaperInput
                    align="right"
                    mono
                    type="text"
                    value={backendUrl}
                    onChange={(e) => setBackendUrl(e.target.value)}
                    style={{ minWidth: 280 }}
                  />
                </Row>
                <Row title="保存后端" desc="改完刷新页面生效。">
                  <PaperButton size="small" onClick={handleSaveBackendUrl}>保存</PaperButton>
                </Row>

                <h3 style={sx.subHead}>会员管理</h3>
                <p style={sx.subHint}>每个租户切换 Free / Pro / Ultra。切了立即生效。</p>
                {membershipLoading && memberships.length === 0 ? (
                  <p style={sx.loadingText}>正在取会员名单…</p>
                ) : memberships.length === 0 ? (
                  <p style={sx.loadingText}>还没有会员。</p>
                ) : (
                  memberships.map((item) => (
                    <Row
                      key={item.user_id}
                      title={item.user_name || item.user_email}
                      desc={<><span>{item.user_email}</span><span style={{ color: 'var(--pencil-soft)', marginLeft: 8 }}>· {item.tenant_name}</span></>}
                    >
                      <div style={{ display: 'flex', gap: 6 }}>
                        {(['free', 'pro', 'ultra'] as TenantPlan[]).map((plan) => (
                          <PaperButton
                            key={plan}
                            variant={item.plan === plan ? 'default' : 'ghost'}
                            size="small"
                            disabled={membershipSavingTenantId === item.tenant_id}
                            onClick={() => void handleMembershipChange(item.tenant_id, plan)}
                          >
                            {plan}
                          </PaperButton>
                        ))}
                      </div>
                    </Row>
                  ))
                )}
              </section>
            )}
          </div>
        </PaperSplit>
      </PaperContent>
    </PaperPage>
  );
};

/* ---------- tiny primitives (local to this page) ---------- */

const Head: React.FC<{ n: string; title: string; cap: string }> = ({ n, title, cap }) => (
  <h2 style={sx.head}>
    <span style={sx.headN}>{n}</span>
    <span style={sx.headTitle}>{title}</span>
    <span style={sx.headCap}>{cap}</span>
  </h2>
);

const Lead: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p style={sx.lead}>{children}</p>
);

const Row: React.FC<{ title: React.ReactNode; desc?: React.ReactNode; children: React.ReactNode }> = ({ title, desc, children }) => (
  <div className="paper-row">
    <div className="lab">
      <div className="lab-title">{title}</div>
      {desc && <div className="lab-desc">{desc}</div>}
    </div>
    <div className="ctrl">{children}</div>
  </div>
);

const FontOpt: React.FC<{
  sel: boolean;
  sample: string;
  sampleStyle?: React.CSSProperties;
  label: string;
  onClick: () => void;
}> = ({ sel, sample, sampleStyle, label, onClick }) => (
  <button
    type="button"
    aria-pressed={sel}
    onClick={onClick}
    style={{ ...sx.fontOpt, ...(sel ? sx.fontOptSel : null) }}
  >
    <span style={{ ...sx.fontRadio, ...(sel ? sx.fontRadioSel : null) }}>
      {sel && <span style={sx.fontRadioDot} />}
    </span>
    <span style={{ ...sx.fontSample, ...(sampleStyle || {}) }}>{sample}</span>
    <span style={sx.fontLabel}>{label}</span>
  </button>
);

const formatRelative = (iso?: string): string => {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '—';
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  return `${months} 个月前`;
};

const sx: Record<string, React.CSSProperties> = {
  head: {
    fontFamily: "'Young Serif', 'LXGW WenKai', ui-serif, serif",
    fontSize: 22, color: 'var(--ink-strong)', fontWeight: 400,
    letterSpacing: '-0.005em',
    display: 'flex', alignItems: 'baseline', gap: 14,
    padding: '0 0 10px', borderBottom: '1px solid var(--rule)',
    margin: 0,
  },
  headN: { fontSize: 16, color: 'var(--accent-ink)', minWidth: 30 },
  headTitle: { fontSize: 22 },
  headCap: {
    fontSize: 11, color: 'var(--pencil)',
    letterSpacing: '0.2em', textTransform: 'uppercase',
    marginLeft: 'auto',
    fontFamily: "'JetBrains Mono', monospace",
    fontWeight: 400,
  },
  lead: {
    marginTop: 8, fontSize: 13, color: 'var(--pencil)',
    lineHeight: 1.7,
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    maxWidth: '56ch',
  },
  fontOpts: { display: 'flex', flexDirection: 'column', gap: 0, marginTop: 16 },
  fontOpt: {
    display: 'grid', gridTemplateColumns: '22px 1fr auto',
    gap: 14, padding: '12px 0',
    borderBottom: '1px dotted var(--rule)',
    alignItems: 'center',
    cursor: 'pointer',
    background: 'transparent', border: 0, borderRadius: 0,
    textAlign: 'left', width: '100%',
    borderBottomStyle: 'dotted', borderBottomColor: 'var(--rule)', borderBottomWidth: 1,
  },
  fontOptSel: {},
  fontRadio: {
    width: 14, height: 14, borderRadius: '50%',
    border: '1.5px solid var(--rule-strong)',
    position: 'relative',
    display: 'block',
  },
  fontRadioSel: { borderColor: 'var(--accent-ink)' },
  fontRadioDot: {
    position: 'absolute', inset: 3,
    background: 'var(--accent-ink)', borderRadius: '50%',
    display: 'block',
  },
  fontSample: {
    fontFamily: "'Young Serif', serif",
    fontSize: 16, color: 'var(--ink-strong)',
    textAlign: 'left',
  },
  fontLabel: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10.5, color: 'var(--pencil)',
    letterSpacing: '0.08em',
  },
  aboutProse: {
    fontFamily: "'Young Serif', serif",
    fontSize: 14.5, lineHeight: 1.8,
    color: 'var(--ink)', maxWidth: '52ch',
    marginTop: 12,
  },
  aboutEm: {
    color: 'var(--accent-ink)', fontStyle: 'italic',
  },
  aboutMail: {
    color: 'var(--accent-ink)',
    borderBottom: '1px solid var(--accent-ink)',
    textDecoration: 'none',
    marginLeft: 4,
  },
  aboutFoot: {
    marginTop: 20, paddingTop: 14,
    borderTop: '1px dotted var(--rule)',
    display: 'flex', justifyContent: 'space-between',
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11, color: 'var(--pencil-soft)',
    letterSpacing: '0.06em',
  },
  subHead: {
    fontFamily: "'Young Serif', serif",
    fontSize: 15, color: 'var(--ink-strong)',
    fontWeight: 500,
    marginTop: 28, marginBottom: 4,
  },
  subHint: {
    fontSize: 12.5, color: 'var(--pencil)',
    marginBottom: 12,
    fontFamily: "'Young Serif', serif", fontStyle: 'italic',
  },
  loadingText: {
    fontSize: 12.5, color: 'var(--pencil)',
    fontFamily: "'Young Serif', serif", fontStyle: 'italic',
  },
};

export default SettingsPage;
