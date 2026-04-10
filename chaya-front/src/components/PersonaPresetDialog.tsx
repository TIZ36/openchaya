/**
 * 人设预设添加/编辑弹窗（昵称 + 系统提示词，持久化到 ext.personaPresets）
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
import { Textarea } from './ui/Textarea';
import type { PersonaPreset } from '../services/roleApi';

export interface PersonaPresetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'add' | 'edit';
  initial?: PersonaPreset | null;
  onSave: (preset: PersonaPreset) => void;
  saving?: boolean;
}

export const PersonaPresetDialog: React.FC<PersonaPresetDialogProps> = ({
  open,
  onOpenChange,
  mode,
  initial,
  onSave,
  saving = false,
}) => {
  const [nickname, setNickname] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');

  useEffect(() => {
    if (open) {
      if (mode === 'edit' && initial) {
        setNickname(initial.nickname || '');
        setSystemPrompt(initial.system_prompt || '');
      } else {
        setNickname('');
        setSystemPrompt('');
      }
    }
  }, [open, mode, initial]);

  const handleSave = () => {
    const trimmed = nickname.trim();
    if (!trimmed) return;
    onSave({
      id: mode === 'edit' && initial ? initial.id : `persona_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      nickname: trimmed,
      system_prompt: systemPrompt.trim(),
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="[data-skin='niho']:text-[var(--text-primary)]">
            {mode === 'add' ? '添加人设' : '编辑人设'}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 overflow-auto no-scrollbar flex-1 min-h-0">
          <div>
            <Label htmlFor="persona-nickname" className="[data-skin='niho']:text-[var(--text-primary)]">昵称</Label>
            <Input
              id="persona-nickname"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="方便记忆的名称，如：客服小美、技术顾问"
              className="mt-1 [data-skin='niho']:bg-[var(--niho-pure-black-elevated)] [data-skin='niho']:border-[var(--niho-text-border)] [data-skin='niho']:text-[var(--text-primary)]"
            />
          </div>
          <div>
            <Label htmlFor="persona-prompt" className="[data-skin='niho']:text-[var(--text-primary)]">人设 / 系统提示词</Label>
            <Textarea
              id="persona-prompt"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="定义角色、能力和行为..."
              className="mt-1 min-h-[160px] [data-skin='niho']:bg-[var(--niho-pure-black-elevated)] [data-skin='niho']:border-[var(--niho-text-border)] [data-skin='niho']:text-[var(--text-primary)]"
            />
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

export default PersonaPresetDialog;
