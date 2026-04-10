/**
 * RejectPolicy - 拒绝策略
 * 处理 Agent 无法回答时的策略
 */

import type { MailboxMessage, RejectPolicy as RejectPolicyType, AgentDefinition } from '../../types';
import { createLogger } from '../../../core/shared/utils';
import { eventBus } from '../../../core/shared/events';

const logger = createLogger('RejectPolicy');

/**
 * 拒绝策略处理器
 */
export class RejectPolicyHandler {
  private agentDef: AgentDefinition;
  private pendingQuestions: Map<string, PendingQuestion> = new Map();

  constructor(agentDef: AgentDefinition) {
    this.agentDef = agentDef;
  }

  /**
   * 执行拒绝策略
   */
  async execute(
    policy: RejectPolicyType,
    message: MailboxMessage,
    reason?: string
  ): Promise<RejectResult> {
    logger.debug('Executing reject policy', {
      agentId: this.agentDef.id,
      policy,
      messageId: message.id,
    });

    switch (policy) {
      case 'silent':
        return this.executeSilent(message, reason);
      
      case 'polite':
        return this.executePolite(message, reason);
      
      case 'delegate':
        return this.executeDelegate(message, reason);
      
      case 'learn_and_wait':
        return this.executeLearnAndWait(message, reason);
      
      default:
        return this.executeSilent(message, reason);
    }
  }

  /**
   * 获取待处理问题
   */
  getPendingQuestion(messageId: string): PendingQuestion | undefined {
    return this.pendingQuestions.get(messageId);
  }

  /**
   * 获取所有待处理问题
   */
  getAllPendingQuestions(): PendingQuestion[] {
    return Array.from(this.pendingQuestions.values());
  }

  /**
   * 标记问题已解答（可学习）
   */
  markAnswered(messageId: string, answer: string, answeredBy: string): void {
    const pending = this.pendingQuestions.get(messageId);
    if (pending) {
      pending.answered = true;
      pending.answer = answer;
      pending.answeredBy = answeredBy;
      pending.answeredAt = Date.now();
    }
  }

  /**
   * 清理已解答的问题
   */
  cleanupAnswered(): PendingQuestion[] {
    const answered: PendingQuestion[] = [];
    
    this.pendingQuestions.forEach((question, id) => {
      if (question.answered) {
        answered.push(question);
        this.pendingQuestions.delete(id);
      }
    });

    return answered;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * 静默拒绝：不回复，但记录问题
   */
  private async executeSilent(
    message: MailboxMessage,
    reason?: string
  ): Promise<RejectResult> {
    // 记录问题
    this.pendingQuestions.set(message.id, {
      messageId: message.id,
      content: message.content,
      senderId: message.senderId,
      senderName: message.senderName,
      reason,
      timestamp: Date.now(),
      answered: false,
    });

    eventBus.emit('agent:rejected', {
      agentId: this.agentDef.id,
      messageId: message.id,
      reason: reason || 'silent policy',
    });

    return {
      action: 'silent',
      recorded: true,
    };
  }

  /**
   * 礼貌拒绝：回复表示不懂
   */
  private async executePolite(
    message: MailboxMessage,
    reason?: string
  ): Promise<RejectResult> {
    const response = this.generatePoliteResponse(reason);

    eventBus.emit('agent:rejected', {
      agentId: this.agentDef.id,
      messageId: message.id,
      reason: reason || 'polite policy',
    });

    return {
      action: 'polite',
      response,
      recorded: false,
    };
  }

  /**
   * 委托：建议找其他 Agent
   */
  private async executeDelegate(
    message: MailboxMessage,
    reason?: string
  ): Promise<RejectResult> {
    const response = this.generateDelegateResponse(reason);

    return {
      action: 'delegate',
      response,
      suggestDelegate: true,
      recorded: false,
    };
  }

  /**
   * 学习等待：记录问题，等待学习
   */
  private async executeLearnAndWait(
    message: MailboxMessage,
    reason?: string
  ): Promise<RejectResult> {
    // 记录问题
    this.pendingQuestions.set(message.id, {
      messageId: message.id,
      content: message.content,
      senderId: message.senderId,
      senderName: message.senderName,
      reason,
      timestamp: Date.now(),
      answered: false,
    });

    eventBus.emit('agent:rejected', {
      agentId: this.agentDef.id,
      messageId: message.id,
      reason: reason || 'learn_and_wait policy',
    });

    return {
      action: 'learn_and_wait',
      recorded: true,
      waitingForAnswer: true,
    };
  }

  /**
   * 生成礼貌回复
   */
  private generatePoliteResponse(reason?: string): string {
    const responses = [
      '抱歉，这个问题超出了我的知识范围。',
      '很遗憾，我目前还不具备回答这个问题的能力。',
      '对不起，这个问题我不太确定怎么回答。',
    ];

    let response = responses[Math.floor(Math.random() * responses.length)];
    
    if (reason) {
      response += ` (${reason})`;
    }

    return response;
  }

  /**
   * 生成委托回复
   */
  private generateDelegateResponse(reason?: string): string {
    return '这个问题可能需要其他专业的助手来回答。' + (reason ? ` (${reason})` : '');
  }
}

/**
 * 拒绝结果
 */
export interface RejectResult {
  action: RejectPolicyType;
  response?: string;
  recorded: boolean;
  suggestDelegate?: boolean;
  waitingForAnswer?: boolean;
}

/**
 * 待处理问题
 */
export interface PendingQuestion {
  messageId: string;
  content: string;
  senderId: string;
  senderName: string;
  reason?: string;
  timestamp: number;
  answered: boolean;
  answer?: string;
  answeredBy?: string;
  answeredAt?: number;
}
