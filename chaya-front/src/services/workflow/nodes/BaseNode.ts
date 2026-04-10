/**
 * BaseNode - 工作流节点基类
 */

import type {
  NodeType,
  NodeDefinition,
  NodeContext,
  NodeResult,
} from '../types';
import { createLogger } from '../../core/shared/utils';

/**
 * 节点基类
 */
export abstract class BaseNode {
  protected definition: NodeDefinition;
  protected logger: ReturnType<typeof createLogger>;

  abstract readonly type: NodeType;

  constructor(definition: NodeDefinition) {
    this.definition = definition;
    this.logger = createLogger(`Node:${definition.name}`);
  }

  /**
   * 获取节点 ID
   */
  get id(): string {
    return this.definition.id;
  }

  /**
   * 获取节点名称
   */
  get name(): string {
    return this.definition.name;
  }

  /**
   * 获取节点配置
   */
  get config(): Record<string, unknown> {
    return this.definition.config;
  }

  /**
   * 执行节点（子类必须实现）
   */
  abstract execute(context: NodeContext): Promise<NodeResult>;

  /**
   * 验证节点配置
   */
  validate(): string[] {
    const errors: string[] = [];
    
    if (!this.definition.id) {
      errors.push('Node ID is required');
    }
    if (!this.definition.name) {
      errors.push('Node name is required');
    }

    return errors;
  }

  /**
   * 获取配置值
   */
  protected getConfig<T>(key: string, defaultValue?: T): T {
    const value = this.definition.config[key];
    return (value !== undefined ? value : defaultValue) as T;
  }

  /**
   * 渲染模板字符串
   */
  protected renderTemplate(
    template: string,
    variables: Record<string, unknown>
  ): string {
    return template.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
      const trimmedKey = key.trim();
      const value = this.getNestedValue(variables, trimmedKey);
      return value !== undefined ? String(value) : match;
    });
  }

  /**
   * 获取嵌套值
   */
  protected getNestedValue(obj: Record<string, unknown>, path: string): unknown {
    return path.split('.').reduce((current: unknown, key) => {
      if (current && typeof current === 'object') {
        return (current as Record<string, unknown>)[key];
      }
      return undefined;
    }, obj);
  }

  /**
   * 创建成功结果
   */
  protected success(
    outputs: Record<string, unknown>,
    duration: number,
    metadata?: Record<string, unknown>
  ): NodeResult {
    return {
      success: true,
      outputs,
      duration,
      metadata,
    };
  }

  /**
   * 创建失败结果
   */
  protected failure(
    error: Error,
    duration: number,
    outputs?: Record<string, unknown>
  ): NodeResult {
    return {
      success: false,
      outputs: outputs || {},
      error,
      duration,
    };
  }
}
