/* ============================================================
   Cron 渲染层服务：桥到 electron/cron.cjs。
   provider 无关：扫的是操作系统 crontab（macOS/Linux），与任何 CLI（claude/cursor/…）无关——
   关掉终端 / 重启电脑都照跑。约定脚本与日志收进 ~/.chaya/cron/ 便于归集扫描。
   可选「睡眠补跑」：把某条升格成 macOS LaunchAgent（launchd 唤醒后补跑错过的触发）。
   纯本地；非 Electron / 非 mac·linux 环境降级。
   ============================================================ */

export interface CronJob {
  id: string;                   // chaya 任务 id（受管）或 ext-<hash>（外部已有行）
  schedule: string;             // "*/15 * * * *" 或 @daily 等
  command: string;              // 调度后的整条命令
  managed: boolean;             // 是否按我们的约定创建（带标记 / 命令在 ~/.chaya/cron/）
  name?: string;
  cwd?: string;                 // 归属工作目录（受管，标记里带）
  scriptPath?: string;
  logPath?: string;
  disabled: boolean;            // crontab 行被注释（已切到 launchd）
  offline: boolean;             // 已升格 launchd 睡眠补跑
  label: string;
  source: 'crontab' | 'harness';
  prompt?: string;              // harness 源：原 prompt
}

export interface CronListResult {
  ok: boolean;
  supported: boolean;           // 是否有 crontab（mac/linux）
  offlineSupported: boolean;    // launchd 睡眠补跑是否可用（mac）
  platform: string;
  cronDir: string;              // 约定归集目录
  jobs: CronJob[];              // OS crontab 任务
  harness: CronJob[];           // 次要：.claude/scheduled_tasks.json（需 Claude 在跑）
}

export type CronEvent =
  | { type: 'tasks' }
  | { type: 'run'; id: string; status: 'running' | 'success' | 'error'; output?: string; error?: string | null };

interface CronBridge {
  list(cwd?: string): Promise<CronListResult>;
  delete(id: string): Promise<{ ok: boolean; error?: string }>;
  offline(id: string, on: boolean): Promise<{ ok: boolean; error?: string }>;
  runNow(id: string): Promise<{ ok: boolean; output?: string; error?: string }>;
  openLog(id: string): Promise<{ ok: boolean; error?: string }>;
  tailLog(id: string, lines?: number): Promise<{ ok: boolean; text?: string; path?: string; error?: string }>;
  openDir(): Promise<{ ok: boolean; error?: string }>;
  onEvent(cb: (data: CronEvent) => void): () => void;
}

function bridge(): CronBridge | null {
  const w = window as any;
  return w?.chateeElectron?.cron ?? null;
}

export function isCronAvailable(): boolean { return !!bridge(); }

const EMPTY: CronListResult = { ok: false, supported: false, offlineSupported: false, platform: '', cronDir: '', jobs: [], harness: [] };

export const cron = {
  available: isCronAvailable,
  list: (cwd?: string) => bridge()?.list(cwd) ?? Promise.resolve(EMPTY),
  delete: (id: string) => bridge()?.delete(id) ?? Promise.resolve({ ok: false } as { ok: boolean; error?: string }),
  offline: (id: string, on: boolean) => bridge()?.offline(id, on) ?? Promise.resolve({ ok: false } as { ok: boolean; error?: string }),
  runNow: (id: string) => bridge()?.runNow(id) ?? Promise.resolve({ ok: false } as { ok: boolean; output?: string; error?: string }),
  openLog: (id: string) => bridge()?.openLog(id) ?? Promise.resolve({ ok: false } as { ok: boolean; error?: string }),
  tailLog: (id: string, lines?: number) => bridge()?.tailLog(id, lines) ?? Promise.resolve({ ok: false } as { ok: boolean; text?: string; path?: string; error?: string }),
  openDir: () => bridge()?.openDir() ?? Promise.resolve({ ok: false } as { ok: boolean; error?: string }),
  onEvent: (cb: (data: CronEvent) => void) => bridge()?.onEvent(cb) ?? (() => {}),
};

/* ── 创建提示词：让 CLI（任意 provider）按约定建 OS crontab，归集到 ~/.chaya/cron/ 便于扫描 ──
   收敛点：脚本/日志都进 ~/.chaya/cron/；crontab 行前插标记注释；cron 不展开 ~ 故用绝对路径。 */
export function cronCreatePrompt(tr: (k: string, v?: any) => string): string {
  return tr('cron.newPromptTemplate');
}

/* ── cron 表达式 → 人话（覆盖常见写法 + @ 简写；复杂表达式回退原文）── */
export function humanizeCron(expr: string, tr?: (k: string, v?: any) => string): string {
  const t = (k: string, v?: any) => (tr ? tr(k, v) : k);
  const s = String(expr || '').trim();
  if (s.startsWith('@')) {
    const map: Record<string, string> = {
      '@reboot': 'cron.atReboot', '@hourly': 'cron.atHourly', '@daily': 'cron.atDaily',
      '@midnight': 'cron.atDaily', '@weekly': 'cron.atWeekly', '@monthly': 'cron.atMonthly',
      '@yearly': 'cron.atYearly', '@annually': 'cron.atYearly',
    };
    return map[s] ? t(map[s]) : s;
  }
  const parts = s.split(/\s+/);
  if (parts.length < 5) return expr;
  const [mi, ho, dom, mo, dow] = parts;
  const stepEvery = (f: string) => { const m = /^\*\/(\d+)$/.exec(f); return m ? parseInt(m[1], 10) : null; };
  const hhmm = (h: string, m: string) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  const sm = stepEvery(mi);
  if (sm && ho === '*' && dom === '*' && mo === '*' && dow === '*') return t('cron.everyNMin', { n: sm });
  const sh = stepEvery(ho);
  if (sh && /^\d+$/.test(mi) && dom === '*' && mo === '*' && dow === '*') return t('cron.everyNHour', { n: sh });
  if (/^\d+$/.test(mi) && ho === '*' && dom === '*' && mo === '*' && dow === '*') return t('cron.hourlyAt', { m: mi });
  if (/^\d+$/.test(mi) && /^\d+$/.test(ho) && dom === '*' && mo === '*' && dow === '*') return t('cron.dailyAt', { time: hhmm(ho, mi) });
  if (/^\d+$/.test(mi) && /^\d+$/.test(ho) && dom === '*' && mo === '*' && /^\d+$/.test(dow)) {
    return t('cron.weeklyAt', { day: t(`cron.dow.${parseInt(dow, 10) % 7}`), time: hhmm(ho, mi) });
  }
  if (/^\d+$/.test(mi) && /^\d+$/.test(ho) && /^\d+$/.test(dom) && mo === '*' && dow === '*') {
    return t('cron.monthlyAt', { d: dom, time: hhmm(ho, mi) });
  }
  return expr;
}
