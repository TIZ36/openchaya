/* ============================================================
   FbotView —— 「飞书录入助手」一级视图（左栏入口，仅桌面版）

   布局：左侧子导航（连接·日志 / 卡片配置 / 提交记录）+ 右侧内容区。
     · 连接   —— appId/secret/测试chat + 启停 + 状态灯 + 实时日志
     · 卡片   —— 可视化编辑能力菜单 + 表单，保存即热更新
     · 提交   —— 收集每次表单提交，列表 + 详情查看

   业务处理（提交后落库）在 electron/fbotMenu.cjs 代码里。
   ============================================================ */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  fbot, type FbotConfig, type FbotEvent, type SpecData, type SpecForm,
  type SpecMenuOption, type SpecField, type FieldKind, type Submission,
} from './services/fbot';

type LogLine = { ts: number; text: string; level: 'info' | 'error' };
type Sub = 'conn' | 'card' | 'inbox';

const FbotView: React.FC = () => {
  const [sub, setSub] = useState<Sub>('conn');
  const [cfg, setCfg] = useState<FbotConfig | null>(null);
  const [secret, setSecret] = useState('');
  const [testChat, setTestChat] = useState('');
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [spec, setSpec] = useState<SpecData | null>(null);
  const [dirty, setDirty] = useState(false);
  const [subs, setSubs] = useState<Submission[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const pushLog = (text: string, level: 'info' | 'error' = 'info') =>
    setLogs((l) => [...l.slice(-150), { ts: Date.now(), text, level }]);

  useEffect(() => {
    fbot.getConfig().then((c) => { if (c) { setCfg(c); setTestChat(c.testChatId || ''); } });
    fbot.getSpec().then((s) => { if (s) setSpec(s); });
    fbot.listSubmissions().then((a) => setSubs(a || []));
    const off = fbot.onEvent((e: FbotEvent) => {
      if (e.type === 'log') pushLog(e.msg, e.level);
      else if (e.type === 'message') pushLog(`收到消息 [${e.chatType}] "${e.text}"`);
      else if (e.type === 'card_action') pushLog(`卡片动作 ${JSON.stringify(e.value)} ${JSON.stringify(e.formValue || {})}`);
      else if (e.type === 'status') { pushLog(e.running ? `已上线 ${e.botName || ''}` : '已下线'); setCfg((c) => c ? { ...c, running: e.running, botName: e.botName || c.botName } : c); }
      else if (e.type === 'submission') { setSubs((a) => [e.item, ...a]); pushLog(`📥 收到提交：${e.item.formTitle}`); }
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
  const delOption = (i: number) => { setSpec((s) => s && ({ ...s, menu: { ...s.menu, options: s.menu.options.filter((_, j) => j !== i) } })); setDirty(true); };
  const patchForm = (k: string, p: Partial<SpecForm>) => { setSpec((s) => s && ({ ...s, forms: { ...s.forms, [k]: { ...s.forms[k], ...p } } })); setDirty(true); };
  const addForm = () => { const k = `form_${Date.now().toString(36)}`; setSpec((s) => s && ({ ...s, forms: { ...s.forms, [k]: { title: '新表单', submitText: '提交', fields: [] } } })); setDirty(true); };
  const delForm = (k: string) => { setSpec((s) => { if (!s) return s; const f = { ...s.forms }; delete f[k]; return { ...s, forms: f }; }); setDirty(true); };
  const patchField = (fk: string, i: number, p: Partial<SpecField>) => { setSpec((s) => { if (!s) return s; const fs = s.forms[fk].fields.slice(); fs[i] = { ...fs[i], ...p }; return { ...s, forms: { ...s.forms, [fk]: { ...s.forms[fk], fields: fs } } }; }); setDirty(true); };
  const addField = (fk: string) => { setSpec((s) => s && ({ ...s, forms: { ...s.forms, [fk]: { ...s.forms[fk], fields: [...s.forms[fk].fields, { name: `f${Date.now().toString(36)}`, kind: 'input', label: '字段' }] } } })); setDirty(true); };
  const delField = (fk: string, i: number) => { setSpec((s) => s && ({ ...s, forms: { ...s.forms, [fk]: { ...s.forms[fk], fields: s.forms[fk].fields.filter((_, j) => j !== i) } } })); setDirty(true); };
  const saveSpec = async () => { if (!spec) return; const r = await fbot.setSpec(spec); if (r.ok) { setDirty(false); pushLog('卡片配置已保存并热更新'); } else pushLog(`保存失败：${r.error}`, 'error'); };
  const resetSpec = async () => { if (!window.confirm('恢复默认卡片配置？当前编辑会丢失。')) return; const r = await fbot.resetSpec(); if (r.ok && r.menu && r.forms) { setSpec({ menu: r.menu, forms: r.forms }); setDirty(false); pushLog('已恢复默认卡片配置'); } };

  const formKeys = spec ? Object.keys(spec.forms) : [];
  const selSub = useMemo(() => subs.find((s) => s.id === sel) || null, [subs, sel]);

  return (
    <div className="v2-feat"><div className="v2-feat-main">
      <div className="fbot-view">
        {/* 子导航 */}
        <aside className="fbot-view-nav">
          <div className="fbot-view-title">
            <span className={`fbot-dot${cfg?.running ? ' on' : ''}`} />
            飞书录入助手
          </div>
          <div className="fbot-view-sub">{cfg?.running ? `在线 ${cfg.botName || ''}` : '离线'}</div>
          <button className={`fbot-nav-item${sub === 'conn' ? ' active' : ''}`} onClick={() => setSub('conn')}>连接 · 日志</button>
          <button className={`fbot-nav-item${sub === 'card' ? ' active' : ''}`} onClick={() => setSub('card')}>卡片配置{dirty ? ' •' : ''}</button>
          <button className={`fbot-nav-item${sub === 'inbox' ? ' active' : ''}`} onClick={() => setSub('inbox')}>提交记录{subs.length ? ` (${subs.length})` : ''}</button>
          <div className="fbot-nav-foot">
            <button className="v2-set-btn primary" style={{ width: '100%' }} disabled={busy} onClick={toggleRun}>{cfg?.running ? '停止' : '启动'}</button>
          </div>
        </aside>

        {/* 内容区 */}
        <div className="fbot-view-body">
          {sub === 'conn' && (
            <div className="fbot-pane">
              <h3>连接</h3>
              <p className="fbot-hint">飞书自建应用凭证；长连接随 App 在线。改后台权限/事件后需重新「发布版本」。</p>
              <div className="v2-modal-sec"><div className="lab">App ID</div>
                <input value={cfg?.appId || ''} onChange={(e) => setCfg((c) => c ? { ...c, appId: e.target.value } : c)} placeholder="cli_xxx" /></div>
              <div className="v2-modal-sec"><div className="lab">App Secret</div>
                <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={cfg?.hasSecret ? '已配置（留空不改）' : '应用密钥'} /></div>
              <div className="v2-modal-sec"><div className="lab">测试群/会话 chat_id</div>
                <input value={testChat} onChange={(e) => setTestChat(e.target.value)} placeholder="oc_xxx（用于「发测试卡片」）" /></div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                <button className="v2-set-btn" onClick={saveConn}>保存连接</button>
                <button className="v2-set-btn" onClick={sendTest} disabled={!cfg?.running}>发测试卡片</button>
              </div>
              <div className="fbot-block-hd">运行日志 <button className="v2-set-btn sm" onClick={() => setLogs([])}>清空</button></div>
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
            <div className="fbot-pane">
              <div className="fbot-pane-hd">
                <h3>卡片配置</h3>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="v2-set-btn" onClick={resetSpec}>恢复默认</button>
                  <button className="v2-set-btn primary" onClick={saveSpec} disabled={!dirty}>{dirty ? '保存配置' : '已保存'}</button>
                </div>
              </div>
              <p className="fbot-hint">可视化编辑能力菜单与表单；保存即热更新到 bot。业务处理（落库等）在 fbotMenu.cjs。</p>
              {!spec && <div className="v2-set-empty">加载中…</div>}
              {spec && (<>
                <div className="v2-modal-sec"><div className="lab">菜单标题</div>
                  <input value={spec.menu.title} onChange={(e) => patchMenu({ title: e.target.value })} /></div>
                <div className="v2-modal-sec"><div className="lab">菜单引导语（支持 markdown）</div>
                  <input value={spec.menu.intro || ''} onChange={(e) => patchMenu({ intro: e.target.value })} /></div>

                <div className="fbot-block-hd">菜单选项 <button className="v2-set-btn sm" onClick={addOption}>＋ 选项</button></div>
                {spec.menu.options.map((opt, i) => (
                  <div key={i} className="fbot-card-row">
                    <input className="grow" value={opt.text} onChange={(e) => patchOption(i, { text: e.target.value })} placeholder="按钮文字" />
                    <select className="v2-set-select" value={opt.type || 'default'} onChange={(e) => patchOption(i, { type: e.target.value as any })}>
                      <option value="primary">主</option><option value="default">次</option><option value="danger">危险</option>
                    </select>
                    <select className="v2-set-select" value={opt.form ? `form:${opt.form}` : (opt.action ? `action:${opt.action}` : '')}
                      onChange={(e) => { const v = e.target.value; if (v.startsWith('form:')) patchOption(i, { form: v.slice(5), action: undefined }); else if (v.startsWith('action:')) patchOption(i, { action: v.slice(7), form: undefined }); }}>
                      <option value="">行为…</option>
                      {formKeys.map((fk) => <option key={fk} value={`form:${fk}`}>弹表单：{spec.forms[fk].title}</option>)}
                      <option value="action:query">动作：查询(代码)</option>
                    </select>
                    <button className="v2-set-btn sm danger" onClick={() => delOption(i)}>删</button>
                  </div>
                ))}

                <div className="fbot-block-hd" style={{ marginTop: 16 }}>表单 <button className="v2-set-btn sm" onClick={addForm}>＋ 表单</button></div>
                {formKeys.length === 0 && <div className="v2-set-empty">还没有表单。加一个，再在选项里把「行为」指向它。</div>}
                {formKeys.map((fk) => {
                  const form = spec.forms[fk];
                  return (
                    <div key={fk} className="fbot-form-box">
                      <div className="fbot-card-row">
                        <span className="fbot-key">{fk}</span>
                        <input className="grow" value={form.title} onChange={(e) => patchForm(fk, { title: e.target.value })} placeholder="表单标题" />
                        <input style={{ width: 90 }} value={form.submitText || ''} onChange={(e) => patchForm(fk, { submitText: e.target.value })} placeholder="提交按钮" />
                        <button className="v2-set-btn sm danger" onClick={() => delForm(fk)}>删表单</button>
                      </div>
                      {form.fields.map((field, fi) => (
                        <div key={fi} className="fbot-card-row sub">
                          <input style={{ width: 96 }} value={field.name} onChange={(e) => patchField(fk, fi, { name: e.target.value })} placeholder="字段名" />
                          <input className="grow" value={field.label} onChange={(e) => patchField(fk, fi, { label: e.target.value })} placeholder="显示标签" />
                          <select className="v2-set-select" value={field.kind} onChange={(e) => patchField(fk, fi, { kind: e.target.value as FieldKind })}>
                            <option value="input">单行</option><option value="multiline">多行</option><option value="select">下拉</option>
                          </select>
                          {field.kind === 'select' && (
                            <input style={{ width: 150 }} value={(field.options || []).map(([v, l]) => v === l ? v : `${v}:${l}`).join(',')}
                              onChange={(e) => patchField(fk, fi, { options: e.target.value.split(',').map((s) => { const [v, l] = s.split(':'); return [v?.trim() || '', (l || v || '').trim()] as [string, string]; }).filter(([v]) => v) })}
                              placeholder="选项 a,b,c 或 值:标签" />
                          )}
                          <label className="fbot-req"><input type="checkbox" checked={!!field.required} onChange={(e) => patchField(fk, fi, { required: e.target.checked })} />必填</label>
                          <button className="v2-set-btn sm danger" onClick={() => delField(fk, fi)}>×</button>
                        </div>
                      ))}
                      <button className="v2-set-btn sm" onClick={() => addField(fk)}>＋ 字段</button>
                    </div>
                  );
                })}
              </>)}
            </div>
          )}

          {sub === 'inbox' && (
            <div className="fbot-pane fbot-inbox">
              <div className="fbot-pane-hd">
                <h3>提交记录 {subs.length ? <span className="fbot-count">{subs.length}</span> : null}</h3>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="v2-set-btn" onClick={() => fbot.listSubmissions().then((a) => setSubs(a || []))}>刷新</button>
                  <button className="v2-set-btn danger" onClick={async () => { if (window.confirm('清空全部提交记录？')) { await fbot.clearSubmissions(); setSubs([]); setSel(null); } }}>清空</button>
                </div>
              </div>
              {subs.length === 0 && <div className="v2-set-empty">还没有提交。让用户 @机器人 → 选项 → 填表单 → 提交，这里就会出现。</div>}
              <div className="fbot-inbox-split">
                <div className="fbot-inbox-list">
                  {subs.map((s) => (
                    <button key={s.id} className={`fbot-inbox-item${sel === s.id ? ' active' : ''}`} onClick={() => setSel(s.id)}>
                      <div className="ti">{s.formTitle}</div>
                      <div className="me">{new Date(s.ts).toLocaleString()}</div>
                    </button>
                  ))}
                </div>
                <div className="fbot-inbox-detail">
                  {!selSub && subs.length > 0 && <div className="v2-set-empty">选一条查看详情</div>}
                  {selSub && (
                    <>
                      <div className="fbot-detail-hd">{selSub.formTitle}<span className="fbot-key">{selSub.formKey}</span></div>
                      <div className="fbot-detail-meta">
                        {new Date(selSub.ts).toLocaleString()}
                        {selSub.operator?.open_id && <> · 提交人 <code>{String(selSub.operator.open_id)}</code></>}
                      </div>
                      <table className="fbot-detail-table"><tbody>
                        {Object.entries(selSub.values).map(([k, v]) => (
                          <tr key={k}><th>{k}</th><td>{String(v) || <span className="muted">(空)</span>}</td></tr>
                        ))}
                      </tbody></table>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div></div>
  );
};

export default FbotView;
