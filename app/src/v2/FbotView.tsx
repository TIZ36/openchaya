/* ============================================================
   FbotView —— 「飞书录入助手」模块，对齐 app 标准骨架：
     · 全局顶栏：状态灯 + 启停（<FbotStatusControl/>，挂 feishu 胶囊旁）
     · 全局左侧栏：分区导航 + 提交列表（<FbotSidebar/>）
     · 主卡：当前分区内容（<FbotView/>，无页眉/无内嵌 tab）
   状态统一由 <FbotProvider> 持有（useFbotStore），三处消费同源。
   业务处理（提交后落库/派发）在 electron/fbot*.cjs。
   ============================================================ */
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  fbot, type FbotConfig, type FbotEvent, type SpecData, type SpecForm, type SpecRoute,
  type SpecMenuOption, type SpecField, type FieldKind, type Submission, type FbotAcl, type AclEntry,
} from './services/fbot';
import { localAgent, permModesFor, permLabel, type ProviderId, type PermMode } from './services/localAgent';
import { canManualDispatch, dispatchSubmission, getDispatch, onDispatchChange, type DispatchState } from './services/fbotDispatch';

const FBOT_PROVIDERS: ProviderId[] = ['claude', 'cursor', 'codex', 'gemini', 'copilot'];
const FBOT_PROVIDER_LABEL: Record<ProviderId, string> = { claude: 'Claude', cursor: 'Cursor', codex: 'Codex', gemini: 'Gemini', copilot: 'Copilot' };
const DISPATCH_LABEL = (ds: DispatchState): string =>
  ds.phase === 'pending' ? '派发中…'
  : ds.phase === 'running' ? `运行中 · ${ds.provider} @ ${ds.cwd}`
  : ds.phase === 'answered' ? (ds.replied ? '已答复回飞书原会话' : '已完成（未回贴）')
  : `失败：${ds.error || ''}`;

type LogLine = { ts: number; text: string; level: 'info' | 'error' };
export type FbotSection = 'inbox' | 'card' | 'acl' | 'conn' | 'guide';

/* ============================================================
   useFbotStore —— 模块全部状态 + 操作（单一持有，供三处消费）。
   ============================================================ */
function useFbotStore() {
  const [sub, setSub] = useState<FbotSection>('card');   // P0 卡片配置默认置顶展示
  const [cfg, setCfg] = useState<FbotConfig | null>(null);
  const [secret, setSecret] = useState('');
  const [testChat, setTestChat] = useState('');
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [spec, setSpec] = useState<SpecData | null>(null);
  const [dirty, setDirty] = useState(false);
  const [subs, setSubs] = useState<Submission[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [acl, setAclState] = useState<FbotAcl | null>(null);
  const [aclDirty, setAclDirty] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const pushLog = (text: string, level: 'info' | 'error' = 'info') =>
    setLogs((l) => [...l.slice(-150), { ts: Date.now(), text, level }]);

  useEffect(() => {
    fbot.getConfig().then((c) => { if (c) { setCfg(c); setTestChat(c.testChatId || ''); } });
    fbot.getSpec().then((s) => { if (s) setSpec(s); });
    fbot.getAcl().then((a) => { if (a) setAclState(a); });
    fbot.listSubmissions().then((a) => setSubs(a || []));
    const off = fbot.onEvent((e: FbotEvent) => {
      if (e.type === 'log') pushLog(e.msg, e.level);
      else if (e.type === 'message') pushLog(`收到消息 [${e.chatType}] "${e.text}"`);
      else if (e.type === 'card_action') pushLog(`卡片动作 ${JSON.stringify(e.value)} ${JSON.stringify(e.formValue || {})}`);
      else if (e.type === 'status') { pushLog(e.running ? `已上线 ${e.botName || ''}` : '已下线'); setCfg((c) => c ? { ...c, running: e.running, botName: e.botName || c.botName } : c); }
      else if (e.type === 'spec') setSpec({ menu: e.menu, forms: e.forms });
      else if (e.type === 'submission') { setSubs((a) => [e.item, ...a]); pushLog(`收到提交：${e.item.formTitle}`); }
    });
    return off;
  }, []);
  useEffect(() => { logRef.current?.scrollTo({ top: 1e9 }); }, [logs]);

  // ---- 连接 ----
  const saveConn = async () => {
    await fbot.setConfig({ appId: cfg?.appId || '', appSecret: secret || undefined, testChatId: testChat });
    setSecret('');
    const c = await fbot.getConfig(); if (c) setCfg(c);
    pushLog('连接配置已保存');
  };
  const toggleRun = async () => {
    setBusy(true);
    try {
      if (cfg?.running) await fbot.stop();
      else { await saveConn(); const r = await fbot.start(); if (!r.ok) pushLog(`启动失败：${r.error}`, 'error'); }
      const c = await fbot.getConfig(); if (c) setCfg(c);
    } finally { setBusy(false); }
  };
  const sendTest = async () => {
    if (!testChat) { pushLog('先填测试群/会话 chat_id', 'error'); return; }
    const r = await fbot.sendCard(testChat, 'menu');
    pushLog(r.ok ? `已发测试菜单卡 → ${testChat}` : `发送失败：${r.error}`, r.ok ? 'info' : 'error');
  };

  // ---- 卡片配置编辑 ----
  const patchMenu = (p: Partial<SpecData['menu']>) => { setSpec((s) => s && ({ ...s, menu: { ...s.menu, ...p } })); setDirty(true); };
  const patchOption = (i: number, p: Partial<SpecMenuOption>) => { setSpec((s) => { if (!s) return s; const o = s.menu.options.slice(); o[i] = { ...o[i], ...p }; return { ...s, menu: { ...s.menu, options: o } }; }); setDirty(true); };
  const addOption = () => { setSpec((s) => s && ({ ...s, menu: { ...s.menu, options: [...s.menu.options, { key: `opt_${Date.now().toString(36)}`, text: '新选项', type: 'default' }] } })); setDirty(true); };
  const patchOptRoute = (i: number, p: Partial<SpecRoute>) => patchOption(i, { route: { kind: 'http', ...(spec?.menu.options[i].route || {}), ...p } });
  const delOption = (i: number) => { setSpec((s) => s && ({ ...s, menu: { ...s.menu, options: s.menu.options.filter((_, j) => j !== i) } })); setDirty(true); };
  const patchForm = (k: string, p: Partial<SpecForm>) => { setSpec((s) => s && ({ ...s, forms: { ...s.forms, [k]: { ...s.forms[k], ...p } } })); setDirty(true); };
  const addForm = () => { const k = `form_${Date.now().toString(36)}`; setSpec((s) => s && ({ ...s, forms: { ...s.forms, [k]: { title: '新表单', submitText: '提交', fields: [] } } })); setDirty(true); };
  const delForm = (k: string) => { setSpec((s) => { if (!s) return s; const f = { ...s.forms }; delete f[k]; return { ...s, forms: f }; }); setDirty(true); };
  const patchField = (fk: string, i: number, p: Partial<SpecField>) => { setSpec((s) => { if (!s) return s; const fs = s.forms[fk].fields.slice(); fs[i] = { ...fs[i], ...p }; return { ...s, forms: { ...s.forms, [fk]: { ...s.forms[fk], fields: fs } } }; }); setDirty(true); };
  const addField = (fk: string) => { setSpec((s) => s && ({ ...s, forms: { ...s.forms, [fk]: { ...s.forms[fk], fields: [...s.forms[fk].fields, { name: `f${Date.now().toString(36)}`, kind: 'input', label: '字段' }] } } })); setDirty(true); };
  const delField = (fk: string, i: number) => { setSpec((s) => s && ({ ...s, forms: { ...s.forms, [fk]: { ...s.forms[fk], fields: s.forms[fk].fields.filter((_, j) => j !== i) } } })); setDirty(true); };
  const saveSpec = async () => { if (!spec) return; const r = await fbot.setSpec(spec); if (r.ok) { setDirty(false); pushLog('卡片配置已保存并热更新'); } else pushLog(`保存失败：${r.error}`, 'error'); };
  const resetSpec = async () => { if (!window.confirm('恢复默认卡片配置？当前编辑会丢失。')) return; const r = await fbot.resetSpec(); if (r.ok && r.menu && r.forms) { setSpec({ menu: r.menu, forms: r.forms }); setDirty(false); pushLog('已恢复默认卡片配置'); } };

  // ---- 表单 → 本地 CLI 路由（#4）----
  const patchRoute = (fk: string, p: Partial<SpecRoute>) =>
    patchForm(fk, { route: { kind: 'agent', sessionMode: 'reuse', trigger: 'manual', provider: 'claude', permMode: 'acceptEdits', ...(spec?.forms[fk].route || {}), ...p } });
  const toggleRoute = (fk: string, on: boolean) =>
    patchForm(fk, { route: on ? { kind: 'agent', sessionMode: 'reuse', trigger: 'manual', provider: 'claude', permMode: 'acceptEdits' } : undefined });
  const pickCwd = async (fk: string) => { const dir = await localAgent.pickFolder(); if (dir) patchRoute(fk, { cwd: dir }); };
  // Prompt 模板：点字段 chip 在光标处插入 {字段名}。
  const tplRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const caretRef = useRef<{ fk: string; pos: number } | null>(null);
  const insertPlaceholder = (fk: string, name: string) => {
    const el = tplRefs.current[fk];
    const token = `{${name}}`;
    const cur = spec?.forms[fk].route?.promptTemplate || '';
    const focused = !!el && document.activeElement === el;
    const start = focused ? el!.selectionStart : cur.length;
    const end = focused ? el!.selectionEnd : cur.length;
    caretRef.current = { fk, pos: start + token.length };
    patchRoute(fk, { promptTemplate: cur.slice(0, start) + token + cur.slice(end) });
  };
  useEffect(() => {
    const c = caretRef.current; if (!c) return; caretRef.current = null;
    const el = tplRefs.current[c.fk]; if (el) { el.focus(); el.setSelectionRange(c.pos, c.pos); }
  });

  // 提交记录：人工派发 + 派发状态订阅。
  const [, bumpDispatch] = useState(0);
  useEffect(() => onDispatchChange(() => bumpDispatch((n) => n + 1)), []);
  const runDispatch = async (s: Submission) => { pushLog(`↗ 派发到会话：${s.formTitle}`); const r = await dispatchSubmission(s, spec?.forms[s.formKey]); pushLog(r.phase === 'error' ? `派发失败：${r.error}` : `已派发 → ${r.provider} @ ${r.cwd}（运行中，完成后答复回飞书）`, r.phase === 'error' ? 'error' : 'info'); };

  // ---- 提问白名单（ACL）----
  const patchAcl = (p: Partial<FbotAcl>) => { setAclState((a) => ({ enabled: false, entries: [], greetTemplate: '', denyMessage: '', ...(a || {}), ...p })); setAclDirty(true); };
  const addAclEntry = () => patchAcl({ entries: [...(acl?.entries || []), { openId: '', name: '' }] });
  const patchAclEntry = (i: number, p: Partial<AclEntry>) => { const es = (acl?.entries || []).slice(); es[i] = { ...es[i], ...p }; patchAcl({ entries: es }); };
  const delAclEntry = (i: number) => patchAcl({ entries: (acl?.entries || []).filter((_, j) => j !== i) });
  const saveAcl = async () => { if (!acl) return; const r = await fbot.setAcl(acl); if (r.ok) { setAclDirty(false); pushLog('提问白名单已保存'); } else pushLog(`白名单保存失败：${r.error}`, 'error'); };
  const addToWhitelist = (openId?: string, name?: string | null) => { if (!openId) return; patchAcl({ enabled: true, entries: [...(acl?.entries || []).filter((e) => e.openId !== openId), { openId, name: name || '' }] }); setSub('acl'); };

  const formKeys = spec ? Object.keys(spec.forms) : [];
  const selSub = useMemo(() => subs.find((s) => s.id === sel) || null, [subs, sel]);

  // 提交人 open_id → 姓名（白名单优先，再 best-effort 通讯录）。缓存。
  const [names, setNames] = useState<Record<string, string>>({});
  const resolvingRef = useRef<Set<string>>(new Set());
  const nameOf = (s: Submission): string | null => s.userName || (s.operator?.open_id ? names[String(s.operator.open_id)] : null) || null;
  useEffect(() => {
    const ids = Array.from(new Set(subs.map((s) => s.operator?.open_id).filter(Boolean) as string[]));
    ids.forEach((id) => {
      if (names[id] || resolvingRef.current.has(id)) return;
      resolvingRef.current.add(id);
      void fbot.resolveUser(id).then((r) => { if (r?.name) setNames((n) => ({ ...n, [id]: r.name as string })); });
    });
  }, [subs, acl]);   // eslint-disable-line react-hooks/exhaustive-deps

  return {
    sub, setSub, cfg, setCfg, secret, setSecret, testChat, setTestChat, busy, logs, setLogs, pushLog, logRef,
    spec, setSpec, dirty, subs, setSubs, sel, setSel, acl, aclDirty,
    saveConn, toggleRun, sendTest,
    patchMenu, patchOption, addOption, patchOptRoute, delOption, patchForm, addForm, delForm, patchField, addField, delField, saveSpec, resetSpec,
    patchRoute, toggleRoute, pickCwd, tplRefs, insertPlaceholder, runDispatch,
    patchAcl, addAclEntry, patchAclEntry, delAclEntry, saveAcl, addToWhitelist,
    formKeys, selSub, names, nameOf,
  };
}

type FbotStore = ReturnType<typeof useFbotStore>;
const FbotCtx = createContext<FbotStore | null>(null);
export const FbotProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const store = useFbotStore();
  return <FbotCtx.Provider value={store}>{children}</FbotCtx.Provider>;
};
function useFbot(): FbotStore { const c = useContext(FbotCtx); if (!c) throw new Error('useFbot 必须在 <FbotProvider> 内'); return c; }

/* ============================================================
   顶栏：状态灯 + 启停（挂 feishu 胶囊旁）
   ============================================================ */
export const FbotStatusControl: React.FC = () => {
  const { cfg, busy, toggleRun } = useFbot();
  return (
    <div className={`fbot-statusctl${cfg?.running ? ' on' : ''}`}>
      <span className="fbot-dot" />
      <span className="lab">{cfg?.running ? (cfg.botName || '在线') : '离线'}</span>
      <button className="fbot-statusctl-btn" disabled={busy} onClick={toggleRun}>{cfg?.running ? '停止' : '启动'}</button>
    </div>
  );
};

/* ============================================================
   左侧栏：分区导航 + 提交列表
   ============================================================ */
const I_INBOX = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M9 10v10" /></svg>;
const I_SHIELD = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d="M12 3l7 3v5c0 4-3 7-7 8-4-1-7-4-7-8V6z" /></svg>;
const I_ACT = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-4l-3 8L9 4l-3 8H2" /></svg>;
const I_BOOK = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19V5a2 2 0 0 1 2-2h13v14H6a2 2 0 0 0-2 2 2 2 0 0 0 2 2h13" /></svg>;

export const FbotSidebar: React.FC = () => {
  const { sub, setSub, subs, acl, aclDirty, dirty } = useFbot();
  const nav: Array<{ k: FbotSection; label: string; icon: React.ReactNode; n?: number | null; dot?: boolean }> = [
    { k: 'inbox', label: '提交记录 · 运维台', icon: I_INBOX, n: subs.length || null },
    { k: 'acl', label: '提问权限', icon: I_SHIELD, n: acl?.enabled ? acl.entries.length : null, dot: aclDirty },
    { k: 'conn', label: '连接 · 日志', icon: I_ACT },
    { k: 'guide', label: '上手指引', icon: I_BOOK },
  ];
  return (
    <>
      <div className="fbot-side-head"><FbotStatusControl /></div>
      {/* P0：卡片配置置顶、突出 —— 桌面端搭飞书能力卡片的核心 */}
      <button className={`fbot-hero${sub === 'card' ? ' on' : ''}`} onClick={() => setSub('card')}>
        <svg className="fbot-hero-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M7 13h7M7 16.5h4" /></svg>
        <span className="fbot-hero-t"><span className="t">卡片配置</span><span className="s">搭建飞书能力卡片 · 核心</span></span>
        {dirty && <span className="fbot-navrow-dot" aria-label="未保存" />}
        <span className="fbot-hero-arr">›</span>
      </button>
      <div className="v2-sec"><span>功能</span></div>
      <div className="fbot-nav2">
        {nav.map((it) => (
          <button key={it.k} className={`fbot-nxrow${sub === it.k ? ' active' : ''}`} onClick={() => setSub(it.k)}>
            <span className="fbot-nxi">{it.icon}</span>
            <span className="nm">{it.label}</span>
            {it.n ? <span className="fbot-navrow-n">{it.n}</span> : null}
            {it.dot ? <span className="fbot-navrow-dot" aria-label="未保存" /> : null}
          </button>
        ))}
      </div>
    </>
  );
};

/* ============================================================
   主卡：当前分区内容（无页眉/无 tab）
   ============================================================ */
const FbotView: React.FC = () => {
  const s = useFbot();
  const {
    sub, setSub, cfg, setCfg, secret, setSecret, testChat, setTestChat, logs, setLogs, logRef,
    spec, dirty, subs, setSubs, sel, setSel, acl, aclDirty,
    saveConn, sendTest, toggleRun,
    patchMenu, patchOption, addOption, patchOptRoute, delOption, patchForm, addForm, delForm, patchField, addField, delField, saveSpec, resetSpec,
    toggleRoute, pickCwd, patchRoute, tplRefs, insertPlaceholder, runDispatch,
    patchAcl, addAclEntry, patchAclEntry, delAclEntry, saveAcl, addToWhitelist,
    formKeys, nameOf,
  } = s;

  // 运维台单行展开的详情（状态 / 字段 / 答复 / 派发）
  const detailOf = (selSub: Submission) => {
    const sForm = spec?.forms[selSub.formKey];
    const ds = getDispatch(selSub.id);
    return (
      <>
        <div className="fbot-detail-hd">{selSub.formTitle}<span className="fbot-key">{selSub.formKey}</span>
          {canManualDispatch(sForm) && (
            <button className="v2-set-btn sm primary fbot-detail-dispatch" onClick={() => runDispatch(selSub)} disabled={ds?.phase === 'pending' || ds?.phase === 'running'}>
              {ds?.phase === 'answered' || ds?.phase === 'error' ? '重新派发' : ds?.phase === 'running' ? '运行中…' : '派发到会话'}
            </button>
          )}
        </div>
        <div className="fbot-detail-meta">
          {nameOf(selSub) && <><b>{nameOf(selSub)}</b> · </>}
          {selSub.operator?.open_id && (() => {
            const oid = String(selSub.operator.open_id);
            const known = acl?.entries.some((e) => e.openId === oid);
            return <><code>{oid}</code>{!known && <button className="fbot-acl-add" onClick={() => addToWhitelist(oid, nameOf(selSub))}>加入白名单{nameOf(selSub) ? '' : '（填姓名）'}</button>}{known && <span className="fbot-ok">在名单</span>}</>;
          })()}
          {ds && <> · <span className={`fbot-dstat ${ds.phase}`}>{DISPATCH_LABEL(ds)}</span></>}
        </div>
        <table className="fbot-detail-table"><tbody>
          {Object.entries(selSub.values).map(([k, v]) => (
            <tr key={k}><th>{k}</th><td>{String(v) || <span className="muted">(空)</span>}</td></tr>
          ))}
        </tbody></table>
        {ds && (ds.transcript || ds.answer) && (
          <div className={`fbot-run${ds.phase === 'running' ? ' live' : ''}`}>
            <div className="fbot-run-hd">
              {ds.phase === 'running' ? (ds.streaming ? '运行中 · 流式刷入飞书卡片' : '会话运行中（实时）') : ds.phase === 'answered' ? (ds.replied ? '已答复回飞书原会话' : '已完成（未回贴）') : '结果'}
              <span className="fbot-run-loc">{ds.provider} @ {ds.cwd}</span>
            </div>
            <pre className="fbot-run-body">{ds.answer || ds.transcript}</pre>
          </div>
        )}
      </>
    );
  };
  const opsPill = (sb: Submission) => {
    const ds = getDispatch(sb.id);
    if (ds?.phase === 'running' || ds?.phase === 'pending') return { c: 'run', t: '运行中' };
    if (ds?.phase === 'answered') return { c: 'ok', t: '已答复' };
    if (ds?.phase === 'error') return { c: 'err', t: '失败' };
    return { c: '', t: '已收到' };
  };

  // 卡片配置：master-detail 选中项（'menu' / 'opt:<i>' / 'form:<fk>'）
  const [ccSel, setCcSel] = useState<string>('menu');

  // 右侧详情：菜单选项编辑（含 Grafana 配置）
  const optDetail = (opt: SpecMenuOption, i: number) => {
    const behavior = opt.route?.kind === 'http' ? 'http:grafana' : opt.form ? `form:${opt.form}` : opt.action ? `action:${opt.action}` : '';
    return (
      <>
        <div className="fbot-cc-dhd">编辑选项<button className="v2-set-btn sm danger" onClick={() => { delOption(i); setCcSel('menu'); }}>删除选项</button></div>
        <div className="fbot-cc-grid">
          <div className="fbot-field"><span className="lab">按钮文字</span><input value={opt.text} onChange={(e) => patchOption(i, { text: e.target.value })} placeholder="按钮文字" /></div>
          <div className="fbot-field"><span className="lab">按钮类型</span>
            <select value={opt.type || 'default'} onChange={(e) => patchOption(i, { type: e.target.value as any })}><option value="primary">主</option><option value="default">次</option><option value="danger">危险</option></select></div>
          <div className="fbot-field"><span className="lab">行为</span>
            <select value={behavior} onChange={(e) => { const v = e.target.value;
              if (v.startsWith('form:')) patchOption(i, { form: v.slice(5), action: undefined, route: undefined });
              else if (v === 'http:grafana') patchOption(i, { route: { kind: 'http', buttonText: '在 Grafana 打开完整看板 ↗' }, form: undefined, action: undefined });
              else if (v.startsWith('action:')) patchOption(i, { action: v.slice(7), form: undefined, route: undefined });
              else patchOption(i, { form: undefined, action: undefined, route: undefined }); }}>
              <option value="">行为…</option>
              {formKeys.map((fk) => <option key={fk} value={`form:${fk}`}>弹表单：{spec!.forms[fk].title}</option>)}
              <option value="http:grafana">动作：Grafana 报表</option>
              <option value="action:query">动作：查询(代码)</option>
            </select></div>
        </div>
        {opt.form && <div className="fbot-cc-jump">该选项弹出表单 <button className="v2-set-btn sm" onClick={() => setCcSel(`form:${opt.form}`)}>编辑「{spec!.forms[opt.form!]?.title || opt.form}」 →</button></div>}
        {opt.route?.kind === 'http' && (
          <div className="fbot-route on" style={{ marginTop: 14 }}><div className="fbot-route-body">
            <div className="fbot-field"><span className="lab">看板链接（Grafana dashboard URL，点选项跳转用）</span>
              <input value={opt.route.linkUrl || ''} onChange={(e) => patchOptRoute(i, { linkUrl: e.target.value })} placeholder="https://monitor.…/d/<uid>/<slug>?orgId=3&…" /></div>
            <div className="fbot-field"><span className="lab">Service account token（Bearer，存本机不入库）</span>
              <input type="password" value={opt.route.token || ''} onChange={(e) => patchOptRoute(i, { token: e.target.value })} placeholder="glsa_…" /></div>
            <div className="fbot-route-opts">
              <label><span className="lab">按钮文案</span><input value={opt.route.buttonText || ''} onChange={(e) => patchOptRoute(i, { buttonText: e.target.value })} placeholder="在 Grafana 打开完整看板 ↗" /></label>
              <label><span className="lab">图宽 px</span><input value={opt.route.width || ''} onChange={(e) => patchOptRoute(i, { width: Number(e.target.value) || undefined })} placeholder="1200" /></label>
              <label><span className="lab">图高 px</span><input value={opt.route.height || ''} onChange={(e) => patchOptRoute(i, { height: Number(e.target.value) || undefined })} placeholder="800" /></label>
            </div>
            <div className="fbot-field" style={{ marginBottom: 0 }}><span className="lab">渲染地址（可选；留空自动 /d/→/render/d/ 推导）</span>
              <input value={opt.route.renderUrl || ''} onChange={(e) => patchOptRoute(i, { renderUrl: e.target.value })} placeholder="留空即可（需 Grafana image-renderer 插件出图）" /></div>
          </div></div>
        )}
      </>
    );
  };

  // 右侧详情：表单编辑（字段 + 派发）
  const formDetail = (fk: string) => {
    const form = spec!.forms[fk]; if (!form) return null;
    const route = form.route; const on = route?.kind === 'agent';
    return (
      <>
        <div className="fbot-cc-dhd">编辑表单 <span className="fbot-key">{fk}</span><button className="v2-set-btn sm danger" onClick={() => { delForm(fk); setCcSel('menu'); }}>删除表单</button></div>
        <div className="fbot-cc-grid">
          <div className="fbot-field"><span className="lab">表单标题</span><input value={form.title} onChange={(e) => patchForm(fk, { title: e.target.value })} placeholder="表单标题" /></div>
          <div className="fbot-field"><span className="lab">提交按钮文案</span><input value={form.submitText || ''} onChange={(e) => patchForm(fk, { submitText: e.target.value })} placeholder="提交" /></div>
        </div>
        <div className="fbot-sec">字段 <button className="v2-set-btn sm" onClick={() => addField(fk)}>＋ 字段</button></div>
        {form.fields.map((field, fi) => (
          <div key={fi} className="fbot-card-row">
            <input style={{ width: 110 }} value={field.name} onChange={(e) => patchField(fk, fi, { name: e.target.value })} placeholder="字段名" />
            <input className="grow" value={field.label} onChange={(e) => patchField(fk, fi, { label: e.target.value })} placeholder="显示标签" />
            <select value={field.kind} onChange={(e) => patchField(fk, fi, { kind: e.target.value as FieldKind })}><option value="input">单行</option><option value="multiline">多行</option><option value="select">下拉</option></select>
            {field.kind === 'select' && (
              <input style={{ width: 180 }} value={(field.options || []).map(([v, l]) => v === l ? v : `${v}:${l}`).join(',')}
                onChange={(e) => patchField(fk, fi, { options: e.target.value.split(',').map((str) => { const [v, l] = str.split(':'); return [v?.trim() || '', (l || v || '').trim()] as [string, string]; }).filter(([v]) => v) })} placeholder="选项 a,b,c 或 值:标签" />
            )}
            <label className="fbot-req"><input type="checkbox" checked={!!field.required} onChange={(e) => patchField(fk, fi, { required: e.target.checked })} />必填</label>
            <button className="v2-set-btn sm danger" onClick={() => delField(fk, fi)}>×</button>
          </div>
        ))}
        <div className={`fbot-route${on ? ' on' : ''}`} style={{ marginTop: 14 }}>
          <label className="fbot-route-toggle"><input type="checkbox" checked={on} onChange={(e) => toggleRoute(fk, e.target.checked)} /> 提交后派发到本地 CLI 会话（提单 → 自动改代码 / 回答）</label>
          {on && route && (
            <div className="fbot-route-body">
              <div className="fbot-field"><span className="lab">关联工作目录</span>
                <div className="fbot-cwd"><input readOnly value={route.cwd || ''} placeholder="选择项目目录（同本地 CLI）…" onClick={() => pickCwd(fk)} /><button className="v2-set-btn sm" onClick={() => pickCwd(fk)}>选择</button></div></div>
              {(() => { const isAnswer = route.intent === 'answer'; return (<>
                <div className="fbot-route-opts">
                  <label><span className="lab">用途</span><select value={route.intent || 'change'} onChange={(e) => { const v = e.target.value as 'answer' | 'change'; patchRoute(fk, v === 'answer' ? { intent: 'answer', permMode: 'plan' } : { intent: 'change', permMode: 'acceptEdits' }); }}><option value="answer">问答（只读，回答问题）</option><option value="change">改代码（提单→自动改）</option></select></label>
                  <label><span className="lab">Provider</span><select value={route.provider || 'claude'} onChange={(e) => patchRoute(fk, { provider: e.target.value as ProviderId })}>{FBOT_PROVIDERS.map((p) => <option key={p} value={p}>{FBOT_PROVIDER_LABEL[p]}</option>)}</select></label>
                  <label><span className="lab">权限档{isAnswer ? '（问答锁只读）' : ''}</span><select value={isAnswer ? 'plan' : (route.permMode || 'acceptEdits')} disabled={isAnswer} onChange={(e) => patchRoute(fk, { permMode: e.target.value as PermMode })}>{permModesFor((route.provider || 'claude') as ProviderId).map((m) => <option key={m} value={m}>{permLabel((route.provider || 'claude') as ProviderId, m)}</option>)}</select></label>
                  <label><span className="lab">会话</span><select value={route.sessionMode || 'reuse'} onChange={(e) => patchRoute(fk, { sessionMode: e.target.value as 'reuse' | 'fresh' })}><option value="reuse">复用（每目录一条）</option><option value="fresh">每次新建</option></select></label>
                  <label><span className="lab">触发</span><select value={route.trigger || 'manual'} onChange={(e) => patchRoute(fk, { trigger: e.target.value as 'auto' | 'manual' })}><option value="manual">手动派发</option><option value="auto">提交即自动</option></select></label>
                </div>
                <div className="fbot-field" style={{ marginBottom: 0 }}><span className="lab">Prompt 模板（留空按「用途」自动拼）</span>
                  {form.fields.length > 0 && (
                    <div className="fbot-ph-chips"><span className="fbot-ph-hint">点字段插入占位：</span>
                      {form.fields.map((f) => { const ph = f.label || f.name; return (<button key={f.name} type="button" className="fbot-ph-chip" title={`插入 {${ph}}`} onClick={() => insertPlaceholder(fk, ph)}>{f.label || f.name}<code>{`{${ph}}`}</code></button>); })}
                    </div>
                  )}
                  <textarea ref={(el) => { tplRefs.current[fk] = el; }} rows={3} value={route.promptTemplate || ''} onChange={(e) => patchRoute(fk, { promptTemplate: e.target.value })} placeholder={isAnswer ? '例：请只读调研并回答下面的问题，不要改代码。问题：（点上方字段插入）' : '例：用户提单（点上方字段插入对应内容），请在本目录完成对应改动。'} /></div>
              </>); })()}
            </div>
          )}
        </div>
      </>
    );
  };

  return (
    <div className="v2-feat"><div className="v2-feat-main">
      <div className="fbot">
        <div className="fbot-body">
          {sub === 'guide' && (() => {
            const hasCreds = !!cfg?.appId && !!cfg?.hasSecret;
            const online = !!cfg?.running;
            const hasRoute = !!spec && Object.values(spec.forms).some((f) => f.route?.kind === 'agent' && f.route?.cwd);
            const step = (done: boolean, n: number) => <span className={`fbot-step-n${done ? ' done' : ''}`}>{done ? '✓' : n}</span>;
            return (
              <div className="fbot-pane fbot-guide">
                <p className="fbot-hint">第一次配置按下面 5 步走一遍即可。每步右边的「去配置」会跳到对应页。飞书后台那步只需做一次。</p>
                <div className="fbot-step">
                  {step(false, 1)}
                  <div className="fbot-step-body">
                    <div className="fbot-step-hd">在飞书开放平台建「自建应用」并开权限<a className="fbot-step-link" href={cfg?.appId ? `https://open.feishu.cn/app/${cfg.appId}/auth` : 'https://open.feishu.cn/app'} target="_blank" rel="noreferrer">打开权限页 ↗</a></div>
                    <div className="fbot-step-desc">
                      权限管理里开启：<code>im:message</code>（发消息）、<code>im:message.p2p_msg:readonly</code>（收私聊）、<code>im:message.group_at_msg:readonly</code>（收群 @）、<code>im:resource</code>（上传图片，Grafana 出图必需）、<code>contact:user.base:readonly</code>（按 open_id 查姓名，可选）。<br />
                      {cfg?.appId && <>一键开通：
                        <a className="fbot-step-link" style={{ marginLeft: 0 }} href={`https://open.feishu.cn/app/${cfg.appId}/auth?q=im:resource&op_from=openapi&token_type=tenant`} target="_blank" rel="noreferrer">上传图片权限 ↗</a>
                        <a className="fbot-step-link" style={{ marginLeft: 8 }} href={`https://open.feishu.cn/app/${cfg.appId}/auth?q=contact:user.base:readonly&op_from=openapi&token_type=tenant`} target="_blank" rel="noreferrer">查姓名权限 ↗</a><br /></>}
                      事件订阅方式选 <b>长连接</b>，订阅 <code>im.message.receive_v1</code>、<code>card.action.trigger</code>。<br />
                      <b>改完必须「创建版本 / 发布」</b>（企业自建可能需管理员审批）才生效。
                    </div>
                  </div>
                </div>
                <div className="fbot-step">
                  {step(hasCreds, 2)}
                  <div className="fbot-step-body">
                    <div className="fbot-step-hd">填 App ID / App Secret<button className="fbot-step-go" onClick={() => setSub('conn')}>去配置 →</button></div>
                    <div className="fbot-step-desc">在「连接 · 日志」页填后台「凭证与基础信息」里的 App ID / Secret，点保存。{hasCreds ? <span className="fbot-ok">已填写</span> : null}</div>
                  </div>
                </div>
                <div className="fbot-step">
                  {step(online, 3)}
                  <div className="fbot-step-body">
                    <div className="fbot-step-hd">启动长连接（顶栏的启动按钮）<button className="fbot-step-go" onClick={() => setSub('conn')}>去连接 →</button></div>
                    <div className="fbot-step-desc">顶栏点启动，状态变 <b>在线</b> 即长连接成功（机器人随 App 在线，关掉 Chaya 就下线）。{online ? <span className="fbot-ok">在线 {cfg?.botName || ''}</span> : <span className="fbot-warn">当前离线</span>}</div>
                  </div>
                </div>
                <div className="fbot-step">
                  {step(hasRoute, 4)}
                  <div className="fbot-step-body">
                    <div className="fbot-step-hd">配卡片 + 把表单接到本地 CLI<button className="fbot-step-go" onClick={() => setSub('card')}>去配置 →</button></div>
                    <div className="fbot-step-desc">「卡片配置」里编菜单/表单；每个表单底部开「派发到本地 CLI 会话」，选工作目录 + 触发方式 = 提单自动改代码 / 回答问题。{hasRoute ? <span className="fbot-ok">已接 1+ 个表单</span> : null}</div>
                  </div>
                </div>
                <div className="fbot-step">
                  {step(!!acl?.enabled, 5)}
                  <div className="fbot-step-body">
                    <div className="fbot-step-hd">（可选）开提问白名单<button className="fbot-step-go" onClick={() => setSub('acl')}>去配置 →</button></div>
                    <div className="fbot-step-desc">只允许名单内的人提问：在「提问权限」开开关、把提交人 open_id（提交记录详情里能看到 <code>ou_…</code>）+ 姓名加进名单。命中先寒暄，未命中婉拒。{acl?.enabled ? <span className="fbot-ok">已开启 · {acl.entries.length} 人</span> : null}</div>
                  </div>
                </div>
                <div className="fbot-step">
                  {step(false, 6)}
                  <div className="fbot-step-body">
                    <div className="fbot-step-hd">测一下<button className="fbot-step-go" onClick={() => setSub('conn')}>去测试 →</button></div>
                    <div className="fbot-step-desc">「连接 · 日志」里填测试群/会话 chat_id 点「发测试卡片」，或直接在飞书里 <b>@机器人</b> → 选项 → 填表单 → 提交。处理流在「提交记录」详情里实时看，结果会回贴到原会话。</div>
                  </div>
                </div>
              </div>
            );
          })()}

          {sub === 'conn' && (
            <div className="fbot-pane">
              <p className="fbot-hint">飞书自建应用凭证；长连接随 App 在线（启停在顶栏）。改后台权限/事件后需重新「发布版本」。</p>
              <div className="fbot-field"><span className="lab">App ID</span>
                <input value={cfg?.appId || ''} onChange={(e) => setCfg((c) => c ? { ...c, appId: e.target.value } : c)} placeholder="cli_xxx" /></div>
              <div className="fbot-field"><span className="lab">App Secret</span>
                <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={cfg?.hasSecret ? '已配置（留空不改）' : '应用密钥'} /></div>
              <div className="fbot-field"><span className="lab">测试群 / 会话 chat_id</span>
                <input value={testChat} onChange={(e) => setTestChat(e.target.value)} placeholder="oc_xxx（用于「发测试卡片」）" /></div>
              <div className="fbot-actions">
                <button className="v2-set-btn" onClick={saveConn}>保存连接</button>
                <button className="v2-set-btn" onClick={toggleRun}>{cfg?.running ? '停止运行' : '启动'}</button>
                <button className="v2-set-btn" onClick={sendTest} disabled={!cfg?.running}>发测试卡片</button>
              </div>
              <div className="fbot-sec">运行日志 <button className="v2-set-btn sm" onClick={() => setLogs([])}>清空</button></div>
              <div ref={logRef} className="fbot-log lg">
                {logs.length === 0 && <div className="v2-set-empty">暂无事件。启动后 @机器人 试试。</div>}
                {logs.map((l, i) => (
                  <div key={i} className={`fbot-log-line${l.level === 'error' ? ' err' : ''}`}>
                    <span className="ts">{new Date(l.ts).toLocaleTimeString()}</span> {l.text}
                  </div>
                ))}
              </div>
            </div>
          )}

          {sub === 'card' && (
            <div className="fbot-pane fbot-cardcfg">
              <div className="fbot-pane-hd">
                <p className="fbot-hint">左侧选条目、右侧编辑；保存即热更新到 bot。业务处理（落库等）在 fbotMenu.cjs。</p>
                <div className="fbot-actions inline">
                  <button className="v2-set-btn" onClick={resetSpec}>恢复默认</button>
                  <button className="v2-set-btn primary" onClick={saveSpec} disabled={!dirty}>{dirty ? '保存配置' : '已保存'}</button>
                </div>
              </div>
              {!spec && <div className="v2-set-empty">加载中…</div>}
              {spec && (
                <div className="fbot-cc">
                  {/* master：菜单 + 能力 + 表单 列表 */}
                  <div className="fbot-cc-list">
                    <button className={`fbot-cc-item${ccSel === 'menu' ? ' on' : ''}`} onClick={() => setCcSel('menu')}>
                      <span className="nm">菜单外观</span><span className="tg">标题 · 引导语</span>
                    </button>
                    <div className="fbot-sec">能力 <button className="v2-set-btn sm" onClick={() => { addOption(); setCcSel(`opt:${spec.menu.options.length}`); }}>＋</button></div>
                    {spec.menu.options.map((opt, i) => {
                      const tag = opt.route?.kind === 'http' ? 'Grafana' : opt.form ? '表单' : opt.action ? '动作' : '—';
                      return (
                        <button key={i} className={`fbot-cc-item${ccSel === `opt:${i}` ? ' on' : ''}`} onClick={() => setCcSel(`opt:${i}`)}>
                          <span className="nm">{opt.text || '(未命名选项)'}</span><span className={`tg${tag === 'Grafana' ? ' graf' : opt.form ? ' form' : ''}`}>{tag}</span>
                        </button>
                      );
                    })}
                    <div className="fbot-sec mt">表单 <button className="v2-set-btn sm" onClick={addForm}>＋</button></div>
                    {formKeys.length === 0 && <div className="v2-side-hint" style={{ padding: '4px 10px' }}>无表单</div>}
                    {formKeys.map((fk) => (
                      <button key={fk} className={`fbot-cc-item${ccSel === `form:${fk}` ? ' on' : ''}`} onClick={() => setCcSel(`form:${fk}`)}>
                        <span className="nm">{spec.forms[fk].title || fk}</span><span className="tg key">{fk}</span>
                      </button>
                    ))}
                  </div>
                  {/* detail：选中项编辑 */}
                  <div className="fbot-cc-detail">
                    {ccSel === 'menu' && (<>
                      <div className="fbot-cc-dhd">菜单外观</div>
                      <div className="fbot-field"><span className="lab">菜单标题</span><input value={spec.menu.title} onChange={(e) => patchMenu({ title: e.target.value })} /></div>
                      <div className="fbot-field"><span className="lab">菜单引导语（支持 markdown，@机器人后弹出）</span><input value={spec.menu.intro || ''} onChange={(e) => patchMenu({ intro: e.target.value })} /></div>
                    </>)}
                    {ccSel.startsWith('opt:') && (spec.menu.options[Number(ccSel.slice(4))]
                      ? optDetail(spec.menu.options[Number(ccSel.slice(4))], Number(ccSel.slice(4)))
                      : <div className="v2-set-empty fbot-center">选项已删除，左侧选一项。</div>)}
                    {ccSel.startsWith('form:') && (spec.forms[ccSel.slice(5)]
                      ? formDetail(ccSel.slice(5))
                      : <div className="v2-set-empty fbot-center">表单已删除，左侧选一项。</div>)}
                  </div>
                </div>
              )}
            </div>
          )}

          {sub === 'acl' && (
            <div className="fbot-pane">
              <div className="fbot-pane-hd">
                <p className="fbot-hint">开启后，只有名单内的人能提问。飞书没有可靠的「open_id → 姓名」接口，所以名单直接存「open_id + 姓名」：提交人 <code>ou_…</code> 在「提交记录」详情里能看到，复制过来 + 填姓名即可（命中先寒暄「好的，姓名，我这就去帮你查询…」；未命中婉拒）。</p>
                <div className="fbot-actions inline">
                  <button className="v2-set-btn primary" onClick={saveAcl} disabled={!aclDirty}>{aclDirty ? '保存白名单' : '已保存'}</button>
                </div>
              </div>
              <label className="fbot-route-toggle" style={{ marginBottom: 16 }}>
                <input type="checkbox" checked={!!acl?.enabled} onChange={(e) => patchAcl({ enabled: e.target.checked })} />
                启用提问白名单（关闭=所有人可提问）
              </label>
              <div className="fbot-sec">名单 <button className="v2-set-btn sm" onClick={addAclEntry}>＋ 添加</button></div>
              {(!acl || acl.entries.length === 0) && <div className="v2-set-empty">名单为空。点「＋ 添加」或在「提交记录」详情点「加入白名单」。</div>}
              {acl?.entries.map((en, i) => (
                <div key={i} className="fbot-card-row">
                  <input className="grow" value={en.openId} onChange={(e) => patchAclEntry(i, { openId: e.target.value })} placeholder="open_id（ou_…）" />
                  <input style={{ width: 140 }} value={en.name} onChange={(e) => patchAclEntry(i, { name: e.target.value })} placeholder="姓名（寒暄用）" />
                  <button className="v2-set-btn sm danger" onClick={() => delAclEntry(i)}>删</button>
                </div>
              ))}
              <div className="fbot-sec mt">话术（可选）</div>
              <div className="fbot-field"><span className="lab">寒暄语（命中名单）· 占位 {`{name}`} / {`{question}`}</span>
                <input value={acl?.greetTemplate || ''} onChange={(e) => patchAcl({ greetTemplate: e.target.value })} placeholder="好的，「{name}」，我这就去帮你查询问题：「{question}」" /></div>
              <div className="fbot-field"><span className="lab">婉拒语（不在名单）</span>
                <input value={acl?.denyMessage || ''} onChange={(e) => patchAcl({ denyMessage: e.target.value })} placeholder="不好意思，你需要先开通提问权限。" /></div>
            </div>
          )}

          {sub === 'inbox' && (
            <div className="fbot-pane fbot-ops">
              <div className="fbot-pane-hd">
                <div className="fbot-ops-title">提交记录 · 运维台</div>
                <div className="fbot-actions inline">
                  <button className="v2-set-btn sm" onClick={() => fbot.listSubmissions().then((a) => setSubs(a || []))}>刷新</button>
                  <button className="v2-set-btn sm danger" onClick={async () => { if (window.confirm('清空全部提交记录？')) { await fbot.clearSubmissions(); setSubs([]); setSel(null); } }}>清空</button>
                </div>
              </div>
              {subs.length === 0 ? (
                <div className="v2-set-empty fbot-center">还没有提交。@机器人 → 选项 → 填表单 → 提交，这里就会出现。</div>
              ) : (
                <table className="fbot-ops-table">
                  <thead><tr><th>提交人</th><th>表单 / 提问</th><th>状态</th><th>时间</th></tr></thead>
                  <tbody>
                    {subs.map((sb) => {
                      const pill = opsPill(sb);
                      const prev = Object.values(sb.values).find((v) => v && String(v).trim()) || '';
                      const open = sel === sb.id;
                      const oid = String(sb.operator?.open_id || '');
                      return (
                        <React.Fragment key={sb.id}>
                          <tr className={`fbot-ops-row${open ? ' open' : ''}`} onClick={() => setSel(open ? null : sb.id)}>
                            <td>{nameOf(sb) || <span className="muted">{oid ? oid.slice(0, 8) + '…' : '—'}</span>}</td>
                            <td><b>{sb.formTitle}</b>{prev ? <span className="fbot-ops-prev"> · {String(prev)}</span> : null}</td>
                            <td><span className={`fbot-pill ${pill.c}`}>{pill.t}</span></td>
                            <td className="fbot-ops-time">{new Date(sb.ts).toLocaleString()}</td>
                          </tr>
                          {open && (
                            <tr className="fbot-ops-expand"><td colSpan={4}><div className="fbot-ops-inner">{detailOf(sb)}</div></td></tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      </div>
    </div></div>
  );
};

export default FbotView;
