/**
 * MCP 服务器配置组件
 * 允许用户添加、编辑、删除 MCP 服务器配置
 */

import React, { useState, useEffect } from 'react';
import { Plus, Trash2, Edit2, X, Server, Check, Wrench, ExternalLink, Plug, RefreshCcw, Smartphone, Key, Loader } from 'lucide-react';
import QRCode from 'qrcode';
import { Button } from './ui/Button';
import { Label } from './ui/Label';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { InputField, TextareaField } from './ui/FormField';
import { toast } from './ui/use-toast';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from './ui/Select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from './ui/Dialog';
import { MCPTool, MCPClient } from '../services/mcpClient';
import {
  getMCPServers,
  createMCPServer,
  updateMCPServer,
  deleteMCPServer,
  MCPServerConfig,
  discoverMCPOAuth,
  authorizeMCPOAuth,
  getMCPOAuthTokenStatus,
  registerNotionClient,
  getNotionRegistrations,
  deleteNotionRegistration,
  NotionRegistration,
} from '../services/mcpApi';
import { getBackendUrl } from '../utils/backendUrl';
import { api } from '../utils/apiClient';

interface MCPConfigProps {}

/** 表单中 `http-oauth` 落库为 http-stream + ext.server_type=http_oauth */
function buildMcpServerPayload(partial: Partial<MCPServerConfig>): Partial<MCPServerConfig> {
  const isHttpOAuth = partial.type === 'http-oauth';
  const ext = { ...(partial.ext || {}) } as NonNullable<MCPServerConfig['ext']>;
  const normalizedUrl = typeof partial.url === 'string' ? partial.url.trim() : partial.url;
  if (isHttpOAuth) {
    ext.server_type = 'http_oauth';
  } else if (ext.server_type === 'http_oauth') {
    delete ext.server_type;
  }
  return {
    ...partial,
    url: normalizedUrl,
    type: isHttpOAuth ? 'http-stream' : (partial.type || 'http-stream'),
    ext: Object.keys(ext).length ? ext : undefined,
  };
}

function serverToFormState(server: MCPServerConfig): Partial<MCPServerConfig> {
  if (server.ext?.server_type === 'http_oauth') {
    return { ...server, type: 'http-oauth' };
  }
  return { ...server };
}

function displayMcpServerType(server: MCPServerConfig): string {
  if (server.ext?.server_type === 'http_oauth') return 'http-oauth';
  return server.type;
}

// Helper: 根据服务器类型渲染图标
const renderServerIcon = (server: MCPServerConfig, size: 'sm' | 'lg' = 'sm') => {
  const isNotion = (server as any).ext?.server_type === 'notion';
  
  if (isNotion) {
    // Notion 服务器显示 Notion 图标（使用完整的双层 path 实现主题适配）
    if (size === 'lg') {
      return (
        <div className="w-20 h-20 rounded-2xl bg-transparent flex items-center justify-center shadow-lg">
          <svg className="w-14 h-14" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M6.017 4.313l55.333 -4.087c6.797 -0.583 8.543 -0.19 12.817 2.917l17.663 12.443c2.913 2.14 3.883 2.723 3.883 5.053v68.243c0 4.277 -1.553 6.807 -6.99 7.193L24.467 99.967c-4.08 0.193 -6.023 -0.39 -8.16 -3.113L3.3 79.94c-2.333 -3.113 -3.3 -5.443 -3.3 -8.167V11.113c0 -3.497 1.553 -6.413 6.017 -6.8z" className="fill-[var(--surface-primary)]"/>
            <path fillRule="evenodd" clipRule="evenodd" d="M61.35 0.227l-55.333 4.087C1.553 4.7 0 7.617 0 11.113v60.66c0 2.724 0.967 5.053 3.3 8.167l13.007 16.913c2.137 2.723 4.08 3.307 8.16 3.113l64.257 -3.89c5.433 -0.387 6.99 -2.917 6.99 -7.193V20.64c0 -2.21 -0.873 -2.847 -3.443 -4.733L74.167 3.143c-4.273 -3.107 -6.02 -3.5 -12.817 -2.917zM25.92 19.523c-5.247 0.353 -6.437 0.433 -9.417 -1.99L8.927 11.507c-0.77 -0.78 -0.383 -1.753 1.557 -1.947l53.193 -3.887c4.467 -0.39 6.793 1.167 8.54 2.527l9.123 6.61c0.39 0.197 1.36 1.36 0.193 1.36l-54.933 3.307 -0.68 0.047zM19.803 88.3V30.367c0 -2.53 0.777 -3.697 3.103 -3.893L86 22.78c2.14 -0.193 3.107 1.167 3.107 3.693v57.547c0 2.53 -0.39 4.67 -3.883 4.863l-60.377 3.5c-3.493 0.193 -5.043 -0.97 -5.043 -4.083zm59.6 -54.827c0.387 1.75 0 3.5 -1.75 3.7l-2.91 0.577v42.773c-2.527 1.36 -4.853 2.137 -6.797 2.137 -3.107 0 -3.883 -0.973 -6.21 -3.887l-19.03 -29.94v28.967l6.02 1.363s0 3.5 -4.857 3.5l-13.39 0.777c-0.39 -0.78 0 -2.723 1.357 -3.11l3.497 -0.97v-38.3L30.48 40.667c-0.39 -1.75 0.58 -4.277 3.3 -4.473l14.367 -0.967 19.8 30.327v-26.83l-5.047 -0.58c-0.39 -2.143 1.163 -3.7 3.103 -3.89l13.4 -0.78z" className="fill-[var(--text-primary)]"/>
          </svg>
        </div>
      );
    }
    return (
      <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-[var(--border-default)] bg-[var(--surface-primary)]">
        <svg className="w-6 h-6" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M6.017 4.313l55.333 -4.087c6.797 -0.583 8.543 -0.19 12.817 2.917l17.663 12.443c2.913 2.14 3.883 2.723 3.883 5.053v68.243c0 4.277 -1.553 6.807 -6.99 7.193L24.467 99.967c-4.08 0.193 -6.023 -0.39 -8.16 -3.113L3.3 79.94c-2.333 -3.113 -3.3 -5.443 -3.3 -8.167V11.113c0 -3.497 1.553 -6.413 6.017 -6.8z" className="fill-[var(--surface-primary)]"/>
          <path fillRule="evenodd" clipRule="evenodd" d="M61.35 0.227l-55.333 4.087C1.553 4.7 0 7.617 0 11.113v60.66c0 2.724 0.967 5.053 3.3 8.167l13.007 16.913c2.137 2.723 4.08 3.307 8.16 3.113l64.257 -3.89c5.433 -0.387 6.99 -2.917 6.99 -7.193V20.64c0 -2.21 -0.873 -2.847 -3.443 -4.733L74.167 3.143c-4.273 -3.107 -6.02 -3.5 -12.817 -2.917zM25.92 19.523c-5.247 0.353 -6.437 0.433 -9.417 -1.99L8.927 11.507c-0.77 -0.78 -0.383 -1.753 1.557 -1.947l53.193 -3.887c4.467 -0.39 6.793 1.167 8.54 2.527l9.123 6.61c0.39 0.197 1.36 1.36 0.193 1.36l-54.933 3.307 -0.68 0.047zM19.803 88.3V30.367c0 -2.53 0.777 -3.697 3.103 -3.893L86 22.78c2.14 -0.193 3.107 1.167 3.107 3.693v57.547c0 2.53 -0.39 4.67 -3.883 4.863l-60.377 3.5c-3.493 0.193 -5.043 -0.97 -5.043 -4.083zm59.6 -54.827c0.387 1.75 0 3.5 -1.75 3.7l-2.91 0.577v42.773c-2.527 1.36 -4.853 2.137 -6.797 2.137 -3.107 0 -3.883 -0.973 -6.21 -3.887l-19.03 -29.94v28.967l6.02 1.363s0 3.5 -4.857 3.5l-13.39 0.777c-0.39 -0.78 0 -2.723 1.357 -3.11l3.497 -0.97v-38.3L30.48 40.667c-0.39 -1.75 0.58 -4.277 3.3 -4.473l14.367 -0.967 19.8 30.327v-26.83l-5.047 -0.58c-0.39 -2.143 1.163 -3.7 3.103 -3.89l13.4 -0.78z" className="fill-[var(--text-primary)]"/>
        </svg>
      </div>
    );
  }
  
  // 其他服务器显示首字母
  if (size === 'lg') {
    return (
      <div className="mcp-server-icon-lg flex h-20 w-20 items-center justify-center rounded-2xl border border-[var(--color-selected-border)] bg-[var(--color-accent-bg)] text-4xl font-bold text-[var(--color-accent)] shadow-lg shadow-[color:color-mix(in_srgb,var(--color-accent)_18%,transparent)]">
        {server.name.charAt(0).toUpperCase()}
      </div>
    );
  }
  return (
    <div className="mcp-server-icon flex h-10 w-10 items-center justify-center rounded-lg border border-[var(--color-selected-border)] bg-[var(--color-accent-bg)] text-lg font-bold text-[var(--color-accent)]">
      {server.name.charAt(0).toUpperCase()}
    </div>
  );
};

const MCPConfig: React.FC<MCPConfigProps> = () => {
  // MCP 服务器列表
  const [servers, setServers] = useState<MCPServerConfig[]>([]);
  const [loading, setLoading] = useState(true);

  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MCPServerConfig | null>(null);
  const [newServer, setNewServer] = useState<Partial<MCPServerConfig>>({
    name: '',
    url: '',
    type: 'http-stream',
    enabled: true,
    description: '',
    ext: {},
  });
  const [oauthHttpBusy, setOauthHttpBusy] = useState(false);
  const [notionAuthState, setNotionAuthState] = useState<'idle' | 'authenticating' | 'authenticated'>('idle');
  
  // Notion 工作空间选择和注册相关状态
  const [showWorkspaceSelection, setShowWorkspaceSelection] = useState(false);
  const [showRegistrationForm, setShowRegistrationForm] = useState(false);
  const [notionRegistrations, setNotionRegistrations] = useState<NotionRegistration[]>([]);
  const [registrationFormData, setRegistrationFormData] = useState({
    client_name: '',
    workspace_alias: '',  // 新增：工作空间别名（全局唯一）
    redirect_uri_base: getBackendUrl(),
  });
  const [isRegistering, setIsRegistering] = useState(false);

  // 测试连接状态
  const [testingServers, setTestingServers] = useState<Set<string>>(new Set());
  const [testResults, setTestResults] = useState<Map<string, { success: boolean; message: string; tools?: MCPTool[]; connected?: boolean }>>(new Map());

  // 已连接的客户端实例
  const [connectedClients, setConnectedClients] = useState<Map<string, MCPClient>>(new Map());

  // 新增：UI 状态
  const [selectedServerForDetail, setSelectedServerForDetail] = useState<MCPServerConfig | null>(null);
  const [showDetailModal, setShowDetailModal] = useState(false);

  // MCP OAuth 二维码弹窗：授权 URL 生成后展示二维码，用户可扫码或在浏览器中打开
  const [oauthQrDialogOpen, setOauthQrDialogOpen] = useState(false);
  const [oauthQrDataUrl, setOauthQrDataUrl] = useState<string | null>(null);
  const [oauthAuthorizationUrl, setOauthAuthorizationUrl] = useState<string | null>(null);

  // 清理连接的辅助函数
  const cleanupConnection = (serverId: string) => {
    const client = connectedClients.get(serverId);
    if (client) {
      client.disconnect().catch(err => console.error(`[MCP Config] Error disconnecting ${serverId}:`, err));
      setConnectedClients(prev => {
        const newMap = new Map(prev);
        newMap.delete(serverId);
        return newMap;
      });
    }
  };

  // 加载 MCP 服务器列表
  useEffect(() => {
    loadServers();
  }, []);

  // OAuth 回调现在由后端处理，不再需要前端处理

  const loadServers = async () => {
    try {
      const serverList = await getMCPServers();
      setServers(serverList);
    } catch (error) {
      console.error('Failed to load MCP servers:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleAddServer = async () => {
    if (!newServer.name || !newServer.url) {
      toast({ title: '名称和 URL 都是必需的', variant: 'destructive' });
      return;
    }

    try {
      await createMCPServer(buildMcpServerPayload(newServer));
      await loadServers(); // 重新加载列表
      setIsAdding(false);
      setNewServer({
        name: '',
        url: '',
        type: 'http-stream',
        enabled: true,
        description: '',
        ext: {},
      });
      toast({ title: 'MCP 服务器已添加', variant: 'success' });
    } catch (error) {
      console.error('Failed to create MCP server:', error);
      toast({
        title: '创建服务器失败',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    }
  };

  // Electron 已移除，stdio MCP 暂不支持

  // 加载 Notion 注册列表
  const loadNotionRegistrations = async (): Promise<NotionRegistration[]> => {
    try {
      const registrations = await getNotionRegistrations();
      setNotionRegistrations(registrations);
      return registrations;
    } catch (error) {
      console.error('[Notion] Failed to load registrations:', error);
      setNotionRegistrations([]);
      return [];
    }
  };

  // 使用已注册的工作空间进行 OAuth 授权
  const handleUseExistingWorkspace = async (registration: NotionRegistration) => {
    setShowWorkspaceSelection(false);
    
    // 检查是否已有对应的服务器配置
    const existingServer = servers.find(s => 
      s.ext?.server_type === 'notion' && 
      s.ext?.client_id === registration.client_id
    );
    
    if (existingServer) {
      // 如果服务器已存在，直接测试连接（后端会自动检查 token 并刷新）
      console.log('[Notion] Server exists, testing connection with existing token...');
      setNotionAuthState('authenticating');
      
      try {
        // 测试连接（后端会自动处理 token 检查和刷新）
        try {
          const result = await api.post<any>(`/api/mcp/servers/${existingServer.id}/test`);
          console.log('[Notion] ✅ Connection test successful:', result);
          setNotionAuthState('authenticated');
          await loadServers(); // 重新加载服务器列表
          alert('Notion MCP 服务器连接成功！');
          return;
        } catch (error: any) {
          console.log('[Notion] Connection test failed:', error);

          // 如果明确需要 OAuth（token 不存在或无效），走 OAuth 流程
          if (error?.requires_oauth || error?.code === 401 || /401/.test(String(error?.message || ''))) {
            console.log('[Notion] OAuth required, starting OAuth flow...');
            await performNotionOAuth(registration.client_id);
          } else {
            // 其他错误（如网络错误），提示用户
            alert('连接失败: ' + ((error && (error.error || error.message)) || '未知错误'));
            setNotionAuthState('idle');
          }
        }
      } catch (error) {
        console.error('[Notion] Connection test error:', error);
        // 如果测试失败，走 OAuth 流程
        await performNotionOAuth(registration.client_id);
      }
    } else {
      // 如果服务器不存在，走 OAuth 流程
      await performNotionOAuth(registration.client_id);
    }
  };

  // 处理 Notion OAuth 连接（入口函数）
  const handleNotionOAuthConnect = async () => {
    // 先加载已注册的工作空间列表
    const registrations = await loadNotionRegistrations();
    
    // 如果有已注册的工作空间，显示选择对话框
    if (registrations.length > 0) {
      setShowWorkspaceSelection(true);
      return;
    }
    
    // 如果没有已注册的工作空间，直接显示注册表单
    setShowRegistrationForm(true);
  };

  // 处理注册新工作空间
  const handleRegisterNotion = async () => {
    if (!registrationFormData.client_name.trim()) {
      alert('请输入客户端名称（Client Name）');
      return;
    }

    if (!registrationFormData.workspace_alias.trim()) {
      alert('请输入工作空间别名（Workspace Alias）');
      return;
    }

    // 验证 client_name：只允许英文、数字、下划线、连字符
    const clientNamePattern = /^[a-zA-Z0-9_-]+$/;
    if (!clientNamePattern.test(registrationFormData.client_name)) {
      alert('客户端名称只能包含英文、数字、下划线和连字符');
      return;
    }

    // 验证 workspace_alias：只允许英文、数字、下划线、连字符
    const workspaceAliasPattern = /^[a-zA-Z0-9_-]+$/;
    if (!workspaceAliasPattern.test(registrationFormData.workspace_alias)) {
      alert('工作空间别名只能包含英文、数字、下划线和连字符');
      return;
    }

    setIsRegistering(true);
    try {
      const result = await registerNotionClient({
        client_name: registrationFormData.client_name.trim(),
        workspace_alias: registrationFormData.workspace_alias.trim(),
        redirect_uri_base: registrationFormData.redirect_uri_base.trim() || getBackendUrl(),
      });

      console.log('[Notion] Registration successful:', result);
      console.log('[Notion] Workspace Alias:', result.workspace_alias);
      console.log('[Notion] Short Hash:', result.short_hash);
      console.log('[Notion] Dynamic Redirect URI:', result.redirect_uri);
      
      // 重新加载注册列表
      await loadNotionRegistrations();
      
      // 关闭注册表单，使用新注册的 client_id 进行 OAuth 授权
      setShowRegistrationForm(false);
      setRegistrationFormData({ client_name: '', workspace_alias: '', redirect_uri_base: getBackendUrl() });
      
      // 使用新注册的 client_id 进行 OAuth 授权
      await performNotionOAuth(result.client_id);
    } catch (error) {
      console.error('[Notion] Registration failed:', error);
      alert('注册失败: ' + (error instanceof Error ? error.message : String(error)));
    } finally {
      setIsRegistering(false);
    }
  };

  // 处理删除 Notion 工作空间注册
  const handleDeleteNotionRegistration = async (registration: NotionRegistration, event: React.MouseEvent) => {
    // 阻止事件冒泡，防止触发父级的点击事件（连接工作空间）
    event.stopPropagation();
    
    const confirmMessage = `确定要删除工作空间 "${registration.client_name}" 吗？\n\n这将删除注册信息和相关的访问令牌。`;
    
    if (!confirm(confirmMessage)) {
      return;
    }

    try {
      console.log(`[Notion] Deleting registration: ${registration.id}`);
      const result = await deleteNotionRegistration(registration.id);
      console.log('[Notion] Delete result:', result);
      
      toast({
        title: '删除成功',
        description: result.message || `工作空间 "${registration.client_name}" 已删除`,
        variant: 'success',
      });
      
      // 重新加载注册列表
      await loadNotionRegistrations();
    } catch (error) {
      console.error('[Notion] Delete failed:', error);
      toast({
        title: '删除失败',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    }
  };

  // 执行 Notion OAuth 授权（使用指定的 client_id）
  const performNotionOAuth = async (clientId: string) => {
    try {
      setNotionAuthState('authenticating');
      
      const mcpUrl = 'https://mcp.notion.com/mcp';  // MCP 服务器 URL
      
      // 1. 发现 OAuth 配置
      console.log('[Notion OAuth] Discovering OAuth configuration...');
      const discovery = await discoverMCPOAuth('https://mcp.notion.com');
      console.log('[Notion OAuth] OAuth discovery result:', discovery);
      
      console.log('[Notion OAuth] Using Client ID:', clientId);
      
      // 2. 生成授权 URL（配置会保存到 Redis，回调地址为后端端点）
      console.log('[Notion OAuth] Generating authorization URL...');
      const authorizeResult = await authorizeMCPOAuth({
        authorization_endpoint: discovery.authorization_server.authorization_endpoint,
        client_id: clientId,
        resource: discovery.resource,
        code_challenge_methods_supported: discovery.authorization_server.code_challenge_methods_supported,
        token_endpoint: discovery.authorization_server.token_endpoint,
        client_secret: '', // Notion MCP 不需要 client_secret
        token_endpoint_auth_methods_supported: discovery.authorization_server.token_endpoint_auth_methods_supported,
        mcp_url: mcpUrl,  // 传递 MCP URL，用于保存 token
      });
      
      console.log('[Notion OAuth] Got authorization URL');
      console.log('[Notion OAuth] Client ID:', authorizeResult.client_id);
      console.log('[Notion OAuth] State:', authorizeResult.state);
      console.log('[Notion OAuth] OAuth config saved to Redis by backend');
      console.log('[Notion OAuth] Callback URL:', `${getBackendUrl()}/mcp/oauth/callback`);

      // 3. 生成二维码并在前端弹窗中展示，用户可扫码或在浏览器中打开
      try {
        const qrDataUrl = await QRCode.toDataURL(authorizeResult.authorization_url, { width: 260, margin: 2 });
        setOauthQrDataUrl(qrDataUrl);
        setOauthAuthorizationUrl(authorizeResult.authorization_url);
        setOauthQrDialogOpen(true);
      } catch (qrErr) {
        console.warn('[Notion OAuth] QR code generation failed, falling back to browser only:', qrErr);
        setOauthAuthorizationUrl(authorizeResult.authorization_url);
        setOauthQrDialogOpen(true);
      }

      // 轮询检查后端是否已完成 token 交换
      try {
        console.log('[Notion OAuth] Polling for token completion...');
        const maxAttempts = 60; // 最多等待60秒
        const pollInterval = 1000; // 每秒检查一次
        let tokenExchangeCompleted = false;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          await new Promise(resolve => setTimeout(resolve, pollInterval));
          
          // 检查后端是否已完成 token 交换
          // 通过尝试创建服务器配置来验证 token 是否已保存
          try {
            // 先检查是否已有对应工作空间（按 client_id 匹配）的服务器配置
            const existingServers = await getMCPServers();
            const registration = notionRegistrations.find(r => r.client_id === authorizeResult.client_id);
            const workspaceName = registration?.client_name || 'Notion';

            const existingServer =
              existingServers.find(
                s => s.ext?.server_type === 'notion' && s.ext?.client_id === authorizeResult.client_id
              ) ||
              existingServers.find(
                s =>
                  s.url === mcpUrl &&
                  s.ext?.server_type === 'notion' &&
                  (!s.ext?.client_id || s.ext?.client_id === '')
              );
            
            if (existingServer) {
              // 如果服务器已存在，更新它（写回工作空间名 + client_id）
              console.log('[Notion OAuth] Server config already exists, updating...');
              await updateMCPServer(existingServer.id, {
                name: workspaceName,
                display_name: workspaceName,
                client_name: workspaceName,
                description: `Notion MCP Server - ${workspaceName}`,
                ext: {
                  ...existingServer.ext,
                  server_type: 'notion',
                  client_id: authorizeResult.client_id,
                  client_name: workspaceName,
                  response_format: 'sse',  // Notion MCP 使用 SSE 格式响应
                },
              });
              await loadServers();
              console.log('[Notion OAuth] ✅ Server config updated');
            } else {
              // 创建新的服务器配置
              await createNotionServerFromRedis(mcpUrl, authorizeResult.client_id);
              console.log('[Notion OAuth] ✅ Server config created');
            }
            tokenExchangeCompleted = true;
            setOauthQrDialogOpen(false);
            setOauthQrDataUrl(null);
            setOauthAuthorizationUrl(null);
            setNotionAuthState('authenticated');
            setShowWorkspaceSelection(false);
            setShowRegistrationForm(false);
            alert('Notion MCP 服务器配置成功！Token 已保存到服务器。');
            return; // 成功，退出循环
            
          } catch (error: any) {
            // 如果错误是因为 token 不存在或服务器配置问题，继续等待
            const errorMessage = error.message || String(error);
            if (errorMessage.includes('token') || 
                errorMessage.includes('Token') ||
                errorMessage.includes('未找到') ||
                errorMessage.includes('not found')) {
              console.log(`[Notion OAuth] Waiting for token exchange... (attempt ${attempt + 1}/${maxAttempts})`);
              continue;
            }
            // 其他错误（如网络错误），也继续等待，可能是暂时的
            if (attempt < maxAttempts - 1) {
              console.log(`[Notion OAuth] Error (will retry):`, errorMessage);
              continue;
            }
            // 最后一次尝试失败，抛出错误
            throw error;
          }
        }
        
        // 超时
        if (!tokenExchangeCompleted) {
          throw new Error('授权超时，请检查是否已在浏览器中完成授权');
        }
        
      } catch (error) {
        console.error('[Notion OAuth] Authorization failed:', error);
        setNotionAuthState('idle');
        setOauthQrDialogOpen(false);
        setOauthQrDataUrl(null);
        setOauthAuthorizationUrl(null);
        if (error instanceof Error && error.message === 'Authorization cancelled by user') {
          alert('授权已取消');
        } else {
          alert('Notion OAuth 授权失败: ' + (error instanceof Error ? error.message : String(error)));
        }
        return;
      }
      
    } catch (error) {
      console.error('[Notion OAuth] Error:', error);
      setNotionAuthState('idle');
      setOauthQrDialogOpen(false);
      setOauthQrDataUrl(null);
      setOauthAuthorizationUrl(null);
      if (error instanceof Error && error.message === 'Authorization cancelled by user') {
        alert('授权已取消');
      } else {
        alert('启动 Notion OAuth 失败: ' + (error instanceof Error ? error.message : String(error)));
      }
    }
  };
  
  // 从 Redis 创建 Notion 服务器配置（token 已由后端保存到 Redis）
  const createNotionServerFromRedis = async (mcpUrl: string, clientId: string) => {
    try {
      console.log('[Notion OAuth] Creating server config (token already in Redis)...');
      console.log('[Notion OAuth] Client ID:', clientId);
      
      // 从注册信息中获取 client_name（用于显示）
      const registration = notionRegistrations.find(r => r.client_id === clientId);
      const displayName = registration?.client_name || 'Notion';
      
      // 创建 Notion MCP 服务器配置
      // Token 已保存在 Redis，MCP 代理会自动从 Redis 获取并刷新
      const notionServerConfig: Partial<MCPServerConfig> = {
        name: displayName,  // 使用 client_name 作为显示名称
        display_name: displayName,
        client_name: displayName,
        url: mcpUrl,
        type: 'http-stream',
        enabled: true,
        use_proxy: true,
        description: `Notion MCP Server - ${displayName}`,
        metadata: {
          headers: {
            // Authorization header 会由 MCP 代理从 Redis 自动获取
            'Notion-Version': '2022-06-28',
          },
        },
        ext: {
          server_type: 'notion',  // 标记为 notion 服务器，触发 token 自动刷新
          client_id: clientId,  // 保存 Client ID，用于关联 token
          client_name: displayName,  // 保存 client_name，用于显示
          response_format: 'sse',  // Notion MCP 使用 SSE 格式响应
        },
      };
      
      await createMCPServer(notionServerConfig);
      await loadServers();
      
      setNotionAuthState('authenticated');
      alert('Notion MCP 服务器配置成功！Token 已保存到服务器。');
      
    } catch (error) {
      console.error('[Notion OAuth] Error creating server config:', error);
      setNotionAuthState('idle');
      throw error;
    }
  };

  /** 通用 HTTP OAuth MCP：发现 →（动态注册 client）→ 授权页/二维码 → 轮询 token 落库 */
  const runHttpOAuthAuthorization = async (mcpUrlRaw: string) => {
    const mcpUrl = mcpUrlRaw.trim();
    if (!mcpUrl) {
      throw new Error('MCP URL 不能为空');
    }
    setOauthHttpBusy(true);
    try {
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
      try {
        const qrDataUrl = await QRCode.toDataURL(authorizeResult.authorization_url, { width: 260, margin: 2 });
        setOauthQrDataUrl(qrDataUrl);
      } catch {
        setOauthQrDataUrl(null);
      }
      setOauthAuthorizationUrl(authorizeResult.authorization_url);
      setOauthQrDialogOpen(true);

      const norm = mcpUrl.replace(/\/$/, '');
      for (let attempt = 0; attempt < 60; attempt++) {
        await new Promise((r) => setTimeout(r, 1000));
        const { has_token } = await getMCPOAuthTokenStatus(norm);
        if (has_token) {
          setOauthQrDialogOpen(false);
          setOauthQrDataUrl(null);
          setOauthAuthorizationUrl(null);
          return;
        }
      }
      setOauthQrDialogOpen(false);
      setOauthQrDataUrl(null);
      setOauthAuthorizationUrl(null);
      throw new Error('授权超时，请检查是否已在浏览器中完成授权');
    } finally {
      setOauthHttpBusy(false);
    }
  };

  const handleAddHttpOAuthAndAuthorize = async () => {
    if (!newServer.name?.trim() || !newServer.url?.trim()) {
      toast({ title: '请填写名称和 URL', variant: 'destructive' });
      return;
    }
    try {
      await runHttpOAuthAuthorization(newServer.url.trim());
      await createMCPServer(buildMcpServerPayload({ ...newServer, type: 'http-oauth' }));
      await loadServers();
      setIsAdding(false);
      setNewServer({
        name: '',
        url: '',
        type: 'http-stream',
        enabled: true,
        description: '',
        ext: {},
      });
      toast({ title: 'HTTP OAuth MCP 已添加', description: 'Token 已保存，可连接测试', variant: 'success' });
    } catch (e) {
      console.error('[HTTP OAuth MCP]', e);
      toast({
        title: '添加失败',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    }
  };

  const handleReauthorizeHttpOAuth = async (server: MCPServerConfig) => {
    try {
      await runHttpOAuthAuthorization(server.url.trim());
      toast({ title: 'OAuth 授权已更新', variant: 'success' });
    } catch (e) {
      console.error('[HTTP OAuth MCP]', e);
      toast({
        title: '授权失败',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    }
  };

  const handleEditServer = (serverId: string) => {
    const server = servers.find(s => s.id === serverId);
    if (server) {
      setNewServer(serverToFormState(server));
      setEditingId(serverId);
    }
  };

  const handleUpdateServer = async () => {
    if (!editingId || !newServer.name || !newServer.url) {
      toast({ title: '名称和 URL 都是必需的', variant: 'destructive' });
      return;
    }

    try {
      await updateMCPServer(editingId, buildMcpServerPayload(newServer));
      await loadServers(); // 重新加载列表
      setEditingId(null);
      setNewServer({
        name: '',
        url: '',
        type: 'http-stream',
        enabled: true,
        description: '',
        ext: {},
      });
      toast({ title: 'MCP 服务器已保存', variant: 'success' });
    } catch (error) {
      console.error('Failed to update MCP server:', error);
      toast({
        title: '更新服务器失败',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    }
  };

  const handleDeleteServer = async (serverId: string) => {
    try {
      await deleteMCPServer(serverId);
      await loadServers(); // 重新加载列表
      setTestResults(prev => {
        const newResults = new Map(prev);
        newResults.delete(serverId);
        return newResults;
      });
      toast({ title: 'MCP 服务器已删除', variant: 'success' });
    } catch (error) {
      console.error('Failed to delete MCP server:', error);
      toast({
        title: '删除服务器失败',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    }
  };

  const handleTestConnection = async (server: MCPServerConfig): Promise<MCPClient | null> => {
    setTestingServers(prev => new Set(prev).add(server.id));

    try {
      console.log(`[MCP Config] Testing connection to ${server.name} (${server.url})`);
      console.log(`[MCP Config] Server metadata:`, JSON.stringify(server.metadata, null, 2));

      // stdio MCP 不支持（需要后端实现）
      if (server.type === 'stdio') {
        throw new Error('stdio MCP 暂不支持，请使用 HTTP 方式的 MCP 服务器');
      }
      
      // 检查metadata中的headers
      if (server.metadata?.headers) {
        const authHeader = server.metadata.headers.Authorization;
        if (authHeader) {
          console.log(`[MCP Config] Authorization header present:`, authHeader.substring(0, 30) + '...');
          console.log(`[MCP Config] Authorization header length:`, authHeader.length);
        } else {
          console.warn(`[MCP Config] ⚠️ No Authorization header in metadata.headers`);
        }
      } else {
        console.warn(`[MCP Config] ⚠️ No metadata.headers found`);
      }

      // 清理之前的连接（如果存在）
      cleanupConnection(server.id);

      // 创建 MCP 客户端实例
      const testClient = new MCPClient({
        server: {
          id: server.id,
          name: server.name,
          url: server.url,
          type: server.type,
          enabled: server.enabled,
          description: server.description,
          metadata: server.metadata,
          ext: server.ext, // 传递扩展配置（包括 response_format, server_type 等）
        },
      });

      // 建立连接并保持
      console.log(`[MCP Config] Starting MCP client connection test`);
      const connectStart = Date.now();
      await testClient.connect();
      const connectTime = Date.now() - connectStart;
      console.log(`[MCP Config] Connection completed in ${connectTime}ms, keeping connection alive`);

      // 保存连接的客户端实例
      setConnectedClients(prev => new Map(prev).set(server.id, testClient));

      // 自动拉取工具列表，保持与其他 MCP 一致的展示体验
      let tools: MCPTool[] | undefined = undefined;
      try {
        // 首次连接后强制拉取，避免命中空缓存导致“看起来没有请求”
        tools = await testClient.listTools(true);
      } catch (toolsError) {
        console.warn(`[MCP Config] Auto fetch tools failed for ${server.name}:`, toolsError);
      }

      setTestResults(prev => new Map(prev).set(server.id, {
        success: true,
        message: tools
          ? `连接成功，发现 ${tools.length} 个工具`
          : `连接成功 (${connectTime}ms)`,
        connected: true,
        tools,
      }));
      return testClient;

    } catch (error) {
      console.error(`[MCP Config] Test connection error:`, error);

      let errorMessage = `连接错误: ${error instanceof Error ? error.message : String(error)}`;

      // 特殊处理 MCP 协议错误
      if (error instanceof Error && (
        error.message.includes('CORS') ||
        error.message.includes('跨域') ||
        error.message.includes('Failed to fetch')
      )) {
        errorMessage = `跨域访问受限。如在浏览器中使用，请确保 MCP 服务器支持 CORS`;
      }

      setTestResults(prev => new Map(prev).set(server.id, {
        success: false,
        message: errorMessage,
        connected: false,
      }));
      return null;
    } finally {
      setTestingServers(prev => {
        const newSet = new Set(prev);
        newSet.delete(server.id);
        return newSet;
      });
    }
  };

  const handleFetchTools = async (server: MCPServerConfig) => {
    setTestingServers(prev => new Set(prev).add(server.id));

    try {
      // 先走后端测试接口（稳定，不依赖前端 session-id）
      console.log(`[MCP Config] Fetching tools via backend test API: ${server.id}`);
      try {
        const data = await api.post<any>(`/api/mcp/servers/${server.id}/test`);
        const tools: MCPTool[] = Array.isArray(data?.tools) ? data.tools : [];
        setTestResults(prev => new Map(prev).set(server.id, {
          success: true,
          connected: true,
          tools,
          message: `连接成功，发现 ${tools.length} 个工具`,
        }));
        return;
      } catch (backendApiError) {
        console.warn('[MCP Config] Backend test API exception, fallback to client flow:', backendApiError);
      }

      let connectedClient = connectedClients.get(server.id);

      if (!connectedClient) {
        console.log(`[MCP Config] Server not connected, testing first...`);
        const createdClient = await handleTestConnection(server);
        if (!createdClient) {
          toast({ title: '连接失败，无法获取工具', variant: 'destructive' });
          return;
        }
        connectedClient = createdClient;
      }

      console.log(`[MCP Config] Fetching tools for ${server.name} (${server.url}) using existing connection`);
      console.log(`[MCP Config] Client state:`, {
        isInitialized: connectedClient.isInitialized,
        serverInfo: connectedClient.getServerInfo(),
      });

      // 确保客户端已完全初始化
      if (!connectedClient.isInitialized) {
        console.log(`[MCP Config] Client not fully initialized, attempting to reconnect...`);
        try {
          await connectedClient.connect();
          console.log(`[MCP Config] Client reconnected successfully`);
        } catch (reconnectError) {
          console.error(`[MCP Config] Failed to reconnect:`, reconnectError);
          throw new Error(`客户端未初始化且重连失败: ${reconnectError instanceof Error ? reconnectError.message : String(reconnectError)}`);
        }
      }

      // 额外等待确保服务器完全准备好
      // 根据 MCP Inspector 的流程，initialize 返回 202 Accepted（异步）
      // 响应通过 SSE 流返回，需要额外时间
      // 即使连接时已经等待，服务器可能还需要额外时间完成初始化
      console.log(`[MCP Config] Waiting for server to be ready before fetching tools...`);
      console.log(`[MCP Config] Note: Server may need additional time after initialize (202 Accepted) and notifications/initialized`);
      await new Promise(resolve => setTimeout(resolve, 3000)); // 增加到 3000ms

      // 使用已连接的客户端实例获取工具列表
      console.log(`[MCP Config] Fetching tools list from existing connection`);
      const toolsStart = Date.now();
      const tools = await connectedClient.listTools(true);
      const toolsTime = Date.now() - toolsStart;
      console.log(`[MCP Config] Tools fetched in ${toolsTime}ms`);

      const toolCount = tools.length;
      console.log(`[MCP Config] Retrieved ${toolCount} tools:`, tools);

      setTestResults(prev => {
        const existing = prev.get(server.id) || { success: true, message: '', connected: true };
        return new Map(prev).set(server.id, {
          ...existing,
          tools: tools,
          message: `连接成功，发现 ${toolCount} 个工具`,
        });
      });

    } catch (error) {
      console.error(`[MCP Config] Fetch tools error:`, error);
      console.error(`[MCP Config] Error stack:`, error instanceof Error ? error.stack : 'No stack trace');

      let errorMessage = `获取工具失败: ${error instanceof Error ? error.message : String(error)}`;

      // 特殊处理 MCP 协议错误
      if (error instanceof Error) {
        if (error.message.includes('invalid during session initialization')) {
          errorMessage = `MCP 协议错误: 服务器可能仍在初始化阶段，请稍后重试`;
        } else if (error.message.includes('not connected')) {
          errorMessage = `连接已断开，请重新测试连接`;
        } else if (error.message.includes('timeout')) {
          errorMessage = `请求超时，请检查网络连接或稍后重试`;
        }
      }

      setTestResults(prev => {
        const existing = prev.get(server.id) || { success: false, message: '', connected: false };
        return new Map(prev).set(server.id, {
          ...existing,
          message: errorMessage,
        });
      });
    } finally {
      setTestingServers(prev => {
        const newSet = new Set(prev);
        newSet.delete(server.id);
        return newSet;
      });
    }
  };

  const handleViewDetail = (server: MCPServerConfig) => {
    setSelectedServerForDetail(server);
    setShowDetailModal(true);
  };

  const cancelEdit = () => {
    setIsAdding(false);
    setEditingId(null);
    setNewServer({
      name: '',
      url: '',
      type: 'http-stream',
      enabled: true,
      description: '',
      ext: {},
    });
  };

  return (
    <div className="mcp-entry-page h-full flex flex-col bg-[var(--surface-primary)]">
      <div className="flex-1 overflow-y-auto no-scrollbar app-pane-pad">
        <div className="max-w-6xl mx-auto w-full space-y-3">
          <div className="app-card-item app-card-pad-sm flex flex-col items-stretch justify-between gap-3 sm:flex-row sm:items-center">
            <div className="flex items-center gap-2 min-w-0">
              <Plug className="w-5 h-5 text-[var(--color-accent)] flex-shrink-0" />
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-[var(--text-primary)] truncate">MCP 录入</h2>
                <p className="text-xs text-[var(--text-muted)] truncate">
                  管理 MCP 服务端点，支持 Notion、HTTP Stream 与 OAuth 模式
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 sm:flex-shrink-0">
              <Button variant="outline" size="sm" className="h-8 flex-1 sm:flex-none" onClick={() => loadServers()} disabled={loading}>
                <RefreshCcw className={`w-3.5 h-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
                刷新
              </Button>
              <Button
                variant="primary"
                size="sm"
                className="h-8 flex-1 sm:flex-none"
                onClick={() => {
                  cancelEdit();
                  setIsAdding(true);
                }}
              >
                <Plus className="w-3.5 h-3.5 mr-1.5" />
                新增
              </Button>
            </div>
          </div>
          <div className="app-card-item app-card-pad-sm space-y-3">
            <div
              className="app-card-item app-card-pad-sm cursor-pointer mcp-notion-card"
              onClick={() => {
                cancelEdit();
                handleNotionOAuthConnect();
              }}
            >
              <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 bg-transparent rounded-lg flex items-center justify-center">
                    <svg className="w-6 h-6" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M6.017 4.313l55.333 -4.087c6.797 -0.583 8.543 -0.19 12.817 2.917l17.663 12.443c2.913 2.14 3.883 2.723 3.883 5.053v68.243c0 4.277 -1.553 6.807 -6.99 7.193L24.467 99.967c-4.08 0.193 -6.023 -0.39 -8.16 -3.113L3.3 79.94c-2.333 -3.113 -3.3 -5.443 -3.3 -8.167V11.113c0 -3.497 1.553 -6.413 6.017 -6.8z" className="fill-[var(--surface-elevated)]" />
                      <path fillRule="evenodd" clipRule="evenodd" d="M61.35 0.227l-55.333 4.087C1.553 4.7 0 7.617 0 11.113v60.66c0 2.724 0.967 5.053 3.3 8.167l13.007 16.913c2.137 2.723 4.08 3.307 8.16 3.113l64.257 -3.89c5.433 -0.387 6.99 -2.917 6.99 -7.193V20.64c0 -2.21 -0.873 -2.847 -3.443 -4.733L74.167 3.143c-4.273 -3.107 -6.02 -3.5 -12.817 -2.917zM25.92 19.523c-5.247 0.353 -6.437 0.433 -9.417 -1.99L8.927 11.507c-0.77 -0.78 -0.383 -1.753 1.557 -1.947l53.193 -3.887c4.467 -0.39 6.793 1.167 8.54 2.527l9.123 6.61c0.39 0.197 1.36 1.36 0.193 1.36l-54.933 3.307 -0.68 0.047zM19.803 88.3V30.367c0 -2.53 0.777 -3.697 3.103 -3.893L86 22.78c2.14 -0.193 3.107 1.167 3.107 3.693v57.547c0 2.53 -0.39 4.67 -3.883 4.863l-60.377 3.5c-3.493 0.193 -5.043 -0.97 -5.043 -4.083zm59.6 -54.827c0.387 1.75 0 3.5 -1.75 3.7l-2.91 0.577v42.773c-2.527 1.36 -4.853 2.137 -6.797 2.137 -3.107 0 -3.883 -0.973 -6.21 -3.887l-19.03 -29.94v28.967l6.02 1.363s0 3.5 -4.857 3.5l-13.39 0.777c-0.39 -0.78 0 -2.723 1.357 -3.11l3.497 -0.97v-38.3L30.48 40.667c-0.39 -1.75 0.58 -4.277 3.3 -4.473l14.367 -0.967 19.8 30.327v-26.83l-5.047 -0.58c-0.39 -2.143 1.163 -3.7 3.103 -3.89l13.4 -0.78z" className="fill-[var(--text-primary)]" />
                    </svg>
                  </div>
                  <div className="min-w-0">
                    <div className="mcp-notion-card-title text-sm font-medium text-[var(--text-primary)]">Notion 官方 MCP</div>
                    <div className="mcp-notion-card-desc text-xs text-[var(--text-secondary)] truncate">点击录入 Notion 工作区</div>
                  </div>
                </div>
                <div className="mcp-notion-card-action self-end text-xs text-[var(--color-accent)] sm:self-auto">连接</div>
              </div>
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-16 text-[var(--text-muted)]">
                <Loader className="w-6 h-6 animate-spin mr-2" />
                加载中…
              </div>
            ) : servers.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center max-w-md mx-auto">
                <Server className="w-10 h-10 text-[var(--text-muted)] mb-3 opacity-60" />
                <p className="text-sm text-[var(--text-secondary)]">暂无服务器</p>
                <p className="text-xs text-[var(--text-muted)] mt-1">点击右上角「新增」录入 MCP 服务器</p>
              </div>
            ) : (
              <div className="app-card-grid">
                {servers.map((server) => (
                  <div
                    key={server.id}
                    className="app-card-item app-card-pad-sm cursor-pointer"
                    onClick={() => handleViewDetail(server)}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 min-w-0">
                          {renderServerIcon(server, 'sm')}
                          <div className="text-sm font-medium text-[var(--text-primary)] truncate">
                            {(server as any).display_name || (server as any).client_name || server.name}
                          </div>
                        </div>
                        <p className="text-xs text-[var(--text-secondary)] mt-2 truncate">{server.url}</p>
                        <div className="flex items-center gap-2 mt-2">
                          <span className="inline-flex items-center rounded border border-[var(--border-default)] bg-[var(--surface-secondary)] px-2 py-0.5 text-[10px] font-medium uppercase text-[var(--text-secondary)]">
                            {displayMcpServerType(server)}
                          </span>
                          <span className={`text-[10px] ${server.enabled ? 'text-[var(--color-accent)]' : 'text-[var(--text-muted)]'}`}>
                            {server.enabled ? '已启用' : '已禁用'}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          title="测试连接"
                          onClick={(e) => { e.stopPropagation(); void handleTestConnection(server); }}
                        >
                          <RefreshCcw className={`w-4 h-4 ${testingServers.has(server.id) ? 'animate-spin' : ''}`} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          title="编辑"
                          onClick={(e) => { e.stopPropagation(); handleEditServer(server.id); }}
                        >
                          <Edit2 className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 text-[var(--color-secondary)]"
                          title="删除"
                          onClick={(e) => { e.stopPropagation(); setDeleteTarget(server); }}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 新增/编辑自定义服务器弹框 */}
      <Dialog
        open={Boolean(isAdding || editingId)}
        onOpenChange={(open) => {
          if (!open) cancelEdit();
        }}
      >
        <DialogContent className="chatee-dialog-standard mcp-dialog max-w-2xl border-[var(--border-default)] bg-[var(--surface-primary)] text-[var(--text-primary)]">
          <DialogHeader>
            <DialogTitle>{editingId ? '编辑服务器' : '新增服务器'}</DialogTitle>
            <DialogDescription className="text-[var(--text-secondary)]">
              填写名称、地址与类型。HTTP Stream / HTTP POST 仅直连 JSON-RPC，不会访问 OAuth well-known；只有选「HTTP OAuth」时服务端才会做 OAuth 发现。若 Chaya 后端在 Docker 内而 MCP 跑在宿主机，请把 localhost 换成 host.docker.internal（或宿主机 IP），或设置环境变量 CHAYA_MCP_LOCALHOST_REWRITE。
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-4">
              <InputField
                label="名称"
                required
                inputProps={{
                  id: 'mcp-server-name',
                  value: newServer.name || '',
                  onChange: (e) => setNewServer(prev => ({ ...prev, name: e.target.value })),
                  placeholder: '例如: my-mcp-server',
                }}
              />
              <InputField
                label="URL"
                required
                inputProps={{
                  id: 'mcp-server-url',
                  value: newServer.url || '',
                  onChange: (e) => setNewServer(prev => ({ ...prev, url: e.target.value })),
                  placeholder: 'http://localhost:8080/mcp',
                }}
              />
              <p className="-mt-2 text-xs text-[var(--text-muted)]">
                本地 MCP 常见为 Streamable HTTP（SSE）响应，引擎已支持解析。连接仍由后端发起：若添加成功但工具拉取失败，请检查后端能否访问该 URL（Docker 内勿用 localhost 指宿主机）。
              </p>
            </div>
            <div className="space-y-4">
              <div>
                <Label className="mb-1 block text-sm font-medium text-[var(--text-primary)]">类型</Label>
                <Select
                  value={newServer.type || 'http-stream'}
                  onValueChange={(v) =>
                    setNewServer((prev) => ({ ...prev, type: v as MCPServerConfig['type'] }))
                  }
                >
                  <SelectTrigger className="border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-primary)] focus:border-[var(--color-accent)]"><SelectValue /></SelectTrigger>
                  <SelectContent className="border-[var(--border-default)] bg-[var(--surface-overlay)] text-[var(--text-primary)]">
                    <SelectItem value="http-stream">HTTP Stream</SelectItem>
                    <SelectItem value="http-oauth">HTTP OAuth</SelectItem>
                    <SelectItem value="http-post">HTTP POST</SelectItem>
                    <SelectItem value="stdio">Stdio</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <TextareaField
                label="描述"
                textareaProps={{
                  id: 'mcp-server-description',
                  value: newServer.description || '',
                  onChange: (e) => setNewServer(prev => ({ ...prev, description: e.target.value })),
                  placeholder: '可选描述...',
                  rows: 3,
                }}
              />
            </div>
          </div>

          <DialogFooter className="flex flex-col sm:flex-row gap-2 sm:justify-end sm:flex-wrap">
            <Button variant="secondary" onClick={cancelEdit} className="niho-close-pink" disabled={oauthHttpBusy}>
              取消
            </Button>
            {editingId && newServer.type === 'http-oauth' && (
              <Button
                variant="secondary"
                onClick={() => {
                  const s = servers.find((x) => x.id === editingId);
                  if (s) void handleReauthorizeHttpOAuth(s);
                }}
                disabled={oauthHttpBusy}
                className="border-[var(--border-default)] bg-[var(--surface-primary)] text-[var(--text-primary)] hover:bg-[var(--color-hover-bg)]"
              >
                <Key className="w-4 h-4 mr-1.5 inline" />
                OAuth 重新授权
              </Button>
            )}
            {!editingId && newServer.type === 'http-oauth' ? (
              <>
                <Button variant="secondary" onClick={handleAddServer} disabled={oauthHttpBusy}>
                  立即创建
                </Button>
                <Button
                  variant="primary"
                  onClick={handleAddHttpOAuthAndAuthorize}
                  disabled={oauthHttpBusy}
                  className="border-0 bg-[var(--color-accent)] text-[var(--text-on-accent)] hover:bg-[var(--color-accent-hover)]"
                >
                  {oauthHttpBusy ? '授权中…' : '创建并授权'}
                </Button>
              </>
            ) : (
              <Button
                variant="primary"
                onClick={editingId ? handleUpdateServer : handleAddServer}
                disabled={oauthHttpBusy}
                className="border-0 bg-[var(--color-accent)] text-[var(--text-on-accent)] hover:bg-[var(--color-accent-hover)]"
              >
                {editingId ? '保存修改' : '立即创建'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 服务器详情弹窗 (明信片样式) */}
      <Dialog open={showDetailModal} onOpenChange={setShowDetailModal}>
        <DialogContent className="mcp-detail-dialog max-w-4xl overflow-hidden border-[var(--border-default)] bg-[var(--surface-primary)] p-0 text-[var(--text-primary)] shadow-2xl">
          {selectedServerForDetail && (
            <div className="flex h-[min(78vh,600px)] flex-col md:h-[600px] md:flex-row">
              {/* 左侧：详情 (明信片正面) */}
              <div className="mcp-detail-left flex flex-1 flex-col border-b border-[var(--border-default)] p-4 sm:p-6 md:border-b-0 md:border-r md:p-8">
                <div className="flex items-start justify-between mb-8">
                  {renderServerIcon(selectedServerForDetail, 'lg')}
                  <div className="text-right">
                    <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)]">Server ID</div>
                    <div className="text-xs font-mono text-[var(--text-secondary)]">{selectedServerForDetail.id.substring(0, 8)}...</div>
                  </div>
                </div>

                <div className="flex-1">
                  <h2 className="mcp-detail-title mb-2 text-3xl font-bold text-[var(--text-primary)]">
                    {(selectedServerForDetail as any).display_name || (selectedServerForDetail as any).client_name || selectedServerForDetail.name}
                  </h2>
                  <div className="flex items-center gap-2 mb-6">
                    <span className="mcp-detail-type-badge rounded border border-[var(--color-selected-border)] bg-[var(--color-accent-bg)] px-2 py-0.5 text-xs font-bold uppercase text-[var(--color-accent)]">
                      {displayMcpServerType(selectedServerForDetail)}
                    </span>
                    <div className={`mcp-detail-status-badge flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-medium ${selectedServerForDetail.enabled ? 'bg-[var(--color-accent-bg)] text-[var(--color-accent)]' : 'bg-[var(--surface-secondary)] text-[var(--text-muted)]'}`}>
                      <div className={`h-1.5 w-1.5 rounded-full ${selectedServerForDetail.enabled ? 'bg-[var(--color-accent)]' : 'bg-[var(--text-muted)]'}`} />
                      {selectedServerForDetail.enabled ? 'Active' : 'Disabled'}
                    </div>
                  </div>

                  <div className="space-y-6">
                    <div>
                      <h4 className="mcp-detail-section-title mb-2 text-xs font-bold uppercase tracking-wider text-[var(--text-muted)]">Endpoint URL</h4>
                      <div className="mcp-detail-url-box rounded-lg border border-[var(--border-default)] bg-[var(--surface-secondary)] p-3 font-mono text-xs break-all text-[var(--text-secondary)]">
                        {selectedServerForDetail.url}
                      </div>
                    </div>

                    <div>
                      <h4 className="mcp-detail-section-title mb-2 text-xs font-bold uppercase tracking-wider text-[var(--text-muted)]">Description</h4>
                      <p className="mcp-detail-description text-sm leading-relaxed text-[var(--text-secondary)]">
                        {selectedServerForDetail.description || 'No description provided for this server.'}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="mt-auto flex flex-col items-stretch justify-between gap-3 border-t border-[var(--border-subtle)] pt-6 sm:flex-row sm:items-center sm:gap-4 sm:pt-8">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button 
                      variant="secondary" 
                      size="sm" 
                      onClick={() => handleTestConnection(selectedServerForDetail)}
                      disabled={testingServers.has(selectedServerForDetail.id)}
                      className="border-[var(--border-default)] bg-[var(--surface-primary)] text-[var(--text-primary)] hover:bg-[var(--color-accent-bg)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                    >
                      连接
                    </Button>
                    {selectedServerForDetail.ext?.server_type === 'http_oauth' && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void handleReauthorizeHttpOAuth(selectedServerForDetail)}
                        disabled={oauthHttpBusy}
                        className="border-[var(--border-default)] bg-[var(--surface-primary)] text-[var(--text-primary)] hover:bg-[var(--color-hover-bg)] hover:border-[var(--color-highlight)] hover:text-[var(--color-highlight)]"
                      >
                        <Key className="w-3.5 h-3.5 mr-1" />
                        OAuth 授权
                      </Button>
                    )}
                    {testResults.get(selectedServerForDetail.id)?.success && (
                      <span className="flex items-center gap-1.5 text-xs font-medium text-[var(--color-highlight)]">
                        <Check className="h-3.5 w-3.5 text-[var(--color-highlight)]" />
                        连接成功
                      </span>
                    )}
                  </div>
                  <Button 
                    variant={testResults.get(selectedServerForDetail.id)?.connected ? 'primary' : 'secondary'}
                    size="sm"
                    className="border-0 bg-[var(--color-accent)] text-[var(--text-on-accent)] hover:bg-[var(--color-accent-hover)]"
                    onClick={() => {
                      void handleFetchTools(selectedServerForDetail);
                    }}
                  >
                    获取工具列表
                    <ExternalLink className="w-4 h-4 ml-2" />
                  </Button>
                </div>
              </div>

               {/* 右侧：工具列表 (明信片背面/详情页) */}
               <div className="mcp-detail-right flex w-full flex-col border-t border-[var(--border-default)] bg-[var(--surface-secondary)] md:w-[380px] md:border-l md:border-t-0">
                <div className="mcp-tools-header flex items-center justify-between border-b border-[var(--border-default)] bg-[var(--surface-primary)] p-4 sm:p-6">
                  <h3 className="mcp-tools-header-title flex items-center gap-2 font-bold text-[var(--text-primary)]">
                    <Wrench className="mcp-tools-header-icon h-4 w-4 text-[var(--color-accent)]" />
                    可用工具
                  </h3>
                  <span className="mcp-tools-count rounded-full border border-[var(--border-default)] bg-[var(--surface-secondary)] px-2 py-0.5 text-xs text-[var(--text-muted)]">
                    {testResults.get(selectedServerForDetail.id)?.tools?.length || 0}
                  </span>
                </div>
                
                <div className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-3 no-scrollbar">
                  {testingServers.has(selectedServerForDetail.id) ? (
                    <div className="flex h-full flex-col items-center justify-center text-[var(--text-muted)]">
                      <div className="mcp-loading-spinner mb-2 h-6 w-6 animate-spin rounded-full border-2 border-[var(--color-accent)] border-t-transparent" />
                      <span className="text-xs mcp-loading-text">正在获取工具...</span>
                    </div>
                  ) : testResults.get(selectedServerForDetail.id)?.tools ? (
                    testResults.get(selectedServerForDetail.id)!.tools!.map((tool, idx) => (
                      <div key={idx} className="mcp-tool-card rounded-xl border border-[var(--border-default)] bg-[var(--surface-primary)] p-4 shadow-sm transition-shadow hover:shadow-md">
                        <div className="mcp-tool-name mb-1 text-sm font-bold text-[var(--text-primary)]">{tool.name}</div>
                        <p className="mcp-tool-description mb-3 line-clamp-2 text-xs text-[var(--text-secondary)]">{tool.description}</p>
                        
                        {tool.inputSchema?.properties && (
                          <div className="space-y-1.5">
                            <div className="mcp-detail-section-title text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">Parameters</div>
                            <div className="flex flex-wrap gap-1.5">
                              {Object.entries(tool.inputSchema.properties).map(([name, schema]: [string, any]) => (
                                <div key={name} className="mcp-tool-param-badge flex items-center gap-1 rounded border border-[var(--border-default)] bg-[var(--surface-secondary)] px-1.5 py-0.5">
                                  <span className="mcp-tool-param-name text-[10px] font-mono text-[var(--color-accent)]">{name}</span>
                                  <span className="mcp-tool-param-type text-[9px] text-[var(--text-muted)]">({schema.type || 'any'})</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    ))
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center px-8 text-center text-[var(--text-muted)]">
                      <Wrench className="mb-4 h-12 w-12 text-[var(--color-accent)] opacity-20" />
                      <p className="text-xs mcp-text-secondary">点击左侧"获取工具列表"按钮来查看此服务器提供的功能</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Notion 工作区：选择/注册（Dialog） */}
      <Dialog
        open={showWorkspaceSelection || showRegistrationForm}
        onOpenChange={(open) => {
          if (open) return;
          if (isRegistering || notionAuthState === 'authenticating') return;
          setShowWorkspaceSelection(false);
          setShowRegistrationForm(false);
        }}
      >
        <DialogContent className="chatee-dialog-standard mcp-dialog max-w-md border-[var(--border-default)] bg-[var(--surface-primary)] text-[var(--text-primary)]">
          {showWorkspaceSelection ? (
            <>
              <DialogHeader>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <DialogTitle>选择 Notion 工作空间</DialogTitle>
                    <DialogDescription className="text-[var(--text-secondary)]">选择已有工作空间进行连接</DialogDescription>
                  </div>
                  <button
                    onClick={() => {
                      if (isRegistering || notionAuthState === 'authenticating') return;
                      setShowWorkspaceSelection(false);
                    }}
                    className="niho-close-pink text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                    disabled={isRegistering || notionAuthState === 'authenticating'}
                    aria-label="关闭"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
              </DialogHeader>

              <div className="space-y-3 max-h-64 overflow-y-auto pr-2 no-scrollbar">
                {notionRegistrations.map((registration) => (
                  <div
                    key={registration.id}
                    className="mcp-workspace-card group flex cursor-pointer items-center justify-between rounded-xl border border-[var(--border-default)] bg-[var(--surface-primary)] p-4 transition-all hover:bg-[var(--color-hover-bg)]"
                    onClick={() => handleUseExistingWorkspace(registration)}
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-transparent rounded-lg flex items-center justify-center">
                        <svg className="w-6 h-6" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
                          <path d="M6.017 4.313l55.333 -4.087c6.797 -0.583 8.543 -0.19 12.817 2.917l17.663 12.443c2.913 2.14 3.883 2.723 3.883 5.053v68.243c0 4.277 -1.553 6.807 -6.99 7.193L24.467 99.967c-4.08 0.193 -6.023 -0.39 -8.16 -3.113L3.3 79.94c-2.333 -3.113 -3.3 -5.443 -3.3 -8.167V11.113c0 -3.497 1.553 -6.413 6.017 -6.8z" className="fill-[var(--surface-primary)]"/>
                          <path fillRule="evenodd" clipRule="evenodd" d="M61.35 0.227l-55.333 4.087C1.553 4.7 0 7.617 0 11.113v60.66c0 2.724 0.967 5.053 3.3 8.167l13.007 16.913c2.137 2.723 4.08 3.307 8.16 3.113l64.257 -3.89c5.433 -0.387 6.99 -2.917 6.99 -7.193V20.64c0 -2.21 -0.873 -2.847 -3.443 -4.733L74.167 3.143c-4.273 -3.107 -6.02 -3.5 -12.817 -2.917zM25.92 19.523c-5.247 0.353 -6.437 0.433 -9.417 -1.99L8.927 11.507c-0.77 -0.78 -0.383 -1.753 1.557 -1.947l53.193 -3.887c4.467 -0.39 6.793 1.167 8.54 2.527l9.123 6.61c0.39 0.197 1.36 1.36 0.193 1.36l-54.933 3.307 -0.68 0.047zM19.803 88.3V30.367c0 -2.53 0.777 -3.697 3.103 -3.893L86 22.78c2.14 -0.193 3.107 1.167 3.107 3.693v57.547c0 2.53 -0.39 4.67 -3.883 4.863l-60.377 3.5c-3.493 0.193 -5.043 -0.97 -5.043 -4.083zm59.6 -54.827c0.387 1.75 0 3.5 -1.75 3.7l-2.91 0.577v42.773c-2.527 1.36 -4.853 2.137 -6.797 2.137 -3.107 0 -3.883 -0.973 -6.21 -3.887l-19.03 -29.94v28.967l6.02 1.363s0 3.5 -4.857 3.5l-13.39 0.777c-0.39 -0.78 0 -2.723 1.357 -3.11l3.497 -0.97v-38.3L30.48 40.667c-0.39 -1.75 0.58 -4.277 3.3 -4.473l14.367 -0.967 19.8 30.327v-26.83l-5.047 -0.58c-0.39 -2.143 1.163 -3.7 3.103 -3.89l13.4 -0.78z" className="fill-[var(--text-primary)]"/>
                        </svg>
                      </div>
                      <div>
                        <div className="text-sm font-bold text-[var(--text-primary)]">{registration.client_name}</div>
                        <div className="text-[10px] text-[var(--text-muted)]">ID: {registration.client_id.substring(0, 8)}...</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        className="border-[var(--border-default)] bg-[var(--surface-primary)] text-[var(--color-accent)] opacity-0 transition-opacity hover:bg-[var(--color-accent-bg)] hover:border-[var(--color-accent)] group-hover:opacity-100"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleUseExistingWorkspace(registration);
                        }}
                      >
                        连接
                      </Button>
                      <button
                        onClick={(e) => handleDeleteNotionRegistration(registration, e)}
                        className="rounded-lg p-2 text-[var(--color-error)] opacity-0 transition-all hover:bg-[var(--color-error-bg)] hover:text-[var(--color-error)] group-hover:opacity-100"
                        title="删除工作空间"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex flex-col gap-3 mt-6">
                <Button
                  variant="primary"
                  onClick={() => {
                    setShowWorkspaceSelection(false);
                    setShowRegistrationForm(true);
                  }}
                  className="border-0 bg-[var(--color-accent)] text-[var(--text-on-accent)] hover:bg-[var(--color-accent-hover)]"
                >
                  注册新工作空间
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    if (isRegistering || notionAuthState === 'authenticating') return;
                    setShowWorkspaceSelection(false);
                  }}
                  className="niho-close-pink"
                >
                  取消
                </Button>
              </div>
            </>
          ) : (
            <>
              <DialogHeader>
                <div className="flex items-center justify-between gap-3">
                  <DialogTitle>注册 Notion 工作空间</DialogTitle>
                  <button
                    onClick={() => {
                      if (isRegistering || notionAuthState === 'authenticating') return;
                      setShowRegistrationForm(false);
                    }}
                    className="niho-close-pink text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                    disabled={isRegistering || notionAuthState === 'authenticating'}
                    aria-label="关闭"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
              </DialogHeader>

              <div className="space-y-5">
                <InputField
                  label="Client Name"
                  required
                  inputProps={{
                    id: 'notion-client-name',
                    value: registrationFormData.client_name,
                    onChange: (e) =>
                      setRegistrationFormData({ ...registrationFormData, client_name: e.target.value }),
                    placeholder: '例如: my-notion-workspace',
                  }}
                />
                <InputField
                  label="Workspace Alias (工作空间别名)"
                  required
                  hint="全局唯一标识，用于区分不同的 Notion 工作空间。只能包含英文、数字、下划线和连字符。"
                  inputProps={{
                    id: 'notion-workspace-alias',
                    value: registrationFormData.workspace_alias,
                    onChange: (e) =>
                      setRegistrationFormData({ ...registrationFormData, workspace_alias: e.target.value }),
                    placeholder: '例如: workspace-1',
                  }}
                />
                <InputField
                  label="Redirect URI Base"
                  inputProps={{
                    id: 'notion-redirect-uri-base',
                    value: registrationFormData.redirect_uri_base,
                    onChange: (e) =>
                      setRegistrationFormData({ ...registrationFormData, redirect_uri_base: e.target.value }),
                    placeholder: getBackendUrl(),
                  }}
                />
              </div>

              <div className="flex flex-col gap-3 mt-8">
                <Button
                  variant="primary"
                  onClick={handleRegisterNotion}
                  disabled={isRegistering || !registrationFormData.client_name.trim() || !registrationFormData.workspace_alias.trim()}
                  className="border-0 bg-[var(--color-accent)] text-[var(--text-on-accent)] hover:bg-[var(--color-accent-hover)]"
                >
                  {isRegistering ? '正在注册...' : '注册并开始授权'}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    if (isRegistering || notionAuthState === 'authenticating') return;
                    setShowRegistrationForm(false);
                  }}
                  className="niho-close-pink"
                >
                  取消
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* MCP OAuth 二维码弹窗：展示授权二维码，用户可扫码或在浏览器中打开 */}
      <Dialog
        open={oauthQrDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setOauthQrDialogOpen(false);
            setOauthQrDataUrl(null);
            setOauthAuthorizationUrl(null);
          }
        }}
      >
        <DialogContent className="chatee-dialog-standard max-w-sm border-[var(--border-default)] bg-[var(--surface-primary)] text-[var(--text-primary)]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Smartphone className="h-5 w-5 text-[var(--color-accent)]" />
              MCP 授权
            </DialogTitle>
            <DialogDescription className="text-[var(--text-secondary)]">
              使用手机扫描下方二维码完成授权，或点击「在浏览器中打开」在电脑上完成。
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-4 py-2">
            {oauthQrDataUrl ? (
              <div className="rounded-lg border border-[var(--border-default)] bg-[var(--surface-primary)] p-2">
                <img src={oauthQrDataUrl} alt="扫码授权" className="h-auto w-full max-w-[260px] aspect-square" />
              </div>
            ) : (
              <div className="flex aspect-square w-full max-w-[260px] items-center justify-center rounded-lg border border-[var(--border-default)] bg-[var(--surface-secondary)] text-sm text-[var(--text-muted)]">
                加载中…
              </div>
            )}
            {oauthAuthorizationUrl && (
              <Button
                variant="primary"
                className="w-full border-0 bg-[var(--color-accent)] text-[var(--text-on-accent)] hover:bg-[var(--color-accent-hover)]"
                onClick={() => {
                  if (typeof window === 'undefined') return;
                  const url = oauthAuthorizationUrl;
                  window.open(url, 'MCP Authorization', 'width=600,height=700,scrollbars=yes,resizable=yes');
                }}
              >
                <ExternalLink className="w-4 h-4 mr-2" />
                在浏览器中打开
              </Button>
            )}
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setOauthQrDialogOpen(false)} className="niho-close-pink">
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title="删除服务器"
        description={`确定要删除「${deleteTarget?.name}」吗？此操作不可撤销。`}
        variant="destructive"
        onConfirm={async () => {
          if (!deleteTarget) return;
          const id = deleteTarget.id;
          setDeleteTarget(null);
          await handleDeleteServer(id);
        }}
      />
    </div>
  );
};

export default MCPConfig;
