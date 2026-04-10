import React from 'react';
import { Plus, MessageCircle, Users, BookOpen } from 'lucide-react';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { ScrollArea } from '../../ui/ScrollArea';
import { DataListItem } from '../../ui/DataListItem';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../../ui/Dialog';
import type { Session } from '../../../services/chat';

export interface PersonaPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  personaSearch: string;
  setPersonaSearch: (value: string) => void;
  isLoadingPersonaList: boolean;
  personaAgents: Session[];
  personaTopics: Session[];
  currentSessionId: string | null;
  onSwitchSession: (sessionId: string) => void;
  onDeleteAgent: (id: string, name: string) => void;
  onShowRoleGenerator: () => void;
}

export const PersonaPanel: React.FC<PersonaPanelProps> = ({
  open,
  onOpenChange,
  personaSearch,
  setPersonaSearch,
  isLoadingPersonaList,
  personaAgents,
  personaTopics,
  currentSessionId,
  onSwitchSession,
  onDeleteAgent,
  onShowRoleGenerator,
}) => {
  return (
    <Dialog
      open={open}
      onOpenChange={(open) => {
        onOpenChange(open);
        if (!open) setPersonaSearch('');
      }}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>选择会话/智能体</DialogTitle>
          <DialogDescription>切换不同的智能体或查看历史群聊</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Input
            value={personaSearch}
            onChange={(e) => setPersonaSearch(e.target.value)}
            placeholder="搜索智能体或群聊..."
            className="h-9"
          />
          <Button
            variant="secondary"
            onClick={() => {
              onShowRoleGenerator();
              onOpenChange(false);
            }}
            title="创建/生成一个新的人设（角色）"
          >
            <Plus className="w-4 h-4" />
            <span>新建Agent</span>
          </Button>
        </div>

        <ScrollArea className="h-[60vh] pr-2 w-full">
          <div className="space-y-4 py-2 w-full min-w-0">
            {/* 智能体/会话列表 */}
            <div className="w-full">
              <div className="text-xs font-semibold text-gray-700 dark:text-gray-200 px-1 mb-1">所有会话</div>
              <div className="space-y-1 w-full">
                {isLoadingPersonaList ? (
                  <div className="text-xs text-gray-500 dark:text-[#808080] px-1 py-2">加载中...</div>
                ) : (
                  <div className="space-y-1 w-full">
                    {/* 合并显示 Agent 和 Meeting */}
                    {personaAgents
                      .filter((a) => {
                        const q = personaSearch.trim().toLowerCase();
                        if (!q) return true;
                        const name = (a.name || a.title || a.session_id).toLowerCase();
                        const prompt = (a.system_prompt || '').toLowerCase();
                        return name.includes(q) || prompt.includes(q);
                      })
                      .map((a) => (
                        <DataListItem
                          key={a.session_id}
                          id={a.session_id}
                          title={a.name || a.title || `Agent ${a.session_id.slice(0, 8)}`}
                          description={a.system_prompt ? a.system_prompt.split('\n')[0]?.slice(0, 80) + (a.system_prompt.length > 80 ? '...' : '') : `${a.message_count || 0} 条消息 · ${a.last_message_at ? new Date(a.last_message_at).toLocaleDateString() : '无记录'}`}
                          avatar={a.avatar || undefined}
                          isSelected={currentSessionId === a.session_id}
                          onClick={() => onSwitchSession(a.session_id)}
                          onDelete={(e) => {
                            e.stopPropagation();
                            onDeleteAgent(a.session_id, a.name || a.title || `Agent ${a.session_id.slice(0, 8)}`);
                          }}
                        />
                      ))
                    }
                    {personaTopics
                      .filter((t) => {
                        const q = personaSearch.trim().toLowerCase();
                        if (!q) return true;
                        const name = (t.name || t.title || t.preview_text || t.session_id).toLowerCase();
                        return name.includes(q);
                      })
                      .map((t) => (
                        <DataListItem
                          key={t.session_id}
                          id={t.session_id}
                          title={t.name || t.title || t.preview_text || `话题 ${t.session_id.slice(0, 8)}`}
                          description={`话题 · ${t.message_count || 0} 条消息`}
                          icon={BookOpen}
                          isSelected={currentSessionId === t.session_id}
                          onClick={() => onSwitchSession(t.session_id)}
                          onDelete={(e) => {
                            e.stopPropagation();
                            onDeleteAgent(t.session_id, t.name || t.title || `话题 ${t.session_id.slice(0, 8)}`);
                          }}
                        />
                      ))
                    }
                  </div>
                )}
              </div>
            </div>
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
