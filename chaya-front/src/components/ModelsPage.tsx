import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getLLMConfigs, deleteLLMConfig, updateLLMConfig, getLLMConfigApiKey,
  type LLMConfigFromDB,
} from '../services/llmApi';
import { toast } from './ui/use-toast';
import {
  PaperPage, PaperTopbar, PaperContent, PaperButton, PaperChip, PaperDot, PaperInput,
} from './paper';

/* ============================================================
   模型 / Providers & Models — aligned with mockups/a-llm-configs.html
   ============================================================ */

type Provider = LLMConfigFromDB['provider'];

const PROVIDER_META: Record<Provider, { glyph: string; label: string; flavor: string }> = {
  openai:    { glyph: 'O', label: 'OpenAI',       flavor: '— 主力' },
  anthropic: { glyph: 'A', label: 'Anthropic',    flavor: '— 写长东西' },
  gemini:    { glyph: 'G', label: 'Google Gemini', flavor: '— 看图用' },
  deepseek:  { glyph: 'D', label: 'DeepSeek',     flavor: '— 便宜好用' },
  ollama:    { glyph: 'L', label: 'Ollama',       flavor: '— 本地' },
  local:     { glyph: 'L', label: '本地',          flavor: '— Self-hosted' },
  custom:    { glyph: '·', label: '自定义',        flavor: '— Custom' },
};

interface ProviderGroup {
  provider: Provider;
  configs: LLMConfigFromDB[];
  active: number;
  hasKey: boolean;
}

const ModelsPage: React.FC = () => {
  const [configs, setConfigs] = useState<LLMConfigFromDB[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<Provider | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [revealKey, setRevealKey] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const list = await getLLMConfigs();
      setConfigs(list);
      if (!selectedProvider && list.length > 0) setSelectedProvider(list[0].provider);
    } catch (e: any) {
      setErr(e?.message || '取模型配置时出错');
    } finally {
      setLoading(false);
    }
  }, [selectedProvider]);

  useEffect(() => { void load(); /* eslint-disable-next-line */ }, []);

  const groups: ProviderGroup[] = useMemo(() => {
    const map = new Map<Provider, ProviderGroup>();
    for (const c of configs) {
      const g = map.get(c.provider) || { provider: c.provider, configs: [], active: 0, hasKey: false };
      g.configs.push(c);
      if (c.enabled) g.active += 1;
      if (c.provider === 'ollama' || c.provider === 'local') g.hasKey = true;
      map.set(c.provider, g);
    }
    return Array.from(map.values()).sort((a, b) => b.active - a.active);
  }, [configs]);

  const selectedGroup = groups.find((g) => g.provider === selectedProvider) || groups[0];
  const selectedConfig = selectedGroup?.configs[0];

  const revealApiKey = async () => {
    if (!selectedConfig) return;
    try {
      const key = await getLLMConfigApiKey(selectedConfig.config_id);
      setSelectedKey(key);
      setRevealKey(true);
    } catch (e: any) {
      toast({ title: '取不到 key', description: e?.message || '', variant: 'destructive' });
    }
  };

  const toggleEnabled = async (cfg: LLMConfigFromDB) => {
    setSaving(true);
    try {
      await updateLLMConfig(cfg.config_id, { enabled: !cfg.enabled });
      await load();
    } catch (e: any) {
      toast({ title: '切换失败', description: e?.message || '', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const removeConfig = async (cfg: LLMConfigFromDB) => {
    if (!confirm(`真的要删掉「${cfg.shortname || cfg.name}」吗？`)) return;
    setSaving(true);
    try {
      await deleteLLMConfig(cfg.config_id);
      await load();
      toast({ title: '删了', variant: 'success' });
    } catch (e: any) {
      toast({ title: '删不掉', description: e?.message || '', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <PaperPage>
      <PaperTopbar
        crumb="Chapter Three · Providers & Models"
        title="模型"
        subtitle="你接的每个 provider 都是一家笔墨店。你的 agents 从这里挑笔写字。"
        meta={loading ? '正在取…' : `${groups.length} 家 · ${configs.length} 款`}
        actions={<PaperButton>+ 接一家</PaperButton>}
      />

      <PaperContent>
        <p style={s.intro}>
          每个 agent 都要选一款模型来说话。<em style={s.introEm}>贵的细腻，便宜的飞快。</em>
          &nbsp;给日常聊天用便宜的，给重要的事用贵的。
        </p>

        {err && <div style={s.errBox}>{err}</div>}

        {loading && groups.length === 0 ? (
          <Loading />
        ) : groups.length === 0 ? (
          <EmptyState />
        ) : (
          <div style={s.layout}>
            <div style={s.providerCol}>
              {groups.map((g) => {
                const selected = g.provider === selectedProvider;
                const meta = PROVIDER_META[g.provider];
                const m = g.configs[0];
                return (
                  <article
                    key={g.provider}
                    style={{ ...s.provider, ...(selected ? s.providerSel : null) }}
                    onClick={() => { setSelectedProvider(g.provider); setRevealKey(false); setSelectedKey(null); }}
                  >
                    <div style={s.pGlyph}>{meta.glyph}</div>
                    <div style={s.pBody}>
                      <div>
                        <span style={s.pName}>{meta.label}</span>
                        <span style={s.pAlias}>{meta.flavor}</span>
                      </div>
                      <div style={s.pDesc}>
                        {m?.description || `已接 ${g.configs.length} 个配置${g.active > 0 ? ` · ${g.active} 个启用` : ''}`}
                      </div>
                      <div style={s.pChips}>
                        {g.configs.slice(0, 5).map((c) => (
                          <PaperChip key={c.config_id} tone={c.enabled ? 'default' : 'soft'}>
                            {c.shortname || c.model || c.name}
                          </PaperChip>
                        ))}
                        {g.configs.length > 5 && <PaperChip tone="soft">+{g.configs.length - 5}</PaperChip>}
                      </div>
                    </div>
                    <div style={s.pRight}>
                      {g.provider === 'ollama' || g.provider === 'local' ? (
                        <PaperChip tone="soft">本地</PaperChip>
                      ) : g.active > 0 ? (
                        <PaperChip tone="ok"><PaperDot tone="ok" /> 已接</PaperChip>
                      ) : (
                        <PaperChip tone="warn">待配</PaperChip>
                      )}
                      <span style={s.pKey}>
                        {g.configs.length} 个配置
                      </span>
                    </div>
                  </article>
                );
              })}
            </div>

            <aside style={s.detail}>
              {selectedGroup && selectedConfig ? (
                <>
                  <div style={s.dLabel}>当前选中</div>
                  <h3 style={s.dTitle}>{PROVIDER_META[selectedGroup.provider].label}</h3>
                  <div style={s.dSub}>{PROVIDER_META[selectedGroup.provider].flavor}</div>

                  <hr style={s.hr} />

                  <div style={s.field}>
                    <div style={s.fieldLabel}>名字 (shortname)</div>
                    <div style={s.fieldVal}>{selectedConfig.shortname || selectedConfig.name}</div>
                  </div>

                  <div style={s.field}>
                    <div style={s.fieldLabelRow}>
                      <span style={s.fieldLabel}>API Key</span>
                      {!revealKey && selectedConfig.provider !== 'ollama' && (
                        <button style={s.revealBtn} onClick={revealApiKey} type="button">看一眼</button>
                      )}
                    </div>
                    <PaperInput
                      mono
                      readOnly
                      value={
                        selectedConfig.provider === 'ollama' || selectedConfig.provider === 'local'
                          ? 'localhost (无需 key)'
                          : revealKey && selectedKey
                            ? selectedKey
                            : 'sk-·························'
                      }
                      style={{ width: '100%' }}
                    />
                  </div>

                  <div style={s.field}>
                    <div style={s.fieldLabel}>API URL</div>
                    <PaperInput mono readOnly value={selectedConfig.api_url || '(默认)'} style={{ width: '100%' }} />
                  </div>

                  <hr style={s.hr} />

                  <div style={s.fieldLabel}>可用模型</div>
                  <div style={s.modelList}>
                    {selectedGroup.configs.map((c) => (
                      <div key={c.config_id} style={s.modelRow}>
                        <div style={s.mInfo}>
                          <div style={s.mName}>{c.shortname || c.model || c.name}</div>
                          {c.max_tokens && (
                            <div style={s.mMeta}>{Math.round(c.max_tokens / 1000)}k ctx</div>
                          )}
                        </div>
                        <div style={s.mActions}>
                          <PaperButton
                            variant="ghost"
                            size="small"
                            disabled={saving}
                            onClick={() => void toggleEnabled(c)}
                          >
                            {c.enabled ? '关' : '开'}
                          </PaperButton>
                          <PaperButton
                            variant="link"
                            size="small"
                            danger
                            disabled={saving}
                            onClick={() => void removeConfig(c)}
                          >
                            删
                          </PaperButton>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div style={{ marginTop: 20, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <PaperButton variant="ghost" size="small">测一下</PaperButton>
                    <PaperButton size="small">改</PaperButton>
                  </div>
                </>
              ) : (
                <p style={s.dEmpty}>选一家 provider 看详情。</p>
              )}
            </aside>
          </div>
        )}
      </PaperContent>
    </PaperPage>
  );
};

const Loading: React.FC = () => (
  <div style={s.loading}>
    <p style={{ fontFamily: "'Young Serif', serif", fontStyle: 'italic', color: 'var(--pencil)' }}>正在取模型…</p>
  </div>
);

const EmptyState: React.FC = () => (
  <div style={s.empty}>
    <div style={{ fontFamily: "'Young Serif', serif", fontSize: 40, color: 'var(--accent-ink)', lineHeight: 1, marginBottom: 12 }}>＋</div>
    <h3 style={s.emptyTitle}>还没接 provider</h3>
    <p style={s.emptyHint}>
      点右上「+ 接一家」开始。OpenAI、Anthropic、Gemini、Ollama（本地）都可以。
    </p>
  </div>
);

const s: Record<string, React.CSSProperties> = {
  intro: {
    maxWidth: '60ch',
    marginBottom: 28,
    fontSize: 13.5,
    color: 'var(--pencil)',
    lineHeight: 1.7,
  },
  introEm: {
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    color: 'var(--marginalia-ink)',
  },
  errBox: {
    padding: '12px 14px',
    background: 'var(--status-error-bg)',
    border: '1px solid color-mix(in oklch, var(--status-error) 30%, transparent)',
    color: 'oklch(0.40 0.130 25)',
    fontSize: 13,
    borderRadius: 2,
    marginBottom: 20,
    fontFamily: "'Young Serif', serif",
  },
  layout: {
    display: 'grid',
    gridTemplateColumns: '1fr 320px',
    gap: 36,
    alignItems: 'start',
  },
  providerCol: {
    display: 'flex',
    flexDirection: 'column',
  },
  provider: {
    display: 'grid',
    gridTemplateColumns: '56px 1fr auto',
    gap: 18,
    alignItems: 'flex-start',
    padding: '20px 8px',
    borderTop: '1px solid var(--rule)',
    cursor: 'pointer',
    transition: 'background 180ms cubic-bezier(0.22,1,0.36,1)',
  },
  providerSel: {
    background: 'color-mix(in oklch, var(--accent-ink) 7%, transparent)',
    boxShadow: 'inset 2px 0 0 var(--accent-ink)',
  },
  pGlyph: {
    width: 48,
    height: 48,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: "'Young Serif', 'LXGW WenKai', ui-serif, serif",
    fontSize: 20,
    color: 'var(--accent-ink)',
    background: 'var(--page-elev)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    boxShadow: 'inset 0 0 0 2px var(--page-elev), inset 0 0 0 3px var(--accent-ink)',
  },
  pBody: { minWidth: 0 },
  pName: {
    fontFamily: "'Young Serif', serif",
    fontSize: 17,
    color: 'var(--ink-strong)',
  },
  pAlias: {
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    fontSize: 12.5,
    color: 'var(--pencil)',
    marginLeft: 6,
  },
  pDesc: {
    fontSize: 12.5,
    color: 'var(--pencil)',
    marginTop: 3,
    lineHeight: 1.5,
  },
  pChips: {
    display: 'flex',
    gap: 6,
    marginTop: 10,
    flexWrap: 'wrap',
  },
  pRight: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: 6,
  },
  pKey: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10.5,
    color: 'var(--pencil-soft)',
    letterSpacing: '0.04em',
  },
  /* detail */
  detail: {
    position: 'sticky',
    top: 0,
    border: '1px solid var(--rule)',
    background: 'var(--page-elev)',
    padding: '22px 22px 26px',
    borderRadius: 3,
    boxShadow: '0 1px 2px oklch(0.18 0.02 310 / 0.05)',
  },
  dLabel: {
    fontSize: 10.5,
    letterSpacing: '0.22em',
    color: 'var(--pencil)',
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  dTitle: {
    fontFamily: "'Young Serif', serif",
    fontSize: 20,
    color: 'var(--ink-strong)',
    margin: 0,
  },
  dSub: {
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    fontSize: 13,
    color: 'var(--pencil)',
    marginTop: 3,
  },
  dEmpty: {
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    color: 'var(--pencil)',
    fontSize: 13,
  },
  hr: {
    border: 0,
    borderTop: '1px dotted var(--rule-strong)',
    margin: '18px 0',
  },
  field: {
    marginBottom: 14,
  },
  fieldLabelRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: 4,
  },
  fieldLabel: {
    fontSize: 10.5,
    letterSpacing: '0.2em',
    color: 'var(--pencil)',
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  fieldVal: {
    fontFamily: "'Young Serif', serif",
    fontSize: 14,
    color: 'var(--ink-strong)',
  },
  revealBtn: {
    background: 'transparent',
    border: 0,
    color: 'var(--accent-ink)',
    fontSize: 11,
    cursor: 'pointer',
    textDecoration: 'underline',
    textUnderlineOffset: 2,
    padding: 0,
    fontFamily: "'Young Serif', serif",
  },
  modelList: {
    display: 'flex',
    flexDirection: 'column',
    marginTop: 10,
  },
  modelRow: {
    display: 'grid',
    gridTemplateColumns: '1fr auto',
    gap: 10,
    padding: '8px 0',
    borderBottom: '1px dotted var(--rule)',
    alignItems: 'center',
  },
  mInfo: { minWidth: 0 },
  mName: {
    fontFamily: "'Young Serif', serif",
    fontSize: 13,
    color: 'var(--ink)',
  },
  mMeta: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10,
    color: 'var(--pencil-soft)',
    letterSpacing: '0.04em',
    marginTop: 2,
  },
  mActions: { display: 'flex', gap: 8, alignItems: 'center' },
  loading: { padding: '48px 20px', textAlign: 'center' },
  empty: {
    padding: '64px 32px',
    textAlign: 'center',
    border: '2px dashed var(--rule-strong)',
    borderRadius: 4,
    color: 'var(--pencil)',
  },
  emptyTitle: {
    fontFamily: "'Young Serif', serif",
    fontSize: 18,
    color: 'var(--ink-strong)',
    margin: 0,
  },
  emptyHint: {
    marginTop: 10,
    fontSize: 13,
    color: 'var(--pencil)',
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    maxWidth: '48ch',
    margin: '10px auto 0',
  },
};

export default ModelsPage;
