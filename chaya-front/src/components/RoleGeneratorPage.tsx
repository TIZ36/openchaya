import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles, Wand2, Settings, Image as ImageIcon, Check, Loader, RefreshCw, Save, Bot } from 'lucide-react';
import { 
  generateRole, 
  refineRoleProperty, 
  generateRoleAvatar, 
  type RoleGenerationResult,
  type RolePropertyType
} from '../services/roleGeneratorApi';
import { 
  getLLMConfigs, 
  type LLMConfigFromDB 
} from '../services/llmApi';
import { 
  createSession, 
  updateSessionAvatar,
  updateSessionName,
  updateSessionSystemPrompt,
  updateSessionLLMConfig
} from '../services/chat';
import { emitSessionsChanged } from '../utils/sessionEvents';
import { Button } from './ui/Button';
import { InputField, TextareaField } from './ui/FormField';
import { Card } from './ui/PageLayout';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/Select';
import { toast } from './ui/use-toast';
import { cn } from '../utils/cn';

interface RoleGeneratorPageProps {
  /** 是否嵌入到 Dialog 中，影响高度计算和标题显示 */
  isEmbedded?: boolean;
  /** 保存成功后的回调 */
  onSaved?: () => void;
}

type Mode = 'random' | 'manual';

const RoleGeneratorPage: React.FC<RoleGeneratorPageProps> = ({ isEmbedded = false, onSaved }) => {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>('random');
  const [prompt, setPrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isRefining, setIsRefining] = useState<RolePropertyType | null>(null);
  const [result, setResult] = useState<RoleGenerationResult | null>(null);
  const [llmConfigs, setLlmConfigs] = useState<LLMConfigFromDB[]>([]);
  const [selectedConfigId, setSelectedSessionConfigId] = useState<string>('');
  const [isAvatarGenerating, setIsAvatarGenerating] = useState(false);
  const [isSaving, setIsAvatarSaving] = useState(false);
  const isSavingRef = useRef(false);
  
  // 基础表单状态（用于手动模式或生成后的微调）
  const [name, setName] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [avatar, setAvatar] = useState<string | null>(null);
  
  // 结果滚动引用
  const resultRef = useRef<HTMLDivElement>(null);

  // 加载模型配置
  useEffect(() => {
    const loadConfigs = async () => {
      try {
        const configs = await getLLMConfigs();
        setLlmConfigs(configs);
        if (configs.length > 0) {
          // 优先选一个默认或者第一个
          const default_ = configs.find(c => c.is_default) || configs[0];
          setSelectedSessionConfigId(default_.config_id);
        }
      } catch (error) {
        console.error('[RoleGenerator] Failed to load configs:', error);
      }
    };
    loadConfigs();
  }, []);

  // 当生成结果变化时，同步到表单
  useEffect(() => {
    if (result) {
      setName(result.name);
      setSystemPrompt(result.system_prompt);
      setAvatar(result.avatar || null);
      
      // 自动滚动到结果区域
      requestAnimationFrame(() => {
        resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }, [result, isEmbedded]);

  const handleGenerate = async () => {
    if (mode === 'random' && !prompt.trim()) {
      toast({ title: '请输入描述', description: '请简单描述一下你想要的角色类型', variant: 'destructive' });
        return;
    }

    setIsGenerating(true);
    try {
      const data = await generateRole(prompt);
      setResult(data);
      toast({ title: '角色生成成功', variant: 'success' });
    } catch (error: any) {
      toast({
        title: '生成失败',
        description: error.message || '模型生成角色时出现错误', 
        variant: 'destructive' 
      });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleRefine = async (type: RolePropertyType) => {
    if (!result) return;

    setIsRefining(type);
    try {
      const newValue = await refineRoleProperty(result, type);
      const updatedResult = { ...result, [type]: newValue };
      setResult(updatedResult);
      
      // 同步到表单
      if (type === 'name') setName(newValue);
      if (type === 'system_prompt') setSystemPrompt(newValue);
      
      toast({ title: '已重新生成', variant: 'success' });
    } catch (error: any) {
      toast({ title: '重试失败', description: error.message, variant: 'destructive' });
    } finally {
      setIsRefining(null);
    }
  };

  const handleGenerateAvatar = async () => {
    if (!result) return;
    
    setIsAvatarGenerating(true);
    try {
      const avatarUrl = await generateRoleAvatar(result);
      setResult({ ...result, avatar: avatarUrl });
      setAvatar(avatarUrl);
      toast({ title: '头像已更新', variant: 'success' });
    } catch (error: any) {
      toast({ title: '头像生成失败', description: error.message, variant: 'destructive' });
    } finally {
      setIsAvatarGenerating(false);
    }
  };

  const handleSave = async () => {
    if (isSavingRef.current) return;

    const finalName = name || result?.name;
    const finalPrompt = systemPrompt || result?.system_prompt;

    if (!finalName) {
      toast({ title: '请输入名称', variant: 'destructive' });
      return;
    }

    if (!selectedConfigId) {
      toast({ title: '请选择模型配置', description: '请先选择一个默认模型配置', variant: 'destructive' });
      return;
    }

    isSavingRef.current = true;
    setIsAvatarSaving(true);
    try {
      // 1. 创建会话
      const session = await createSession(selectedConfigId, finalName, 'agent');
      
      // 2. 更新配置
      await Promise.all([
        updateSessionSystemPrompt(session.session_id, finalPrompt || ''),
        updateSessionLLMConfig(session.session_id, selectedConfigId),
        avatar ? updateSessionAvatar(session.session_id, avatar) : Promise.resolve(),
        updateSessionName(session.session_id, finalName)
      ]);

      toast({ title: '智能体已保存', description: `角色 "${finalName}" 已添加到智能体列表`, variant: 'success' });
      
      // 如果不是嵌入模式，跳转到聊天或列表
      if (!isEmbedded) {
        navigate(`/?session=${session.session_id}`);
      }
      
      emitSessionsChanged();
      if (onSaved) {
        onSaved();
      }
    } catch (error: any) {
      toast({ title: '保存失败', description: error.message, variant: 'destructive' });
    } finally {
      setIsAvatarSaving(false);
      isSavingRef.current = false;
    }
  };

  const renderConfigSelector = () => (
    <div className="space-y-2">
      <Label className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-[#858585]">
        默认模型配置
      </Label>
      <Select value={selectedConfigId} onValueChange={setSelectedSessionConfigId}>
        <SelectTrigger className="w-full bg-white dark:bg-[#2d2d2d] border-gray-200 dark:border-[#404040]">
          <SelectValue placeholder="选择模型配置" />
        </SelectTrigger>
        <SelectContent>
          {llmConfigs.map(config => (
            <SelectItem key={config.config_id} value={config.config_id}>
              <div className="flex items-center gap-2">
                <span className="font-medium">{config.name}</span>
                <span className="text-[10px] opacity-50 px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 rounded">
                  {config.provider}
                </span>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <div className={cn(
      "flex flex-col bg-gray-50 dark:bg-[#1a1a1a]",
      isEmbedded ? "h-full" : "min-h-screen"
    )}>
      {/* 顶部标题栏 - 仅在非嵌入模式显示 */}
      {!isEmbedded && (
        <div className="flex-shrink-0 px-8 py-6 bg-white dark:bg-[#2d2d2d] border-b border-gray-200 dark:border-[#404040]">
          <div className="max-w-5xl mx-auto flex items-center justify-between">
            <div>
            <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center">
                  <Sparkles className="w-6 h-6 text-purple-600 dark:text-purple-400" />
              </div>
              <div>
                  <h1 className="text-2xl font-bold text-gray-900 dark:text-white">角色生成器</h1>
                  <p className="text-sm text-gray-500 dark:text-[#858585] mt-1">
                    利用 AI 灵感，快速打造独特的人设与智能体
                  </p>
              </div>
            </div>
            </div>
          </div>
        </div>
      )}

      {/* 主内容区 */}
      <div className="flex-1 overflow-y-auto">
        <div className={cn(
          "mx-auto space-y-6 pb-12",
          isEmbedded ? "p-6" : "max-w-5xl p-8"
        )}>
          
          {/* 输入卡片 */}
          <Card className="p-0 overflow-hidden border-none shadow-sm gnome-card">
            <div className="flex border-b border-gray-100 dark:border-[#404040]">
              <button
                onClick={() => setMode('random')}
                className={cn(
                  "flex-1 px-6 py-4 text-sm font-medium transition-colors border-b-2 flex items-center justify-center gap-2",
                  mode === 'random'
                    ? "border-primary-500 text-primary-600 bg-primary-50/30 dark:bg-primary-900/10" 
                    : "border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                )}
              >
                <Wand2 className="w-4 h-4" />
                灵感生成 (AI)
              </button>
              <button
                onClick={() => {
                  setMode('manual');
                  if (!result) {
                    setResult({ name: '', system_prompt: '', description: '', tags: [] });
                  }
                }}
                className={cn(
                  "flex-1 px-6 py-4 text-sm font-medium transition-colors border-b-2 flex items-center justify-center gap-2",
                  mode === 'manual'
                    ? "border-primary-500 text-primary-600 bg-primary-50/30 dark:bg-primary-900/10" 
                    : "border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                )}
              >
                <Settings className="w-4 h-4" />
                手动创建
              </button>
          </div>

            <div className="p-6">
              {mode === 'random' ? (
              <div className="space-y-4">
                  <div className="space-y-2">
                    <Label className="text-sm font-medium text-gray-700 dark:text-gray-200">
                      我想要一个什么样的角色...
                  </Label>
                  <Textarea
                      placeholder="例如：一个毒舌但心软的编程导师、一个来自 2077 年的赛博侦探、或者一个精通大数据的商业分析师..."
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      className="min-h-[120px] resize-none text-base bg-gray-50/50 dark:bg-gray-800/30 border-gray-200 dark:border-[#404040] focus:ring-primary-500"
                  />
                </div>
                
                  <div className="flex items-center justify-between gap-4 pt-2">
                    <div className="flex-1 max-w-xs">
                      {renderConfigSelector()}
                  </div>
                <Button
                  variant="primary"
                      size="lg"
                      onClick={handleGenerate}
                      disabled={isGenerating || !prompt.trim()}
                      className="h-12 px-8 shadow-md"
                >
                      {isGenerating ? (
                    <>
                          <Loader className="w-5 h-5 mr-2 animate-spin" />
                          正在构思中...
                    </>
                  ) : (
                    <>
                          <Sparkles className="w-5 h-5 mr-2" />
                          生成角色灵感
                    </>
                  )}
                </Button>
              </div>
              </div>
              ) : (
                <div className="space-y-6">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-4">
                      <InputField
                        label="角色名称"
                        inputProps={{
                          placeholder: "给你的 AI 起个名字",
                          value: name,
                          onChange: (e) => setName(e.target.value),
                        }}
                      />
                      {renderConfigSelector()}
                    </div>
                  <TextareaField
                    label="人设指令 (System Prompt)"
                    textareaProps={{
                      placeholder: "定义角色的性格、说话方式、知识背景等...",
                      className: "min-h-[140px] resize-none",
                      value: systemPrompt,
                      onChange: (e) => setSystemPrompt(e.target.value),
                    }}
                  />
                  </div>

                  <div className="flex justify-end pt-4 border-t border-gray-100 dark:border-[#404040]">
                    <Button
                      variant="primary" 
                      onClick={handleSave}
                      disabled={isSaving || !name.trim()}
                      className="h-11 px-10"
                    >
                      {isSaving ? <Loader className="animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                      直接保存智能体
                    </Button>
                        </div>
                      </div>
                    )}
                  </div>
          </Card>

          {/* 生成结果展示区 */}
          {result && mode === 'random' && (
            <div ref={resultRef} className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
              <div className="flex items-center gap-2 px-1">
                <div className="h-px flex-1 bg-gray-200 dark:bg-[#404040]" />
                <span className="text-xs font-bold text-gray-400 dark:text-[#666666] uppercase tracking-widest">
                  生成结果
                </span>
                <div className="h-px flex-1 bg-gray-200 dark:bg-[#404040]" />
                  </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* 左侧：头像与核心信息 */}
                <Card className="lg:col-span-1 p-6 flex flex-col items-center text-center space-y-6 border-none shadow-sm gnome-card">
                  <div className="relative group">
                    <div className="w-32 h-32 rounded-3xl overflow-hidden bg-gray-100 dark:bg-gray-800 border-4 border-white dark:border-[#2d2d2d] shadow-xl transition-transform group-hover:scale-[1.02]">
                      {avatar ? (
                        <img src={avatar} alt="Avatar" className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <Bot className="w-12 h-12 text-gray-300 dark:text-gray-600" />
                      </div>
                    )}
                      
                      {isAvatarGenerating && (
                        <div className="absolute inset-0 bg-black/40 backdrop-blur-sm flex flex-col items-center justify-center text-white">
                          <Loader className="w-6 h-6 animate-spin mb-2" />
                          <span className="text-[10px] font-medium">生成中...</span>
                          </div>
                        )}
                      </div>

                          <button
                      onClick={handleGenerateAvatar}
                      disabled={isAvatarGenerating}
                      className="absolute -bottom-2 -right-2 w-10 h-10 rounded-full bg-primary-500 text-white shadow-lg flex items-center justify-center hover:bg-primary-600 transition-colors disabled:opacity-50"
                      title="重新生成头像"
                          >
                      <RefreshCw className={cn("w-5 h-5", isAvatarGenerating && "animate-spin")} />
                          </button>
                      </div>

                  <div className="space-y-2 w-full">
                    <div className="flex items-center justify-center gap-2 group/title">
                      <h2 className="text-xl font-bold text-gray-900 dark:text-white">
                        {name || result.name}
                      </h2>
                          <button
                        onClick={() => handleRefine('name')}
                        className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 opacity-0 group-hover/title:opacity-100 transition-opacity"
                        title="换个名字"
                          >
                        <RefreshCw className={cn("w-3 h-3 text-gray-400", isRefining === 'name' && "animate-spin")} />
                          </button>
                        </div>
                    
                    <div className="flex flex-wrap justify-center gap-1.5">
                      {result.tags.map((tag: string, i: number) => (
                        <span key={i} className="px-2.5 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-[11px] font-medium text-gray-600 dark:text-[#a0a0a0] border border-gray-200/50 dark:border-[#404040]/50">
                          {tag}
                        </span>
                            ))}
                  </div>
                </div>

                  <div className="w-full pt-4 border-t border-gray-100 dark:border-[#404040]">
                  <Button
                    variant="primary"
                      className="w-full h-11 shadow-md"
                      onClick={handleSave}
                      disabled={isSaving}
                  >
                      {isSaving ? (
                        <Loader className="animate-spin mr-2" />
                    ) : (
                        <Check className="w-4 h-4 mr-2" />
                    )}
                      满意并保存
                  </Button>
                    <p className="text-[10px] text-gray-400 dark:text-[#666666] mt-3">
                      点击保存将此角色正式添加到您的智能体列表中
                    </p>
                </div>
                </Card>
                
                {/* 右侧：详细人设描述 */}
                <Card className="lg:col-span-2 p-0 flex flex-col border-none shadow-sm gnome-card overflow-hidden">
                  <div className="px-6 py-4 border-b border-gray-100 dark:border-[#404040] flex items-center justify-between bg-gray-50/50 dark:bg-gray-800/20">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-green-500" />
                      <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                        核心人设指令 (System Prompt)
                      </span>
                  </div>
                      <Button
                        variant="ghost"
                        size="sm"
                      className="h-8 text-xs text-primary-600 dark:text-primary-400"
                      onClick={() => handleRefine('system_prompt')}
                      disabled={isRefining === 'system_prompt'}
                      >
                      <RefreshCw className={cn("w-3 h-3 mr-1.5", isRefining === 'system_prompt' && "animate-spin")} />
                      优化指令
                      </Button>
                  </div>
                  
                  <div className="flex-1 p-6">
                    <div className="relative group">
                  <Textarea
                        value={systemPrompt || result.system_prompt}
                        onChange={(e) => setSystemPrompt(e.target.value)}
                        className="min-h-[280px] w-full p-4 bg-transparent border-none focus:ring-0 resize-none font-mono text-sm leading-relaxed text-gray-700 dark:text-gray-300"
                      />
                      <div className="absolute top-0 left-0 w-1 h-full bg-gray-100 dark:bg-[#404040] rounded-full" />
                </div>
                </div>

                  <div className="px-6 py-4 bg-gray-50/50 dark:bg-gray-800/20 border-t border-gray-100 dark:border-[#404040]">
                    <div className="flex items-start gap-3">
                      <div className="p-2 rounded-lg bg-amber-50 dark:bg-amber-900/20">
                        <Sparkles className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                      </div>
                      <div className="space-y-1">
                        <span className="text-xs font-semibold text-gray-600 dark:text-gray-400 block">
                          AI 角色定位
                      </span>
                        <p className="text-xs text-gray-500 dark:text-[#858585] leading-relaxed">
                          {result.description}
                        </p>
                    </div>
                    </div>
                </div>
                </Card>
                </div>
              </div>
            )}
          </div>
        </div>
    </div>
  );
};

export default RoleGeneratorPage;
