/**
 * ConditionNode - 条件分支节点
 */

import { BaseNode } from './BaseNode';
import type { NodeType, NodeContext, NodeResult } from '../types';

/**
 * 条件节点配置
 */
export interface ConditionNodeConfig {
  expression: string;        // JavaScript 表达式
  trueOutput?: string;       // 为真时的输出键
  falseOutput?: string;      // 为假时的输出键
}

/**
 * 条件节点
 */
export class ConditionNode extends BaseNode {
  readonly type: NodeType = 'condition';

  /**
   * 执行节点
   */
  async execute(context: NodeContext): Promise<NodeResult> {
    const startTime = Date.now();
    const config = this.config as ConditionNodeConfig;

    try {
      // 渲染表达式
      const expression = this.renderTemplate(config.expression, context.variables);

      // 评估表达式
      const result = this.evaluateExpression(expression, context.variables);

      const duration = Date.now() - startTime;

      this.logger.debug('Condition evaluated', {
        nodeId: this.id,
        expression,
        result,
      });

      return this.success(
        {
          result: Boolean(result),
          branch: result ? 'true' : 'false',
          [config.trueOutput || 'trueResult']: result ? true : undefined,
          [config.falseOutput || 'falseResult']: result ? undefined : true,
        },
        duration,
        { expression }
      );
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error('Condition evaluation failed', { nodeId: this.id, error });
      return this.failure(error as Error, duration);
    }
  }

  /**
   * 验证配置
   */
  validate(): string[] {
    const errors = super.validate();
    const config = this.config as ConditionNodeConfig;

    if (!config.expression) {
      errors.push('Expression is required');
    }

    return errors;
  }

  /**
   * 评估表达式
   */
  private evaluateExpression(
    expression: string,
    variables: Record<string, unknown>
  ): unknown {
    // 创建安全的执行环境
    const safeEval = new Function(
      ...Object.keys(variables),
      `"use strict"; return (${expression});`
    );

    return safeEval(...Object.values(variables));
  }
}
