/* ============================================================
   Review 渲染层服务：桥到 electron/review.cjs。
   纯本地（userData 持久化）；非 Electron 环境降级为空操作。
   一次评审 = 抓 cwd 的 git 工作区改动 → 选 provider 跑只读评审 → 落库留历史。
   ============================================================ */

export type ReviewStatus = 'running' | 'success' | 'error' | 'aborted';

export interface ReviewFile { path: string; adds: number; dels: number; untracked: boolean }

export interface ReviewRun {
  id: string;
  cwd: string;
  provider: string;            // claude / cursor / codex / gemini / copilot
  model: string | null;
  guidance: string | null;     // 自定义评审指引（空=用默认）
  status: ReviewStatus;
  startedAt: number;
  finishedAt: number | null;
  output: string;              // 评审结果（markdown）
  error: string | null;
  sessionId: string | null;
  resumedFrom?: string | null; // 续用的上一条会话 id（null=本次新开）
  files: ReviewFile[];
  fileCount: number;
  diffBytes: number;
  truncated: boolean;          // diff 是否被截断
}

export interface ReviewPreview { ok: boolean; repo: boolean; files: ReviewFile[]; diffBytes: number; truncated: boolean }

export interface ReviewRunPayload { cwd: string; provider?: string; model?: string; guidance?: string; fresh?: boolean; resumeFrom?: string }

/** 续用会话表：provider → 该目录下可续用的会话 id。 */
export type ReviewSessions = Record<string, string>;

export type ReviewEvent =
  | { type: 'run'; run: ReviewRun }
  | { type: 'list'; cwd: string }
  | { type: 'sessions'; cwd: string }
  | { type: 'error'; error: string; cwd: string };

interface ReviewBridge {
  list(cwd?: string): Promise<{ ok: boolean; runs: ReviewRun[] }>;
  sessions(cwd: string): Promise<{ ok: boolean; sessions: ReviewSessions }>;
  resetSession(cwd: string, provider?: string): Promise<{ ok: boolean }>;
  preview(cwd: string): Promise<ReviewPreview>;
  run(payload: ReviewRunPayload): Promise<{ ok: boolean; error?: string }>;
  cancel(id: string): Promise<{ ok: boolean }>;
  delete(cwd: string, id: string): Promise<{ ok: boolean }>;
  clear(cwd: string): Promise<{ ok: boolean }>;
  onEvent(cb: (data: ReviewEvent) => void): () => void;
}

function bridge(): ReviewBridge | null {
  const w = window as any;
  return w?.chateeElectron?.review ?? null;
}

export function isReviewAvailable(): boolean { return !!bridge(); }

const EMPTY_PREVIEW: ReviewPreview = { ok: false, repo: false, files: [], diffBytes: 0, truncated: false };

export const review = {
  available: isReviewAvailable,
  list: (cwd?: string) => bridge()?.list(cwd) ?? Promise.resolve({ ok: false, runs: [] }),
  sessions: (cwd: string) => bridge()?.sessions(cwd) ?? Promise.resolve({ ok: false, sessions: {} as ReviewSessions }),
  resetSession: (cwd: string, provider?: string) => bridge()?.resetSession(cwd, provider) ?? Promise.resolve({ ok: false }),
  preview: (cwd: string) => bridge()?.preview(cwd) ?? Promise.resolve(EMPTY_PREVIEW),
  run: (payload: ReviewRunPayload) => bridge()?.run(payload) ?? Promise.resolve({ ok: false, error: 'no bridge' }),
  cancel: (id: string) => bridge()?.cancel(id) ?? Promise.resolve({ ok: false }),
  delete: (cwd: string, id: string) => bridge()?.delete(cwd, id) ?? Promise.resolve({ ok: false }),
  clear: (cwd: string) => bridge()?.clear(cwd) ?? Promise.resolve({ ok: false }),
  onEvent: (cb: (data: ReviewEvent) => void) => bridge()?.onEvent(cb) ?? (() => {}),
};
