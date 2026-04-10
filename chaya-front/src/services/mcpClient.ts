/**
 * MCP (Model Context Protocol) 客户端实现
 * 使用官方 @modelcontextprotocol/sdk
 * 
 * @deprecated 此文件将在未来版本中废弃
 * 请使用新的分层架构:
 * - import { ConnectionPool, MCPClient, HealthMonitor } from './services/providers/mcp'
 * - import { MCPServer, MCPTool } from './services/providers/mcp'
 * 
 * 新架构提供更好的连接池管理、健康监控和错误处理
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import { getBackendUrl } from '../utils/backendUrl';

export interface MCPServer {
  id: string;
  name: string;
  url: string;
  type: 'http-stream' | 'http-post' | 'stdio' | 'http-oauth';
  enabled: boolean;
  description?: string;
  metadata?: Record<string, any>;
  ext?: Record<string, any>; // 扩展配置（如 response_format, server_type 等）
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties?: Record<string, any>;
    required?: string[];
  };
}

export interface MCPClientOptions {
  server: MCPServer;
}

export class MCPClient {
  private server: MCPServer;
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private isConnected: boolean = false;
  private cachedTools: MCPTool[] | null = null; // 缓存工具列表
  private toolsCacheTime: number = 0; // 工具列表缓存时间
  private readonly TOOLS_CACHE_TTL = 5 * 60 * 1000; // 工具列表缓存5分钟
  private isInUse: boolean = false; // 连接是否正在使用中（连接池管理）
  public lastUsedTime: number = 0; // 最后使用时间（公开以供连接池管理使用）
  private _isHealthy: boolean = true; // 连接健康状态
  private consecutiveErrors: number = 0; // 连续错误次数
  private readonly MAX_CONSECUTIVE_ERRORS = 3; // 最大连续错误次数，超过则认为连接不健康
  private lastHealthCheckTime: number = 0; // 上次健康检查时间
  private readonly HEALTH_CHECK_INTERVAL = 60 * 1000; // 健康检查间隔 60 秒（与 HealthMonitor 一致，降低请求频率）

  constructor(options: MCPClientOptions) {
    this.server = options.server;
  }

  /**
   * 标记连接为使用中
   */
  markAsInUse(): void {
    this.isInUse = true;
    this.lastUsedTime = Date.now();
  }

  /**
   * 标记连接为空闲
   */
  markAsIdle(): void {
    this.isInUse = false;
    this.lastUsedTime = Date.now();
  }

  /**
   * 检查连接是否空闲
   */
  isIdle(): boolean {
    return !this.isInUse && this.isInitialized;
  }

  /**
   * 获取连接健康状态
   */
  get isHealthy(): boolean {
    return this._isHealthy && this.isConnected;
  }

  /**
   * 标记连接为不健康
   */
  markAsUnhealthy(): void {
    this._isHealthy = false;
    console.warn(`[MCP] Connection to ${this.server.name} marked as unhealthy`);
  }

  /**
   * 标记连接为健康
   */
  markAsHealthy(): void {
    this._isHealthy = true;
    this.consecutiveErrors = 0;
    console.log(`[MCP] Connection to ${this.server.name} marked as healthy`);
  }

  /**
   * 记录错误，累计错误次数
   * @returns 如果连续错误次数超过阈值，返回 true（表示应该重连）
   */
  recordError(error: Error): boolean {
    this.consecutiveErrors++;
    console.warn(`[MCP] Error recorded for ${this.server.name} (${this.consecutiveErrors}/${this.MAX_CONSECUTIVE_ERRORS}):`, error.message);
    
    // 检测常见的连接断开错误
    const errorMessage = error.message.toLowerCase();
    const isConnectionError = 
      errorMessage.includes('network') ||
      errorMessage.includes('connection') ||
      errorMessage.includes('timeout') ||
      errorMessage.includes('aborted') ||
      errorMessage.includes('econnrefused') ||
      errorMessage.includes('econnreset') ||
      errorMessage.includes('epipe') ||
      errorMessage.includes('socket') ||
      errorMessage.includes('fetch failed') ||
      errorMessage.includes('failed to fetch') ||
      errorMessage.includes('session') ||
      // MCP 服务器重启后常见：旧 session 失效会直接返回 404/410
      errorMessage.includes('http 404') ||
      errorMessage.includes('http 410') ||
      errorMessage.includes('not connected') ||
      errorMessage.includes('transport');

    if (isConnectionError || this.consecutiveErrors >= this.MAX_CONSECUTIVE_ERRORS) {
      this.markAsUnhealthy();
      return true; // 需要重连
    }

    return false;
  }

  /**
   * 重置错误计数（成功操作后调用）
   */
  resetErrors(): void {
    if (this.consecutiveErrors > 0) {
      console.log(`[MCP] Resetting error count for ${this.server.name} (was ${this.consecutiveErrors})`);
    }
    this.consecutiveErrors = 0;
    this._isHealthy = true;
  }

  /**
   * 健康检查结果
   */
  private _healthCheckSupported: boolean | null = null; // null 表示未知，true 表示支持，false 表示不支持
  private _lastHealthWarning: number = 0; // 上次健康警告时间
  private readonly HEALTH_WARNING_INTERVAL = 5 * 60 * 1000; // 健康警告间隔（5分钟）

  /**
   * 检查 MCP 服务器是否支持健康检查接口
   */
  get supportsHealthCheck(): boolean | null {
    return this._healthCheckSupported;
  }

  /**
   * 检查连接健康状态（主动健康检查）
   * 优先使用标准 /health 接口，如果不支持则回退到 tools/list
   * @returns true 表示连接健康，false 表示不健康
   */
  async checkHealth(): Promise<boolean> {
    // 如果最近已经检查过，直接返回缓存的状态
    const now = Date.now();
    if (now - this.lastHealthCheckTime < this.HEALTH_CHECK_INTERVAL) {
      return this._isHealthy;
    }
    this.lastHealthCheckTime = now;

    // 基本检查：transport 和 client 是否存在
    if (!this.transport || !this.client || !this.isConnected) {
      console.warn(`[MCP] Health check failed for ${this.server.name}: not connected`);
      this.markAsUnhealthy();
      return false;
    }

    try {
      console.log(`[MCP] Performing health check for ${this.server.name}...`);
      
      // 首先尝试使用标准 /health 接口
      const healthResult = await this.callHealthEndpoint();
      
      if (healthResult.supported) {
        this._healthCheckSupported = true;
        
        if (healthResult.healthy) {
          console.log(`[MCP] Health check passed for ${this.server.name} (via /health endpoint)`);
          this.markAsHealthy();
          return true;
        } else {
          console.warn(`[MCP] Health check failed for ${this.server.name}: server reported unhealthy`);
          this.markAsUnhealthy();
          return false;
        }
      } else {
        // /health 接口不支持，输出警告并回退到 tools/list
        this._healthCheckSupported = false;
        
        // 每隔一段时间输出一次警告，避免日志刷屏
        if (now - this._lastHealthWarning > this.HEALTH_WARNING_INTERVAL) {
          this._lastHealthWarning = now;
          console.warn(`[MCP] ⚠️ MCP服务器 "${this.server.name}" 不支持标准健康检查接口 /health`);
          console.warn(`[MCP] ⚠️ 建议: MCP服务应实现 /health 接口以支持连接健康检查`);
          console.warn(`[MCP] ⚠️ 规范: GET /health 应返回 {"status": "healthy"} 或 {"status": "unhealthy"}`);
          console.warn(`[MCP] 回退使用 tools/list 进行健康检查...`);
        }
        
        // 回退：使用 tools/list 作为健康检查
        await this.listTools(true); // forceRefresh = true
        
        console.log(`[MCP] Health check passed for ${this.server.name} (via tools/list fallback)`);
        this.markAsHealthy();
        return true;
      }
    } catch (error) {
      console.error(`[MCP] Health check failed for ${this.server.name}:`, error);
      this.markAsUnhealthy();
      return false;
    }
  }

  /**
   * 调用 MCP 服务器的 /health 接口
   * @returns { supported: boolean, healthy: boolean, details?: any }
   */
  private async callHealthEndpoint(): Promise<{ supported: boolean; healthy: boolean; details?: any }> {
    try {
      // 构建健康检查 URL
      const baseUrl = this.server.url.replace(/\/mcp\/?$/, ''); // 移除 /mcp 后缀
      const healthUrl = `${baseUrl}/health`;
      
      // 始终使用代理访问健康检查接口，以解决跨域问题
      const targetUrl = this.buildHealthProxyUrl(healthUrl);
      
      console.log(`[MCP] Calling health endpoint: ${targetUrl}`);
      
      // 设置较短的超时时间（5秒）
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(targetUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      
      // 检查响应状态
      if (response.status === 404 || response.status === 405) {
        // /health 接口不存在
        return { supported: false, healthy: false };
      }
      
      if (!response.ok) {
        // 服务器返回错误状态
        return { supported: true, healthy: false, details: { status: response.status } };
      }
      
      // 解析响应
      const data = await response.json();
      
      // 检查健康状态
      // 支持多种格式：
      // - { "status": "healthy" }
      // - { "status": "ok" }
      // - { "healthy": true }
      // - { "ok": true }
      const isHealthy = 
        data.status === 'healthy' || 
        data.status === 'ok' ||
        data.healthy === true ||
        data.ok === true;
      
      return { supported: true, healthy: isHealthy, details: data };
      
    } catch (error: any) {
      // 网络错误或超时
      if (error.name === 'AbortError') {
        console.warn(`[MCP] Health endpoint timeout for ${this.server.name}`);
        return { supported: true, healthy: false, details: { error: 'timeout' } };
      }
      
      // 其他错误（如连接拒绝、DNS 解析失败等）可能表示 /health 不支持
      // 或者服务器本身不可用
      const errorMessage = error.message?.toLowerCase() || '';
      if (errorMessage.includes('404') || errorMessage.includes('not found')) {
        return { supported: false, healthy: false };
      }
      
      // 假设是服务器不可用
      return { supported: true, healthy: false, details: { error: error.message } };
    }
  }

  /**
   * 构建健康检查代理 URL
   */
  private buildHealthProxyUrl(healthUrl: string): string {
    const backendUrl = this.getBackendUrl();
    const encodedUrl = encodeURIComponent(healthUrl);
    return `${backendUrl}/mcp/health?url=${encodedUrl}`;
  }

  /**
   * 获取 session ID
   */
  getSessionId(): string | undefined {
    return this.transport ? (this.transport as any).sessionId : undefined;
  }


  /**
   * 获取后端 API 地址
   */
  private getBackendUrl(): string {
    // 使用统一的后端 URL 获取函数
    return getBackendUrl();
  }

  /**
   * 构建代理 URL（所有环境都使用代理，解决 CORS 问题）
   * 使用后端 API 地址，通过后端代理转发
   */
  private buildProxyUrl(serverUrl: string, serverId?: string): string {
    // 所有环境都使用后端代理，避免 CORS 问题
    // 格式：http://localhost:3002/mcp?url=...&transportType=streamable-http&server_id=...
    // 带 server_id 时后端根据 JWT + Redis/配置注入上游 Authorization
    const backendUrl = this.getBackendUrl();
    const encodedUrl = encodeURIComponent(serverUrl);
    let proxyUrl = `${backendUrl}/mcp?url=${encodedUrl}&transportType=streamable-http`;
    if (serverId) {
      proxyUrl += `&server_id=${encodeURIComponent(serverId)}`;
    }
    console.log(`[MCP] Built proxy URL: ${proxyUrl}`);
    return proxyUrl;
  }

  /**
   * 连接到 MCP 服务器
   */
  async connect(): Promise<void> {
    if (this.isConnected) {
      console.log(`[MCP] Already connected to ${this.server.name}`);
      return;
    }

    try {
      // 所有环境都使用代理模式，解决 CORS 问题
      const targetUrl = this.buildProxyUrl(this.server.url, this.server.id);
      
      console.log(`[MCP] Connecting to ${this.server.name}`);
      console.log(`[MCP] Using proxy to avoid CORS issues`);
      console.log(`[MCP] Target URL: ${targetUrl}`);

      // 创建 StreamableHTTP 传输层（流式 HTTP 传输）
      // 使用最新的 MCP 协议版本 2025-06-18（兼容 2025-03-26）
      console.log(`[MCP] Creating StreamableHTTPClientTransport`);
      
      // 构建请求头，合并默认头和自定义头（如Authorization）
      const defaultHeaders: Record<string, string> = {
        'mcp-protocol-version': '2025-06-18',
        'Accept': 'application/json, text/event-stream',
      };
      
      // 从metadata中获取自定义headers（如Notion的Authorization）
      const customHeaders = this.server.metadata?.headers || {};
      const headers: Record<string, string> = { ...defaultHeaders, ...customHeaders };
      const chayaToken = typeof localStorage !== 'undefined' ? localStorage.getItem('chaya_token') : null;
      if (chayaToken && this.server.id) {
        headers['X-Chaya-Authorization'] = `Bearer ${chayaToken}`;
      }
      
      console.log(`[MCP] Server metadata:`, JSON.stringify(this.server.metadata, null, 2));
      console.log(`[MCP] Custom headers from metadata:`, Object.keys(customHeaders));
      console.log(`[MCP] Request headers:`, Object.keys(headers).map(k => 
        k === 'Authorization' ? `${k}: Bearer ***` : `${k}: ${headers[k]}`
      ).join(', '));
      
      // 检查Authorization header
      if (headers['Authorization']) {
        const authValue = headers['Authorization'];
        console.log(`[MCP] Authorization header present, length: ${authValue.length}`);
        console.log(`[MCP] Authorization header format: ${authValue.substring(0, 20)}...`);
      } else {
        console.warn(`[MCP] ⚠️ No Authorization header found in headers!`);
      }
      
      this.transport = new StreamableHTTPClientTransport(new URL(targetUrl), {
        requestInit: {
          headers,
        },
      });
      console.log(`[MCP] StreamableHTTPClientTransport created, will use POST for requests and SSE for responses`);

      // 创建 MCP 客户端
      // 显式提供 JSON Schema 验证器以避免 "resultSchema.parse is not a function" 错误
      this.client = new Client(
        {
          name: 'youtube-manager',
          version: '1.0.0',
        },
        {
          capabilities: {
            tools: {},
          },
          jsonSchemaValidator: new AjvJsonSchemaValidator(),
        }
      );

      // 严格遵循 MCP 协议初始化流程：
      // 1. Client.connect() 会自动：
      //    - 启动传输层（建立 SSE 连接）
      //    - 发送 initialize 请求
      //    - 等待 initialize 成功响应（确认初始化完成）
      //    - 发送 notifications/initialized 通知
      // 2. 等待服务器完成内部初始化

      console.log(`[MCP] Step 1: Connecting client (will automatically:`);
      console.log(`[MCP]   - Start transport layer (SSE connection)`);
      console.log(`[MCP]   - Send initialize request`);
      console.log(`[MCP]   - Wait for initialize response`);
      console.log(`[MCP]   - Send notifications/initialized notification)`);
      
      try {
        await this.client.connect(this.transport);
        console.log(`[MCP] Step 2: Client connected successfully (initialize completed)`);
      } catch (error) {
        // 检查是否是405错误（METHOD NOT ALLOWED）
        // 这可能是SDK内部的预检请求失败，但不影响实际连接
        const errorMessage = error instanceof Error ? error.message : String(error);
        const is405Error = errorMessage.includes('405') || errorMessage.includes('METHOD NOT ALLOWED');
        
        if (is405Error) {
          console.warn(`[MCP] ⚠️ Received 405 error during connection (likely SDK preflight request):`, errorMessage);
          console.warn(`[MCP] This error is usually harmless. Attempting to continue...`);
          // 405错误通常是SDK内部的预检请求失败，但实际的SSE连接可能已经建立
          // 我们尝试继续，如果连接真的失败了，后续操作会失败
          // 设置一个标志，表示连接可能有问题，但允许继续尝试
          console.warn(`[MCP] Connection may still be functional. Will verify with subsequent operations.`);
        } else {
          console.error(`[MCP] Client connection failed:`, error);
          throw new Error(`Failed to initialize MCP session: ${errorMessage}`);
        }
      }

      // 获取会话 ID（如果服务器分配了）
      const sessionId = this.transport.sessionId;
      if (sessionId) {
        console.log(`[MCP] Session ID: ${sessionId}`);
      }

      // Step 3: 等待服务器完成内部初始化
      // Client.connect() 已经完成了 initialize 和 notifications/initialized
      // 根据 MCP Inspector 的流程：
      // - initialize 返回 202 Accepted（异步处理）
      // - 响应通过 SSE 流返回
      // - 服务器需要时间完成内部状态转换
      // 某些服务器（如 xiaohongshu-mcp）可能需要额外时间
      // 优化：减少等待时间，通过实际测试工具列表来验证连接是否就绪
      console.log(`[MCP] Step 3: Waiting for server to complete internal initialization...`);
      console.log(`[MCP] Note: initialize may return 202 Accepted (async), response comes via SSE stream`);
      console.log(`[MCP] Reduced wait time, will verify readiness by testing tools/list...`);
      await new Promise(resolve => setTimeout(resolve, 1000)); // 减少到 1000ms，通过实际请求验证就绪状态

      this.isConnected = true;
      console.log(`[MCP] Successfully connected and initialized ${this.server.name}${sessionId ? ` (session: ${sessionId})` : ''}`);

    } catch (error) {
      console.error(`[MCP] Failed to connect to ${this.server.name}:`, error);
      this.isConnected = false;
      throw error;
    }
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    if (!this.client && !this.transport) {
      return;
    }
    try {
      // transport.close() 会负责关闭底层 SSE/HTTP 连接
      if (this.transport) {
        await this.transport.close();
      }
    } catch (error) {
      console.error(`[MCP] Error disconnecting from ${this.server.name}:`, error);
    } finally {
      this.client = null;
      this.transport = null;
      this.isConnected = false;
      // 清除缓存
      this.cachedTools = null;
      this.toolsCacheTime = 0;
      console.log(`[MCP] Disconnected from ${this.server.name}`);
    }
  }

  /**
   * 强制重连（用于 MCP 服务器重启 / session 丢失 等场景）
   */
  private async forceReconnect(reason: string, detail?: any): Promise<void> {
    console.warn(`[MCP] Forcing reconnect to ${this.server.name} (reason=${reason})`, detail ?? '');
    // 清理旧状态，避免继续携带旧 mcp-session-id
    await this.disconnect();
    await this.connect();
    this.clearToolsCache();
    this.resetErrors();
  }

  /**
   * 是否需要因 HTTP 状态码触发重连
   * - 404/410: 常见于 MCP 服务重启后旧 session 失效
   * - 502/503/504: 代理或目标服务短暂不可用
   */
  private shouldReconnectForHttpStatus(status: number): boolean {
    return status === 404 || status === 410 || status === 502 || status === 503 || status === 504;
  }
  
  /**
   * 清除工具列表缓存
   */
  clearToolsCache(): void {
    this.cachedTools = null;
    this.toolsCacheTime = 0;
    console.log(`[MCP] Cleared tools cache for ${this.server.name}`);
  }

  /**
   * 获取服务器信息
   */
  getServerInfo(): MCPServer {
    return this.server;
  }

  /**
   * 获取连接状态
   */
  get isInitialized(): boolean {
    return this.isConnected;
  }

  /**
   * 获取可用工具列表
   * 
   * 注意：由于 SDK 的 schema 验证问题，我们直接发送原始 HTTP 请求
   * 优化：使用缓存避免重复请求
   */
  async listTools(forceRefresh: boolean = false): Promise<MCPTool[]> {
    if (!this.transport) {
      throw new Error('MCP transport not connected');
    }

    // 检查缓存
    const now = Date.now();
    if (!forceRefresh && this.cachedTools && (now - this.toolsCacheTime) < this.TOOLS_CACHE_TTL) {
      console.log(`[MCP] Using cached tools list for ${this.server.name} (${this.cachedTools.length} tools)`);
      return this.cachedTools;
    }

    const maxRetries = 2; // 减少重试次数
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[MCP] Attempting to get tools list from ${this.server.name} (attempt ${attempt}/${maxRetries})`);
        console.log(`[MCP] Sending direct HTTP POST to bypass SDK validation`);

        // 使用代理发送 HTTP POST 请求，解决 CORS 问题（必须带 server_id 以便后端注入 OAuth）
        const targetUrl = this.buildProxyUrl(this.server.url, this.server.id);

        const requestBody = {
          jsonrpc: '2.0',
          id: attempt,
          method: 'tools/list',
          params: {
            _meta: {
              progressToken: attempt
            }
          }
        };

        console.log(`[MCP] Sending request to ${targetUrl}`);
        console.log(`[MCP] Request body:`, JSON.stringify(requestBody));

        // 检查服务器是否使用 SSE 格式（Notion MCP 使用 SSE）
        const isSSE = (this.server as any).ext?.response_format === 'sse' || 
                      (this.server as any).ext?.server_type === 'notion';

        // 与 StreamableHTTPClientTransport / MCP 规范一致：必须同时声明 JSON 与 SSE，否则部分上游返回 406
        const listHeaders: Record<string, string> = {
          'Content-Type': 'application/json',
          Accept: isSSE ? 'text/event-stream' : 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-06-18',
          'mcp-session-id': (this.transport as any).sessionId || '',
        };
        const chayaTok = typeof localStorage !== 'undefined' ? localStorage.getItem('chaya_token') : null;
        if (chayaTok && this.server.id) {
          listHeaders['X-Chaya-Authorization'] = `Bearer ${chayaTok}`;
        }

        const response = await fetch(targetUrl, {
          method: 'POST',
          headers: listHeaders,
          body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
          // MCP 服务重启后：旧 session 常直接 404/410，需要强制重连后再试
          if (this.shouldReconnectForHttpStatus(response.status) && attempt < maxRetries) {
            await this.forceReconnect('listTools_http_status', {
              status: response.status,
              statusText: response.statusText,
            });
            continue;
          }
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        // 检查响应类型：SSE流式响应还是普通JSON响应
        const contentType = response.headers.get('content-type') || '';
        const isStreaming = contentType.includes('text/event-stream') || isSSE;

        let jsonResponse: any;

        if (isStreaming) {
          // 处理 SSE 格式响应
          console.log(`[MCP] Detected SSE response for tools/list, parsing...`);
          const responseText = await response.text();
          console.log(`[MCP] SSE response preview:`, responseText.substring(0, 200));
          
          // 解析 SSE 格式
          const lines = responseText.split('\n');
          for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine.startsWith('data: ')) {
              const jsonStr = trimmedLine.substring(6);
              if (jsonStr.trim()) {
                try {
                  jsonResponse = JSON.parse(jsonStr);
                  console.log(`[MCP] Parsed SSE response:`, jsonResponse);
                  break;
                } catch (parseError) {
                  console.warn(`[MCP] Failed to parse SSE data line:`, parseError);
                }
              }
            } else if (trimmedLine.startsWith('{')) {
              // 直接是JSON对象（没有 "data: " 前缀）
              try {
                jsonResponse = JSON.parse(trimmedLine);
                console.log(`[MCP] Parsed JSON response:`, jsonResponse);
                break;
              } catch (parseError) {
                console.warn(`[MCP] Failed to parse JSON line:`, parseError);
              }
            }
          }
          
          if (!jsonResponse) {
            throw new Error('Failed to parse SSE response for tools/list');
          }
        } else {
          // 普通 JSON 响应
          jsonResponse = await response.json();
          console.log(`[MCP] Received JSON response:`, jsonResponse);
        }

        if (jsonResponse.error) {
          throw new Error(`MCP Error: ${jsonResponse.error.message}`);
        }

        const tools = jsonResponse.result?.tools || [];
        console.log(`[MCP] Retrieved ${tools.length} tools from ${this.server.name}`);
        
        // 缓存工具列表
        this.cachedTools = tools;
        this.toolsCacheTime = Date.now();
        
        // 成功操作，重置错误计数
        this.resetErrors();
        
        return tools;

      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // 记录错误并检测是否需要重连
        const needsReconnect = this.recordError(lastError);
        if (needsReconnect && attempt < maxRetries) {
          // 旧连接可能已失效（服务重启 / session 过期），尝试强制重连再试一次
          await this.forceReconnect('listTools_error', { message: lastError.message });
          continue;
        }

        if (lastError.message.includes('invalid during session initialization') && attempt < maxRetries) {
          const waitTime = 1000 * attempt; // 减少等待时间：1s, 2s
          console.log(`[MCP] Server still initializing, waiting ${waitTime}ms before retry (attempt ${attempt}/${maxRetries})...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          continue;
        }

        console.error(`[MCP] Failed to get tools list from ${this.server.name}:`, error);
        console.error(`[MCP] Error details:`, lastError.message);
        throw lastError;
      }
    }

    throw lastError || new Error('Failed to get tools list after retries');
  }

  /**
   * 调用工具
   * 
   * 注意：由于 SDK 的 schema 验证问题，我们直接发送原始 HTTP 请求
   * 支持SSE流式响应和普通JSON响应
   */
  async callTool(name: string, args: any, onStream?: (chunk: any) => void): Promise<any> {
    if (!this.transport) {
      throw new Error('MCP transport not connected');
    }

    const callOnce = async (allowReconnectRetry: boolean): Promise<any> => {
      console.log(`[MCP] Calling tool ${name} on ${this.server.name}`);
      console.log(`[MCP] Tool arguments:`, args);

      // 始终通过后端代理发送请求，以解决 CORS 问题并允许后端注入认证头（如 OAuth Token）
      const targetUrl = this.buildProxyUrl(this.server.url, this.server.id);

      const requestBody = {
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: {
          name,
          arguments: args,
        }
      };

      console.log(`[MCP] Sending request to ${targetUrl}`);

      // 创建带超时的 fetch（90秒超时，MCP工具调用通常需要更长时间）
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 90000); // 90秒超时
      
      const callHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
        'mcp-session-id': (this.transport as any).sessionId || '',
      };
      const chayaTokCall = typeof localStorage !== 'undefined' ? localStorage.getItem('chaya_token') : null;
      if (chayaTokCall && this.server.id) {
        callHeaders['X-Chaya-Authorization'] = `Bearer ${chayaTokCall}`;
      }

      let response: Response;
      try {
        response = await fetch(targetUrl, {
          method: 'POST',
          headers: callHeaders,
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
      } catch (error: any) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
          throw new Error('MCP tool call timeout (90s)');
        }
        throw error;
      }

      if (!response.ok) {
        if (allowReconnectRetry && this.shouldReconnectForHttpStatus(response.status)) {
          await this.forceReconnect('callTool_http_status', {
            status: response.status,
            statusText: response.statusText,
            toolName: name,
          });
          return await callOnce(false);
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // 检查响应类型：SSE流式响应还是普通JSON响应
      const contentType = response.headers.get('content-type') || '';
      const isStreaming = contentType.includes('text/event-stream');
      
      if (isStreaming) {
        // 明确的SSE流式响应（按照文档要求）
        console.log(`[MCP] Detected streaming response (SSE format from Content-Type: text/event-stream)`);
        return await this.handleStreamingResponse(response, onStream);
      }
      
      // 尝试读取响应文本，判断是否是SSE格式（即使Content-Type不是text/event-stream）
      // 使用clone()避免消费原始响应
      const responseClone = response.clone();
      let responseText: string;
      try {
        responseText = await responseClone.text();
      } catch (e) {
        // 如果无法读取文本，尝试直接作为流处理
        console.log(`[MCP] Cannot read response text, trying as stream`);
        return await this.handleStreamingResponse(response, onStream);
      }
      
      // 检查响应内容是否像SSE格式（按照文档：data: {"jsonrpc":"2.0",...}）
      const looksLikeSSE = responseText.includes('data: {') || 
                           (responseText.trim().startsWith('data: ') && responseText.includes('jsonrpc'));

      if (looksLikeSSE) {
        console.log(`[MCP] Detected streaming response (SSE format from content: data: {...})`);
        // 使用原始响应作为流处理
        return await this.handleStreamingResponse(response, onStream);
      }
      
      // 普通JSON响应
      try {
        const jsonResponse = JSON.parse(responseText);
        console.log(`[MCP] Received JSON response:`, jsonResponse);

        // 检查错误（按照文档要求）
        if (jsonResponse.error) {
          throw new Error(`MCP Error: ${jsonResponse.error.message || JSON.stringify(jsonResponse.error)}`);
        }

        console.log(`[MCP] Tool ${name} executed successfully on ${this.server.name}`);
        // 成功操作，重置错误计数
        this.resetErrors();
        return jsonResponse.result;
      } catch (parseError) {
        // JSON解析失败，可能是SSE格式但格式不标准（例如：data: {"js"... 被截断）
        if (parseError instanceof SyntaxError && parseError.message.includes('JSON')) {
          console.log(`[MCP] JSON parse failed (${parseError.message}), trying to handle as SSE stream`);
          // 使用原始响应作为流处理
          const result = await this.handleStreamingResponse(response, onStream);
          // 成功操作，重置错误计数
          this.resetErrors();
          return result;
        }
        throw parseError;
      }
    };

    try {
      return await callOnce(true);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      // 记录错误并检测是否需要重连
      const needsReconnect = this.recordError(err);
      if (needsReconnect) {
        // 这里不再直接 throw 前重连（避免业务层重复调用造成风暴）
        // 真正重连由上面的 HTTP-status 分支或下一次调用触发（listTools/callTool 会重试一次）
        console.warn(`[MCP] Connection to ${this.server.name} appears broken during tool call (will reconnect on next attempt)`);
      }
      console.error(`[MCP] Failed to call tool ${name} on ${this.server.name}:`, error);
      throw error;
    }
  }

  /**
   * 处理SSE流式响应
   */
  private async handleStreamingResponse(response: Response, onStream?: (chunk: any) => void): Promise<any> {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Response body is not readable');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let fullResult: any = null;
    const chunks: any[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        
        if (done) {
          break;
        }

        // 解码数据块
        buffer += decoder.decode(value, { stream: true });
        
        // 处理SSE格式：按行分割，查找 "data: " 开头的行
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // 保留最后不完整的行

        for (const line of lines) {
          const trimmedLine = line.trim();
          if (!trimmedLine) continue;

          // SSE格式：data: {"jsonrpc":"2.0","id":2,"result":{...}}
          if (trimmedLine.startsWith('data: ')) {
            const jsonStr = trimmedLine.substring(6); // 移除 "data: " 前缀
            
            if (!jsonStr.trim()) {
              continue; // 跳过空行
            }
            
            try {
              // 解析JSON-RPC响应
              const jsonRpcResponse = JSON.parse(jsonStr);
              
              // 检查错误（文档要求）
              if (jsonRpcResponse.error) {
                throw new Error(`MCP Error: ${jsonRpcResponse.error.message || JSON.stringify(jsonRpcResponse.error)}`);
              }
              
              // 收集所有数据块
              chunks.push(jsonRpcResponse);
              
              // 如果包含完整结果，保存它（文档说明：result.content[0].text）
              if (jsonRpcResponse.result !== undefined) {
                fullResult = jsonRpcResponse.result;
                
                // 流式输出：提取content并调用回调
                if (onStream && jsonRpcResponse.result.content) {
                  // 处理content数组
                  if (Array.isArray(jsonRpcResponse.result.content)) {
                    for (const contentItem of jsonRpcResponse.result.content) {
                      if (contentItem.type === 'text' && contentItem.text) {
                        // 尝试解析内层JSON（文档说明：text字段可能是JSON字符串）
                        try {
                          const innerData = JSON.parse(contentItem.text);
                          onStream({ content: innerData, type: 'parsed' });
                        } catch {
                          // 如果不是JSON，直接输出文本
                          onStream({ content: contentItem.text, type: 'text' });
                        }
                      } else {
                        onStream({ content: contentItem, type: contentItem.type || 'unknown' });
                      }
                    }
                  } else if (jsonRpcResponse.result.content) {
                    onStream({ content: jsonRpcResponse.result.content, type: 'content' });
                  }
                }
              }
            } catch (parseError) {
              // JSON解析失败
              console.warn(`[MCP] Failed to parse SSE data line: ${jsonStr.substring(0, 100)}`, parseError);
              if (onStream) {
                onStream({ content: jsonStr, raw: true, error: parseError instanceof Error ? parseError.message : String(parseError) });
              }
            }
          } else if (trimmedLine.startsWith('{')) {
            // 直接是JSON对象（没有 "data: " 前缀）
            try {
              const jsonData = JSON.parse(trimmedLine);
              chunks.push(jsonData);
              
              if (jsonData.result !== undefined) {
                fullResult = jsonData.result;
              }
              
              if (onStream) {
                onStream(jsonData);
              }
            } catch (parseError) {
              console.warn(`[MCP] Failed to parse JSON line: ${trimmedLine.substring(0, 100)}`);
            }
          }
        }
      }

      // 处理剩余的buffer
      if (buffer.trim()) {
        if (buffer.trim().startsWith('data: ')) {
          const jsonStr = buffer.trim().substring(6);
          try {
            const jsonData = JSON.parse(jsonStr);
            chunks.push(jsonData);
            if (jsonData.result !== undefined) {
              fullResult = jsonData.result;
            }
            if (onStream) {
              onStream(jsonData);
            }
          } catch (e) {
            // 忽略解析错误
          }
        } else if (buffer.trim().startsWith('{')) {
          try {
            const jsonData = JSON.parse(buffer.trim());
            chunks.push(jsonData);
            if (jsonData.result !== undefined) {
              fullResult = jsonData.result;
            }
            if (onStream) {
              onStream(jsonData);
            }
          } catch (e) {
            // 忽略解析错误
          }
        }
      }

      // 返回最终结果（按照文档要求：从result.content[0].text提取数据）
      if (fullResult !== null) {
        // 如果result包含content数组，尝试提取text字段并二次解析
        if (Array.isArray(fullResult.content) && fullResult.content.length > 0) {
          const firstContent = fullResult.content[0];
          if (firstContent.type === 'text' && firstContent.text) {
            try {
              // 尝试二次JSON解析（文档说明：text字段可能是JSON字符串）
              const parsedText = JSON.parse(firstContent.text);
              return {
                ...fullResult,
                parsedData: parsedText, // 添加解析后的数据
                originalText: firstContent.text, // 保留原始文本
              };
            } catch {
              // 如果不是JSON，直接返回text
              return {
                ...fullResult,
                text: firstContent.text,
              };
            }
          }
        }
        return fullResult;
      } else if (chunks.length > 0) {
        // 从最后一个chunk中提取result
        const lastChunk = chunks[chunks.length - 1];
        if (lastChunk.result) {
          return lastChunk.result;
        }
        // 如果没有明确的result字段，返回所有收集的数据
        return { chunks, message: 'Multiple chunks received' };
      } else {
        return { content: [], message: 'No data received' };
      }

    } finally {
      reader.releaseLock();
    }
  }
}

/**
 * MCP 连接池项
 */
interface MCPPoolItem {
  client: MCPClient;
  serverId: string;
  createdAt: number;
}

/**
 * MCP 管理器（带连接池和自动重连机制）
 */
export class MCPManager {
  private clients = new Map<string, MCPClient>(); // 共享连接（向后兼容）
  private connectionPool = new Map<string, MCPPoolItem[]>(); // 连接池：serverId -> MCPClient[]
  private serverConfigs = new Map<string, MCPServer>(); // 服务器配置缓存（用于重连）
  private readonly MAX_POOL_SIZE = 10; // 每个服务器的最大连接池大小
  private readonly IDLE_TIMEOUT = 5 * 60 * 1000; // 空闲连接超时时间（5分钟）
  private readonly RECONNECT_DELAY = 5000; // 重连延迟 5 秒，避免连接失败时每秒访问 /mcp
  private readonly MAX_RECONNECT_ATTEMPTS = 3; // 最大重连尝试次数

  /**
   * 从连接池获取一个空闲且健康的连接
   * @param serverId 服务器ID
   * @returns 空闲的MCP客户端，如果没有则返回null
   */
  private getFromPool(serverId: string): MCPClient | null {
    const pool = this.connectionPool.get(serverId);
    if (!pool || pool.length === 0) {
      return null;
    }

    // 查找空闲且健康的连接，同时清理无效连接
    for (let i = pool.length - 1; i >= 0; i--) {
      const item = pool[i];
      
      // 首先检查连接是否仍然有效且健康
      if (!item.client.isInitialized || !item.client.isHealthy) {
        // 连接已失效或不健康，从池中移除并销毁
        console.log(`[MCP Pool] Removing ${!item.client.isInitialized ? 'invalid' : 'unhealthy'} connection from pool for ${serverId}`);
        this.destroyClient(item.client);
        pool.splice(i, 1);
        continue;
      }
      
      // 检查是否空闲
      if (item.client.isIdle()) {
        // 检查是否超时
        const idleTime = Date.now() - item.client.lastUsedTime;
        if (idleTime > this.IDLE_TIMEOUT) {
          // 连接已超时，关闭并从池中移除
          console.log(`[MCP Pool] Connection for ${serverId} idle timeout (${idleTime}ms), removing from pool`);
          this.destroyClient(item.client);
          pool.splice(i, 1);
          continue;
        }
        // 找到有效的空闲连接，标记为使用中并返回
        item.client.markAsInUse();
        console.log(`[MCP Pool] Reusing healthy connection from pool for ${serverId} (session: ${item.client.getSessionId()})`);
        return item.client;
      }
    }

    return null;
  }

  /**
   * 安全地销毁客户端连接
   * @param client 要销毁的客户端
   */
  private destroyClient(client: MCPClient): void {
    try {
      client.disconnect().catch(err => {
        console.error(`[MCP Pool] Error disconnecting client:`, err);
      });
    } catch (error) {
      console.error(`[MCP Pool] Error destroying client:`, error);
    }
  }

  /**
   * 使连接失效并从池中移除
   * @param client 要失效的客户端
   * @param serverId 服务器ID
   */
  invalidateConnection(client: MCPClient, serverId: string): void {
    console.log(`[MCP Pool] Invalidating connection for ${serverId}`);
    
    // 标记为不健康
    client.markAsUnhealthy();
    
    // 从连接池中移除
    const pool = this.connectionPool.get(serverId);
    if (pool) {
      const index = pool.findIndex(item => item.client === client);
      if (index !== -1) {
        pool.splice(index, 1);
        console.log(`[MCP Pool] Removed invalid connection from pool for ${serverId}`);
      }
    }
    
    // 从共享连接中移除
    if (this.clients.get(serverId) === client) {
      this.clients.delete(serverId);
      console.log(`[MCP Pool] Removed invalid shared connection for ${serverId}`);
    }
    
    // 销毁连接
    this.destroyClient(client);
  }

  /**
   * 重新建立连接
   * @param server 服务器配置
   * @returns 新的MCP客户端
   */
  async reconnect(server: MCPServer): Promise<MCPClient> {
    console.log(`[MCP Pool] Attempting to reconnect to ${server.name}...`);
    
    // 缓存服务器配置
    this.serverConfigs.set(server.id, server);
    
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= this.MAX_RECONNECT_ATTEMPTS; attempt++) {
      try {
        console.log(`[MCP Pool] Reconnection attempt ${attempt}/${this.MAX_RECONNECT_ATTEMPTS} for ${server.name}`);
        
        // 创建新连接
        const newClient = new MCPClient({ server });
        await newClient.connect();
        
        // 验证连接是否成功
        if (!newClient.isInitialized) {
          throw new Error(`Connection failed: client not initialized`);
        }
        
        // 标记为健康和使用中
        newClient.markAsHealthy();
        newClient.markAsInUse();
        
        console.log(`[MCP Pool] Successfully reconnected to ${server.name} (session: ${newClient.getSessionId()})`);
        return newClient;
        
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.error(`[MCP Pool] Reconnection attempt ${attempt} failed for ${server.name}:`, lastError.message);
        
        if (attempt < this.MAX_RECONNECT_ATTEMPTS) {
          const delay = this.RECONNECT_DELAY * attempt; // 指数退避
          console.log(`[MCP Pool] Waiting ${delay}ms before next reconnection attempt...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    throw new Error(`Failed to reconnect to ${server.name} after ${this.MAX_RECONNECT_ATTEMPTS} attempts: ${lastError?.message}`);
  }

  /**
   * 获取健康的连接，如果当前连接不健康则自动重连
   * @param server 服务器配置
   * @param currentClient 当前客户端（可选，用于检查是否需要重连）
   * @returns 健康的MCP客户端
   */
  async acquireHealthyConnection(server: MCPServer, currentClient?: MCPClient): Promise<MCPClient> {
    // 缓存服务器配置
    this.serverConfigs.set(server.id, server);
    
    // 如果提供了当前客户端，检查其健康状态
    if (currentClient) {
      if (currentClient.isHealthy && currentClient.isInitialized) {
        console.log(`[MCP Pool] Current connection to ${server.name} is healthy, reusing`);
        return currentClient;
      }
      
      // 当前连接不健康，先失效它
      console.log(`[MCP Pool] Current connection to ${server.name} is unhealthy, invalidating and reconnecting`);
      this.invalidateConnection(currentClient, server.id);
    }
    
    // 尝试从池中获取健康连接
    const pooledClient = this.getFromPool(server.id);
    if (pooledClient && pooledClient.isHealthy) {
      return pooledClient;
    }
    
    // 创建新连接
    return await this.reconnect(server);
  }

  /**
   * 将连接归还到连接池
   * @param client MCP客户端
   * @param serverId 服务器ID
   */
  returnToPool(client: MCPClient, serverId: string): void {
    // 只有已初始化且健康的连接才能放入池中
    if (!client.isInitialized) {
      console.log(`[MCP Pool] Connection for ${serverId} is not initialized, not returning to pool`);
      this.destroyClient(client);
      return;
    }

    // 检查连接健康状态
    if (!client.isHealthy) {
      console.log(`[MCP Pool] Connection for ${serverId} is unhealthy, destroying instead of returning to pool`);
      this.destroyClient(client);
      return;
    }

    // 标记为空闲
    client.markAsIdle();

    // 检查是否已在池中
    const pool = this.connectionPool.get(serverId) || [];
    const existsInPool = pool.some(item => item.client === client);
    
    if (!existsInPool) {
      // 如果池未满，添加到池中
      if (pool.length < this.MAX_POOL_SIZE) {
        pool.push({
          client,
          serverId,
          createdAt: Date.now(),
        });
        this.connectionPool.set(serverId, pool);
        console.log(`[MCP Pool] Healthy connection returned to pool for ${serverId} (pool size: ${pool.length}, session: ${client.getSessionId()})`);
      } else {
        // 池已满，关闭连接
        console.log(`[MCP Pool] Pool full for ${serverId}, closing connection`);
        this.destroyClient(client);
      }
    } else {
      console.log(`[MCP Pool] Connection already in pool for ${serverId}`);
    }
  }

  /**
   * 从连接池获取或创建新的MCP连接（带健康检查和自动重连）
   * @param server MCP服务器配置
   * @returns MCP客户端
   * @throws 如果服务器未启用或连接失败
   */
  async acquireConnection(server: MCPServer): Promise<MCPClient> {
    // 检查服务器是否启用
    if (!server.enabled) {
      throw new Error(`MCP服务器 ${server.name} 未启用`);
    }

    // 缓存服务器配置（用于后续重连）
    this.serverConfigs.set(server.id, server);

    // 先从连接池获取空闲且健康的连接
    const pooledClient = this.getFromPool(server.id);
    if (pooledClient) {
      // 验证连接是否仍然有效且健康
      if (pooledClient.isInitialized && pooledClient.isHealthy) {
        return pooledClient;
      } else {
        // 连接已失效或不健康，销毁并移除
        console.log(`[MCP Pool] Pooled connection for ${server.name} is ${!pooledClient.isInitialized ? 'invalid' : 'unhealthy'}, removing from pool`);
        this.invalidateConnection(pooledClient, server.id);
        // 继续创建新连接
      }
    }

    // 池中没有空闲健康连接，创建新连接（带重试）
    console.log(`[MCP Pool] No healthy idle connection in pool for ${server.name}, creating new connection`);
    
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= this.MAX_RECONNECT_ATTEMPTS; attempt++) {
      try {
        const newClient = new MCPClient({ server });
        
        // 尝试连接
        await newClient.connect();
        
        // 验证连接是否成功
        if (!newClient.isInitialized) {
          throw new Error(`连接失败：客户端未初始化`);
        }

        // 标记为健康和使用中
        newClient.markAsHealthy();
        newClient.markAsInUse();
        
        console.log(`[MCP Pool] New healthy connection created for ${server.name} (session: ${newClient.getSessionId()})`);
        return newClient;
        
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.error(`[MCP Pool] Connection attempt ${attempt}/${this.MAX_RECONNECT_ATTEMPTS} failed for ${server.name}:`, lastError.message);
        
        if (attempt < this.MAX_RECONNECT_ATTEMPTS) {
          const delay = this.RECONNECT_DELAY * attempt;
          console.log(`[MCP Pool] Waiting ${delay}ms before next attempt...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw new Error(`无法连接到MCP服务器 ${server.name}: ${lastError?.message}`);
  }

  /**
   * 添加服务器（向后兼容方法，带健康检查和自动重连）
   * 优化：如果客户端已存在且健康，直接返回，避免重复连接
   * @param server MCP服务器配置
   * @param createNewConnection 是否创建新连接（已废弃，使用 acquireConnection 代替）
   * @deprecated 使用 acquireConnection 代替
   */
  async addServer(server: MCPServer, createNewConnection: boolean = false): Promise<MCPClient> {
    // 缓存服务器配置（用于后续重连）
    this.serverConfigs.set(server.id, server);
    
    // 如果要求创建新连接，使用连接池机制
    if (createNewConnection) {
      return await this.acquireConnection(server);
    }
    
    // 原有逻辑：共享连接（向后兼容，增加健康检查）
    let client = this.clients.get(server.id);
    if (client) {
      console.log(`[MCP Manager] Server ${server.name} already added.`);
      
      // 检查连接是否健康
      if (client.isInitialized && client.isHealthy) {
        console.log(`[MCP Manager] Server ${server.name} is healthy, reusing connection.`);
        return client;
      }
      
      // 连接不健康或未连接，需要重连
      if (!client.isInitialized || !client.isHealthy) {
        console.log(`[MCP Manager] Server ${server.name} is ${!client.isInitialized ? 'not connected' : 'unhealthy'}, reconnecting...`);
        
        // 销毁旧连接
        this.destroyClient(client);
        this.clients.delete(server.id);
        
        // 创建新连接
        try {
          client = await this.reconnect(server);
          this.clients.set(server.id, client);
          return client;
        } catch (error) {
          console.error(`[MCP Manager] Failed to reconnect to ${server.name}:`, error);
          throw error;
        }
      }
    }

    // 创建新连接
    client = new MCPClient({ server });
    this.clients.set(server.id, client);

    if (server.enabled) {
      try {
        await client.connect();
        client.markAsHealthy();
      } catch (error) {
        // 连接失败，从 clients 中移除
        this.clients.delete(server.id);
        throw error;
      }
    }

    return client;
  }

  /**
   * 获取客户端
   */
  getClient(serverId: string): MCPClient | undefined {
    return this.clients.get(serverId);
  }

  /**
   * 获取所有客户端（包括连接池中的连接）
   */
  getAllClients(): MCPClient[] {
    const allClients: MCPClient[] = [];
    // 添加共享连接
    allClients.push(...Array.from(this.clients.values()));
    // 添加连接池中的连接
    for (const pool of this.connectionPool.values()) {
      for (const item of pool) {
        if (item.client.isInitialized) {
          allClients.push(item.client);
        }
      }
    }
    return allClients;
  }

  /**
   * 移除服务器
   */
  removeServer(serverId: string): void {
    const client = this.clients.get(serverId);
    if (client) {
      this.destroyClient(client);
      this.clients.delete(serverId);
      console.log(`[MCP Manager] Server ${serverId} removed.`);
    }
    
    // 同时清理连接池中的连接
    const pool = this.connectionPool.get(serverId);
    if (pool) {
      for (const item of pool) {
        this.destroyClient(item.client);
      }
      this.connectionPool.delete(serverId);
      console.log(`[MCP Manager] Connection pool for ${serverId} cleared.`);
    }
    
    // 移除服务器配置缓存
    this.serverConfigs.delete(serverId);
  }

  /**
   * 获取缓存的服务器配置
   * @param serverId 服务器ID
   * @returns 服务器配置，如果没有缓存则返回 undefined
   */
  getServerConfig(serverId: string): MCPServer | undefined {
    return this.serverConfigs.get(serverId);
  }

  /**
   * 清理所有不健康的连接
   * 可以定期调用此方法来清理连接池
   */
  cleanupUnhealthyConnections(): void {
    console.log(`[MCP Manager] Cleaning up unhealthy connections...`);
    let cleanedCount = 0;
    
    // 清理共享连接
    for (const [serverId, client] of this.clients.entries()) {
      if (!client.isInitialized || !client.isHealthy) {
        console.log(`[MCP Manager] Removing unhealthy shared connection for ${serverId}`);
        this.destroyClient(client);
        this.clients.delete(serverId);
        cleanedCount++;
      }
    }
    
    // 清理连接池
    for (const [serverId, pool] of this.connectionPool.entries()) {
      for (let i = pool.length - 1; i >= 0; i--) {
        const item = pool[i];
        if (!item.client.isInitialized || !item.client.isHealthy) {
          console.log(`[MCP Manager] Removing unhealthy pooled connection for ${serverId}`);
          this.destroyClient(item.client);
          pool.splice(i, 1);
          cleanedCount++;
        }
      }
    }
    
    console.log(`[MCP Manager] Cleanup completed, removed ${cleanedCount} unhealthy connections`);
  }

  /**
   * 获取连接池状态（用于调试）
   */
  getPoolStatus(): { serverId: string; poolSize: number; healthyCount: number; sharedHealthy: boolean }[] {
    const status: { serverId: string; poolSize: number; healthyCount: number; sharedHealthy: boolean }[] = [];
    
    // 收集所有已知的服务器ID
    const serverIds = new Set<string>([
      ...this.clients.keys(),
      ...this.connectionPool.keys(),
    ]);
    
    for (const serverId of serverIds) {
      const sharedClient = this.clients.get(serverId);
      const pool = this.connectionPool.get(serverId) || [];
      
      status.push({
        serverId,
        poolSize: pool.length,
        healthyCount: pool.filter(item => item.client.isInitialized && item.client.isHealthy).length,
        sharedHealthy: sharedClient ? (sharedClient.isInitialized && sharedClient.isHealthy) : false,
      });
    }
    
    return status;
  }
}

// 全局 MCP 管理器实例
export const mcpManager = new MCPManager();