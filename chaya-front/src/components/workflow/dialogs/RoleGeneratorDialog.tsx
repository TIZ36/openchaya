import React from 'react';
import { Button } from '../../ui/Button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../../ui/Dialog';
import RoleGeneratorPage from '../../RoleGeneratorPage';

export interface RoleGeneratorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onClose: () => void;
  onSaved?: () => void;
}

export const RoleGeneratorDialog: React.FC<RoleGeneratorDialogProps> = ({
  open,
  onOpenChange,
  onClose,
  onSaved,
}) => {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
    >
      <DialogContent className="max-w-6xl h-[85vh] flex flex-col p-0">
        <DialogHeader className="flex-shrink-0 px-6 pt-6 pb-4 border-b border-gray-200 dark:border-[#404040]">
          <DialogTitle>创建人设</DialogTitle>
          <DialogDescription>生成并保存一个可复用的人设（角色），然后在对话中一键切换。</DialogDescription>
        </DialogHeader>
        <div className="flex-1 min-h-0">
          <RoleGeneratorPage isEmbedded onSaved={onSaved} />
        </div>
        <DialogFooter className="flex-shrink-0 px-6 py-4 border-t border-gray-200 dark:border-[#404040]">
          <Button
            variant="secondary"
            onClick={onClose}
          >
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
