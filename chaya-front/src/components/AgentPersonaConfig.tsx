/**
 * Agent Persona 配置组件
 * 可切换的 persona：人设、音色。
 * Intelligence（智能层）：自驱思考（Primag）、知识拓扑（只读）。
 */

import React, { useState, useEffect } from 'react';
import { 
  Volume2, Brain, Sparkles, Plus, Trash2, 
  Clock, Tag, AlertCircle, Upload, Loader,
} from 'lucide-react';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Label } from './ui/Label';
import { Switch } from './ui/Switch';
import { Badge } from './ui/PageLayout';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from './ui/Select';
import { toast } from './ui/use-toast';
import { fetchVoices, uploadCustomVoice, Voice } from '../services/ttsApi';
import TopologyReadonlyPanel from './TopologyReadonlyPanel';

// ============================================================================
// 类型定义
// ============================================================================

/** 语音人设配置 */
export interface VoicePersonaConfig {
  enabled: boolean;
  provider: 'openai' | 'elevenlabs' | 'azure' | 'local';
  voiceId: string;
  voiceName: string;
  language: string;
  speed?: number;
  pitch?: number;
  elevenLabsToken?: string;
}

/** 自驱思考配置 */
export interface AutonomousThinkingConfig {
  enabled: boolean;
  interval: number; // 毫秒
  topics: string[];
  memoryTriggered: boolean;
}

/** 记忆锚点规则（旧版会话侧规则；基本设置中拓扑为只读） */
export interface MemoryTriggerRule {
  id: string;
  name: string;
  type: 'importance' | 'recent' | 'keyword';
  keywords?: string[];
  threshold?: number;
  withinHours?: number;
  action: string;
  cooldown: number; // 毫秒
  enabled: boolean;
}

/** @deprecated 已从前端移除配置项，保留字段以兼容旧数据 */
export type ResponseMode = 'normal' | 'persona';

/** Agent 人设完整配置 */
export interface AgentPersonaFullConfig {
  voice: VoicePersonaConfig;
  thinking: AutonomousThinkingConfig;
  memoryTriggers: MemoryTriggerRule[];
  /** @deprecated 不再提供 UI，持久化时保持或默认为 normal */
  responseMode: ResponseMode;
  /**
   * 记忆锚点总开关（与会话侧规则列表配合）。
   * 与拓扑相关的「记忆锚点命中」依赖 `topologyEnabled`：需先开启行为拓扑以构建知识图谱。
   */
  memoryTriggersEnabled?: boolean;
  /** @deprecated 技能属 Hardness，不再在 Persona 中配置 */
  skillTriggerEnabled?: boolean;
  /** 是否让 Orchestrator 读取行为拓扑（agent_topology）：命中路径可动态合并技能与步骤提示 */
  topologyEnabled?: boolean;
}

interface AgentPersonaConfigProps {
  config: AgentPersonaFullConfig;
  onChange: (config: AgentPersonaFullConfig) => void;
  compact?: boolean;
  /** 仅渲染可切换的「声音」配置（人设与声音 Tab 用） */
  voiceOnly?: boolean;
  /** Intelligence 面板：自驱思考（stub）、知识拓扑（只读） */
  chayaOnly?: boolean;
  /** 基本设置「智能化」岛屿：自驱思考（stub）+ 记忆锚点（仅后端知识行为拓扑只读） */
  intelOnly?: boolean;
  /** 与 chayaOnly / intelOnly 联用：拉取 `/api/agents/{id}/topology` */
  topologyAgentId?: string;
}

// ============================================================================
// 默认配置
// ============================================================================

export const defaultPersonaConfig: AgentPersonaFullConfig = {
  voice: {
    enabled: false,
    provider: 'openai',
    voiceId: 'alloy',
    voiceName: 'Alloy',
    language: 'zh-CN',
    speed: 1.0,
    pitch: 1.0,
  },
  thinking: {
    enabled: false,
    interval: 3600000, // 1小时
    topics: [],
    memoryTriggered: false,
  },
  memoryTriggers: [],
  responseMode: 'normal', // 默认普通聊天模式
  memoryTriggersEnabled: true,
  topologyEnabled: false,
};

// ============================================================================
// 预设选项
// ============================================================================

const VOICE_PROVIDERS = [
  { value: 'openai', label: 'OpenAI TTS', voices: [
    { id: 'alloy', name: 'Alloy (中性)' },
    { id: 'echo', name: 'Echo (男声)' },
    { id: 'fable', name: 'Fable (英式)' },
    { id: 'onyx', name: 'Onyx (低沉男声)' },
    { id: 'nova', name: 'Nova (女声)' },
    { id: 'shimmer', name: 'Shimmer (柔和女声)' },
  ]},
  { value: 'elevenlabs', label: 'ElevenLabs', voices: [
    { id: 'rachel', name: 'Rachel' },
    { id: 'adam', name: 'Adam' },
    { id: 'antoni', name: 'Antoni' },
  ]},
  { value: 'azure', label: 'Azure TTS', voices: [
    { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓 (女声)' },
    { id: 'zh-CN-YunxiNeural', name: '云希 (男声)' },
    { id: 'zh-CN-YunyangNeural', name: '云扬 (新闻)' },
  ]},
];

const LANGUAGES = [
  { value: 'zh-CN', label: '中文 (简体)' },
  { value: 'zh-TW', label: '中文 (繁体)' },
  { value: 'en-US', label: 'English (US)' },
  { value: 'en-GB', label: 'English (UK)' },
  { value: 'ja-JP', label: '日本語' },
  { value: 'ko-KR', label: '한국어' },
];

const THINKING_INTERVALS = [
  { value: 1800000, label: '30 分钟' },
  { value: 3600000, label: '1 小时' },
  { value: 7200000, label: '2 小时' },
  { value: 14400000, label: '4 小时' },
  { value: 86400000, label: '1 天' },
];

const TRIGGER_COOLDOWNS = [
  { value: 300000, label: '5 分钟' },
  { value: 900000, label: '15 分钟' },
  { value: 1800000, label: '30 分钟' },
  { value: 3600000, label: '1 小时' },
];

// ============================================================================
// 语音配置面板
// ============================================================================

interface VoiceConfigPanelProps {
  config: VoicePersonaConfig;
  onChange: (config: VoicePersonaConfig) => void;
}

const VoiceConfigPanel: React.FC<VoiceConfigPanelProps> = ({ config, onChange }) => {
  const [elevenLabsVoices, setElevenLabsVoices] = useState<Voice[]>([]);
  const [loadingVoices, setLoadingVoices] = useState(false);
  const [uploadingVoice, setUploadingVoice] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [voiceName, setVoiceName] = useState('');
  const [showUploadForm, setShowUploadForm] = useState(false);

  useEffect(() => {
    if (config.provider === 'elevenlabs' && elevenLabsVoices.length === 0) {
      loadElevenLabsVoices();
    }
  }, [config.provider]);

  const loadElevenLabsVoices = async () => {
    try {
      setLoadingVoices(true);
      const voices = await fetchVoices(config.elevenLabsToken);
      setElevenLabsVoices(voices);
      
      if (voices.length > 0 && !config.voiceId) {
        onChange({
          ...config,
          voiceId: voices[0].voice_id,
          voiceName: voices[0].name,
        });
      }
    } catch (error) {
      toast({
        title: '加载语音失败',
        description: error instanceof Error ? error.message : '获取 ElevenLabs 语音列表失败',
        variant: 'destructive',
      });
    } finally {
      setLoadingVoices(false);
    }
  };

  const handleUploadCustomVoice = async () => {
    if (!selectedFile || !voiceName.trim()) {
      toast({
        title: '缺少信息',
        description: '请选择文件和输入语音名称',
        variant: 'destructive',
      });
      return;
    }

    try {
      setUploadingVoice(true);
      const result = await uploadCustomVoice(selectedFile, voiceName.trim(), undefined, config.elevenLabsToken);
      toast({
        title: '语音上传成功',
        description: result.message,
      });
      
      onChange({
        ...config,
        voiceId: result.voice_id,
        voiceName: result.name,
      });
      
      setSelectedFile(null);
      setVoiceName('');
      setShowUploadForm(false);
      
      await loadElevenLabsVoices();
    } catch (error) {
      toast({
        title: '上传失败',
        description: error instanceof Error ? error.message : '无法上传语音',
        variant: 'destructive',
      });
    } finally {
      setUploadingVoice(false);
    }
  };

  const currentProvider = VOICE_PROVIDERS.find(p => p.value === config.provider);
  let voices = currentProvider?.voices || [];
  
  if (config.provider === 'elevenlabs') {
    voices = elevenLabsVoices.map(v => ({
      id: v.voice_id,
      name: `${v.name}${v.gender ? ` (${v.gender})` : ''}`,
    }));
  }

  return (
    <div className="border border-[var(--color-border)] rounded-lg overflow-hidden [data-skin='niho']:border-[var(--niho-text-border)] [data-skin='niho']:bg-[var(--niho-pure-black-elevated)]">
      <div className="flex items-center justify-between px-3 py-2 bg-[var(--color-bg-secondary)] [data-skin='niho']:bg-[var(--niho-text-bg)] [data-skin='niho']:border-b [data-skin='niho']:border-[var(--niho-text-border)]">
        <div className="flex items-center gap-2">
          <Volume2 className="w-4 h-4 text-blue-500 [data-skin='niho']:text-[var(--color-info)]" />
          <span className="text-sm font-medium [data-skin='niho']:text-[var(--text-primary)]">音色</span>
        </div>
        <Switch
          checked={config.enabled}
          onCheckedChange={(enabled) => onChange({ ...config, enabled })}
        />
      </div>
      {config.enabled && (
        <div className="space-y-4 p-3 [data-skin='niho']:bg-[#000000]">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="[data-skin='niho']:text-[var(--text-primary)]">TTS 提供者</Label>
              <Select
                value={config.provider}
                onValueChange={(provider: any) => {
                  const newProvider = VOICE_PROVIDERS.find(p => p.value === provider);
                  const defaultVoice = provider === 'elevenlabs' 
                    ? (elevenLabsVoices[0]?.voice_id || '') 
                    : (newProvider?.voices[0]?.id || '');
                  onChange({
                    ...config,
                    provider,
                    voiceId: defaultVoice,
                    voiceName: provider === 'elevenlabs'
                      ? (elevenLabsVoices[0]?.name || '')
                      : (newProvider?.voices[0]?.name || ''),
                  });
                }}
              >
                <SelectTrigger className="[data-skin='niho']:bg-[var(--niho-pure-black-elevated)] [data-skin='niho']:border-[var(--niho-text-border)] [data-skin='niho']:text-[var(--text-primary)] [data-skin='niho']:focus:border-[var(--color-accent-bg)]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="[data-skin='niho']:bg-[#000000] [data-skin='niho']:border-[var(--niho-text-border)]">
                  {VOICE_PROVIDERS.map(p => (
                    <SelectItem 
                      key={p.value} 
                      value={p.value}
                      className="[data-skin='niho']:text-[var(--text-primary)] [data-skin='niho']:hover:bg-[var(--color-accent-bg)] [data-skin='niho']:focus:bg-[var(--color-accent-bg)]"
                    >
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="[data-skin='niho']:text-[var(--text-primary)]">
                语音角色
                {config.provider === 'elevenlabs' && loadingVoices && (
                  <Loader className="w-3 h-3 inline ml-2 animate-spin" />
                )}
              </Label>
              <Select
                value={config.voiceId}
                onValueChange={(voiceId) => {
                  const voice = voices.find(v => v.id === voiceId);
                  onChange({
                    ...config,
                    voiceId,
                    voiceName: voice?.name || voiceId,
                  });
                }}
              >
                <SelectTrigger className="[data-skin='niho']:bg-[var(--niho-pure-black-elevated)] [data-skin='niho']:border-[var(--niho-text-border)] [data-skin='niho']:text-[var(--text-primary)] [data-skin='niho']:focus:border-[var(--color-accent-bg)]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="[data-skin='niho']:bg-[#000000] [data-skin='niho']:border-[var(--niho-text-border)]">
                  {voices.map(v => (
                    <SelectItem 
                      key={v.id} 
                      value={v.id}
                      className="[data-skin='niho']:text-[var(--text-primary)] [data-skin='niho']:hover:bg-[var(--color-accent-bg)] [data-skin='niho']:focus:bg-[var(--color-accent-bg)]"
                    >
                      {v.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {config.provider === 'elevenlabs' && (
            <div className="space-y-3">
              <div>
                <Label className="[data-skin='niho']:text-[var(--text-primary)]">ElevenLabs API Key</Label>
                <Input
                  type="password"
                  value={config.elevenLabsToken || ''}
                  onChange={(e) => onChange({ ...config, elevenLabsToken: e.target.value })}
                  placeholder="sk_..."
                  className="[data-skin='niho']:bg-[#000000] [data-skin='niho']:border-[var(--niho-text-border)] [data-skin='niho']:text-[var(--text-primary)]"
                />
                <p className="text-xs text-gray-500 mt-1 [data-skin='niho']:text-[var(--text-secondary)]">
                  获取 token: <a href="https://elevenlabs.io/api" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">elevenlabs.io/api</a>
                </p>
              </div>
              <div className="flex gap-2">
                <Button 
                  size="sm" 
                  variant="outline"
                  onClick={() => setShowUploadForm(!showUploadForm)}
                  className="[data-skin='niho']:border-[var(--niho-text-border)] [data-skin='niho']:text-[var(--text-primary)] [data-skin='niho']:hover:bg-[var(--niho-text-bg)]"
                >
                  <Upload className="w-4 h-4 mr-2" />
                  上传自定义语音
                </Button>
              </div>
            </div>
           )}

          {showUploadForm && config.provider === 'elevenlabs' && (
            <div className="space-y-3 p-3 bg-[var(--color-bg-secondary)] rounded [data-skin='niho']:bg-[var(--niho-text-bg)]">
              <div>
                <Label className="[data-skin='niho']:text-[var(--text-primary)]">语音文件</Label>
                <input
                  type="file"
                  accept=".mp3,.wav,.m4a,.webm"
                  onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                  disabled={uploadingVoice}
                  className="w-full px-2 py-2 border border-[var(--color-border)] rounded text-sm [data-skin='niho']:border-[var(--niho-text-border)] [data-skin='niho']:bg-[#000000] [data-skin='niho']:text-[var(--text-primary)]"
                />
                <p className="text-xs text-gray-500 mt-1 [data-skin='niho']:text-[var(--text-secondary)]">
                  支持格式: mp3, wav, m4a, webm
                </p>
              </div>
              <div>
                <Label className="[data-skin='niho']:text-[var(--text-primary)]">语音名称</Label>
                <Input
                  value={voiceName}
                  onChange={(e) => setVoiceName(e.target.value)}
                  placeholder="输入自定义语音名称"
                  disabled={uploadingVoice}
                  className="[data-skin='niho']:bg-[#000000] [data-skin='niho']:border-[var(--niho-text-border)] [data-skin='niho']:text-[var(--text-primary)]"
                />
              </div>
              <div className="flex gap-2">
                <Button 
                  size="sm"
                  onClick={handleUploadCustomVoice}
                  disabled={uploadingVoice || !selectedFile || !voiceName.trim()}
                  className="[data-skin='niho']:bg-[var(--color-accent)] [data-skin='niho']:text-[#000000]"
                >
                  {uploadingVoice ? '上传中...' : '上传'}
                </Button>
                <Button 
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setShowUploadForm(false);
                    setSelectedFile(null);
                    setVoiceName('');
                  }}
                  disabled={uploadingVoice}
                  className="[data-skin='niho']:border-[var(--niho-text-border)] [data-skin='niho']:text-[var(--text-primary)]"
                >
                  取消
                </Button>
              </div>
            </div>
          )}

          <div className="grid grid-cols-3 gap-4">
            <div>
              <Label className="[data-skin='niho']:text-[var(--text-primary)]">语言</Label>
              <Select
                value={config.language}
                onValueChange={(language) => onChange({ ...config, language })}
              >
                <SelectTrigger className="[data-skin='niho']:bg-[var(--niho-pure-black-elevated)] [data-skin='niho']:border-[var(--niho-text-border)] [data-skin='niho']:text-[var(--text-primary)] [data-skin='niho']:focus:border-[var(--color-accent-bg)]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="[data-skin='niho']:bg-[#000000] [data-skin='niho']:border-[var(--niho-text-border)]">
                  {LANGUAGES.map(l => (
                    <SelectItem 
                      key={l.value} 
                      value={l.value}
                      className="[data-skin='niho']:text-[var(--text-primary)] [data-skin='niho']:hover:bg-[var(--color-accent-bg)] [data-skin='niho']:focus:bg-[var(--color-accent-bg)]"
                    >
                      {l.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="[data-skin='niho']:text-[var(--text-primary)]">语速 ({config.speed?.toFixed(1)}x)</Label>
              <input
                type="range"
                min="0.5"
                max="2.0"
                step="0.1"
                value={config.speed || 1.0}
                onChange={(e) => onChange({ ...config, speed: parseFloat(e.target.value) })}
                className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-gray-700 mt-2 [data-skin='niho']:bg-[var(--niho-text-bg)] [data-skin='niho']:accent-[var(--color-accent)]"
              />
            </div>
            <div>
              <Label className="[data-skin='niho']:text-[var(--text-primary)]">音调 ({config.pitch?.toFixed(1)}x)</Label>
              <input
                type="range"
                min="0.5"
                max="2.0"
                step="0.1"
                value={config.pitch || 1.0}
                onChange={(e) => onChange({ ...config, pitch: parseFloat(e.target.value) })}
                className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-gray-700 mt-2 [data-skin='niho']:bg-[var(--niho-text-bg)] [data-skin='niho']:accent-[var(--color-accent)]"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// 自驱思考配置面板
// ============================================================================

interface ThinkingConfigPanelProps {
  config: AutonomousThinkingConfig;
  onChange: (config: AutonomousThinkingConfig) => void;
  /** 暂未接后端：仅展示说明，开关固定关闭且不可操作 */
  stub?: boolean;
}

const ThinkingConfigPanel: React.FC<ThinkingConfigPanelProps> = ({ config, onChange, stub }) => {
  const [newTopic, setNewTopic] = useState('');

  const addTopic = () => {
    if (!newTopic.trim()) return;
    if (config.topics.includes(newTopic.trim())) {
      toast({ title: '主题已存在', variant: 'destructive' });
      return;
    }
    onChange({
      ...config,
      topics: [...config.topics, newTopic.trim()],
    });
    setNewTopic('');
  };

  const removeTopic = (topic: string) => {
    onChange({
      ...config,
      topics: config.topics.filter(t => t !== topic),
    });
  };

  if (stub) {
    return (
      <div className="border border-[var(--color-border)] rounded-lg overflow-hidden opacity-90 [data-skin='niho']:border-[var(--niho-text-border)] [data-skin='niho']:bg-[var(--niho-pure-black-elevated)]">
        <div className="flex items-center justify-between px-3 py-2 bg-[var(--color-bg-secondary)] [data-skin='niho']:bg-[var(--niho-text-bg)] [data-skin='niho']:border-b [data-skin='niho']:border-[var(--niho-text-border)]">
          <div className="flex items-center gap-2">
            <Brain className="w-4 h-4 text-purple-500 [data-skin='niho']:text-[var(--color-secondary)]" />
            <span className="text-sm font-medium [data-skin='niho']:text-[var(--text-primary)]">自驱思考</span>
          </div>
          <Switch checked={false} disabled onCheckedChange={() => {}} />
        </div>
        <div className="p-3 text-xs text-[var(--color-text-tertiary)] space-y-1 [data-skin='niho']:bg-[#000000] [data-skin='niho']:text-[var(--niho-skyblue-gray)]">
          <p>暂未接入后端，当前不会生效。</p>
          <p>后续仅在 <span className="font-medium text-[var(--text-primary)]">Primag</span> 中配置自驱思考。</p>
        </div>
      </div>
    );
  }

  return (
    <div className="border border-[var(--color-border)] rounded-lg overflow-hidden [data-skin='niho']:border-[var(--niho-text-border)] [data-skin='niho']:bg-[var(--niho-pure-black-elevated)]">
      <div className="flex items-center justify-between px-3 py-2 bg-[var(--color-bg-secondary)] [data-skin='niho']:bg-[var(--niho-text-bg)] [data-skin='niho']:border-b [data-skin='niho']:border-[var(--niho-text-border)]">
        <div className="flex items-center gap-2">
          <Brain className="w-4 h-4 text-purple-500 [data-skin='niho']:text-[var(--color-secondary)]" />
          <span className="text-sm font-medium [data-skin='niho']:text-[var(--text-primary)]">自驱思考</span>
        </div>
        <Switch
          checked={config.enabled}
          onCheckedChange={(enabled) => onChange({ ...config, enabled })}
        />
      </div>
      {config.enabled && (
        <div className="space-y-4 p-3 [data-skin='niho']:bg-[#000000]">
          {/* 思考间隔 */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="flex items-center gap-1 [data-skin='niho']:text-[var(--text-primary)]">
                <Clock className="w-3 h-3 [data-skin='niho']:text-[var(--color-accent)]" />
                思考间隔
              </Label>
              <Select
                value={config.interval.toString()}
                onValueChange={(v) => onChange({ ...config, interval: parseInt(v) })}
              >
                <SelectTrigger className="[data-skin='niho']:bg-[var(--niho-pure-black-elevated)] [data-skin='niho']:border-[var(--niho-text-border)] [data-skin='niho']:text-[var(--text-primary)] [data-skin='niho']:focus:border-[var(--color-accent-bg)]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="[data-skin='niho']:bg-[#000000] [data-skin='niho']:border-[var(--niho-text-border)]">
                  {THINKING_INTERVALS.map(i => (
                    <SelectItem 
                      key={i.value} 
                      value={i.value.toString()}
                      className="[data-skin='niho']:text-[var(--text-primary)] [data-skin='niho']:hover:bg-[var(--color-accent-bg)] [data-skin='niho']:focus:bg-[var(--color-accent-bg)]"
                    >
                      {i.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end">
              <div className="flex items-center gap-2">
                <Switch
                  checked={config.memoryTriggered}
                  onCheckedChange={(memoryTriggered) => onChange({ ...config, memoryTriggered })}
                />
                <Label className="text-sm [data-skin='niho']:text-[var(--text-primary)]">记忆触发思考</Label>
              </div>
            </div>
          </div>

          {/* 思考主题 */}
          <div>
            <Label className="flex items-center gap-1 mb-2 [data-skin='niho']:text-[var(--text-primary)]">
              <Tag className="w-3 h-3 [data-skin='niho']:text-[var(--color-accent)]" />
              思考主题
            </Label>
            <div className="flex gap-2 mb-2">
              <Input
                placeholder="添加主题..."
                value={newTopic}
                onChange={(e) => setNewTopic(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addTopic()}
                className="flex-1 [data-skin='niho']:bg-[var(--niho-pure-black-elevated)] [data-skin='niho']:border-[var(--niho-text-border)] [data-skin='niho']:text-[var(--text-primary)] [data-skin='niho']:placeholder:text-[var(--niho-skyblue-gray)] [data-skin='niho']:focus:border-[var(--color-accent-bg)]"
              />
              <Button 
                variant="outline" 
                size="sm" 
                onClick={addTopic}
                className="[data-skin='niho']:border-[var(--niho-text-border)] [data-skin='niho']:bg-transparent [data-skin='niho']:text-[var(--text-primary)] [data-skin='niho']:hover:bg-[var(--color-accent-bg)] [data-skin='niho']:hover:border-[var(--color-accent-bg)] [data-skin='niho']:hover:text-[var(--color-accent)]"
              >
                <Plus className="w-4 h-4" />
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              {config.topics.map(topic => (
                <Badge 
                  key={topic} 
                  variant="info" 
                  className="flex items-center gap-1 [data-skin='niho']:bg-[var(--color-accent-bg)] [data-skin='niho']:text-[var(--color-accent)] [data-skin='niho']:border [data-skin='niho']:border-[var(--color-accent-bg)]"
                >
                  {topic}
                  <button 
                    onClick={() => removeTopic(topic)} 
                    className="hover:text-red-500 [data-skin='niho']:hover:text-[var(--color-secondary)]"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </Badge>
              ))}
              {config.topics.length === 0 && (
                <span className="text-xs text-[var(--color-text-tertiary)] [data-skin='niho']:text-[var(--niho-skyblue-gray)]">
                  添加 Agent 会自主思考的话题
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// 记忆触发配置面板
// ============================================================================

interface MemoryTriggerPanelProps {
  rules: MemoryTriggerRule[];
  onChange: (rules: MemoryTriggerRule[]) => void;
  /** 总开关：关闭时不展示规则列表与添加 */
  masterEnabled?: boolean;
  /** 总开关变更（由父组件传入时在 header 显示 Switch） */
  onMasterEnabledChange?: (enabled: boolean) => void;
}

const MemoryTriggerPanel: React.FC<MemoryTriggerPanelProps> = ({ rules, onChange, masterEnabled = true, onMasterEnabledChange }) => {
  const [showAddRule, setShowAddRule] = useState(false);
  const [newRule, setNewRule] = useState<Partial<MemoryTriggerRule>>({
    type: 'keyword',
    keywords: [],
    threshold: 0.8,
    withinHours: 1,
    action: 'notify',
    cooldown: 900000,
    enabled: true,
  });
  const [keywordInput, setKeywordInput] = useState('');

  const addRule = () => {
    if (!newRule.name?.trim()) {
      toast({ title: '请输入规则名称', variant: 'destructive' });
      return;
    }
    
    const rule: MemoryTriggerRule = {
      id: `rule_${Date.now()}`,
      name: newRule.name!,
      type: newRule.type || 'keyword',
      keywords: newRule.keywords,
      threshold: newRule.threshold,
      withinHours: newRule.withinHours,
      action: newRule.action || 'notify',
      cooldown: newRule.cooldown || 900000,
      enabled: true,
    };
    
    onChange([...rules, rule]);
    setShowAddRule(false);
    setNewRule({
      type: 'keyword',
      keywords: [],
      threshold: 0.8,
      withinHours: 1,
      action: 'notify',
      cooldown: 900000,
      enabled: true,
    });
  };

  const removeRule = (id: string) => {
    onChange(rules.filter(r => r.id !== id));
  };

  const toggleRule = (id: string) => {
    onChange(rules.map(r => r.id === id ? { ...r, enabled: !r.enabled } : r));
  };

  return (
    <div className="border border-[var(--color-border)] rounded-lg overflow-hidden [data-skin='niho']:border-[var(--niho-text-border)] [data-skin='niho']:bg-[var(--niho-pure-black-elevated)]">
      <div className="flex items-center justify-between px-3 py-2 bg-[var(--color-bg-secondary)] [data-skin='niho']:bg-[var(--niho-text-bg)] [data-skin='niho']:border-b [data-skin='niho']:border-[var(--niho-text-border)]">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-yellow-500 [data-skin='niho']:text-[var(--color-highlight)]" />
          <span className="text-sm font-medium [data-skin='niho']:text-[var(--text-primary)]">记忆锚点</span>
        </div>
        <div className="flex items-center gap-2">
          {onMasterEnabledChange != null && (
            <Switch
              checked={masterEnabled !== false}
              onCheckedChange={onMasterEnabledChange}
            />
          )}
          {masterEnabled !== false && (
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={() => setShowAddRule(true)}
              className="[data-skin='niho']:text-[var(--text-primary)] [data-skin='niho']:hover:bg-[var(--color-accent-bg)] [data-skin='niho']:hover:text-[var(--color-accent)]"
            >
              <Plus className="w-4 h-4 mr-1" />
              添加规则
            </Button>
          )}
        </div>
      </div>
      <div className="space-y-2 p-3 [data-skin='niho']:bg-[#000000]">
        {!masterEnabled ? (
          <div className="text-sm text-[var(--color-text-tertiary)] py-3 text-center [data-skin='niho']:text-[var(--niho-skyblue-gray)]">
            已关闭记忆锚点，开启后可添加规则
          </div>
        ) : rules.length === 0 ? (
          <div className="text-sm text-[var(--color-text-tertiary)] py-4 text-center [data-skin='niho']:text-[var(--niho-skyblue-gray)]">
            <AlertCircle className="w-5 h-5 mx-auto mb-2 opacity-50 [data-skin='niho']:text-[var(--niho-skyblue-gray)]" />
            暂无记忆锚点规则，添加规则让 Chaya 根据记忆自动执行动作
          </div>
        ) : (
          rules.map(rule => (
            <div 
              key={rule.id}
              className={`flex items-center justify-between p-2 rounded-lg border ${
                rule.enabled 
                  ? 'bg-[var(--color-bg-secondary)] border-[var(--color-border)] [data-skin="niho"]:bg-[var(--niho-text-bg)] [data-skin="niho"]:border-[var(--niho-text-border)]' 
                  : 'bg-gray-100 dark:bg-gray-800 border-gray-200 dark:border-gray-700 opacity-60 [data-skin="niho"]:bg-[var(--niho-text-bg)] [data-skin="niho"]:border-[var(--niho-text-border)] [data-skin="niho"]:opacity-40'
              }`}
            >
              <div className="flex items-center gap-2">
                <Switch
                  checked={rule.enabled}
                  onCheckedChange={() => toggleRule(rule.id)}
                />
                <div>
                  <div className="text-sm font-medium [data-skin='niho']:text-[var(--text-primary)]">{rule.name}</div>
                  <div className="text-xs text-[var(--color-text-tertiary)] [data-skin='niho']:text-[var(--niho-skyblue-gray)]">
                    {rule.type === 'keyword' && `关键词: ${rule.keywords?.join(', ')}`}
                    {rule.type === 'importance' && `重要度 ≥ ${rule.threshold}`}
                    {rule.type === 'recent' && `${rule.withinHours}小时内`}
                  </div>
                </div>
              </div>
              <Button 
                variant="ghost" 
                size="icon" 
                onClick={() => removeRule(rule.id)}
                className="[data-skin='niho']:text-[var(--color-secondary)] [data-skin='niho']:hover:bg-[var(--color-secondary-bg)] [data-skin='niho']:hover:text-[var(--color-secondary-hover)]"
              >
                <Trash2 className="w-4 h-4 text-red-500 [data-skin='niho']:text-[var(--color-secondary)]" />
              </Button>
            </div>
          ))
        )}

        {/* 添加规则表单 */}
        {showAddRule && (
          <div className="p-3 border border-dashed border-[var(--color-border)] rounded-lg space-y-3 [data-skin='niho']:border-[var(--niho-text-border)] [data-skin='niho']:bg-[var(--niho-pure-black-elevated)]">
            <div>
              <Label className="[data-skin='niho']:text-[var(--text-primary)]">规则名称</Label>
              <Input
                placeholder="如：重要消息提醒"
                value={newRule.name || ''}
                onChange={(e) => setNewRule({ ...newRule, name: e.target.value })}
                className="[data-skin='niho']:bg-[#000000] [data-skin='niho']:border-[var(--niho-text-border)] [data-skin='niho']:text-[var(--text-primary)] [data-skin='niho']:placeholder:text-[var(--niho-skyblue-gray)] [data-skin='niho']:focus:border-[var(--color-accent-bg)]"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="[data-skin='niho']:text-[var(--text-primary)]">触发类型</Label>
                <Select
                  value={newRule.type}
                  onValueChange={(type: any) => setNewRule({ ...newRule, type })}
                >
                  <SelectTrigger className="[data-skin='niho']:bg-[#000000] [data-skin='niho']:border-[var(--niho-text-border)] [data-skin='niho']:text-[var(--text-primary)] [data-skin='niho']:focus:border-[var(--color-accent-bg)]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="[data-skin='niho']:bg-[#000000] [data-skin='niho']:border-[var(--niho-text-border)]">
                    <SelectItem 
                      value="keyword"
                      className="[data-skin='niho']:text-[var(--text-primary)] [data-skin='niho']:hover:bg-[var(--color-accent-bg)]"
                    >
                      关键词匹配
                    </SelectItem>
                    <SelectItem 
                      value="importance"
                      className="[data-skin='niho']:text-[var(--text-primary)] [data-skin='niho']:hover:bg-[var(--color-accent-bg)]"
                    >
                      重要度阈值
                    </SelectItem>
                    <SelectItem 
                      value="recent"
                      className="[data-skin='niho']:text-[var(--text-primary)] [data-skin='niho']:hover:bg-[var(--color-accent-bg)]"
                    >
                      近期记忆
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="[data-skin='niho']:text-[var(--text-primary)]">冷却时间</Label>
                <Select
                  value={newRule.cooldown?.toString()}
                  onValueChange={(v) => setNewRule({ ...newRule, cooldown: parseInt(v) })}
                >
                  <SelectTrigger className="[data-skin='niho']:bg-[#000000] [data-skin='niho']:border-[var(--niho-text-border)] [data-skin='niho']:text-[var(--text-primary)] [data-skin='niho']:focus:border-[var(--color-accent-bg)]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="[data-skin='niho']:bg-[#000000] [data-skin='niho']:border-[var(--niho-text-border)]">
                    {TRIGGER_COOLDOWNS.map(c => (
                      <SelectItem 
                        key={c.value} 
                        value={c.value.toString()}
                        className="[data-skin='niho']:text-[var(--text-primary)] [data-skin='niho']:hover:bg-[var(--color-accent-bg)] [data-skin='niho']:focus:bg-[var(--color-accent-bg)]"
                      >
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            
            {/* 类型特定配置 */}
            {newRule.type === 'keyword' && (
              <div>
                <Label className="[data-skin='niho']:text-[var(--text-primary)]">关键词（逗号分隔）</Label>
                <Input
                  placeholder="重要, 紧急, 提醒"
                  value={keywordInput}
                  onChange={(e) => {
                    setKeywordInput(e.target.value);
                    setNewRule({
                      ...newRule,
                      keywords: e.target.value.split(',').map(k => k.trim()).filter(Boolean),
                    });
                  }}
                  className="[data-skin='niho']:bg-[#000000] [data-skin='niho']:border-[var(--niho-text-border)] [data-skin='niho']:text-[var(--text-primary)] [data-skin='niho']:placeholder:text-[var(--niho-skyblue-gray)] [data-skin='niho']:focus:border-[var(--color-accent-bg)]"
                />
              </div>
            )}
            {newRule.type === 'importance' && (
              <div>
                <Label className="[data-skin='niho']:text-[var(--text-primary)]">重要度阈值 ({newRule.threshold})</Label>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.1"
                  value={newRule.threshold}
                  onChange={(e) => setNewRule({ ...newRule, threshold: parseFloat(e.target.value) })}
                  className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-gray-700 [data-skin='niho']:bg-[var(--niho-text-bg)] [data-skin='niho']:accent-[var(--color-accent)]"
                />
              </div>
            )}
            {newRule.type === 'recent' && (
              <div>
                <Label className="[data-skin='niho']:text-[var(--text-primary)]">时间范围（小时）</Label>
                <Input
                  type="number"
                  min="1"
                  max="24"
                  value={newRule.withinHours}
                  onChange={(e) => setNewRule({ ...newRule, withinHours: parseInt(e.target.value) })}
                  className="[data-skin='niho']:bg-[#000000] [data-skin='niho']:border-[var(--niho-text-border)] [data-skin='niho']:text-[var(--text-primary)] [data-skin='niho']:placeholder:text-[var(--niho-skyblue-gray)] [data-skin='niho']:focus:border-[var(--color-accent-bg)]"
                />
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button 
                variant="secondary" 
                size="sm" 
                onClick={() => setShowAddRule(false)}
                className="[data-skin='niho']:border-[var(--niho-text-border)] [data-skin='niho']:bg-transparent [data-skin='niho']:text-[var(--text-primary)] [data-skin='niho']:hover:bg-[var(--niho-text-bg)]"
              >
                取消
              </Button>
              <Button 
                variant="primary" 
                size="sm" 
                onClick={addRule}
                className="[data-skin='niho']:bg-[var(--color-accent)] [data-skin='niho']:text-[#000000] [data-skin='niho']:hover:bg-[var(--color-accent-hover)] [data-skin='niho']:shadow-[0_0_12px_rgba(0,255,136,0.3)]"
              >
                添加
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const AgentPersonaConfig: React.FC<AgentPersonaConfigProps> = ({
  config,
  onChange,
  compact = false,
  voiceOnly = false,
  chayaOnly = false,
  intelOnly = false,
  topologyAgentId,
}) => {
  if (voiceOnly) {
    return (
      <div className={`space-y-4 ${compact ? '' : 'p-4'}`}>
        <div className="text-xs text-gray-500 mb-2 [data-skin='niho']:text-[var(--niho-skyblue-gray)]">
          开启后可选择 TTS 提供方与角色
        </div>
        <VoiceConfigPanel
          config={config.voice}
          onChange={(voice) => onChange({ ...config, voice })}
        />
      </div>
    );
  }
  if (intelOnly) {
    return (
      <div className={`space-y-4 ${compact ? '' : 'p-4'}`}>
        <ThinkingConfigPanel
          config={config.thinking}
          onChange={(thinking) => onChange({ ...config, thinking })}
          stub
        />
        <div className="overflow-hidden rounded-lg border border-[var(--color-border)] [data-skin='niho']:border-[var(--niho-text-border)] [data-skin='niho']:bg-[var(--niho-pure-black-elevated)]">
          <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-3 py-2 [data-skin='niho']:border-[var(--niho-text-border)] [data-skin='niho']:bg-[var(--niho-text-bg)]">
            <div className="min-w-0">
              <div className="text-sm font-medium [data-skin='niho']:text-[var(--text-primary)]">行为拓扑增强</div>
              <div className="mt-0.5 text-[11px] leading-relaxed text-[var(--color-text-tertiary)] [data-skin='niho']:text-[var(--niho-skyblue-gray)]">
                总开关：开启后构建/使用知识行为拓扑（知识图谱），Orchestrator 命中路径时注入步骤与技能 SOP。
                <span className="text-[var(--text-primary)]/90 [data-skin='niho']:text-[var(--text-primary)]">
                  {' '}
                  记忆锚点命中能力仅在此开启后生效
                </span>
                。
              </div>
            </div>
            <Switch
              checked={config.topologyEnabled ?? false}
              onCheckedChange={(v) => onChange({ ...config, topologyEnabled: v })}
            />
          </div>
        </div>
        {topologyAgentId ? (
          <TopologyReadonlyPanel agentId={topologyAgentId} topologyEnabled={config.topologyEnabled ?? false} />
        ) : null}
      </div>
    );
  }
  if (chayaOnly) {
    return (
      <div className={`space-y-4 ${compact ? '' : 'p-4'}`}>
        <div className="text-xs text-gray-500 mb-2 [data-skin='niho']:text-[var(--niho-skyblue-gray)]">
          Intelligence（智能层；技能属 Hardness，不在此配置）
        </div>
        <ThinkingConfigPanel
          config={config.thinking}
          onChange={(thinking) => onChange({ ...config, thinking })}
          stub
        />
        {topologyAgentId ? (
          <TopologyReadonlyPanel agentId={topologyAgentId} topologyEnabled={config.topologyEnabled ?? false} />
        ) : null}
      </div>
    );
  }
  return (
    <div className={`space-y-4 ${compact ? '' : 'p-4'}`}>
      <VoiceConfigPanel
        config={config.voice}
        onChange={(voice) => onChange({ ...config, voice })}
      />
      <ThinkingConfigPanel
        config={config.thinking}
        onChange={(thinking) => onChange({ ...config, thinking })}
      />
      <MemoryTriggerPanel
        rules={config.memoryTriggers}
        onChange={(memoryTriggers) => onChange({ ...config, memoryTriggers })}
      />
    </div>
  );
};

export default AgentPersonaConfig;
