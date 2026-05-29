import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  smartnoteProbe, smartnoteMemories, smartnoteRetrieve, smartnoteDocuments, smartnoteTags,
  getSmartnoteApiKey, setSmartnoteApiKey,
  getSmartnoteBaseUrl, setSmartnoteBaseUrl,
  type Memory, type MemoryKind, type MemoryCreate, type MemoryPatch,
  type RetrievedMemory, type Document, type Tag,
} from '../services/smartnoteApi';
import { IconPin, IconEdit, IconTrash, IconDoc, IconPlus } from './icons';

/** Domain swatch palette — kept aligned with the create modal choices. */
const DOMAIN_COLORS = ['#6e6e6e', '#c15f3c', '#c8923f', '#3a8a5c', '#3a6f9c', '#7a5cc2', '#b14a8a'];
export function domainColor(t?: Tag | null): string {
  const c = (t?.color || '').trim();
  return c && c.startsWith('#') ? c : '#6e6e6e';
}

/* ============================================================
   Knowledge (v2) — via Smartnote Cloud.
   Tabs: 记忆 · 文档 · 搜
   ============================================================ */

type Tab = 'memories' | 'documents' | 'search';
type ConnState = 'probing' | 'ok' | 'no-key' | 'down';

const KIND_LABELS: Record<MemoryKind, string> = {
  fact: '事实',
  preference: '偏好',
  procedure: '步骤',
  episode: '回忆',
  document_ref: '文档块',
};
const KIND_TONES: Record<MemoryKind, string> = {
  fact: 'mute',
  preference: 'ok',
  procedure: 'warn',
  episode: 'soft',
  document_ref: 'soft',
};

const KnowledgeView: React.FC = () => {
  const [tab, setTab] = useState<Tab>('memories');
  const [conn, setConn] = useState<ConnState>('probing');
  const [connErr, setConnErr] = useState<string | null>(null);

  // Knowledge domains (= workspace tags). `domain` null means 全部 (no scope).
  const [domains, setDomains] = useState<Tag[]>([]);
  const [domain, setDomain] = useState<string | null>(null);
  const [domainModal, setDomainModal] = useState<Tag | 'new' | null>(null);

  const probe = useCallback(async () => {
    setConn('probing'); setConnErr(null);
    if (!getSmartnoteApiKey()) { setConn('no-key'); return; }
    try {
      const r = await smartnoteProbe();
      if (r.ok) setConn('ok');
      else { setConn('down'); setConnErr(r.error || '探测失败'); }
    } catch (e: any) {
      setConn('down'); setConnErr(e?.message || '探测失败');
    }
  }, []);

  const loadDomains = useCallback(async () => {
    try { setDomains(await smartnoteTags.list() || []); }
    catch (e) { console.warn('[v2] tags.list', e); }
  }, []);

  useEffect(() => { void probe(); }, [probe]);
  useEffect(() => { if (conn === 'ok') void loadDomains(); }, [conn, loadDomains]);

  const activeDomain = domains.find((d) => d.name === domain) || null;

  return (
    <div className="v2-view">
      <div className="v2-view-head v2-kb-head">
        <h2>知识库</h2>
        <div className="v2-kb-conn">
          <ConnDot state={conn} />
          <span>{
            conn === 'probing' ? '连接中…' :
            conn === 'ok' ? '已连接' :
            conn === 'no-key' ? '未配置 API Key' :
            conn === 'down' ? '不可达' : ''
          }</span>
        </div>
      </div>

      {conn === 'ok' && (
        <div className="v2-kb-domains">
          <button className={`v2-kb-dom${domain === null ? ' on' : ''}`} onClick={() => setDomain(null)}>全部</button>
          {domains.map((d) => (
            <button
              key={d.name}
              className={`v2-kb-dom${domain === d.name ? ' on' : ''}`}
              onClick={() => setDomain(d.name)}
              onDoubleClick={() => setDomainModal(d)}
              title="双击编辑 / 删除"
            >
              <span className="dot" style={{ background: domainColor(d) }} />{d.name}
            </button>
          ))}
          <button className="v2-kb-dom add" onClick={() => setDomainModal('new')} title="新建知识域"><IconPlus /> 域</button>
        </div>
      )}

      <div className="v2-kb-tabs-row">
        <div className="v2-kb-tabs">
          <button className={tab === 'memories' ? 'on' : ''} onClick={() => setTab('memories')}>记忆</button>
          <button className={tab === 'documents' ? 'on' : ''} onClick={() => setTab('documents')}>文档</button>
          <button className={tab === 'search' ? 'on' : ''} onClick={() => setTab('search')}>搜</button>
        </div>
        {activeDomain && (
          <span className="v2-kb-dom-hint">
            当前域：<b style={{ color: domainColor(activeDomain) }}>{activeDomain.name}</b>
            <span> — 新增内容会归到该域；闲聊里 <code>@{activeDomain.name}</code> 即可调用</span>
          </span>
        )}
      </div>

      <div className="v2-kb-body">
        {conn === 'no-key' && <NoKey onSaved={probe} />}
        {conn === 'down' && <Down err={connErr} onRetry={probe} />}
        {conn === 'probing' && <KbEmpty title="连接中…" />}
        {conn === 'ok' && tab === 'memories' && <MemoriesTab domain={domain} />}
        {conn === 'ok' && tab === 'documents' && <DocumentsTab domain={domain} domains={domains} />}
        {conn === 'ok' && tab === 'search' && <SearchTab domain={domain} />}
      </div>

      {domainModal && (
        <DomainEditModal
          tag={domainModal === 'new' ? null : domainModal}
          onClose={() => setDomainModal(null)}
          onSaved={async (savedName, removed) => {
            setDomainModal(null);
            await loadDomains();
            if (removed && domain === savedName) setDomain(null);
            else if (savedName) setDomain(savedName);
          }}
        />
      )}
    </div>
  );
};

/* ============ Domain (knowledge area) create / edit ============ */

const DomainEditModal: React.FC<{
  tag: Tag | null;
  onClose: () => void;
  onSaved: (name: string | null, removed?: boolean) => void | Promise<void>;
}> = ({ tag, onClose, onSaved }) => {
  const [name, setName] = useState(tag?.name || '');
  const [desc, setDesc] = useState(tag?.description || '');
  const [color, setColor] = useState(domainColor(tag));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async () => {
    const nm = name.trim();
    if (!nm) { window.alert('域名不能空'); return; }
    setBusy(true);
    try {
      await smartnoteTags.upsert({ name: nm, description: desc.trim(), color, sort_order: tag?.sort_order ?? 0 });
      await onSaved(nm);
    } catch (e: any) { window.alert(e?.message || '保存失败'); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!tag) return;
    if (!window.confirm(`删除知识域「${tag.name}」？\n\n域里的记忆/文档不会被删，只是去掉归属标签。`)) return;
    setBusy(true);
    try { await smartnoteTags.remove(tag.name); await onSaved(tag.name, true); }
    catch (e: any) { window.alert(e?.message || '删除失败'); }
    finally { setBusy(false); }
  };

  return (
    <div className="v2-modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="v2-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="v2-modal-hd">
          <h3>{tag ? '编辑知识域' : '新建知识域'}</h3>
          <button className="x" onClick={onClose}>✕</button>
        </div>
        <div className="v2-modal-body">
          <div className="v2-modal-sec">
            <div className="lab">别名（域名）</div>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：东方玄学" disabled={!!tag}
              title={tag ? '已存在的域名不能改（它是检索标识）；要改名请新建' : ''} />
            <div className="v2-modal-note">这个名字就是聊天里 <code>@{name.trim() || '域名'}</code> 调用时用的标识。</div>
          </div>
          <div className="v2-modal-sec">
            <div className="lab">说明（可选）</div>
            <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="这个域装什么" />
          </div>
          <div className="v2-modal-sec">
            <div className="lab">颜色</div>
            <div className="v2-kb-swatches">
              {DOMAIN_COLORS.map((c) => (
                <button key={c} className={`v2-kb-swatch${color === c ? ' on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} />
              ))}
            </div>
          </div>
        </div>
        <div className="v2-modal-foot">
          {tag && <button className="v2-mbtn" style={{ color: 'var(--c-danger)', marginRight: 'auto' }} onClick={() => void remove()} disabled={busy}>删除</button>}
          <button className="v2-mbtn" onClick={onClose} disabled={busy}>取消</button>
          <button className="v2-mbtn primary" onClick={() => void save()} disabled={busy}>{busy ? '保存中…' : '保存'}</button>
        </div>
      </div>
    </div>
  );
};

/* ============ Memories ============ */

const MemoriesTab: React.FC<{ domain: string | null }> = ({ domain }) => {
  const [list, setList] = useState<Memory[] | null>(null);
  const [kindFilter, setKindFilter] = useState<MemoryKind | 'all'>('all');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Memory | 'new' | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: any = { limit: 200 };
      if (kindFilter !== 'all') params.kind = kindFilter;
      if (q.trim()) params.q = q.trim();
      if (domain) params.tag = domain; // scope to the active knowledge domain
      const res = await smartnoteMemories.list(params);
      setList(res.memories || []);
    } catch (e) {
      console.warn('[v2] memories.list', e);
      setList([]);
    } finally { setLoading(false); }
  }, [kindFilter, q, domain]);

  useEffect(() => { void load(); }, [load]);

  const onPin = async (m: Memory) => {
    try { await smartnoteMemories.update(m.id, { pinned: !m.pinned }); void load(); }
    catch (e: any) { window.alert(e?.message || '失败'); }
  };
  const onDelete = async (m: Memory) => {
    if (!window.confirm(`删除这条记忆？\n\n${m.content.slice(0, 80)}…`)) return;
    try { await smartnoteMemories.remove(m.id); void load(); }
    catch (e: any) { window.alert(e?.message || '失败'); }
  };

  return (
    <>
      <div className="v2-kb-toolbar">
        <div className="v2-kb-filters">
          <button className={`v2-kb-pill${kindFilter === 'all' ? ' on' : ''}`} onClick={() => setKindFilter('all')}>全部</button>
          {(Object.keys(KIND_LABELS) as MemoryKind[]).map((k) => (
            <button
              key={k}
              className={`v2-kb-pill${kindFilter === k ? ' on' : ''}`}
              onClick={() => setKindFilter(k)}
            >
              {KIND_LABELS[k]}
            </button>
          ))}
        </div>
        <div className="v2-kb-search">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="过滤记忆…（按 Enter 提交）" onKeyDown={(e) => { if (e.key === 'Enter') void load(); }} />
        </div>
        <button className="v2-set-btn primary" onClick={() => setEditing('new')}>＋ 新记忆</button>
      </div>

      {loading && !list && <KbEmpty title="加载中…" />}
      {list && list.length === 0 && <KbEmpty title="还没有记忆" hint="点右上「＋ 新记忆」加一条，或在文档里 ingest。" />}
      {list && list.length > 0 && (
        <div className="v2-kb-list">
          {list.map((m) => (
            <MemoryRowMemo
              key={m.id}
              m={m}
              onPin={onPin}
              onEdit={setEditing as (m: Memory) => void}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}

      {editing && (
        <MemoryEditModal
          memory={editing === 'new' ? null : editing}
          domain={editing === 'new' ? domain : null}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); }}
        />
      )}
    </>
  );
};

/** Row receives an `m` plus per-action callbacks that take `m` directly. The
 *  parent no longer creates `() => void onPin(m)` per render; identity stays
 *  stable across re-renders so React.memo actually skips the work for the
 *  98 rows that didn't change when one was pinned. */
interface MemoryRowProps {
  m: Memory;
  onPin: (m: Memory) => void;
  onEdit: (m: Memory) => void;
  onDelete: (m: Memory) => void;
}
const MemoryRow: React.FC<MemoryRowProps> = ({ m, onPin, onEdit, onDelete }) => (
  <div className={`v2-kb-card${m.pinned ? ' pinned' : ''}`}>
    <div className="hd">
      <span className={`v2-pill ${KIND_TONES[m.kind]}`}>{KIND_LABELS[m.kind]}</span>
      {m.scope && m.scope !== 'workspace' && <span className="v2-pill mute">scope: {m.scope}</span>}
      {m.tags?.slice(0, 3).map((t) => <span key={t} className="v2-pill mute">#{t}</span>)}
      {m.tags && m.tags.length > 3 && <span className="v2-pill mute" title={m.tags.slice(3).map((t) => `#${t}`).join(' ')}>+{m.tags.length - 3}</span>}
      <span className="grow" />
      <div className="acts">
        <button className={`iconbtn${m.pinned ? ' on' : ''}`} title={m.pinned ? '取消置顶' : '置顶'} onClick={() => onPin(m)}><IconPin filled={m.pinned} /></button>
        <button className="iconbtn" title="编辑" onClick={() => onEdit(m)}><IconEdit /></button>
        <button className="iconbtn danger" title="删除" onClick={() => onDelete(m)}><IconTrash /></button>
      </div>
    </div>
    <ExpandableBody text={m.content} lines={5} />
    <div className="ft">
      <span>{new Date(m.created_at).toLocaleString('zh-CN', { hour12: false })}</span>
      <span>by {m.author_agent || 'unknown'}</span>
    </div>
  </div>
);
const MemoryRowMemo = React.memo(MemoryRow);

const MemoryEditModal: React.FC<{
  memory: Memory | null;
  domain?: string | null;
  onClose: () => void;
  onSaved: () => void;
}> = ({ memory, domain, onClose, onSaved }) => {
  const [kind, setKind] = useState<MemoryKind>(memory?.kind || 'fact');
  const [content, setContent] = useState(memory?.content || '');
  const [scope, setScope] = useState(memory?.scope || 'workspace');
  // New memory under a domain → seed its tag so it's retrievable via @domain.
  const [tagsStr, setTagsStr] = useState(
    (memory?.tags || (domain ? [domain] : [])).join(', '),
  );
  const [pinned, setPinned] = useState(!!memory?.pinned);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async () => {
    if (!content.trim()) { window.alert('内容不能空'); return; }
    setBusy(true);
    const tags = tagsStr.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
    try {
      if (memory) {
        const patch: MemoryPatch = { content: content.trim(), scope, tags, pinned };
        await smartnoteMemories.update(memory.id, patch);
      } else {
        const body: MemoryCreate = { kind, content: content.trim(), scope, tags, pinned };
        await smartnoteMemories.create(body);
      }
      onSaved();
    } catch (e: any) {
      window.alert(e?.message || '保存失败');
    } finally { setBusy(false); }
  };

  return (
    <div className="v2-modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="v2-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="v2-modal-hd">
          <h3>{memory ? '编辑记忆' : '新记忆'}</h3>
          <button className="x" onClick={onClose}>✕</button>
        </div>
        <div className="v2-modal-body">
          <div className="v2-modal-sec">
            <div className="lab">类型</div>
            <div className="v2-options">
              {(Object.keys(KIND_LABELS) as MemoryKind[]).map((k) => (
                <div
                  key={k}
                  className={`v2-opt${kind === k ? ' active' : ''}`}
                  onClick={() => !memory && setKind(k)}
                  style={memory ? { opacity: 0.6, cursor: 'not-allowed' } : undefined}
                  title={memory ? '已存的记忆不能改类型' : ''}
                >
                  <span>{KIND_LABELS[k]}</span><small>{k.toUpperCase()}</small>
                </div>
              ))}
            </div>
          </div>
          <div className="v2-modal-sec">
            <div className="lab">内容</div>
            <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={6} placeholder="写下要记住的事实、偏好、步骤…" />
          </div>
          <div className="v2-modal-sec">
            <div className="lab">Scope</div>
            <input value={scope} onChange={(e) => setScope(e.target.value)} placeholder="workspace · agent:<id> · …" />
            <div className="v2-modal-note">默认 workspace（所有 agent 共享）；要私有化用 <code>agent:&lt;agentId&gt;</code></div>
          </div>
          <div className="v2-modal-sec">
            <div className="lab">标签</div>
            <input value={tagsStr} onChange={(e) => setTagsStr(e.target.value)} placeholder="用逗号或空格分隔" />
          </div>
          <div className="v2-modal-sec">
            <div className="v2-set-row" style={{ padding: 0 }}>
              <div className="v2-set-row-l"><div className="lab">置顶</div><div className="sub">优先用于检索结果</div></div>
              <button className={`v2-switch${pinned ? ' on' : ''}`} onClick={() => setPinned(!pinned)}><span className="thumb" /></button>
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

/* ============ Documents ============ */

/** Read the domain list a document was filed under (metadata.domains[]). */
function docDomains(d: Document): string[] {
  const md: any = d.metadata || {};
  if (Array.isArray(md.domains)) return md.domains.map((x: any) => String(x));
  if (md.domain) return [String(md.domain)];
  return [];
}

const DocumentsTab: React.FC<{ domain: string | null; domains: Tag[] }> = ({ domain, domains }) => {
  const [list, setList] = useState<Document[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [editingDoc, setEditingDoc] = useState<Document | null>(null);

  const load = useCallback(async () => {
    try { const r = await smartnoteDocuments.list(); setList(r.documents || []); }
    catch (e) { console.warn('[v2] documents.list', e); setList([]); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // Domain filter is client-side: the list endpoint has no tag filter, but each
  // doc carries its domains in metadata.
  const shown = list && (domain ? list.filter((d) => docDomains(d).includes(domain)) : list);

  const onIngest = async (d: Document) => {
    setBusy(d.id);
    try {
      const r = await smartnoteDocuments.ingest(d.id);
      window.alert(`已切成 ${r.chunks} 块进库`);
      void load();
    } catch (e: any) { window.alert(e?.message || 'ingest 失败'); }
    finally { setBusy(null); }
  };

  return (
    <>
      <div className="v2-kb-toolbar">
        <div className="v2-kb-filters" style={{ flex: 1 }} />
        <button className="v2-set-btn primary" onClick={() => setUploadOpen(true)}>＋ 新文档</button>
      </div>
      {!shown && <KbEmpty title="加载中…" />}
      {shown && shown.length === 0 && (
        <KbEmpty title={domain ? `「${domain}」域里还没有文档` : '还没有文档'} hint="贴段文字进来 → 切块 → 入记忆库。切块时会带上域标签。" />
      )}
      {shown && shown.length > 0 && (
        <div className="v2-kb-list even">
          {shown.map((d) => (
            <div key={d.id} className="v2-kb-card">
              <div className="hd">
                <span className="v2-pill">{d.kind || 'text'}</span>
                <span className="v2-pill mute">{formatBytes(d.byte_size)}</span>
                {d.ingested_at
                  ? <span className="v2-pill ok">已切块</span>
                  : <span className="v2-pill warn">待切块</span>}
                {docDomains(d).map((dm) => <span key={dm} className="v2-pill soft">@{dm}</span>)}
                <span className="grow" />
                <button className="iconbtn" title="配置知识域" onClick={() => setEditingDoc(d)}><IconEdit /></button>
                {!d.ingested_at && (
                  <button className="v2-set-btn" disabled={busy === d.id} onClick={() => void onIngest(d)}>
                    {busy === d.id ? '处理中…' : '切块入库'}
                  </button>
                )}
              </div>
              <div className="body doc-name"><span className="doc-ic"><IconDoc /></span>{d.name}</div>
              <div className="ft">
                <span>新建 {new Date(d.created_at).toLocaleString('zh-CN', { hour12: false })}</span>
                {d.ingested_at && <span>ingest {new Date(d.ingested_at).toLocaleString('zh-CN', { hour12: false })}</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {uploadOpen && (
        <DocumentCreateModal domain={domain} onClose={() => setUploadOpen(false)} onCreated={() => { setUploadOpen(false); void load(); }} />
      )}

      {editingDoc && (
        <DocumentDomainsModal
          doc={editingDoc}
          domains={domains}
          onClose={() => setEditingDoc(null)}
          onSaved={() => { setEditingDoc(null); void load(); }}
        />
      )}
    </>
  );
};

/** Assign/unassign knowledge domains on an existing document. Patching
 *  metadata.domains re-tags the doc's chunks in place (cloud-side), so an old
 *  already-ingested book becomes reachable via `@域` without re-chunking. */
const DocumentDomainsModal: React.FC<{
  doc: Document;
  domains: Tag[];
  onClose: () => void;
  onSaved: () => void;
}> = ({ doc, domains, onClose, onSaved }) => {
  const [picked, setPicked] = useState<string[]>(docDomains(doc));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggle = (name: string) =>
    setPicked((p) => p.includes(name) ? p.filter((x) => x !== name) : [...p, name]);

  const save = async () => {
    setBusy(true);
    try {
      // metadata REPLACES the stored object → merge, only overriding domains.
      const meta: Record<string, unknown> = { ...(doc.metadata || {}) };
      if (picked.length) meta.domains = picked; else delete meta.domains;
      delete (meta as any).domain; // collapse legacy single-domain field into domains
      await smartnoteDocuments.patch(doc.id, { metadata: meta });
      onSaved();
    } catch (e: any) { window.alert(e?.message || '保存失败'); }
    finally { setBusy(false); }
  };

  return (
    <div className="v2-modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="v2-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="v2-modal-hd">
          <h3>配置知识域</h3>
          <button className="x" onClick={onClose}>✕</button>
        </div>
        <div className="v2-modal-body">
          <div className="v2-modal-sec">
            <div className="lab">文档</div>
            <div className="v2-modal-note" style={{ marginTop: 2 }}>{doc.name}</div>
          </div>
          <div className="v2-modal-sec">
            <div className="lab">归属域（可多选）</div>
            {domains.length === 0 ? (
              <div className="v2-modal-note">还没有知识域。先在上方「＋ 域」新建一个。</div>
            ) : (
              <div className="v2-kb-domains" style={{ padding: 0, border: 'none' }}>
                {domains.map((d) => (
                  <button
                    key={d.name}
                    className={`v2-kb-dom${picked.includes(d.name) ? ' on' : ''}`}
                    onClick={() => toggle(d.name)}
                  >
                    <span className="dot" style={{ background: domainColor(d) }} />{d.name}
                  </button>
                ))}
              </div>
            )}
            <div className="v2-modal-note">
              {doc.ingested_at
                ? <>保存后，已切块的内容会即时重新打上所选域标签，<code>@域</code> 立即可检索到——无需重新切块。</>
                : <>这份文档还没切块。配置好域后点「切块入库」，切出的块会带上所选域标签。</>}
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

const DocumentCreateModal: React.FC<{ domain: string | null; onClose: () => void; onCreated: () => void }> = ({ domain, onClose, onCreated }) => {
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onPickFile = async (file: File) => {
    if (!name.trim()) setName(file.name);
    const txt = await file.text();
    setContent(txt);
  };

  const save = async () => {
    if (!name.trim() || !content.trim()) { window.alert('名字和内容都要填'); return; }
    setBusy(true);
    try {
      await smartnoteDocuments.create({
        name: name.trim(),
        content: content.trim(),
        // Filed under the active domain → ingest stamps the chunks with this
        // tag (patched cloud), so @domain retrieval reaches the book content.
        metadata: domain ? { domains: [domain] } : undefined,
      });
      onCreated();
    } catch (e: any) { window.alert(e?.message || '失败'); }
    finally { setBusy(false); }
  };

  return (
    <div className="v2-modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="v2-modal wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="v2-modal-hd">
          <h3>新文档</h3>
          <button className="x" onClick={onClose}>✕</button>
        </div>
        <div className="v2-modal-body">
          <div className="v2-modal-sec">
            <div className="lab">名字</div>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：产品介绍.md" />
          </div>
          <div className="v2-modal-sec">
            <div className="lab" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>正文</span>
              <button className="v2-set-btn" style={{ marginLeft: 'auto' }} onClick={() => fileRef.current?.click()}>从文件读…</button>
              <input ref={fileRef} type="file" accept=".txt,.md,.markdown,.text,.rst,.org,.html" style={{ display: 'none' }}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void onPickFile(f); e.target.value = ''; }} />
            </div>
            <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={14} placeholder="贴文本或从文件读…" />
            <div className="v2-modal-note">
              {domain
                ? <>将归入知识域 <b>@{domain}</b>。保存后点「切块入库」，切出的块会带上该域标签，<code>@{domain}</code> 即可检索到。</>
                : <>未选域（全部）。保存后点「切块入库」让 Smartnote 切块并嵌入；如需 <code>@域</code> 调用，请先在上方选一个域再上传。</>}
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

/* ============ Search ============ */

const SearchTab: React.FC<{ domain: string | null }> = ({ domain }) => {
  const [q, setQ] = useState('');
  const [kinds, setKinds] = useState<MemoryKind[]>([]);
  const [topk, setTopk] = useState(8);
  const [scope, setScope] = useState('');
  const [results, setResults] = useState<RetrievedMemory[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<{ vectorOk?: boolean } | null>(null);

  const search = async () => {
    if (!q.trim()) return;
    setBusy(true);
    try {
      const r = await smartnoteRetrieve({
        query: q.trim(),
        kinds: kinds.length ? kinds : undefined,
        topk,
        scope: scope.trim() || undefined,
        tags: domain ? [domain] : undefined, // scope search to the active domain
      });
      setResults(r.results || []);
      setInfo({ vectorOk: r.query_embedded });
    } catch (e: any) {
      window.alert(e?.message || '检索失败');
    } finally { setBusy(false); }
  };

  const toggleKind = (k: MemoryKind) => setKinds((p) => p.includes(k) ? p.filter((x) => x !== k) : [...p, k]);

  return (
    <>
      <div className="v2-kb-search-bar">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void search(); }}
          placeholder="问点什么…  (Enter 检索)"
          autoFocus
        />
        <button className="v2-set-btn primary" onClick={() => void search()} disabled={busy || !q.trim()}>
          {busy ? '检索中…' : '检索'}
        </button>
      </div>
      <div className="v2-kb-toolbar">
        <div className="v2-kb-filters">
          {(Object.keys(KIND_LABELS) as MemoryKind[]).map((k) => (
            <button
              key={k}
              className={`v2-kb-pill${kinds.includes(k) ? ' on' : ''}`}
              onClick={() => toggleKind(k)}
            >
              {KIND_LABELS[k]}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: 'var(--c-ink-3)' }}>topK</span>
          <select className="v2-set-select" value={topk} onChange={(e) => setTopk(Number(e.target.value))}>
            {[3, 5, 8, 12, 20].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <input className="v2-set-select" style={{ minWidth: 140 }} value={scope} onChange={(e) => setScope(e.target.value)} placeholder="scope (可选)" />
        </div>
      </div>

      {info && info.vectorOk === false && (
        <div className="v2-kb-warn">向量检索不可用，已 fallback 到关键词。</div>
      )}

      {!results && <KbEmpty title="还没有检索" hint="上面输入要找的内容，Enter 提交。" />}
      {results && results.length === 0 && <KbEmpty title="没找到" hint="换个关键词或加大 topK。" />}
      {results && results.length > 0 && (
        <div className="v2-kb-list">
          {results.map((r) => (
            <div key={r.id} className="v2-kb-card">
              <div className="hd">
                <span className={`v2-pill ${KIND_TONES[r.kind as MemoryKind] || 'mute'}`}>{KIND_LABELS[r.kind as MemoryKind] || r.kind}</span>
                {r.pinned && <span className="v2-pill ok">★ 置顶</span>}
                {r.tags?.slice(0, 3).map((t) => <span key={t} className="v2-pill mute">#{t}</span>)}
                {r.tags && r.tags.length > 3 && <span className="v2-pill mute" title={r.tags.slice(3).map((t) => `#${t}`).join(' ')}>+{r.tags.length - 3}</span>}
              </div>
              <ExpandableBody text={r.content} lines={4} />
              <div className="ft">
                <span className="v2-kb-score">
                  {r.score.toFixed(2)}
                  {r.vector_score > 0 && ` · 向量 ${r.vector_score.toFixed(2)}`}
                  {r.lexical_score > 0 && ` · 词 ${r.lexical_score.toFixed(2)}`}
                </span>
                <span className="grow" />
                <span>by {r.author_agent || 'unknown'}</span>
                <span>{new Date(r.created_at).toLocaleString('zh-CN', { hour12: false })}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
};

/* ============ small bits ============ */

/** Card body that clamps long text to `lines`, fading the cut, and reveals an
 *  inline 展开/收起 only when the content actually overflows. Cards grow to fit
 *  short content, so nothing is hard-cut or pushed past the viewport. */
const ExpandableBody: React.FC<{ text: string; lines?: number }> = ({ text, lines = 5 }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || expanded) return; // while expanded keep the toggle; remeasure on collapse
    const check = () => setOverflowing(el.scrollHeight - el.clientHeight > 2);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, expanded]);

  const clamped = !expanded;
  return (
    <>
      <div
        className={`v2-kb-body-wrap${clamped ? ' clamped' : ''}${clamped && overflowing ? ' has-more' : ''}`}
        style={{ ['--kb-clamp' as any]: lines }}
      >
        <div ref={ref} className="body">{text}</div>
      </div>
      {overflowing && (
        <button className="v2-kb-expand" onClick={() => setExpanded((e) => !e)}>
          {expanded ? '收起' : '展开'}
        </button>
      )}
    </>
  );
};

const ConnDot: React.FC<{ state: ConnState }> = ({ state }) => {
  const color =
    state === 'ok' ? 'var(--c-success)' :
    state === 'probing' ? 'var(--c-warn)' :
    state === 'no-key' ? 'var(--c-ink-4)' :
    'var(--c-danger)';
  return <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block', flex: '0 0 auto' }} />;
};

const KbEmpty: React.FC<{ title: string; hint?: string }> = ({ title, hint }) => (
  <div className="v2-kb-empty">
    <div className="t">{title}</div>
    {hint && <div className="h">{hint}</div>}
  </div>
);

const NoKey: React.FC<{ onSaved: () => void | Promise<void> }> = ({ onSaved }) => {
  const [key, setKey] = useState(getSmartnoteApiKey());
  const [base, setBase] = useState(getSmartnoteBaseUrl());
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!key.trim()) return;
    setBusy(true);
    setSmartnoteBaseUrl(base.trim());
    setSmartnoteApiKey(key.trim());
    try { await onSaved(); } finally { setBusy(false); }
  };
  return (
    <div className="v2-kb-empty" style={{ paddingTop: 40 }}>
      <div className="t">配置 Smartnote 凭据</div>
      <div className="h">把你的 API Key 填进去，知识库 / 记忆 / RAG 就都能用了。</div>
      <div style={{ maxWidth: 420, margin: '24px auto 0', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div>
          <div style={{ fontSize: 11.5, color: 'var(--c-ink-3)', marginBottom: 4 }}>API Key</div>
          <input
            type="password" value={key} onChange={(e) => setKey(e.target.value)}
            placeholder="sn_…"
            style={{ width: '100%', padding: '10px 12px', borderRadius: 10, background: 'var(--c-surface)', fontSize: 14, border: '1px solid var(--c-rule)' }}
          />
        </div>
        <div>
          <div style={{ fontSize: 11.5, color: 'var(--c-ink-3)', marginBottom: 4 }}>Base URL <span style={{ color: 'var(--c-ink-4)' }}>(留空用默认)</span></div>
          <input
            value={base} onChange={(e) => setBase(e.target.value)}
            placeholder="https://api.smartnote.cloud"
            style={{ width: '100%', padding: '10px 12px', borderRadius: 10, background: 'var(--c-surface)', fontSize: 14, border: '1px solid var(--c-rule)' }}
          />
        </div>
        <button
          className="v2-set-btn primary"
          onClick={() => void save()}
          disabled={busy || !key.trim()}
          style={{ marginTop: 6 }}
        >{busy ? '验证中…' : '保存并连接'}</button>
        <div style={{ fontSize: 12, color: 'var(--c-ink-4)', textAlign: 'center', marginTop: 4 }}>
          也能在 设置 · 知识/RAG 里改。
        </div>
      </div>
    </div>
  );
};

const Down: React.FC<{ err: string | null; onRetry: () => void | Promise<void> }> = ({ err, onRetry }) => (
  <div className="v2-kb-empty">
    <div className="t">Smartnote 不可达</div>
    <div className="h">{err || '连不上知识库服务。'}</div>
    <div style={{ marginTop: 12 }}>
      <button className="v2-set-btn primary" onClick={() => void onRetry()}>重试</button>
    </div>
  </div>
);

function formatBytes(n: number): string {
  if (!n || n < 1024) return `${n || 0} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default KnowledgeView;
