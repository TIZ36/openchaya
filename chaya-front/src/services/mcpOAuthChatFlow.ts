import {
  discoverMCPOAuth,
  authorizeMCPOAuth,
  getMCPOAuthTokenStatus,
} from './mcpApi';

export type McpOAuthPollResult = 'success' | 'timeout';

/**
 * 与 MCPConfig.runHttpOAuthAuthorization 对齐：发现 → authorize → 新窗口打开授权页 → 轮询 token。
 * 用于聊天内 WS 推送 mcp_oauth_required 时一键拉起授权。
 */
export async function openMcpOAuthAuthorizeAndPoll(mcpUrlRaw: string): Promise<McpOAuthPollResult> {
  const mcpUrl = mcpUrlRaw.trim();
  if (!mcpUrl) {
    throw new Error('MCP URL 不能为空');
  }
  const discovery = await discoverMCPOAuth(mcpUrl);
  const as = discovery.authorization_server;
  const authorizeResult = await authorizeMCPOAuth({
    authorization_endpoint: as.authorization_endpoint,
    resource: discovery.resource,
    code_challenge_methods_supported: as.code_challenge_methods_supported,
    token_endpoint: as.token_endpoint,
    registration_endpoint: as.registration_endpoint,
    token_endpoint_auth_methods_supported:
      as.token_endpoint_auth_methods_supported ?? ['none'],
    mcp_url: mcpUrl.replace(/\/$/, ''),
  });
  window.open(authorizeResult.authorization_url, '_blank', 'noopener,noreferrer');

  const norm = mcpUrl.replace(/\/$/, '');
  for (let attempt = 0; attempt < 90; attempt++) {
    await new Promise((r) => setTimeout(r, 1000));
    const { has_token } = await getMCPOAuthTokenStatus(norm);
    if (has_token) return 'success';
  }
  return 'timeout';
}
