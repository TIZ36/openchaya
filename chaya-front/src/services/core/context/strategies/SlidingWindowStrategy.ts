/**
 * SlidingWindowStrategy - 滑动窗口策略
 * 保留最近 N 条消息，FIFO 淘汰旧消息
 */

import type { Message } from '../../message/types';
import type { IContextStrategy, TokenBudget, ContextConfig } from '../types';

/**
 * 滑动窗口策略
 */
export class SlidingWindowStrategy implements IContextStrategy {
  name: 'sliding_window' = 'sliding_window';

  async select(
    history: Message[],
    _newMessage: string,
    budget: TokenBudget,
    config: ContextConfig
  ): Promise<Message[]> {
    if (history.length === 0) return [];

    const windowConfig = config.window ?? { recentCount: 20, importantRoles: ['system'] };
    const { recentCount, importantRoles } = windowConfig;

    // 分离重要消息和普通消息
    const importantMessages: Message[] = [];
    const normalMessages: Message[] = [];

    for (const msg of history) {
      if (importantRoles.includes(msg.role)) {
        importantMessages.push(msg);
      } else {
        normalMessages.push(msg);
      }
    }

    // 计算可用预算
    let usedTokens = 0;
    const importantTokens = this.estimateTokens(importantMessages);
    usedTokens += importantTokens;

    // 从最新的消息开始选择
    const selectedNormal: Message[] = [];
    const recentNormal = normalMessages.slice(-recentCount);

    for (let i = recentNormal.length - 1; i >= 0; i--) {
      const msg = recentNormal[i];
      const msgTokens = this.estimateMessageTokens(msg);
      
      if (usedTokens + msgTokens <= budget.available) {
        selectedNormal.unshift(msg);
        usedTokens += msgTokens;
      } else {
        break;
      }
    }

    // 合并并按时间排序
    const result = [...importantMessages, ...selectedNormal];
    result.sort((a, b) => a.timestamp - b.timestamp);

    return result;
  }

  /**
   * 估算消息列表的 token 数
   */
  private estimateTokens(messages: Message[]): number {
    return messages.reduce((sum, msg) => sum + this.estimateMessageTokens(msg), 0);
  }

  /**
   * 估算单条消息的 token 数
   * 简单估算：中文约 2 字符/token，英文约 4 字符/token
   */
  private estimateMessageTokens(message: Message): number {
    const content = message.content || '';
    
    // 粗略估算：假设平均 3 字符/token
    let tokens = Math.ceil(content.length / 3);
    
    // 角色标记和格式开销
    tokens += 10;
    
    // 工具调用开销
    if (message.toolCalls) {
      tokens += message.toolCalls.length * 50;
    }
    
    // 媒体开销
    if (message.media) {
      tokens += message.media.length * 1000;
    }
    
    return tokens;
  }
}
