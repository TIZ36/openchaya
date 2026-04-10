/**
 * 基本设置对话框（与 Persona 页内嵌共用 ChayaConfigPanel）
 */

import React from 'react';
import { Settings } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from './ui/Dialog';
import ChayaConfigPanel from './ChayaConfigPanel';
import type { PersonaPreset } from '../services/roleApi';
import type { Session } from '../services/chat';

interface AgentPersonaDialogProps {
  agent: Session | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 与 AgentsPage 一致：来自主 Agent ext，供自定义 Agent 基本设置载入人设预设 */
  globalPersonaPresets?: PersonaPreset[];
  onSaved?: () => void;
}

const AgentPersonaDialog: React.FC<AgentPersonaDialogProps> = ({
  agent,
  open,
  onOpenChange,
  globalPersonaPresets,
  onSaved,
}) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[80vh] flex flex-col [data-skin='niho']:bg-[#000000] [data-skin='niho']:border-[var(--niho-text-border)]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 [data-skin='niho']:text-[var(--text-primary)]">
            <Settings className="w-5 h-5 [data-skin='niho']:text-[var(--color-accent)]" />
            基本设置
          </DialogTitle>
        </DialogHeader>

        <ChayaConfigPanel
          agent={agent}
          active={open && !!agent}
          variant="dialog"
          globalPersonaPresets={globalPersonaPresets}
          onCancel={() => onOpenChange(false)}
          onSaved={() => {
            onOpenChange(false);
            onSaved?.();
          }}
        />
      </DialogContent>
    </Dialog>
  );
};

export default AgentPersonaDialog;
