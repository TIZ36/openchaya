/**
 * 音色 TTS 预设添加/编辑弹窗（昵称 + 提供方/角色，持久化到 ext.voicePresets）
 */

import React, { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from './ui/Dialog';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Label } from './ui/Label';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from './ui/Select';
import type { VoicePreset } from '../services/roleApi';
import { Volume2 } from 'lucide-react';

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
];

export interface VoicePresetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'add' | 'edit';
  initial?: VoicePreset | null;
  onSave: (preset: VoicePreset) => void;
  saving?: boolean;
}

export const VoicePresetDialog: React.FC<VoicePresetDialogProps> = ({
  open,
  onOpenChange,
  mode,
  initial,
  onSave,
  saving = false,
}) => {
  const [nickname, setNickname] = useState('');
  const [provider, setProvider] = useState<string>('openai');
  const [voiceId, setVoiceId] = useState('');
  const [voiceName, setVoiceName] = useState('');
  const [language, setLanguage] = useState('zh-CN');

  const currentProvider = VOICE_PROVIDERS.find(p => p.value === provider);
  const voices = currentProvider?.voices || [];

  useEffect(() => {
    if (open) {
      if (mode === 'edit' && initial) {
        setNickname(initial.nickname || '');
        setProvider(initial.provider || 'openai');
        setVoiceId(initial.voiceId || '');
        setVoiceName(initial.voiceName || '');
        setLanguage(initial.language || 'zh-CN');
      } else {
        const def = VOICE_PROVIDERS[0];
        const firstVoice = def?.voices[0];
        setNickname('');
        setProvider(def?.value || 'openai');
        setVoiceId(firstVoice?.id || '');
        setVoiceName(firstVoice?.name || '');
        setLanguage('zh-CN');
      }
    }
  }, [open, mode, initial]);

  useEffect(() => {
    if (provider && voices.length && !voiceId) {
      const first = voices[0];
      setVoiceId(first.id);
      setVoiceName(first.name || first.id);
    }
  }, [provider, voices, voiceId]);

  const handleProviderChange = (v: string) => {
    setProvider(v);
    const p = VOICE_PROVIDERS.find(x => x.value === v);
    const first = p?.voices[0];
    setVoiceId(first?.id || '');
    setVoiceName(first?.name || first?.id || '');
  };

  const handleVoiceChange = (id: string) => {
    const voice = voices.find(x => x.id === id);
    setVoiceId(id);
    setVoiceName(voice?.name || id);
  };

  const handleSave = () => {
    const trimmed = nickname.trim();
    if (!trimmed) return;
    onSave({
      id: mode === 'edit' && initial ? initial.id : `voice_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      nickname: trimmed,
      provider,
      voiceId,
      voiceName: voiceName || voiceId,
      language,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 [data-skin='niho']:text-[var(--text-primary)]">
            <Volume2 className="w-4 h-4 [data-skin='niho']:text-[var(--color-info)]" />
            {mode === 'add' ? '添加音色' : '编辑音色'}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 overflow-auto no-scrollbar flex-1 min-h-0">
          <div>
            <Label className="[data-skin='niho']:text-[var(--text-primary)]">昵称</Label>
            <Input
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="如：温柔女声、新闻男声"
              className="mt-1 [data-skin='niho']:bg-[var(--niho-pure-black-elevated)] [data-skin='niho']:border-[var(--niho-text-border)] [data-skin='niho']:text-[var(--text-primary)]"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="[data-skin='niho']:text-[var(--text-primary)]">TTS 提供者</Label>
              <Select value={provider} onValueChange={handleProviderChange}>
                <SelectTrigger className="mt-1 [data-skin='niho']:bg-[var(--niho-pure-black-elevated)] [data-skin='niho']:border-[var(--niho-text-border)] [data-skin='niho']:text-[var(--text-primary)]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="[data-skin='niho']:bg-[#000000] [data-skin='niho']:border-[var(--niho-text-border)]">
                  {VOICE_PROVIDERS.map(p => (
                    <SelectItem key={p.value} value={p.value} className="[data-skin='niho']:text-[var(--text-primary)] [data-skin='niho']:hover:bg-[var(--color-accent-bg)]">
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="[data-skin='niho']:text-[var(--text-primary)]">语音角色</Label>
              <Select value={voiceId} onValueChange={handleVoiceChange}>
                <SelectTrigger className="mt-1 [data-skin='niho']:bg-[var(--niho-pure-black-elevated)] [data-skin='niho']:border-[var(--niho-text-border)] [data-skin='niho']:text-[var(--text-primary)]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="[data-skin='niho']:bg-[#000000] [data-skin='niho']:border-[var(--niho-text-border)]">
                  {voices.map(v => (
                    <SelectItem key={v.id} value={v.id} className="[data-skin='niho']:text-[var(--text-primary)] [data-skin='niho']:hover:bg-[var(--color-accent-bg)]">
                      {v.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label className="[data-skin='niho']:text-[var(--text-primary)]">语言</Label>
            <Select value={language} onValueChange={setLanguage}>
              <SelectTrigger className="mt-1 [data-skin='niho']:bg-[var(--niho-pure-black-elevated)] [data-skin='niho']:border-[var(--niho-text-border)] [data-skin='niho']:text-[var(--text-primary)]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="[data-skin='niho']:bg-[#000000] [data-skin='niho']:border-[var(--niho-text-border)]">
                {LANGUAGES.map(l => (
                  <SelectItem key={l.value} value={l.value} className="[data-skin='niho']:text-[var(--text-primary)] [data-skin='niho']:hover:bg-[var(--color-accent-bg)]">
                    {l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter className="flex-shrink-0 pt-3 border-t border-gray-200 dark:border-[#404040] [data-skin='niho']:border-[var(--niho-text-border)]">
          <Button variant="secondary" onClick={() => onOpenChange(false)} className="niho-close-pink">
            取消
          </Button>
          <Button variant="primary" onClick={handleSave} disabled={saving || !nickname.trim()}>
            {saving ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default VoicePresetDialog;
