import React from 'react';
import { FileText } from 'lucide-react';
import { Button } from '../../ui/Button';
import { Textarea } from '../../ui/Textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../../ui/Dialog';

export interface SystemPromptEditDialogProps {
  open: boolean;
  onClose: () => void;
  draft: string;
  setDraft: (value: string) => void;
  onSave: () => Promise<void>;
  onClear: () => Promise<void>;
}

export const SystemPromptEditDialog: React.FC<SystemPromptEditDialogProps> = ({
  open,
  onClose,
  draft,
  setDraft,
  onSave,
  onClear,
}) => {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-indigo-500" />
            设置人设
          </DialogTitle>
          <DialogDescription>
            人设是 AI 的角色设定，会影响所有对话的回复风格和内容。
          </DialogDescription>
        </DialogHeader>

        <div className="py-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="例如：你是一个专业的产品经理，擅长分析用户需求和产品设计..."
            className="min-h-[160px]"
            autoFocus
          />
        </div>

        <DialogFooter className="flex items-center justify-between">
          <Button
            variant="destructive"
            onClick={() => {
              void onClear();
            }}
          >
            清除人设
          </Button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              取消
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                void onSave();
              }}
            >
              保存
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
