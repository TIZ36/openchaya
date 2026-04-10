/**
 * 人设切换弹框 - 点击输入框上的「人设」后弹出，在弹框内切换人设预设、预览内容，并在详情页支持编辑并保存
 */

import React, { useState, useEffect } from 'react';
import { MessageSquare, ArrowLeft, Check, ChevronRight, Pencil } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { Label } from '../../ui/Label';
import { Textarea } from '../../ui/Textarea';
import { ScrollArea } from '../../ui/ScrollArea';
import type { PersonaPreset } from '../../../services/roleApi';

/** preset_list：先展示全局预设列表再进详情；current_agent_only：仅当前 Agent 生效人设（不展示预设列表） */
export type PersonaSwitchDialogVariant = 'preset_list' | 'current_agent_only';

export interface PersonaSwitchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  personaPresets: PersonaPreset[];
  currentPersonaId?: string;
  /** 无预设列表时用于展示当前 Agent 的系统提示词（会话列表不含 ext 时常为空，靠此项兜底） */
  fallbackSystemPrompt?: string;
  /** 输入栏「人设」等入口用 current_agent_only */
  variant?: PersonaSwitchDialogVariant;
  onSwitchPersona: (presetId: string) => Promise<void>;
  /** 在详情页编辑并保存人设，持久化后 Chaya 会立即更新 */
  onSavePersona?: (preset: PersonaPreset) => Promise<void>;
  onOpenPersonaSettings?: () => void;
  personaSwitchLoading?: boolean;
  personaSaveLoading?: boolean;
}

export const PersonaSwitchDialog: React.FC<PersonaSwitchDialogProps> = ({
  open,
  onOpenChange,
  personaPresets,
  currentPersonaId,
  fallbackSystemPrompt,
  variant = 'preset_list',
  onSwitchPersona,
  onSavePersona,
  onOpenPersonaSettings,
  personaSwitchLoading = false,
  personaSaveLoading = false,
}) => {
  const [previewPersona, setPreviewPersona] = useState<PersonaPreset | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editNickname, setEditNickname] = useState('');
  const [editSystemPrompt, setEditSystemPrompt] = useState('');

  useEffect(() => {
    if (previewPersona && !isEditing) {
      setEditNickname(previewPersona.nickname || '');
      setEditSystemPrompt(previewPersona.system_prompt || '');
    }
  }, [previewPersona?.id, isEditing]);

  const handleSelectPersona = async (id: string) => {
    if (id === '__fallback__') return;
    if (id === currentPersonaId) return;
    try {
      await onSwitchPersona(id);
      onOpenChange(false);
    } catch (_e) {
      // 错误由调用方 toast
    }
  };

  const handleStartEdit = () => {
    if (previewPersona) {
      setEditNickname(previewPersona.nickname || '');
      setEditSystemPrompt(previewPersona.system_prompt || '');
      setIsEditing(true);
    }
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    if (previewPersona) {
      setEditNickname(previewPersona.nickname || '');
      setEditSystemPrompt(previewPersona.system_prompt || '');
    }
  };

  const handleSaveEdit = async () => {
    if (!previewPersona || !onSavePersona || !editNickname.trim()) return;
    const updated: PersonaPreset = {
      id: previewPersona.id,
      nickname: editNickname.trim(),
      system_prompt: editSystemPrompt.trim(),
    };
    try {
      await onSavePersona(updated);
      setPreviewPersona(updated);
      setIsEditing(false);
    } catch (_e) {
      // 错误由调用方 toast
    }
  };

  const prevOpenRef = React.useRef(false);
  React.useEffect(() => {
    if (!open) {
      setPreviewPersona(null);
      setIsEditing(false);
      prevOpenRef.current = false;
      return;
    }
    const justOpened = !prevOpenRef.current;
    prevOpenRef.current = true;

    if (justOpened) {
      if (variant === 'current_agent_only') {
        const matched =
          currentPersonaId && personaPresets.find((p) => p.id === currentPersonaId);
        setPreviewPersona({
          id: matched ? matched.id : '__fallback__',
          nickname: (matched?.nickname || '').trim() || '当前人设',
          system_prompt: (fallbackSystemPrompt || '').trim(),
        });
        return;
      }
      if (personaPresets.length > 0) {
        setPreviewPersona(null);
      } else if (fallbackSystemPrompt?.trim()) {
        setPreviewPersona({ id: '__fallback__', nickname: '当前人设', system_prompt: fallbackSystemPrompt.trim() });
      } else {
        setPreviewPersona(null);
      }
      return;
    }
    if (variant === 'current_agent_only') {
      setPreviewPersona((prev) =>
        prev ? { ...prev, system_prompt: (fallbackSystemPrompt || '').trim() } : prev,
      );
    } else if (personaPresets.length === 0 && fallbackSystemPrompt?.trim()) {
      setPreviewPersona((prev) =>
        prev?.id === '__fallback__'
          ? { ...prev, system_prompt: fallbackSystemPrompt.trim() }
          : prev,
      );
    }
  }, [open, personaPresets, variant, currentPersonaId, fallbackSystemPrompt]);

  const showPreview = open && previewPersona !== null;
  const loading = personaSwitchLoading || personaSaveLoading;

  const handleClose = (o: boolean) => {
    if (!o) {
      setPreviewPersona(null);
      setIsEditing(false);
    }
    onOpenChange(o);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className={`chatee-dialog-standard max-w-lg ${showPreview ? 'flex flex-col max-h-[85vh]' : ''}`}>
        {showPreview ? (
          /* 预览/编辑页 */
          <>
            <DialogHeader className="flex-shrink-0 space-y-1">
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 shrink-0"
                  onClick={() => {
                    if (variant === 'current_agent_only') {
                      onOpenChange(false);
                      return;
                    }
                    if (personaPresets.length === 0) {
                      onOpenChange(false);
                      return;
                    }
                    setIsEditing(false);
                    setPreviewPersona(null);
                  }}
                  title={
                    variant === 'current_agent_only'
                      ? '关闭'
                      : personaPresets.length === 0
                        ? '关闭'
                        : '返回列表'
                  }
                >
                  <ArrowLeft className="w-4 h-4" />
                </Button>
                <DialogTitle className="text-base truncate">
                  {isEditing ? '编辑人设' : previewPersona.nickname}
                </DialogTitle>
              </div>
              <DialogDescription className="text-xs">
                {isEditing
                  ? '修改昵称或人设内容后保存，若为当前使用的人设，Chaya 会立即更新'
                  : variant === 'current_agent_only'
                    ? '当前 Agent 正在使用的系统提示词。切换全局预设请点头像进入「人设管理」。'
                    : '人设内容预览（可点击「编辑」修改并保存，系统提示词较长时可在此区域内滚动查看全文）'}
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-1.5 min-h-0 flex-1 overflow-hidden">
              {isEditing ? (
                <div className="space-y-3 overflow-y-auto no-scrollbar flex-1 min-h-0">
                  <div>
                    <Label htmlFor="persona-edit-nickname" className="text-xs [data-skin='niho']:text-[var(--niho-skyblue-gray)]">昵称</Label>
                    <Input
                      id="persona-edit-nickname"
                      value={editNickname}
                      onChange={(e) => setEditNickname(e.target.value)}
                      placeholder="方便记忆的名称"
                      className="mt-1 text-sm [data-skin='niho']:bg-[var(--niho-pure-black)] [data-skin='niho']:border-[var(--niho-text-border)] [data-skin='niho']:text-[var(--text-primary)]"
                    />
                  </div>
                  <div>
                    <Label htmlFor="persona-edit-prompt" className="text-xs [data-skin='niho']:text-[var(--niho-skyblue-gray)]">人设 / 系统提示词</Label>
                    <Textarea
                      id="persona-edit-prompt"
                      value={editSystemPrompt}
                      onChange={(e) => setEditSystemPrompt(e.target.value)}
                      placeholder="定义角色、能力和行为..."
                      className="mt-1 min-h-[200px] text-sm resize-y [data-skin='niho']:bg-[var(--niho-pure-black)] [data-skin='niho']:border-[var(--niho-text-border)] [data-skin='niho']:text-[var(--text-primary)]"
                    />
                  </div>
                </div>
              ) : (
                <>
                  <div className="min-h-0 flex-1 overflow-y-auto no-scrollbar rounded-lg bg-gray-50 dark:bg-[#1a1a1a] [data-skin='niho']:bg-[var(--niho-pure-black)] [data-skin='niho']:border [data-skin='niho']:border-[var(--niho-text-border)] border border-gray-200 dark:border-[#333] p-3">
                    <pre className="text-sm text-gray-800 dark:text-gray-200 [data-skin='niho']:text-[var(--text-primary)] whitespace-pre-wrap font-sans leading-relaxed m-0">
                      {previewPersona.system_prompt || '该人设暂无内容'}
                    </pre>
                  </div>
                  {(previewPersona.system_prompt?.length ?? 0) > 300 && (
                    <p className="text-[11px] text-gray-500 dark:text-[#808080] [data-skin='niho']:text-[var(--niho-skyblue-gray)] px-0.5">
                      内容较长，可在此区域内上下滚动查看全文
                    </p>
                  )}
                </>
              )}
            </div>

            <DialogFooter className="flex-shrink-0 gap-2 border-t border-gray-200 dark:border-[#333] [data-skin='niho']:border-[var(--niho-text-border)] pt-4">
              {isEditing ? (
                <>
                  <Button variant="secondary" className="niho-close-pink" onClick={handleCancelEdit}>
                    取消
                  </Button>
                  <Button
                    variant="primary"
                    disabled={loading || !editNickname.trim()}
                    onClick={handleSaveEdit}
                    className="[data-skin='niho']:bg-[var(--color-accent)] [data-skin='niho']:text-[#000000] [data-skin='niho']:hover:bg-[var(--color-accent-hover)]"
                  >
                    {personaSaveLoading ? '保存中...' : '保存'}
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="secondary"
                    className="niho-close-pink"
                    onClick={() => {
                      if (variant === 'current_agent_only') {
                        onOpenChange(false);
                        return;
                      }
                      if (personaPresets.length === 0) {
                        onOpenChange(false);
                        return;
                      }
                      setIsEditing(false);
                      setPreviewPersona(null);
                    }}
                  >
                    {variant === 'current_agent_only' || personaPresets.length === 0 ? '关闭' : '返回'}
                  </Button>
                  {onSavePersona && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={loading}
                      onClick={handleStartEdit}
                      className="[data-skin='niho']:border-[var(--niho-text-border)] [data-skin='niho']:text-[var(--text-primary)]"
                    >
                      <Pencil className="w-3.5 h-3.5 mr-1" />
                      编辑
                    </Button>
                  )}
                  <Button
                    variant="primary"
                    disabled={
                      loading ||
                      previewPersona.id === '__fallback__' ||
                      currentPersonaId === previewPersona.id
                    }
                    onClick={() => handleSelectPersona(previewPersona.id)}
                    className="[data-skin='niho']:bg-[var(--color-accent)] [data-skin='niho']:text-[#000000] [data-skin='niho']:hover:bg-[var(--color-accent-hover)]"
                  >
                    {previewPersona.id === '__fallback__' || currentPersonaId === previewPersona.id ? (
                      <>
                        <Check className="w-3.5 h-3.5 mr-1.5" />
                        当前使用
                      </>
                    ) : (
                      '使用此人设'
                    )}
                  </Button>
                </>
              )}
            </DialogFooter>
          </>
        ) : variant === 'current_agent_only' ? (
          <div className="py-10 text-center text-sm text-muted-foreground">加载中…</div>
        ) : (
          /* 列表页 */
          <>
            <DialogHeader className="flex-shrink-0">
              <DialogTitle>切换人设</DialogTitle>
              <DialogDescription>
                点击人设查看详情，在详情页可切换使用
              </DialogDescription>
            </DialogHeader>

            {onOpenPersonaSettings && (
              <div className="px-1 pb-1">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => {
                    onOpenChange(false);
                    onOpenPersonaSettings();
                  }}
                >
                  打开基本设置
                </Button>
              </div>
            )}

            <ScrollArea className="max-h-[60vh] overflow-auto no-scrollbar pr-1">
              <div className="space-y-0.5 py-0.5">
                {personaPresets.length === 0 ? (
                  <div className="py-6 px-4 text-center rounded-md border border-dashed bg-gray-50 dark:bg-[#1a1a1a] [data-skin='niho']:bg-[var(--niho-pure-black)] border-gray-300 dark:border-[#404040] [data-skin='niho']:border-[var(--niho-text-border)]">
                    <MessageSquare className="w-6 h-6 mx-auto mb-1.5 text-gray-400 [data-skin='niho']:text-[var(--niho-skyblue-gray)]" />
                    <p className="text-xs text-gray-500 dark:text-[#808080] [data-skin='niho']:text-[var(--niho-skyblue-gray)]">
                      暂无人设预设，可在「设置 → 人设管理」中添加
                    </p>
                  </div>
                ) : (
                  personaPresets.map((p) => (
                    <div
                      key={p.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => setPreviewPersona(p)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setPreviewPersona(p);
                        }
                      }}
                      className={`
                        flex items-center gap-2 w-full px-2.5 py-1.5 rounded-md border text-left transition-colors cursor-pointer select-none min-h-0
                        ${currentPersonaId === p.id
                          ? 'bg-primary-50 dark:bg-primary-900/20 border-primary-200 dark:border-primary-800 [data-skin="niho"]:bg-[var(--color-accent-bg)] [data-skin="niho"]:border-[var(--color-accent)]'
                          : 'bg-gray-50 dark:bg-[#1a1a1a] border-gray-200 dark:border-[#333] hover:bg-gray-100 dark:hover:bg-[#252525] [data-skin="niho"]:bg-[var(--niho-pure-black)] [data-skin="niho"]:border-[var(--niho-text-border)] [data-skin="niho"]:hover:bg-[var(--niho-text-bg)]'
                        }
                        ${personaSwitchLoading ? 'opacity-60 pointer-events-none' : ''}
                      `}
                    >
                      <span className="flex-1 min-w-0 text-xs font-medium truncate text-gray-900 dark:text-white [data-skin='niho']:text-[var(--text-primary)]">
                        {p.nickname}
                      </span>
                      {currentPersonaId === p.id && (
                        <span className="shrink-0 inline-flex items-center gap-0.5 text-[10px] text-primary-600 dark:text-primary-400 [data-skin='niho']:text-[var(--color-accent)]">
                          <Check className="w-2.5 h-2.5" /> 使用中
                        </span>
                      )}
                      <ChevronRight className="w-3.5 h-3.5 shrink-0 text-gray-400 [data-skin='niho']:text-[var(--niho-skyblue-gray)]" aria-hidden />
                    </div>
                  ))
                )}
              </div>
            </ScrollArea>

            <DialogFooter className="flex-shrink-0 border-t border-gray-200 dark:border-[#333] [data-skin='niho']:border-[var(--niho-text-border)] pt-4">
              <Button variant="secondary" className="niho-close-pink" onClick={() => onOpenChange(false)}>
                关闭
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};
