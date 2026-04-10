import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  BookOpen, Trash2, Upload, Search, Loader,
  FileText, FileType, AlertCircle, CheckCircle2, Clock,
} from 'lucide-react';
import {
  getAgentKB, listDocuments, uploadDocuments, deleteDocument,
  searchKB, updateKBEmbedding,
  type KnowledgeBase, type KBDocument, type KBSearchResult,
} from '../services/kbApi';
import { getLLMConfigs } from '../services/llmApi';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { toast } from './ui/use-toast';

interface KnowledgeBasePageProps {
  sessionId?: string;
}

/**
 * 极简知识库页面
 *
 * 打开即用：自动为当前 Agent 创建知识库（本地免费 Embedding，无需配置）。
 * 三种操作：上传文件 · 粘贴飞书链接 · 查看已有文档。
 */
const KnowledgeBasePage: React.FC<KnowledgeBasePageProps> = ({ sessionId }) => {
  const [kb, setKb] = useState<KnowledgeBase | null>(null);
  const [loading, setLoading] = useState(true);

  const [docs, setDocs] = useState<KBDocument[]>([]);
  const [uploading, setUploading] = useState(false);

  // Embedding config
  const [showEmbeddingConfig, setShowEmbeddingConfig] = useState(false);
  const [llmConfigs, setLlmConfigs] = useState<Array<{ config_id: string; name: string; provider: string }>>([]);
  const [switchingEmbedding, setSwitchingEmbedding] = useState(false);

  // Search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<KBSearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Init ──
  const initKB = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    try {
      const result = await getAgentKB(sessionId);
      setKb(result);
      const docList = await listDocuments(result.kb_id);
      setDocs(docList);
    } catch (e: any) {
      toast({ title: '知识库初始化失败', description: e.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => { initKB(); }, [initKB]);

  // ── Poll processing docs ──
  useEffect(() => {
    const hasProcessing = docs.some((d) => d.status === 'pending' || d.status === 'processing');
    if (hasProcessing && kb) {
      pollRef.current = setInterval(async () => {
        try {
          const updated = await listDocuments(kb.kb_id);
          setDocs(updated);
          if (!updated.some((d) => d.status === 'pending' || d.status === 'processing')) {
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
            const refreshed = await getAgentKB(sessionId!);
            setKb(refreshed);
          }
        } catch { /* ignore */ }
      }, 3000);
    }
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [docs, kb, sessionId]);

  // ── Handlers ──

  const handleUpload = async (files: FileList | File[]) => {
    if (!kb) return;
    setUploading(true);
    try {
      await uploadDocuments(kb.kb_id, Array.from(files));
      toast({ title: `${files.length} 个文件已提交处理` });
      const updated = await listDocuments(kb.kb_id);
      setDocs(updated);
    } catch (e: any) {
      toast({ title: '上传失败', description: e.message, variant: 'destructive' });
    } finally {
      setUploading(false);
    }
  };

  const handleDeleteDoc = async (docId: string) => {
    if (!kb) return;
    try {
      await deleteDocument(kb.kb_id, docId);
      toast({ title: '文档已删除' });
      const updated = await listDocuments(kb.kb_id);
      setDocs(updated);
      const refreshed = await getAgentKB(sessionId!);
      setKb(refreshed);
    } catch {
      toast({ title: '删除失败', variant: 'destructive' });
    }
  };

  const handleSearch = async () => {
    if (!kb || !searchQuery.trim()) return;
    setSearching(true);
    try {
      const results = await searchKB(kb.kb_id, searchQuery.trim());
      setSearchResults(results);
    } catch {
      toast({ title: '搜索失败', variant: 'destructive' });
    } finally {
      setSearching(false);
    }
  };

  const handleToggleEmbeddingConfig = async () => {
    if (!showEmbeddingConfig && llmConfigs.length === 0) {
      try {
        const configs = await getLLMConfigs();
        setLlmConfigs(configs.map((c: any) => ({ config_id: c.config_id, name: c.name, provider: c.provider })));
      } catch { /* ignore */ }
    }
    setShowEmbeddingConfig(!showEmbeddingConfig);
  };

  const handleSwitchEmbedding = async (configId: string) => {
    if (!kb) return;
    setSwitchingEmbedding(true);
    try {
      const updated = await updateKBEmbedding(kb.kb_id, configId);
      setKb(updated);
      setShowEmbeddingConfig(false);
      toast({ title: `Embedding 已切换为 ${configId === 'local' ? '本地模型' : configId}` });
    } catch (e: any) {
      toast({ title: '切换失败', description: e.message, variant: 'destructive' });
    } finally {
      setSwitchingEmbedding(false);
    }
  };

  // ── Helpers ──

  const statusIcon = (s: string) => {
    if (s === 'ready') return <CheckCircle2 className="w-3 h-3 text-emerald-500" />;
    if (s === 'processing' || s === 'pending') return <Loader className="w-3 h-3 text-amber-500 animate-spin" />;
    if (s === 'error') return <AlertCircle className="w-3 h-3 text-red-500" />;
    return <Clock className="w-3 h-3 text-gray-400" />;
  };

  const statusText = (doc: KBDocument) => {
    if (doc.status === 'ready') return `${doc.chunk_count} 块`;
    if (doc.status === 'processing') return '处理中...';
    if (doc.status === 'pending') return '等待中...';
    if (doc.status === 'error') return doc.error_msg || '出错';
    return doc.status;
  };

  const fmtSize = (b: number) =>
    b < 1024 ? `${b}B` : b < 1048576 ? `${(b / 1024).toFixed(0)}KB` : `${(b / 1048576).toFixed(1)}MB`;

  // ── Render ──

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader className="w-5 h-5 animate-spin text-[var(--text-muted)]" />
      </div>
    );
  }

  if (!sessionId) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-[var(--text-muted)]">
        请先选择一个 Agent
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--border-default)]">
        <div className="flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-[var(--text-secondary)]" />
          <span className="text-xs font-medium text-[var(--text-primary)]">知识库</span>
          {kb && (
            <span className="text-[10px] text-[var(--text-muted)]">
              {kb.doc_count} 文档 · {kb.chunk_count} 块
            </span>
          )}
        </div>
        {kb && (
          <button
            onClick={handleToggleEmbeddingConfig}
            className="text-[10px] text-[var(--text-muted)] hover:text-blue-400 transition-colors cursor-pointer"
            title="点击切换 Embedding 模型"
          >
            {kb.embedding_config_id === 'local' ? '⚡ 本地模型' : `🔑 ${kb.embedding_model || 'API'}`}
          </button>
        )}
      </div>

      {/* Embedding config switcher */}
      {showEmbeddingConfig && kb && (
        <div className="px-4 py-2 border-b border-[var(--border-default)] bg-[var(--surface-secondary)]">
          <div className="text-[10px] text-[var(--text-muted)] mb-1.5">切换 Embedding 模型</div>
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => handleSwitchEmbedding('local')}
              disabled={switchingEmbedding}
              className={`px-2 py-1 rounded text-[11px] border transition-colors ${
                kb.embedding_config_id === 'local'
                  ? 'border-blue-500/50 bg-blue-500/10 text-blue-400'
                  : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:border-blue-400/30'
              }`}
            >
              ⚡ 本地免费
            </button>
            {llmConfigs.map((c) => (
              <button
                key={c.config_id}
                onClick={() => handleSwitchEmbedding(c.config_id)}
                disabled={switchingEmbedding}
                className={`px-2 py-1 rounded text-[11px] border transition-colors ${
                  kb.embedding_config_id === c.config_id
                    ? 'border-blue-500/50 bg-blue-500/10 text-blue-400'
                    : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:border-blue-400/30'
                }`}
              >
                🔑 {c.name}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-[var(--text-muted)] mt-1.5">
            本地模型免费但首次需下载 ~500MB；API 模型需要对应的 API Key，速度更快
          </p>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-4 py-3 space-y-4">

          {/* 1. Upload zone */}
          <div
            onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
            onDrop={(e) => {
              e.preventDefault(); e.stopPropagation();
              if (e.dataTransfer.files.length) handleUpload(e.dataTransfer.files);
            }}
            className="border border-dashed border-[var(--border-default)] rounded-lg p-5 text-center hover:border-blue-400/50 transition-colors cursor-pointer"
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? (
              <Loader className="w-5 h-5 mx-auto animate-spin text-blue-400 mb-1" />
            ) : (
              <Upload className="w-5 h-5 mx-auto text-[var(--text-muted)] mb-1" />
            )}
            <p className="text-xs text-[var(--text-muted)]">
              点击或拖拽文件上传
            </p>
            <p className="text-[10px] text-[var(--text-muted)] mt-0.5">
              TXT · MD · PDF · DOCX · JSON · YAML
            </p>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".txt,.md,.pdf,.docx,.json,.yaml,.yml,.csv"
            className="hidden"
            onChange={(e) => {
              if (e.target.files) handleUpload(e.target.files);
              e.target.value = '';
            }}
          />

          {/* 2. Document list */}
          {docs.length > 0 && (
            <div>
              <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider mb-1.5 font-medium">
                已加载的文档
              </div>
              <div className="space-y-1">
                {docs.map((doc) => (
                  <div
                    key={doc.doc_id}
                    className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-[var(--surface-secondary)] group"
                  >
                    {doc.file_type === 'pdf'
                      ? <FileType className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
                      : <FileText className="w-3.5 h-3.5 text-blue-400 flex-shrink-0" />}
                    <span className="text-xs text-[var(--text-primary)] truncate flex-1 min-w-0">
                      {doc.file_name}
                    </span>
                    <span className="text-[10px] text-[var(--text-muted)] flex-shrink-0">
                      {fmtSize(doc.file_size)}
                    </span>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {statusIcon(doc.status)}
                      <span className="text-[10px] text-[var(--text-muted)] max-w-[100px] truncate">
                        {statusText(doc)}
                      </span>
                    </div>
                    <button
                      onClick={() => handleDeleteDoc(doc.doc_id)}
                      className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-red-500/10 text-[var(--text-muted)] hover:text-red-500 transition-all flex-shrink-0"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 4. Search test */}
          {kb && (kb.chunk_count > 0 || docs.some((d) => d.status === 'ready')) && (
            <div>
              <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider mb-1.5 font-medium">
                检索测试
              </div>
              <div className="flex gap-2">
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="输入问题测试检索效果..."
                  className="flex-1 text-xs"
                  onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                />
                <Button size="sm" variant="outline" onClick={handleSearch} disabled={searching || !searchQuery.trim()}>
                  {searching ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                </Button>
              </div>
              {searchResults.length > 0 && (
                <div className="mt-2 space-y-1.5 max-h-[280px] overflow-y-auto">
                  {searchResults.map((r, i) => (
                    <div key={i} className="p-2 rounded-md bg-[var(--surface-secondary)] text-xs">
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="text-[10px] text-[var(--text-muted)] truncate">
                          {r.doc_name}{r.heading ? ` · ${r.heading}` : ''}
                        </span>
                        <span className="text-[10px] font-mono text-blue-400 flex-shrink-0 ml-2">
                          {r.score.toFixed(3)}
                        </span>
                      </div>
                      <p className="text-[var(--text-primary)] whitespace-pre-wrap line-clamp-3">
                        {r.text}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Empty state */}
          {docs.length === 0 && (
            <div className="text-center py-6">
              <p className="text-xs text-[var(--text-muted)]">
                上传文件，或在聊天中将机器人回复存入知识库。对话时 Agent 将自动检索相关内容
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default KnowledgeBasePage;
