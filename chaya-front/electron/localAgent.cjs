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
const crypto = require('node:crypto');
const cursorDriver = require('./cursorDriver.cjs');

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

/* ------------------------------------------------------------------ *
 * MCP：读 ~/.claude.json（Claude Code CLI 配置）里的 MCP server，
 * 让用户在本地 agent 里按需启用（默认全关，保持冷启快）。
 * ------------------------------------------------------------------ */
function readClaudeJson() {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')); }
  catch { return {}; }
}
/** 列出某 cwd 可用的 MCP server（全局 + 该项目级），返回 [{name, scope, type}]（不含密钥）。 */
function listMcpConfigs(cwd) {
  const j = readClaudeJson();
  const out = [];
  const seen = new Set();
  const add = (m, scope) => {
    for (const name in (m || {})) {
      if (seen.has(name)) continue;
      seen.add(name);
      const c = m[name] || {};
      out.push({ name, scope, type: c.type || (c.command ? 'stdio' : 'http') });
    }
  };
  const proj = (j.projects && cwd && j.projects[cwd]) ? j.projects[cwd].mcpServers : null;
  add(proj, 'project');
  add(j.mcpServers, 'global');
  return out;
}
/** 把启用的 MCP 名字解析成 SDK options.mcpServers（从 ~/.claude.json 取真实配置含密钥）。 */
function resolveMcp(cwd, names) {
  if (!Array.isArray(names) || names.length === 0) return undefined;
  const j = readClaudeJson();
  const proj = (j.projects && cwd && j.projects[cwd]) ? (j.projects[cwd].mcpServers || {}) : {};
  const glob = j.mcpServers || {};
  const out = {};
  for (const name of names) { const c = proj[name] || glob[name]; if (c) out[name] = c; }
  return Object.keys(out).length ? out : undefined;
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
  cursor: { id: 'cursor', label: 'Cursor', bin: 'cursor-agent', live: true, needsApiKey: true },
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
  if (provider === 'cursor') return cursorListSessions(cwd);
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
  if (provider === 'cursor') return cursorReadSession(cwd, sessionId);
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
  if (provider === 'cursor') return cursorDeleteSession(cwd, sessionId);
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
const sessions = new Map();      // runKey -> { input, ac, query }
const pendingPerms = new Map();  // permId -> { cwd: runKey, settle }
const PERM_MODES = ['default', 'plan', 'acceptEdits', 'bypassPermissions'];

/* runKey：会话路由键。主会话 = cwd 本身；衍生(derive)等并行「车道」= cwd + lane。
 * 关键：runKey 只做 Map 键与事件路由键；SDK 的工作目录始终是真实 cwd。
 * 这样同一项目目录可并存「主会话」与「衍生会话」两条独立常驻进程，互不串台。 */
function runKey(cwd, lane) { return lane ? `${cwd}#@#${lane}` : cwd; }

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
function startSession(sender, { cwd, provider, sessionId, permMode, model, mcp, lane }) {
  const key = runKey(cwd, lane);   // Map 键 / 事件路由键（SDK 仍用真实 cwd）
  if (lane) console.log('[localAgent] start derive session · key=%s · dir=%s', key, cwd);
  const def = PROVIDERS[provider || 'claude'];
  if (!def || !def.live) { sender.send('localAgent:event', { cwd: key, ev: { type: 'error', error: `${provider} 暂不支持实时对话` } }); return null; }
  const bin = resolveBin(def.bin);
  if (!bin) { sender.send('localAgent:event', { cwd: key, ev: { type: 'error', error: `未找到 ${def.bin}，请确认已安装` } }); return null; }
  const mode = PERM_MODES.includes(permMode) ? permMode : 'default';
  const input = makeInputQueue();
  const ac = new AbortController();

  // 发事件给渲染层（按 runKey 路由）；帧已销毁（渲染进程崩溃/重载）则中断会话并停发，
  // 避免对着死帧疯狂 send 刷屏报错、也让孤儿 SDK 进程及时收尾。
  const emit = (ev) => {
    if (sender.isDestroyed()) { try { ac.abort(); } catch { /* */ } return false; }
    try { sender.send('localAgent:event', { cwd: key, ev }); return true; }
    catch { try { ac.abort(); } catch { /* */ } return false; }
  };

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
    pendingPerms.set(permId, { cwd: key, settle });
    const isQuestion = toolName === 'AskUserQuestion';
    emit({
      type: isQuestion ? 'question_request' : 'permission_request', permId, toolName, input: toolInput,
      title: ctx?.title || null, displayName: ctx?.displayName || null, description: ctx?.description || null,
      suggestions: ctx?.suggestions || null,
    });
    if (ctx?.signal) ctx.signal.addEventListener('abort', () => {
      if (pendingPerms.has(permId)) { pendingPerms.delete(permId); settle({ behavior: 'deny', message: '已取消' }); }
    });
  });

  const mcpServers = resolveMcp(cwd, mcp);
  const session = { input, ac, query: null, model: model || null, mcp: Array.isArray(mcp) ? mcp.slice() : [] };
  sessions.set(key, session);

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
          // 不连 ~/.claude.json 的环境 MCP（feishu/gitlab/ruflo 等）——本地编码 agent 用不到，
          // 而连接它们会给每次冷启加好几秒。需要再单独配。
          strictMcpConfig: true,
          ...(mcpServers ? { mcpServers } : {}),
          includePartialMessages: true,
          pathToClaudeCodeExecutable: bin,
          abortController: ac,
          env: childEnv(),
          stderr: (data) => emit({ type: 'stderr', text: String(data) }),
          ...(model ? { model } : {}),
          ...(sessionId ? { resume: sessionId } : {}),
        },
      });
      session.query = q;
      // 拉一次该 provider/账号下可选模型，推给渲染层填「模型选择器」（/model 等价）。
      if (typeof q.supportedModels === 'function') {
        q.supportedModels().then((ms) => emit({ type: 'models', models: ms })).catch(() => {});
      }
      for await (const msg of q) { if (!emit(msg)) break; }   // 帧没了就停，别空转
    } catch (e) {
      if (!ac.signal.aborted) emit({ type: 'error', error: String(e && e.message || e) });
    } finally {
      sessions.delete(key);
      clearPerms(key, '会话结束');
      emit({ type: 'session_closed' });
    }
  })();

  return session;
}

/* ------------------------------------------------------------------ *
 * 附件（拖入文件 / 附件按钮 / 粘贴图片）→ 注入用户消息。
 *   - 图片 → Anthropic image content block（base64），模型直接「看见」（视觉）；
 *   - 其它文件 → 在文本里追加 @绝对路径 引用，让 agent 用 Read 工具读取分析；
 *   - cursor 无 streaming-input / 视觉，统一退化成「@路径」文本引用。
 * 渲染层对图片附件总带 dataUrl（拖/粘贴自带，dialog 选取由 pickFiles 回填），
 * 故主进程只解析 dataUrl，不再回读磁盘。
 * ------------------------------------------------------------------ */
const IMAGE_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
};
function imageMimeForPath(p) { return IMAGE_MIME[path.extname(p || '').toLowerCase()] || null; }

/** data:<mime>;base64,<data> → SDK image block；失败返回 null。 */
function dataUrlToImageBlock(dataUrl) {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl || '');
  if (!m) return null;
  return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
}

/** 把带 path 的附件折成「参考文件」文本，供 agent Read。
 *  includeImages=false（claude）：图片走视觉 image block，不在文本里重复引用；
 *  includeImages=true（cursor，无视觉）：图片文件也按 @路径 引用，至少能被 Read。 */
function fileRefsText(prompt, attachments, includeImages) {
  const refs = (attachments || [])
    .filter((a) => a && a.path && (includeImages || a.kind !== 'image'))
    .map((a) => `@${a.path}`);
  if (!refs.length) return prompt || '';
  return `${prompt || ''}${prompt ? '\n\n' : ''}参考以下文件（请读取并分析）：\n${refs.join('\n')}`;
}

/** Claude 用户消息内容：有附件 → [文本块, 图片块…]；无 → 原字符串。 */
function buildClaudeContent(prompt, attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return prompt;
  const images = [];
  for (const a of attachments) {
    if (!a || a.kind !== 'image') continue;
    const block = a.dataUrl ? dataUrlToImageBlock(a.dataUrl) : null;
    if (block) images.push(block);
  }
  const text = fileRefsText(prompt, attachments);
  if (!images.length) return text;
  const out = [];
  if (text) out.push({ type: 'text', text });
  out.push(...images);
  return out;
}

/** 发一个回合：会话不存在则懒创建（带 resume），然后把用户消息推进流。
 *  模型在发送这一刻才应用：冷启已用 options.model 起；暖会话且模型变了才 setModel
 *  （setModel 会注入「Set model to …」回显，渲染层会过滤掉，不当对话显示）。
 *  attachments：拖入/选取的文件 + 粘贴的图片（见上方注入逻辑）。 */
async function sessionSend(sender, { cwd, provider, sessionId, prompt, permMode, model, mcp, apiKey, attachments, lane }) {
  if (provider === 'cursor' && !lane) return cursorSend(sender, { cwd, sessionId, prompt: fileRefsText(prompt, attachments, true), permMode, model, apiKey });
  const key = runKey(cwd, lane);
  let s = sessions.get(key);
  if (!s) s = startSession(sender, { cwd, provider, sessionId, permMode, model, mcp, lane });
  if (!s) return { ok: false };
  const want = model || null;
  if (s.query && want !== s.model && typeof s.query.setModel === 'function') {
    try { await s.query.setModel(want || undefined); } catch { /* */ }
  }
  s.model = want;
  s.input.push({ type: 'user', message: { role: 'user', content: buildClaudeContent(prompt, attachments) }, parent_tool_use_id: null });
  return { ok: true };
}

/** 预热：打开/聚焦会话时就起常驻进程（提前付冷启 + resume 读盘），
 *  等用户真正发送时已是暖的——首 token 从 ~10s 降到 ~2s。已有则不重起。 */
function sessionWarm(sender, { cwd, provider, sessionId, permMode, model, mcp, apiKey, lane }) {
  if (provider === 'cursor' && !lane) return cursorWarm(sender, { cwd, sessionId, permMode, model, apiKey });
  if (sessions.has(runKey(cwd, lane))) return { ok: true };
  const s = startSession(sender, { cwd, provider, sessionId, permMode, model, mcp, lane });
  return { ok: !!s };
}

/** 运行中改 MCP（/mcp 等价）：重设该会话启用的 MCP server，并回推连接状态。 */
async function sessionSetMcp({ cwd, mcp, lane }) {
  const s = sessions.get(runKey(cwd, lane));
  if (!s) return { ok: false };
  s.mcp = Array.isArray(mcp) ? mcp.slice() : [];
  if (s.query && typeof s.query.setMcpServers === 'function') {
    try {
      await s.query.setMcpServers(resolveMcp(cwd, s.mcp) || {});
      if (typeof s.query.mcpServerStatus === 'function') {
        const st = await s.query.mcpServerStatus();
        if (!s.ac.signal.aborted && !s.sender?.isDestroyed?.()) {
          // 通过事件回推（emit 仅在 startSession 闭包里；这里直接用 sessions 的 sender 不可得，
          // 故由渲染层在 system/init 与轮询时读取；此处仅确保已应用）。
        }
        return { ok: true, servers: st };
      }
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    return { ok: true };
  }
  return { ok: true };   // 会话未起：下次发送/预热会以 s.mcp 起
}

/** 探测 MCP 连接状态。 */
async function sessionMcpStatus({ cwd, lane }) {
  const s = sessions.get(runKey(cwd, lane));
  if (s?.query && typeof s.query.mcpServerStatus === 'function') {
    try { return { ok: true, servers: await s.query.mcpServerStatus() }; }
    catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }
  return { ok: false };
}

/** 重连某个 MCP server（不通时用），完成后回最新状态。 */
async function sessionReconnectMcp({ cwd, name, lane }) {
  const s = sessions.get(runKey(cwd, lane));
  if (s?.query && typeof s.query.reconnectMcpServer === 'function') {
    try {
      await s.query.reconnectMcpServer(name);
      const servers = typeof s.query.mcpServerStatus === 'function' ? await s.query.mcpServerStatus() : undefined;
      return { ok: true, servers };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }
  return { ok: false };
}

/** 运行中切模型（/model 等价）。会话不存在则忽略（下次发送会以选中的 model 起）。 */
async function sessionSetModel({ cwd, model, lane }) {
  if (!lane) { const cu = cursorSessions.get(cwd); if (cu) { cu.model = model || null; return { ok: true }; } }
  const s = sessions.get(runKey(cwd, lane));
  if (s?.query && typeof s.query.setModel === 'function') {
    try { await s.query.setModel(model || undefined); } catch { /* */ }
    s.model = model || null;   // 记录已应用，发送时不再重复 setModel
    return { ok: true };
  }
  return { ok: false };
}

/** 中断当前回合，但保留常驻会话（可继续发）。 */
async function sessionInterrupt({ cwd, lane }) {
  if (!lane) {   // lane 是 claude 专用的并行车道；带 lane 时跳过 cursor 分支
    const cu = cursorSessions.get(cwd);
    if (cu) { try { if (cu.child) cu.child.kill('SIGTERM'); } catch { /* */ } return { ok: true }; }
  }
  const s = sessions.get(runKey(cwd, lane));
  if (s?.query) { try { await s.query.interrupt(); } catch { /* ignore */ } return { ok: true }; }
  return { ok: false };
}

/** 关闭某标签/车道的常驻会话，回收进程（切会话/新建/关标签/换 provider/关衍生卡片时调）。 */
function sessionClose({ cwd, lane }) {
  if (!lane) {
    const cu = cursorSessions.get(cwd);
    if (cu) {
      cursorSessions.delete(cwd);
      try { if (cu.ac) cu.ac.abort(); } catch { /* */ }
      try { if (cu.child) cu.child.kill('SIGTERM'); } catch { /* */ }
      return { ok: true };
    }
  }
  const key = runKey(cwd, lane);
  const s = sessions.get(key);
  if (!s) return { ok: false };
  sessions.delete(key);
  clearPerms(key, '已切换');
  try { s.input.close(); } catch { /* */ }
  try { s.ac.abort(); } catch { /* */ }
  return { ok: true };
}

/** 会话进行中切换权限模式（Tab 切档即时生效）。 */
async function sessionSetPermMode({ cwd, permMode, lane }) {
  if (!lane) { const cu = cursorSessions.get(cwd); if (cu) { cu.permMode = permMode || 'force'; return { ok: true }; } }
  const mode = PERM_MODES.includes(permMode) ? permMode : 'default';
  const s = sessions.get(runKey(cwd, lane));
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
 * 实时驱动 Cursor —— 无状态一次性进程（每回合 spawn 一次 `cursor-agent -p`）。
 * 与 Claude 的常驻 query 不同：cursor headless 没有 streaming-input 常驻，靠
 * --resume <session_id> 续上下文；首回合无 resume，从 init 捕获 session_id 留作下回合。
 * 事件经 cursorDriver.normalizeEvent 翻成渲染层的 SDK 形状，渲染层零改动。
 * headless 必须 CURSOR_API_KEY（渲染层从后端凭据拉到、随 payload 传入）。
 * ------------------------------------------------------------------ */
const cursorSessions = new Map();   // cwd -> { child, ac, sessionId, model, permMode, apiKey }

/** 可选模型是账号级、基本不变 —— 整个进程只拉一次（`cursor-agent models` 实测 ~4.7s，
 *  绝不能每回合都跑）。缓存命中即同步回推；并发请求复用同一次拉取。 */
let _cursorModels = null;       // ModelInfo[] | null
let _cursorModelsInflight = null;
function fetchCursorModels(bin, apiKey, emit) {
  if (_cursorModels) { if (_cursorModels.length) emit({ type: 'models', models: _cursorModels }); return; }
  if (!_cursorModelsInflight) {
    _cursorModelsInflight = new Promise((resolve) => {
      execFile(bin, ['models'], { env: { ...childEnv(), ...(apiKey ? { CURSOR_API_KEY: apiKey } : {}) }, timeout: 10000 }, (err, stdout) => {
        _cursorModels = err ? [] : cursorDriver.parseModels(stdout);
        _cursorModelsInflight = null;
        resolve(_cursorModels);
      });
    });
  }
  _cursorModelsInflight.then((models) => { if (models && models.length) emit({ type: 'models', models }); });
}

/** 发一个 cursor 回合：spawn 进程、流式解析、按 cwd 路由事件回渲染层。 */
function cursorSend(sender, { cwd, sessionId, prompt, permMode, model, apiKey }) {
  const bin = resolveBin('cursor-agent');
  if (!bin) { sender.send('localAgent:event', { cwd, ev: { type: 'error', error: '未找到 cursor-agent，请确认已安装' } }); return { ok: false }; }
  const prev = cursorSessions.get(cwd);
  const key = apiKey || (prev && prev.apiKey) || null;
  if (!key) { sender.send('localAgent:event', { cwd, ev: { type: 'error', error: '需要 Cursor API Key —— 请在设置里录入' } }); return { ok: false }; }
  // 防孤儿：上回合若有未退的子进程（异常路径，渲染层 running 已防双发），先收掉再起新的，避免事件串扰。
  if (prev && prev.child) { try { prev.ac && prev.ac.abort(); } catch { /* */ } try { prev.child.kill('SIGTERM'); } catch { /* */ } prev.child = null; }

  const ac = new AbortController();
  const emit = (ev) => {
    if (sender.isDestroyed()) { try { ac.abort(); } catch { /* */ } return false; }
    try { sender.send('localAgent:event', { cwd, ev }); return true; }
    catch { try { ac.abort(); } catch { /* */ } return false; }
  };

  // 续接 id：优先用本会话上回合捕获的 session_id，否则用打开历史会话传入的 sessionId。
  const resumeId = (prev && prev.sessionId) || sessionId || null;
  const args = cursorDriver.spawnArgs({ prompt, sessionId: resumeId, model, permMode });

  let child;
  try {
    child = spawn(bin, args, { cwd, env: { ...childEnv(), CURSOR_API_KEY: key }, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    emit({ type: 'error', error: String(e && e.message || e) });
    return { ok: false };
  }

  const session = { child, ac, sessionId: resumeId, model: model || null, permMode: permMode || 'force', apiKey: key };
  cursorSessions.set(cwd, session);
  ac.signal.addEventListener('abort', () => { try { child.kill('SIGTERM'); } catch { /* */ } });

  const ctx = cursorDriver.makeTurnState();
  let sawResult = false;
  let stderrBuf = '';
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }   // 非 JSON（trust 提示等）→ 跳过
      for (const ev of cursorDriver.normalizeEvent(o, ctx)) {
        if (ev.type === 'result') sawResult = true;
        if (!emit(ev)) return;
      }
      if (ctx.sessionId) session.sessionId = ctx.sessionId;   // 留作下回合 --resume
    }
  });
  child.stderr.on('data', (d) => { stderrBuf += d.toString('utf8'); });
  child.on('error', (e) => { emit({ type: 'error', error: String(e && e.message || e) }); emit({ type: 'session_closed' }); });
  child.on('close', (code) => {
    session.child = null;
    if (!sawResult) {
      const msg = stderrBuf.trim() || (code ? `cursor-agent 退出码 ${code}` : '会话结束');
      emit({ type: 'error', error: msg });
      emit({ type: 'session_closed' });   // 解除「处理中」
    }
    // 正常结束（已收到 result）：会话保留在 map（含 session_id）供下回合续接，进程已退。
  });

  // 模型列表已缓存才同步回推（绝不在 send 里 spawn `models`——那会每回合多花 ~4.7s）。
  // 未缓存时不在此拉取：warm 已负责首拉；真没 warm 过也不该拖慢这一回合。
  if (_cursorModels && _cursorModels.length) emit({ type: 'models', models: _cursorModels });
  return { ok: true };
}

/** cursor 预热：起不动常驻进程，只登记会话状态（让发送前的 setModel/permMode 生效）+ 拉模型列表。 */
function cursorWarm(sender, { cwd, sessionId, permMode, model, apiKey }) {
  const bin = resolveBin('cursor-agent');
  if (!bin) return { ok: false };
  const prev = cursorSessions.get(cwd);
  const key = apiKey || (prev && prev.apiKey) || null;
  if (!prev) cursorSessions.set(cwd, { child: null, ac: null, sessionId: sessionId || null, model: model || null, permMode: permMode || 'force', apiKey: key });
  else { if (apiKey) prev.apiKey = key; if (model !== undefined) prev.model = model || null; if (permMode) prev.permMode = permMode; }
  if (key) fetchCursorModels(bin, key, (ev) => { try { sender.send('localAgent:event', { cwd, ev }); } catch { /* */ } });
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Cursor 历史落盘读取 —— ~/.cursor/chats/<md5(cwd)>/<sessionId>/store.db
 *   <sessionId>（agent-uuid 目录名）= --resume 的 id。
 *   用系统 sqlite3 CLI 读（自动处理 WAL，零原生依赖）：meta(JSON) + blobs(内容寻址)。
 *   根 blob protobuf 的 field-1 = 有序消息哈希；消息 blob = JSON。
 * ------------------------------------------------------------------ */
function cursorChatsDir(cwd) {
  return path.join(os.homedir(), '.cursor', 'chats', crypto.createHash('md5').update(cwd).digest('hex'));
}

let _sqliteBin;
function sqliteBin() {
  if (_sqliteBin === undefined) _sqliteBin = resolveBin('sqlite3') || '/usr/bin/sqlite3';
  return _sqliteBin;
}

function sqliteQuery(db, sql) {
  return new Promise((resolve) => {
    execFile(sqliteBin(), [db, sql], { maxBuffer: 128 * 1024 * 1024, timeout: 15000 }, (err, stdout) => {
      if (err) return resolve('');
      resolve(String(stdout || ''));
    });
  });
}

/** 读一个会话的全部消息（+ 派生 preview/turns）。失败返回 null。 */
async function cursorLoadSession(db) {
  const metaHex = (await sqliteQuery(db, 'SELECT value FROM meta LIMIT 1')).trim();
  if (!metaHex) return null;
  let meta;
  try { meta = JSON.parse(Buffer.from(metaHex, 'hex').toString('utf8')); } catch { return null; }
  if (!meta || !meta.latestRootBlobId) return { meta, messages: [], preview: null, turns: 0 };

  // 一次性取出所有 blob（id<TAB>hex），在内存里组 DAG。
  const dump = await sqliteQuery(db, "SELECT id || char(9) || hex(data) FROM blobs");
  const blobs = new Map();
  for (const line of dump.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const id = line.slice(0, tab);
    const hex = line.slice(tab + 1).trim();
    if (id && hex) blobs.set(id, Buffer.from(hex, 'hex'));
  }
  const root = blobs.get(meta.latestRootBlobId);
  if (!root) return { meta, messages: [], preview: null, turns: 0 };

  const messages = [];
  let preview = null;
  let turns = 0;
  for (const h of cursorDriver.rootChildHashes(root)) {
    const b = blobs.get(h);
    if (!b) continue;
    let o;
    try { o = JSON.parse(b.toString('utf8')); } catch { continue; }
    if (o.role === 'user') {
      turns += 1;
      if (!preview) {
        const txt = cursorDriver.cleanUserText(typeof o.content === 'string'
          ? o.content
          : Array.isArray(o.content) ? o.content.filter((p) => p && p.type === 'text').map((p) => p.text || '').join('\n') : '');
        if (txt) preview = txt.slice(0, 120);
      }
    }
    const m = cursorDriver.mapStoredMessage(o);
    if (m) messages.push(m);
  }
  return { meta, messages, preview, turns };
}

async function cursorListSessions(cwd) {
  const dir = cursorChatsDir(cwd);
  let uuids;
  try { uuids = (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch { return []; }
  const out = await Promise.all(uuids.map(async (sessionId) => {
    const db = path.join(dir, sessionId, 'store.db');
    let mtime = 0;
    try { mtime = (await fsp.stat(db)).mtimeMs; } catch { return null; }
    const loaded = await cursorLoadSession(db);
    if (!loaded) return null;
    const name = loaded.meta && loaded.meta.name;
    const title = (name && name !== 'New Agent') ? name : (loaded.preview || null);
    return { sessionId, title, preview: loaded.preview, turns: loaded.turns, updatedAt: mtime || (loaded.meta && loaded.meta.createdAt) || 0 };
  }));
  return out.filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
}

async function cursorReadSession(cwd, sessionId) {
  const db = path.join(cursorChatsDir(cwd), sessionId, 'store.db');
  const loaded = await cursorLoadSession(db);
  return { messages: loaded ? loaded.messages : [] };
}

async function cursorDeleteSession(cwd, sessionId) {
  if (!sessionId || /[/\\]/.test(sessionId)) return { ok: false, error: 'bad sessionId' };
  const root = path.join(os.homedir(), '.cursor', 'chats');
  const target = path.join(cursorChatsDir(cwd), sessionId);
  if (!target.startsWith(root + path.sep)) return { ok: false, error: 'out of bounds' };
  try {
    const { shell } = require('electron');
    await shell.trashItem(target);
    return { ok: true, trashed: true };
  } catch {
    try { await fsp.rm(target, { recursive: true, force: true }); return { ok: true, trashed: false }; }
    catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }
}

/* ------------------------------------------------------------------ *
 * IPC 注册
 * ------------------------------------------------------------------ */
function registerLocalAgent(ipcMain, dialog) {
  console.log('[localAgent] ready · multi-session lane routing (runKey=cwd#@#lane)');
  ipcMain.handle('localAgent:detect', () => detect());
  ipcMain.handle('localAgent:pickFolder', async () => {
    const res = await dialog.showOpenDialog({
      title: '选择本地 Agent 的工作目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
  });
  // 附件按钮：多选任意文件作为参考。图片回填 dataUrl 供前端缩略图 + 主进程视觉块；
  // 其它文件只回元信息（发送时折成 @路径 让 agent 读取）。超大图片（>8MB）不内联 dataUrl，
  // 退化为按路径引用，避免 IPC/base64 撑爆。
  ipcMain.handle('localAgent:pickFiles', async () => {
    const res = await dialog.showOpenDialog({
      title: '选择参考文件', properties: ['openFile', 'multiSelections'],
    });
    if (res.canceled || !Array.isArray(res.filePaths)) return [];
    const out = [];
    for (const p of res.filePaths) {
      const mime = imageMimeForPath(p);
      let size = 0; try { size = (await fsp.stat(p)).size; } catch { /* */ }
      let dataUrl;
      if (mime && mime !== 'image/svg+xml' && size > 0 && size <= 8 * 1024 * 1024) {
        try { dataUrl = `data:${mime};base64,${(await fsp.readFile(p)).toString('base64')}`; } catch { /* */ }
      }
      // 仅当成功内联 dataUrl 才作为「图片」（走视觉）；否则（超大/SVG/读失败）退化为按 @路径 让 agent 读取。
      out.push({ kind: dataUrl ? 'image' : 'file', name: path.basename(p), path: p, mime: mime || null, size, dataUrl });
    }
    return out;
  });
  ipcMain.handle('localAgent:listSessions', (_e, { provider, cwd }) => listSessions(provider, cwd));
  ipcMain.handle('localAgent:readSession', (_e, { provider, cwd, sessionId }) => readSession(provider, cwd, sessionId));
  ipcMain.handle('localAgent:deleteSession', (_e, { provider, cwd, sessionId }) => deleteSession(provider, cwd, sessionId));
  ipcMain.handle('localAgent:listCommands', (_e, { provider, cwd }) => listCommands(provider, cwd));
  ipcMain.handle('localAgent:send', (e, payload) => sessionSend(e.sender, payload));
  ipcMain.handle('localAgent:warm', (e, payload) => sessionWarm(e.sender, payload));
  ipcMain.handle('localAgent:permissionRespond', (_e, { permId, decision }) => permissionRespond(permId, decision));
  ipcMain.handle('localAgent:interrupt', (_e, { cwd, lane }) => sessionInterrupt({ cwd, lane }));
  ipcMain.handle('localAgent:sessionClose', (_e, { cwd, lane }) => sessionClose({ cwd, lane }));
  ipcMain.handle('localAgent:setPermMode', (_e, { cwd, permMode, lane }) => sessionSetPermMode({ cwd, permMode, lane }));
  ipcMain.handle('localAgent:setModel', (_e, { cwd, model, lane }) => sessionSetModel({ cwd, model, lane }));
  ipcMain.handle('localAgent:listMcp', (_e, { cwd }) => listMcpConfigs(cwd));
  ipcMain.handle('localAgent:setMcp', (_e, { cwd, mcp, lane }) => sessionSetMcp({ cwd, mcp, lane }));
  ipcMain.handle('localAgent:mcpStatus', (_e, { cwd, lane }) => sessionMcpStatus({ cwd, lane }));
  ipcMain.handle('localAgent:reconnectMcp', (_e, { cwd, name, lane }) => sessionReconnectMcp({ cwd, name, lane }));
}

module.exports = {
  registerLocalAgent,
  // 仅供本地冒烟测试，不在渲染进程使用。
  _internals: { detect, findProjectDir, listSessions, readSession, listCommands, deleteSession },
};
