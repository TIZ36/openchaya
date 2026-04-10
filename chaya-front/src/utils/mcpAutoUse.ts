/** localStorage：对话是否允许后端自动选用 MCP（与 backend mcp_chat_router.ext.auto_mcp 对齐） */
export const MCP_AUTO_USE_LS_KEY = 'chaya_mcp_auto_use';

export function readMcpAutoUseEnabled(): boolean {
  try {
    return localStorage.getItem(MCP_AUTO_USE_LS_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function writeMcpAutoUseEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(MCP_AUTO_USE_LS_KEY, enabled ? 'true' : 'false');
  } catch {
    /* ignore */
  }
}
