import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getLLMConfigs, createLLMConfig, deleteLLMConfig, updateLLMConfig,
  getLLMConfigApiKey, listAvailableModels,
  type LLMConfigFromDB, type AvailableModel,
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

/** Provider-level default API URLs (used by auto-discover panel). */
const DEFAULT_API_URLS: Partial<Record<Provider, string>> = {
  openai:    'https://api.openai.com/v1',
  gemini:    'https://generativelanguage.googleapis.com',
  deepseek:  'https://api.deepseek.com/v1',
  ollama:    'http://localhost:11434',
};

const ModelsPage: React.FC = () => {
  const [configs, setConfigs] = useState<LLMConfigFromDB[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<Provider | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [revealKey, setRevealKey] = useState(false);
  const [saving, setSaving] = useState(false);

  // Auto-discover flow
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [discoverProvider, setDiscoverProvider] = useState<Provider>('gemini');
  const [discoverApiKey, setDiscoverApiKey] = useState('');
  const [discoverApiUrl, setDiscoverApiUrl] = useState<string>(DEFAULT_API_URLS.gemini || '');
  const [discoverFetching, setDiscoverFetching] = useState(false);
  const [discoveredModels, setDiscoveredModels] = useState<AvailableModel[]>([]);
  const [modelFlags, setModelFlags] = useState<Record<string, { enabled: boolean; media: boolean }>>({});
  const [discoverSaving, setDiscoverSaving] = useState(false);

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

  const toggleMediaVisible = async (cfg: LLMConfigFromDB) => {
    setSaving(true);
    try {
      await updateLLMConfig(cfg.config_id, { media_visible: !cfg.media_visible } as any);
      await load();
    } catch (e: any) {
      toast({ title: '切换失败', description: e?.message || '', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  /* ---------- auto-discover ---------- */

  const openDiscover = (provider?: Provider) => {
    const p = provider || selectedProvider || 'gemini';
    setDiscoverProvider(p);
    setDiscoverApiUrl(DEFAULT_API_URLS[p] || '');
    setDiscoverApiKey('');
    setDiscoveredModels([]);
    setModelFlags({});
    setDiscoverOpen(true);
  };

  const fetchModels = async () => {
    if (!discoverApiKey.trim()) {
      toast({ title: '先填 API key', variant: 'destructive' });
      return;
    }
    setDiscoverFetching(true);
    try {
      const list = await listAvailableModels(
        discoverProvider,
        discoverApiKey.trim(),
        discoverApiUrl.trim() || undefined,
      );
      setDiscoveredModels(list);
      // Seed checkboxes from existing configs for this provider so re-imports
      // show the current enabled / media_visible state. Any model not yet in
      // DB falls back to heuristic defaults (image models → 创作可见).
      const priorByModel = new Map<string, LLMConfigFromDB>();
      for (const c of configs) {
        if (c.provider !== discoverProvider) continue;
        const key = (c.model || c.name || '').toLowerCase();
        if (key) priorByModel.set(key, c);
      }
      const flags: Record<string, { enabled: boolean; media: boolean }> = {};
      for (const m of list) {
        const prior = priorByModel.get(m.id.toLowerCase());
        if (prior) {
          flags[m.id] = { enabled: !!prior.enabled, media: !!prior.media_visible };
        } else {
          const isImage = /image|nano-banana|imagen/i.test(m.id);
          flags[m.id] = {
            enabled: list.length <= 5,
            media: isImage,
          };
        }
      }
      setModelFlags(flags);
      toast({
        title: `拿到 ${list.length} 个模型`,
        description: '勾选需要启用的 · 图像模型自动标记为「创作可见」',
        variant: 'success',
      });
    } catch (e: any) {
      toast({ title: '拉不到', description: e?.message || '', variant: 'destructive' });
    } finally {
      setDiscoverFetching(false);
    }
  };

  const toggleModelFlag = (id: string, field: 'enabled' | 'media') => {
    setModelFlags((prev) => ({
      ...prev,
      [id]: {
        enabled: field === 'enabled' ? !(prev[id]?.enabled) : !!prev[id]?.enabled,
        media: field === 'media' ? !(prev[id]?.media) : !!prev[id]?.media,
      },
    }));
  };

  const bulkSave = async () => {
    const enabledModels = discoveredModels.filter((m) => modelFlags[m.id]?.enabled);
    if (enabledModels.length === 0) {
      toast({ title: '没勾选任何模型', variant: 'destructive' });
      return;
    }
    setDiscoverSaving(true);
    let ok = 0, fail = 0, updated = 0;
    // Index existing configs for this provider by model id so we can UPDATE
    // instead of silently skipping when the user re-imports to toggle
    // "创作可见" on a model they'd already added.
    const existingByModel = new Map<string, LLMConfigFromDB>();
    for (const c of configs) {
      if (c.provider !== discoverProvider) continue;
      const key = (c.model || c.name || '').toLowerCase();
      if (key) existingByModel.set(key, c);
    }
    for (const m of enabledModels) {
      try {
        const hit = existingByModel.get(m.id.toLowerCase());
        const wantMedia = !!modelFlags[m.id]?.media;
        if (hit) {
          // Re-import path: push the toggles through so the row's
          // enabled/media_visible actually reflect the modal's checkboxes.
          const patch: Record<string, unknown> = {};
          if (!hit.enabled) patch.enabled = true;
          if (!!hit.media_visible !== wantMedia) patch.media_visible = wantMedia;
          if (Object.keys(patch).length > 0) {
            await updateLLMConfig(hit.config_id, patch as any);
            updated += 1;
          }
          ok += 1;
          continue;
        }
        await createLLMConfig({
          name: m.name || m.id,
          shortname: m.id,
          provider: discoverProvider,
          api_key: discoverApiKey.trim(),
          api_url: discoverApiUrl.trim() || undefined,
          model: m.id,
          enabled: true,
          media_visible: wantMedia,
        });
        ok += 1;
      } catch (e: any) {
        console.warn('[ModelsPage] save config failed for', m.id, e?.message);
        fail += 1;
      }
    }
    setDiscoverSaving(false);
    setDiscoverOpen(false);
    await load();
    setSelectedProvider(discoverProvider);
    toast({
      title: `存了 ${ok} 个${updated > 0 ? `（更新 ${updated}）` : ''}${fail > 0 ? `，${fail} 个失败` : ''}`,
      variant: fail > 0 ? 'destructive' : 'success',
    });
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
        actions={<PaperButton onClick={() => openDiscover()}>+ 接一家</PaperButton>}
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

                  <div style={{ ...s.fieldLabel, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <span>可用模型</span>
                    <PaperButton variant="ghost" size="small" onClick={() => openDiscover(selectedGroup.provider)}>
                      + 加更多
                    </PaperButton>
                  </div>
                  <div style={s.modelList}>
                    {selectedGroup.configs.map((c) => (
                      <div key={c.config_id} style={s.modelRow}>
                        <div style={s.mInfo}>
                          <div style={s.mName}>
                            {c.shortname || c.model || c.name}
                            {!c.enabled && <span style={s.mDisabled}> · 关</span>}
                            {c.media_visible && <span style={s.mMediaTag}>· 创作可见</span>}
                          </div>
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
                            title={c.enabled ? '关闭这个模型（对话和创作都用不了）' : '启用这个模型'}
                          >
                            {c.enabled ? '关' : '开'}
                          </PaperButton>
                          <PaperButton
                            variant="ghost"
                            size="small"
                            disabled={saving || !c.enabled}
                            onClick={() => void toggleMediaVisible(c)}
                            title={c.media_visible ? '取消创作可见（创作页不再显示）' : '让这个模型出现在「创作」里'}
                          >
                            {c.media_visible ? '✓ 创作' : '创作'}
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
                </>
              ) : (
                <p style={s.dEmpty}>选一家 provider 看详情。</p>
              )}
            </aside>
          </div>
        )}
      </PaperContent>

      {discoverOpen && (
        <div style={s.discoverOverlay} onClick={() => setDiscoverOpen(false)}>
          <div style={s.discoverPanel} onClick={(e) => e.stopPropagation()}>
            <div style={s.discoverHead}>
              <span>接一家 provider · 自动拉模型</span>
              <button type="button" style={s.discoverClose} onClick={() => setDiscoverOpen(false)}>×</button>
            </div>

            <div style={s.discoverBody}>
              <div style={s.dFieldRow}>
                <div style={s.dFieldLabel}>Provider</div>
                <select
                  value={discoverProvider}
                  onChange={(e) => {
                    const p = e.target.value as Provider;
                    setDiscoverProvider(p);
                    setDiscoverApiUrl(DEFAULT_API_URLS[p] || '');
                    setDiscoveredModels([]);
                    setModelFlags({});
                  }}
                  style={s.dFieldInput}
                >
                  <option value="gemini">Gemini (Google)</option>
                  <option value="openai">OpenAI</option>
                  <option value="deepseek">DeepSeek</option>
                  <option value="ollama">Ollama (本地)</option>
                </select>
              </div>

              <div style={s.dFieldRow}>
                <div style={s.dFieldLabel}>API URL</div>
                <input
                  type="text"
                  value={discoverApiUrl}
                  onChange={(e) => setDiscoverApiUrl(e.target.value)}
                  placeholder={DEFAULT_API_URLS[discoverProvider] || 'https://...'}
                  style={s.dFieldInput}
                />
              </div>

              <div style={s.dFieldRow}>
                <div style={s.dFieldLabel}>API Key</div>
                <input
                  type="password"
                  value={discoverApiKey}
                  onChange={(e) => setDiscoverApiKey(e.target.value)}
                  placeholder={discoverProvider === 'ollama' ? '（本地不需要 key）' : 'sk-...'}
                  style={s.dFieldInput}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4, marginBottom: 14 }}>
                <PaperButton
                  size="small"
                  onClick={fetchModels}
                  disabled={discoverFetching || (!discoverApiKey.trim() && discoverProvider !== 'ollama')}
                >
                  {discoverFetching ? '正在拉…' : (discoveredModels.length > 0 ? '重拉' : '拉取可用模型')}
                </PaperButton>
              </div>

              {discoveredModels.length > 0 && (
                <>
                  <div style={s.discoverListHead}>
                    <span>共 {discoveredModels.length} 个 · 勾选要启用的</span>
                    <span>
                      <button
                        type="button"
                        style={s.bulkLink}
                        onClick={() => {
                          const next: typeof modelFlags = {};
                          for (const m of discoveredModels) {
                            next[m.id] = { enabled: true, media: modelFlags[m.id]?.media || false };
                          }
                          setModelFlags(next);
                        }}
                      >全选</button>
                      <span style={{ color: 'var(--rule-strong)', margin: '0 6px' }}>/</span>
                      <button
                        type="button"
                        style={s.bulkLink}
                        onClick={() => setModelFlags({})}
                      >全清</button>
                    </span>
                  </div>
                  <div style={s.discoverList}>
                    {discoveredModels.map((m) => {
                      const flags = modelFlags[m.id] || { enabled: false, media: false };
                      return (
                        <div key={m.id} style={s.discoverRow}>
                          <label style={s.discoverCheckLabel}>
                            <input
                              type="checkbox"
                              checked={flags.enabled}
                              onChange={() => toggleModelFlag(m.id, 'enabled')}
                            />
                            <span style={s.discoverModelName}>{m.name || m.id}</span>
                          </label>
                          <label style={{ ...s.discoverCheckLabel, opacity: flags.enabled ? 1 : 0.4 }}>
                            <input
                              type="checkbox"
                              checked={flags.media}
                              disabled={!flags.enabled}
                              onChange={() => toggleModelFlag(m.id, 'media')}
                            />
                            <span style={s.discoverModelMedia}>创作可见</span>
                          </label>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>

            <div style={s.discoverFoot}>
              <span style={s.discoverFootHint}>
                Key 会存到后端并跟每个模型的 config 一起。
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                <PaperButton variant="ghost" size="small" onClick={() => setDiscoverOpen(false)}>取消</PaperButton>
                <PaperButton
                  size="small"
                  onClick={bulkSave}
                  disabled={discoverSaving || discoveredModels.length === 0}
                >
                  {discoverSaving ? '存…' : `存 ${Object.values(modelFlags).filter((f) => f.enabled).length} 个`}
                </PaperButton>
              </div>
            </div>
          </div>
        </div>
      )}
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
  mActions: { display: 'flex', gap: 6, alignItems: 'center' },
  mDisabled: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10,
    color: 'var(--pencil-soft)',
    letterSpacing: '0.08em',
  },
  mMediaTag: {
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    fontSize: 11,
    color: 'var(--marginalia-ink)',
    marginLeft: 6,
  },
  /* Discover modal */
  discoverOverlay: {
    position: 'fixed', inset: 0,
    background: 'color-mix(in oklch, var(--ink) 55%, transparent)',
    backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 50, padding: 40,
  },
  discoverPanel: {
    background: 'var(--page-elev)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 3,
    boxShadow: '0 20px 60px oklch(0 0 0 / 0.35)',
    display: 'flex', flexDirection: 'column',
    width: '100%', maxWidth: 640, maxHeight: '85vh',
    overflow: 'hidden',
  },
  discoverHead: {
    padding: '16px 22px',
    borderBottom: '1px solid var(--rule)',
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    fontFamily: "'Young Serif', serif",
    fontSize: 14,
    color: 'var(--ink-strong)',
  },
  discoverClose: {
    background: 'transparent', border: 0,
    color: 'var(--pencil)', fontSize: 22, lineHeight: 1,
    cursor: 'pointer', padding: 0,
  },
  discoverBody: {
    padding: '18px 22px',
    overflowY: 'auto',
    flex: 1,
  },
  dFieldRow: {
    display: 'grid',
    gridTemplateColumns: '100px 1fr',
    gap: 12,
    alignItems: 'center',
    marginBottom: 10,
  },
  dFieldLabel: {
    fontSize: 10.5,
    letterSpacing: '0.22em',
    color: 'var(--pencil)',
    textTransform: 'uppercase',
  },
  dFieldInput: {
    background: 'transparent',
    border: 0,
    borderBottom: '1px solid var(--rule-strong)',
    padding: '6px 2px',
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12.5,
    color: 'var(--ink)',
    outline: 'none',
    width: '100%',
  },
  discoverListHead: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    fontSize: 11,
    color: 'var(--pencil)',
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    marginTop: 8,
    marginBottom: 6,
    paddingBottom: 6,
    borderBottom: '1px dotted var(--rule)',
  },
  bulkLink: {
    background: 'transparent',
    border: 0,
    color: 'var(--accent-ink)',
    cursor: 'pointer',
    fontFamily: "'Young Serif', serif",
    fontSize: 11.5,
    textDecoration: 'underline',
    textUnderlineOffset: 2,
    padding: 0,
    fontStyle: 'normal',
  },
  discoverList: {
    display: 'flex', flexDirection: 'column',
    maxHeight: 340, overflowY: 'auto',
  },
  discoverRow: {
    display: 'grid',
    gridTemplateColumns: '1fr auto',
    gap: 12,
    padding: '7px 4px',
    borderBottom: '1px dotted var(--rule)',
    alignItems: 'center',
  },
  discoverCheckLabel: {
    display: 'flex', alignItems: 'center', gap: 8,
    cursor: 'pointer',
    fontFamily: "'Young Serif', serif",
    fontSize: 13,
  },
  discoverModelName: {
    color: 'var(--ink)',
  },
  discoverModelMedia: {
    color: 'var(--marginalia-ink)',
    fontStyle: 'italic',
    fontSize: 12,
  },
  discoverFoot: {
    padding: '12px 22px',
    borderTop: '1px solid var(--rule)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    background: 'color-mix(in oklch, var(--paper) 60%, var(--page-elev))',
  },
  discoverFootHint: {
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    fontSize: 11.5,
    color: 'var(--pencil)',
  },
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
