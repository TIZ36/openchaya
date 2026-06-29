/* ============================================================
   Automation 渲染层服务：桥到 electron/automation.cjs。
   纯本地（userData 持久化）；非 Electron 环境降级为空操作。
   ============================================================ */
export type AutoTriggerKind = 'manual' | 'interval' | 'cron';
export type AutoTargetKind = 'new' | 'bind';
export type AutoOverlap = 'skip' | 'parallel';

export interface AutoTrigger { kind: AutoTriggerKind; everyMs?: number; cron?: string }
export interface AutoTarget { kind: AutoTargetKind; sessionId?: string | null }
export interface AutoChainEdge { taskId: string; passOutput: boolean; onlyIfSuccess: boolean }

export interface AutomationTask {
  id: string;
  cwd: string;
  name: string;
  enabled: boolean;
  provider?: string;          // claude / cursor / codex / gemini
  model?: string;
  permMode?: string;          // 默认 bypassPermissions（无人值守）
  prompt: string;
  branch?: string;            // 基于此分支执行（独立 worktree，隔离主工作区未提交改动）；空=直接在 cwd 跑
  target: AutoTarget;
  trigger: AutoTrigger;
  onComplete?: { next: AutoChainEdge[] };
  overlap?: AutoOverlap;
  timeoutMs?: number;
  lastRunAt?: number;
  createdAt?: number;
  updatedAt?: number;
}

export type RunStatus = 'running' | 'success' | 'error' | 'skipped';
export interface AutomationRun {
  id: string;
  taskId: string;
  cwd: string;
  startedAt: number;
  finishedAt: number | null;
  status: RunStatus;
  output: string;
  error: string | null;
  sessionId: string | null;
  branch?: string | null;
  triggeredBy: 'manual' | 'schedule' | 'chain';
}

export interface BranchInfo { ok: boolean; repo: boolean; branches: string[]; current: string | null }

export interface AutomationGraphNode {
  id: string; name: string; cwd: string; cyc: boolean; enabled?: boolean;
  trigger?: AutoTrigger; target?: AutoTarget; branch?: string;
  provider?: string; permMode?: string; overlap?: string; prompt?: string;
}
export interface AutomationGraphEdge { from: string; to: string; passOutput?: boolean; onlyIfSuccess?: boolean; cyc?: boolean }
export interface AutomationGraph {
  nodes?: AutomationGraphNode[];
  edges: AutomationGraphEdge[];
  inCycle: string[];
  chains: { tasks: string[]; nodes?: AutomationGraphNode[]; cwds: string[]; hasCycle: boolean }[];
}

interface AutomationBridge {
  list(cwd?: string): Promise<{ ok: boolean; tasks: AutomationTask[] }>;
  save(task: Partial<AutomationTask>): Promise<{ ok: boolean; task?: AutomationTask; error?: string }>;
  delete(id: string): Promise<{ ok: boolean }>;
  setEnabled(id: string, enabled: boolean): Promise<{ ok: boolean }>;
  runNow(id: string): Promise<{ ok: boolean; error?: string }>;
  cancel(id: string): Promise<{ ok: boolean }>;
  runs(id: string): Promise<{ ok: boolean; runs: AutomationRun[] }>;
  graph(): Promise<{ ok: boolean; graph: AutomationGraph }>;
  branches(cwd: string): Promise<BranchInfo>;
  onEvent(cb: (data: { type: 'run' | 'tasks'; run?: AutomationRun }) => void): () => void;
}

function bridge(): AutomationBridge | null {
  const w = window as any;
  return w?.chateeElectron?.automation ?? null;
}

export function isAutomationAvailable(): boolean { return !!bridge(); }

const EMPTY_GRAPH: AutomationGraph = { edges: [], inCycle: [], chains: [] };

export const automation = {
  available: isAutomationAvailable,
  list: (cwd?: string) => bridge()?.list(cwd) ?? Promise.resolve({ ok: false, tasks: [] }),
  save: (task: Partial<AutomationTask>) => bridge()?.save(task) ?? Promise.resolve({ ok: false }),
  delete: (id: string) => bridge()?.delete(id) ?? Promise.resolve({ ok: false }),
  setEnabled: (id: string, enabled: boolean) => bridge()?.setEnabled(id, enabled) ?? Promise.resolve({ ok: false }),
  runNow: (id: string) => bridge()?.runNow(id) ?? Promise.resolve({ ok: false }),
  cancel: (id: string) => bridge()?.cancel(id) ?? Promise.resolve({ ok: false }),
  runs: (id: string) => bridge()?.runs(id) ?? Promise.resolve({ ok: false, runs: [] }),
  graph: () => bridge()?.graph() ?? Promise.resolve({ ok: false, graph: EMPTY_GRAPH }),
  branches: (cwd: string) => bridge()?.branches(cwd) ?? Promise.resolve({ ok: false, repo: false, branches: [], current: null } as BranchInfo),
  onEvent: (cb: (data: { type: 'run' | 'tasks'; run?: AutomationRun }) => void) => bridge()?.onEvent(cb) ?? (() => {}),
};
