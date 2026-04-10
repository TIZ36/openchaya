/**
 * CapabilityChecker - 能力检查器
 * 评估 Agent 是否有能力回答问题
 */

import type { AgentDefinition, CapabilityAssessment, MailboxMessage } from '../../types';
import { createLogger } from '../../../core/shared/utils';
import { eventBus } from '../../../core/shared/events';

const logger = createLogger('CapabilityChecker');

/**
 * 能力检查器
 */
export class CapabilityChecker {
  private agentDef: AgentDefinition;
  private keywords: Map<string, number> = new Map(); // 关键词权重
  private topicHistory: string[] = [];

  constructor(agentDef: AgentDefinition) {
    this.agentDef = agentDef;
    this.extractKeywords();
  }

  /**
   * 评估能力
   */
  assess(message: MailboxMessage): CapabilityAssessment {
    const content = message.content.toLowerCase();
    
    // 基础评分
    let score = 0.5;
    const reasons: string[] = [];
    const requiredCapabilities: string[] = [];

    // 1. 关键词匹配
    const keywordScore = this.matchKeywords(content);
    score += keywordScore * 0.3;
    if (keywordScore > 0.5) {
      reasons.push('关键词匹配度高');
    }

    // 2. 检查是否需要工具
    const toolsNeeded = this.detectToolsNeeded(content);
    if (toolsNeeded.length > 0) {
      const hasTools = this.hasRequiredTools(toolsNeeded);
      if (hasTools) {
        score += 0.2;
        reasons.push('具备所需工具');
      } else {
        score -= 0.3;
        reasons.push('缺少所需工具');
        requiredCapabilities.push(...toolsNeeded);
      }
    }

    // 3. 检查是否需要特定知识
    const topicMatch = this.matchTopic(content);
    score += topicMatch * 0.2;

    // 4. 检查历史处理
    if (this.hasHandledSimilar(content)) {
      score += 0.1;
      reasons.push('有相关处理经验');
    }

    // 确定结果
    const canRespond = score >= 0.5;
    let suggestedAction: CapabilityAssessment['suggestedAction'];

    if (canRespond) {
      suggestedAction = 'respond';
    } else if (score >= 0.3) {
      suggestedAction = this.agentDef.behavior.learningEnabled ? 'learn' : 'delegate';
    } else {
      suggestedAction = this.agentDef.behavior.rejectUnknown ? 'reject' : 'delegate';
    }

    const assessment: CapabilityAssessment = {
      canRespond,
      confidence: Math.min(1, Math.max(0, score)),
      reason: reasons.join('；') || undefined,
      suggestedAction,
      requiredCapabilities: requiredCapabilities.length > 0 ? requiredCapabilities : undefined,
    };

    // 发送事件
    eventBus.emit('agent:capability_check', {
      agentId: this.agentDef.id,
      messageId: message.id,
      canRespond,
      confidence: assessment.confidence,
    });

    logger.debug('Capability assessed', {
      agentId: this.agentDef.id,
      messageId: message.id,
      assessment,
    });

    return assessment;
  }

  /**
   * 更新能力（学习后）
   */
  updateCapability(topic: string, keywords: string[]): void {
    for (const kw of keywords) {
      const current = this.keywords.get(kw) || 0;
      this.keywords.set(kw, Math.min(1, current + 0.1));
    }
    this.topicHistory.push(topic);
    
    logger.debug('Capability updated', {
      agentId: this.agentDef.id,
      topic,
      newKeywords: keywords.length,
    });
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * 从系统提示词提取关键词
   */
  private extractKeywords(): void {
    const prompt = this.agentDef.systemPrompt.toLowerCase();
    
    // 简单的关键词提取
    const words = prompt
      .replace(/[^\w\u4e00-\u9fa5]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1);

    // 统计词频
    const freq = new Map<string, number>();
    for (const word of words) {
      freq.set(word, (freq.get(word) || 0) + 1);
    }

    // 转换为权重
    const maxFreq = Math.max(...freq.values());
    freq.forEach((count, word) => {
      this.keywords.set(word, count / maxFreq);
    });
  }

  /**
   * 匹配关键词
   */
  private matchKeywords(content: string): number {
    const contentWords = content
      .replace(/[^\w\u4e00-\u9fa5]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1);

    let totalWeight = 0;
    let matchWeight = 0;

    this.keywords.forEach((weight, keyword) => {
      totalWeight += weight;
      if (contentWords.includes(keyword) || content.includes(keyword)) {
        matchWeight += weight;
      }
    });

    return totalWeight > 0 ? matchWeight / totalWeight : 0;
  }

  /**
   * 检测需要的工具
   */
  private detectToolsNeeded(content: string): string[] {
    const tools: string[] = [];

    // 简单的规则检测
    if (content.includes('搜索') || content.includes('search')) {
      tools.push('search');
    }
    if (content.includes('代码') || content.includes('code') || content.includes('编程')) {
      tools.push('code');
    }
    if (content.includes('文件') || content.includes('file')) {
      tools.push('file');
    }
    if (content.includes('数据库') || content.includes('database')) {
      tools.push('database');
    }

    return tools;
  }

  /**
   * 检查是否具备所需工具
   */
  private hasRequiredTools(tools: string[]): boolean {
    const availableServers = this.agentDef.capabilities.mcpServers || [];
    
    // 简化检查：假设服务器名称包含工具类型
    return tools.every((tool) =>
      availableServers.some((server) =>
        server.toLowerCase().includes(tool.toLowerCase())
      )
    );
  }

  /**
   * 匹配主题
   */
  private matchTopic(content: string): number {
    if (this.topicHistory.length === 0) return 0;

    const contentLower = content.toLowerCase();
    let matches = 0;

    for (const topic of this.topicHistory) {
      if (contentLower.includes(topic.toLowerCase())) {
        matches++;
      }
    }

    return Math.min(1, matches / 5);
  }

  /**
   * 检查是否处理过类似问题
   */
  private hasHandledSimilar(content: string): boolean {
    // 简化实现：检查主题历史
    return this.topicHistory.some((topic) =>
      content.toLowerCase().includes(topic.toLowerCase())
    );
  }
}
