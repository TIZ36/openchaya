/**
 * Agent - Agent Actor 模型实现
 * 整合邮箱、能力检查、学习、记忆等模块
 */

import type {
  AgentDefinition,
  AgentStatus,
  MailboxMessage,
  CapabilityAssessment,
  RejectPolicy,
} from './types';
import { Mailbox, type MessageHandler } from './agent/mailbox';
import { CapabilityChecker, RejectPolicyHandler } from './agent/capability';
import { KnowledgeObserver, KnowledgeAbsorber } from './agent/learning';
import { MemoryStore, MemoryRetrieval, MemoryConsolidation } from './memory';
import { VoicePersonaManager, AutonomousThinking, MemoryTrigger } from './persona';
import { createProvider, type ILLMProvider, type LLMMessage } from '../providers/llm';
import { createLogger } from '../core/shared/utils';
import { eventBus } from '../core/shared/events';

const logger = createLogger('Agent');

/**
 * Agent 类
 */
export class Agent {
  private definition: AgentDefinition;
  private status: AgentStatus = 'idle';
  
  // 核心组件
  private mailbox: Mailbox;
  private capabilityChecker: CapabilityChecker;
  private rejectHandler: RejectPolicyHandler;
  private knowledgeObserver: KnowledgeObserver;
  private knowledgeAbsorber: KnowledgeAbsorber;
  private memoryStore: MemoryStore;
  private memoryRetrieval: MemoryRetrieval;
  private memoryConsolidation: MemoryConsolidation;
  private voicePersona: VoicePersonaManager;
  private autonomousThinking: AutonomousThinking;
  private memoryTrigger: MemoryTrigger;
  
  // LLM Provider
  private llmProvider?: ILLMProvider;
  
  // 回调
  private responseCallback?: (message: string, replyTo?: string) => void;

  constructor(definition: AgentDefinition) {
    this.definition = definition;
    
    // 初始化组件
    this.mailbox = new Mailbox(definition.id);
    this.capabilityChecker = new CapabilityChecker(definition);
    this.rejectHandler = new RejectPolicyHandler(definition);
    this.knowledgeObserver = new KnowledgeObserver(definition.id);
    this.knowledgeAbsorber = new KnowledgeAbsorber(definition.id);
    this.memoryStore = new MemoryStore(definition.id);
    this.memoryRetrieval = new MemoryRetrieval(this.memoryStore);
    this.memoryConsolidation = new MemoryConsolidation(this.memoryStore);
    this.voicePersona = new VoicePersonaManager(definition.id);
    this.autonomousThinking = new AutonomousThinking(definition.id);
    this.memoryTrigger = new MemoryTrigger(definition.id, this.memoryStore);
    
    // 设置邮箱处理器
    this.mailbox.setHandler(this.handleMessage.bind(this));
    
    // 设置思考处理器
    this.autonomousThinking.setHandler(this.thinkAbout.bind(this));
    
    logger.info('Agent created', { id: definition.id, name: definition.name });
  }

  // ============================================================================
  // Getters
  // ============================================================================

  get id(): string {
    return this.definition.id;
  }

  get name(): string {
    return this.definition.name;
  }

  get currentStatus(): AgentStatus {
    return this.status;
  }

  // ============================================================================
  // Public API
  // ============================================================================

  /**
   * 初始化 Agent
   */
  async init(): Promise<void> {
    // 创建 LLM Provider
    this.llmProvider = createProvider({
      provider: this.definition.capabilities.llmProvider as any,
      model: this.definition.capabilities.llmModel,
    });
    
    // 启动记忆整合
    this.memoryConsolidation.start();
    
    // 如果启用自驱思考，启动
    if (this.definition.behavior.proactive) {
      this.autonomousThinking.start();
    }
    
    logger.info('Agent initialized', { id: this.id });
  }

  /**
   * 接收消息
   */
  receive(
    senderId: string,
    senderName: string,
    content: string,
    options?: {
      priority?: MailboxMessage['priority'];
      replyTo?: string;
    }
  ): MailboxMessage {
    return this.mailbox.send(senderId, senderName, content, options);
  }

  /**
   * 设置响应回调
   */
  onResponse(callback: (message: string, replyTo?: string) => void): void {
    this.responseCallback = callback;
  }

  /**
   * 观察其他 Agent 的回答
   */
  observe(
    questionId: string,
    question: string,
    answer: string,
    sourceAgentId: string,
    sourceAgentName: string
  ): boolean {
    return this.knowledgeObserver.observe(
      questionId,
      question,
      answer,
      sourceAgentId,
      sourceAgentName
    );
  }

  /**
   * 执行知识学习
   */
  async learnFromObservations(): Promise<number> {
    const records = this.knowledgeObserver.toLearningRecords();
    const results = await this.knowledgeAbsorber.absorbBatch(records);
    
    const successCount = results.filter((r) => r.success).length;
    
    // 清除已处理的观察
    this.knowledgeObserver.clear();
    
    return successCount;
  }

  /**
   * 添加记忆
   */
  addMemory(content: string, type: 'episodic' | 'semantic' | 'procedural' = 'episodic'): void {
    this.memoryStore.add(content, type);
  }

  /**
   * 检索记忆
   */
  async retrieveMemory(query: string, topK: number = 5): Promise<string[]> {
    const results = await this.memoryRetrieval.retrieve(query, { topK });
    return results.map((r) => r.memory.content);
  }

  /**
   * 获取邮箱状态
   */
  getMailboxSize(): number {
    return this.mailbox.size;
  }

  /**
   * 停止 Agent
   */
  stop(): void {
    this.mailbox.pause();
    this.memoryConsolidation.stop();
    this.autonomousThinking.stop();
    
    logger.info('Agent stopped', { id: this.id });
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * 处理邮箱消息
   */
  private async handleMessage(message: MailboxMessage): Promise<void> {
    this.status = 'thinking';

    try {
      // 1. 能力评估
      const assessment = this.capabilityChecker.assess(message);

      // 2. 根据评估结果处理
      if (assessment.canRespond) {
        await this.respond(message, assessment);
      } else {
        await this.handleRejection(message, assessment);
      }
    } catch (error) {
      logger.error('Message handling failed', {
        agentId: this.id,
        messageId: message.id,
        error,
      });
    } finally {
      this.status = 'idle';
    }
  }

  /**
   * 响应消息
   */
  private async respond(
    message: MailboxMessage,
    assessment: CapabilityAssessment
  ): Promise<void> {
    this.status = 'responding';

    if (!this.llmProvider) {
      logger.error('LLM provider not initialized', { agentId: this.id });
      return;
    }

    // 构建消息
    const messages: LLMMessage[] = [
      { role: 'system', content: this.definition.systemPrompt },
    ];

    // 检索相关记忆
    const memories = await this.memoryRetrieval.retrieve(message.content, { topK: 3 });
    if (memories.length > 0) {
      const memoryContext = memories.map((m) => m.memory.content).join('\n---\n');
      messages.push({
        role: 'system',
        content: `[相关记忆]\n${memoryContext}`,
      });
    }

    // 添加用户消息
    messages.push({
      role: 'user',
      content: `[${message.senderName}]: ${message.content}`,
    });

    try {
      const response = await this.llmProvider.chat(messages);

      // 回调响应
      if (this.responseCallback) {
        this.responseCallback(response.content, message.id);
      }

      // 保存记忆
      this.memoryStore.add(
        `问: ${message.content}\n答: ${response.content}`,
        'episodic',
        { importance: assessment.confidence }
      );

      logger.debug('Response sent', {
        agentId: this.id,
        messageId: message.id,
      });
    } catch (error) {
      logger.error('Response failed', {
        agentId: this.id,
        messageId: message.id,
        error,
      });
    }
  }

  /**
   * 处理拒绝
   */
  private async handleRejection(
    message: MailboxMessage,
    assessment: CapabilityAssessment
  ): Promise<void> {
    // 确定拒绝策略
    let policy: RejectPolicy;
    
    if (this.definition.behavior.learningEnabled) {
      policy = 'learn_and_wait';
    } else if (this.definition.behavior.rejectUnknown) {
      policy = 'silent';
    } else {
      policy = 'polite';
    }

    const result = await this.rejectHandler.execute(policy, message, assessment.reason);

    if (result.response && this.responseCallback) {
      this.responseCallback(result.response, message.id);
    }

    logger.debug('Message rejected', {
      agentId: this.id,
      messageId: message.id,
      policy,
    });
  }

  /**
   * 自驱思考
   */
  private async thinkAbout(topic: string, prompt: string): Promise<string> {
    if (!this.llmProvider) {
      throw new Error('LLM provider not initialized');
    }

    this.status = 'thinking';

    try {
      const messages: LLMMessage[] = [
        { role: 'system', content: this.definition.systemPrompt },
        { role: 'user', content: prompt },
      ];

      const response = await this.llmProvider.chat(messages);

      // 保存思考结果为记忆
      this.memoryStore.add(
        `[自驱思考 - ${topic}]\n${response.content}`,
        'semantic',
        { importance: 0.7 }
      );

      return response.content;
    } finally {
      this.status = 'idle';
    }
  }
}
