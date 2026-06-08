/* ============================================================
   Automation —— 本地自动化任务引擎（纯本地，存 userData）。
   一个任务 = 在某工作目录(cwd)按触发器跑一条 prompt（新建 session 或绑定已有 session）。
   - 持久化：userData/automation/{tasks.json, runs.json}（按 cwd 分区只是查询，不分文件）。
   - 执行：localAgent.runHeadless（无人值守，默认 bypassPermissions）。
   - 调度：仅在 App 运行期间（30s tick）；interval 周期 + cron 定时；错过的 interval 下个 tick 补跑。
   - 链路(DAG)：task.onComplete.next[] 形成有向图；完成后把输出当 prompt 触发下游。
     启动即算一次全图环检测，处于环上的任务不参与链式触发（前端也会提示「不会执行」）。
   ============================================================ */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const { execFile } = require('child_process');
const crypto = require('crypto');
const { runHeadless, gitBin, childEnv } = require('./localAgent.cjs');

/* ---------------- git / 分支隔离 ----------------
 * automation 任务基于「工作目录的某个 branch」执行，跑在独立 git worktree 里（detached 到
 * 该分支提交），从而不受主工作区未提交改动的影响。worktree 按 (repoRoot, branch) 复用；
 * 每次运行前刷到分支最新提交 + 清干净上一轮残留。
 */
function git(cwd, args, timeout = 30000) {
  return new Promise((resolve) => {
    try {
      execFile(gitBin(), args, { cwd, env: childEnv(), maxBuffer: 32 * 1024 * 1024, timeout },
        (err, stdout, stderr) => resolve({ ok: !err, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() }));
    } catch (e) { resolve({ ok: false, stdout: '', stderr: String(e && e.message || e) }); }
  });
}
async function repoRoot(cwd) { const r = await git(cwd, ['rev-parse', '--show-toplevel']); return r.ok ? r.stdout : null; }
async function currentBranch(cwd) { const r = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']); return r.ok ? r.stdout : null; }
async function listBranches(cwd) {
  const root = await repoRoot(cwd);
  if (!root) return { ok: true, repo: false, branches: [], current: null };
  const r = await git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  const branches = r.ok ? r.stdout.split('\n').filter(Boolean) : [];
  return { ok: true, repo: true, branches, current: await currentBranch(root) };
}
function worktreeDir(root, branch) {
  const key = crypto.createHash('sha1').update(`${root}@@${branch}`).digest('hex').slice(0, 16);
  return path.join(DIR, 'worktrees', key);
}
/** 确保 (root, branch) 的 worktree 存在并刷到分支最新提交（detached，干净）。返回执行目录。 */
async function ensureWorktree(cwd, branch) {
  const root = await repoRoot(cwd);
  if (!root) return { ok: false, error: 'not a git repo' };
  const ver = await git(root, ['rev-parse', '--verify', '--quiet', branch]);
  if (!ver.ok || !ver.stdout) return { ok: false, error: `分支不存在：${branch}` };
  const wt = worktreeDir(root, branch);
  if (!fs.existsSync(path.join(wt, '.git'))) {
    try { fs.mkdirSync(path.dirname(wt), { recursive: true }); } catch { /* */ }
    const add = await git(root, ['worktree', 'add', '--detach', wt, branch], 120000);
    if (!add.ok && !fs.existsSync(path.join(wt, '.git'))) {
      await git(root, ['worktree', 'prune']);
      const retry = await git(root, ['worktree', 'add', '--detach', wt, branch], 120000);
      if (!retry.ok) return { ok: false, error: `创建 worktree 失败：${retry.stderr || add.stderr}` };
    }
  }
  // 刷到分支最新提交 + 丢弃上一轮残留（隔离主工作区的未提交改动）。
  await git(wt, ['checkout', '--detach', '--force', branch], 60000);
  await git(wt, ['reset', '--hard', branch], 60000);
  await git(wt, ['clean', '-ffd'], 60000);
  return { ok: true, dir: wt, root };
}

let DIR = '';
let TASKS_FILE = '';
let RUNS_FILE = '';

let tasks = [];                 // AutomationTask[]
let runs = {};                  // taskId -> Run[]（新→旧，封顶 RUNS_CAP）
const running = new Set();      // 正在跑的 taskId（overlap=skip 用）
const aborters = new Map();     // taskId -> AbortController
let tickTimer = null;
const lastTickByTask = new Map();   // taskId -> 上次 cron 命中的分钟戳（防同分钟重复）

const RUNS_CAP = 50;            // 每任务保留的运行记录上限
const RUN_OUTPUT_CAP = 200_000; // 单条 run 输出落盘上限（防膨胀）
const CHAIN_OUTPUT_CAP = 60_000;// 链式传给下游 prompt 的输出截断
const MAX_CHAIN_DEPTH = 50;     // 链式触发深度保险

/* ---------------- 持久化 ---------------- */
function ensureDirs() {
  DIR = path.join(app.getPath('userData'), 'automation');
  TASKS_FILE = path.join(DIR, 'tasks.json');
  RUNS_FILE = path.join(DIR, 'runs.json');
  try { fs.mkdirSync(DIR, { recursive: true }); } catch { /* */ }
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
async function atomicWrite(file, data) {
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}
let saveTasksTimer = null, saveRunsTimer = null;
function saveTasks() { clearTimeout(saveTasksTimer); saveTasksTimer = setTimeout(() => { atomicWrite(TASKS_FILE, tasks).catch(() => {}); }, 120); }
function saveRuns() { clearTimeout(saveRunsTimer); saveRunsTimer = setTimeout(() => { atomicWrite(RUNS_FILE, runs).catch(() => {}); }, 200); }

function load() {
  ensureDirs();
  tasks = readJson(TASKS_FILE, []);
  runs = readJson(RUNS_FILE, {});
  if (!Array.isArray(tasks)) tasks = [];
  if (!runs || typeof runs !== 'object') runs = {};
}

/* ---------------- 事件广播 ---------------- */
function broadcast(ev) {
  for (const w of BrowserWindow.getAllWindows()) {
    try { if (!w.isDestroyed()) w.webContents.send('automation:event', ev); } catch { /* */ }
  }
}

/* ---------------- 图 / 环检测 ---------------- */
function buildGraph() {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const adj = new Map();   // id -> [nextId...]
  for (const t of tasks) {
    const next = ((t.onComplete && t.onComplete.next) || []).map((e) => e.taskId).filter((id) => byId.has(id));
    adj.set(t.id, next);
  }
  // Tarjan-lite：DFS 找处于环上的节点（在递归栈里回边即环）。
  const color = new Map();   // 0 未访问 / 1 在栈 / 2 完成
  const inCycle = new Set();
  const stack = [];
  const dfs = (u) => {
    color.set(u, 1); stack.push(u);
    for (const v of (adj.get(u) || [])) {
      if (color.get(v) === 1) { // 回边 → 标记栈上从 v 到 u 的整段
        const i = stack.lastIndexOf(v);
        for (let k = i; k < stack.length; k++) inCycle.add(stack[k]);
      } else if (!color.get(v)) dfs(v);
    }
    stack.pop(); color.set(u, 2);
  };
  for (const t of tasks) if (!color.get(t.id)) dfs(t.id);
  // 弱连通分量（把链路成组展示用）。
  const undirected = new Map();
  const link = (a, b) => { if (!undirected.has(a)) undirected.set(a, new Set()); undirected.get(a).add(b); };
  for (const [u, vs] of adj) { for (const v of vs) { link(u, v); link(v, u); } }
  const comp = new Map(); let cid = 0;
  for (const t of tasks) {
    if (comp.has(t.id)) continue;
    const has = (undirected.get(t.id) && undirected.get(t.id).size) || ((adj.get(t.id) || []).length);
    if (!has) continue;   // 孤立节点不算链
    const id = cid++; const q = [t.id]; comp.set(t.id, id);
    while (q.length) { const x = q.shift(); for (const y of (undirected.get(x) || [])) if (!comp.has(y)) { comp.set(y, id); q.push(y); } }
  }
  return { adj, inCycle, comp };
}

function graphSummary() {
  const { adj, inCycle, comp } = buildGraph();
  const chains = new Map();   // compId -> { tasks:[ids], cwds:Set, hasCycle }
  for (const [id, c] of comp) {
    if (!chains.has(c)) chains.set(c, { tasks: [], cwds: new Set(), hasCycle: false });
    const ch = chains.get(c);
    ch.tasks.push(id);
    const t = tasks.find((x) => x.id === id); if (t) ch.cwds.add(t.cwd);
    if (inCycle.has(id)) ch.hasCycle = true;
  }
  const nameOf = new Map(tasks.map((t) => [t.id, t.name]));
  const cwdOf = new Map(tasks.map((t) => [t.id, t.cwd]));
  // 全局节点（带全配置，供画布只读展示）+ 富边（passOutput / onlyIfSuccess / 是否环上）。
  const nodes = tasks.map((t) => ({
    id: t.id, name: t.name, cwd: t.cwd, enabled: !!t.enabled, cyc: inCycle.has(t.id),
    trigger: t.trigger || { kind: 'manual' },
    target: t.target || { kind: 'new' },
    branch: t.branch || '',
    provider: t.provider || 'claude',
    permMode: t.permMode || 'bypassPermissions',
    overlap: t.overlap || 'skip',
    prompt: t.prompt || '',
  }));
  const richEdges = [];
  const byId2 = new Set(tasks.map((t) => t.id));
  for (const t of tasks) for (const e of ((t.onComplete && t.onComplete.next) || [])) {
    if (!byId2.has(e.taskId)) continue;
    richEdges.push({ from: t.id, to: e.taskId, passOutput: !!e.passOutput, onlyIfSuccess: !!e.onlyIfSuccess, cyc: inCycle.has(t.id) && inCycle.has(e.taskId) });
  }
  return {
    nodes,
    edges: richEdges,
    inCycle: [...inCycle],
    chains: [...chains.values()].map((ch) => ({
      tasks: ch.tasks,
      nodes: ch.tasks.map((id) => ({ id, name: nameOf.get(id) || id, cwd: cwdOf.get(id) || '', cyc: inCycle.has(id) })),
      cwds: [...ch.cwds], hasCycle: ch.hasCycle,
    })),
  };
}

/* ---------------- 运行 ---------------- */
function recordRun(run) {
  const arr = runs[run.taskId] || (runs[run.taskId] = []);
  arr.unshift(run);
  if (arr.length > RUNS_CAP) arr.length = RUNS_CAP;
  saveRuns();
  broadcast({ type: 'run', run });
}
function updateRun(run, patch) {
  Object.assign(run, patch);
  saveRuns();
  broadcast({ type: 'run', run });
}

const newId = (p) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

async function runTask(task, opts = {}) {
  const { triggeredBy = 'manual', inputOutput, depth = 0 } = opts;
  if (!task || !task.cwd) return null;
  if (running.has(task.id)) {
    if ((task.overlap || 'skip') === 'skip') {
      recordRun({ id: newId('run'), taskId: task.id, cwd: task.cwd, startedAt: Date.now(), finishedAt: Date.now(), status: 'skipped', output: '', error: '上一轮仍在运行（overlap=skip）', triggeredBy });
      return null;
    }
    // parallel：允许并跑（不拦）
  }
  running.add(task.id);
  const ac = new AbortController();
  aborters.set(task.id, ac);
  const run = { id: newId('run'), taskId: task.id, cwd: task.cwd, startedAt: Date.now(), finishedAt: null, status: 'running', output: '', error: null, sessionId: null, triggeredBy };
  recordRun(run);

  // 链式：上游输出作为本任务 prompt（截断）；否则用任务自身 prompt。
  const upstream = (inputOutput || '').slice(0, CHAIN_OUTPUT_CAP);
  const basePrompt = task.prompt || '';
  const prompt = upstream
    ? (basePrompt ? `${basePrompt}\n\n---\n上游任务输出：\n${upstream}` : upstream)
    : basePrompt;

  task.lastRunAt = Date.now();
  saveTasks();

  // 分支隔离：target=new 且指定了 branch → 在独立 worktree（detached 到该分支提交）里跑，
  // 不受主工作区未提交改动影响。bind（续接已有会话）必须回到原 cwd，故不隔离。
  const bind = task.target && task.target.kind === 'bind';
  let runCwd = task.cwd;
  let branchInfo = '';
  if (!bind && task.branch) {
    const wt = await ensureWorktree(task.cwd, task.branch);
    if (!wt.ok) {
      running.delete(task.id); aborters.delete(task.id);
      updateRun(run, { finishedAt: Date.now(), status: 'error', error: wt.error || '准备分支工作区失败' });
      return run;
    }
    runCwd = wt.dir;
    branchInfo = task.branch;
  }
  updateRun(run, { cwd: runCwd, branch: branchInfo || null });

  let res;
  try {
    res = await runHeadless({
      provider: task.provider || 'claude',
      cwd: runCwd,
      sessionId: bind ? (task.target.sessionId || null) : null,
      prompt,
      permMode: task.permMode || 'bypassPermissions',
      model: task.model || undefined,
      timeoutMs: task.timeoutMs || undefined,
      signal: ac.signal,
    });
  } catch (e) {
    res = { ok: false, error: String(e && e.message || e), output: '' };
  }
  running.delete(task.id);
  aborters.delete(task.id);

  const output = (res.output || '').slice(0, RUN_OUTPUT_CAP);
  updateRun(run, { finishedAt: Date.now(), status: res.ok ? 'success' : 'error', output, error: res.ok ? null : (res.error || 'error'), sessionId: res.sessionId || null });

  // 链式触发下游（DAG，环上任务不触发）。
  const { inCycle } = buildGraph();
  if (depth < MAX_CHAIN_DEPTH && !inCycle.has(task.id)) {
    const next = (task.onComplete && task.onComplete.next) || [];
    for (const edge of next) {
      const child = tasks.find((t) => t.id === edge.taskId);
      if (!child || !child.enabled) continue;
      if (inCycle.has(child.id)) continue;                 // 下游在环上 → 不进
      if (edge.onlyIfSuccess && !res.ok) continue;
      runTask(child, { triggeredBy: 'chain', inputOutput: edge.passOutput ? output : undefined, depth: depth + 1 });
    }
  }
  return run;
}

/* ---------------- 调度（仅 App 运行期间） ---------------- */
function cronFieldMatch(field, val, min, max) {
  if (field === '*' || field == null) return true;
  for (const part of String(field).split(',')) {
    let step = 1, range = part;
    const slash = part.indexOf('/');
    if (slash >= 0) { step = parseInt(part.slice(slash + 1), 10) || 1; range = part.slice(0, slash); }
    let lo = min, hi = max;
    if (range !== '*' && range !== '') {
      const dash = range.indexOf('-');
      if (dash >= 0) { lo = parseInt(range.slice(0, dash), 10); hi = parseInt(range.slice(dash + 1), 10); }
      else { lo = hi = parseInt(range, 10); }
    }
    if (Number.isNaN(lo) || Number.isNaN(hi)) continue;
    for (let v = lo; v <= hi; v += step) if (v === val) return true;
  }
  return false;
}
function cronMatch(expr, d) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length < 5) return false;
  const [mi, ho, dom, mo, dow] = parts;
  return cronFieldMatch(mi, d.getMinutes(), 0, 59)
    && cronFieldMatch(ho, d.getHours(), 0, 23)
    && cronFieldMatch(dom, d.getDate(), 1, 31)
    && cronFieldMatch(mo, d.getMonth() + 1, 1, 12)
    && cronFieldMatch(dow, d.getDay(), 0, 6);
}
function tick() {
  const now = Date.now();
  const d = new Date();
  const minuteStamp = Math.floor(now / 60000);
  for (const t of tasks) {
    if (!t.enabled || !t.trigger) continue;
    const k = t.trigger.kind;
    if (k === 'interval') {
      const every = Number(t.trigger.everyMs) || 0;
      if (every > 0 && (now - (t.lastRunAt || 0) >= every)) runTask(t, { triggeredBy: 'schedule' });
    } else if (k === 'cron') {
      if (cronMatch(t.trigger.cron, d) && lastTickByTask.get(t.id) !== minuteStamp) {
        lastTickByTask.set(t.id, minuteStamp);
        runTask(t, { triggeredBy: 'schedule' });
      }
    }
  }
}
function startScheduler() {
  if (tickTimer) return;
  tickTimer = setInterval(tick, 30_000);
  if (tickTimer.unref) tickTimer.unref();
  setTimeout(tick, 4000);   // 启动后稍等再扫一次（补跑错过的 interval）
}

/* ---------------- IPC ---------------- */
function registerAutomation(ipcMain) {
  load();
  startScheduler();

  ipcMain.handle('automation:list', (_e, { cwd } = {}) => {
    const list = cwd ? tasks.filter((t) => t.cwd === cwd) : tasks;
    return { ok: true, tasks: list };
  });
  ipcMain.handle('automation:save', (_e, { task }) => {
    if (!task || !task.cwd || !task.name) return { ok: false, error: 'bad task' };
    const now = Date.now();
    const i = tasks.findIndex((t) => t.id === task.id);
    if (i >= 0) { tasks[i] = { ...tasks[i], ...task, updatedAt: now }; }
    else { task.id = task.id || newId('task'); task.createdAt = now; task.updatedAt = now; if (task.enabled == null) task.enabled = true; tasks.push(task); }
    saveTasks();
    broadcast({ type: 'tasks' });
    return { ok: true, task: tasks.find((t) => t.id === task.id) };
  });
  ipcMain.handle('automation:delete', (_e, { id }) => {
    tasks = tasks.filter((t) => t.id !== id);
    delete runs[id];
    // 摘掉别人指向它的链路边
    for (const t of tasks) if (t.onComplete && Array.isArray(t.onComplete.next)) t.onComplete.next = t.onComplete.next.filter((e) => e.taskId !== id);
    saveTasks(); saveRuns();
    broadcast({ type: 'tasks' });
    return { ok: true };
  });
  ipcMain.handle('automation:setEnabled', (_e, { id, enabled }) => {
    const t = tasks.find((x) => x.id === id); if (t) { t.enabled = !!enabled; t.updatedAt = Date.now(); saveTasks(); broadcast({ type: 'tasks' }); }
    return { ok: true };
  });
  ipcMain.handle('automation:runNow', (_e, { id }) => {
    const t = tasks.find((x) => x.id === id); if (!t) return { ok: false, error: 'not found' };
    runTask(t, { triggeredBy: 'manual' });   // 异步跑，事件回推
    return { ok: true };
  });
  ipcMain.handle('automation:cancel', (_e, { id }) => {
    const ac = aborters.get(id); if (ac) { try { ac.abort(); } catch { /* */ } }
    return { ok: true };
  });
  ipcMain.handle('automation:runs', (_e, { id }) => ({ ok: true, runs: runs[id] || [] }));
  ipcMain.handle('automation:graph', () => ({ ok: true, graph: graphSummary() }));
  ipcMain.handle('automation:branches', (_e, { cwd }) => listBranches(cwd));
}

module.exports = { registerAutomation };
