/**
 * StepCollector - 步骤收集器
 * 统一管理过程步骤的收集、更新和订阅
 */

import type { ProcessStep } from '../shared/types';

/**
 * 步骤匹配器（用于更新步骤时匹配已有步骤）
 */
export interface StepMatcher {
  type: string;
  timestamp?: number;
  toolName?: string;
  agent_id?: string;
  iteration?: number;
  [key: string]: any;
}

/**
 * 步骤收集器类
 */
export class StepCollector {
  private steps: ProcessStep[] = [];
  private listeners: Set<(steps: ProcessStep[]) => void> = new Set();
  private updateTimer: number | null = null;

  /**
   * 添加步骤
   */
  addStep(step: ProcessStep): void {
    // 确保有时间戳
    if (!step.timestamp) {
      step.timestamp = Date.now();
    }

    // 检查是否已存在相同步骤（避免重复）
    const existingIndex = this.findStepIndex(step);
    if (existingIndex >= 0) {
      // 如果已存在，更新而不是添加
      this.updateStepInternal(existingIndex, step);
      return;
    }

    // 添加新步骤
    this.steps.push(step);
    this.notifyListeners();
  }

  /**
   * 更新步骤
   * 根据匹配器找到已有步骤并更新
   */
  updateStep(step: Partial<ProcessStep> & StepMatcher): void {
    const index = this.findStepIndex(step);
    if (index >= 0) {
      this.updateStepInternal(index, step);
    } else {
      // 如果找不到，作为新步骤添加
      this.addStep(step as ProcessStep);
    }
  }

  /**
   * 内部更新步骤
   */
  private updateStepInternal(index: number, updates: Partial<ProcessStep>): void {
    const existing = this.steps[index];
    this.steps[index] = {
      ...existing,
      ...updates,
      // 保留原有时间戳（除非明确更新）
      timestamp: updates.timestamp ?? existing.timestamp,
    };
    this.notifyListeners();
  }

  /**
   * 查找步骤索引
   */
  private findStepIndex(matcher: StepMatcher): number {
    return this.steps.findIndex((step) => {
      // 类型必须匹配
      if (step.type !== matcher.type) {
        return false;
      }

      // 如果提供了时间戳，必须匹配（允许一定误差，±100ms）
      if (matcher.timestamp && step.timestamp) {
        const diff = Math.abs(step.timestamp - matcher.timestamp);
        if (diff > 100) {
          return false;
        }
      }

      // 如果提供了 toolName，必须匹配
      if (matcher.toolName && step.toolName !== matcher.toolName) {
        return false;
      }

      // 如果提供了 agent_id，必须匹配
      if (matcher.agent_id && step.agent_id !== matcher.agent_id) {
        return false;
      }

      // 如果提供了 iteration，必须匹配
      if (matcher.iteration !== undefined && step.iteration !== matcher.iteration) {
        return false;
      }

      return true;
    });
  }

  /**
   * 获取步骤列表（按时间戳排序）
   */
  getSteps(): ProcessStep[] {
    return [...this.steps].sort((a, b) => {
      const tsA = a.timestamp || 0;
      const tsB = b.timestamp || 0;
      return tsA - tsB;
    });
  }

  /**
   * 订阅步骤变化
   * @returns 取消订阅函数
   */
  subscribe(listener: (steps: ProcessStep[]) => void): () => void {
    this.listeners.add(listener);
    
    // 立即通知一次当前步骤
    listener(this.getSteps());

    // 返回取消订阅函数
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 通知所有监听器（带节流）
   */
  private notifyListeners(): void {
    // 使用 requestAnimationFrame 节流，避免频繁更新
    if (this.updateTimer !== null) {
      cancelAnimationFrame(this.updateTimer);
    }

    this.updateTimer = requestAnimationFrame(() => {
      const steps = this.getSteps();
      this.listeners.forEach((listener) => {
        try {
          listener(steps);
        } catch (error) {
          console.error('[StepCollector] Listener error:', error);
        }
      });
      this.updateTimer = null;
    });
  }

  /**
   * 清空步骤
   */
  clear(): void {
    this.steps = [];
    this.notifyListeners();
  }

  /**
   * 获取步骤数量
   */
  getCount(): number {
    return this.steps.length;
  }

  /**
   * 获取特定类型的步骤
   */
  getStepsByType(type: string): ProcessStep[] {
    return this.steps.filter((step) => step.type === type);
  }

  /**
   * 获取正在运行的步骤
   */
  getRunningSteps(): ProcessStep[] {
    return this.steps.filter((step) => step.status === 'running');
  }

  /**
   * 销毁收集器（清理资源）
   */
  destroy(): void {
    if (this.updateTimer !== null) {
      cancelAnimationFrame(this.updateTimer);
      this.updateTimer = null;
    }
    this.listeners.clear();
    this.steps = [];
  }
}

