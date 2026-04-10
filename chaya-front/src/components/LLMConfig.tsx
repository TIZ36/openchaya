/**
 * LLM配置组件 - 紧凑版
 * 用于配置和管理LLM API设置，保存到MySQL数据库
 */

import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { Plus, Trash2, CheckCircle, XCircle, Edit2, Brain, Save, X, Loader2, Eye, EyeOff, Type, Image as ImageIcon, Video, Music, Mic, Download, Upload, ChevronDown, ChevronRight, Camera, Search, Check, RefreshCw, GripVertical } from 'lucide-react';
import { 
  getLLMConfigs, getLLMConfig, createLLMConfig, updateLLMConfig, deleteLLMConfig, getLLMConfigApiKey, 
  LLMConfigFromDB, CreateLLMConfigRequest,
  downloadLLMConfigAsJson, downloadAllLLMConfigsAsJson, importLLMConfigsFromFile, importLLMConfigs,
  getProviders, getProvider, createProvider, updateProvider, deleteProvider, reorderProviders,
  getSupportedProviders,
  LLMProvider, CreateProviderRequest, UpdateProviderRequest, SupportedProvider
} from '../services/llmApi';
import { fetchOllamaModels } from '../services/ollamaService';
import { fetchModelsForProvider, type ModelWithCapabilities } from '../services/modelListService';
import PageLayout, { Card, EmptyState } from './ui/PageLayout';
import { Button } from './ui/Button';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { InputField, TextareaField, FormFieldGroup } from './ui/FormField';
import { ModelSelectDialog } from './ui/ModelSelectDialog';
import { toast } from './ui/use-toast';
import { Checkbox } from './ui/Checkbox';
import { Switch } from './ui/Switch';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from './ui/Select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from './ui/Dialog';
import { ProviderIcon } from './ui/ProviderIcon';
import { CapabilityIcons } from './ui/CapabilityIcons';

// Provider display info
const PROVIDER_INFO: Record<string, { name: string; color: string; icon: string }> = {
  openai: { name: 'OpenAI', color: '#10A37F', icon: '🤖' },
  deepseek: { name: 'DeepSeek', color: '#5B68DF', icon: '🔮' },
  anthropic: { name: 'Anthropic (Claude)', color: '#D4A574', icon: '🧠' },
  gemini: { name: 'Google Gemini', color: '#4285F4', icon: '✨' },
  ollama: { name: 'Ollama', color: '#1D4ED8', icon: '🦙' },
};

/** 是否为默认供应商：provider_id == provider_type，不可编辑/删除 */
const isDefaultMainstreamProvider = (provider: { provider_id: string; provider_type: string }): boolean => {
  const type = (provider.provider_type || '').trim().toLowerCase();
  const id = (provider.provider_id || '').trim().toLowerCase();
  return Boolean(type) && type === id;
};

/** 自定义供应商：provider_id != provider_type，允许编辑/删除 */
const isCustomProvider = (provider: { provider_id: string; provider_type: string }) =>
  !isDefaultMainstreamProvider(provider);

/** 列表与标题显示名：统一显示 llm_provider.name */
const getProviderDisplayName = (provider: { name?: string; provider_id?: string; provider_type: string }): string => {
  return provider.name?.trim() || provider.provider_id?.trim() || provider.provider_type;
};

// 供应商图标：使用 ProviderIcon（simple-icons + 内联 SVG）
const renderProviderIcon = (
  providerType: string,
  className?: string,
  size?: number
): React.ReactNode => {
  const key = providerType.toLowerCase();
  if (['openai', 'anthropic', 'google', 'gemini', 'deepseek', 'ollama'].includes(key)) {
    return <ProviderIcon provider={providerType} size={size || 16} className={className} />;
  }
  return (
    <span className={className}>
      {PROVIDER_INFO[providerType]?.icon || '📦'}
    </span>
  );
};

const inferMediaCapabilitiesFromModelId = (modelId: string, capabilities?: { image_gen?: boolean; video_gen?: boolean } | null) => {
  if (capabilities?.image_gen || capabilities?.video_gen) return capabilities;
  const lower = (modelId || '').toLowerCase();
  return {
    image_gen: lower.includes('grok-imagine') || lower.includes('dall-e') || lower.includes('gpt-image'),
    video_gen: lower.includes('grok-imagine-1.0-video'),
  };
};

const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = error => reject(error);
  });
};

// 注意：logo下载现在通过后端API完成，不再需要前端直接下载
// 保留此函数用于向后兼容（如果有其他地方使用）
const downloadLogoFromLobeHub = async (provider: string): Promise<string | null> => {
  // 已废弃：现在使用后端API downloadProviderLogo
  console.warn('downloadLogoFromLobeHub is deprecated, use downloadProviderLogo from llmApi instead');
  return null;
};

// Token 列表简化组件（只显示 token，点击弹出对话框）
interface TokenListSimpleProps {
  configs: LLMConfigFromDB[];
  selectedProvider: LLMProvider | undefined;
  getLLMConfigApiKey: (configId: string) => Promise<string>;
  showTokenKeys: Record<string, boolean>;
  setShowTokenKeys: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  tokenApiKeys: Record<string, string>;
  setTokenApiKeys: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  loadingTokenApiKey: Record<string, boolean>;
  setLoadingTokenApiKey: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  onTokenClick: (tokenKey: string, configs: LLMConfigFromDB[], apiKey: string) => void;
  onDeleteToken: (tokenKey: string, configs: LLMConfigFromDB[]) => Promise<void>;
}

const TokenListSimple: React.FC<TokenListSimpleProps> = ({
  configs,
  selectedProvider,
  getLLMConfigApiKey,
  showTokenKeys,
  setShowTokenKeys,
  tokenApiKeys,
  setTokenApiKeys,
  loadingTokenApiKey,
  setLoadingTokenApiKey,
  onTokenClick,
  onDeleteToken,
}) => {
  const [tokenGroups, setTokenGroups] = useState<Map<string, { apiKey: string; configs: LLMConfigFromDB[]; isActive: boolean }>>(new Map());
  const [loadingTokens, setLoadingTokens] = useState(true);

  useEffect(() => {
    const loadTokenGroups = async () => {
      setLoadingTokens(true);
      const groups = new Map<string, { apiKey: string; configs: LLMConfigFromDB[]; isActive: boolean }>();
      
      for (const config of configs) {
        try {
          const apiKey = await getLLMConfigApiKey(config.config_id);
          const tokenKey = apiKey || 'no-token';
          
          if (!groups.has(tokenKey)) {
            groups.set(tokenKey, { apiKey, configs: [], isActive: false });
          }
          const group = groups.get(tokenKey)!;
          group.configs.push(config);
          // 如果有任何一个模型启用，则该 token 视为活跃
          if (config.enabled) {
            group.isActive = true;
          }
        } catch (error) {
          const fallbackKey = `error-${config.config_id}`;
          if (!groups.has(fallbackKey)) {
            groups.set(fallbackKey, { apiKey: '', configs: [], isActive: false });
          }
          groups.get(fallbackKey)!.configs.push(config);
        }
      }
      
      setTokenGroups(groups);
      setLoadingTokens(false);
    };

    if (configs.length > 0) {
      loadTokenGroups();
    } else {
      setTokenGroups(new Map());
      setLoadingTokens(false);
    }
  }, [configs, getLLMConfigApiKey]);

  const maskApiKey = (key: string) => {
    if (!key || key.length < 8) return '***';
    return `${key.substring(0, 4)}...${key.substring(key.length - 4)}`;
  };

  const handleToggleShowToken = async (tokenKey: string, apiKey: string) => {
    const isShowing = showTokenKeys[tokenKey] || false;
    
    if (!isShowing && !tokenApiKeys[tokenKey] && apiKey) {
      setLoadingTokenApiKey(prev => ({ ...prev, [tokenKey]: true }));
      try {
        setTokenApiKeys(prev => ({ ...prev, [tokenKey]: apiKey }));
      } catch (error) {
        console.error('Failed to load API key:', error);
      } finally {
        setLoadingTokenApiKey(prev => ({ ...prev, [tokenKey]: false }));
      }
    }
    
    setShowTokenKeys(prev => ({ ...prev, [tokenKey]: !isShowing }));
  };

  if (loadingTokens) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" />
        <span className="ml-2 text-sm text-[var(--text-muted)]">加载 Token 列表...</span>
      </div>
    );
  }

  if (tokenGroups.size === 0) {
    return (
      <div className="llm-config-token-empty-wrap">
        <EmptyState
          icon={Brain}
          title="暂无 Token"
          description="点击右上角按钮录入第一个 Token"
        />
      </div>
    );
  }

  // 不展示「未设置 Token」的单独一行（无 apiKey 或加载失败的组不显示在列表中）
  const visibleGroups = Array.from(tokenGroups.entries()).filter(
    ([tokenKey, group]) => tokenKey !== 'no-token' && !tokenKey.startsWith('error-') && Boolean(group.apiKey?.trim())
  );

  return (
    <div className="space-y-2">
      {visibleGroups.map(([tokenKey, group]) => {
        const totalCount = group.configs.length;
        const showKey = showTokenKeys[tokenKey] || false;
        const displayKey = tokenApiKeys[tokenKey] || group.apiKey || '';

        return (
          <div
            key={tokenKey}
            className={`
              llm-config-token-card border rounded-lg p-3 cursor-pointer transition-all
              ${group.isActive 
                ? 'llm-config-token-card--active border-[var(--color-success)] bg-[var(--color-success-bg)]' 
                : 'border-[var(--border-default)] hover:border-[var(--color-selected-border)] hover:bg-[var(--color-hover-bg)]'
              }
            `}
            onClick={() => onTokenClick(tokenKey, group.configs, group.apiKey)}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <div className={`w-2 h-2 rounded-full flex-shrink-0 llm-config-token-dot ${group.isActive ? 'llm-config-token-dot--active bg-[var(--color-success)]' : 'bg-[var(--text-muted)]'}`} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-[var(--text-primary)] truncate ">
                    {displayKey ? maskApiKey(displayKey) : '未设置 Token'}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => handleToggleShowToken(tokenKey, group.apiKey)}
                  disabled={loadingTokenApiKey[tokenKey]}
                  title={showKey ? '隐藏 Token' : '查看 Token'}
                >
                  {loadingTokenApiKey[tokenKey] ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : showKey ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-[var(--color-secondary)] hover:text-[var(--color-secondary)] hover:bg-[var(--niho-mist-pink-bg)]"
                  onClick={async () => {
                    if (confirm(`确定要删除这个 Token 及其下的 ${totalCount} 个模型吗？`)) {
                      await onDeleteToken(tokenKey, group.configs);
                    }
                  }}
                  title="删除 Token"
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </div>
            {showKey && displayKey && (
              <div className="llm-config-token-copy-box mt-2 p-2 bg-[var(--surface-primary)] rounded border border-[var(--border-default)]">
                <div className="text-xs font-mono text-[var(--text-secondary)] break-all">
                  {displayKey}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

const LLMConfigPanel: React.FC = () => {
  // 供应商相关状态
  const [providers, setProviders] = useState<LLMProvider[]>([]);
  const [supportedProviders, setSupportedProviders] = useState<SupportedProvider[]>([]);
  const [isLoadingProviders, setIsLoadingProviders] = useState(true);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [showCreateProviderDialog, setShowCreateProviderDialog] = useState(false);
  const [showEditProviderDialog, setShowEditProviderDialog] = useState(false);
  const [editingProvider, setEditingProvider] = useState<LLMProvider | null>(null);
  const [deleteProviderTarget, setDeleteProviderTarget] = useState<LLMProvider | null>(null);
  /** 供应商拖拽：源下标 / 插入位置（0=第一项前 … n=最后一项后） */
  const [providerDragFrom, setProviderDragFrom] = useState<number | null>(null);
  const [providerInsertBefore, setProviderInsertBefore] = useState<number | null>(null);
  const providerDragFromRef = useRef<number | null>(null);
  // Logo 相关状态已移除，现在直接使用 @lobehub/icons 组件
  const [newProvider, setNewProvider] = useState<CreateProviderRequest>({
    name: '',
    provider_type: 'openai',
    override_url: false,
    logo_theme: 'auto',
  });
  
  // 模型配置相关状态
  const [configs, setConfigs] = useState<LLMConfigFromDB[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LLMConfigFromDB | null>(null);
  const [newConfig, setNewConfig] = useState<CreateLLMConfigRequest>({
    name: '',
    provider: 'openai',
    api_key: '',
    api_url: '',
    model: '',
    enabled: true,
    tags: [],
    description: '',
  });
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [isLoadingOllamaModels, setIsLoadingOllamaModels] = useState(false);
  const [ollamaError, setOllamaError] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<string[]>([]); // 通用模型列表
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [showOllamaModelDialog, setShowOllamaModelDialog] = useState(false); // 显示 Ollama 模型选择对话框
  const [showModelSelectDialog, setShowModelSelectDialog] = useState(false); // 显示通用模型选择对话框
  const [showApiKey, setShowApiKey] = useState(false); // 控制API密钥显示/隐藏
  const [loadingApiKey, setLoadingApiKey] = useState(false); // 加载API密钥状态
  
  // Token 管理相关状态（用于主流供应商）
  const [newTokenApiKey, setNewTokenApiKey] = useState('');
  const [isAddingToken, setIsAddingToken] = useState(false);
  const [tokenAvailableModels, setTokenAvailableModels] = useState<(string | ModelWithCapabilities)[]>([]);
  const [selectedModelsForToken, setSelectedModelsForToken] = useState<Set<string>>(new Set());
  const [isLoadingTokenModels, setIsLoadingTokenModels] = useState(false);
  const [tokenApiKeys, setTokenApiKeys] = useState<Record<string, string>>({}); // 存储已加载的 API keys
  const [loadingTokenApiKey, setLoadingTokenApiKey] = useState<Record<string, boolean>>({});
  const [showTokenKeys, setShowTokenKeys] = useState<Record<string, boolean>>({}); // 控制每个 token 的显示/隐藏
  const [tokenError, setTokenError] = useState<string | null>(null);
  
  // Token 录入对话框状态
  const [showAddTokenDialog, setShowAddTokenDialog] = useState(false);
  
  // Token 模型管理对话框状态
  const [showTokenModelsDialog, setShowTokenModelsDialog] = useState(false);
  const [selectedTokenKey, setSelectedTokenKey] = useState<string | null>(null);
  const [selectedTokenConfigs, setSelectedTokenConfigs] = useState<LLMConfigFromDB[]>([]);
  const [selectedTokenApiKey, setSelectedTokenApiKey] = useState<string>('');
  const [availableModelsForSelectedToken, setAvailableModelsForSelectedToken] = useState<string[]>([]);
  /** 管理 Token 模型对话框中「重新获取」得到的带能力信息的模型列表，用于在模型列右侧显示能力 */
  const [availableModelsWithCapabilitiesForToken, setAvailableModelsWithCapabilitiesForToken] = useState<(string | ModelWithCapabilities)[]>([]);
  const [isLoadingAvailableModels, setIsLoadingAvailableModels] = useState(false);
  const [showAddModelsSection, setShowAddModelsSection] = useState(false);
  const [selectedNewModels, setSelectedNewModels] = useState<Set<string>>(new Set());
  
  // Logo 上传和设置功能已移除，现在直接使用 @lobehub/icons 组件

  // Remove logo
  const handleRemoveLogo = () => {
    setNewConfig(prev => ({
      ...prev,
      metadata: {
        ...prev.metadata,
        providerLogo: undefined,
      },
    }));
  };

  // getProviderLogo 函数已移除，现在直接使用 @lobehub/icons 组件

  // Get provider logo for group header (uses first config with custom logo, or default)
  const getProviderGroupLogo = (provider: string, configs: LLMConfigFromDB[]) => {
    // Find first config with custom logo
    const configWithLogo = configs.find(c => c.metadata?.providerLogo);
    if (configWithLogo?.metadata?.providerLogo) {
      const posX = configWithLogo.metadata?.logoPositionX ?? 50;
      const posY = configWithLogo.metadata?.logoPositionY ?? 50;
      const scale = (configWithLogo.metadata?.logoScale ?? 100) / 100;
      return (
        <img 
          src={configWithLogo.metadata.providerLogo} 
          alt={provider} 
          className="w-full h-full object-cover rounded-lg"
          style={{ 
            objectPosition: `${posX}% ${posY}%`,
            transform: `scale(${scale})`,
          }}
        />
      );
    }
    const info = PROVIDER_INFO[provider] || { icon: '📦', color: '#6B7280' };
    return (
      <span className="text-lg">{info.icon}</span>
    );
  };

  // 不再需要按provider分组，因为现在使用供应商列表

  // 加载系统支持的供应商列表
  const loadSupportedProviders = async () => {
    try {
      const data = await getSupportedProviders();
      setSupportedProviders(data);
    } catch (error) {
      console.error('Failed to load supported providers:', error);
    }
  };

  // 加载供应商列表
  const loadProviders = async () => {
    try {
      setIsLoadingProviders(true);
      const data = await getProviders();
      setProviders(data);
      
      // 不再需要下载logo，直接使用 @lobehub/icons 组件
      
      // 默认选中第一个供应商
      if (data.length > 0 && !selectedProviderId) {
        setSelectedProviderId(data[0].provider_id);
      }
    } catch (error) {
      console.error('Failed to load providers:', error);
      toast({
        title: '加载供应商失败',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    } finally {
      setIsLoadingProviders(false);
    }
  };

  const reorderProviderListByInsertBefore = <T,>(list: T[], from: number, insertBefore: number): T[] => {
    const n = list.length;
    if (from < 0 || from >= n || insertBefore < 0 || insertBefore > n) return [...list];
    if (from === insertBefore) return [...list];
    const next = [...list];
    const [item] = next.splice(from, 1);
    let insertAt = insertBefore;
    if (from < insertBefore) insertAt--;
    next.splice(insertAt, 0, item);
    return next;
  };

  const computeInsertBeforeFromRowEvent = (e: React.DragEvent, rowIndex: number, rowCount: number) => {
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    const after = e.clientY >= mid;
    return after ? Math.min(rowIndex + 1, rowCount) : rowIndex;
  };

  const onProviderDragStart = (e: React.DragEvent, index: number) => {
    e.dataTransfer.setData('text/plain', String(index));
    e.dataTransfer.effectAllowed = 'move';
    providerDragFromRef.current = index;
    setProviderDragFrom(index);
    setProviderInsertBefore(null);
  };
  const onProviderDragEnd = () => {
    providerDragFromRef.current = null;
    setProviderDragFrom(null);
    setProviderInsertBefore(null);
  };
  const onProviderDragOverRow = (e: React.DragEvent, rowIndex: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (providerDragFromRef.current === null) return;
    setProviderInsertBefore(computeInsertBeforeFromRowEvent(e, rowIndex, providers.length));
  };
  const onProviderDropRow = async (e: React.DragEvent, rowIndex: number) => {
    e.preventDefault();
    const fromFromEvent = parseInt(e.dataTransfer.getData('text/plain'), 10);
    const from = Number.isNaN(fromFromEvent) ? providerDragFromRef.current ?? -1 : fromFromEvent;
    if (Number.isNaN(from) || from < 0 || from >= providers.length) {
      onProviderDragEnd();
      return;
    }
    // 优先使用 dragover 时已计算的插入位置，避免 drop 时二次计算导致错位
    const insertBefore = providerInsertBefore ?? computeInsertBeforeFromRowEvent(e, rowIndex, providers.length);
    const next = reorderProviderListByInsertBefore(providers, from, insertBefore);
    const same =
      next.length === providers.length &&
      next.every((p, i) => p.provider_id === providers[i].provider_id);
    if (same) {
      onProviderDragEnd();
      return;
    }
    const prev = [...providers];
    setProviders(next);
    onProviderDragEnd();
    try {
      await reorderProviders(next.map((p) => p.provider_id));
      toast({ title: '供应商顺序已保存', description: 'Chaya 聊天中「选择模型」Tab 顺序已同步', variant: 'success' });
    } catch (err) {
      setProviders(prev);
      toast({
        title: '保存顺序失败',
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      });
    }
  };

  // handleLoadLogoOptions 函数已移除，现在直接使用 @lobehub/icons 组件

  // 加载模型配置列表
  const loadConfigs = async () => {
    try {
      setIsLoading(true);
      const data = await getLLMConfigs();
      setConfigs(data);
    } catch (error) {
      console.error('Failed to load LLM configs:', error);
      toast({
        title: '加载配置失败',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadSupportedProviders();
    loadProviders();
    loadConfigs();
  }, []);

  // 获取 Ollama 模型列表
  const loadOllamaModels = useCallback(async (serverUrl: string) => {
    if (!serverUrl || !serverUrl.trim()) {
      setOllamaModels([]);
      setOllamaError(null);
      return;
    }

    setIsLoadingOllamaModels(true);
    setOllamaError(null);

    try {
      const models = await fetchOllamaModels(serverUrl.trim());
      // 去重：使用 Set 去除重复项
      const uniqueModels = Array.from(new Set(models));
      setOllamaModels(uniqueModels);
      // 如果当前没有选择模型，且模型列表不为空，自动选择第一个
      setNewConfig(prev => {
        if (!prev.model && uniqueModels.length > 0) {
          return { ...prev, model: uniqueModels[0] };
        }
        return prev;
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setOllamaError(errorMessage);
      setOllamaModels([]);
      console.error('Failed to fetch Ollama models:', error);
    } finally {
      setIsLoadingOllamaModels(false);
    }
  }, []);

  // 加载通用模型列表（OpenAI 兼容 API，如 NVIDIA）
  const loadModels = useCallback(async (provider: string, apiUrl: string, apiKey?: string) => {
    if (!apiUrl || !apiUrl.trim()) {
      setAvailableModels([]);
      setModelsError(null);
      return;
    }

    // Ollama 使用单独的逻辑
    if (provider === 'ollama') {
      return;
    }

    setIsLoadingModels(true);
    setModelsError(null);

    try {
      const models = await fetchModelsForProvider(provider, apiUrl.trim(), apiKey);
      // 提取模型 ID（兼容 string[] 和 ModelWithCapabilities[]）
      const modelIds = models.map(m => typeof m === 'string' ? m : m.id);
      // 去重：使用 Set 去除重复项
      const uniqueModels = Array.from(new Set(modelIds));
      setAvailableModels(uniqueModels);
      // 如果当前没有选择模型，且模型列表不为空，自动选择第一个
      setNewConfig(prev => {
        if (!prev.model && uniqueModels.length > 0) {
          return { ...prev, model: uniqueModels[0] };
        }
        return prev;
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setModelsError(errorMessage);
      setAvailableModels([]);
      console.error('Failed to fetch models:', error);
    } finally {
      setIsLoadingModels(false);
    }
  }, []);

  // 不再自动加载 Ollama 模型列表，改为用户点击时手动加载

  // 不再自动加载模型列表，改为用户点击时手动加载

  const handleAddConfig = async () => {
    if (!selectedProvider) {
      toast({
        title: '请先选择供应商',
        variant: 'destructive',
      });
      return;
    }

    // Ollama 不需要 API key，其他提供商需要
    const requiresApiKey = selectedProvider.provider_type !== 'ollama';
    if (!newConfig.name || (requiresApiKey && !newConfig.api_key)) {
      toast({
        title: requiresApiKey ? '请填写配置名称和 API 密钥' : '请填写配置名称',
        variant: 'destructive',
      });
      return;
    }

    try {
      // 确保使用选中的供应商类型
      const configToCreate = {
        ...newConfig,
        provider: selectedProvider.provider_type,
        // supplier 归属：写入 supplier=provider_id（系统供应商也写，便于统一按 supplier 筛选）
        supplier: selectedProvider.provider_id,
        // 如果供应商设置了override_url，使用供应商的default_api_url（如果模型配置中没有设置）
        api_url: newConfig.api_url || selectedProvider.default_api_url || getProviderDefaultUrl(selectedProvider.provider_type),
      };
      
      await createLLMConfig(configToCreate);
      await loadConfigs();
      
      // 重置表单
      setNewConfig({
        name: '',
        shortname: '',
        provider: selectedProvider.provider_type,
        api_key: '',
        api_url: selectedProvider.override_url ? (selectedProvider.default_api_url || '') : (selectedProvider.default_api_url || getProviderDefaultUrl(selectedProvider.provider_type)),
        model: '',
        enabled: true,
        tags: [],
        description: '',
        metadata: {},
      });
      setIsAdding(false);
    } catch (error) {
      console.error('Failed to add config:', error);
      toast({
        title: '添加配置失败',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    }
  };

  const handleUpdateConfig = async () => {
    // 编辑时：Ollama 不需要 API key，其他提供商在新建时需要，但编辑时可以不填写（留空则不更新）
    if (!editingId || !newConfig.name) {
      toast({ title: '请填写配置名称', variant: 'destructive' });
      return;
    }

    // 构建更新数据，如果api_key为空字符串，则不包含在更新数据中（后端会保留原有值）
    const updateData: Partial<CreateLLMConfigRequest> = {
      name: newConfig.name,
      shortname: newConfig.shortname,
      provider: newConfig.provider,
      // supplier 归属（token/计费方）
      supplier: (newConfig as any).supplier,
      api_url: newConfig.api_url,
      model: newConfig.model,
      enabled: newConfig.enabled,
      tags: newConfig.tags,
      description: newConfig.description,
      metadata: newConfig.metadata,
    };
    
    // 只有在非Ollama且提供了api_key时才更新api_key
    if (newConfig.provider !== 'ollama' && newConfig.api_key && newConfig.api_key.trim() !== '') {
      updateData.api_key = newConfig.api_key;
    }

    try {
      await updateLLMConfig(editingId, updateData);
      await loadConfigs();
    
      // 重置表单
    setNewConfig({
        name: '',
        shortname: '',
      provider: 'openai',
        api_key: '',
        api_url: '',
        model: '',
      enabled: true,
        tags: [],
        description: '',
        metadata: {},
    });
    setIsAdding(false);
    setEditingId(null);
    } catch (error) {
      console.error('Failed to update config:', error);
      toast({
        title: '更新配置失败',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    }
  };

  const handleDeleteConfig = async (configId: string) => {
    try {
      await deleteLLMConfig(configId);
      await loadConfigs();
    } catch (error) {
      console.error('Failed to delete config:', error);
      toast({
        title: '删除配置失败',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    }
  };

  const handleEditConfig = async (config: LLMConfigFromDB) => {
    // 查找对应的供应商（按 supplier 归属）
    const supplierId = config.supplier || config.provider;
    const provider = providers.find(p => 
      p.provider_id === supplierId || 
      p.provider_type === supplierId
    );
    
    if (provider) {
      setSelectedProviderId(provider.provider_id);
    }
    
    const defaultUrl = provider?.default_api_url || getProviderDefaultUrl(config.provider);
    
    // 重置状态
    setAvailableModels([]);
    setModelsError(null);
    setOllamaModels([]);
    setOllamaError(null);
    
    setNewConfig({
      name: config.name,
      shortname: config.shortname || '',
      provider: config.provider,
      supplier: supplierId,
      api_key: '', // 初始为空，用户可以通过点击眼睛图标查看
      api_url: config.api_url || defaultUrl,
      model: config.model || '',
      enabled: config.enabled,
      tags: config.tags || [],
      description: config.description || '',
      metadata: config.metadata || {},
    });
    setEditingId(config.config_id);
    setIsAdding(true);
    setShowApiKey(false); // 重置显示状态
    
    // 不再自动加载模型列表，改为用户点击时手动加载
  };

  // 加载并显示API密钥
  const handleLoadApiKey = async () => {
    if (!editingId) return;
    
    if (showApiKey) {
      // 如果已经显示，则隐藏
      setShowApiKey(false);
      setNewConfig(prev => ({ ...prev, api_key: '' }));
      return;
    }
    
    // 加载API密钥
    setLoadingApiKey(true);
    try {
      const apiKey = await getLLMConfigApiKey(editingId);
      setNewConfig(prev => ({ ...prev, api_key: apiKey }));
      setShowApiKey(true);
    } catch (error) {
      console.error('Failed to load API key:', error);
      alert(`加载API密钥失败: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setLoadingApiKey(false);
    }
  };

  const handleCancel = () => {
    setIsAdding(false);
    setEditingId(null);
    setShowApiKey(false);
    setAvailableModels([]);
    setModelsError(null);
    setOllamaModels([]);
    setOllamaError(null);
    setShowOllamaModelDialog(false);
    setShowModelSelectDialog(false);
    
    // 重置表单，使用当前选中供应商的默认值
    if (selectedProvider) {
      const defaultModel = getProviderDefaultModel(selectedProvider.provider_type);
      const defaultUrl = selectedProvider.default_api_url || getProviderDefaultUrl(selectedProvider.provider_type, defaultModel);
      setNewConfig({
        name: '',
        provider: selectedProvider.provider_type,
        supplier: selectedProvider.provider_id,
        api_key: '',
        api_url: selectedProvider.override_url ? (selectedProvider.default_api_url || '') : defaultUrl,
        model: '',
        enabled: true,
        tags: [],
        description: '',
        metadata: {},
      });
    } else {
      setNewConfig({
        name: '',
        provider: 'openai',
        supplier: undefined,
        api_key: '',
        api_url: '',
        model: '',
        enabled: true,
        tags: [],
        description: '',
        metadata: {},
      });
    }
  };

  // 导出单个配置
  const handleExportConfig = async (config: LLMConfigFromDB) => {
    try {
      await downloadLLMConfigAsJson(config.config_id, config.name);
    } catch (error) {
      console.error('Failed to export config:', error);
      alert(`导出失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // 导出所有配置
  const handleExportAllConfigs = async () => {
    try {
      await downloadAllLLMConfigsAsJson();
    } catch (error) {
      console.error('Failed to export all configs:', error);
      alert(`导出失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // 导入配置
  const handleImportConfigs = async () => {
    try {
      const data = await importLLMConfigsFromFile();
      
      // 询问处理方式
      const skipExisting = confirm(
        '检测到配置文件。\n\n' +
        '点击"确定"：跳过已存在的同名配置\n' +
        '点击"取消"：创建新配置（添加后缀）'
      );
      
      const result = await importLLMConfigs(data, skipExisting);
      
      let message = `成功导入 ${result.imported.length} 个配置`;
      if (result.skipped.length > 0) {
        message += `\n跳过 ${result.skipped.length} 个已存在的配置`;
      }
      alert(message);
      
      // 刷新列表
      await loadConfigs();
    } catch (error) {
      console.error('Failed to import configs:', error);
      alert(`导入失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const getProviderPlaceholder = (provider: string) => {
    switch (provider) {
      case 'openai':
        return 'sk-...';
      case 'deepseek':
        return 'sk-...';
      case 'anthropic':
        return 'sk-ant-...';
      case 'gemini':
        return 'AIza...';
      case 'ollama':
        return 'Ollama 不需要 API 密钥（可选）';
      default:
        return 'API密钥';
    }
  };

  const getProviderDefaultUrl = (provider: string, model?: string) => {
    switch (provider) {
      case 'openai':
        // 检查是否是 DeepSeek 模型（兼容旧数据）
        if (model && model.includes('deepseek')) {
          return 'https://api.deepseek.com/v1/chat/completions';
        }
        return 'https://api.openai.com/v1/chat/completions';
      case 'deepseek':
        return 'https://api.deepseek.com/v1/chat/completions';
      case 'anthropic':
        return 'https://api.anthropic.com/v1/messages';
      case 'gemini':
        return 'https://generativelanguage.googleapis.com/v1beta';
      case 'ollama':
        return 'http://localhost:11434';
      default:
        return '';
    }
  };

  const getProviderDefaultModel = (provider: string) => {
    switch (provider) {
      case 'openai':
        return 'gpt-4';
      case 'deepseek':
        return 'deepseek-chat';
      case 'anthropic':
        return 'claude-3-5-sonnet-20241022';
      case 'gemini':
        return 'gemini-2.5-flash';
      case 'ollama':
        return '';
      default:
        return '';
    }
  };

  const getProviderUrlPlaceholder = (provider: string) => {
    switch (provider) {
      case 'openai':
        return 'https://api.openai.com/v1/chat/completions';
      case 'deepseek':
        return 'https://api.deepseek.com/v1/chat/completions';
      case 'anthropic':
        return 'https://api.anthropic.com/v1/messages';
      case 'gemini':
        return 'https://generativelanguage.googleapis.com/v1beta';
      case 'ollama':
        return 'http://10.104.4.16:11434 或 http://localhost:11434';
      default:
        return '例如: https://api.example.com/v1/chat/completions';
    }
  };

  // 获取当前选中的供应商（必须在所有 hooks 之后，但在条件返回之前）
  const selectedProvider = providers.find(p => p.provider_id === selectedProviderId);
  
  // 获取当前供应商的模型配置（必须在所有 hooks 之后，但在条件返回之前）
  const providerConfigs = useMemo(() => {
    if (!selectedProviderId || !selectedProvider) return [];
    // 按 supplier 归属过滤：supplier = supplier ?? provider
    // - 系统供应商：supplier 通常为空，此时 supplier=provider
    // - 自定义供应商：supplier=provider_id（token/计费归属），provider=provider_type（兼容路由）
    return configs.filter(c => (c.supplier || c.provider) === selectedProviderId);
  }, [configs, selectedProviderId, selectedProvider]);

  const mediaModelNameRegex = /(image|video|veo)/i;
  const isMediaModelByName = useCallback((config: LLMConfigFromDB) => {
    const source = `${config.model || ''} ${config.name || ''}`;
    return mediaModelNameRegex.test(source);
  }, []);

  const canToggleMediaVisible = useCallback((config: LLMConfigFromDB): boolean => {
    const caps = (config.metadata?.capabilities || {}) as { image_gen?: boolean; video_gen?: boolean };
    return Boolean(caps.image_gen || caps.video_gen || isMediaModelByName(config));
  }, [isMediaModelByName]);

  const handleToggleMediaVisible = useCallback(async (config: LLMConfigFromDB, visible: boolean) => {
    try {
      await updateLLMConfig(config.config_id, { media_visible: visible });
      setConfigs(prev => prev.map(c =>
        c.config_id === config.config_id ? { ...c, media_visible: visible } : c,
      ));
      setSelectedTokenConfigs(prev => prev.map(c =>
        c.config_id === config.config_id ? { ...c, media_visible: visible } : c,
      ));
      toast({
        title: visible ? '媒体创作台可见' : '已从媒体创作台隐藏',
        description: visible ? '可在媒体创作中选择该模型' : undefined,
        variant: 'success',
      });
    } catch (error) {
      toast({
        title: '更新失败',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    }
  }, []);

  const enabledProviderConfigs = useMemo(
    () => providerConfigs.filter((c) => c.enabled),
    [providerConfigs],
  );
  const enabledChatConfigs = useMemo(
    () => enabledProviderConfigs.filter((c) => !isMediaModelByName(c)),
    [enabledProviderConfigs, isMediaModelByName],
  );
  const enabledMediaConfigs = useMemo(
    () => enabledProviderConfigs.filter((c) => isMediaModelByName(c)),
    [enabledProviderConfigs, isMediaModelByName],
  );

  // 条件返回必须在所有 hooks 之后
  if (isLoading || isLoadingProviders) {
    return (
    <PageLayout
        title="LLM 模型配置"
        description="管理您的大语言模型 API 配置"
        icon={Brain}
        variant="persona"
        personaConstrainContent={true}
        showHeader={false}
      >
        <div className="llm-config-loading flex items-center justify-center py-12">
          <div className="w-6 h-6 border-2 border-[var(--border-default)] border-t-[var(--color-accent)] rounded-full animate-spin" />
          <span className="ml-3 text-[var(--text-muted)]">加载中...</span>
        </div>
      </PageLayout>
    );
  }

  // 顶部 Tab：选中 null 表示「添加供应商」页
  const showAddProviderContent = selectedProviderId === null;

  // 左侧供应商列表项（复用在侧栏与顶部 Tab）
  const renderProviderTabs = (vertical: boolean) => (
    <>
      <button
        type="button"
        onClick={() => setSelectedProviderId(null)}
        className={`
          llm-config-tab ${showAddProviderContent ? 'llm-config-tab--active' : ''}
          flex items-center gap-2 text-sm font-medium whitespace-nowrap transition-colors
          ${vertical ? 'llm-two-pane-nav-item w-full text-left' : 'px-4 py-2.5 border-b-2'}
          ${showAddProviderContent
            ? vertical
              ? 'is-active'
              : 'border-[var(--color-accent)] text-[var(--color-accent)]'
            : vertical
              ? ''
              : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
          }
        `}
      >
        <Plus className="w-4 h-4 flex-shrink-0" />
        添加供应商
      </button>
      {vertical && providerDragFrom !== null && providerInsertBefore === 0 && (
        <div className="relative h-0 pointer-events-none flex items-center justify-center py-0.5 -my-px" aria-hidden>
          <div className="h-0.5 w-full rounded-full bg-[var(--color-accent)] shadow-[0_0_8px_rgba(59,130,246,0.35)] [data-skin='niho']:shadow-[0_0_10px_rgba(0,255,136,0.5)]" />
        </div>
      )}
      {providers.map((provider, providerIndex) => {
        const isActive = selectedProviderId === provider.provider_id;
        const providerModelCount = configs.filter(c =>
          (c.supplier || c.provider) === provider.provider_id && c.enabled
        ).length;
        const isDraggingRow = vertical && providerDragFrom === providerIndex;
        return (
          <React.Fragment key={provider.provider_id}>
          <div
            className={`${vertical ? 'group/item' : 'group flex items-center gap-1 flex-shrink-0'} ${isDraggingRow ? 'opacity-50' : ''} transition-opacity`}
            draggable={vertical}
            onDragStart={vertical ? (e) => onProviderDragStart(e, providerIndex) : undefined}
            onDragEnd={vertical ? onProviderDragEnd : undefined}
            onDragOver={vertical ? (e) => onProviderDragOverRow(e, providerIndex) : undefined}
            onDrop={vertical ? (e) => void onProviderDropRow(e, providerIndex) : undefined}
          >
            <div className={vertical ? 'flex items-center gap-1 w-full min-w-0' : 'contents'}>
            {vertical && (
                <span
                  className="cursor-grab active:cursor-grabbing text-[var(--text-muted)] hover:text-[var(--text-secondary)] flex-shrink-0 p-0.5 -ml-0.5"
                  title="拖动排序"
                onClick={(e) => e.stopPropagation()}
                role="presentation"
              >
                <GripVertical className="w-3.5 h-3.5" />
              </span>
            )}
            <button
              type="button"
              onClick={() => setSelectedProviderId(provider.provider_id)}
              className={`
                llm-config-tab ${isActive ? 'llm-config-tab--active' : ''}
                flex items-center gap-2 text-sm font-medium whitespace-nowrap transition-colors
                ${vertical ? 'llm-two-pane-nav-item flex-1 min-w-0 text-left' : 'px-4 py-2.5 border-b-2'}
                ${isActive
                  ? vertical
                    ? 'is-active'
                    : 'border-[var(--color-accent)] text-[var(--color-accent)]'
                  : vertical
                    ? ''
                    : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                }
              `}
            >
              <span className="w-5 h-5 rounded flex items-center justify-center overflow-hidden flex-shrink-0">
                {renderProviderIcon(provider.provider_type, 'w-full h-full', 20)}
              </span>
              <span className={vertical ? 'truncate' : 'truncate max-w-[120px]'}>{getProviderDisplayName(provider)}</span>
              {providerModelCount > 0 && (
                <span className="text-xs opacity-70 flex-shrink-0">({providerModelCount})</span>
              )}
            </button>
            </div>
            {vertical && isActive && isCustomProvider(provider) && (
              <div className="flex items-center gap-0.5 mt-1.5 pl-7 opacity-0 group-hover/item:opacity-100 transition-opacity">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-[var(--text-muted)] hover:text-[var(--color-accent)] hover:bg-[var(--color-hover-bg)]"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditingProvider(provider);
                    setShowEditProviderDialog(true);
                  }}
                  title="编辑"
                >
                  <Edit2 className="w-3.5 h-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteProviderTarget(provider);
                  }}
                  title="删除"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            )}
            {!vertical && isActive && isCustomProvider(provider) && (
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <Button variant="ghost" size="icon" className="h-6 w-6 text-[var(--text-muted)] hover:text-[var(--color-accent)] hover:bg-[var(--color-hover-bg)]" onClick={(e) => { e.stopPropagation(); setEditingProvider(provider); setShowEditProviderDialog(true); }} title="编辑">
                  <Edit2 className="w-3.5 h-3.5" />
                </Button>
                <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" onClick={(e) => { e.stopPropagation(); setDeleteProviderTarget(provider); }} title="删除">
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            )}
          </div>
          {vertical && providerDragFrom !== null && providerInsertBefore === providerIndex + 1 && (
            <div className="relative h-0 pointer-events-none flex items-center justify-center py-0.5 -my-px" aria-hidden>
              <div className="h-0.5 w-full rounded-full bg-[var(--color-accent)] shadow-[0_0_8px_rgba(59,130,246,0.35)] [data-skin='niho']:shadow-[0_0_10px_rgba(0,255,136,0.5)]" />
            </div>
          )}
          </React.Fragment>
        );
      })}
    </>
  );

  return (
    <PageLayout
      title="LLM 模型配置"
      description="管理您的大语言模型 API 配置"
      icon={Brain}
      variant="persona"
      personaConstrainContent={false}
      showHeader={false}
    >
      {/* 整体居中：供应商列表 + Token/内容区 作为一块，两侧留白 */}
      <div className="llm-config-page h-full min-h-0 app-pane-pad">
        <div className="llm-two-pane h-full min-h-0 w-full max-w-6xl mx-auto">
          {/* 左侧：供应商列表（紧挨内容区） */}
          <div className="llm-two-pane-nav">
            <div className="llm-two-pane-nav-title">
              模型录入菜单
            </div>
            {/* 小屏：顶部横向 Tab */}
            <div className="lg:hidden overflow-x-auto no-scrollbar min-h-10">
              <div className="flex gap-0">
                {renderProviderTabs(false)}
              </div>
            </div>
            {/* 大屏：左侧竖排列表 */}
            <div className="llm-two-pane-nav-list hidden lg:flex">
              {renderProviderTabs(true)}
            </div>
          </div>

          {/* 右侧：Token 录入 / 模型内容区 */}
          <div className="llm-two-pane-content min-w-0 overflow-auto app-pane-pad-left pr-0 lg:pr-0">
            <div className="w-full max-w-2xl">
      {showAddProviderContent ? (
        <div className="space-y-6">
          <Card title="添加供应商" description="从系统支持的供应商中添加，或创建自定义供应商" variant="persona" size="relaxed">
            <div className="space-y-4">
              <Button
                onClick={() => setShowCreateProviderDialog(true)}
                variant="primary"
                size="sm"
                className="llm-config-btn-primary llm-config-btn-compact"
              >
                <Plus className="w-4 h-4 mr-2" />
                添加自定义供应商
              </Button>
              {supportedProviders.length > 0 && (() => {
                const addedProviderTypes = new Set(providers.map(p => p.provider_type));
                const unaddedProviders = supportedProviders.filter(
                  sp => !addedProviderTypes.has(sp.provider_type)
                );
                if (unaddedProviders.length === 0) return null;
                return (
                  <>
                     <div className="text-xs font-semibold text-[var(--text-muted)] ">
                       系统支持的供应商（点击添加）
                     </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {unaddedProviders.map(supportedProvider => (
                        <button
                          key={supportedProvider.provider_type}
                          type="button"
                          onClick={async () => {
                            try {
                              const existingProvider = providers.find(p => p.provider_type === supportedProvider.provider_type);
                              if (!existingProvider) {
                                const result = await createProvider({
                                  name: supportedProvider.name,
                                  provider_type: supportedProvider.provider_type,
                                  override_url: false,
                                  default_api_url: supportedProvider.default_api_url,
                                  logo_theme: 'auto',
                                });
                                await loadProviders();
                                setSelectedProviderId(result.provider_id);
                                toast({ title: '供应商添加成功', description: `已添加 ${supportedProvider.name}`, variant: 'success' });
                              } else {
                                setSelectedProviderId(existingProvider.provider_id);
                              }
                            } catch (error) {
                              toast({
                                title: '添加供应商失败',
                                description: error instanceof Error ? error.message : String(error),
                                variant: 'destructive',
                              });
                            }
                          }}
                          className="llm-config-provider-card app-card-item app-card-pad-sm flex items-center gap-3 text-left transition-colors"
                        >
                          <span className="w-8 h-8 rounded flex items-center justify-center flex-shrink-0 text-lg">
                            {supportedProvider.icon}
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-[var(--text-primary)] truncate">
                              {supportedProvider.name}
                            </div>
                            <div className="text-xs text-[var(--text-muted)] truncate ">
                              {supportedProvider.description}
                            </div>
                          </div>
                          <Plus className="w-4 h-4 text-[var(--text-muted)] flex-shrink-0" />
                        </button>
                      ))}
                    </div>
                  </>
                );
              })()}
            </div>
          </Card>
          {providers.length === 0 && (
            <EmptyState
              icon={Brain}
              title="暂无供应商"
              description="从上方添加系统支持的供应商，或创建自定义供应商"
            />
          )}
        </div>
      ) : !selectedProvider ? (
        <EmptyState
          icon={Brain}
          title="请选择供应商"
          description="点击顶部 Tab 切换供应商"
        />
      ) : (
        <div className="space-y-6">
            <div className="space-y-4">
              {/* Token 管理界面（仅主流供应商：openai, anthropic, gemini, deepseek） */}
              {selectedProvider && ['openai', 'anthropic', 'gemini', 'deepseek'].includes(selectedProvider.provider_type) && (
                <Card 
                  className="llm-config-token-card-wrap"
                  title="录入token"
                  description={undefined}
                  size="compact"
                  variant="persona"
                  headerAction={
                    <div className="relative z-10 flex gap-2">
                      <Button
                        variant="primary"
                        size="sm"
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          console.log('录入 Token 按钮被点击');
                          setNewTokenApiKey('');
                          setTokenAvailableModels([]);
                          setTokenError(null);
                          setSelectedModelsForToken(new Set());
                          setShowAddTokenDialog(true);
                          console.log('showAddTokenDialog 设置为 true');
                        }}
                        className="relative z-10 pointer-events-auto llm-config-btn-primary llm-config-btn-compact"
                      >
                        <Plus className="w-4 h-4 mr-2" />
                        录入 Token
                      </Button>
                    </div>
                  }
                >
                  {/* Token 列表（只显示 token，不显示模型详情） */}
                  <TokenListSimple
                    configs={providerConfigs}
                    selectedProvider={selectedProvider}
                    getLLMConfigApiKey={getLLMConfigApiKey}
                    showTokenKeys={showTokenKeys}
                    setShowTokenKeys={setShowTokenKeys}
                    tokenApiKeys={tokenApiKeys}
                    setTokenApiKeys={setTokenApiKeys}
                    loadingTokenApiKey={loadingTokenApiKey}
                    setLoadingTokenApiKey={setLoadingTokenApiKey}
                    onTokenClick={(tokenKey, configs, apiKey) => {
                      setSelectedTokenKey(tokenKey);
                      setSelectedTokenConfigs(configs);
                      setSelectedTokenApiKey(apiKey);
                      setShowTokenModelsDialog(true);
                    }}
                    onDeleteToken={async (tokenKey, configs) => {
                      // 删除该 token 下的所有配置
                      for (const config of configs) {
                        await deleteLLMConfig(config.config_id);
                      }
                      await loadConfigs();
                      toast({
                        title: 'Token 已删除',
                        description: `已删除 ${configs.length} 个模型配置`,
                        variant: 'success',
                      });
                    }}
                  />
                </Card>
              )}

              {/* 已有 Token 时，展示当前已开启模型（内部滚动） */}
              {selectedProvider && ['openai', 'anthropic', 'gemini', 'deepseek'].includes(selectedProvider.provider_type) && providerConfigs.length > 0 && (
                <div className="space-y-3">
                  <Card
                    title={`聊天模型 (${enabledChatConfigs.length})`}
                    size="compact"
                    variant="persona"
                  >
                    <div className="max-h-[240px] overflow-y-auto no-scrollbar pr-1 space-y-2">
                      {enabledChatConfigs.length === 0 ? (
                        <div className="text-sm text-[var(--text-muted)] py-2 px-1">
                          暂无聊天模型
                        </div>
                      ) : (
                        enabledChatConfigs.map((config) => (
                          <div
                            key={config.config_id}
                            className="llm-config-model-row app-list-item flex items-center justify-between p-3 transition-colors"
                          >
                            <div className="flex items-center space-x-3 flex-1 min-w-0">
                              <div className="w-8 h-8 rounded flex items-center justify-center overflow-hidden border border-[var(--border-default)] bg-[var(--surface-primary)]">
                                {renderProviderIcon(config.supplier || config.provider, 'w-full h-full', 24)}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="font-medium text-sm text-[var(--text-primary)] truncate">
                                  {config.name}
                                </div>
                                <div className="text-xs text-[var(--text-muted)] flex items-center gap-1 truncate">
                                  <span className="truncate">{config.model || '未设置模型'}</span>
                                  {config.supplier && config.supplier !== config.provider && (
                                     <span className="text-[var(--text-muted)] shrink-0">(兼容: {config.provider})</span>
                                  )}
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-2 ml-3 flex-shrink-0">
                              <span className="ui-badge-success text-xs">已启用</span>
                              <CapabilityIcons capabilities={config.metadata?.capabilities} modelName={config.model} className="w-3.5 h-3.5" />
                              {canToggleMediaVisible(config) && (
                                <div className="flex items-center gap-1.5 pl-2 border-l border-[var(--border-default)]">
                                  <Switch
                                    checked={!!config.media_visible}
                                    onCheckedChange={(v) => { void handleToggleMediaVisible(config, v); }}
                                  />
                                  <span className="text-xs text-[var(--text-secondary)]">媒体可见</span>
                                </div>
                              )}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </Card>

                  <Card
                    title={`媒体模型 (${enabledMediaConfigs.length})`}
                    size="compact"
                    variant="persona"
                  >
                    <div className="max-h-[240px] overflow-y-auto no-scrollbar pr-1 space-y-2">
                      {enabledMediaConfigs.length === 0 ? (
                        <div className="text-sm text-[var(--text-muted)] py-2 px-1">
                          暂无媒体模型
                        </div>
                      ) : (
                        enabledMediaConfigs.map((config) => (
                          <div
                            key={config.config_id}
                            className="llm-config-model-row app-list-item flex items-center justify-between p-3 transition-colors"
                          >
                            <div className="flex items-center space-x-3 flex-1 min-w-0">
                              <div className="w-8 h-8 rounded flex items-center justify-center overflow-hidden border border-[var(--border-default)] bg-[var(--surface-primary)]">
                                {renderProviderIcon(config.supplier || config.provider, 'w-full h-full', 24)}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="font-medium text-sm text-[var(--text-primary)] truncate">
                                  {config.name}
                                </div>
                                <div className="text-xs text-[var(--text-muted)] flex items-center gap-1 truncate">
                                  <span className="truncate">{config.model || '未设置模型'}</span>
                                  {config.supplier && config.supplier !== config.provider && (
                                     <span className="text-[var(--text-muted)] shrink-0">(兼容: {config.provider})</span>
                                  )}
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-2 ml-3 flex-shrink-0">
                              <span className="ui-badge-success text-xs">已启用</span>
                              <CapabilityIcons capabilities={config.metadata?.capabilities} modelName={config.model} className="w-3.5 h-3.5" />
                              {canToggleMediaVisible(config) && (
                                <div className="flex items-center gap-1.5 pl-2 border-l border-[var(--border-default)]">
                                  <Switch
                                    checked={!!config.media_visible}
                                    onCheckedChange={(v) => { void handleToggleMediaVisible(config, v); }}
                                  />
                                  <span className="text-xs text-[var(--text-secondary)]">媒体可见</span>
                                </div>
                              )}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </Card>
                </div>
              )}

              {/* 已有模型列表（非主流供应商或传统视图） */}
              {(!selectedProvider || !['openai', 'anthropic', 'gemini', 'deepseek'].includes(selectedProvider.provider_type)) && (
              <Card 
                title={providerConfigs.length === 0 ? '已添加的模型' : `已添加的模型 (${providerConfigs.length})`}
                description={providerConfigs.length === 0 ? '为当前供应商添加模型配置，每个模型可以设置独立的API密钥和参数' : undefined} 
                size="compact"
                variant="persona"
                headerAction={
                  <Button
                    variant="primary"
                    size="sm"
                    className="w-full md:w-auto llm-config-btn-primary llm-config-btn-compact"
                    onClick={async () => {
                      if (!selectedProvider) {
                        toast({
                          title: '提示',
                          description: '请先选择供应商',
                          variant: 'default',
                        });
                        return;
                      }
                      setIsAdding(true);
                      setEditingId(null);
                      setAvailableModels([]);
                      setModelsError(null);
                      setOllamaModels([]);
                      setOllamaError(null);
                      
                      // 初始化配置，继承供应商设置
                      const defaultModel = getProviderDefaultModel(selectedProvider.provider_type);
                      const defaultUrl = selectedProvider.default_api_url || getProviderDefaultUrl(selectedProvider.provider_type, defaultModel);
                      
                      setNewConfig({
                        name: '',
                        provider: selectedProvider.provider_type,
                        api_key: '',
                        api_url: selectedProvider.override_url ? (selectedProvider.default_api_url || '') : defaultUrl,
                        model: '',
                        enabled: true,
                        tags: [],
                        description: '',
                        metadata: {},
                      });
                      
                      // 如果供应商还没有logo，且是第一次添加模型，尝试自动下载logo（包括系统供应商）
                      // 不再需要下载logo，直接使用 @lobehub/icons 组件
                    }}
                  >
                    <Plus className="w-4 h-4 mr-2" />
                    添加模型
                  </Button>
                }
              >
                {providerConfigs.length === 0 ? (
                  <EmptyState
                    icon={Brain}
                    title="暂无模型"
                    description="点击右上角按钮添加第一个模型"
                  />
                ) : (
                  <div className="space-y-2">
                    {providerConfigs.map(config => (
                      <div
                        key={config.config_id}
                        className="llm-config-model-row app-list-item flex items-center justify-between p-3 transition-colors"
                      >
                        <div className="flex items-center space-x-3 flex-1">
                          <div className="w-8 h-8 rounded flex items-center justify-center overflow-hidden border border-[var(--border-default)] bg-[var(--surface-primary)]">
                            {/* 优先使用 supplier，其次使用 provider */}
                            {renderProviderIcon(config.supplier || config.provider, 'w-full h-full', 24)}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="font-medium text-sm text-[var(--text-primary)]">
                              {config.name}
                            </div>
                            <div className="text-xs text-[var(--text-muted)] flex items-center gap-1">
                              <span>{config.model || '未设置模型'}</span>
                              {/* 兼容路由（provider）作为补充信息展示 */}
                              {config.supplier && config.supplier !== config.provider && (
                                <span className="text-[var(--text-muted)]">(兼容: {config.provider})</span>
                              )}
                              <CapabilityIcons capabilities={config.metadata?.capabilities} modelName={config.model} className="w-3 h-3" />
                            </div>
                          </div>
                          {config.enabled ? (
                            <>
                              <span className="ui-badge-success text-xs">已启用</span>
                              <CapabilityIcons capabilities={config.metadata?.capabilities} modelName={config.model} className="w-3.5 h-3.5" />
                            </>
                          ) : (
                            <span className="px-2 py-1 text-xs bg-[var(--surface-secondary)] text-[var(--text-secondary)] rounded border border-[var(--border-default)]">
                              已禁用
                            </span>
                          )}
                          {canToggleMediaVisible(config) && (
                            <div className="ml-2 flex items-center gap-1.5 pl-2 border-l border-[var(--border-default)]">
                              <Switch
                                checked={!!config.media_visible}
                                onCheckedChange={(v) => { void handleToggleMediaVisible(config, v); }}
                              />
                              <span className="text-xs text-[var(--text-secondary)]">媒体可见</span>
                            </div>
                          )}
                        </div>
                        <div className="flex items-center space-x-2 ml-4">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-[var(--text-muted)] hover:text-[var(--color-accent)] hover:bg-[var(--color-accent-bg)]"
                            onClick={() => handleEditConfig(config)}
                          >
                            <Edit2 className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-[var(--color-secondary)] hover:bg-[var(--niho-mist-pink-bg)]"
                            onClick={() => setDeleteTarget(config)}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
              )}

              {/* 添加新模型配置 */}
              {isAdding && selectedProvider && (
                <Card 
                  title={editingId ? '编辑模型配置' : '添加新模型'}
                  variant="persona"
                  headerAction={
                    <Button onClick={handleCancel} variant="ghost" size="icon">
                      <X className="w-5 h-5" />
                    </Button>
                  }
                >
                  <FormFieldGroup spacing="compact">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {/* 注意：provider 和 override_url 现在从选中的供应商继承，不再需要用户选择 */}
                      
                      {/* API URL - 根据供应商设置显示 */}
                      {selectedProvider && (
                        <>
                          {selectedProvider.override_url ? (
                            // 如果供应商设置了 override_url，显示可编辑的URL输入框
                            <div className="md:col-span-2">
                              <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">
                                API URL <span className="text-[var(--color-error)]">*</span>
                              </label>
                              <input
                                type="text"
                                value={newConfig.api_url || selectedProvider.default_api_url || ''}
                                onChange={(e) => {
                                  setNewConfig({ ...newConfig, api_url: e.target.value, model: '' });
                                  setAvailableModels([]);
                                  setModelsError(null);
                                }}
                                className="input-field"
                                placeholder={selectedProvider.default_api_url || '请输入 API URL'}
                              />
                            </div>
                          ) : selectedProvider.provider_type === 'ollama' ? (
                            // Ollama 需要服务器地址
                            <div className="md:col-span-2">
                              <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">
                                Ollama 服务器地址 <span className="text-[var(--color-error)]">*</span>
                              </label>
                              <input
                                type="text"
                                value={newConfig.api_url || selectedProvider.default_api_url || getProviderDefaultUrl('ollama') || ''}
                                onChange={(e) => {
                                  setNewConfig({ ...newConfig, api_url: e.target.value, model: '' });
                                  setAvailableModels([]);
                                  setModelsError(null);
                                }}
                                className="input-field"
                                placeholder={selectedProvider.default_api_url || getProviderDefaultUrl('ollama')}
                              />
                              <p className="text-xs text-[var(--text-muted)] mt-1">
                                默认: {getProviderDefaultUrl('ollama')}
                                <span className="block mt-1">
                                  💡 提示：输入服务器地址后，点击模型名称输入框可以获取可用模型列表
                                </span>
                                <span className="block mt-1 text-[var(--color-success)] ">
                                  ✅ Ollama 模型不需要 API 密钥，可以直接使用
                                </span>
                              </p>
                            </div>
                          ) : (
                            // 其他供应商使用默认URL（只读显示）
                            <div className="md:col-span-2">
                              <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">
                                API URL <span className="text-xs text-[var(--text-muted)]">(使用默认: {selectedProvider.default_api_url || getProviderDefaultUrl(selectedProvider.provider_type)})</span>
                              </label>
                              <input
                                type="text"
                                value={newConfig.api_url || selectedProvider.default_api_url || getProviderDefaultUrl(selectedProvider.provider_type) || ''}
                                onChange={(e) => {
                                  setNewConfig({ ...newConfig, api_url: e.target.value, model: '' });
                                  setAvailableModels([]);
                                  setModelsError(null);
                                }}
                                className="input-field"
                                placeholder={selectedProvider.default_api_url || getProviderDefaultUrl(selectedProvider.provider_type)}
                                readOnly
                              />
                            </div>
                          )}
                        </>
                      )}

                      {/* API密钥 */}
                      {selectedProvider && selectedProvider.provider_type !== 'ollama' && (
              <div>
                          <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">
                            API密钥 {!editingId && <span className="text-[var(--color-error)]">*</span>} {editingId && <span className="text-xs text-[var(--text-muted)]">(留空则不更新)</span>}
                          </label>
                          <div className="relative">
                            <input
                              type={showApiKey ? 'text' : 'password'}
                              value={newConfig.api_key || ''}
                              onChange={(e) => {
                                setNewConfig({ ...newConfig, api_key: e.target.value });
                                // 清空模型列表，等待重新加载
                                setAvailableModels([]);
                                setModelsError(null);
                              }}
                              className="input-field pr-10"
                              placeholder={editingId
                                ? '点击右侧眼睛图标查看或留空不更新'
                                : (selectedProvider
                                  ? `请输入 ${getProviderDisplayName(selectedProvider)} 的 API Token（格式如 ${getProviderPlaceholder(selectedProvider.provider_type)}）`
                                  : '请输入 API Token')}
                              readOnly={editingId !== null && !showApiKey && !newConfig.api_key}
                            />
                            {editingId && (
                              <button
                                type="button"
                                onClick={handleLoadApiKey}
                                disabled={loadingApiKey}
                                className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors disabled:opacity-50"
                                title={showApiKey ? '隐藏API密钥' : '显示API密钥'}
                              >
                                {loadingApiKey ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : showApiKey ? (
                                  <EyeOff className="w-4 h-4" />
                                ) : (
                                  <Eye className="w-4 h-4" />
                                )}
                              </button>
                            )}
                          </div>
                        </div>
                      )}

                      {/* 模型名称 */}
                      <div>
                        <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">
                          模型名称
                          {selectedProvider && ((selectedProvider.provider_type === 'ollama' as any || (selectedProvider.provider_type !== 'ollama' && newConfig.api_key))) && (
                            <span className="text-xs text-[var(--text-muted)]">(点击输入框选择模型)</span>
                          )}
                        </label>
                        {selectedProvider && selectedProvider.provider_type === 'ollama' ? (
                          <div>
                            <input
                              type="text"
                              value={newConfig.model || ''}
                              onChange={(e) => {
                                const model = e.target.value;
                                setNewConfig(prev => ({
                                  ...prev,
                                  model,
                                  // 如果配置名称为空，自动填充为模型名称
                                  name: prev.name || model,
                                }));
                              }}
                              className="input-field cursor-pointer"
                              placeholder={
                                newConfig.api_url
                                  ? '点击选择模型'
                                  : '请先输入服务器地址，然后点击选择模型'
                              }
                              onClick={() => {
                                if (!newConfig.api_url) {
                                  toast({
                                    title: '提示',
                                    description: '请先输入 Ollama 服务器地址',
                                    variant: 'default',
                                  });
                                  return;
                                }
                                // 如果模型列表为空，先加载
                                if (ollamaModels.length === 0 && !isLoadingOllamaModels) {
                                  loadOllamaModels(newConfig.api_url);
                                }
                                setShowOllamaModelDialog(true);
                              }}
                              readOnly
                            />
                            {isLoadingOllamaModels && (
                              <div className="flex items-center space-x-2 mt-1 text-xs text-[var(--text-muted)]">
                                <Loader2 className="w-3 h-3 animate-spin " />
                                <span>正在获取模型列表...</span>
                              </div>
                            )}
                            {ollamaError && (
                              <div className="mt-1 text-xs text-[var(--color-error)]">
                                {ollamaError}
                              </div>
                            )}
                            {!isLoadingOllamaModels && !ollamaError && ollamaModels.length > 0 && (
                              <div className="mt-1 text-xs text-[var(--color-success)] ">
                                已找到 {ollamaModels.length} 个模型
                              </div>
                            )}
                            <ModelSelectDialog
                              open={showOllamaModelDialog}
                              onOpenChange={setShowOllamaModelDialog}
                              models={ollamaModels}
                              selectedModel={newConfig.model}
                              onSelect={(model) => {
                                setNewConfig(prev => ({
                                  ...prev,
                                  model,
                                  // 如果配置名称为空，自动填充为模型名称
                                  name: prev.name || model,
                                }));
                              }}
                              title="选择 Ollama 模型"
                              description={
                                ollamaModels.length > 0
                                  ? `从 ${ollamaModels.length} 个可用模型中选择`
                                  : isLoadingOllamaModels
                                  ? '正在加载模型列表...'
                                  : '暂无可用模型，请检查服务器地址'
                              }
                              loading={isLoadingOllamaModels}
                              emptyMessage="暂无可用模型，请先输入服务器地址"
                            />
                          </div>
                        ) : (
                          <div>
                            <input
                              type="text"
                              value={newConfig.model || ''}
                              onChange={(e) => {
                                const model = e.target.value;
                                setNewConfig(prev => ({
                                  ...prev,
                                  model,
                                  // 如果配置名称为空，自动填充为模型名称
                                  name: prev.name || model,
                                }));
                              }}
                              className="input-field cursor-pointer"
                              placeholder={
                                newConfig.api_key
                                  ? '点击选择模型'
                                  : '请先填写 API Key，然后点击选择模型'
                              }
                              onClick={() => {
                                if (!newConfig.api_key) {
                                  toast({
                                    title: '提示',
                                    description: '请先填写 API Key',
                                    variant: 'default',
                                  });
                                  return;
                                }
                                // 获取实际的 API URL（从供应商继承或使用默认值）
                                const actualApiUrl = newConfig.api_url || selectedProvider?.default_api_url || getProviderDefaultUrl(selectedProvider?.provider_type || 'openai');
                                
                                // 如果模型列表为空，先加载
                                if (availableModels.length === 0 && !isLoadingModels && selectedProvider) {
                                  loadModels(selectedProvider.provider_type, actualApiUrl, newConfig.api_key);
                                }
                                setShowModelSelectDialog(true);
                              }}
                              readOnly
                            />
                            {isLoadingModels && (
                              <div className="flex items-center space-x-2 mt-1 text-xs text-[var(--text-muted)]">
                                <Loader2 className="w-3 h-3 animate-spin " />
                                <span>正在从 API 获取模型列表...</span>
                              </div>
                            )}
                            {modelsError && (
                              <div className="mt-1 text-xs text-[var(--color-error)]">
                                {modelsError}
                              </div>
                            )}
                            {!isLoadingModels && !modelsError && availableModels.length > 0 && (
                              <div className="mt-1 text-xs text-[var(--color-success)] ">
                                已找到 {availableModels.length} 个模型
                              </div>
                            )}
                            <ModelSelectDialog
                              open={showModelSelectDialog}
                              onOpenChange={setShowModelSelectDialog}
                              models={availableModels}
                              selectedModel={newConfig.model}
                              onSelect={(model) => {
                                setNewConfig(prev => ({
                                  ...prev,
                                  model,
                                  // 如果配置名称为空，自动填充为模型名称
                                  name: prev.name || model,
                                }));
                              }}
                              title="选择模型"
                              description={
                                availableModels.length > 0
                                  ? `从 ${availableModels.length} 个可用模型中选择`
                                  : isLoadingModels
                                  ? '正在加载模型列表...'
                                  : '暂无可用模型'
                              }
                              loading={isLoadingModels}
                              emptyMessage={newConfig.api_key ? '暂无可用模型' : '请先填写 API Key'}
                            />
                          </div>
                        )}
                      </div>

                      {/* 描述 */}
                      <TextareaField
                        label="描述（可选）"
                        textareaProps={{
                          id: "config-description",
                          value: newConfig.description || '',
                          onChange: (e) => setNewConfig({ ...newConfig, description: e.target.value }),
                          rows: 2,
                          placeholder: "模型描述...",
                        }}
                        className="md:col-span-2"
                      />

                      {/* Gemini/Google 专用：联网搜索（放在 Thinking 前，便于找到） */}
                      {selectedProvider && (() => {
                        const pt = (selectedProvider.provider_type || '').toLowerCase();
                        const pid = (selectedProvider.provider_id || '').toLowerCase();
                        return pt === 'gemini' || pt === 'google' || pid === 'gemini' || pid === 'google';
                      })() && (
                        <div className="md:col-span-2 space-y-2">
                          <div className="text-xs font-medium text-[var(--text-muted)] border-b border-[var(--border-default)] pb-1">
                            Gemini / Google 选项
                          </div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <Switch
                              id="enableGoogleSearch"
                              checked={newConfig.metadata?.enableGoogleSearch ?? false}
                              onCheckedChange={(checked) => {
                                setNewConfig({
                                  ...newConfig,
                                  metadata: {
                                    ...newConfig.metadata,
                                    enableGoogleSearch: checked,
                                  },
                                });
                              }}
                            />
                            <label htmlFor="enableGoogleSearch" className="text-sm font-medium text-[var(--text-secondary)] cursor-pointer">
                              启用联网搜索（Google Search）
                            </label>
                            <span className="text-xs text-[var(--text-muted)]">
                              可检索实时网页并引用来源，需付费额度
                            </span>
                          </div>
                        </div>
                      )}

                      {/* Thinking 模式配置 */}
                      <div className="md:col-span-2 flex items-center space-x-2">
                        <Switch
                          id="enableThinking"
                          checked={newConfig.metadata?.enableThinking ?? false}
                          onCheckedChange={(checked) => {
                            setNewConfig({
                              ...newConfig,
                              metadata: {
                                ...newConfig.metadata,
                                enableThinking: checked,
                              },
                            });
                          }}
                        />
                        <label
                          htmlFor="enableThinking"
                          className="text-sm font-medium text-[var(--text-secondary)]"
                        >
                          启用 Thinking 模式（深度思考）
                        </label>
                        <span className="text-xs text-[var(--text-muted)]">
                          （一旦启用，聊天中不允许切换模式。用户可灵活测试后确认）
                        </span>
                      </div>

                      {/* 支持的输入类型 */}
                      <div className="md:col-span-2">
                        <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">
                          支持的输入类型
                        </label>
                        <div className="flex flex-wrap gap-3">
                          {(['text', 'image', 'video', 'audio'] as const).map((type) => {
                            const supportedInputs = newConfig.metadata?.supportedInputs || [];
                            const isChecked = supportedInputs.includes(type);
                            const icons = {
                              text: Type,
                              image: ImageIcon,
                              video: Video,
                              audio: Music,
                            };
                            const labels = {
                              text: '文字',
                              image: '图片',
                              video: '视频',
                              audio: '音频',
                            };
                            const Icon = icons[type];
                            
                            return (
                              <label key={type} className="flex items-center space-x-1.5 cursor-pointer">
                                <Checkbox
                                  checked={isChecked}
                                  onCheckedChange={(checked) => {
                                    const nextChecked = checked === true;
                                    const current = newConfig.metadata?.supportedInputs || [];
                                    const updated = nextChecked
                                      ? [...current, type]
                                      : current.filter((t: string) => t !== type);
                                    setNewConfig({
                                      ...newConfig,
                                      metadata: {
                                        ...newConfig.metadata,
                                        supportedInputs: updated,
                                      },
                                    });
                                  }}
                                />
                                <Icon className="w-4 h-4 text-[var(--text-secondary)]" />
                                <span className="text-sm text-[var(--text-secondary)]">{labels[type]}</span>
                              </label>
                            );
                          })}
                        </div>
                      </div>

                      {/* 支持的输出类型 */}
                      <div className="md:col-span-2">
                        <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">
                          支持的输出类型
                        </label>
                        <div className="flex flex-wrap gap-3">
                          {(['text', 'image', 'video', 'audio'] as const).map((type) => {
                            const supportedOutputs = newConfig.metadata?.supportedOutputs || [];
                            const isChecked = supportedOutputs.includes(type);
                            const icons = {
                              text: Type,
                              image: ImageIcon,
                              video: Video,
                              audio: Music,
                            };
                            const labels = {
                              text: '文字',
                              image: '图片',
                              video: '视频',
                              audio: '音频',
                            };
                            const Icon = icons[type];
                            
                            return (
                              <label key={type} className="flex items-center space-x-1.5 cursor-pointer">
                                <Checkbox
                                  checked={isChecked}
                                  onCheckedChange={(checked) => {
                                    const nextChecked = checked === true;
                                    const current = newConfig.metadata?.supportedOutputs || [];
                                    const updated = nextChecked
                                      ? [...current, type]
                                      : current.filter((t: string) => t !== type);
                                    setNewConfig({
                                      ...newConfig,
                                      metadata: {
                                        ...newConfig.metadata,
                                        supportedOutputs: updated,
                                      },
                                    });
                                  }}
                                />
                                <Icon className="w-4 h-4 text-[var(--text-secondary)]" />
                                <span className="text-sm text-[var(--text-secondary)]">{labels[type]}</span>
                              </label>
                            );
                          })}
                        </div>
                      </div>

                      {/* 启用状态 */}
                      <div className="md:col-span-2 flex items-center space-x-2">
                        <Switch
                          id="enabled"
                          checked={newConfig.enabled ?? true}
                          onCheckedChange={(checked) =>
                            setNewConfig({ ...newConfig, enabled: checked })
                          }
                        />
                        <label
                          htmlFor="enabled"
                          className="text-sm font-medium text-[var(--text-secondary)]"
                        >
                          启用此配置
                        </label>
                      </div>

                      {/* 配置名称 */}
                      <InputField
                        label="配置名称"
                        required
                        inputProps={{
                          id: "config-name",
                          type: "text",
                          value: newConfig.name || '',
                          onChange: (e) => setNewConfig({ ...newConfig, name: e.target.value }),
                          placeholder: "例如: OpenAI GPT-4",
                        }}
                      />

                      {/* 段名称 (Shortname) */}
                      <InputField
                        label="短名称 (Shortname)"
                        inputProps={{
                          id: "config-shortname",
                          type: "text",
                          value: newConfig.shortname || '',
                          onChange: (e) => setNewConfig({ ...newConfig, shortname: e.target.value }),
                          placeholder: "例如: GPT4",
                        }}
                      />
                    </div>
                  </FormFieldGroup>

                  {/* 操作按钮 */}
                  <div className="flex space-x-2 mt-4 pt-4 border-t border-[var(--border-default)]">
                    <Button
                      onClick={editingId ? handleUpdateConfig : handleAddConfig}
                      variant="primary"
                      className="[data-skin='niho']:bg-[var(--color-accent)] [data-skin='niho']:hover:bg-[var(--color-accent-hover)] [data-skin='niho']:text-black [data-skin='niho']:border-0"
                    >
                      <Save className="w-4 h-4" />
                      <span>{editingId ? '保存' : '添加'}</span>
                    </Button>
                    <Button
                      onClick={handleCancel}
                      variant="secondary"
                      className="niho-close-pink"
                    >
                      取消
                    </Button>
                  </div>
                </Card>
              )}
            </div>
        </div>
      )}

            </div>
          </div>
        </div>
      </div>

      {/* 创建自定义供应商对话框 */}
      <Dialog open={showCreateProviderDialog} onOpenChange={setShowCreateProviderDialog}>
        <DialogContent className="chatee-dialog-standard max-w-md w-[95vw] md:w-auto max-h-[80vh] md:max-h-none bg-[var(--surface-primary)] border-[var(--border-default)] text-[var(--text-primary)]">
          <DialogHeader>
            <DialogTitle className="text-[var(--text-primary)]">添加自定义供应商</DialogTitle>
            <DialogDescription className="text-[var(--text-secondary)]">
              添加一个自定义供应商，用于兼容模式的非主流供应商（如 DeepSeek、NVIDIA 等）
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <InputField
              label="供应商名称"
              required
              inputProps={{
                id: "provider-name",
                type: "text",
                value: newProvider.name,
                onChange: (e) => setNewProvider({ ...newProvider, name: e.target.value }),
                placeholder: "例如: NVIDIA",
              }}
            />

            <div>
              <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">
                兼容的供应商类型 <span className="text-[var(--color-error)]">*</span>
              </label>
              <Select
                value={newProvider.provider_type}
                onValueChange={(value) => {
                  setNewProvider({
                    ...newProvider,
                    provider_type: value as CreateProviderRequest['provider_type'],
                  });
                }}
              >
                <SelectTrigger className="input-field bg-[var(--surface-primary)] border-[var(--border-default)] text-[var(--text-primary)]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI (兼容 OpenAI API)</SelectItem>
                  <SelectItem value="deepseek">DeepSeek</SelectItem>
                  <SelectItem value="anthropic">Anthropic (Claude)</SelectItem>
                  <SelectItem value="gemini">Google Gemini</SelectItem>
                  <SelectItem value="ollama">Ollama</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center space-x-2">
              <Switch
                id="provider-override-url"
                checked={newProvider.override_url || false}
                onCheckedChange={(checked) => {
                  setNewProvider({ ...newProvider, override_url: checked });
                }}
              />
              <label
                htmlFor="provider-override-url"
                className="text-sm font-medium text-[var(--text-secondary)]"
              >
                覆盖默认 API URL
              </label>
            </div>

            {newProvider.override_url && (
              <InputField
                label="默认 API URL"
                inputProps={{
                  id: "provider-api-url",
                  type: "text",
                  value: newProvider.default_api_url || '',
                  onChange: (e) => setNewProvider({ ...newProvider, default_api_url: e.target.value }),
                  placeholder: "例如: https://integrate.api.nvidia.com/v1",
                }}
              />
            )}
          </div>

          <DialogFooter className="border-t border-[var(--border-default)]">
            <Button
              variant="secondary"
              className="niho-close-pink"
              onClick={() => {
                setShowCreateProviderDialog(false);
                setNewProvider({
                  name: '',
                  provider_type: 'openai',
                  override_url: false,
                  logo_theme: 'auto',
                });
              }}
            >
              取消
            </Button>
            <Button
              variant="primary"
              className="text-[var(--text-on-accent)]"
              onClick={async () => {
                if (!newProvider.name || !newProvider.provider_type) {
                  toast({
                    title: '请填写供应商名称和兼容类型',
                    variant: 'destructive',
                  });
                  return;
                }

                try {
                  const result = await createProvider(newProvider);
                  await loadProviders();
                  setSelectedProviderId(result.provider_id);
                  setShowCreateProviderDialog(false);
                  setNewProvider({
                    name: '',
                    provider_type: 'openai',
                    override_url: false,
                    logo_theme: 'auto',
                  });
                  
                  // 不再需要下载logo，直接使用 @lobehub/icons 组件

                  toast({
                    title: '供应商创建成功',
                    variant: 'success',
                  });
                } catch (error) {
                  toast({
                    title: '创建供应商失败',
                    description: error instanceof Error ? error.message : String(error),
                    variant: 'destructive',
                  });
                }
              }}
            >
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 编辑供应商对话框 */}
      <Dialog open={showEditProviderDialog} onOpenChange={setShowEditProviderDialog}>
        <DialogContent className="chatee-dialog-standard max-w-md w-[95vw] md:w-auto max-h-[80vh] md:max-h-none bg-[var(--surface-primary)] border-[var(--border-default)] text-[var(--text-primary)]">
          <DialogHeader>
            <DialogTitle className="text-[var(--text-primary)]">编辑供应商</DialogTitle>
            <DialogDescription className="text-[var(--text-secondary)]">
              {editingProvider && isDefaultMainstreamProvider(editingProvider)
                ? '默认供应商不可修改'
                : '修改供应商信息'}
            </DialogDescription>
          </DialogHeader>
          
          {editingProvider && (
            <div className="space-y-4 py-4">
              <InputField
                label="供应商名称"
                required
                inputProps={{
                  id: "edit-provider-name",
                  type: "text",
                  value: editingProvider.name,
                  onChange: (e) => setEditingProvider({ ...editingProvider, name: e.target.value }),
                  placeholder: "例如: NVIDIA",
                  disabled: isDefaultMainstreamProvider(editingProvider),
                }}
              />

              <div>
                <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">
                  兼容的供应商类型 <span className="text-[var(--color-error)]">*</span>
                </label>
                <Select
                  value={editingProvider.provider_type}
                  disabled={isDefaultMainstreamProvider(editingProvider)}
                  onValueChange={(value) => {
                    setEditingProvider({
                      ...editingProvider,
                      provider_type: value as LLMProvider['provider_type'],
                    });
                  }}
                >
                  <SelectTrigger className="input-field bg-[var(--surface-primary)] border-[var(--border-default)] text-[var(--text-primary)]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openai">OpenAI (兼容 OpenAI API)</SelectItem>
                    <SelectItem value="deepseek">DeepSeek</SelectItem>
                    <SelectItem value="anthropic">Anthropic (Claude)</SelectItem>
                    <SelectItem value="gemini">Google Gemini</SelectItem>
                    <SelectItem value="ollama">Ollama</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center space-x-2">
                <Switch
                  id="edit-provider-override-url"
                  checked={editingProvider.override_url || false}
                  disabled={isDefaultMainstreamProvider(editingProvider)}
                  onCheckedChange={(checked) => {
                    setEditingProvider({ ...editingProvider, override_url: checked });
                  }}
                />
                <label
                  htmlFor="edit-provider-override-url"
                  className="text-sm font-medium text-[var(--text-secondary)]"
                >
                  覆盖默认 API URL
                </label>
              </div>

              {editingProvider.override_url && (
                <InputField
                  label="自定义 API URL"
                  inputProps={{
                    id: "edit-provider-api-url",
                    type: "text",
                    value: editingProvider.default_api_url || '',
                    onChange: (e) => setEditingProvider({ ...editingProvider, default_api_url: e.target.value }),
                    placeholder: "例如: https://integrate.api.nvidia.com/v1",
                    disabled: isDefaultMainstreamProvider(editingProvider),
                  }}
                />
              )}
            </div>
          )}

          <DialogFooter className="border-t border-[var(--border-default)]">
            <Button
              variant="secondary"
              className="niho-close-pink"
              onClick={() => {
                setShowEditProviderDialog(false);
                setEditingProvider(null);
              }}
            >
              取消
            </Button>
            <Button
              variant="primary"
              className="text-[var(--text-on-accent)]"
              disabled={Boolean(editingProvider && isDefaultMainstreamProvider(editingProvider))}
              onClick={async () => {
                if (editingProvider && isDefaultMainstreamProvider(editingProvider)) {
                  toast({
                    title: '默认供应商不可修改',
                    variant: 'destructive',
                  });
                  return;
                }
                if (!editingProvider || !editingProvider.name || !editingProvider.provider_type) {
                  toast({
                    title: '请填写供应商名称和兼容类型',
                    variant: 'destructive',
                  });
                  return;
                }

                try {
                  await updateProvider(editingProvider.provider_id, {
                    name: editingProvider.name,
                    provider_type: editingProvider.provider_type,
                    override_url: editingProvider.override_url,
                    default_api_url: editingProvider.default_api_url,
                  });
                  await loadProviders();
                  setShowEditProviderDialog(false);
                  setEditingProvider(null);
                  toast({
                    title: '供应商更新成功',
                    variant: 'success',
                  });
                } catch (error) {
                  toast({
                    title: '更新供应商失败',
                    description: error instanceof Error ? error.message : String(error),
                    variant: 'destructive',
                  });
                }
              }}
            >
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除供应商确认对话框 */}
      <ConfirmDialog
        open={deleteProviderTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteProviderTarget(null);
        }}
        title="删除供应商"
        description={`确定要删除「${deleteProviderTarget?.name}」吗？此操作不可撤销，且会删除该供应商下的所有模型配置。`}
        variant="destructive"
        onConfirm={async () => {
          if (!deleteProviderTarget) return;
          const id = deleteProviderTarget.provider_id;
          setDeleteProviderTarget(null);
          try {
            await deleteProvider(id);
            await loadProviders();
            if (selectedProviderId === id) {
              setSelectedProviderId(null);
            }
            toast({
              title: '供应商删除成功',
              variant: 'success',
            });
          } catch (error) {
            toast({
              title: '删除供应商失败',
              description: error instanceof Error ? error.message : String(error),
              variant: 'destructive',
            });
          }
        }}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="删除模型配置"
        description={`确定要删除「${deleteTarget?.name}」吗？此操作不可撤销。`}
        variant="destructive"
        onConfirm={async () => {
          if (!deleteTarget) return;
          const id = deleteTarget.config_id;
          setDeleteTarget(null);
          await handleDeleteConfig(id);
        }}
      />

      {/* Logo选择对话框已移除，现在直接使用 @lobehub/icons 组件 */}

      {/* Token 录入对话框 */}
      <Dialog open={showAddTokenDialog} onOpenChange={setShowAddTokenDialog}>
        <DialogContent className="chatee-dialog-standard max-w-2xl w-[95vw] md:w-auto max-h-[80vh] md:max-h-none bg-[var(--surface-primary)] border-[var(--border-default)] text-[var(--text-primary)]">
          <DialogHeader>
            <DialogTitle className="text-[var(--text-primary)]">
              {selectedProvider ? `录入 Token - ${getProviderDisplayName(selectedProvider)}` : '录入 Token'}
            </DialogTitle>
            <DialogDescription className="text-[var(--text-secondary)]">
              {selectedProvider ? `为 ${getProviderDisplayName(selectedProvider)} 输入 API Token，系统将自动获取支持的模型列表` : '输入 API Token，系统将自动获取支持的模型列表'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 max-h-[60vh] overflow-auto no-scrollbar">
            <div>
              <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">
                API Token <span className="text-[var(--color-error)]">*</span>
              </label>
              <input
                type="password"
                value={newTokenApiKey}
                onChange={(e) => setNewTokenApiKey(e.target.value)}
                className="input-field w-full"
                placeholder={selectedProvider
                  ? `请输入 ${getProviderDisplayName(selectedProvider)} 的 API Token（格式如 ${getProviderPlaceholder(selectedProvider.provider_type)}）`
                  : '请输入 API Token'}
              />
            </div>
            {tokenError && (
              <div className="text-sm text-[var(--color-error)]">
                {tokenError}
              </div>
            )}
            {tokenAvailableModels.length === 0 ? (
              <Button
                variant="primary"
                onClick={async () => {
                  if (!selectedProvider) return;
                  if (!newTokenApiKey.trim()) {
                    setTokenError('请输入 API Token');
                    return;
                  }
                  
                  setIsLoadingTokenModels(true);
                  setTokenError(null);
                  
                  try {
                    if (!selectedProvider || !selectedProvider.provider_id) {
                      setTokenError('请先选择供应商');
                      setIsLoadingTokenModels(false);
                      return;
                    }
                    
                    const defaultUrl = selectedProvider.default_api_url || getProviderDefaultUrl(selectedProvider.provider_type);
                    const models = await fetchModelsForProvider(
                      selectedProvider.provider_type,
                      defaultUrl,
                      newTokenApiKey.trim(),
                      true // includeCapabilities = true
                    );
                    
                    if (models.length === 0) {
                      setTokenError('未获取到可用模型，请检查 Token 是否正确');
                      setIsLoadingTokenModels(false);
                      return;
                    }
                    
                    setTokenAvailableModels(models);

                    // 查找同 Token 下已存在的 Agent 配置模型名（去重）
                    const existingModelNames = new Set<string>();
                    for (const cfg of providerConfigs) {
                      if (cfg.metadata?.media_purpose) continue;
                      try {
                        const k = await getLLMConfigApiKey(cfg.config_id);
                        if (k === newTokenApiKey.trim()) existingModelNames.add(cfg.model || cfg.name);
                      } catch { /* skip */ }
                    }

                    // 提取模型 ID，排除已存在的模型
                    const modelIds = models
                      .map(m => typeof m === 'string' ? m : m.id)
                      .filter(id => !existingModelNames.has(id));
                    setSelectedModelsForToken(new Set<string>(modelIds));

                    if (existingModelNames.size > 0) {
                      console.log(`[Token录入] 已排除 ${existingModelNames.size} 个已存在的模型:`, [...existingModelNames]);
                    }
                  } catch (error) {
                    setTokenError(error instanceof Error ? error.message : '获取模型列表失败');
                  } finally {
                    setIsLoadingTokenModels(false);
                  }
                }}
                disabled={isLoadingTokenModels || !newTokenApiKey.trim()}
                className="w-full llm-config-btn-compact"
              >
                {isLoadingTokenModels ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    获取模型列表...
                  </>
                ) : (
                  '获取模型列表'
                )}
              </Button>
            ) : (
              <div>
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="text-sm font-medium text-[var(--text-secondary)]">
                    选择要启用的模型 ({selectedModelsForToken.size} / {tokenAvailableModels.length})
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="shrink-0 llm-config-btn-compact"
                    onClick={async () => {
                      if (!selectedProvider || !newTokenApiKey.trim()) return;
                      setIsLoadingTokenModels(true);
                      setTokenError(null);
                      try {
                        const defaultUrl = selectedProvider.default_api_url || getProviderDefaultUrl(selectedProvider.provider_type);
                        const models = await fetchModelsForProvider(
                          selectedProvider.provider_type,
                          defaultUrl,
                          newTokenApiKey.trim(),
                          true
                        );
                        if (models.length === 0) {
                          setTokenError('未获取到可用模型');
                          return;
                        }
                        setTokenAvailableModels(models);
                        const modelIds = models.map(m => typeof m === 'string' ? m : m.id);
                        setSelectedModelsForToken(prev => {
                          const next = new Set<string>();
                          modelIds.forEach(id => { if (prev.has(id)) next.add(id); });
                          return next;
                        });
                      } catch (error) {
                        setTokenError(error instanceof Error ? error.message : '获取模型列表失败');
                      } finally {
                        setIsLoadingTokenModels(false);
                      }
                    }}
                    disabled={isLoadingTokenModels}
                  >
                    {isLoadingTokenModels ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <RefreshCw className="w-4 h-4 mr-1" />
                    )}
                    重新获取模型列表
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2 mb-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    className="llm-config-btn-compact"
                    onClick={() => {
                      const callableIds = tokenAvailableModels
                        .filter(m => typeof m === 'string' || (m as ModelWithCapabilities).isCallable !== false)
                        .map(m => typeof m === 'string' ? m : m.id);
                      setSelectedModelsForToken(new Set(callableIds));
                    }}
                  >
                    全选
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="llm-config-btn-compact"
                    onClick={() => setSelectedModelsForToken(new Set())}
                  >
                    全不选
                  </Button>
                </div>
                <div className="max-h-60 overflow-y-auto border border-[var(--border-default)] rounded-lg p-2 space-y-1 bg-[var(--surface-primary)]">
                  {tokenAvailableModels.map(model => {
                    const modelId = typeof model === 'string' ? model : model.id;
                    const capabilities = typeof model === 'object' && 'capabilities' in model ? model.capabilities : null;
                    const isCallable = typeof model === 'object' && 'isCallable' in model ? (model as ModelWithCapabilities).isCallable !== false : true;
                    // 检查同 Token 下是否已存在（通过初始加载时排除的逻辑反推）
                    const alreadyExists = !isCallable ? false : providerConfigs.some(c =>
                      !c.metadata?.media_purpose && (c.model || c.name) === modelId
                    );
                    return (
                      <label
                        key={modelId}
                        className={`flex items-center gap-2 p-2 rounded ${
                          alreadyExists
                            ? 'opacity-50 cursor-default'
                            : isCallable
                              ? 'hover:bg-[var(--color-hover-bg)] cursor-pointer'
                              : 'opacity-60 cursor-not-allowed'
                        }`}
                        title={alreadyExists ? '该模型已在此 Token 下配置' : !isCallable ? '该模型不支持对话（仅支持生图等），不可用于聊天' : undefined}
                      >
                        <input
                          type="checkbox"
                          checked={alreadyExists || selectedModelsForToken.has(modelId)}
                          disabled={!isCallable || alreadyExists}
                          onChange={(e) => {
                            if (!isCallable || alreadyExists) return;
                            const newSet = new Set(selectedModelsForToken);
                            if (e.target.checked) {
                              newSet.add(modelId);
                            } else {
                              newSet.delete(modelId);
                            }
                            setSelectedModelsForToken(newSet);
                          }}
                          className="rounded"
                        />
                        <span className={`text-sm flex-1 ${alreadyExists ? 'text-[var(--text-muted)] opacity-70' : 'text-[var(--text-secondary)]'}`}>{modelId}</span>
                        {alreadyExists && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-success-bg)] text-[var(--color-success)]">已配置</span>
                        )}
                        <CapabilityIcons capabilities={capabilities} modelName={modelId} className="w-4 h-4" />
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          <DialogFooter className="[data-skin='niho']:border-t-[var(--niho-text-border)]">
            <Button
              variant="secondary"
              className="niho-close-pink"
              onClick={() => {
                setShowAddTokenDialog(false);
                setNewTokenApiKey('');
                setTokenAvailableModels([]);
                setSelectedModelsForToken(new Set());
                setTokenError(null);
              }}
            >
              取消
            </Button>
            {tokenAvailableModels.length > 0 && (
              <Button
                variant="primary"
                className="[data-skin='niho']:bg-[var(--color-accent)] [data-skin='niho']:hover:bg-[var(--color-accent-hover)] [data-skin='niho']:text-black [data-skin='niho']:border-0"
                onClick={async () => {
                  if (!selectedProvider) return;
                  if (selectedModelsForToken.size === 0) {
                    setTokenError('请至少选择一个模型');
                    return;
                  }
                  
                  try {
                    const defaultUrl = selectedProvider.default_api_url || getProviderDefaultUrl(selectedProvider.provider_type);
                    
                    // 禁用当前供应商的所有现有配置
                    for (const config of providerConfigs) {
                      if (config.enabled) {
                        await updateLLMConfig(config.config_id, { enabled: false });
                      }
                    }
                    
                    // 创建新的模型配置
                    if (!selectedProvider || !selectedProvider.provider_id) {
                      setTokenError('供应商信息不完整，无法创建配置');
                      return;
                    }
                    
                    const supplierId = selectedProvider.provider_id;
                    console.log('[Token录入] 准备创建配置:');
                    console.log('  - selectedProvider:', {
                      provider_id: selectedProvider.provider_id,
                      provider_type: selectedProvider.provider_type,
                      name: selectedProvider.name
                    });
                    console.log('  - supplier (provider_id):', supplierId);
                    console.log('  - provider (provider_type):', selectedProvider.provider_type);
                    
                    if (!supplierId) {
                      setTokenError('供应商 ID 为空，无法创建配置');
                      return;
                    }
                    
                    // 获取同 Token 下已有的 Agent 配置（用于去重）
                    const existingAgentModels = new Set<string>();
                    for (const cfg of providerConfigs) {
                      if (cfg.metadata?.media_purpose) continue; // 跳过媒体配置
                      try {
                        const k = await getLLMConfigApiKey(cfg.config_id);
                        if (k === newTokenApiKey.trim()) existingAgentModels.add(cfg.model || cfg.name);
                      } catch { /* skip */ }
                    }

                    let createdCount = 0;
                    let skippedCount = 0;
                    for (const modelId of selectedModelsForToken) {
                      // 去重：同 Token 下已存在同名 Agent 配置则跳过
                      if (existingAgentModels.has(modelId)) {
                        skippedCount++;
                        console.log(`[Token录入] 跳过已存在的模型: ${modelId}`);
                        continue;
                      }
                      const modelInfo = tokenAvailableModels.find(m => (typeof m === 'string' ? m : m.id) === modelId);
                      const isCallable = typeof modelInfo === 'object' && 'isCallable' in modelInfo ? (modelInfo as ModelWithCapabilities).isCallable !== false : true;
                      if (!isCallable) continue; // 仅支持对话的模型才创建配置
                      const capabilities = typeof modelInfo === 'object' && 'capabilities' in modelInfo ? modelInfo.capabilities : null;
                      
                      const configData = {
                        name: modelId,
                        provider: selectedProvider.provider_type,
                        supplier: supplierId,
                        api_key: newTokenApiKey.trim(),
                        api_url: defaultUrl,
                        model: modelId,
                        enabled: true,
                        tags: [],
                        description: '',
                        metadata: { ...(capabilities ? { capabilities } : {}), is_callable: isCallable },
                      };
                      
                      try {
                        const created = await createLLMConfig(configData);
                        console.log('[Token录入] ✅ 创建成功:', created.config_id);
                        createdCount++;
                      } catch (error) {
                        console.error('[Token录入] ❌ 创建失败:', error);
                        throw error;
                      }
                    }
                    
                    await loadConfigs();
                    
                    toast({
                      title: 'Token 录入成功',
                      description: skippedCount > 0
                        ? `已创建 ${createdCount} 个模型配置（跳过 ${skippedCount} 个已存在的模型）`
                        : `已创建 ${createdCount} 个模型配置并设为当前使用`,
                      variant: 'success',
                    });
                    
                    setShowAddTokenDialog(false);
                    setNewTokenApiKey('');
                    setTokenAvailableModels([]);
                    setSelectedModelsForToken(new Set());
                    setTokenError(null);
                  } catch (error) {
                    setTokenError(error instanceof Error ? error.message : '创建模型配置失败');
                  }
                }}
                disabled={selectedModelsForToken.size === 0}
              >
                <Save className="w-4 h-4 mr-2" />
                保存 ({selectedModelsForToken.size} 个模型)
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Token 模型管理对话框 */}
      <Dialog open={showTokenModelsDialog} onOpenChange={setShowTokenModelsDialog}>
        <DialogContent className="chatee-dialog-standard max-w-2xl w-[95vw] md:w-auto max-h-[80vh] md:max-h-none [data-skin='niho']:bg-[var(--niho-pure-black)] [data-skin='niho']:border-[var(--niho-text-border)]">
          <DialogHeader>
            <DialogTitle className="[data-skin='niho']:text-[var(--text-primary)]">管理 Token 模型</DialogTitle>
            <DialogDescription className="[data-skin='niho']:text-[var(--niho-skyblue-gray)]">
              查看和管理该 Token 下的所有模型，可以同时启用多个模型，但不同 Token 之间只能启用一个
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 max-h-[60vh] overflow-auto no-scrollbar">
            {selectedTokenApiKey && (
              <div className="p-3 bg-[var(--surface-secondary)] rounded-lg border border-[var(--border-default)]">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-xs text-[var(--text-muted)]">API Token</div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="llm-config-btn-compact"
                    onClick={async () => {
                      if (!selectedProvider || !selectedTokenApiKey) return;
                      setIsLoadingAvailableModels(true);
                      try {
                        const defaultUrl = selectedProvider.default_api_url || getProviderDefaultUrl(selectedProvider.provider_type);
                        const models = await fetchModelsForProvider(
                          selectedProvider.provider_type,
                          defaultUrl,
                          selectedTokenApiKey,
                          true // includeCapabilities = true
                        );
                        const modelIds = models.map(m => typeof m === 'string' ? m : m.id);
                        setAvailableModelsForSelectedToken(modelIds);
                        setAvailableModelsWithCapabilitiesForToken(models);
                        const existingModelNames = new Set(selectedTokenConfigs.map(c => c.model || c.name));
                        const newModels = modelIds.filter(m => !existingModelNames.has(m));
                        setSelectedNewModels(new Set(newModels));
                        setShowAddModelsSection(true);
                        toast({
                          title: '获取成功',
                          description: `找到 ${models.length} 个可用模型`,
                          variant: 'success',
                        });
                      } catch (error) {
                        toast({
                          title: '获取失败',
                          description: error instanceof Error ? error.message : '无法获取模型列表',
                          variant: 'destructive',
                        });
                      } finally {
                        setIsLoadingAvailableModels(false);
                      }
                    }}
                    disabled={isLoadingAvailableModels}
                  >
                    {isLoadingAvailableModels ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        获取中...
                      </>
                    ) : (
                      <>
                        <RefreshCw className="w-4 h-4 mr-2" />
                        重新获取模型列表
                      </>
                    )}
                  </Button>
                </div>
                <div className="text-sm font-mono break-all text-[var(--text-secondary)]">
                  {selectedTokenApiKey}
                </div>
              </div>
            )}
            
            {/* ═══ 模型列表 — 分 Agent / 媒体 两栏 ═══ */}
            {showAddModelsSection && availableModelsForSelectedToken.length > 0 && (() => {
              // 把模型分为两组
              const allItems = availableModelsWithCapabilitiesForToken.length > 0
                ? availableModelsWithCapabilitiesForToken
                : availableModelsForSelectedToken.map(id => id);

              const agentItems: typeof allItems = [];
              const mediaItems: typeof allItems = [];
              for (const item of allItems) {
                const cap = typeof item === 'object' && item && 'capabilities' in item
                  ? (item as ModelWithCapabilities).capabilities : null;
                const isCallable = typeof item === 'object' && item && 'isCallable' in item
                  ? (item as ModelWithCapabilities).isCallable !== false : true;
                const inferredCap = inferMediaCapabilitiesFromModelId(typeof item === 'string' ? item : item.id, cap);
                const hasMedia = !!(inferredCap?.image_gen || inferredCap?.video_gen);
                if (isCallable) agentItems.push(item);
                if (hasMedia) mediaItems.push(item);
              }

              /** 渲染一行模型（复用逻辑） */
              const renderModelRow = (item: string | ModelWithCapabilities, purpose: 'agent' | 'media') => {
                const modelId = typeof item === 'string' ? item : item.id;
                const capabilities = typeof item === 'object' && item && 'capabilities' in item
                  ? (item as ModelWithCapabilities).capabilities : null;
                const isCallable = typeof item === 'object' && item && 'isCallable' in item
                  ? (item as ModelWithCapabilities).isCallable !== false : true;
                const inferredCap = inferMediaCapabilitiesFromModelId(modelId, capabilities);
                const hasMedia = !!(inferredCap?.image_gen || inferredCap?.video_gen);
                const existingConfig = selectedTokenConfigs.find(c => {
                  const matched = (c.model || c.name) === modelId;
                  if (!matched) return false;
                  if (purpose === 'media') return !!(c.metadata?.media_purpose);
                  return !c.metadata?.media_purpose;
                });
                const isConfigured = !!existingConfig;
                const displayCapabilities = existingConfig?.metadata?.capabilities ?? capabilities;
                const canToggle = purpose === 'agent' ? isCallable : hasMedia;

                if (isConfigured) {
                  return (
                    <div
                      key={`${purpose}-${modelId}`}
                      className={`rounded border border-transparent ${canToggle ? 'hover:border-[var(--border-default)]' : 'opacity-60'}`}
                    >
                      <div
                        className={`flex items-center justify-between rounded p-2 ${canToggle ? 'hover:bg-[var(--color-hover-bg)]' : ''}`}
                      >
                        <div className="flex items-center gap-3 flex-1 min-w-0">
                          <Switch
                            checked={existingConfig.enabled}
                            disabled={!canToggle}
                            onCheckedChange={async () => {
                              if (!canToggle) return;
                              try {
                                const newEnabled = !existingConfig.enabled;
                                /* 同 Token 下的 agent 模型：关闭其他 Token */
                                let toDisable: LLMConfigFromDB[] = [];
                                if (newEnabled && purpose === 'agent') {
                                  for (const otherConfig of providerConfigs) {
                                    try {
                                      const otherApiKey = await getLLMConfigApiKey(otherConfig.config_id);
                                      if (otherApiKey !== selectedTokenApiKey && otherConfig.enabled) toDisable.push(otherConfig);
                                    } catch { /* skip */ }
                                  }
                                  await Promise.all(toDisable.map(c2 => updateLLMConfig(c2.config_id, { enabled: false })));
                                }
                                await updateLLMConfig(existingConfig.config_id, { enabled: newEnabled });
                                setConfigs(prev => prev.map(c2 => {
                                  if (c2.config_id === existingConfig.config_id) return { ...c2, enabled: newEnabled };
                                  if (newEnabled && toDisable.some(d => d.config_id === c2.config_id)) return { ...c2, enabled: false };
                                  return c2;
                                }));
                                setSelectedTokenConfigs(prev => prev.map(c2 => c2.config_id === existingConfig.config_id ? { ...c2, enabled: newEnabled } : c2));
                                toast({ title: newEnabled ? '已启用' : '已禁用', variant: 'success' });
                              } catch (error) {
                                toast({ title: '更新失败', description: error instanceof Error ? error.message : String(error), variant: 'destructive' });
                              }
                            }}
                          />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium flex items-center gap-2 text-[var(--text-primary)]">
                              <span className="truncate">{modelId}</span>
                              <CapabilityIcons capabilities={displayCapabilities} modelName={modelId} className="w-3.5 h-3.5" />
                            </div>
                            <div className="text-xs text-[var(--text-muted)]">
                              {existingConfig.enabled ? '已启用' : '未启用'}
                              {purpose === 'media' && <span className="ml-1 text-[var(--color-secondary)]">(媒体)</span>}
                            </div>
                          </div>
                        </div>
                        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-[var(--color-error)] hover:bg-[var(--color-error-bg)] hover:text-[var(--color-error)]"
                          onClick={async () => {
                            if (confirm(`确定要删除${purpose === 'media' ? '媒体' : ''}模型 "${modelId}" 吗？`)) {
                              try {
                                await deleteLLMConfig(existingConfig.config_id);
                                await loadConfigs();
                                setSelectedTokenConfigs(prev => prev.filter(c2 => c2.config_id !== existingConfig.config_id));
                                if (showAddModelsSection && selectedProvider && selectedTokenApiKey) {
                                  const defaultUrl = selectedProvider.default_api_url || getProviderDefaultUrl(selectedProvider.provider_type);
                                  try {
                                    const models = await fetchModelsForProvider(selectedProvider.provider_type, defaultUrl, selectedTokenApiKey, true);
                                    setAvailableModelsForSelectedToken(models.map(m => typeof m === 'string' ? m : m.id));
                                    setAvailableModelsWithCapabilitiesForToken(models);
                                  } catch { /* ignore */ }
                                }
                                toast({ title: '已删除', variant: 'success' });
                              } catch (error) {
                                toast({ title: '删除失败', description: error instanceof Error ? error.message : String(error), variant: 'destructive' });
                              }
                            }
                          }}
                          title="删除模型"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                      {hasMedia && (
                        <div className="flex items-center gap-2 rounded-b border-t border-[var(--border-subtle)] bg-[var(--surface-secondary)] px-2 py-1.5 pl-10">
                          <Switch
                            checked={!!existingConfig.media_visible}
                            onCheckedChange={async (v) => {
                              try {
                                await updateLLMConfig(existingConfig.config_id, { media_visible: v });
                                setConfigs(prev => prev.map(c2 =>
                                  c2.config_id === existingConfig.config_id ? { ...c2, media_visible: v } : c2,
                                ));
                                setSelectedTokenConfigs(prev => prev.map(c2 =>
                                  c2.config_id === existingConfig.config_id ? { ...c2, media_visible: v } : c2,
                                ));
                                toast({
                                  title: v ? '媒体创作台可见' : '已从媒体创作台隐藏',
                                  description: v ? '可在媒体创作中选择该模型' : undefined,
                                  variant: 'success',
                                });
                              } catch (error) {
                                toast({
                                  title: '更新失败',
                                  description: error instanceof Error ? error.message : String(error),
                                  variant: 'destructive',
                                });
                              }
                            }}
                          />
                          <span className="text-xs text-[var(--text-secondary)]">媒体创作台可见</span>
                          <span className="hidden text-xs text-[var(--text-muted)] sm:inline">开启后可在「媒体创作」中选用</span>
                        </div>
                      )}
                    </div>
                  );
                }

                // 未配置的模型
                return (
                  <div
                    key={`${purpose}-${modelId}`}
                    className={`flex items-center justify-between rounded p-2 ${canToggle ? 'hover:bg-[var(--color-hover-bg)]' : 'opacity-40 cursor-not-allowed'}`}
                    title={!canToggle ? (purpose === 'agent' ? '该模型不支持对话' : '该模型不支持图像/视频生成') : undefined}
                  >
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <Switch
                        checked={false}
                        disabled={!canToggle}
                        onCheckedChange={async () => {
                          if (!canToggle || !selectedProvider) return;
                          try {
                            let toDisable: LLMConfigFromDB[] = [];
                            if (purpose === 'agent') {
                              for (const otherConfig of providerConfigs) {
                                try {
                                  const otherApiKey = await getLLMConfigApiKey(otherConfig.config_id);
                                  if (otherApiKey !== selectedTokenApiKey && otherConfig.enabled) toDisable.push(otherConfig);
                                } catch { /* skip */ }
                              }
                              await Promise.all(toDisable.map(c2 => updateLLMConfig(c2.config_id, { enabled: false })));
                            }
                            const defaultUrl = selectedProvider.default_api_url || getProviderDefaultUrl(selectedProvider.provider_type);
                            const { config_id } = await createLLMConfig({
                              name: purpose === 'media' ? `[媒体] ${modelId}` : modelId,
                              provider: selectedProvider.provider_type,
                              supplier: selectedProvider.provider_id,
                              api_key: selectedTokenApiKey,
                              api_url: defaultUrl,
                              model: modelId,
                              enabled: true,
                              tags: purpose === 'media' ? ['media'] : [],
                              description: purpose === 'media' ? '媒体创作专用模型' : '',
                              media_visible: purpose === 'media',
                              metadata: {
                                ...(capabilities ? { capabilities } : {}),
                                is_callable: isCallable,
                                ...(purpose === 'media' ? { media_purpose: true } : {}),
                              },
                            });
                            const fullConfig = await getLLMConfig(config_id);
                            setConfigs(prev => [
                              ...prev.map(c2 => toDisable.some(d => d.config_id === c2.config_id) ? { ...c2, enabled: false } : c2),
                              fullConfig,
                            ]);
                            setSelectedTokenConfigs(prev => [...prev, fullConfig]);
                            toast({ title: '已添加并启用', description: `${purpose === 'media' ? '媒体' : ''}模型 "${modelId}" 已启用`, variant: 'success' });
                          } catch (error) {
                            toast({ title: '添加失败', description: error instanceof Error ? error.message : '无法添加模型', variant: 'destructive' });
                          }
                        }}
                        className="opacity-60"
                      />
                      <div className="flex-1 min-w-0">
                        <div className={`text-sm flex items-center gap-2 ${canToggle ? 'text-[var(--text-secondary)]' : 'text-[var(--text-muted)]'}`}>
                          <span className="truncate">{modelId}</span>
                          <CapabilityIcons capabilities={displayCapabilities} modelName={modelId} className="w-3.5 h-3.5" />
                        </div>
                        <div className="text-xs text-[var(--text-muted)]">未配置</div>
                      </div>
                    </div>
                  </div>
                );
              };

              return (
                <div className="space-y-4">
                  {/* ── Agent 模型区 ── */}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Brain className="w-4 h-4 text-[var(--color-accent)]" />
                      <span className="text-sm font-medium text-[var(--text-secondary)]">
                        Agent 对话模型 ({agentItems.length})
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-accent)]/10 text-[var(--color-accent)]">聊天</span>
                    </div>
                    <div className="max-h-60 overflow-y-auto rounded-lg border border-[var(--border-default)] bg-[var(--surface-primary)] p-2 space-y-1">
                      {agentItems.length === 0
                        ? <p className="p-2 text-xs text-[var(--text-muted)]">该 Token 没有支持对话的模型</p>
                        : agentItems.map(item => renderModelRow(item, 'agent'))
                      }
                    </div>
                  </div>

                  {/* ── 媒体创作模型区 ── */}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <ImageIcon className="w-4 h-4 text-[var(--color-secondary)]" />
                      <span className="text-sm font-medium text-[var(--text-secondary)]">
                        媒体创作模型 ({mediaItems.length})
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-secondary)]/10 text-[var(--color-secondary)]">生图/生视频</span>
                    </div>
                    <div className="max-h-60 overflow-y-auto rounded-lg border border-[var(--border-default)] bg-[var(--surface-primary)] p-2 space-y-1">
                      {mediaItems.length === 0
                        ? <p className="p-2 text-xs text-[var(--text-muted)]">该 Token 没有支持媒体生成的模型</p>
                        : mediaItems.map(item => renderModelRow(item, 'media'))
                      }
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* 未重新获取时显示已配置的模型（分组展示） */}
            {!showAddModelsSection && (() => {
              const agentConfigs = selectedTokenConfigs.filter(c => !c.metadata?.media_purpose);
              const mediaConfigs = selectedTokenConfigs.filter(c => c.metadata?.media_purpose);

              const renderConfigRow = (config: LLMConfigFromDB, purpose: 'agent' | 'media') => {
                const cap = config.metadata?.capabilities;
                return (
                  <div
                    key={config.config_id}
                    className="app-list-item flex items-center justify-between p-3"
                  >
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <Switch
                        checked={config.enabled}
                        onCheckedChange={async () => {
                          try {
                            const newEnabled = !config.enabled;
                            let toDisable: LLMConfigFromDB[] = [];
                            if (newEnabled && purpose === 'agent') {
                              for (const otherConfig of providerConfigs) {
                                try {
                                  const otherApiKey = await getLLMConfigApiKey(otherConfig.config_id);
                                  if (otherApiKey !== selectedTokenApiKey && otherConfig.enabled) toDisable.push(otherConfig);
                                } catch { /* skip */ }
                              }
                              await Promise.all(toDisable.map(c => updateLLMConfig(c.config_id, { enabled: false })));
                            }
                            await updateLLMConfig(config.config_id, { enabled: newEnabled });
                            setConfigs(prev => prev.map(c => {
                              if (c.config_id === config.config_id) return { ...c, enabled: newEnabled };
                              if (newEnabled && toDisable.some(d => d.config_id === c.config_id)) return { ...c, enabled: false };
                              return c;
                            }));
                            setSelectedTokenConfigs(prev => prev.map(c => c.config_id === config.config_id ? { ...c, enabled: newEnabled } : c));
                            toast({ title: newEnabled ? '已启用' : '已禁用', variant: 'success' });
                          } catch (error) {
                            toast({ title: '更新失败', description: error instanceof Error ? error.message : String(error), variant: 'destructive' });
                          }
                        }}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium flex items-center gap-2 text-[var(--text-primary)]">
                          <span className="truncate">{config.name}</span>
                          <CapabilityIcons capabilities={cap} modelName={config.model} className="w-3.5 h-3.5" />
                        </div>
                        <div className="text-xs text-[var(--text-muted)]">
                          {config.model || '未设置模型'}
                        </div>
                      </div>
                    </div>
                    <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-[var(--color-error)] hover:bg-[var(--color-error-bg)] hover:text-[var(--color-error)]"
                      onClick={async () => {
                        if (confirm(`确定要删除模型 "${config.name}" 吗？`)) {
                          try {
                            await deleteLLMConfig(config.config_id);
                            await loadConfigs();
                            setSelectedTokenConfigs(prev => prev.filter(c => c.config_id !== config.config_id));
                            toast({ title: '已删除', variant: 'success' });
                          } catch (error) {
                            toast({ title: '删除失败', description: error instanceof Error ? error.message : String(error), variant: 'destructive' });
                          }
                        }
                      }}
                      title="删除模型"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                );
              };

              return (
                <div className="space-y-4">
                  {/* Agent 模型 */}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Brain className="w-4 h-4 text-[var(--color-accent)]" />
                      <span className="text-sm font-medium text-[var(--text-secondary)]">
                        Agent 对话模型 ({agentConfigs.length})
                      </span>
                    </div>
                    {agentConfigs.length === 0
                      ? <p className="px-2 text-xs text-[var(--text-muted)]">暂无 Agent 模型配置</p>
                      : agentConfigs.map(c => renderConfigRow(c, 'agent'))
                    }
                  </div>
                  {/* 媒体模型 */}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <ImageIcon className="w-4 h-4 text-[var(--color-secondary)]" />
                      <span className="text-sm font-medium text-[var(--text-secondary)]">
                        媒体创作模型 ({mediaConfigs.length})
                      </span>
                    </div>
                    {mediaConfigs.length === 0
                      ? <p className="px-2 text-xs text-[var(--text-muted)]">暂无媒体创作模型</p>
                      : mediaConfigs.map(c => renderConfigRow(c, 'media'))
                    }
                  </div>
                </div>
              );
            })()}
          </div>
          <DialogFooter className="border-t border-[var(--border-default)]">
            <Button
              variant="secondary"
              className="niho-close-pink"
              onClick={() => {
                setShowTokenModelsDialog(false);
                setShowAddModelsSection(false);
                setSelectedNewModels(new Set());
                setAvailableModelsForSelectedToken([]);
                setAvailableModelsWithCapabilitiesForToken([]);
              }}
            >
              关闭
            </Button>
            <Button
              variant="primary"
              className="[data-skin='niho']:bg-[var(--color-accent)] [data-skin='niho']:hover:bg-[var(--color-accent-hover)] [data-skin='niho']:text-black [data-skin='niho']:border-0"
              onClick={async () => {
                try {
                  const toDisable: LLMConfigFromDB[] = [];
                  for (const config of providerConfigs) {
                    try {
                      const otherApiKey = await getLLMConfigApiKey(config.config_id);
                      if (otherApiKey !== selectedTokenApiKey && config.enabled) toDisable.push(config);
                    } catch { /* skip */ }
                  }
                  await Promise.all(toDisable.map(c => updateLLMConfig(c.config_id, { enabled: false })));
                  const toEnable = selectedTokenConfigs.filter(c => !c.enabled);
                  await Promise.all(toEnable.map(c => updateLLMConfig(c.config_id, { enabled: true })));
                  setConfigs(prev => prev.map(c => {
                    if (toDisable.some(d => d.config_id === c.config_id)) return { ...c, enabled: false };
                    if (selectedTokenConfigs.some(t => t.config_id === c.config_id)) return { ...c, enabled: true };
                    return c;
                  }));
                  setSelectedTokenConfigs(prev => prev.map(c => ({ ...c, enabled: true })));
                  toast({
                    title: '已设为当前使用',
                    description: `已启用该 Token 下的 ${selectedTokenConfigs.length} 个模型`,
                    variant: 'success',
                  });
                  if (showAddModelsSection && selectedProvider && selectedTokenApiKey) {
                    try {
                      const defaultUrl = selectedProvider.default_api_url || getProviderDefaultUrl(selectedProvider.provider_type);
                      const models = await fetchModelsForProvider(
                        selectedProvider.provider_type,
                        defaultUrl,
                        selectedTokenApiKey,
                        true
                      );
                      const modelIds = models.map(m => typeof m === 'string' ? m : m.id);
                      setAvailableModelsForSelectedToken(modelIds);
                      setAvailableModelsWithCapabilitiesForToken(models);
                    } catch (error) {
                      console.error('Failed to refresh models:', error);
                    }
                  }
                } catch (error) {
                  toast({
                    title: '更新失败',
                    description: error instanceof Error ? error.message : String(error),
                    variant: 'destructive',
                  });
                }
              }}
            >
              启用该 Token 的所有模型
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Logo 设置对话框已移除，现在直接使用 @lobehub/icons 组件 */}

    </PageLayout>
  );
};

export default LLMConfigPanel;
