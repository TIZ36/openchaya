import React, { useCallback, useEffect, useState } from 'react';
import { Package, Loader, RefreshCw, Trash2, Pencil, BookOpen, Plus } from 'lucide-react';
import {
  getSkillPacks,
  deleteSkillPack,
  updateSkillPack,
  saveSkillPack,
  type SkillPack,
} from '../services/skillPackApi';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { toast } from './ui/use-toast';
import { ConfirmDialog } from './ui/ConfirmDialog';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from './ui/Dialog';

/**
 * 技能录入：技能包列表与基础维护（新建仍主要在 Chaya 对话流中完成）
 */
interface SkillPackEntryPageProps {
  sessionId?: string;
}

const SkillPackEntryPage: React.FC<SkillPackEntryPageProps> = ({ sessionId }) => {
  const [list, setList] = useState<SkillPack[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editSummary, setEditSummary] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<SkillPack | null>(null);
  const [selectedPack, setSelectedPack] = useState<SkillPack | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createSummary, setCreateSummary] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const packs = await getSkillPacks();
      setList(packs);
    } catch (e) {
      console.error(e);
      toast({ title: '加载失败', description: String(e), variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const cancelEdit = () => {
    setEditingId(null);
    setEditName('');
    setEditSummary('');
  };

  const saveEdit = async () => {
    if (!editingId || !selectedPack) return;
    try {
      await updateSkillPack(editingId, { name: editName.trim(), summary: editSummary.trim() });
      toast({ title: '已保存', variant: 'success' });
      await load();
      setSelectedPack({ ...selectedPack, name: editName.trim(), summary: editSummary.trim() });
      setEditingId(null);
    } catch (e) {
      toast({
        title: '保存失败',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteSkillPack(deleteTarget.skill_pack_id);
      toast({ title: '已删除', variant: 'success' });
      if (selectedPack?.skill_pack_id === deleteTarget.skill_pack_id) {
        setDetailOpen(false);
        setSelectedPack(null);
      }
      setDeleteTarget(null);
      await load();
    } catch (e) {
      toast({
        title: '删除失败',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    }
  };

  const handleCreateSkillPack = async () => {
    const name = createName.trim();
    if (!name) {
      toast({ title: '请填写技能包名称', variant: 'destructive' });
      return;
    }
    setCreating(true);
    try {
      const saved = await saveSkillPack({
        name,
        summary: createSummary.trim() || undefined,
      });
      toast({ title: '已创建技能包', variant: 'success' });
      setCreateOpen(false);
      setCreateName('');
      setCreateSummary('');
      await load();
      setSelectedPack(saved);
      setDetailOpen(true);
      cancelEdit();
    } catch (e) {
      toast({
        title: '创建失败',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    } finally {
      setCreating(false);
    }
  };

  const openDetail = (pack: SkillPack, editable = false) => {
    setSelectedPack(pack);
    setDetailOpen(true);
    if (editable) {
      setEditingId(pack.skill_pack_id);
      setEditName(pack.name);
      setEditSummary(pack.summary || '');
    } else {
      cancelEdit();
    }
  };

  return (
    <div className="skill-pack-entry-page h-full flex flex-col bg-[var(--surface-primary)]">
      <div className="flex-1 overflow-y-auto no-scrollbar app-pane-pad">
        <div className="max-w-6xl mx-auto w-full space-y-3">
          <div className="app-card-item app-card-pad-sm flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <Package className="w-5 h-5 text-[var(--color-accent)] flex-shrink-0" />
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-[var(--text-primary)] truncate">技能包</h2>
                <p className="text-xs text-[var(--text-muted)] truncate">
                  可在此新建空白技能包，或在 Chaya 对话中从消息生成；支持改名、改摘要或删除
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <Button variant="primary" size="sm" className="h-8" onClick={() => setCreateOpen(true)}>
                <Plus className="w-3.5 h-3.5 mr-1.5" />
                新建技能包
              </Button>
              <Button variant="outline" size="sm" className="h-8" onClick={() => load()} disabled={loading}>
                <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
                刷新
              </Button>
            </div>
          </div>
          {sessionId ? (
            <div className="app-card-item app-card-pad-sm text-xs text-[var(--text-secondary)]">
              当前 Agent：<code className="px-1 py-0.5 rounded bg-gray-100 dark:bg-[#222]">{sessionId}</code>
            </div>
          ) : null}
          <div className="app-card-item app-card-pad-sm">
            {loading ? (
              <div className="flex items-center justify-center py-16 text-[var(--text-muted)]">
                <Loader className="w-6 h-6 animate-spin mr-2" />
                加载中…
              </div>
            ) : list.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center max-w-md mx-auto">
                <BookOpen className="w-10 h-10 text-[var(--text-muted)] mb-3 opacity-60" />
                <p className="text-sm text-[var(--text-secondary)]">暂无技能包</p>
                <p className="text-xs text-[var(--text-muted)] mt-1">
                  点击上方「新建技能包」手动创建，或在「Chaya 聊天」中勾选消息后生成并保存
                </p>
                <Button variant="outline" size="sm" className="mt-4 h-8" onClick={() => setCreateOpen(true)}>
                  <Plus className="w-3.5 h-3.5 mr-1.5" />
                  新建技能包
                </Button>
              </div>
            ) : (
              <div className="app-card-grid">
                {list.map((p) => (
                  <div
                    key={p.skill_pack_id}
                    className="app-card-item app-card-pad-sm cursor-pointer"
                    onClick={() => openDetail(p)}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-[var(--text-primary)] truncate">{p.name}</div>
                        {p.summary ? (
                          <p className="text-xs text-[var(--text-secondary)] mt-1 line-clamp-4">
                            {p.summary}
                          </p>
                        ) : (
                          <p className="text-xs text-[var(--text-muted)] mt-1">暂无摘要</p>
                        )}
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          title="编辑"
                          onClick={(e) => { e.stopPropagation(); openDetail(p, true); }}
                        >
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 text-[var(--color-secondary)]"
                          title="删除"
                          onClick={(e) => { e.stopPropagation(); setDeleteTarget(p); }}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                    <p className="text-[10px] text-[var(--text-muted)] mt-3">
                      {p.updated_at ? `更新 ${p.updated_at}` : `创建 ${p.created_at || '—'}`}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <Dialog open={createOpen} onOpenChange={(o) => { setCreateOpen(o); if (!o) { setCreateName(''); setCreateSummary(''); } }}>
        <DialogContent className="max-w-lg chatee-dialog-standard">
          <DialogHeader>
            <DialogTitle>新建技能包</DialogTitle>
            <DialogDescription>填写名称与可选摘要；摘要不填时系统将使用默认占位文案。</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 max-h-[60vh] overflow-auto no-scrollbar">
            <Input
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              placeholder="技能包名称（必填）"
              className="h-9"
            />
            <textarea
              value={createSummary}
              onChange={(e) => setCreateSummary(e.target.value)}
              placeholder="摘要 / 能力说明（可选）"
              rows={6}
              className="w-full rounded-md border border-[var(--border-default)] bg-[var(--surface-primary)] px-3 py-2 text-sm text-[var(--text-primary)] resize-y min-h-[120px]"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setCreateOpen(false)} disabled={creating}>
              取消
            </Button>
            <Button variant="primary" size="sm" onClick={() => void handleCreateSkillPack()} disabled={creating}>
              {creating ? '创建中…' : '创建'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={detailOpen}
        onOpenChange={(open) => {
          setDetailOpen(open);
          if (!open) {
            setSelectedPack(null);
            cancelEdit();
          }
        }}
      >
        <DialogContent className="max-w-2xl chatee-dialog-standard">
          {selectedPack && (
            <>
              <DialogHeader>
                <DialogTitle>{editingId === selectedPack.skill_pack_id ? '编辑技能包' : selectedPack.name}</DialogTitle>
                <DialogDescription>
                  {editingId === selectedPack.skill_pack_id ? '修改名称和摘要后保存' : '技能包详情'}
                </DialogDescription>
              </DialogHeader>
              <div className="max-h-[60vh] overflow-auto no-scrollbar">
                {editingId === selectedPack.skill_pack_id ? (
                  <div className="space-y-3">
                    <Input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      placeholder="名称"
                      className="h-9"
                    />
                    <textarea
                      value={editSummary}
                      onChange={(e) => setEditSummary(e.target.value)}
                      placeholder="摘要"
                      rows={8}
                      className="w-full rounded-md border border-[var(--border-default)] bg-[var(--surface-primary)] px-3 py-2 text-sm text-[var(--text-primary)] resize-y min-h-[160px]"
                    />
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div>
                      <div className="text-xs text-[var(--text-muted)] mb-1">名称</div>
                      <div className="text-sm font-medium text-[var(--text-primary)]">{selectedPack.name}</div>
                    </div>
                    <div>
                      <div className="text-xs text-[var(--text-muted)] mb-1">摘要</div>
                      <div className="text-sm text-[var(--text-secondary)] whitespace-pre-wrap break-words">
                        {selectedPack.summary || '暂无摘要'}
                      </div>
                    </div>
                    <div className="text-xs text-[var(--text-muted)]">
                      {selectedPack.updated_at ? `更新 ${selectedPack.updated_at}` : `创建 ${selectedPack.created_at || '—'}`}
                    </div>
                  </div>
                )}
              </div>
              <DialogFooter className="gap-2">
                {editingId === selectedPack.skill_pack_id ? (
                  <>
                    <Button variant="outline" className="niho-close-pink" onClick={() => cancelEdit()}>
                      取消编辑
                    </Button>
                    <Button onClick={saveEdit}>保存</Button>
                  </>
                ) : (
                  <>
                    <Button variant="outline" className="niho-close-pink" onClick={() => setDetailOpen(false)}>
                      关闭
                    </Button>
                    <Button variant="outline" onClick={() => openDetail(selectedPack, true)}>
                      编辑
                    </Button>
                    <Button variant="destructive" onClick={() => setDeleteTarget(selectedPack)}>
                      删除
                    </Button>
                  </>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="删除技能包"
        description={`确定删除「${deleteTarget?.name ?? ''}」吗？此操作不可恢复。`}
        variant="destructive"
        onConfirm={confirmDelete}
      />
    </div>
  );
};

export default SkillPackEntryPage;
