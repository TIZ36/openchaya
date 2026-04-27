import React, { useCallback, useEffect, useState } from 'react';
import {
  PaperPage, PaperTopbar, PaperContent, PaperButton, PaperInput, PaperTextarea, PaperChip,
} from './paper';
import { toast } from './ui/use-toast';
import {
  mcpApi, skillsApi, oauthApi,
  type MCPServer, type Skill, type MCPTransport,
} from '../services/integrationsApi';

/* ============================================================
   Integrations · MCP servers + Skills
   Two tabs sharing one chapter. CRUD-only for v1; OAuth flow,
   live health probes and skill triggering preview are v2 work.
   ============================================================ */

type Tab = 'mcp' | 'skill';

const IntegrationsPage: React.FC = () => {
  const [tab, setTab] = useState<Tab>('mcp');
  return (
    <PaperPage>
      <PaperTopbar
        crumb="Chapter Seven · Integrations"
        title="接口"
        subtitle="MCP 工具服务器和 Skill 流程，挂在 agent 身上的两类外挂。"
        meta={tab === 'mcp' ? 'MCP Servers' : 'Skills'}
        actions={
          <div style={s.tabRow}>
            <button
              type="button"
              onClick={() => setTab('mcp')}
              style={{ ...s.tabBtn, ...(tab === 'mcp' ? s.tabBtnOn : null) }}
            >MCP</button>
            <button
              type="button"
              onClick={() => setTab('skill')}
              style={{ ...s.tabBtn, ...(tab === 'skill' ? s.tabBtnOn : null) }}
            >Skill</button>
          </div>
        }
      />
      <PaperContent>
        {tab === 'mcp' ? <MCPTab /> : <SkillTab />}
      </PaperContent>
    </PaperPage>
  );
};

/* ─────────────────────── MCP TAB ─────────────────────── */

const MCPTab: React.FC = () => {
  const [servers, setServers] = useState<MCPServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const list = await mcpApi.list();
      setServers(Array.isArray(list) ? list : []);
    } catch (e: any) {
      setErr(e?.message || '取 MCP 列表时出错');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const onToggle = async (sv: MCPServer) => {
    try {
      await mcpApi.update(sv.id, { enabled: !sv.enabled });
      await load();
    } catch (e: any) {
      toast({ title: '改不了', description: e?.message || '', variant: 'destructive' });
    }
  };
  const onDelete = async (sv: MCPServer) => {
    if (!confirm(`删掉 MCP 服务器「${sv.name}」吗？所有 agent 的绑定也会一起解开。`)) return;
    try {
      await mcpApi.remove(sv.id);
      await load();
      toast({ title: '删了' });
    } catch (e: any) {
      toast({ title: '删不掉', description: e?.message || '', variant: 'destructive' });
    }
  };

  return (
    <>
      <div style={s.toolbar}>
        <div style={s.hint}>
          配置 MCP 工具服务器；启用后 agent 在「人设」页绑定它就能调用其工具。
          <br />
          <span style={s.hintMono}>http / sse</span> 走 HTTP/EventStream 直连；
          <span style={s.hintMono}>stdio</span> 在引擎进程里 spawn 子进程。
        </div>
        <PaperButton onClick={() => setShowForm((v) => !v)}>{showForm ? '收起' : '+ 加一个'}</PaperButton>
      </div>

      {showForm && <MCPCreateForm onCreated={() => { setShowForm(false); void load(); }} />}

      {err && <div style={s.errBox}>{err}</div>}
      {loading && servers.length === 0 ? (
        <Loading text="正在取 MCP…" />
      ) : servers.length === 0 ? (
        <Empty title="还没挂 MCP 服务器" hint="加一个 sse / stdio / http 服务器，agent 就能调用它的工具了。" />
      ) : (
        <div style={s.grid}>
          {servers.map((sv) => (
            <MCPCard
              key={sv.id}
              sv={sv}
              onToggle={() => void onToggle(sv)}
              onDelete={() => void onDelete(sv)}
              onProbed={() => void load()}
            />
          ))}
        </div>
      )}
    </>
  );
};

const MCPCard: React.FC<{
  sv: MCPServer;
  onToggle: () => void;
  onDelete: () => void;
  onProbed: () => void;
}> = ({ sv, onToggle, onDelete, onProbed }) => {
  const [probing, setProbing] = useState(false);
  const [probeRes, setProbeRes] = useState<{ ok: boolean; tool_count: number; tools?: string[]; error?: string } | null>(null);

  // OAuth state. We probe token status once on mount + after a fresh authorize
  // round-trip; the badge is "has token / no token / unknown" — the backend
  // doesn't currently surface expiry, so we intentionally don't show that.
  // stdio servers don't need OAuth (they run as a child process), so the
  // badge + button are hidden for that transport.
  const [hasToken, setHasToken] = useState<boolean | null>(null);
  const [authBusy, setAuthBusy] = useState<'discover' | 'redirect' | 'polling' | null>(null);
  const oauthEligible = sv.type !== 'stdio';

  useEffect(() => {
    if (!oauthEligible || !sv.url) return;
    let cancelled = false;
    oauthApi.tokenStatus(sv.url)
      .then((r) => { if (!cancelled) setHasToken(!!r?.has_token); })
      .catch(() => { if (!cancelled) setHasToken(null); });
    return () => { cancelled = true; };
  }, [oauthEligible, sv.url]);

  const dot = sv.enabled
    ? (sv.healthy ? 'var(--status-success)' : 'var(--status-warning)')
    : 'var(--rule-strong)';

  const probe = async () => {
    setProbing(true);
    try {
      const r = await mcpApi.probe(sv.id);
      setProbeRes(r);
      if (r.ok) toast({ title: `连通 · ${r.tool_count} 个工具` });
      else toast({ title: '连不上', description: r.error || '没拉到工具', variant: 'destructive' });
      onProbed();
    } catch (e: any) {
      toast({ title: '连不上', description: e?.message || '', variant: 'destructive' });
    } finally {
      setProbing(false);
    }
  };

  const authorize = async () => {
    if (!sv.url) return;
    setAuthBusy('discover');
    try {
      // 1. Discover OAuth metadata. Servers without OAuth return empty endpoints
      //    — treat that as "doesn't need authorization".
      const meta = await oauthApi.discover(sv.url);
      if (!meta?.authorization_endpoint || !meta?.token_endpoint) {
        toast({ title: '这个服务器不需要 OAuth', description: '没发现 authorization_endpoint' });
        setAuthBusy(null);
        return;
      }
      // 2. Authorize: backend stashes PKCE + state in Redis, returns the URL
      //    the user should be sent to.
      const auth = await oauthApi.authorize({ ...meta, mcp_url: sv.url });
      if (!auth?.authorization_url) {
        toast({ title: '没拿到授权 URL', variant: 'destructive' });
        setAuthBusy(null);
        return;
      }
      // 3. Open the authorization URL in a popup. The provider redirects to
      //    /mcp/oauth/callback which exchanges the code server-side.
      setAuthBusy('redirect');
      const popup = window.open(auth.authorization_url, 'mcp-oauth', 'width=520,height=720,menubar=no,toolbar=no');
      if (!popup) {
        toast({ title: '浏览器拦了弹窗', description: '允许弹窗后重试', variant: 'destructive' });
        setAuthBusy(null);
        return;
      }
      // 4. Poll token-status while the popup is open. Stop after 3 min;
      //    user might cancel mid-flow and we don't want to spin forever.
      setAuthBusy('polling');
      const start = Date.now();
      const POLL_MS = 1500;
      const TIMEOUT_MS = 3 * 60 * 1000;
      const tick = async (): Promise<void> => {
        try {
          const st = await oauthApi.tokenStatus(sv.url);
          if (st?.has_token) {
            setHasToken(true);
            setAuthBusy(null);
            popup.close();
            toast({ title: '授权成功' });
            onProbed(); // re-probe so tools show up
            return;
          }
        } catch { /* ignore one-off poll errors */ }
        if (popup.closed) {
          setAuthBusy(null);
          toast({ title: '弹窗已关', description: '没完成授权' });
          return;
        }
        if (Date.now() - start > TIMEOUT_MS) {
          setAuthBusy(null);
          toast({ title: '授权超时', description: '3 分钟没完成，重试一下' });
          return;
        }
        setTimeout(() => void tick(), POLL_MS);
      };
      void tick();
    } catch (e: any) {
      toast({ title: '授权失败', description: e?.message || '', variant: 'destructive' });
      setAuthBusy(null);
    }
  };

  const authBadge = (() => {
    if (!oauthEligible) return null;
    if (authBusy === 'polling') return <PaperChip tone={'warning' as any}>等回调…</PaperChip>;
    if (hasToken === true) return <PaperChip tone={'success' as any}>已授权</PaperChip>;
    if (hasToken === false) return <PaperChip>未授权</PaperChip>;
    return null;
  })();

  return (
    <div style={s.card}>
      <div style={s.cardHead}>
        <span style={{ ...s.statusDot, background: dot }} />
        <div style={s.cardTitle}>{sv.name}</div>
        <PaperChip tone={sv.type === 'stdio' ? 'warning' as any : 'default'}>{sv.type}</PaperChip>
        {authBadge}
      </div>
      <div style={s.cardURL} title={sv.url}>{sv.url}</div>
      <div style={s.cardMeta}>
        {sv.enabled ? (sv.healthy ? '在线' : '已启用 · 未连通') : '已停用'}
        {probeRes && probeRes.ok && (
          <> · <span style={s.probeOk}>{probeRes.tool_count} 个工具</span></>
        )}
      </div>
      {probeRes?.ok && probeRes.tools && probeRes.tools.length > 0 && (
        <div style={s.chipRow}>
          {probeRes.tools.slice(0, 6).map((t) => <PaperChip key={t}>{t}</PaperChip>)}
          {probeRes.tools.length > 6 && <span style={s.chipMore}>+{probeRes.tools.length - 6}</span>}
        </div>
      )}
      <div style={s.cardActions}>
        <PaperButton variant="ghost" size="small" onClick={() => void probe()} disabled={probing || !sv.enabled}>
          {probing ? '试…' : '测连接'}
        </PaperButton>
        {oauthEligible && (
          <PaperButton variant="ghost" size="small" onClick={() => void authorize()} disabled={!!authBusy || !sv.enabled}>
            {authBusy === 'discover' ? '探…'
              : authBusy === 'redirect' ? '跳…'
              : authBusy === 'polling' ? '等回调'
              : (hasToken ? '重授权' : '授权')}
          </PaperButton>
        )}
        <PaperButton variant="ghost" size="small" onClick={onToggle}>
          {sv.enabled ? '停用' : '启用'}
        </PaperButton>
        <span style={{ flex: 1 }} />
        <PaperButton variant="link" danger onClick={onDelete}>删</PaperButton>
      </div>
    </div>
  );
};

const MCPCreateForm: React.FC<{ onCreated: () => void }> = ({ onCreated }) => {
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<MCPTransport>('sse');
  const [url, setUrl] = useState('');
  const [command, setCommand] = useState('');
  const [argsText, setArgsText] = useState('');
  const [envText, setEnvText] = useState('');
  const [headersText, setHeadersText] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) { toast({ title: '名字不能空', variant: 'destructive' }); return; }
    if (transport === 'stdio') {
      if (!command.trim()) { toast({ title: 'stdio 需要 command', variant: 'destructive' }); return; }
    } else {
      if (!url.trim()) { toast({ title: 'http/sse 需要 URL', variant: 'destructive' }); return; }
    }
    let env: Record<string, string> | undefined;
    let headers: Record<string, string> | undefined;
    try {
      if (envText.trim()) env = JSON.parse(envText);
      if (headersText.trim()) headers = JSON.parse(headersText);
    } catch (e: any) {
      toast({ title: 'JSON 解析失败', description: e?.message || '', variant: 'destructive' });
      return;
    }
    setSubmitting(true);
    try {
      await mcpApi.create({
        name: trimmedName,
        type: transport,
        // For stdio, backend still expects something in `url`; pass the command as a placeholder
        // and put the real spec in config.command/args/env (autoConnect uses Config).
        url: transport === 'stdio' ? command.trim() : url.trim(),
        command: transport === 'stdio' ? command.trim() : undefined,
        args: argsText.trim() ? argsText.trim().split(/\s+/) : undefined,
        env,
        headers,
        enabled: true,
      });
      toast({ title: '加好了' });
      onCreated();
    } catch (e: any) {
      toast({ title: '加不上', description: e?.message || '', variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={s.formBox}>
      <div style={s.formGrid}>
        <Field label="名字（任意）">
          <PaperInput value={name} onChange={(e) => setName(e.target.value)} placeholder="比如 GitHub MCP" />
        </Field>
        <Field label="传输方式">
          <select
            value={transport}
            onChange={(e) => setTransport(e.target.value as MCPTransport)}
            style={s.select}
          >
            <option value="sse">sse — Server-Sent Events</option>
            <option value="http">http — HTTP/JSON</option>
            <option value="stdio">stdio — 子进程</option>
          </select>
        </Field>
      </div>

      {transport === 'stdio' ? (
        <>
          <Field label="Command">
            <PaperInput value={command} onChange={(e) => setCommand(e.target.value)} placeholder="例如 npx 或 /usr/bin/python" mono />
          </Field>
          <Field label="Args（空格分隔）">
            <PaperInput value={argsText} onChange={(e) => setArgsText(e.target.value)} placeholder="-y @modelcontextprotocol/server-github" mono />
          </Field>
          <Field label="Env（JSON 对象，选填）">
            <PaperTextarea value={envText} onChange={(e) => setEnvText(e.target.value)} placeholder='{"GITHUB_TOKEN":"ghp_..."}' rows={3} />
          </Field>
        </>
      ) : (
        <>
          <Field label="URL">
            <PaperInput value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" mono />
          </Field>
          <Field label="Headers（JSON 对象，选填）">
            <PaperTextarea value={headersText} onChange={(e) => setHeadersText(e.target.value)} placeholder='{"Authorization":"Bearer ..."}' rows={3} />
          </Field>
        </>
      )}

      <div style={s.formFoot}>
        <PaperButton onClick={() => void submit()} disabled={submitting}>
          {submitting ? '加…' : '加上'}
        </PaperButton>
      </div>
    </div>
  );
};

/* ─────────────────────── SKILL TAB ─────────────────────── */

const SkillTab: React.FC = () => {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Skill | null>(null); // null = list mode; {} draft for new
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const list = await skillsApi.list();
      setSkills(Array.isArray(list) ? list : []);
    } catch (e: any) {
      setErr(e?.message || '取 Skill 列表时出错');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const onDelete = async (sk: Skill) => {
    if (!confirm(`删掉 skill「${sk.name}」吗？所有 agent 的绑定也会一起解开。`)) return;
    try {
      await skillsApi.remove(sk.id);
      await load();
      toast({ title: '删了' });
    } catch (e: any) {
      toast({ title: '删不掉', description: e?.message || '', variant: 'destructive' });
    }
  };

  if (creating || editing) {
    return (
      <SkillEditor
        initial={editing}
        onSaved={() => { setCreating(false); setEditing(null); void load(); }}
        onCancel={() => { setCreating(false); setEditing(null); }}
      />
    );
  }

  return (
    <>
      <div style={s.toolbar}>
        <div style={s.hint}>
          Skill 是「触发词 + 步骤」的小流程，命中关键词时引擎会把步骤拼进 prompt 引导 agent。
          <br />可以指定它依赖哪些 MCP 服务器。
        </div>
        <PaperButton onClick={() => setCreating(true)}>+ 写一个</PaperButton>
      </div>

      {err && <div style={s.errBox}>{err}</div>}
      {loading && skills.length === 0 ? (
        <Loading text="正在取 Skill…" />
      ) : skills.length === 0 ? (
        <Empty title="还没写过 Skill" hint="写一个：定义关键词 + 步骤，agent 命中后自动按流程走。" />
      ) : (
        <div style={s.grid}>
          {skills.map((sk) => (
            <SkillCard key={sk.id} sk={sk} onEdit={() => setEditing(sk)} onDelete={() => void onDelete(sk)} />
          ))}
        </div>
      )}
    </>
  );
};

const SkillCard: React.FC<{ sk: Skill; onEdit: () => void; onDelete: () => void }> = ({ sk, onEdit, onDelete }) => {
  const kws = Array.isArray(sk.keywords) ? sk.keywords : [];
  const stepsCount = Array.isArray(sk.steps) ? sk.steps.length : 0;
  const reqMcp = Array.isArray(sk.required_mcp) ? sk.required_mcp : [];
  return (
    <div style={s.card}>
      <div style={s.cardHead}>
        <div style={s.cardTitle}>{sk.name}</div>
        <PaperChip>{stepsCount} 步</PaperChip>
      </div>
      {sk.description && <div style={s.cardDesc}>{sk.description}</div>}
      {kws.length > 0 && (
        <div style={s.chipRow}>
          {kws.slice(0, 8).map((k, i) => <PaperChip key={i}>{String(k)}</PaperChip>)}
          {kws.length > 8 && <span style={s.chipMore}>+{kws.length - 8}</span>}
        </div>
      )}
      {reqMcp.length > 0 && (
        <div style={s.cardMeta}>需要 MCP：{reqMcp.join(', ')}</div>
      )}
      <div style={s.cardActions}>
        <PaperButton variant="ghost" size="small" onClick={onEdit}>改</PaperButton>
        <span style={{ flex: 1 }} />
        <PaperButton variant="link" danger onClick={onDelete}>删</PaperButton>
      </div>
    </div>
  );
};

// Convert whatever the backend stored (array of strings, array of objects
// with .text/.content, or unknown) into a flat list of strings the editor
// can render. Drops anything we can't read; round-tripping objects-as-JSON
// would lose typed steps but they shouldn't have been there in v1 anyway.
function stepsToStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((s) => {
    if (typeof s === 'string') return s;
    if (s && typeof s === 'object') {
      const obj = s as Record<string, unknown>;
      if (typeof obj.text === 'string') return obj.text;
      if (typeof obj.content === 'string') return obj.content;
      if (typeof obj.description === 'string') return obj.description;
    }
    return '';
  });
}

const SkillEditor: React.FC<{
  initial: Skill | null;
  onSaved: () => void;
  onCancel: () => void;
}> = ({ initial, onSaved, onCancel }) => {
  const [name, setName] = useState(initial?.name || '');
  const [desc, setDesc] = useState(initial?.description || '');
  const [keywordsText, setKeywordsText] = useState(
    Array.isArray(initial?.keywords) ? initial!.keywords!.join(', ') : ''
  );
  const [steps, setSteps] = useState<string[]>(() => {
    const list = stepsToStringList(initial?.steps);
    return list.length > 0 ? list : ['第一步：…'];
  });
  const [requiredMcpText, setRequiredMcpText] = useState(
    Array.isArray(initial?.required_mcp) ? initial!.required_mcp!.join(', ') : ''
  );
  const [submitting, setSubmitting] = useState(false);
  const [trial, setTrial] = useState('');

  const updateStep = (i: number, v: string) =>
    setSteps((prev) => prev.map((s, idx) => (idx === i ? v : s)));
  const addStep = () => setSteps((prev) => [...prev, '']);
  const removeStep = (i: number) =>
    setSteps((prev) => (prev.length <= 1 ? prev : prev.filter((_, idx) => idx !== i)));
  const moveStep = (i: number, dir: -1 | 1) => setSteps((prev) => {
    const j = i + dir;
    if (j < 0 || j >= prev.length) return prev;
    const next = prev.slice();
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  // Parse keywords once for both submit and trigger preview.
  const keywords = keywordsText
    .split(',').map((s) => s.trim()).filter(Boolean);

  // Skill trigger preview: case-insensitive contains check, mirroring the
  // simple substring match the backend uses to decide if a skill fires.
  // This is the "would this message trigger?" UX hint, not a full replay.
  const trialNorm = trial.toLowerCase();
  const matchedKeywords = trialNorm
    ? keywords.filter((k) => k && trialNorm.includes(k.toLowerCase()))
    : [];
  const wouldTrigger = trial.trim() !== '' && matchedKeywords.length > 0;

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) { toast({ title: '名字不能空', variant: 'destructive' }); return; }
    const cleanSteps = steps.map((s) => s.trim()).filter(Boolean);
    if (cleanSteps.length === 0) {
      toast({ title: '至少要一个步骤', variant: 'destructive' });
      return;
    }
    const body = {
      name: trimmed,
      description: desc.trim(),
      keywords,
      steps: cleanSteps,
      required_mcp: requiredMcpText.split(',').map((s) => s.trim()).filter(Boolean),
    };
    setSubmitting(true);
    try {
      if (initial?.id) await skillsApi.update(initial.id, body);
      else await skillsApi.create(body);
      toast({ title: initial?.id ? '改好了' : '写好了' });
      onSaved();
    } catch (e: any) {
      toast({ title: '存不上', description: e?.message || '', variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={s.formBox}>
      <Field label="名字"><PaperInput value={name} onChange={(e) => setName(e.target.value)} placeholder="比如 周报生成" /></Field>
      <Field label="描述（一句话说它是干啥的）">
        <PaperInput value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="把本周提交聚合成 markdown 周报" />
      </Field>
      <Field label="关键词（逗号分隔，命中即触发）">
        <PaperInput value={keywordsText} onChange={(e) => setKeywordsText(e.target.value)} placeholder="周报, weekly, 总结" />
      </Field>

      {/* Trigger preview — shows whether a sample message would fire this skill,
         and which keywords it hit. Saves no state; pure UX feedback. */}
      <Field label="试一句（看会不会触发）">
        <PaperInput value={trial} onChange={(e) => setTrial(e.target.value)} placeholder='比如「帮我生成本周的周报」' />
        {trial.trim() && (
          <div style={s.triggerHint}>
            {wouldTrigger ? (
              <>
                <span style={s.triggerOn}>✓ 会触发</span>
                <span style={{ marginLeft: 8 }}>—</span>
                {matchedKeywords.map((k, i) => (
                  <span key={i} style={s.triggerKw}>{k}</span>
                ))}
              </>
            ) : (
              <span style={s.triggerOff}>○ 不会触发（没命中任何关键词）</span>
            )}
          </div>
        )}
      </Field>

      <Field label={`步骤（${steps.length}）`}>
        <div style={s.stepsList}>
          {steps.map((step, i) => (
            <div key={i} style={s.stepRow}>
              <span style={s.stepNum}>{String(i + 1).padStart(2, '0')}</span>
              <PaperTextarea
                value={step}
                onChange={(e) => updateStep(i, e.target.value)}
                placeholder={`第 ${i + 1} 步要 agent 干啥`}
                rows={2}
                style={{ flex: 1, resize: 'vertical' }}
              />
              <div style={s.stepActions}>
                <button type="button" onClick={() => moveStep(i, -1)} disabled={i === 0} style={s.stepIcon} title="上移">↑</button>
                <button type="button" onClick={() => moveStep(i, +1)} disabled={i === steps.length - 1} style={s.stepIcon} title="下移">↓</button>
                <button type="button" onClick={() => removeStep(i)} disabled={steps.length <= 1} style={{ ...s.stepIcon, color: 'oklch(0.55 0.16 25)' }} title="删">×</button>
              </div>
            </div>
          ))}
        </div>
        <PaperButton variant="ghost" size="small" onClick={addStep}>+ 加一步</PaperButton>
      </Field>

      <Field label="依赖的 MCP 服务器（逗号分隔 ID，选填）">
        <PaperInput value={requiredMcpText} onChange={(e) => setRequiredMcpText(e.target.value)} placeholder="github-mcp-id, jira-mcp-id" mono />
      </Field>
      <div style={s.formFoot}>
        <PaperButton variant="ghost" onClick={onCancel}>取消</PaperButton>
        <span style={{ flex: 1 }} />
        <PaperButton onClick={() => void submit()} disabled={submitting}>{submitting ? '存…' : '存'}</PaperButton>
      </div>
    </div>
  );
};

/* ─────────────────────── shared bits ─────────────────────── */

const Field: React.FC<React.PropsWithChildren<{ label: string }>> = ({ label, children }) => (
  <div style={s.field}>
    <div style={s.fieldLabel}>{label}</div>
    {children}
  </div>
);

const Loading: React.FC<{ text: string }> = ({ text }) => (
  <div style={s.loading}>{text}</div>
);

const Empty: React.FC<{ title: string; hint: string }> = ({ title, hint }) => (
  <div style={s.empty}>
    <h3 style={s.emptyTitle}>{title}</h3>
    <p style={s.emptyHint}>{hint}</p>
  </div>
);

const s: Record<string, React.CSSProperties> = {
  tabRow: { display: 'flex', gap: 4 },
  tabBtn: {
    padding: '4px 14px',
    fontFamily: "'Young Serif', serif",
    fontSize: 13,
    color: 'var(--pencil)',
    background: 'transparent',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    cursor: 'pointer',
  },
  tabBtnOn: {
    background: 'var(--accent-ink)',
    color: 'var(--paper)',
    borderColor: 'var(--accent-ink)',
  },
  toolbar: {
    display: 'flex', gap: 16, alignItems: 'flex-start',
    padding: '4px 0 18px', borderBottom: '1px dotted var(--rule)',
    marginBottom: 18,
  },
  hint: {
    flex: 1, fontFamily: "'Young Serif', serif", fontStyle: 'italic',
    fontSize: 13, color: 'var(--pencil)', lineHeight: 1.6,
  },
  hintMono: {
    fontFamily: "'JetBrains Mono', monospace", fontStyle: 'normal',
    fontSize: 11, color: 'var(--ink-strong)',
    background: 'var(--page-elev)', padding: '0 4px', margin: '0 2px',
    border: '1px solid var(--rule)', borderRadius: 1,
  },
  grid: {
    display: 'grid', gap: 14,
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
  },
  card: {
    background: 'var(--page-elev)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 3, padding: '14px 16px',
    display: 'flex', flexDirection: 'column', gap: 8,
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: 10 },
  statusDot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  cardTitle: {
    fontFamily: "'Young Serif', serif", fontSize: 15, color: 'var(--ink-strong)',
    flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  cardURL: {
    fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
    color: 'var(--pencil)', wordBreak: 'break-all',
  },
  cardDesc: {
    fontFamily: "'Young Serif', serif", fontSize: 13,
    color: 'var(--ink)', lineHeight: 1.5,
  },
  cardMeta: {
    fontSize: 11, color: 'var(--pencil-soft)',
    fontFamily: "'JetBrains Mono', monospace",
  },
  cardActions: {
    display: 'flex', alignItems: 'center', gap: 8,
    paddingTop: 6, borderTop: '1px dotted var(--rule)',
  },
  chipRow: { display: 'flex', flexWrap: 'wrap', gap: 4 },
  chipMore: {
    fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
    color: 'var(--pencil-soft)', alignSelf: 'center',
  },
  formBox: {
    background: 'var(--page-elev)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 3, padding: 18, marginBottom: 24,
    display: 'flex', flexDirection: 'column', gap: 14,
  },
  formGrid: { display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 14 },
  formFoot: { display: 'flex', alignItems: 'center', gap: 10, paddingTop: 6, borderTop: '1px dotted var(--rule)' },
  field: { display: 'flex', flexDirection: 'column', gap: 4 },
  fieldLabel: {
    fontSize: 10.5, letterSpacing: '0.18em', textTransform: 'uppercase',
    color: 'var(--pencil)', fontFamily: "'JetBrains Mono', monospace",
  },
  select: {
    background: 'var(--paper)', border: '1px solid var(--rule-strong)',
    borderRadius: 2, padding: '8px 10px',
    fontFamily: "'Commissioner', sans-serif", fontSize: 13,
    color: 'var(--ink)', outline: 'none',
  },
  loading: {
    textAlign: 'center', padding: '48px 0',
    fontFamily: "'Young Serif', serif", fontStyle: 'italic',
    color: 'var(--pencil)',
  },
  empty: {
    padding: '64px 32px', textAlign: 'center',
    border: '2px dashed var(--rule-strong)', borderRadius: 4,
  },
  emptyTitle: {
    fontFamily: "'Young Serif', serif", fontSize: 18,
    color: 'var(--ink-strong)', margin: 0,
  },
  emptyHint: {
    marginTop: 10, fontSize: 13, color: 'var(--pencil)',
    fontFamily: "'Young Serif', serif", fontStyle: 'italic',
    maxWidth: '44ch', margin: '10px auto 0',
  },
  errBox: {
    padding: '12px 14px', background: 'var(--status-error-bg)',
    border: '1px solid color-mix(in oklch, var(--status-error) 30%, transparent)',
    color: 'oklch(0.40 0.130 25)', fontSize: 13, borderRadius: 2,
    marginBottom: 16, fontFamily: "'Young Serif', serif",
  },
  /* steps editor */
  stepsList: { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 8 },
  stepRow: {
    display: 'flex', gap: 10, alignItems: 'flex-start',
    background: 'var(--paper)', border: '1px solid var(--rule)',
    borderRadius: 2, padding: '8px 10px',
  },
  stepNum: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11, color: 'var(--pencil-soft)',
    paddingTop: 8, width: 22, flexShrink: 0,
  },
  stepActions: { display: 'flex', flexDirection: 'column', gap: 2 },
  stepIcon: {
    width: 22, height: 22,
    background: 'transparent', border: '1px solid var(--rule)',
    borderRadius: 2, color: 'var(--pencil)',
    fontSize: 11, lineHeight: 1, cursor: 'pointer', padding: 0,
  },
  /* trigger preview */
  triggerHint: {
    marginTop: 6, padding: '6px 10px',
    fontSize: 12, fontFamily: "'Young Serif', serif",
    background: 'var(--page-elev)',
    border: '1px dotted var(--rule-strong)', borderRadius: 2,
    display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6,
  },
  triggerOn: { color: 'var(--status-success)' },
  triggerOff: { color: 'var(--pencil)', fontStyle: 'italic' },
  probeOk: {
    color: 'var(--status-success)',
    fontFamily: "'JetBrains Mono', monospace",
  },
  triggerKw: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    background: 'color-mix(in oklch, var(--accent-ink) 12%, transparent)',
    color: 'var(--ink-strong)',
    padding: '0 6px', borderRadius: 1,
  },
};

export default IntegrationsPage;
