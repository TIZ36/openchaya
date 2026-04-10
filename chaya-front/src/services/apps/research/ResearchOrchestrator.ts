/**
 * ResearchOrchestrator - 研究助手编排器
 * 管理研究工作流程
 */

import { Agent, Session } from '../../session';
import { DocumentGenerator, type Document, type DocumentSection } from './DocumentGenerator';
import { createLogger, generateId } from '../../core/shared/utils';

const logger = createLogger('ResearchOrchestrator');

/**
 * 研究阶段
 */
export type ResearchPhase = 
  | 'planning'
  | 'information_gathering'
  | 'analysis'
  | 'synthesis'
  | 'writing'
  | 'review'
  | 'completed';

/**
 * 研究配置
 */
export interface ResearchConfig {
  topic: string;
  description?: string;
  depth: 'shallow' | 'medium' | 'deep';
  outputFormat: 'markdown' | 'html' | 'json';
  includeReferences: boolean;
  maxSources: number;
}

/**
 * 默认研究配置
 */
export const DEFAULT_RESEARCH_CONFIG: Partial<ResearchConfig> = {
  depth: 'medium',
  outputFormat: 'markdown',
  includeReferences: true,
  maxSources: 10,
};

/**
 * 研究记录
 */
export interface ResearchRecord {
  id: string;
  config: ResearchConfig;
  phase: ResearchPhase;
  findings: ResearchFinding[];
  outline: DocumentSection[];
  draft?: string;
  finalDocument?: string;
  startedAt: number;
  completedAt?: number;
}

/**
 * 研究发现
 */
export interface ResearchFinding {
  id: string;
  topic: string;
  content: string;
  source?: string;
  confidence: number;
  timestamp: number;
}

/**
 * 研究助手编排器
 */
export class ResearchOrchestrator {
  private config: ResearchConfig;
  private record: ResearchRecord;
  private session: Session;
  private documentGenerator: DocumentGenerator;
  private researchAgent?: Agent;

  constructor(config: ResearchConfig) {
    this.config = { ...DEFAULT_RESEARCH_CONFIG, ...config } as ResearchConfig;
    this.session = new Session('single', `Research: ${config.topic}`);
    this.documentGenerator = new DocumentGenerator();

    this.record = {
      id: generateId('research'),
      config: this.config,
      phase: 'planning',
      findings: [],
      outline: [],
      startedAt: Date.now(),
    };
  }

  // ============================================================================
  // Public API
  // ============================================================================

  /**
   * 设置研究 Agent
   */
  setAgent(agent: Agent): void {
    this.researchAgent = agent;
    this.session.addAgent(agent);

    agent.onResponse((content) => {
      this.handleAgentResponse(content);
    });

    logger.info('Research agent set', { researchId: this.record.id, agentId: agent.id });
  }

  /**
   * 开始研究
   */
  async start(): Promise<void> {
    if (!this.researchAgent) {
      throw new Error('Research agent not set');
    }

    logger.info('Research started', {
      researchId: this.record.id,
      topic: this.config.topic,
    });

    // 阶段 1: 规划
    await this.planningPhase();

    // 阶段 2: 信息收集
    await this.gatheringPhase();

    // 阶段 3: 分析
    await this.analysisPhase();

    // 阶段 4: 综合
    await this.synthesisPhase();

    // 阶段 5: 写作
    await this.writingPhase();

    // 阶段 6: 审查
    await this.reviewPhase();

    // 完成
    this.record.phase = 'completed';
    this.record.completedAt = Date.now();

    logger.info('Research completed', {
      researchId: this.record.id,
      duration: this.record.completedAt - this.record.startedAt,
    });
  }

  /**
   * 获取研究记录
   */
  getRecord(): ResearchRecord {
    return { ...this.record };
  }

  /**
   * 获取当前阶段
   */
  getPhase(): ResearchPhase {
    return this.record.phase;
  }

  /**
   * 获取最终文档
   */
  getDocument(): string | undefined {
    return this.record.finalDocument;
  }

  // ============================================================================
  // Research Phases
  // ============================================================================

  /**
   * 规划阶段
   */
  private async planningPhase(): Promise<void> {
    this.record.phase = 'planning';
    logger.debug('Planning phase started', { researchId: this.record.id });

    const prompt = `
作为研究助手，请为以下研究主题制定一个研究大纲：

主题：${this.config.topic}
${this.config.description ? `描述：${this.config.description}` : ''}
研究深度：${this.config.depth}

请提供：
1. 研究目标
2. 主要研究问题
3. 建议的章节结构
4. 需要收集的关键信息类型

请以结构化的方式回复。
    `.trim();

    await this.askAgent(prompt);
  }

  /**
   * 信息收集阶段
   */
  private async gatheringPhase(): Promise<void> {
    this.record.phase = 'information_gathering';
    logger.debug('Gathering phase started', { researchId: this.record.id });

    const prompt = `
基于之前的研究大纲，请开始收集关于"${this.config.topic}"的关键信息。

请关注：
1. 核心概念和定义
2. 主要观点和理论
3. 相关数据和事实
4. 不同视角和争议点

每个发现请注明来源（如果有的话）。
    `.trim();

    await this.askAgent(prompt);
  }

  /**
   * 分析阶段
   */
  private async analysisPhase(): Promise<void> {
    this.record.phase = 'analysis';
    logger.debug('Analysis phase started', { researchId: this.record.id });

    const findingsSummary = this.record.findings
      .map((f) => `- ${f.topic}: ${f.content.slice(0, 100)}...`)
      .join('\n');

    const prompt = `
请分析以下收集到的信息：

${findingsSummary}

请提供：
1. 关键发现的总结
2. 信息之间的关联性分析
3. 潜在的结论方向
4. 需要进一步探讨的问题
    `.trim();

    await this.askAgent(prompt);
  }

  /**
   * 综合阶段
   */
  private async synthesisPhase(): Promise<void> {
    this.record.phase = 'synthesis';
    logger.debug('Synthesis phase started', { researchId: this.record.id });

    const prompt = `
基于之前的分析，请综合所有信息，形成对"${this.config.topic}"的全面理解。

请提供：
1. 主要结论
2. 支持证据
3. 局限性和未解决的问题
4. 建议和展望
    `.trim();

    await this.askAgent(prompt);
  }

  /**
   * 写作阶段
   */
  private async writingPhase(): Promise<void> {
    this.record.phase = 'writing';
    logger.debug('Writing phase started', { researchId: this.record.id });

    const prompt = `
请基于所有研究内容，撰写关于"${this.config.topic}"的研究报告。

报告结构：
1. 摘要
2. 引言
3. 主要内容（根据大纲）
4. 结论
5. 参考文献（如适用）

请使用清晰、专业的语言。
    `.trim();

    const response = await this.askAgent(prompt);
    this.record.draft = response;
  }

  /**
   * 审查阶段
   */
  private async reviewPhase(): Promise<void> {
    this.record.phase = 'review';
    logger.debug('Review phase started', { researchId: this.record.id });

    const prompt = `
请审查以下研究报告草稿，并提出改进建议：

${this.record.draft}

请检查：
1. 内容的准确性和完整性
2. 逻辑结构和连贯性
3. 语言表达和清晰度
4. 格式和引用规范

然后提供最终修订版本。
    `.trim();

    const finalContent = await this.askAgent(prompt);

    // 生成最终文档
    const doc: Document = {
      title: this.config.topic,
      date: new Date().toISOString().split('T')[0],
      abstract: this.record.findings[0]?.content.slice(0, 200),
      sections: this.record.outline,
      references: this.config.includeReferences
        ? this.record.findings.filter((f) => f.source).map((f) => f.source!)
        : undefined,
    };

    // 使用最终内容更新章节
    if (doc.sections.length === 0) {
      doc.sections = [
        { id: '1', title: '研究报告', content: finalContent, level: 1 },
      ];
    }

    this.record.finalDocument = this.documentGenerator.generate(
      doc,
      this.config.outputFormat
    );
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * 向 Agent 提问
   */
  private async askAgent(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      let response = '';

      this.researchAgent!.onResponse((content) => {
        response = content;
        resolve(response);
      });

      this.researchAgent!.receive('researcher', 'Researcher', prompt, {
        priority: 'high',
      });

      // 超时处理
      setTimeout(() => {
        if (!response) {
          resolve('');
        }
      }, 120000);
    });
  }

  /**
   * 处理 Agent 响应
   */
  private handleAgentResponse(content: string): void {
    // 解析响应并添加到发现中
    const finding: ResearchFinding = {
      id: generateId('finding'),
      topic: this.config.topic,
      content,
      confidence: 0.8,
      timestamp: Date.now(),
    };

    this.record.findings.push(finding);
  }
}
