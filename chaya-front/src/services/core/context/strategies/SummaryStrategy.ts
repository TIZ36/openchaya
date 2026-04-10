/**
 * SummaryStrategy - 摘要策略
 * 旧消息摘要压缩 + 最近消息完整保留
 */

import type { Message } from '../../message/types';
import type { IContextStrategy, TokenBudget, ContextConfig } from '../types';

/**
 * 摘要策略
 */
export class SummaryStrategy implements IContextStrategy {
  name: 'summary' = 'summary';

  private summaryCallback?: (messages: Message[]) => Promise<string>;

  /**
   * 设置摘要回调
   */
  setSummaryCallback(callback: (messages: Message[]) => Promise<string>): void {
    this.summaryCallback = callback;
  }

  async select(
    history: Message[],
    _newMessage: string,
    budget: TokenBudget,
    config: ContextConfig
  ): Promise<Message[]> {
    if (history.length === 0) return [];

    const summaryConfig = config.summary ?? { enabled: true, threshold: 50 };
    const windowConfig = config.window ?? { recentCount: 20, importantRoles: ['system'] };

    // 如果消息数量未超过阈值，使用滑动窗口
    if (history.length <= summaryConfig.threshold) {
      return this.selectWithWindow(history, budget, windowConfig);
    }

    // 分离系统消息
    const systemMessages = history.filter((m) => m.role === 'system');
    const nonSystemMessages = history.filter((m) => m.role !== 'system');

    // 分离最近消息和需要摘要的消息
    const recentCount = windowConfig.recentCount;
    const recentMessages = nonSystemMessages.slice(-recentCount);
    const oldMessages = nonSystemMessages.slice(0, -recentCount);

    // 生成摘要
    let summaryMessage: Message | null = null;
    if (oldMessages.length > 0 && this.summaryCallback) {
      try {
        const summaryContent = await this.summaryCallback(oldMessages);
        summaryMessage = {
          id: 'summary',
          sessionId: history[0].sessionId,
          role: 'system',
          content: `[历史对话摘要]\n${summaryContent}`,
          timestamp: oldMessages[oldMessages.length - 1].timestamp,
        };
      } catch (error) {
        console.error('[SummaryStrategy] Failed to generate summary:', error);
      }
    }

    // 组装结果
    const result: Message[] = [];

    // 添加系统消息
    result.push(...systemMessages);

    // 添加摘要
    if (summaryMessage) {
      result.push(summaryMessage);
    }

    // 添加最近消息（在 token 预算内）
    let usedTokens = this.estimateTokens(result);
    for (const msg of recentMessages) {
      const msgTokens = this.estimateMessageTokens(msg);
      if (usedTokens + msgTokens <= budget.available) {
        result.push(msg);
        usedTokens += msgTokens;
      }
    }

    // 按时间排序
    result.sort((a, b) => a.timestamp - b.timestamp);

    return result;
  }

  /**
   * 使用滑动窗口选择
   */
  private selectWithWindow(
    history: Message[],
    budget: TokenBudget,
    windowConfig: { recentCount: number; importantRoles: string[] }
  ): Message[] {
    const { recentCount, importantRoles } = windowConfig;

    const importantMessages = history.filter((m) => importantRoles.includes(m.role));
    const normalMessages = history.filter((m) => !importantRoles.includes(m.role));
    const recentNormal = normalMessages.slice(-recentCount);

    let usedTokens = this.estimateTokens(importantMessages);
    const selected: Message[] = [...importantMessages];

    for (const msg of recentNormal) {
      const msgTokens = this.estimateMessageTokens(msg);
      if (usedTokens + msgTokens <= budget.available) {
        selected.push(msg);
        usedTokens += msgTokens;
      }
    }

    selected.sort((a, b) => a.timestamp - b.timestamp);
    return selected;
  }

  private estimateTokens(messages: Message[]): number {
    return messages.reduce((sum, msg) => sum + this.estimateMessageTokens(msg), 0);
  }

  private estimateMessageTokens(message: Message): number {
    const content = message.content || '';
    let tokens = Math.ceil(content.length / 3);
    tokens += 10;
    if (message.toolCalls) {
      tokens += message.toolCalls.length * 50;
    }
    if (message.media) {
      tokens += message.media.length * 1000;
    }
    return tokens;
  }
}
