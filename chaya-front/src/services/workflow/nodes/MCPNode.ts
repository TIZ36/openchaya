/**
 * MCPNode - MCP 工具调用节点
 */

import { BaseNode } from './BaseNode';
import type { NodeType, NodeContext, NodeResult } from '../types';
import { ensureMCPProviderInitialized, getConnectionPool } from '../../providers/mcp';

/**
 * MCP 节点配置
 */
export interface MCPNodeConfig {
  serverId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  timeout?: number;
}

/**
 * MCP 节点
 */
export class MCPNode extends BaseNode {
  readonly type: NodeType = 'mcp';

  /**
   * 执行节点
   */
  async execute(context: NodeContext): Promise<NodeResult> {
    const startTime = Date.now();
    const config = this.config as MCPNodeConfig;

    try {
      // 渲染参数
      const renderedArgs: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(config.arguments)) {
        if (typeof value === 'string') {
          renderedArgs[key] = this.renderTemplate(value, context.variables);
        } else {
          renderedArgs[key] = value;
        }
      }

      // 确保 MCP Provider 初始化（加载启用服务器 + 启动 HealthMonitor）
      await ensureMCPProviderInitialized();

      // 获取连接池
      const pool = getConnectionPool();

      // 调用工具
      const result = await pool.callTool({
        serverId: config.serverId,
        toolName: config.toolName,
        arguments: renderedArgs,
        timeout: config.timeout,
      });

      const duration = Date.now() - startTime;

      this.logger.debug('MCP tool call completed', {
        nodeId: this.id,
        toolName: config.toolName,
        duration,
        success: result.success,
      });

      if (result.success) {
        return this.success(
          { result: result.content },
          duration,
          {
            serverId: config.serverId,
            toolName: config.toolName,
          }
        );
      } else {
        return this.failure(
          new Error(String(result.content)),
          duration,
          { result: result.content }
        );
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error('MCP tool call failed', { nodeId: this.id, error });
      return this.failure(error as Error, duration);
    }
  }

  /**
   * 验证配置
   */
  validate(): string[] {
    const errors = super.validate();
    const config = this.config as MCPNodeConfig;

    if (!config.serverId) {
      errors.push('Server ID is required');
    }
    if (!config.toolName) {
      errors.push('Tool name is required');
    }

    return errors;
  }
}
