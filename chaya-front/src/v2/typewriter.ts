/**
 * 出字平滑（打字机）共享配置 —— 对话流与 CLI(本地 Agent) 流共用同一套速度档位。
 *
 * 模型 token 是突发到达的（一帧蹦 1~32 字、卡顿时整段停），直接渲染会忽快忽慢。
 * 平滑引擎把到达文本写进一个 backlog，再用 rAF 以「自适应但分段匀速」的速率逐字
 * 逼近，做到丝滑。这里只定义档位参数；引擎分别在 useChatBackend / useLocalAgent。
 */

export type TypeSpeed = 'slow' | 'normal' | 'fast';

export interface SmoothParams {
  /** 把当前积压吐完的目标时长（秒）。越小越贴近实时、越快。 */
  drainSec: number;
  /** 速率下限（字符/秒）：小段也至少这么快，避免拖沓。 */
  minRate: number;
  /** 速率上限（字符/秒）：远超任何模型吞吐，只用来逐帧平滑突发块。 */
  maxRate: number;
  /** 重估速率的间隔（毫秒）：其间固定匀速，不逐帧抖动。 */
  holdMs: number;
}

export const TYPEWRITER_PRESETS: Record<TypeSpeed, SmoothParams> = {
  // 慢：从容的打字机手感，明显能看到逐字。
  slow:   { drainSec: 0.5,  minRate: 55,  maxRate: 6000, holdMs: 420 },
  // 适中：默认。延迟≈一两帧，跟手又不突兀。holdMs 调短 → 速率重估更频繁、突发块
  // 过渡更顺；minRate 略升避免长背压时拖沓——整体更"丝滑渐进"。
  normal: { drainSec: 0.15, minRate: 280, maxRate: 6000, holdMs: 260 },
  // 快：几乎贴着到达速率，仅抹掉「整段突然蹦出」的突兀。
  fast:   { drainSec: 0.06, minRate: 800, maxRate: 6000, holdMs: 240 },
};

export interface TypewriterConfig {
  /** 关闭 → 到达即显示（旧行为，逐 chunk 直接渲染）。 */
  enabled: boolean;
  speed: TypeSpeed;
}

export const DEFAULT_TYPEWRITER: TypewriterConfig = { enabled: true, speed: 'normal' };

/** Drain time used during the finalize phase (after the stream is done) — kept
 *  short across all speeds so the tail catches up promptly without a visible lag. */
export const FINISH_DRAIN_SEC = 0.08;
