/* ============================================================
   Review —— 本地代码评审引擎（纯本地，存 userData）。
   一次评审 = 抓「工作目录(cwd)的 git 工作区改动(vs HEAD，含未跟踪)」→ 嵌进评审 prompt →
   用所选 provider 跑一条无人值守(只读)会话 → 落库为一条评审记录（按 cwd 留历史）。
   - 只看工作区改动：不做分支隔离（要的是当前 worktree 的真实未提交改动）。
   - 自由选 provider：每条记录留 provider，便于同一份 diff 交叉跑多个 AI 对比。
   - 持久化：userData/review/runs.json（{ [cwd]: ReviewRun[] }，每目录封顶 RUNS_CAP）。
   ============================================================ */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const { execFile } = require('child_process');
const { runHeadless, gitBin, childEnv } = require('./localAgent.cjs');

const DIFF_CAP = 120_000;        // 嵌进 prompt 的 diff 文本上限（防撑爆上下文）
const UNTRACKED_FILE_CAP = 8_000; // 单个未跟踪文件内容上限
const RUNS_CAP = 50;             // 每目录保留的评审记录上限
const OUTPUT_CAP = 400_000;      // 单条评审输出落盘上限

/* ---------------- git ---------------- */
function git(cwd, args, timeout = 30000) {
  return new Promise((resolve) => {
    try {
      execFile(gitBin(), args, { cwd, env: childEnv(), maxBuffer: 64 * 1024 * 1024, timeout },
        (err, stdout, stderr) => resolve({ ok: !err, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() }));
    } catch (e) { resolve({ ok: false, stdout: '', stderr: String(e && e.message || e) }); }
  });
}
async function repoRoot(cwd) { const r = await git(cwd, ['rev-parse', '--show-toplevel']); return r.ok ? r.stdout : null; }

/** 抓工作区改动（vs HEAD，含未跟踪文件内容）。返回 { repo, files, diff, diffBytes, truncated }。 */
async function gatherWorktree(cwd) {
  const root = await repoRoot(cwd);
  if (!root) return { ok: true, repo: false, files: [], diff: '', diffBytes: 0, truncated: false };

  // 改动文件 numstat（tracked，vs HEAD；无 HEAD 的新仓库退化为不带 HEAD）。
  const files = [];
  let num = await git(root, ['-c', 'core.quotepath=false', 'diff', '--numstat', 'HEAD']);
  if (!num.ok) num = await git(root, ['-c', 'core.quotepath=false', 'diff', '--numstat']);
  if (num.ok && num.stdout) {
    for (const line of num.stdout.split('\n')) {
      const tab = line.split('\t');
      if (tab.length < 3) continue;
      const p = tab.slice(2).join('\t');
      files.push({ path: p, adds: parseInt(tab[0], 10) || 0, dels: parseInt(tab[1], 10) || 0, binary: tab[0] === '-', untracked: false });
    }
  }

  // tracked 补丁（vs HEAD）。
  let patch = await git(root, ['-c', 'core.quotepath=false', 'diff', 'HEAD']);
  if (!patch.ok) patch = await git(root, ['-c', 'core.quotepath=false', 'diff']);
  let diff = patch.ok ? patch.stdout : '';

  // 未跟踪文件：列出 + 附内容（封顶），合成「new file」块拼进 diff。
  const unt = await git(root, ['ls-files', '--others', '--exclude-standard']);
  const untracked = unt.ok && unt.stdout ? unt.stdout.split('\n').filter(Boolean) : [];
  for (const rel of untracked) {
    let content = '';
    let lines = 0;
    try {
      content = await fsp.readFile(path.join(root, rel), 'utf8');
      lines = content ? content.split('\n').length : 0;
      if (content.length > UNTRACKED_FILE_CAP) content = `${content.slice(0, UNTRACKED_FILE_CAP)}\n… [truncated]`;
    } catch { content = '[binary or unreadable]'; }
    files.push({ path: rel, adds: lines, dels: 0, binary: false, untracked: true });
    diff += `\n\ndiff --git a/${rel} b/${rel}\nnew file (untracked)\n--- /dev/null\n+++ b/${rel}\n${content.split('\n').map((l) => `+${l}`).join('\n')}`;
  }

  const truncated = diff.length > DIFF_CAP;
  if (truncated) diff = `${diff.slice(0, DIFF_CAP)}\n\n… [diff truncated at ${DIFF_CAP} chars]`;
  return { ok: true, repo: true, root, files, diff, diffBytes: Buffer.byteLength(diff), truncated };
}

/* ---------------- 评审 prompt ---------------- */
const DEFAULT_GUIDANCE = `你是资深代码评审者。请只评审下面这份「git 工作区未提交改动」(vs HEAD，含未跟踪文件)，不要评审无关的既有代码。

按严重度分级（阻断 / 重要 / 次要 / 吹毛求疵），每条指出：文件:行号、问题是什么、为什么、建议怎么改。优先覆盖：正确性 bug、安全隐患、边界情况、并发/资源泄漏；其次才是可读性/风格。
最后给一句总体结论。用中文回答。`;

function buildPrompt(guidance, wt, cwd, resuming) {
  const head = (guidance || DEFAULT_GUIDANCE).trim();
  const fileList = wt.files.map((f) => `  ${f.untracked ? '?' : 'M'} ${f.path} (+${f.adds}/-${f.dels})`).join('\n');
  // 续用会话：agent 已了解本项目/已读过的文件，无需重新铺垫，只给当前最新 diff（省上下文/token）。
  const cont = resuming
    ? '（续用上次评审会话：你已熟悉本项目，无需重新通读，只针对下面这份「当前最新」的工作区 diff 做评审。）\n\n'
    : '';
  return `${cont}${head}

工作目录：${cwd}
改动文件（${wt.files.length}）：
${fileList || '  (none)'}

=== git diff (vs HEAD) ===
${wt.diff || '(empty)'}`;
}

/** review 用只读权限档：评审不应改文件。各 provider 取最接近「只读」的档。 */
function reviewPermMode(provider) {
  if (provider === 'cursor') return 'ask';     // cursor: 只读问答
  if (provider === 'claude') return 'plan';    // claude: 只读规划
  return 'default';                            // gemini/codex/copilot: ACP 默认（runHeadless 自动放行只读）
}

let DIR = '';
let RUNS_FILE = '';
let SESS_FILE = '';
let runsByCwd = {};               // { [cwd]: ReviewRun[] }（新→旧）
let sessByCwd = {};               // { [cwd]: { [provider]: sessionId } }（续用：同目录同引擎复用会话，省上下文）
const aborters = new Map();       // runId -> AbortController

/* ---------------- 持久化 ---------------- */
function ensureDirs() {
  DIR = path.join(app.getPath('userData'), 'review');
  RUNS_FILE = path.join(DIR, 'runs.json');
  SESS_FILE = path.join(DIR, 'sessions.json');
  try { fs.mkdirSync(DIR, { recursive: true }); } catch { /* */ }
}
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
async function atomicWrite(file, data) {
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}
let saveTimer = null, saveSessTimer = null;
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { atomicWrite(RUNS_FILE, runsByCwd).catch(() => {}); }, 150); }
/** 立即落盘（新建/完成记录用）：不等防抖窗口，避免紧接着重载/退出丢记录。 */
function saveNow() { clearTimeout(saveTimer); atomicWrite(RUNS_FILE, runsByCwd).catch(() => {}); }
function saveSess() { clearTimeout(saveSessTimer); saveSessTimer = setTimeout(() => { atomicWrite(SESS_FILE, sessByCwd).catch(() => {}); }, 150); }
function load() {
  ensureDirs();
  runsByCwd = readJson(RUNS_FILE, {});
  sessByCwd = readJson(SESS_FILE, {});
  if (!runsByCwd || typeof runsByCwd !== 'object') runsByCwd = {};
  if (!sessByCwd || typeof sessByCwd !== 'object') sessByCwd = {};
  // 上次进程里跑到一半的评审（重载/退出打断）：headless 进程已随上次进程消失，
  // 这里把残留的 running 归档为 aborted，避免历史里出现永远转圈的「幽灵记录」。
  let dirty = false;
  for (const cwd of Object.keys(runsByCwd)) {
    for (const r of runsByCwd[cwd]) {
      if (r.status === 'running') { r.status = 'aborted'; r.finishedAt = r.finishedAt || Date.now(); if (!r.error) r.error = 'aborted'; dirty = true; }
    }
  }
  if (dirty) saveNow();
}
function getSession(cwd, provider) { return (sessByCwd[cwd] && sessByCwd[cwd][provider]) || null; }
function setSession(cwd, provider, sid) {
  if (!cwd || !provider || !sid) return;
  (sessByCwd[cwd] || (sessByCwd[cwd] = {}))[provider] = sid;
  saveSess();
  broadcast({ type: 'sessions', cwd });
}
function clearSession(cwd, provider) {
  if (sessByCwd[cwd]) {
    if (provider) delete sessByCwd[cwd][provider]; else delete sessByCwd[cwd];
    saveSess();
    broadcast({ type: 'sessions', cwd });
  }
}

/* ---------------- 事件广播 ---------------- */
function broadcast(ev) {
  for (const w of BrowserWindow.getAllWindows()) {
    try { if (!w.isDestroyed()) w.webContents.send('review:event', ev); } catch { /* */ }
  }
}
function recordRun(run) {
  const arr = runsByCwd[run.cwd] || (runsByCwd[run.cwd] = []);
  arr.unshift(run);
  if (arr.length > RUNS_CAP) arr.length = RUNS_CAP;
  saveNow();   // 立即落盘：新记录刚建就持久化，重载也能回显
  broadcast({ type: 'run', run });
}
function updateRun(run, patch) {
  Object.assign(run, patch);
  // 终态(成功/失败/中止)立即落盘；运行中的中间态防抖即可。
  if (run.status && run.status !== 'running') saveNow(); else save();
  broadcast({ type: 'run', run });
}

const newId = (p) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/* ---------------- 运行 ---------------- */
/* 并发护栏：同一 目录×引擎 只允许一条评审在跑（交叉 AI 用不同 provider，互不挡）。
 * 否则连点「评审」会堆出多条无人值守的 headless 子进程。 */
const runningKeys = new Set();

async function runReview({ cwd, provider = 'claude', model, guidance, fresh = false, resumeFrom } = {}) {
  if (!cwd) return { ok: false, error: 'no dir' };
  const runKey = `${cwd}::${provider}`;
  if (runningKeys.has(runKey)) return { ok: false, error: 'already running' };
  runningKeys.add(runKey);
  try {
    return await runReviewInner({ cwd, provider, model, guidance, fresh, resumeFrom });
  } finally {
    runningKeys.delete(runKey);
  }
}

async function runReviewInner({ cwd, provider, model, guidance, fresh, resumeFrom }) {
  const wt = await gatherWorktree(cwd);
  if (!wt.repo) return { ok: false, error: 'not a git repo' };
  if (!wt.files.length) return { ok: false, error: 'clean' };

  // 续用会话（省上下文/token）：优先用显式指定的 resumeFrom（用户在 UI 选了某条历史评审结果，
  // 相当于在那个会话里继续触发），否则回落到该目录该引擎最近一次会话；fresh=true 强制新开。
  const resumeId = fresh ? null : (resumeFrom || getSession(cwd, provider));

  const run = {
    id: newId('rev'), cwd, provider, model: model || null, guidance: guidance || null,
    status: 'running', startedAt: Date.now(), finishedAt: null,
    output: '', error: null, sessionId: null, resumedFrom: resumeId,
    files: wt.files.map((f) => ({ path: f.path, adds: f.adds, dels: f.dels, untracked: !!f.untracked })),
    fileCount: wt.files.length, diffBytes: wt.diffBytes, truncated: wt.truncated,
  };
  recordRun(run);

  const ac = new AbortController();
  aborters.set(run.id, ac);
  const prompt = buildPrompt(guidance, wt, cwd, !!resumeId);

  let res;
  try {
    res = await runHeadless({
      provider, cwd, sessionId: resumeId, prompt,
      permMode: reviewPermMode(provider),
      model: model || undefined,
      signal: ac.signal,
    });
  } catch (e) {
    res = { ok: false, error: String(e && e.message || e), output: '' };
  }
  aborters.delete(run.id);

  const aborted = res.error === 'aborted';
  const sid = res.sessionId || resumeId || null;
  updateRun(run, {
    finishedAt: Date.now(),
    status: aborted ? 'aborted' : (res.ok ? 'success' : 'error'),
    output: (res.output || '').slice(0, OUTPUT_CAP),
    error: res.ok ? null : (res.error || 'error'),
    sessionId: sid,
  });
  // 记住会话 id 供下次续用（中止/失败若已拿到 id 也记，便于接着聊）。
  if (sid) setSession(cwd, provider, sid);
  return { ok: true, run };
}

/* ---------------- IPC ---------------- */
function registerReview(ipcMain) {
  load();
  ipcMain.handle('review:list', (_e, { cwd } = {}) => ({ ok: true, runs: (cwd && runsByCwd[cwd]) || [] }));
  ipcMain.handle('review:sessions', (_e, { cwd } = {}) => ({ ok: true, sessions: (cwd && sessByCwd[cwd]) || {} }));
  ipcMain.handle('review:resetSession', (_e, { cwd, provider } = {}) => { clearSession(cwd, provider); return { ok: true }; });
  ipcMain.handle('review:preview', async (_e, { cwd } = {}) => {
    const wt = await gatherWorktree(cwd);
    return { ok: wt.ok, repo: wt.repo, files: wt.files, diffBytes: wt.diffBytes, truncated: wt.truncated };
  });
  ipcMain.handle('review:run', (_e, payload = {}) => {
    runReview(payload).then((r) => { if (!r.ok) broadcast({ type: 'error', error: r.error, cwd: payload.cwd }); });
    return { ok: true };   // 异步跑，结果走事件
  });
  ipcMain.handle('review:cancel', (_e, { id }) => {
    const ac = aborters.get(id); if (ac) { try { ac.abort(); } catch { /* */ } }
    return { ok: true };
  });
  ipcMain.handle('review:delete', (_e, { cwd, id }) => {
    if (cwd && runsByCwd[cwd]) { runsByCwd[cwd] = runsByCwd[cwd].filter((r) => r.id !== id); save(); broadcast({ type: 'list', cwd }); }
    return { ok: true };
  });
  ipcMain.handle('review:clear', (_e, { cwd }) => {
    if (cwd) { delete runsByCwd[cwd]; save(); broadcast({ type: 'list', cwd }); }
    return { ok: true };
  });
}

module.exports = { registerReview };
