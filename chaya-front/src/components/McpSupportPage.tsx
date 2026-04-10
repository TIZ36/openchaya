/**
 * 本系统已接入 MCP 能力说明（只读列表，数据来自后端）
 */

import React, { useEffect, useState } from 'react';
import { Server, Loader2 } from 'lucide-react';
import PageLayout, { Card } from './ui/PageLayout';
import { getMCPServers, type MCPServerConfig } from '../services/mcpApi';

function displayType(server: MCPServerConfig): string {
  if (server.ext?.server_type === 'http_oauth') return 'http-oauth';
  if (server.ext?.server_type === 'notion') return 'notion';
  return server.type;
}

const McpSupportPage: React.FC = () => {
  const [servers, setServers] = useState<MCPServerConfig[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const list = await getMCPServers();
        if (!cancelled) setServers(list || []);
      } catch {
        if (!cancelled) setServers([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const enabledList = servers.filter((s) => s.enabled);

  return (
    <PageLayout
      title="本系统支持的 MCP"
      showHeader={false}
      fullWidth
      contentClassName="min-h-0 p-0 overflow-auto no-scrollbar"
    >
      <div className="mcp-support-page max-w-3xl mx-auto w-full space-y-4 pb-8 app-pane-pad">
          <Card className="niho-card-2 p-4 space-y-2">
            <p className="text-sm text-[var(--text-primary)] leading-relaxed">
              以下为当前环境已配置的 MCP 服务端点。启用状态由「MCP」页签中的录入管理；对话中是否在每轮自动选用，由「对话中自动使用 MCP」开关与后端路由策略共同决定。
            </p>
            <p className="text-xs text-[var(--text-muted)]">
              显式在输入区「插件」中勾选的 MCP 会优先于自动路由；将自动开关关闭后，仅使用插件中勾选的服务器。
            </p>
          </Card>

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-[var(--text-muted)] text-sm">
              <Loader2 className="w-4 h-4 animate-spin" />
              加载中…
            </div>
          ) : enabledList.length === 0 ? (
            <Card className="niho-card-1 p-6 text-center text-sm text-[var(--text-muted)]">
              当前没有已启用的 MCP 服务器，请在「MCP」页签中添加并启用。
            </Card>
          ) : (
            <div className="app-list-layout space-y-2">
              {enabledList.map((s) => (
                <div
                  key={s.id}
                  className="app-list-item niho-card-1 flex flex-col gap-1.5 p-3 sm:flex-row sm:items-start sm:justify-between"
                >
                  <div className="flex items-start gap-2 min-w-0">
                    <Server className="w-4 h-4 text-[var(--color-accent)] flex-shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-[var(--text-primary)] truncate">
                        {s.display_name || s.client_name || s.name}
                      </div>
                      {s.description && (
                        <div className="text-xs text-[var(--text-muted)] mt-0.5 leading-relaxed">{s.description}</div>
                      )}
                      {s.url && (
                        <div className="text-[11px] font-mono text-[var(--niho-skyblue-gray)] mt-1 truncate" title={s.url}>
                          {s.url}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5 sm:justify-end sm:flex-shrink-0">
                    <span className="text-[10px] px-2 py-0.5 rounded border border-[var(--niho-text-border)] text-[var(--niho-skyblue-gray)]">
                      {displayType(s)}
                    </span>
                    <span className="text-[10px] px-2 py-0.5 rounded border border-[var(--color-accent)]/35 text-[var(--color-accent)]">
                      已启用
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
    </PageLayout>
  );
};

export default McpSupportPage;
