/**
 * MCP 工作台：服务器录入与管理
 * 「对话中自动使用 MCP」开关在聊天页顶部 Tab 行（Chaya）
 */

import React from 'react';
import MCPConfig from './MCPConfig';

interface McpWorkspacePanelProps {
  sessionId?: string;
}

const McpWorkspacePanel: React.FC<McpWorkspacePanelProps> = ({ sessionId }) => {
  return (
    <div className="mcp-workspace-page h-full min-h-0 flex flex-col overflow-hidden bg-[var(--surface-primary)]">
      {sessionId ? (
        <div className="px-3 py-2 text-xs text-[var(--text-secondary)] border-b border-[var(--border-default)]">
          当前 Agent：<code className="px-1 py-0.5 rounded bg-gray-100 dark:bg-[#222]">{sessionId}</code>
        </div>
      ) : null}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <MCPConfig />
      </div>
    </div>
  );
};

export default McpWorkspacePanel;
