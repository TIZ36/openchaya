/**
 * 本地 Agent 桥 —— 纯本地功能，与 Chaya 后端无关。
 *
 * 让用户在 Chaya 的对话框里直接驱动自己机器上已安装的 CLI Agent
 * (Claude Code / Codex / Gemini)。当前 Claude Code 端到端打通，
 * codex / gemini 仅做安装探测，run/sessions 走同一抽象后续接入。
 *
 * 设计要点：
 *  - 渲染进程关闭了 nodeIntegration，所有进程操作都在主进程完成，
 *    经 preload 的 contextBridge 暴露 invoke / 事件流。
 *  - 每个用户回合 = 一次 `claude -p ... --output-format stream-json`
 *    调用（无状态进程、靠 --resume <session_id> 续接上下文），
 *    与 Chaya 的请求/响应式聊天一致，也天然落盘成可读取的 transcript。
 *  - 权限策略：YOLO —— 传 --dangerously-skip-permissions，全自动执行。
 */
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

/* GUI 启动的 Electron 在 macOS 下 PATH 很贫瘠，CLI 往往找不到。
 * 补上常见安装目录，并据此解析二进制全路径。 */
const EXTRA_PATHS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  path.join(os.homedir(), '.local', 'bin'),
  path.join(os.homedir(), '.bun', 'bin'),
  path.join(os.homedir(), '.deno', 'bin'),
  path.join(os.homedir(), '.npm-global', 'bin'),
];

function augmentedPath() {
  const cur = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const merged = [...new Set([...cur, ...EXTRA_PATHS])];
  return merged.join(path.delimiter);
}

function childEnv() {
  return { ...process.env, PATH: augmentedPath() };
}

/** 在 PATH（含补充目录）里找可执行文件全路径，找不到返回 null。 */
function resolveBin(name) {
  for (const dir of [...new Set([...(process.env.PATH || '').split(path.delimiter), ...EXTRA_PATHS])]) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* keep looking */ }
  }
  return null;
}

function getVersion(bin) {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { env: childEnv(), timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(String(stdout || '').trim().split('\n')[0] || null);
    });
  });
}

/* ------------------------------------------------------------------ *
 * Provider 抽象
 * ------------------------------------------------------------------ */
const PROVIDERS = {
  claude: { id: 'claude', label: 'Claude Code', bin: 'claude', live: true },
  codex: { id: 'codex', label: 'Codex', bin: 'codex', live: false },
  gemini: { id: 'gemini', label: 'Gemini', bin: 'gemini', live: false },
};

/** 探测已安装的本地 agent 及版本。 */
async function detect() {
  const out = [];
  for (const p of Object.values(PROVIDERS)) {
    const bin = resolveBin(p.bin);
    out.push({
      id: p.id,
      label: p.label,
      installed: !!bin,
      bin,
      live: p.live,
      version: bin ? await getVersion(bin) : null,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Claude Code 会话落盘读取
 *   ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
 * ------------------------------------------------------------------ */
function claudeProjectsRoot() {
  return path.join(os.homedir(), '.claude', 'projects');
}

/** Claude 把 cwd 编码成目录名：把 `/`、`.` 等替换成 `-`（如
 *  `/Users/x/aiproj/chaya-next` → `-Users-x-aiproj-chaya-next`）。
 *  编码规则历史上有变动，所以先按规则猜，再回退到扫描目录里
 *  实际 transcript 的 cwd 字段精确匹配。 */
function encodeCwdCandidates(cwd) {
  return [
    cwd.replace(/[/\\]/g, '-'),
    cwd.replace(/[/\\._]/g, '-'),
    cwd.replace(/[^a-zA-Z0-9]/g, '-'),
  ];
}

async function readFirstCwd(jsonlPath) {
  // 只读前若干行找 cwd，避免整文件解析。
  let fh;
  try {
    fh = await fsp.open(jsonlPath, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const lines = buf.slice(0, bytesRead).toString('utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o && typeof o.cwd === 'string') return o.cwd;
      } catch { /* partial last line, ignore */ }
    }
  } catch { /* unreadable */ } finally {
    if (fh) await fh.close().catch(() => {});
  }
  return null;
}

/** 找到 cwd 对应的 Claude project 目录，找不到返回 null。 */
async function findProjectDir(cwd) {
  const root = claudeProjectsRoot();
  // 快路径：直接命中编码候选。
  for (const cand of encodeCwdCandidates(cwd)) {
    const dir = path.join(root, cand);
    try {
      const st = await fsp.stat(dir);
      if (st.isDirectory()) return dir;
    } catch { /* miss */ }
  }
  // 慢路径：扫描所有 project 目录，按 transcript 里的真实 cwd 匹配。
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    let files;
    try {
      files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.jsonl'));
    } catch { continue; }
    if (files.length === 0) continue;
    const real = await readFirstCwd(path.join(dir, files[0]));
    if (real && real === cwd) return dir;
  }
  return null;
}

/** 列出某 cwd 下的 Claude 会话（轻量：只取标题/首条提示/时间）。 */
async function listSessions(provider, cwd) {
  // Only Claude has session-history scanning wired up. codex/gemini are
  // detection-only stubs for now, so return empty rather than leaking Claude's
  // sessions into another provider's tree. (Their dirs get added when run is.)
  if ((provider || 'claude') !== 'claude') return [];
  const dir = await findProjectDir(cwd);
  if (!dir) return [];
  let files;
  try {
    files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const sessions = await Promise.all(files.map(async (f) => {
    const full = path.join(dir, f);
    const sessionId = f.replace(/\.jsonl$/, '');
    let mtime = 0;
    try { mtime = (await fsp.stat(full)).mtimeMs; } catch { /* keep 0 */ }
    const { title, firstPrompt, turns } = await peekSession(full);
    return { sessionId, title, preview: firstPrompt, turns, updatedAt: mtime };
  }));
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return sessions;
}

/** 读前若干行，提取 ai-title / 首条 user 提示 / 粗略回合数。 */
async function peekSession(jsonlPath) {
  let title = null;
  let firstPrompt = null;
  let turns = 0;
  let fh;
  try {
    fh = await fsp.open(jsonlPath, 'r');
    const buf = Buffer.alloc(256 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const lines = buf.slice(0, bytesRead).toString('utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.type === 'ai-title' && o.title) title = o.title;
      if (o.type === 'user' && !firstPrompt) {
        const t = extractText(o.message);
        if (t) firstPrompt = t.slice(0, 120);
      }
      if (o.type === 'user') turns += 1;
    }
  } catch { /* unreadable */ } finally {
    if (fh) await fh.close().catch(() => {});
  }
  return { title, firstPrompt, turns };
}

/** 完整读取一个会话，归一化成可渲染的消息列表。 */
async function readSession(provider, cwd, sessionId) {
  if ((provider || 'claude') !== 'claude') return { messages: [] };
  const dir = await findProjectDir(cwd);
  if (!dir) return { messages: [] };
  const full = path.join(dir, `${sessionId}.jsonl`);
  let raw;
  try { raw = await fsp.readFile(full, 'utf8'); } catch { return { messages: [] }; }
  const messages = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    const parts = normalizeParts(o.message);
    if (parts.length === 0) continue;
    messages.push({ role: o.type, parts, ts: o.timestamp || null, uuid: o.uuid || null });
  }
  return { messages };
}

/** 删除一个会话 transcript。默认移到系统回收站（可恢复）；不支持则硬删。
 *  安全检查：目标必须落在 ~/.claude/projects 之内，且文件名是合法 sessionId。 */
async function deleteSession(provider, cwd, sessionId) {
  if ((provider || 'claude') !== 'claude') return { ok: false, error: 'unsupported provider' };
  if (!sessionId || /[/\\]/.test(sessionId)) return { ok: false, error: 'bad sessionId' };
  const dir = await findProjectDir(cwd);
  if (!dir) return { ok: false, error: 'project not found' };
  const full = path.join(dir, `${sessionId}.jsonl`);
  // 防越界：必须仍在 projects 根下。
  if (!full.startsWith(claudeProjectsRoot() + path.sep)) return { ok: false, error: 'out of bounds' };
  try {
    const { shell } = require('electron');   // 主进程内可用
    await shell.trashItem(full);             // → 系统回收站，可恢复
    return { ok: true, trashed: true };
  } catch {
    try { await fsp.unlink(full); return { ok: true, trashed: false }; }
    catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }
}

function extractText(message) {
  if (!message) return '';
  const c = message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.filter((p) => p.type === 'text').map((p) => p.text || '').join('\n');
  }
  return '';
}

/** message.content → [{kind:'text'|'thinking'|'tool_use'|'tool_result', ...}] */
function normalizeParts(message) {
  if (!message) return [];
  const c = message.content;
  if (typeof c === 'string') return c.trim() ? [{ kind: 'text', text: c }] : [];
  if (!Array.isArray(c)) return [];
  const out = [];
  for (const p of c) {
    if (p.type === 'text' && p.text) out.push({ kind: 'text', text: p.text });
    else if (p.type === 'thinking' && p.thinking) out.push({ kind: 'thinking', text: p.thinking });
    else if (p.type === 'tool_use') out.push({ kind: 'tool_use', name: p.name || 'tool', input: p.input, id: p.id });
    else if (p.type === 'tool_result') {
      const txt = typeof p.content === 'string'
        ? p.content
        : Array.isArray(p.content) ? p.content.map((x) => x.text || '').join('\n') : '';
      out.push({ kind: 'tool_result', text: (txt || '').slice(0, 8000), isError: !!p.is_error, toolUseId: p.tool_use_id });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 斜杠命令发现 —— 跟 VSCode 插件/Agent SDK 一个路子：
 *   权威列表来自 `system/init` 事件的 slash_commands（内置 + 自定义都在里头）。
 *   描述/来源（project/user）再从磁盘 .claude/commands 扫描补上。
 *   probe：起一个 streaming 会话，发条极简消息触发 init，拿到 slash_commands
 *   立刻 SIGKILL（在模型应答前就杀掉，几乎零开销；订阅用户更无所谓）。
 * ------------------------------------------------------------------ */
function probeSlashCommands(bin, cwd) {
  return new Promise((resolve) => {
    let child;
    let done = false;
    let buf = '';
    const finish = (names) => {
      if (done) return;
      done = true;
      try { if (child) child.kill('SIGKILL'); } catch { /* gone */ }
      resolve(names);
    };
    try {
      child = spawn(bin, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'default'],
        { cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'ignore'] });
    } catch { return resolve(null); }
    const timer = setTimeout(() => finish(null), 8000);
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line);
          if (o.type === 'system' && o.subtype === 'init') {
            clearTimeout(timer);
            return finish(Array.isArray(o.slash_commands) ? o.slash_commands : []);
          }
        } catch { /* ignore partial */ }
      }
    });
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', () => { clearTimeout(timer); finish(null); });
    // 发条极简消息触发 init（拿到就杀，模型来不及跑）。
    try { child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: '.' } })}\n`); } catch { /* dead */ }
  });
}

async function listCommands(provider, cwd) {
  if ((provider || 'claude') !== 'claude') return [];

  // 1) 扫磁盘自定义命令，拿描述 + 来源（project/user）。
  const scanned = [];
  const seen = new Set();
  for (const r of [
    { dir: path.join(cwd || '', '.claude', 'commands'), scope: 'project' },
    { dir: path.join(os.homedir(), '.claude', 'commands'), scope: 'user' },
  ]) await walkCommands(r.dir, '', r.scope, scanned, seen);
  const byName = new Map(scanned.map((c) => [c.name, c]));

  // 2) probe init 拿权威名单（含内置）；无项目时用 home 作 cwd 也能拿到内置。
  const bin = resolveBin('claude');
  const names = bin ? await probeSlashCommands(bin, cwd || os.homedir()) : null;

  if (!names) {                       // probe 失败 → 退回纯扫描
    scanned.sort((a, b) => a.name.localeCompare(b.name));
    return scanned;
  }

  // 3) 合并：名单以 probe 为准，描述/来源从扫描补；扫到了但 probe 没有的也并进来。
  const out = names.map((n) => {
    const full = `/${n}`;
    const sc = byName.get(full);
    return { name: full, description: sc ? sc.description : '', scope: sc ? sc.scope : 'builtin' };
  });
  const have = new Set(names);
  for (const c of scanned) if (!have.has(c.name.slice(1))) out.push(c);
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

async function walkCommands(dir, prefix, scope, out, seen) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walkCommands(full, prefix ? `${prefix}:${e.name}` : e.name, scope, out, seen);
    } else if (e.name.endsWith('.md')) {
      const base = e.name.replace(/\.md$/, '');
      const name = prefix ? `${prefix}:${base}` : base;
      if (seen.has(name)) continue;   // 项目级先扫，覆盖用户级
      seen.add(name);
      out.push({ name: `/${name}`, description: await readCmdDesc(full), scope });
    }
  }
}

async function readCmdDesc(file) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(2048);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const head = buf.slice(0, bytesRead).toString('utf8');
    const m = /^---[\s\S]*?\bdescription:\s*(.+)$/m.exec(head);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    const line = head.split('\n').find((l) => l.trim() && !l.startsWith('---') && !l.startsWith('#'));
    return line ? line.trim().slice(0, 80) : '';
  } catch { return ''; } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/* ------------------------------------------------------------------ *
 * 实时驱动 Claude Code —— Agent SDK 常驻会话（streaming-input）。
 * 每个标签(cwd) 一个长驻 query：进程不退、消息推进去、init 只一次 →
 * 后续回合只剩 API 往返，追齐原生终端速度。事件按 cwd 路由回对应标签。
 * canUseTool 让 agent 要权限/提问时真正暂停，弹给用户选。SDK 是 ESM，动态 import。
 * ------------------------------------------------------------------ */
const sessions = new Map();      // cwd -> { input, ac, query }
const pendingPerms = new Map();  // permId -> { cwd, settle }
const PERM_MODES = ['default', 'plan', 'acceptEdits', 'bypassPermissions'];

let _sdkPromise = null;
function getSdk() {
  if (!_sdkPromise) _sdkPromise = import('@anthropic-ai/claude-agent-sdk');
  return _sdkPromise;
}

/** 可推送的异步迭代器，作为 SDK streaming-input 的 prompt。 */
function makeInputQueue() {
  const queue = [];
  let resolveNext = null;
  let closed = false;
  return {
    iter: {
      [Symbol.asyncIterator]() { return this; },
      next() {
        if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
        if (closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => { resolveNext = r; });
      },
    },
    push(msg) {
      if (resolveNext) { const r = resolveNext; resolveNext = null; r({ value: msg, done: false }); }
      else queue.push(msg);
    },
    close() {
      closed = true;
      if (resolveNext) { const r = resolveNext; resolveNext = null; r({ value: undefined, done: true }); }
    },
  };
}

function clearPerms(cwd, message) {
  for (const [pid, e] of pendingPerms) {
    if (e.cwd === cwd) { pendingPerms.delete(pid); e.settle({ behavior: 'deny', message: message || '会话结束' }); }
  }
}

/** 起一个常驻会话（懒创建，首条消息时调用）。失败返回 null 并已发 error 事件。 */
function startSession(sender, { cwd, provider, sessionId, permMode }) {
  const def = PROVIDERS[provider || 'claude'];
  if (!def || !def.live) { sender.send('localAgent:event', { cwd, ev: { type: 'error', error: `${provider} 暂不支持实时对话` } }); return null; }
  const bin = resolveBin(def.bin);
  if (!bin) { sender.send('localAgent:event', { cwd, ev: { type: 'error', error: `未找到 ${def.bin}，请确认已安装` } }); return null; }
  const mode = PERM_MODES.includes(permMode) ? permMode : 'default';
  const input = makeInputQueue();
  const ac = new AbortController();

  const canUseTool = (toolName, toolInput, ctx) => new Promise((resolve) => {
    const settle = (decision) => {
      if (decision && decision.behavior === 'allow') {
        const r = { behavior: 'allow', updatedInput: decision.updatedInput || toolInput || {} };
        if (decision.updatedPermissions) r.updatedPermissions = decision.updatedPermissions;
        resolve(r);
      } else {
        resolve({ behavior: 'deny', message: (decision && decision.message) || '已拒绝' });
      }
    };
    if (ac.signal.aborted) { settle({ behavior: 'deny', message: '已取消' }); return; }
    const permId = `perm-${Math.random().toString(36).slice(2, 10)}`;
    pendingPerms.set(permId, { cwd, settle });
    const isQuestion = toolName === 'AskUserQuestion';
    sender.send('localAgent:event', { cwd, ev: {
      type: isQuestion ? 'question_request' : 'permission_request', permId, toolName, input: toolInput,
      title: ctx?.title || null, displayName: ctx?.displayName || null, description: ctx?.description || null,
      suggestions: ctx?.suggestions || null,
    } });
    if (ctx?.signal) ctx.signal.addEventListener('abort', () => {
      if (pendingPerms.has(permId)) { pendingPerms.delete(permId); settle({ behavior: 'deny', message: '已取消' }); }
    });
  });

  const session = { input, ac, query: null };
  sessions.set(cwd, session);

  (async () => {
    try {
      const { query } = await getSdk();
      const q = query({
        prompt: input.iter,
        options: {
          cwd, permissionMode: mode, canUseTool,
          // 让 bypassPermissions 真正生效（否则该模式仍会触发 canUseTool 询问）。
          // 只是「允许」选用 bypass，不强制——具体行为由 permissionMode 决定。
          allowDangerouslySkipPermissions: true,
          // 加载用户/项目/本地设置（CLAUDE.md + 权限 allow/deny 规则），
          // 与终端里的 CC 行为一致：预批准的规则照样生效、提示更少更一致。
          settingSources: ['user', 'project', 'local'],
          includePartialMessages: true,
          pathToClaudeCodeExecutable: bin,
          abortController: ac,
          env: childEnv(),
          stderr: (data) => sender.send('localAgent:event', { cwd, ev: { type: 'stderr', text: String(data) } }),
          ...(sessionId ? { resume: sessionId } : {}),
        },
      });
      session.query = q;
      for await (const msg of q) sender.send('localAgent:event', { cwd, ev: msg });
    } catch (e) {
      if (!ac.signal.aborted) sender.send('localAgent:event', { cwd, ev: { type: 'error', error: String(e && e.message || e) } });
    } finally {
      sessions.delete(cwd);
      clearPerms(cwd, '会话结束');
      sender.send('localAgent:event', { cwd, ev: { type: 'session_closed' } });
    }
  })();

  return session;
}

/** 发一个回合：会话不存在则懒创建（带 resume），然后把用户消息推进流。 */
function sessionSend(sender, { cwd, provider, sessionId, prompt, permMode }) {
  let s = sessions.get(cwd);
  if (!s) s = startSession(sender, { cwd, provider, sessionId, permMode });
  if (!s) return { ok: false };
  s.input.push({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null });
  return { ok: true };
}

/** 中断当前回合，但保留常驻会话（可继续发）。 */
async function sessionInterrupt({ cwd }) {
  const s = sessions.get(cwd);
  if (s?.query) { try { await s.query.interrupt(); } catch { /* ignore */ } return { ok: true }; }
  return { ok: false };
}

/** 关闭某标签的常驻会话，回收进程（切会话/新建/关标签/换 provider 时调）。 */
function sessionClose({ cwd }) {
  const s = sessions.get(cwd);
  if (!s) return { ok: false };
  sessions.delete(cwd);
  clearPerms(cwd, '已切换');
  try { s.input.close(); } catch { /* */ }
  try { s.ac.abort(); } catch { /* */ }
  return { ok: true };
}

/** 会话进行中切换权限模式（Tab 切档即时生效）。 */
async function sessionSetPermMode({ cwd, permMode }) {
  const mode = PERM_MODES.includes(permMode) ? permMode : 'default';
  const s = sessions.get(cwd);
  if (s?.query) { try { await s.query.setPermissionMode(mode); } catch { /* */ } return { ok: true }; }
  return { ok: false };
}

function permissionRespond(permId, decision) {
  const e = pendingPerms.get(permId);
  if (!e) return { ok: false };
  pendingPerms.delete(permId);
  e.settle(decision);   // settle 规整 allow/deny 成 SDK 要求的形状
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * IPC 注册
 * ------------------------------------------------------------------ */
function registerLocalAgent(ipcMain, dialog) {
  ipcMain.handle('localAgent:detect', () => detect());
  ipcMain.handle('localAgent:pickFolder', async () => {
    const res = await dialog.showOpenDialog({
      title: '选择本地 Agent 的工作目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
  });
  ipcMain.handle('localAgent:listSessions', (_e, { provider, cwd }) => listSessions(provider, cwd));
  ipcMain.handle('localAgent:readSession', (_e, { provider, cwd, sessionId }) => readSession(provider, cwd, sessionId));
  ipcMain.handle('localAgent:deleteSession', (_e, { provider, cwd, sessionId }) => deleteSession(provider, cwd, sessionId));
  ipcMain.handle('localAgent:listCommands', (_e, { provider, cwd }) => listCommands(provider, cwd));
  ipcMain.handle('localAgent:send', (e, payload) => sessionSend(e.sender, payload));
  ipcMain.handle('localAgent:permissionRespond', (_e, { permId, decision }) => permissionRespond(permId, decision));
  ipcMain.handle('localAgent:interrupt', (_e, { cwd }) => sessionInterrupt({ cwd }));
  ipcMain.handle('localAgent:sessionClose', (_e, { cwd }) => sessionClose({ cwd }));
  ipcMain.handle('localAgent:setPermMode', (_e, { cwd, permMode }) => sessionSetPermMode({ cwd, permMode }));
}

module.exports = {
  registerLocalAgent,
  // 仅供本地冒烟测试，不在渲染进程使用。
  _internals: { detect, findProjectDir, listSessions, readSession, listCommands, deleteSession },
};
