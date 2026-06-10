/**
 * 本地 Agent 桥 —— 纯本地功能，与 Chaya 后端无关。
 *
 * 让用户在 Chaya 的对话框里直接驱动自己机器上已安装的 CLI Agent
 * (Claude Code / Cursor / Codex / Gemini)。四个 provider 都已接入实时对话：
 * Claude 走常驻 SDK query；Gemini 走常驻 ACP；Cursor/Codex 走单回合进程 + resume。
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
const geminiDriver = require('./geminiDriver.cjs');       // 历史落盘读取(mapTool 复用)
const geminiAcp = require('./geminiAcpDriver.cjs');       // 常驻 ACP 实时驱动

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
/** 把启用的 MCP 名字解析成 ACP `session/new` 的 mcpServers 数组（Zed Agent-Client-Protocol 格式）。
 *  ~/.claude.json 用「对象」存 env/headers，ACP 用「数组」（[{name,value}]），这里转一道；
 *  stdio →{name,command,args,env[]}；http/sse →{type,name,url,headers[]}。gemini/copilot 同吃这套。 */
function resolveMcpAcp(cwd, names) {
  const obj = resolveMcp(cwd, names);
  if (!obj) return [];
  const kv = (o) => Object.entries(o || {}).map(([name, value]) => ({ name, value: String(value) }));
  const out = [];
  for (const name in obj) {
    const c = obj[name] || {};
    const type = c.type || (c.command ? 'stdio' : (c.url ? 'http' : 'stdio'));
    if (type === 'http' || type === 'sse') {
      if (!c.url) continue;
      out.push({ type, name, url: c.url, headers: kv(c.headers) });
    } else {
      if (!c.command) continue;
      out.push({ name, command: c.command, args: Array.isArray(c.args) ? c.args : [], env: kv(c.env) });
    }
  }
  return out;
}
/** 两个 MCP 名字列表是否等价（顺序无关）—— 用于判断 ACP 会话是否需要按新 mcp 重建。 */
function sameMcpNames(a, b) {
  const x = Array.isArray(a) ? [...a].sort() : [];
  const y = Array.isArray(b) ? [...b].sort() : [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
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
  codex: { id: 'codex', label: 'Codex', bin: 'codex', live: true },
  gemini: { id: 'gemini', label: 'Gemini', bin: 'gemini', live: true },
  copilot: { id: 'copilot', label: 'Copilot', bin: 'copilot', live: true },
};

/** 探测已安装的本地 agent 及版本。only=单个 provider 时只探它（冷启提速）；版本探测并行。 */
async function detect(only) {
  const list = only && PROVIDERS[only] ? [PROVIDERS[only]] : Object.values(PROVIDERS);
  return Promise.all(list.map(async (p) => {
    const bin = resolveBin(p.bin);
    return { id: p.id, label: p.label, installed: !!bin, bin, live: p.live, version: bin ? await getVersion(bin) : null };
  }));
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
  if (provider === 'gemini') return geminiListSessions(cwd);
  if (provider === 'codex') return codexListSessions(cwd);
  if (provider === 'copilot') return copilotListSessions(cwd);
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
  if (provider === 'gemini') return geminiReadSession(cwd, sessionId);
  if (provider === 'codex') return codexReadSession(cwd, sessionId);
  if (provider === 'copilot') return copilotReadSession(cwd, sessionId);
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
  if (provider === 'gemini') return geminiDeleteSession(cwd, sessionId);
  if (provider === 'codex') return codexDeleteSession(cwd, sessionId);
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
 * Codex 会话落盘读取
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<session-id>.jsonl
 *   ~/.codex/archived_sessions/... 同形
 * ------------------------------------------------------------------ */
function codexRoot() {
  return path.join(os.homedir(), '.codex');
}
function codexSessionsRoot() {
  return path.join(codexRoot(), 'sessions');
}
function codexArchivedRoot() {
  return path.join(codexRoot(), 'archived_sessions');
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
function codexSessionIdFromFile(file) {
  const m = path.basename(file).match(UUID_RE);
  return m ? m[0] : null;
}

async function codexWalkJsonl(dir, out = []) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  await Promise.all(entries.map(async (e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await codexWalkJsonl(full, out);
    else if (e.isFile() && e.name.endsWith('.jsonl') && e.name.startsWith('rollout-')) out.push(full);
  }));
  return out;
}

async function codexAllRolloutFiles() {
  const out = [];
  await codexWalkJsonl(codexSessionsRoot(), out);
  await codexWalkJsonl(codexArchivedRoot(), out);
  return out;
}

async function codexReadSessionIndex() {
  const file = path.join(codexRoot(), 'session_index.jsonl');
  const map = new Map();
  let raw;
  try { raw = await fsp.readFile(file, 'utf8'); } catch { return map; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o && o.id) map.set(o.id, {
        title: o.thread_name || null,
        updatedAt: o.updated_at ? Date.parse(o.updated_at) : 0,
      });
    } catch { /* skip */ }
  }
  return map;
}

async function codexReadMeta(jsonlPath) {
  let fh;
  try {
    fh = await fsp.open(jsonlPath, 'r');
    const buf = Buffer.alloc(128 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const lines = buf.slice(0, bytesRead).toString('utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.type === 'session_meta' && o.payload) {
        return {
          id: o.payload.id || codexSessionIdFromFile(jsonlPath),
          cwd: o.payload.cwd || null,
          timestamp: o.payload.timestamp || o.timestamp || null,
        };
      }
      if (o.type === 'turn_context' && o.payload?.cwd) {
        return { id: codexSessionIdFromFile(jsonlPath), cwd: o.payload.cwd, timestamp: o.timestamp || null };
      }
    }
  } catch { /* unreadable */ } finally {
    if (fh) await fh.close().catch(() => {});
  }
  return { id: codexSessionIdFromFile(jsonlPath), cwd: null, timestamp: null };
}

function codexCwdMatchesProject(projectCwd, sessionCwd) {
  if (!projectCwd || !sessionCwd) return false;
  return path.resolve(projectCwd) === path.resolve(sessionCwd);
}

function codexTextFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((p) => {
    if (!p) return '';
    if (typeof p.text === 'string') return p.text;
    if (typeof p.content === 'string') return p.content;
    return '';
  }).filter(Boolean).join('\n');
}

function codexPartsFromMessage(item) {
  const text = codexTextFromContent(item && item.content);
  return text.trim() ? [{ kind: 'text', text }] : [];
}

function codexToolInput(item) {
  if (!item || typeof item.arguments !== 'string') return item?.arguments;
  try { return JSON.parse(item.arguments); } catch { return item.arguments; }
}

function codexPartFromResponseItem(item) {
  if (!item || item.type !== 'function_call') return null;
  return { kind: 'tool_use', name: item.name || 'tool', input: codexToolInput(item), id: item.call_id };
}

function codexToolResultFromResponseItem(item) {
  if (!item || item.type !== 'function_call_output') return null;
  const txt = typeof item.output === 'string' ? item.output : JSON.stringify(item.output || '');
  return { kind: 'tool_result', text: (txt || '').slice(0, 8000), toolUseId: item.call_id };
}

async function codexPeekSession(jsonlPath) {
  let firstPrompt = null;
  let turns = 0;
  let fh;
  try {
    fh = await fsp.open(jsonlPath, 'r');
    const buf = Buffer.alloc(512 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const lines = buf.slice(0, bytesRead).toString('utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const p = o.payload || {};
      if (o.type === 'response_item' && p.type === 'message' && p.role === 'user') {
        turns += 1;
        if (!firstPrompt) {
          const t = codexTextFromContent(p.content);
          if (t) firstPrompt = t.slice(0, 120);
        }
      }
    }
  } catch { /* unreadable */ } finally {
    if (fh) await fh.close().catch(() => {});
  }
  return { firstPrompt, turns };
}

async function codexFilesForCwd(cwd) {
  const files = await codexAllRolloutFiles();
  const metas = await Promise.all(files.map(async (file) => ({ file, meta: await codexReadMeta(file) })));
  return metas.filter((x) => x.meta && codexCwdMatchesProject(cwd, x.meta.cwd));
}

async function codexListSessions(cwd) {
  const [items, index] = await Promise.all([codexFilesForCwd(cwd), codexReadSessionIndex()]);
  const sessions = await Promise.all(items.map(async ({ file, meta }) => {
    const id = meta.id || codexSessionIdFromFile(file);
    if (!id) return null;
    if (!index.has(id)) return null;
    const st = await fsp.stat(file).catch(() => null);
    const idx = index.get(id) || {};
    const peek = await codexPeekSession(file);
    const updatedAt = idx.updatedAt || (st ? st.mtimeMs : 0) || (meta.timestamp ? Date.parse(meta.timestamp) : 0);
    return {
      sessionId: id,
      title: idx.title || null,
      preview: peek.firstPrompt,
      turns: peek.turns,
      updatedAt,
    };
  }));
  return sessions.filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
}

async function codexListAllSessions() {
  const [files, index] = await Promise.all([codexAllRolloutFiles(), codexReadSessionIndex()]);
  const rows = await Promise.all(files.map(async (file) => {
    const meta = await codexReadMeta(file);
    const id = meta.id || codexSessionIdFromFile(file);
    if (!id || !meta.cwd) return null;
    if (!index.has(id)) return null;
    const st = await fsp.stat(file).catch(() => null);
    const idx = index.get(id) || {};
    const peek = await codexPeekSession(file);
    const updatedAt = idx.updatedAt || (st ? st.mtimeMs : 0) || (meta.timestamp ? Date.parse(meta.timestamp) : 0);
    return {
      provider: 'codex',
      sessionId: id,
      title: idx.title || null,
      preview: peek.firstPrompt,
      turns: peek.turns,
      updatedAt,
      cwd: meta.cwd,
    };
  }));
  const byId = new Map();
  for (const row of rows) {
    if (!row) continue;
    const prev = byId.get(row.sessionId);
    if (!prev || row.updatedAt > prev.updatedAt) byId.set(row.sessionId, row);
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

async function codexFindSessionFile(cwd, sessionId) {
  if (!sessionId || /[/\\]/.test(sessionId)) return null;
  const items = await codexFilesForCwd(cwd);
  const hit = items.find((x) => (x.meta.id || codexSessionIdFromFile(x.file)) === sessionId);
  return hit ? hit.file : null;
}

async function codexReadSession(cwd, sessionId) {
  const full = await codexFindSessionFile(cwd, sessionId);
  if (!full) return { messages: [] };
  let raw;
  try { raw = await fsp.readFile(full, 'utf8'); } catch { return { messages: [] }; }
  const messages = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const p = o.payload || {};
    if (o.type !== 'response_item') continue;
    if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
      const parts = codexPartsFromMessage(p);
      if (parts.length) messages.push({ role: p.role, parts, ts: o.timestamp || null, uuid: p.id || null });
      continue;
    }
    if (p.type === 'function_call') {
      const part = codexPartFromResponseItem(p);
      if (part) messages.push({ role: 'assistant', parts: [part], ts: o.timestamp || null, uuid: p.call_id || null });
      continue;
    }
    if (p.type === 'function_call_output') {
      const part = codexToolResultFromResponseItem(p);
      if (part) messages.push({ role: 'assistant', parts: [part], ts: o.timestamp || null, uuid: p.call_id || null });
    }
  }
  return { messages };
}

async function codexDeleteSession(cwd, sessionId) {
  const full = await codexFindSessionFile(cwd, sessionId);
  if (!full) return { ok: false, error: 'session not found' };
  const roots = [codexSessionsRoot(), codexArchivedRoot()].map((r) => path.resolve(r) + path.sep);
  const resolved = path.resolve(full);
  if (!roots.some((r) => resolved.startsWith(r))) return { ok: false, error: 'out of bounds' };
  try {
    const { shell } = require('electron');
    await shell.trashItem(full);
    return { ok: true, trashed: true };
  } catch {
    try { await fsp.unlink(full); return { ok: true, trashed: false }; }
    catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }
}

/* ------------------------------------------------------------------ *
 * 斜杠命令发现 —— 跟 VSCode 插件/Agent SDK 一个路子：
 *   权威列表来自 `system/init` 事件的 slash_commands（内置 + 自定义都在里头）。
 *   描述/来源（project/user）再从磁盘 .claude/commands 扫描补上。
 *   probe：起一个 streaming 会话，发条极简消息触发 init，拿到 slash_commands
 *   立刻 SIGKILL（在模型应答前就杀掉，几乎零开销；订阅用户更无所谓）。
 * ------------------------------------------------------------------ */
/* 子进程输出缓冲守卫：常驻会话可能挂一整天，stderr/残行只增不减会慢慢吃内存。
 * 行缓冲超上限 = 异常超大单行（或非行式输出），裁掉头部只留尾；stderr 只为
 * 出错时的提示文案服务，留尾部足矣。 */
const STREAM_LINEBUF_MAX = 1024 * 1024;  // 1MB
const STDERR_TAIL_MAX = 256 * 1024;      // 256KB
const capTail = (s, max) => (s.length > max ? s.slice(-max) : s);

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
      buf = capTail(buf + d.toString('utf8'), STREAM_LINEBUF_MAX);
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
 * Unified Skill Hub —— 扫描各家 CLI 在本机安装的技能/自定义命令，
 * 渲染端自动导入成 Chaya 技能（prompt 模板），从而跨 5 个 provider 通用。
 * 来源（都只扫用户级目录；项目级命令已由 listCommands 走 provider 原生通道）：
 *   ~/.claude/skills/<name>/SKILL.md   — Claude Code Skill（frontmatter name/description）
 *   ~/.claude/commands/**.md           — Claude 自定义命令（$ARGUMENTS 占位）
 *   ~/.codex/prompts/*.md              — Codex 自定义 prompt
 *   ~/.cursor/commands/*.md            — Cursor 自定义命令
 *   ~/.gemini/commands/**.toml         — Gemini CLI 命令（prompt 字段，{{args}} 占位）
 * 返回统一结构 {name, description, body, origin, path, mtime}；body 已把各家
 * 参数占位归一成 Chaya 的 {{input}}。超大文件截断，防止把 localStorage 撑爆。
 * ------------------------------------------------------------------ */
const SKILL_BODY_MAX = 24 * 1024;

function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  const lines = m[1].split('\n');
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let val = kv[2].trim();
    // YAML 块标量（>- / | 等）：取后续缩进行拼成一段。
    if (/^[>|][+-]?$/.test(val)) {
      const parts = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || !lines[i + 1].trim())) { i++; parts.push(lines[i].trim()); }
      val = parts.join(' ').trim();
    }
    meta[kv[1].toLowerCase()] = val.replace(/^["']|["']$/g, '');
  }
  return { meta, body: text.slice(m[0].length) };
}

function clampBody(s) {
  const t = String(s || '').trim();
  return t.length > SKILL_BODY_MAX ? `${t.slice(0, SKILL_BODY_MAX)}\n…(truncated)` : t;
}

async function scanCliSkills() {
  const out = [];
  const home = os.homedir();
  const push = async (file, origin, name, mk) => {
    try {
      const st = await fsp.stat(file);
      if (!st.isFile() || st.size > 512 * 1024) return;
      const text = await fsp.readFile(file, 'utf8');
      const entry = mk(text);
      if (!entry || !entry.body) return;
      out.push({ name, description: '', ...entry, origin, path: file, mtime: st.mtimeMs });
    } catch { /* unreadable → skip */ }
  };

  // Claude Skills：每个技能一个目录，正文就是 prompt。
  try {
    const root = path.join(home, '.claude', 'skills');
    for (const e of await fsp.readdir(root, { withFileTypes: true })) {
      // 符号链接目录也算（CLI 装的技能常以软链形式挂进来）。
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      await push(path.join(root, e.name, 'SKILL.md'), 'claude', e.name, (text) => {
        const { meta, body } = parseFrontmatter(text);
        return { name: meta.name || e.name, description: meta.description || '', body: clampBody(body) };
      });
    }
  } catch { /* no dir */ }

  // Markdown 命令类（claude commands / codex prompts / cursor commands）。
  const mdRoots = [
    { dir: path.join(home, '.claude', 'commands'), origin: 'claude' },
    { dir: path.join(home, '.codex', 'prompts'), origin: 'codex' },
    { dir: path.join(home, '.cursor', 'commands'), origin: 'cursor' },
  ];
  const walkMd = async (dir, prefix, origin) => {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await walkMd(full, prefix ? `${prefix}:${e.name}` : e.name, origin); continue; }
      if (!e.name.endsWith('.md')) continue;
      const base = e.name.replace(/\.md$/, '');
      await push(full, origin, prefix ? `${prefix}:${base}` : base, (text) => {
        const { meta, body } = parseFrontmatter(text);
        return { description: meta.description || '', body: clampBody(body.split('$ARGUMENTS').join('{{input}}')) };
      });
    }
  };
  for (const r of mdRoots) await walkMd(r.dir, '', r.origin);

  // Gemini CLI：TOML，取 description / prompt（含多行 """…"""）。
  const walkToml = async (dir, prefix) => {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await walkToml(full, prefix ? `${prefix}:${e.name}` : e.name); continue; }
      if (!e.name.endsWith('.toml')) continue;
      const base = e.name.replace(/\.toml$/, '');
      await push(full, 'gemini', prefix ? `${prefix}:${base}` : base, (text) => {
        const desc = /^description\s*=\s*"(.*)"\s*$/m.exec(text);
        const multi = /prompt\s*=\s*"""([\s\S]*?)"""/.exec(text);
        const single = /^prompt\s*=\s*"(.*)"\s*$/m.exec(text);
        const prompt = multi ? multi[1] : single ? single[1].replace(/\\n/g, '\n') : '';
        if (!prompt.trim()) return null;
        return { description: desc ? desc[1] : '', body: clampBody(prompt.split('{{args}}').join('{{input}}')) };
      });
    }
  };
  await walkToml(path.join(home, '.gemini', 'commands'), '');

  return out;
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
/* ------------------------------------------------------------------ *
 * 流式 IPC 合批：SDK/CLI 每个 token 一条 text_delta，多会话并行时主进程
 * webContents.send 频率数百 Hz，IPC 序列化本身成为瓶颈。这里把连续的
 * text_delta 聚合 ~16ms 一发（渲染端有打字机缓冲，体感零差异）；任何
 * 非 delta 事件到来先冲掉积压，保证事件顺序不变。
 * ------------------------------------------------------------------ */
const DELTA_BATCH_MS = 16;
function makeBatchedEmit(emitNow) {
  let buf = null;     // { parentId, text }
  let timer = null;
  const flushDelta = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!buf) return true;
    const { parentId, text } = buf; buf = null;
    const ev = { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } };
    if (parentId) ev.parent_tool_use_id = parentId;
    return emitNow(ev);
  };
  return (ev) => {
    const e = ev && ev.type === 'stream_event' ? ev.event : null;
    if (e && e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta' && typeof e.delta.text === 'string') {
      const pid = (ev.parent_tool_use_id) || null;
      if (buf && buf.parentId !== pid && !flushDelta()) return false;
      if (!buf) buf = { parentId: pid, text: '' };
      buf.text += e.delta.text;
      if (!timer) timer = setTimeout(flushDelta, DELTA_BATCH_MS);
      return true;
    }
    if (buf && !flushDelta()) return false;   // 非 delta：先保序冲掉积压
    return emitNow(ev);
  };
}

function startSession(sender, { cwd, provider, sessionId, permMode, model, reasoning, mcp, lane }) {
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
  const emit = makeBatchedEmit((ev) => {
    const s = sessions.get(key); if (s) s.touched = Date.now();   // 任意流量 = 活跃，重置闲置计时
    if (sender.isDestroyed()) { try { ac.abort(); } catch { /* */ } return false; }
    try { sender.send('localAgent:event', { cwd: key, ev }); return true; }
    catch { try { ac.abort(); } catch { /* */ } return false; }
  });

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
    pendingPerms.set(permId, { cwd: key, settle, at: Date.now() });
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
  const session = { input, ac, query: null, model: model || null, reasoning: reasoning || null, mcp: Array.isArray(mcp) ? mcp.slice() : [], touched: Date.now() };
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
          ...(reasoning ? { effort: reasoning } : {}),   // claude 思考强度：low/medium/high/xhigh/max（SDK Options.effort）
          ...(sessionId ? { resume: sessionId } : {}),
        },
      });
      session.query = q;
      // 拉一次该 provider/账号下可选模型，推给渲染层填「模型选择器」（/model 等价）。
      if (typeof q.supportedModels === 'function') {
        q.supportedModels().then((ms) => { cacheModels('claude', ms); emit({ type: 'models', models: ms }); }).catch(() => {});
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
async function sessionSend(sender, { cwd, provider, sessionId, prompt, permMode, model, reasoning, mcp, apiKey, attachments, lane }) {
  if (provider === 'cursor' && !lane) return cursorSend(sender, { cwd, sessionId, prompt: fileRefsText(prompt, attachments, true), permMode, model, apiKey });
  if (provider === 'codex') return codexSend(sender, { cwd, lane, sessionId, prompt: fileRefsText(prompt, attachments, true), permMode, model, reasoning });
  // gemini 无 streaming-input/视觉 → 附件按 @路径 文本引用（与 cursor 同）；支持 lane。
  if (provider === 'gemini') return geminiSend(sender, { cwd, lane, sessionId, prompt: fileRefsText(prompt, attachments, true), permMode, model, mcp });
  if (provider === 'copilot') return copilotSend(sender, { cwd, lane, sessionId, prompt: fileRefsText(prompt, attachments, true), permMode, model, mcp });
  const key = runKey(cwd, lane);
  let s = sessions.get(key);
  if (!s) s = startSession(sender, { cwd, provider, sessionId, permMode, model, reasoning, mcp, lane });
  if (!s) return { ok: false };
  // claude effort 无运行时 setter：思考强度变了就用新强度重建会话（resume 同一 sessionId，对话不丢）。
  const wantEffort = reasoning || null;
  if (s.query && wantEffort !== s.reasoning) {
    try { s.ac.abort(); } catch { /* */ }
    sessions.delete(key);
    s = startSession(sender, { cwd, provider, sessionId, permMode, model, reasoning, mcp, lane });
    if (!s) return { ok: false };
  }
  s.reasoning = wantEffort;
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
function sessionWarm(sender, { cwd, provider, sessionId, permMode, model, reasoning, mcp, apiKey, lane }) {
  if (provider === 'cursor' && !lane) return cursorWarm(sender, { cwd, sessionId, permMode, model, apiKey });
  if (provider === 'codex') return codexWarm(sender, { cwd, lane, sessionId, permMode, model, reasoning });
  if (provider === 'gemini') return geminiWarm(sender, { cwd, lane, sessionId, permMode, model, mcp });
  if (provider === 'copilot') return copilotWarm(sender, { cwd, lane, sessionId, permMode, model, mcp });
  if (sessions.has(runKey(cwd, lane))) return { ok: true };
  const s = startSession(sender, { cwd, provider, sessionId, permMode, model, reasoning, mcp, lane });
  return { ok: !!s };
}

/** 运行中改 MCP（/mcp 等价）：重设该会话启用的 MCP server，并回推连接状态。 */
async function sessionSetMcp({ cwd, mcp, lane }) {
  // ACP providers(gemini/copilot)：mcpServers 只能在 session/new 注入，无法像 claude 那样热更。
  // 不在这里硬杀连接（会留 session_closed 闪烁、且这里拿不到 sender 重建）——保持当前 mcpNames
  // 不变，下次 warm/send 会带上新的 mcp，ensure 里 sameMcpNames 比对发现变化即自动重建会话。
  { const k = runKey(cwd, lane);
    if (geminiSessions.has(k) || copilotSessions.has(k)) return { ok: true, deferred: true };
  }
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
  { const cx = codexSessions.get(runKey(cwd, lane)); if (cx) { cx.model = model || null; return { ok: true }; } }
  { const g = geminiSessions.get(runKey(cwd, lane)); if (g) { g.model = model || null; return { ok: true }; } }
  { const cp = copilotSessions.get(runKey(cwd, lane)); if (cp) { cp.model = model || null; if (cp.conn && model && model !== 'auto') { try { await cp.conn.request('session/set_model', { sessionId: cp.sessionId, modelId: model }); } catch { /* */ } } return { ok: true }; } }
  const s = sessions.get(runKey(cwd, lane));
  if (s?.query && typeof s.query.setModel === 'function') {
    try { await s.query.setModel(model || undefined); } catch { /* */ }
    s.model = model || null;   // 记录已应用，发送时不再重复 setModel
    return { ok: true };
  }
  return { ok: false };
}

/** 运行中切思考强度。codex 下回合按新值重起；claude 只记下，下次 sessionSend 检测到变化会带新
 *  effort 重建会话（无运行时 setEffort）。会话不存在则忽略（下次发送按选中值起）。 */
async function sessionSetReasoning({ cwd, reasoning, lane }) {
  const cx = codexSessions.get(runKey(cwd, lane));
  if (cx) { cx.reasoning = reasoning || null; return { ok: true }; }
  const s = sessions.get(runKey(cwd, lane));   // claude 常驻会话
  if (s) { s.reasoning = reasoning || null; return { ok: true }; }
  return { ok: false };
}

/** 中断当前回合，但保留常驻会话（可继续发）。 */
async function sessionInterrupt({ cwd, lane }) {
  if (!lane) {   // lane 是 claude 专用的并行车道；带 lane 时跳过 cursor 分支
    const cu = cursorSessions.get(cwd);
    if (cu) { try { if (cu.child) cu.child.kill('SIGTERM'); } catch { /* */ } return { ok: true }; }
  }
  { const cx = codexSessions.get(runKey(cwd, lane)); if (cx) { try { if (cx.child) cx.child.kill('SIGTERM'); } catch { /* */ } return { ok: true }; } }
  { const g = geminiSessions.get(runKey(cwd, lane)); if (g && g.conn) { try { g.conn.notify('session/cancel', { sessionId: g.sessionId }); } catch { /* */ } return { ok: true }; } }
  { const cp = copilotSessions.get(runKey(cwd, lane)); if (cp && cp.conn) { try { cp.conn.notify('session/cancel', { sessionId: cp.sessionId }); } catch { /* */ } return { ok: true }; } }
  const s = sessions.get(runKey(cwd, lane));
  if (s?.query) { try { await s.query.interrupt(); } catch { /* ignore */ } return { ok: true }; }
  return { ok: false };
}

/** 真正回收一条常驻 claude 会话：关输入流(EOF→子进程退出) + abort(SIGTERM 兜底)。 */
function killSessionByKey(key, reason) {
  const s = sessions.get(key);
  if (!s) return false;
  sessions.delete(key);
  clearPerms(key, reason || '已切换');
  try { s.input.close(); } catch { /* */ }   // 结束输入迭代 → claude 子进程收到 stdin EOF 自行退出
  try { s.ac.abort(); } catch { /* */ }       // 兜底：SDK abort → SIGTERM 子进程
  return true;
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
  {
    const key = runKey(cwd, lane);
    const cx = codexSessions.get(key);
    if (cx) {
      codexSessions.delete(key);
      try { if (cx.ac) cx.ac.abort(); } catch { /* */ }
      try { if (cx.child) cx.child.kill('SIGTERM'); } catch { /* */ }
      return { ok: true };
    }
  }
  { const gk = runKey(cwd, lane); const g = geminiSessions.get(gk);
    if (g) { geminiSessions.delete(gk); try { g.conn && g.conn.kill(); } catch { /* */ } return { ok: true }; } }
  { const ck = runKey(cwd, lane); const cp = copilotSessions.get(ck);
    if (cp) { copilotSessions.delete(ck); try { cp.conn && cp.conn.kill(); } catch { /* */ } return { ok: true }; } }
  return { ok: killSessionByKey(runKey(cwd, lane)) };
}

/** 全部回收：渲染进程重载/崩溃/退出时调——否则旧会话的 claude 子进程会变孤儿常驻
 *  （实测一天下来累积了 9 条、共 ~500MB、最久 20h+）。幂等。 */
function killAllSessions() {
  const n = sessions.size + cursorSessions.size + codexSessions.size + geminiSessions.size + copilotSessions.size;
  for (const key of [...sessions.keys()]) killSessionByKey(key, '已重置');
  for (const [cwd, cu] of [...cursorSessions]) {
    cursorSessions.delete(cwd);
    try { if (cu.ac) cu.ac.abort(); } catch { /* */ }
    try { if (cu.child) cu.child.kill('SIGTERM'); } catch { /* */ }
  }
  for (const [key, cx] of [...codexSessions]) {
    codexSessions.delete(key);
    try { if (cx.ac) cx.ac.abort(); } catch { /* */ }
    try { if (cx.child) cx.child.kill('SIGTERM'); } catch { /* */ }
  }
  for (const [key, g] of [...geminiSessions]) {
    geminiSessions.delete(key);
    try { if (g.conn) g.conn.kill(); } catch { /* */ }
  }
  for (const [key, cp] of [...copilotSessions]) {
    copilotSessions.delete(key);
    try { if (cp.conn) cp.conn.kill(); } catch { /* */ }
  }
  // Backstop: CLI children (direct children of this main process) — claude ignores
  // SIGTERM and can orphan (observed 20h+). On full teardown SIGKILL every one of
  // ours. "stream-json" matches claude/cursor (--output-format) AND gemini (-o).
  try {
    require('child_process').execFile('pkill', ['-9', '-P', String(process.pid), '-f', 'stream-json'], () => {});
    require('child_process').execFile('pkill', ['-9', '-P', String(process.pid), '-f', 'experimental-acp'], () => {});
  } catch { /* pkill unavailable (non-unix) — graceful close above still applies */ }
  if (n) console.log('[localAgent] killAllSessions · reaped %d resident session(s)', n);
  return n;
}

/** 闲置回收：超过 IDLE_MS 没有任何流量(发送/流式)的常驻会话被收掉，下次发送自动重新冷启。
 *  防止后台多会话/预热会话长期占着 ~60MB/条 的 claude 子进程。 */
const SESSION_IDLE_MS = 15 * 60 * 1000;
function reapIdleSessions() {
  const now = Date.now();
  for (const [key, s] of sessions) {
    if (now - (s.touched || 0) > SESSION_IDLE_MS) {
      console.log('[localAgent] reap idle session · %s (idle %dm)', key, Math.round((now - s.touched) / 60000));
      killSessionByKey(key, '闲置回收');
    }
  }
  for (const [key, cx] of codexSessions) {
    if (now - (cx.touched || 0) > SESSION_IDLE_MS) {
      console.log('[localAgent] reap idle codex · %s', key);
      codexSessions.delete(key);
      try { if (cx.ac) cx.ac.abort(); } catch { /* */ }
      try { if (cx.child) cx.child.kill('SIGTERM'); } catch { /* */ }
    }
  }
  // 常驻 gemini ACP 进程同样闲置回收(下次发送 geminiEnsure 自动重建)。
  for (const [key, g] of geminiSessions) {
    if (g.conn && now - (g.touched || 0) > SESSION_IDLE_MS) {
      console.log('[localAgent] reap idle gemini · %s', key);
      try { g.conn.kill(); } catch { /* */ }
      geminiSessions.delete(key);
    }
  }
  for (const [key, cp] of copilotSessions) {
    if (cp.conn && now - (cp.touched || 0) > SESSION_IDLE_MS) {
      console.log('[localAgent] reap idle copilot · %s', key);
      try { cp.conn.kill(); } catch { /* */ }
      copilotSessions.delete(key);
    }
  }
  // 僵尸权限请求：渲染层崩溃/弹窗被无限期忽略 → 超 30 分钟拒绝并清掉，
  // 否则 Map 记录和挂着的 canUseTool Promise 永久滞留。
  for (const [permId, e] of pendingPerms) {
    if (now - (e.at || 0) > PERM_MAX_AGE_MS) {
      pendingPerms.delete(permId);
      try { e.settle({ behavior: 'deny', message: '权限请求超时（无人应答）' }); } catch { /* */ }
    }
  }
}
const PERM_MAX_AGE_MS = 30 * 60 * 1000;

/** 会话进行中切换权限模式（Tab 切档即时生效）。 */
async function sessionSetPermMode({ cwd, permMode, lane }) {
  if (!lane) { const cu = cursorSessions.get(cwd); if (cu) { cu.permMode = permMode || 'force'; return { ok: true }; } }
  { const cx = codexSessions.get(runKey(cwd, lane)); if (cx) { cx.permMode = permMode || 'default'; return { ok: true }; } }
  { const g = geminiSessions.get(runKey(cwd, lane)); if (g) { g.permMode = permMode || 'default'; return { ok: true }; } }
  { const cp = copilotSessions.get(runKey(cwd, lane)); if (cp) { cp.permMode = permMode || 'default'; return { ok: true }; } }
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
 * 实时驱动 Codex —— 无状态一次性进程（每回合 spawn 一次 `codex exec --json`）。
 * 新会话用 `codex -C <cwd> exec ...`，续接用 `codex exec resume <sessionId> ...`。
 * stdout JSONL 被翻成 Claude SDK 同形事件，渲染层无需分叉。
 * ------------------------------------------------------------------ */
const codexSessions = new Map();   // runKey(cwd,lane) -> { child, ac, sessionId, model, reasoning, permMode }

function codexTopPermArgs(permMode) {
  if (permMode === 'bypassPermissions' || permMode === 'force') return ['--dangerously-bypass-approvals-and-sandbox'];
  return ['-a', 'never'];
}

function codexExecSandboxArgs(permMode) {
  if (permMode === 'bypassPermissions' || permMode === 'force') return [];
  if (permMode === 'plan' || permMode === 'ask') return ['-s', 'read-only'];
  return ['-s', 'workspace-write'];
}

function codexReasoningArgs(reasoning) {
  const val = String(reasoning || '').trim().toLowerCase();
  if (!/^(minimal|low|medium|high|xhigh)$/.test(val)) return [];
  return ['-c', `model_reasoning_effort="${val}"`];
}

function codexSpawnArgs({ cwd, prompt, sessionId, model, reasoning, permMode }) {
  const text = prompt || '';
  if (sessionId) {
    const args = [...codexTopPermArgs(permMode), ...codexReasoningArgs(reasoning), 'exec', 'resume', '--json', '--skip-git-repo-check'];
    if (model) args.push('-m', model);
    args.push(sessionId, text);
    return args;
  }
  const args = [...codexTopPermArgs(permMode), ...codexReasoningArgs(reasoning), '-C', cwd, 'exec', '--json', '--skip-git-repo-check'];
  if (model) args.push('-m', model);
  args.push(...codexExecSandboxArgs(permMode), text);
  return args;
}

function codexTextDeltaEvent(text) {
  if (!text) return null;
  return { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } };
}

function codexExtractEventText(p) {
  if (!p) return '';
  if (typeof p.delta === 'string') return p.delta;
  if (typeof p.text === 'string') return p.text;
  if (typeof p.message === 'string') return p.message;
  if (p.delta && typeof p.delta.text === 'string') return p.delta.text;
  return '';
}

function codexIsSandboxPermissionFailure(text) {
  return /Operation not permitted|Permission denied|failed due sandbox|sandbox permissions/i.test(String(text || ''));
}

function codexRememberPermissionFailure(ctx, command, output) {
  const text = [command, output].filter(Boolean).join('\n');
  if (!codexIsSandboxPermissionFailure(text)) return;
  ctx.permissionFailure = {
    command: command || '',
    output: String(output || '').slice(0, 2000),
  };
}

function codexMessageEvent(text, uuid) {
  const body = String(text || '');
  if (!body.trim()) return null;
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: body }] }, uuid: uuid || null };
}

function codexToolEvent(item) {
  if (!item || item.type !== 'command_execution') return null;
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        name: 'exec_command',
        input: { cmd: item.command || '' },
        id: item.id,
      }],
    },
    uuid: item.id || null,
  };
}

function codexToolResultEvent(item) {
  if (!item || item.type !== 'command_execution') return null;
  const text = item.aggregated_output || (item.exit_code == null ? '' : `exit_code: ${item.exit_code}`);
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        content: String(text || '').slice(0, 8000),
        tool_use_id: item.id,
        is_error: item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0),
      }],
    },
    uuid: item.id || null,
  };
}

function codexNormalizeStdoutEvent(o, ctx) {
  const out = [];
  const p = (o && o.payload) || o || {};
  const typ = o && o.type;
  const payloadType = p.type;

  if (typ === 'thread.started' && p.thread_id) {
    ctx.sessionId = p.thread_id;
    out.push({ type: 'system', subtype: 'init', session_id: p.thread_id });
    return out;
  }

  if (typ === 'item.started' || typ === 'item.completed') {
    const item = p.item || {};
    if (item.type === 'agent_message') {
      codexRememberPermissionFailure(ctx, '', item.text);
      const ev = codexMessageEvent(item.text, item.id);
      if (ev) { ctx.sawAssistant = true; ctx.sawVisible = true; out.push(ev); }
      return out;
    }
    if (item.type === 'command_execution') {
      codexRememberPermissionFailure(ctx, item.command, item.aggregated_output);
      if (typ === 'item.started') {
        const ev = codexToolEvent(item);
        if (ev) { ctx.sawVisible = true; out.push(ev); }
      } else {
        const ev = codexToolResultEvent(item);
        if (ev) { ctx.sawVisible = true; out.push(ev); }
      }
      return out;
    }
  }

  if (typ === 'turn.completed') {
    if (!ctx.permissionFailure) out.push({ type: 'result', subtype: 'success', session_id: ctx.sessionId || undefined });
    return out;
  }

  const sid = p.id || p.session_id || p.sessionId || p.thread_id || p.conversation_id;
  if (typ !== 'session_meta' && /session|thread/i.test(String(typ || '')) && sid) {
    ctx.sessionId = sid;
    out.push({ type: 'system', subtype: 'init', session_id: sid });
  }

  if (typ === 'session_meta' && p.id) {
    ctx.sessionId = p.id;
    out.push({ type: 'system', subtype: 'init', session_id: p.id });
    return out;
  }

  if (typ === 'response_item' || payloadType === 'message' || payloadType === 'function_call' || payloadType === 'function_call_output') {
    const item = typ === 'response_item' ? p : p.item || p;
    if (item.type === 'message') {
      if (item.role === 'assistant') {
        const parts = codexPartsFromMessage(item);
        if (parts.length) {
          ctx.sawAssistant = true;
          ctx.sawVisible = true;
          out.push({ type: 'assistant', message: { role: 'assistant', content: parts.map((part) => ({ type: 'text', text: part.text })).filter((part) => part.text) }, uuid: item.id || null });
        }
      }
      return out;
    }
    if (item.type === 'function_call') {
      const part = codexPartFromResponseItem(item);
      if (part) { ctx.sawVisible = true; out.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: part.name, input: part.input, id: part.id }] }, uuid: item.call_id || null }); }
      return out;
    }
    if (item.type === 'function_call_output') {
      const part = codexToolResultFromResponseItem(item);
      if (part) { ctx.sawVisible = true; out.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_result', content: part.text, tool_use_id: part.toolUseId }] }, uuid: item.call_id || null }); }
      return out;
    }
  }

  if (typ === 'event_msg') {
    if (payloadType === 'agent_message_delta' || payloadType === 'agent_message_chunk') {
      const ev = codexTextDeltaEvent(codexExtractEventText(p));
      if (ev) { ctx.sawVisible = true; out.push(ev); }
    }
    if (payloadType === 'task_complete' || payloadType === 'turn_complete' || payloadType === 'turn_completed') {
      if (!ctx.permissionFailure) out.push({ type: 'result', subtype: 'success', session_id: ctx.sessionId || undefined });
    }
    if (payloadType === 'error') out.push({ type: 'error', error: p.message || p.error || 'Codex 执行失败' });
    return out;
  }

  if (/delta/i.test(String(typ || payloadType || ''))) {
    const ev = codexTextDeltaEvent(codexExtractEventText(p));
    if (ev) { ctx.sawVisible = true; out.push(ev); }
  }
  if (typ === 'result' || payloadType === 'result') {
    if (!ctx.permissionFailure) out.push({ type: 'result', subtype: p.subtype || 'success', session_id: ctx.sessionId || sid || undefined });
  }
  if (typ === 'error' || payloadType === 'error') {
    out.push({ type: 'error', error: p.message || p.error || 'Codex 执行失败' });
  }
  return out;
}

function codexDrainStdoutBuffer(buf, ctx, onEvent) {
  const rest = String(buf || '').trim();
  if (!rest) return;
  for (const line of rest.split(/\n+/)) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    for (const ev of codexNormalizeStdoutEvent(o, ctx)) onEvent(ev);
  }
}

async function codexLatestSessionIdForCwd(cwd, sinceMs) {
  const sessions = await codexListSessions(cwd);
  const hit = sessions.find((s) => !sinceMs || s.updatedAt >= sinceMs - 120000);
  return hit ? hit.sessionId : null;
}

let _codexModels = null;
let _codexModelsInflight = null;

function parseCodexModels(stdout) {
  let o;
  try { o = JSON.parse(String(stdout || '{}')); } catch { return []; }
  const list = Array.isArray(o.models) ? o.models : [];
  return list
    .filter((m) => m && m.slug && m.visibility !== 'hidden')
    .map((m) => ({
      value: m.slug,
      displayName: m.display_name || m.slug,
      description: m.description || undefined,
      defaultReasoningLevel: m.default_reasoning_level || undefined,
      supportedReasoningLevels: Array.isArray(m.supported_reasoning_levels)
        ? m.supported_reasoning_levels
          .filter((x) => x && x.effort)
          .map((x) => ({ effort: String(x.effort), description: x.description || undefined }))
        : undefined,
    }));
}

function fetchCodexModels(bin, emit) {
  if (_codexModels) { if (_codexModels.length) emit({ type: 'models', models: _codexModels }); return; }
  if (!_codexModelsInflight) {
    _codexModelsInflight = new Promise((resolve) => {
      execFile(bin, ['debug', 'models', '--bundled'], { env: childEnv(), timeout: 10000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        _codexModels = err ? [] : parseCodexModels(stdout);
        cacheModels('codex', _codexModels);
        _codexModelsInflight = null;
        resolve(_codexModels);
      });
    });
  }
  _codexModelsInflight.then((models) => { if (models && models.length) emit({ type: 'models', models }); });
}

function codexWarm(_sender, { cwd, lane, sessionId, permMode, model, reasoning }) {
  const bin = resolveBin('codex');
  const key = runKey(cwd, lane);
  const prev = codexSessions.get(key);
  if (!prev) codexSessions.set(key, { child: null, ac: null, sessionId: sessionId || null, model: model || null, reasoning: reasoning || null, permMode: permMode || 'default', touched: Date.now() });
  else { if (sessionId !== undefined) prev.sessionId = sessionId || null; if (model !== undefined) prev.model = model || null; if (reasoning !== undefined) prev.reasoning = reasoning || null; if (permMode) prev.permMode = permMode; prev.touched = Date.now(); }
  if (bin) fetchCodexModels(bin, (ev) => { try { _sender && _sender.send('localAgent:event', { cwd: key, ev }); } catch { /* ignore */ } });
  return { ok: true };
}

function codexSend(sender, { cwd, lane, sessionId, prompt, permMode, model, reasoning }) {
  const bin = resolveBin('codex');
  const key = runKey(cwd, lane);
  if (!bin) { sender.send('localAgent:event', { cwd: key, ev: { type: 'error', error: '未找到 codex，请确认已安装 Codex CLI' } }); return { ok: false }; }
  const prev = codexSessions.get(key);
  if (prev && prev.child) { try { if (prev.ac) prev.ac.abort(); } catch { /* */ } try { prev.child.kill('SIGTERM'); } catch { /* */ } }

  const ac = new AbortController();
  const resumeId = (prev && prev.sessionId) || sessionId || null;
  const wantModel = model || (prev && prev.model) || null;
  const wantReasoning = reasoning || (prev && prev.reasoning) || null;
  const wantPerm = permMode || (prev && prev.permMode) || 'default';
  const startedAt = Date.now();
  const args = codexSpawnArgs({ cwd, prompt, sessionId: resumeId, model: wantModel, reasoning: wantReasoning, permMode: wantPerm });

  const emit = makeBatchedEmit((ev) => {
    if (sender.isDestroyed()) { try { ac.abort(); } catch { /* */ } return false; }
    try { sender.send('localAgent:event', { cwd: key, ev }); return true; }
    catch { try { ac.abort(); } catch { /* */ } return false; }
  });

  const offerSandboxRetry = () => {
    if (wantPerm === 'bypassPermissions' || wantPerm === 'force') return false;
    if (wantPerm === 'plan' || wantPerm === 'ask') return false;
    if (!ctx.permissionFailure) return false;
    const permId = `perm-${Math.random().toString(36).slice(2, 10)}`;
    const failedCommand = ctx.permissionFailure.command || 'codex exec';
    pendingPerms.set(permId, {
      cwd: key,
      at: Date.now(),
      settle: (decision) => {
        if (decision && decision.behavior === 'allow') {
          codexSend(sender, { cwd, lane, sessionId: session.sessionId || resumeId, prompt, permMode: 'bypassPermissions', model: wantModel, reasoning: wantReasoning });
        } else {
          emit({ type: 'error', error: (decision && decision.message) || '已拒绝' });
          emit({ type: 'session_closed' });
        }
      },
    });
    emit({
      type: 'permission_request',
      permId,
      toolName: 'Bash',
      input: { command: failedCommand, error: ctx.permissionFailure.output },
      title: 'Codex 需要在 bypass 模式下重跑当前请求',
      displayName: 'Codex permission',
      description: '刚才的命令被沙箱拦截。允许后，Chaya 会用 Codex bypass 权限重跑这一整轮请求。',
      suggestions: null,
    });
    return true;
  };

  let child;
  try {
    child = spawn(bin, args, { cwd, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    emit({ type: 'error', error: String(e && e.message || e) });
    return { ok: false };
  }

  const session = { child, ac, sessionId: resumeId, model: wantModel, reasoning: wantReasoning, permMode: wantPerm, touched: Date.now() };
  codexSessions.set(key, session);
  ac.signal.addEventListener('abort', () => { try { child.kill('SIGTERM'); } catch { /* */ } });
  if (resumeId) emit({ type: 'system', subtype: 'init', session_id: resumeId });
  fetchCodexModels(bin, emit);

  const ctx = { sessionId: resumeId, sawAssistant: false, sawVisible: false };
  let sawResult = false;
  let stderrBuf = '';
  let buf = '';
  const handleCodexEvent = (ev) => {
    if (ev.type === 'result') sawResult = true;
    if (ev.session_id) session.sessionId = ev.session_id;
    return emit(ev);
  };
  child.stdout.on('data', (d) => {
    buf = capTail(buf + d.toString('utf8'), STREAM_LINEBUF_MAX);
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      session.touched = Date.now();
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      for (const ev of codexNormalizeStdoutEvent(o, ctx)) {
        if (!handleCodexEvent(ev)) return;
      }
      if (ctx.sessionId) session.sessionId = ctx.sessionId;
    }
  });
  child.stderr.on('data', (d) => { stderrBuf = capTail(stderrBuf + d.toString('utf8'), STDERR_TAIL_MAX); });
  child.on('error', (e) => { emit({ type: 'error', error: String(e && e.message || e) }); emit({ type: 'session_closed' }); });
  child.on('close', (code) => {
    session.child = null;
    (async () => {
      codexDrainStdoutBuffer(buf, ctx, handleCodexEvent);
      if (ctx.sessionId) session.sessionId = ctx.sessionId;
      if (!session.sessionId) {
        const sid = await codexLatestSessionIdForCwd(cwd, startedAt).catch(() => null);
        if (sid) { session.sessionId = sid; emit({ type: 'system', subtype: 'init', session_id: sid }); }
      }
      if (sawResult && !ctx.sawVisible) {
        const msg = stderrBuf.trim() || 'Codex 已结束，但没有返回任何可显示内容';
        emit({ type: 'error', error: msg });
        emit({ type: 'session_closed' });
        return;
      }
      if (!sawResult) {
        if (code === 0 || ctx.sawAssistant) {
          if (!offerSandboxRetry()) emit({ type: 'result', subtype: 'success', session_id: session.sessionId || undefined });
        } else {
          const msg = stderrBuf.trim() || (code ? `codex 退出码 ${code}` : 'Codex 会话结束');
          codexRememberPermissionFailure(ctx, '', msg);
          if (!offerSandboxRetry()) {
            emit({ type: 'error', error: msg });
            emit({ type: 'session_closed' });
          }
        }
      }
    })();
  });

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
        cacheModels('cursor', _cursorModels);
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
  const emit = makeBatchedEmit((ev) => {
    if (sender.isDestroyed()) { try { ac.abort(); } catch { /* */ } return false; }
    try { sender.send('localAgent:event', { cwd, ev }); return true; }
    catch { try { ac.abort(); } catch { /* */ } return false; }
  });

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
    buf = capTail(buf + d.toString('utf8'), STREAM_LINEBUF_MAX);
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
  child.stderr.on('data', (d) => { stderrBuf = capTail(stderrBuf + d.toString('utf8'), STDERR_TAIL_MAX); });
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
 * 实时驱动 Gemini —— 常驻 ACP agent（`gemini --experimental-acp`，JSON-RPC/ndjson）。
 * 比 stream-json 每回合 spawn 更优：常驻、双向流式、协议自带逐工具权限请求、按 id 续接。
 * 用 gemini 自身登录态(oauth)，零鉴权代码。文件读写由 agent 委托回我们(fs/* 请求)。
 * 按 runKey(cwd,lane) 寻址；cwd 统一传 realpath，确保历史落盘 hash 与读取一致。
 * ------------------------------------------------------------------ */
const geminiSessions = new Map();   // runKey -> { conn, sessionId, model, permMode, turnCtx, key, emit, _init }
const GEMINI_MODELS = [
  { value: 'auto', displayName: 'Auto', description: 'Gemini 自动选择' },
  { value: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
  { value: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
];

/* claude 模型别名（Claude Code 稳定解析）：会话起来后会被真实 supportedModels 覆盖进缓存。 */
const CLAUDE_MODELS = [
  { value: 'default', displayName: '默认' },
  { value: 'opus', displayName: 'Claude Opus' },
  { value: 'sonnet', displayName: 'Claude Sonnet' },
  { value: 'haiku', displayName: 'Claude Haiku' },
];

/* 进程级模型缓存：任意会话拿到真实 supportedModels 就存这里，listModels 优先返回它。
 * 带 TTL：app 常开好几天时缓存会陈旧（CLI 升级带来新模型），过期就重新探测。 */
const MODELS_TTL_MS = 60 * 60 * 1000;   // 1h
const _modelsByProvider = {};
function cacheModels(provider, models) {
  if (provider && Array.isArray(models) && models.length) _modelsByProvider[provider] = { at: Date.now(), models };
}
function cachedModels(provider) {
  const c = _modelsByProvider[provider];
  return (c && Date.now() - c.at < MODELS_TTL_MS) ? c.models : null;
}

/** 不开聊天会话也能拿 claude 真实可选模型：起一次性 SDK query 只调 supportedModels，拿到即收尾。
 *  等价于终端 /model 列表——随本机 claude/SDK 升级自动带上新模型(opus/sonnet/haiku/fable…)，无需写死。 */
let _claudeProbe = null;   // 同时并发只探一次
async function probeClaudeModels() {
  if (_claudeProbe) return _claudeProbe;
  _claudeProbe = (async () => {
    const bin = resolveBin('claude');
    if (!bin) return [];
    const { query } = await getSdk();
    const input = makeInputQueue();
    const ac = new AbortController();
    const q = query({
      prompt: input.iter,
      options: {
        cwd: os.tmpdir(),
        permissionMode: 'default',
        pathToClaudeCodeExecutable: bin,
        abortController: ac,
        env: childEnv(),
        settingSources: [],      // 探测而已，不必加载 CLAUDE.md/权限
        strictMcpConfig: true,   // 不连任何 MCP，冷启更快
      },
    });
    try {
      if (typeof q.supportedModels !== 'function') return [];
      const ms = await q.supportedModels();
      return Array.isArray(ms) ? ms : [];
    } finally {
      try { input.close(); } catch { /* */ }
      try { ac.abort(); } catch { /* */ }
    }
  })().catch(() => []).finally(() => { _claudeProbe = null; });
  return _claudeProbe;
}

/** 不开聊天会话也能拿 copilot 真实可选模型：起一次性 ACP 连接，initialize → session/new
 *  拿到 availableModels 即关。copilot CLI 没有「列模型」命令，模型只在 session/new 响应里带回。 */
let _copilotProbe = null;
async function probeCopilotModels() {
  if (_copilotProbe) return _copilotProbe;
  _copilotProbe = (async () => {
    const bin = resolveBin('copilot');
    if (!bin) return [];
    let cwd = os.tmpdir(); try { cwd = fs.realpathSync(cwd); } catch { /* */ }
    const conn = new geminiAcp.AcpConn({
      bin, args: ['--acp'], cwd, env: childEnv(),
      onNotify: () => {}, onRequest: async () => ({}), onClose: () => {}, onError: () => {},
    });
    try {
      await conn.request('initialize', { protocolVersion: geminiAcp.ACP_PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } });
      const ns = await conn.request('session/new', { cwd, mcpServers: resolveMcpAcp(cwd, []) });
      return mapCopilotModels(ns);
    } finally {
      try { conn.kill(); } catch { /* */ }
    }
  })().catch(() => []).finally(() => { _copilotProbe = null; });
  return _copilotProbe;
}

/** 不开聊天会话也能拿 gemini 真实可选模型：起一次性 ACP 连接 initialize → session/new，
 *  读响应里的 models.availableModels（ACP 标准结构，新版 gemini CLI 会带）。拿不到才退写死列表。 */
let _geminiProbe = null;
async function probeGeminiModels() {
  if (_geminiProbe) return _geminiProbe;
  _geminiProbe = (async () => {
    const bin = resolveBin('gemini');
    if (!bin) return [];
    let cwd = os.tmpdir(); try { cwd = fs.realpathSync(cwd); } catch { /* */ }
    const conn = new geminiAcp.AcpConn({
      bin, cwd, env: childEnv(),   // args 默认 --experimental-acp
      onNotify: () => {}, onRequest: async () => ({}), onClose: () => {}, onError: () => {},
    });
    try {
      await conn.request('initialize', { protocolVersion: geminiAcp.ACP_PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } });
      const ns = await conn.request('session/new', { cwd, mcpServers: resolveMcpAcp(cwd, []) });
      return mapCopilotModels(ns);   // 同 ACP availableModels 结构
    } finally {
      try { conn.kill(); } catch { /* */ }
    }
  })().catch(() => []).finally(() => { _geminiProbe = null; });
  return _geminiProbe;
}

/** 主动取某 provider 的可选模型（无需先开会话）：
 *  cursor/gemini 真实拉取；claude/codex/copilot 用真实缓存(若有)否则静态兜底。一律可被前端自由输入覆盖。 */
async function listModels(provider, { apiKey } = {}) {
  { const c = cachedModels(provider); if (c) return c; }
  switch (provider) {
    case 'gemini': {
      const models = await probeGeminiModels();   // ACP session/new 探测，新版 CLI 带真实模型
      if (models.length) { cacheModels('gemini', models); return models; }
      return GEMINI_MODELS;                        // 旧版不带 → 退写死的别名
    }
    case 'claude': {
      const models = await probeClaudeModels();   // 真实 /model 列表，随 SDK 升级自动更新
      if (models.length) { cacheModels('claude', models); return models; }
      return CLAUDE_MODELS;                        // 探测失败(未装/超旧)才退静态别名
    }
    case 'cursor': {
      const bin = resolveBin('cursor-agent');
      if (!bin) return [];
      const models = await new Promise((res) => {
        execFile(bin, ['models'], { env: { ...childEnv(), ...(apiKey ? { CURSOR_API_KEY: apiKey } : {}) }, timeout: 10000 },
          (err, stdout) => res(err ? [] : cursorDriver.parseModels(stdout)));
      });
      cacheModels('cursor', models);
      return models;
    }
    case 'codex': {
      const bin = resolveBin('codex');
      if (!bin) return [];
      const models = await new Promise((res) => {
        execFile(bin, ['debug', 'models', '--bundled'], { env: childEnv(), timeout: 10000, maxBuffer: 16 * 1024 * 1024 },
          (err, stdout) => res(err ? [] : parseCodexModels(stdout)));
      });
      cacheModels('codex', models);
      return models;
    }
    case 'copilot': {
      const models = await probeCopilotModels();   // ACP session/new 探测，随登录态/CLI 升级更新
      if (models.length) { cacheModels('copilot', models); return models; }
      return [];                                    // 探测失败(未装/未 login) 留空让前端自由输入
    }
    default: return [];
  }
}

/** ACP session/request_permission → 复用渲染层既有权限 UI(canUseTool 同款)。
 *  自动档(bypass/acceptEdits) 直接放行，default 弹给用户。返回 ACP outcome。 */
function geminiPermission(sess, params) {
  const options = Array.isArray(params.options) ? params.options : [];
  const tc = params.toolCall || {};
  const pick = (...kinds) => { for (const k of kinds) { const o = options.find((x) => x.kind === k); if (o) return o; } return options[0]; };
  const sel = (o) => ({ outcome: o ? { outcome: 'selected', optionId: o.optionId } : { outcome: 'cancelled' } });
  const pm = (sess && sess.permMode) || 'default';
  if (pm === 'bypassPermissions') return Promise.resolve(sel(pick('allow_always', 'allow_once')));
  if (pm === 'acceptEdits' && tc.kind === 'edit') return Promise.resolve(sel(pick('allow_once', 'allow_always')));
  return new Promise((resolve) => {
    const permId = `perm-${Math.random().toString(36).slice(2, 10)}`;
    pendingPerms.set(permId, { cwd: sess ? sess.key : '', at: Date.now(), settle: (decision) => {
      const allow = decision && decision.behavior === 'allow';
      resolve(sel(allow ? pick('allow_once', 'allow_always') : pick('reject_once', 'reject_always')));
    } });
    const { verb, input } = geminiAcp.mapAcpTool(tc.kind, tc.rawInput, tc.title);
    sess.emit({ type: 'permission_request', permId, toolName: verb, input, title: tc.title || verb, displayName: verb, description: tc.title || '', suggestions: null });
  });
}

/** 确保某 key 有一条常驻 ACP 会话(initialize + session/new|load)。并发安全(_init)。 */
async function geminiEnsure(sender, { cwd, lane, sessionId, permMode, model, mcp }) {
  const key = runKey(cwd, lane);
  let s = geminiSessions.get(key);
  if (s) {
    if (model !== undefined) s.model = model || s.model;
    if (permMode) s.permMode = permMode;
    if (s._init) { try { await s._init; } catch { /* */ } }
    if (s.conn) {
      // ACP 只在 session/new 时吃 mcpServers，无法热更：mcp 选择变了就杀掉重建，否则复用。
      if (mcp === undefined || sameMcpNames(s.mcpNames, mcp)) return geminiSessions.get(key);
      try { s.conn.kill(); } catch { /* */ }
      geminiSessions.delete(key);
    }
  }
  const bin = resolveBin('gemini');
  if (!bin) { sender.send('localAgent:event', { cwd: key, ev: { type: 'error', error: '未找到 gemini，请确认已安装 gemini CLI' } }); return null; }
  let realCwd = cwd; try { realCwd = fs.realpathSync(cwd); } catch { /* */ }
  const emit = makeBatchedEmit((ev) => { if (sender.isDestroyed()) return false; try { sender.send('localAgent:event', { cwd: key, ev }); return true; } catch { return false; } });
  const mcpNames = Array.isArray(mcp) ? mcp.slice() : (s && s.mcpNames) || [];
  const mcpServers = resolveMcpAcp(cwd, mcpNames);
  s = { conn: null, sessionId: sessionId || null, model: (model !== undefined ? model : null), permMode: permMode || 'default', turnCtx: geminiAcp.makeTurnState(), key, emit, _init: null, mcpNames, touched: Date.now() };
  geminiSessions.set(key, s);
  s._init = (async () => {
    const conn = new geminiAcp.AcpConn({
      bin, cwd: realCwd, env: childEnv(),
      onNotify: (m, p) => { if (m !== 'session/update') return; const cur = geminiSessions.get(key); if (!cur) return; cur.touched = Date.now(); if (cur.replaying) return; for (const ev of geminiAcp.normalizeUpdate(p, cur.turnCtx)) emit(ev); },
      onRequest: async (m, p) => {
        if (m === 'fs/read_text_file') { try { return { content: await fsp.readFile(p.path, 'utf8') }; } catch { return { content: '' }; } }
        if (m === 'fs/write_text_file') { try { await fsp.mkdir(path.dirname(p.path), { recursive: true }); await fsp.writeFile(p.path, p.content ?? ''); } catch { /* */ } return null; }
        if (m === 'session/request_permission') return geminiPermission(geminiSessions.get(key), p);
        return {};
      },
      onClose: () => { emit({ type: 'session_closed' }); clearPerms(key, '会话结束'); geminiSessions.delete(key); },
      onError: (e) => emit({ type: 'error', error: String(e && e.message || e) }),
    });
    s.conn = conn;
    await conn.request('initialize', { protocolVersion: geminiAcp.ACP_PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } });
    let nsModels = [];
    if (s.sessionId) {
      // session/load 的历史回放(session/update)丢弃——历史已由 readSession 渲染，避免重复两遍。
      s.replaying = true;
      try { await conn.request('session/load', { cwd: realCwd, mcpServers, sessionId: s.sessionId }); }
      catch { const ns = await conn.request('session/new', { cwd: realCwd, mcpServers }); s.sessionId = ns.sessionId; nsModels = mapCopilotModels(ns); }
      finally { s.replaying = false; }
    } else {
      const ns = await conn.request('session/new', { cwd: realCwd, mcpServers });
      s.sessionId = ns.sessionId; nsModels = mapCopilotModels(ns);
    }
    const models = nsModels.length ? nsModels : GEMINI_MODELS;   // 新版 CLI 带真实模型，旧版退写死
    cacheModels('gemini', models);
    emit({ type: 'models', models });
  })();
  try { await s._init; } catch (e) { emit({ type: 'error', error: 'gemini ACP 初始化失败: ' + (e && e.message || e) }); try { s.conn && s.conn.kill(); } catch { /* */ } geminiSessions.delete(key); return null; }
  s._init = null;
  return geminiSessions.get(key);
}

/** 发一个 gemini 回合：常驻 ACP session/prompt，流式 update 归一回渲染层。 */
async function geminiSend(sender, { cwd, lane, sessionId, prompt, permMode, model, mcp }) {
  const s = await geminiEnsure(sender, { cwd, lane, sessionId, permMode, model, mcp });
  if (!s) return { ok: false };
  s.turnCtx = geminiAcp.makeTurnState();   // 新回合的累计/工具状态
  s.touched = Date.now();
  const emit = s.emit;
  emit({ type: 'system', subtype: 'init', session_id: s.sessionId });   // 让渲染层拿到真实 sessionId
  try {
    const res = await s.conn.request('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: prompt }] });
    // 收尾：累计文本补一条 assistant 气泡(否则 livePreview 在 finalize 被丢弃) + result。
    const ctx = s.turnCtx;
    if (!ctx.emittedFinal && ctx.accum) emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: ctx.accum }] } });
    const stop = (res && res.stopReason) || 'end_turn';
    emit({ type: 'result', subtype: stop === 'end_turn' ? 'success' : stop, session_id: s.sessionId });
  } catch (e) {
    emit({ type: 'error', error: String(e && e.message || e) });
    emit({ type: 'session_closed' });
  }
  return { ok: true };
}

/** gemini 预热：建立常驻 ACP 连接(initialize + session)，首发即暖。失败静默。 */
function geminiWarm(sender, { cwd, lane, sessionId, permMode, model, mcp }) {
  void geminiEnsure(sender, { cwd, lane, sessionId, permMode, model, mcp });
  return { ok: true };
}

/* ============================================================
 * Copilot ACP —— GitHub Copilot CLI 的 Agent Client Protocol（`copilot --acp`）。
 *   复用 gemini 的 ACP 驱动(geminiAcp)，仅 bin/args 不同；用 copilot 自身登录态(copilot login)。
 *   优势：loadSession 支持续接；session/new 直接返回可用模型列表(多模型)。
 * ============================================================ */
const copilotSessions = new Map();   // runKey -> { conn, sessionId, model, permMode, turnCtx, key, emit, _init, models }
function mapCopilotModels(ns) {
  const list = (ns && ns.models && ns.models.availableModels) || [];
  return list.map((m) => ({ value: m.modelId, displayName: m.name || m.modelId, description: m.description || '' }));
}
async function copilotEnsure(sender, { cwd, lane, sessionId, permMode, model, mcp }) {
  const key = runKey(cwd, lane);
  let s = copilotSessions.get(key);
  if (s) {
    if (model !== undefined) s.model = model || s.model;
    if (permMode) s.permMode = permMode;
    if (s._init) { try { await s._init; } catch { /* */ } }
    if (s.conn) {
      // ACP 只在 session/new 时吃 mcpServers，无法热更：mcp 选择变了就杀掉重建，否则复用。
      if (mcp === undefined || sameMcpNames(s.mcpNames, mcp)) return copilotSessions.get(key);
      try { s.conn.kill(); } catch { /* */ }
      copilotSessions.delete(key);
    }
  }
  const bin = resolveBin('copilot');
  if (!bin) { sender.send('localAgent:event', { cwd: key, ev: { type: 'error', error: '未找到 copilot —— 请 `npm i -g @github/copilot` 安装并 `copilot login`' } }); return null; }
  let realCwd = cwd; try { realCwd = fs.realpathSync(cwd); } catch { /* */ }
  const emit = makeBatchedEmit((ev) => { if (sender.isDestroyed()) return false; try { sender.send('localAgent:event', { cwd: key, ev }); return true; } catch { return false; } });
  const mcpNames = Array.isArray(mcp) ? mcp.slice() : (s && s.mcpNames) || [];
  const mcpServers = resolveMcpAcp(cwd, mcpNames);
  s = { conn: null, sessionId: sessionId || null, model: (model !== undefined ? model : null), permMode: permMode || 'default', turnCtx: geminiAcp.makeTurnState(), key, emit, _init: null, models: [], mcpNames, touched: Date.now() };
  copilotSessions.set(key, s);
  s._init = (async () => {
    const conn = new geminiAcp.AcpConn({
      bin, args: ['--acp'], cwd: realCwd, env: childEnv(),
      // 回放期(session/load)的 session/update 全部丢弃：历史已由 copilotReadSession 渲染过，
      // 否则会和已显示的历史重复成两遍。只渲染 load 完成后的「新」活动。
      onNotify: (m, p) => { if (m !== 'session/update') return; const cur = copilotSessions.get(key); if (!cur) return; cur.touched = Date.now(); if (cur.replaying) return; for (const ev of geminiAcp.normalizeUpdate(p, cur.turnCtx)) emit(ev); },
      onRequest: async (m, p) => {
        if (m === 'fs/read_text_file') { try { return { content: await fsp.readFile(p.path, 'utf8') }; } catch { return { content: '' }; } }
        if (m === 'fs/write_text_file') { try { await fsp.mkdir(path.dirname(p.path), { recursive: true }); await fsp.writeFile(p.path, p.content ?? ''); } catch { /* */ } return null; }
        if (m === 'session/request_permission') return geminiPermission(copilotSessions.get(key), p);
        return {};
      },
      onClose: () => { emit({ type: 'session_closed' }); clearPerms(key, '会话结束'); copilotSessions.delete(key); },
      onError: (e) => emit({ type: 'error', error: String(e && e.message || e) }),
    });
    s.conn = conn;
    await conn.request('initialize', { protocolVersion: geminiAcp.ACP_PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } });
    let ns;
    if (s.sessionId) {
      // session/load 会把整段历史当 session/update 回放 → 置 replaying 标志丢弃这些回放事件。
      s.replaying = true;
      try { ns = await conn.request('session/load', { cwd: realCwd, mcpServers, sessionId: s.sessionId }); }
      catch { ns = await conn.request('session/new', { cwd: realCwd, mcpServers }); s.sessionId = ns.sessionId; }
      finally { s.replaying = false; }
    } else {
      ns = await conn.request('session/new', { cwd: realCwd, mcpServers });
      s.sessionId = ns.sessionId;
    }
    s.models = mapCopilotModels(ns);
    if (s.models.length) { cacheModels('copilot', s.models); emit({ type: 'models', models: s.models }); }
    if (s.model && s.model !== 'auto') { try { await conn.request('session/set_model', { sessionId: s.sessionId, modelId: s.model }); } catch { /* 不支持就算了 */ } }
  })();
  try { await s._init; } catch (e) { emit({ type: 'error', error: 'copilot ACP 初始化失败（可能需 `copilot login`）：' + (e && e.message || e) }); try { s.conn && s.conn.kill(); } catch { /* */ } copilotSessions.delete(key); return null; }
  s._init = null;
  return copilotSessions.get(key);
}
async function copilotSend(sender, { cwd, lane, sessionId, prompt, permMode, model, mcp }) {
  const s = await copilotEnsure(sender, { cwd, lane, sessionId, permMode, model, mcp });
  if (!s) return { ok: false };
  s.turnCtx = geminiAcp.makeTurnState();
  s.touched = Date.now();
  const emit = s.emit;
  emit({ type: 'system', subtype: 'init', session_id: s.sessionId });
  try {
    const res = await s.conn.request('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: prompt }] });
    const ctx = s.turnCtx;
    if (!ctx.emittedFinal && ctx.accum) emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: ctx.accum }] } });
    const stop = (res && res.stopReason) || 'end_turn';
    emit({ type: 'result', subtype: stop === 'end_turn' ? 'success' : stop, session_id: s.sessionId });
  } catch (e) {
    emit({ type: 'error', error: String(e && e.message || e) });
    emit({ type: 'session_closed' });
  }
  return { ok: true };
}
function copilotWarm(sender, { cwd, lane, sessionId, permMode, model, mcp }) {
  void copilotEnsure(sender, { cwd, lane, sessionId, permMode, model, mcp });
  return { ok: true };
}

/* ---- Copilot 历史（copilot ≥1.0：~/.copilot/session-state/<id>/）：每个会话一个目录，
 *      workspace.yaml(cwd/name/git/时间) + events.jsonl(对话事件流) + session.db(仅 todos)。
 *      旧版单库 ~/.copilot/session-store.db 已废弃（新版不再生成）。按 cwd 精确匹配，
 *      含 VS Code/JetBrains 起的会话（workspace.yaml.client_name 区分）。 ---- */
const COPILOT_STATE_DIR = path.join(os.homedir(), '.copilot', 'session-state');
/** 从 workspace.yaml 抽单行字段（cwd/updated_at/...）。name 可能是多行块标量(|-)，调用方自己判。 */
function copilotYamlField(yaml, key) {
  const m = yaml.match(new RegExp('^' + key + ':[ \\t]*(.*)$', 'm'));
  return m ? m[1].trim() : null;
}
/** 流式扫 events.jsonl：数 user.message 条数(=turns) + 取首条用户消息作标题回退。 */
function copilotScanEvents(raw) {
  let turns = 0, firstUser = null;
  for (const line of raw.split('\n')) {
    if (!line || line[0] !== '{') continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.type === 'user.message') {
      turns++;
      if (!firstUser && j.data && j.data.content) firstUser = String(j.data.content).replace(/\s+/g, ' ').trim().slice(0, 80);
    }
  }
  return { turns, firstUser };
}
/** 扫一遍整个 session-state/ 目录，按 cwd 分组缓存（短 TTL）。切 provider 时各项目并发拉列表
 *  会对同一目录扫多次 → 用 3s 缓存把 N 次全量扫描收敛成 1 次。 */
let _copilotScanCache = null;   // { at, byCwd: Map<cwd, session[]> }
async function copilotScanAll() {
  if (_copilotScanCache && (Date.now() - _copilotScanCache.at) < 3000) return _copilotScanCache.byCwd;
  const byCwd = new Map();
  let dirs; try { dirs = await fsp.readdir(COPILOT_STATE_DIR); } catch { dirs = []; }
  await Promise.all(dirs.map(async (id) => {
    const base = path.join(COPILOT_STATE_DIR, id);
    let yaml; try { yaml = await fsp.readFile(path.join(base, 'workspace.yaml'), 'utf8'); } catch { return; }
    const wd = copilotYamlField(yaml, 'cwd'); if (!wd) return;
    let raw; try { raw = await fsp.readFile(path.join(base, 'events.jsonl'), 'utf8'); } catch { return; }
    const { turns, firstUser } = copilotScanEvents(raw);
    if (!turns) return;   // 没产生过对话 → 不进列表
    const name = copilotYamlField(yaml, 'name');           // 块标量(|-/>)开头的多行名跳过，用 firstUser
    const title = (name && !/^[|>]/.test(name) && name) || firstUser || null;
    const updatedAt = Date.parse(copilotYamlField(yaml, 'updated_at') || '') || 0;
    if (!byCwd.has(wd)) byCwd.set(wd, []);
    byCwd.get(wd).push({ sessionId: id, title, preview: title, turns, updatedAt });
  }));
  for (const arr of byCwd.values()) arr.sort((a, b) => b.updatedAt - a.updatedAt);
  _copilotScanCache = { at: Date.now(), byCwd };
  return byCwd;
}
async function copilotListSessions(cwd) {
  let real = cwd; try { real = fs.realpathSync(cwd); } catch { /* */ }
  const byCwd = await copilotScanAll();
  return (byCwd.get(real) || byCwd.get(cwd) || []).slice(0, 100);
}
async function copilotReadSession(cwd, sessionId) {
  const file = path.join(COPILOT_STATE_DIR, sessionId, 'events.jsonl');
  let raw; try { raw = await fsp.readFile(file, 'utf8'); } catch { return { messages: [] }; }
  const events = [];
  for (const line of raw.split('\n')) { if (!line || line[0] !== '{') continue; try { events.push(JSON.parse(line)); } catch { /* */ } }
  // 先收集工具结果(toolCallId → 文本)，渲染 assistant 时回填成 tool_result 卡片。
  const toolRes = new Map();
  for (const e of events) {
    if (e.type !== 'tool.execution_complete' || !e.data) continue;
    const r = e.data.result || {};
    const text = (typeof r === 'string') ? r : (r.detailedContent || r.content || r.output || r.error || '');
    toolRes.set(e.data.toolCallId, { text: String(text || ''), isError: e.data.success === false });
  }
  const messages = [];
  for (const e of events) {
    const ts = e.timestamp ? Date.parse(e.timestamp) || null : null;
    if (e.type === 'user.message') {
      const text = e.data && e.data.content ? String(e.data.content).trim() : '';
      if (text) messages.push({ role: 'user', parts: [{ kind: 'text', text }], ts, uuid: e.id || null });
    } else if (e.type === 'assistant.message') {
      const parts = [];
      if (e.data && e.data.content && String(e.data.content).trim()) parts.push({ kind: 'text', text: String(e.data.content) });
      for (const tr of (e.data && e.data.toolRequests) || []) {
        parts.push({ kind: 'tool_use', name: tr.name || 'tool', input: tr.arguments, id: tr.toolCallId });
        const res = toolRes.get(tr.toolCallId);
        if (res && res.text) parts.push({ kind: 'tool_result', text: res.text.slice(0, 8000), isError: res.isError, toolUseId: tr.toolCallId });
      }
      if (parts.length) messages.push({ role: 'assistant', parts, ts, uuid: (e.data && e.data.messageId) || e.id || null });
    }
  }
  return { messages };
}

/* ------------------------------------------------------------------ *
 * Gemini 历史落盘读取 —— ~/.gemini/tmp/<sha256(realpath(cwd))>/chats/session-*.json
 *   每个文件 = { sessionId, startTime, lastUpdated, messages:[{type:'user'|'gemini', content, toolCalls?}] }
 *   纯 JSON,直接读;无需调 CLI。续接用 --list-sessions 的序号(geminiResumeIndex)。
 * ------------------------------------------------------------------ */
function geminiChatsDir(cwd) {
  let real = cwd;
  try { real = fs.realpathSync(cwd); } catch { /* 路径不存在则用原值 */ }
  const hash = crypto.createHash('sha256').update(real).digest('hex');
  return path.join(os.homedir(), '.gemini', 'tmp', hash, 'chats');
}

/** gemini message[] → 渲染层 TranscriptMessage[]（text + 工具卡片，复用同一套渲染）。 */
function geminiMessagesToTranscript(messages) {
  const out = [];
  for (const m of (messages || [])) {
    const ts = m.timestamp ? Date.parse(m.timestamp) || null : null;
    if (m.type === 'user') {
      const text = (m.content || '').trim();
      if (text) out.push({ role: 'user', parts: [{ kind: 'text', text }], ts, uuid: m.id || null });
    } else if (m.type === 'gemini' || m.type === 'assistant') {
      const parts = [];
      if (m.content && String(m.content).trim()) parts.push({ kind: 'text', text: String(m.content) });
      for (const tc of (m.toolCalls || [])) {
        const { verb, input } = geminiDriver.mapTool(tc.name, tc.args);
        parts.push({ kind: 'tool_use', name: verb, input, id: tc.id });
        const resp = tc.result && tc.result[0] && tc.result[0].functionResponse && tc.result[0].functionResponse.response;
        const resText = tc.resultDisplay || (resp && (resp.output || resp.error)) || '';
        if (resText) parts.push({ kind: 'tool_result', text: String(resText), isError: !!(tc.status && tc.status !== 'success'), toolUseId: tc.id });
      }
      if (parts.length) out.push({ role: 'assistant', parts, ts, uuid: m.id || null });
    }
  }
  return out;
}

async function geminiReadSessionFile(full) {
  let raw; try { raw = await fsp.readFile(full, 'utf8'); } catch { return null; }
  let d; try { d = JSON.parse(raw); } catch { return null; }
  return d && Array.isArray(d.messages) ? d : null;
}

/** 列出某 cwd 下的 gemini 历史会话（标题取首条用户消息）。按 lastUpdated 倒序。 */
async function geminiListSessions(cwd) {
  const dir = geminiChatsDir(cwd);
  let files;
  try { files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = await Promise.all(files.map(async (f) => {
    const d = await geminiReadSessionFile(path.join(dir, f));
    if (!d || d.messages.length === 0) return null;
    const firstUser = d.messages.find((m) => m.type === 'user' && (m.content || '').trim());
    const title = firstUser ? String(firstUser.content).replace(/\s+/g, ' ').slice(0, 80) : null;
    const turns = d.messages.filter((m) => m.type === 'user').length;
    const updatedAt = Date.parse(d.lastUpdated || d.startTime || '') || 0;
    return { sessionId: d.sessionId, title, preview: title, turns, updatedAt };
  }));
  return out.filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
}

async function geminiReadSession(cwd, sessionId) {
  const dir = geminiChatsDir(cwd);
  let files;
  try { files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.json')); } catch { return { messages: [] }; }
  for (const f of files) {
    const d = await geminiReadSessionFile(path.join(dir, f));
    if (d && d.sessionId === sessionId) return { messages: geminiMessagesToTranscript(d.messages) };
  }
  return { messages: [] };
}

/** sessionId → --list-sessions 的 1-based 序号（按 lastUpdated 倒序，与 CLI 的「最近优先」一致）。 */
async function geminiResumeIndex(cwd, sessionId) {
  const list = await geminiListSessions(cwd);
  const i = list.findIndex((s) => s.sessionId === sessionId);
  return i < 0 ? 0 : i + 1;
}

async function geminiDeleteSession(cwd, sessionId) {
  const dir = geminiChatsDir(cwd);
  let files;
  try { files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.json')); } catch { return { ok: false, error: 'no sessions' }; }
  for (const f of files) {
    const d = await geminiReadSessionFile(path.join(dir, f));
    if (d && d.sessionId === sessionId) {
      const target = path.join(dir, f);
      try { const { shell } = require('electron'); await shell.trashItem(target); return { ok: true, trashed: true }; }
      catch { try { await fsp.unlink(target); return { ok: true, trashed: false }; } catch (e) { return { ok: false, error: String(e && e.message || e) }; } }
    }
  }
  return { ok: false, error: 'not found' };
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
 * 外部编辑器：把会话工作目录甩给本机 VSCode / Cursor 当工程打开。
 * 检测：先看 macOS app bundle，再退化到 PATH 里的 CLI（code / cursor）。
 * 打开：darwin 用 `open -a <App> <dir>`（不依赖 CLI 装没装），失败再退 CLI。
 * ------------------------------------------------------------------ */
function whichBin(bin) {
  return new Promise((resolve) => {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    try {
      execFile(finder, [bin], { env: childEnv(), timeout: 4000 }, (err, stdout) => resolve(!err && !!String(stdout || '').trim()));
    } catch { resolve(false); }
  });
}

const EDITOR_META = {
  vscode: { app: 'Visual Studio Code', bundle: 'Visual Studio Code.app', cli: 'code' },
  cursor: { app: 'Cursor', bundle: 'Cursor.app', cli: 'cursor' },
};

async function detectEditors() {
  const out = { vscode: false, cursor: false };
  for (const key of ['vscode', 'cursor']) {
    const meta = EDITOR_META[key];
    if (process.platform === 'darwin') {
      const candidates = [`/Applications/${meta.bundle}`, path.join(os.homedir(), 'Applications', meta.bundle)];
      if (candidates.some((p) => { try { return fs.existsSync(p); } catch { return false; } })) { out[key] = true; continue; }
    }
    out[key] = await whichBin(meta.cli);
  }
  return out;
}

async function openInEditor(editor, dir) {
  const meta = EDITOR_META[editor];
  if (!meta) return { ok: false, error: 'unknown editor' };
  if (!dir) return { ok: false, error: 'no dir' };
  try { const st = await fsp.stat(dir); if (!st.isDirectory()) return { ok: false, error: 'not a directory' }; }
  catch { return { ok: false, error: 'dir not found' }; }
  return new Promise((resolve) => {
    const tryCli = () => {
      const bin = process.platform === 'win32' ? `${meta.cli}.cmd` : meta.cli;
      try {
        execFile(bin, [dir], { env: childEnv(), shell: process.platform === 'win32', timeout: 8000 }, (err) =>
          resolve(err ? { ok: false, error: String(err && err.message || err) } : { ok: true }));
      } catch (e) { resolve({ ok: false, error: String(e && e.message || e) }); }
    };
    if (process.platform === 'darwin') {
      execFile('open', ['-a', meta.app, dir], { timeout: 8000 }, (err) => { if (!err) resolve({ ok: true }); else tryCli(); });
    } else {
      tryCli();
    }
  });
}

/* ------------------------------------------------------------------ *
 * Git 工作区改动：以「文件夹事实」为准，而非某个 session 的 transcript 自述。
 * 同一目录可并行跑多个 session（也可能用户手改 / git 操作），都反映在工作区 diff 里。
 * gitStatus = 列出相对 HEAD 的改动文件（含未跟踪）；gitDiffFile = 单文件 unified diff（懒取）。
 * ------------------------------------------------------------------ */
// GUI Electron 的 PATH 解析不可靠 → 解析 git 全路径再 exec（同 resolveBin 惯例）。
let _gitBin;
function gitBin() { if (_gitBin === undefined) _gitBin = resolveBin('git') || 'git'; return _gitBin; }
function runGit(cwd, args) {
  return new Promise((resolve) => {
    try {
      execFile(gitBin(), args, { cwd, env: childEnv(), maxBuffer: 64 * 1024 * 1024, timeout: 15000 },
        (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', enoent: !!(err && err.code === 'ENOENT') }));
    } catch (e) { resolve({ ok: false, stdout: '', stderr: String(e && e.message || e), enoent: true }); }
  });
}

async function gitStatus(dir) {
  if (!dir) return { ok: false, error: 'no dir' };
  const top = await runGit(dir, ['rev-parse', '--show-toplevel']);
  // git 没找到(ENOENT) ≠ 不是仓库：分开报，前端给不同提示。
  if (!top.ok) return { ok: true, repo: false, gitMissing: !!top.enoent, files: [] };
  const root = top.stdout.trim();
  // 行数统计（相对 HEAD，含暂存+未暂存的已跟踪改动）。空仓库无 HEAD → 失败则留空。
  const stat = new Map();
  const num = await runGit(root, ['-c', 'core.quotepath=false', 'diff', '--numstat', 'HEAD']);
  if (num.ok) {
    for (const line of num.stdout.split('\n')) {
      if (!line.trim()) continue;
      const tab = line.split('\t');
      if (tab.length < 3) continue;
      const a = tab[0], d = tab[1], p = tab.slice(2).join('\t');
      stat.set(p, { adds: a === '-' ? 0 : (parseInt(a, 10) || 0), dels: d === '-' ? 0 : (parseInt(d, 10) || 0), binary: a === '-' });
    }
  }
  const st = await runGit(root, ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '--untracked-files=all']);
  const files = [];
  if (st.ok) {
    for (const line of st.stdout.split('\n')) {
      if (line.length < 4) continue;
      const x = line[0], y = line[1];
      let p = line.slice(3);
      let renamedFrom;
      const arrow = p.indexOf(' -> ');
      if (arrow >= 0) { renamedFrom = p.slice(0, arrow); p = p.slice(arrow + 4); }
      const untracked = x === '?' && y === '?';
      const s = stat.get(p);
      files.push({ path: p, abs: path.join(root, p), x, y, untracked, adds: s ? s.adds : 0, dels: s ? s.dels : 0, binary: s ? s.binary : false, renamedFrom });
    }
  }
  return { ok: true, repo: true, root, files };
}

async function gitDiffFile(dir, file, untracked) {
  if (!dir || !file) return { ok: false, error: 'bad args' };
  const top = await runGit(dir, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return { ok: false, error: 'not a repo' };
  const root = top.stdout.trim();
  const readContent = async () => {
    try { return { ok: true, untracked: true, content: await fsp.readFile(path.join(root, file), 'utf8') }; }
    catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  };
  if (untracked) return readContent();
  // 相对 HEAD（暂存+未暂存合并）；退化到仅未暂存 / 仅暂存（空仓库或边界态）；再退化到读全文。
  for (const args of [['diff', 'HEAD', '--', file], ['diff', '--', file], ['diff', '--cached', '--', file]]) {
    const d = await runGit(root, ['-c', 'core.quotepath=false', ...args]);
    if (d.ok && d.stdout.trim()) return { ok: true, diff: d.stdout };
  }
  return readContent();
}

/** 撤销工作区单个文件的改动（worktree revert）：
 *  · 未跟踪/新增(HEAD 无此路径) → 工作区文件移到系统回收站(失败则删)，并从 index 移除；
 *  · 已跟踪(HEAD 有) → `git checkout HEAD -- file` 还原 index+worktree 到上次提交。
 *  破坏性操作，前端须二次确认。 */
async function gitRevertFile(dir, file, untracked) {
  if (!dir || !file) return { ok: false, error: 'bad args' };
  const top = await runGit(dir, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return { ok: false, error: 'not a repo' };
  const root = top.stdout.trim();
  const abs = path.join(root, file);
  const inHead = untracked ? { ok: false } : await runGit(root, ['cat-file', '-e', `HEAD:${file}`]);
  if (inHead.ok) {
    const r = await runGit(root, ['checkout', 'HEAD', '--', file]);
    return r.ok ? { ok: true } : { ok: false, error: (r.stderr || 'checkout failed').trim() };
  }
  // 不在 HEAD（未跟踪或 staged 新增）→ 从 index 移除（若有）+ 工作区文件移回收站。
  await runGit(root, ['rm', '--cached', '--force', '--', file]);
  try { const { shell } = require('electron'); await shell.trashItem(abs); }
  catch { try { await fsp.rm(abs, { force: true }); } catch (e) { return { ok: false, error: String(e && e.message || e) }; } }
  return { ok: true };
}

/** 一键还原整个工作区：已跟踪改动 `reset --hard HEAD` 退回上次提交；未跟踪文件逐个移回收站。
 *  破坏性，前端须二次确认。返回 { ok, trashed }（trashed=移回收站的未跟踪文件数）。 */
async function gitRevertAll(dir) {
  if (!dir) return { ok: false, error: 'no dir' };
  const top = await runGit(dir, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return { ok: false, error: 'not a repo' };
  const root = top.stdout.trim();
  // 1) 已跟踪：有 HEAD 则硬重置回上次提交；无 HEAD（空仓库）则仅 unstage，让其落到未跟踪后清理。
  const hasHead = await runGit(root, ['rev-parse', '--verify', 'HEAD']);
  if (hasHead.ok) await runGit(root, ['reset', '--hard', 'HEAD']);
  else await runGit(root, ['reset']);
  // 2) 未跟踪（含上一步 unstage 出来的新增）：逐个移系统回收站（失败则删）。
  let trashed = 0;
  const st = await runGit(root, ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '--untracked-files=all']);
  if (st.ok) {
    let shell; try { shell = require('electron').shell; } catch { /* */ }
    for (const line of st.stdout.split('\n')) {
      if (line.slice(0, 2) !== '??') continue;
      const p = line.slice(3);
      const abs = path.join(root, p);
      try { if (shell) await shell.trashItem(abs); else await fsp.rm(abs, { force: true, recursive: true }); trashed++; }
      catch { /* 跳过单个失败 */ }
    }
  }
  return { ok: true, trashed };
}

/* ------------------------------------------------------------------ *
 * Headless 执行器：无渲染窗格、无人值守地跑一条 prompt，监听到 result 即 resolve。
 * 给「自动化任务」用（automation.cjs）。复用 sessionSend 全套（假 sender 截事件）。
 *   target：sessionId=null → 新建会话；sessionId 给值 → resume 该会话（在独立 lane 起进程，
 *           其轮次追加进该会话历史，不与用户已开的 pane 抢同一 runKey）。
 *   permMode：自动化默认 bypassPermissions（无人点授权）；question_request 自动按默认继续。
 * 返回 { ok, output, error?, sessionId, subtype? }。onText 可选：增量文本回调。
 * ------------------------------------------------------------------ */
function runHeadless({ provider = 'claude', cwd, sessionId = null, prompt, permMode = 'bypassPermissions', model, mcp, lane, timeoutMs, onText, signal }) {
  const useLane = lane || `auto-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  return new Promise((resolve) => {
    let lastAssistant = '';
    let newSessionId = null;
    let settled = false;
    let timer = null;
    const finish = (r) => {
      if (settled) return; settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      try { sessionClose({ cwd, lane: useLane }); } catch { /* */ }
      resolve({ sessionId: newSessionId || sessionId || null, ...r });
    };
    const fakeSender = {
      isDestroyed: () => false,
      send: (_ch, payload) => {
        const ev = payload && payload.ev;
        if (!ev) return;
        switch (ev.type) {
          case 'assistant': {
            const c = ev.message && ev.message.content;
            let t = '';
            if (Array.isArray(c)) { for (const b of c) if (b && b.type === 'text' && b.text) t += b.text; }
            else if (typeof c === 'string') t = c;
            if (t) { lastAssistant = t; if (onText) { try { onText(t); } catch { /* */ } } }
            break;
          }
          case 'system':
            if (ev.subtype === 'init' && ev.session_id) newSessionId = ev.session_id;
            break;
          case 'permission_request':   // bypass 下不该来；保险起见放行
            try { permissionRespond(ev.permId, { behavior: 'allow', updatedInput: ev.input || {} }); } catch { /* */ }
            break;
          case 'question_request':     // 无人值守：按默认继续，不挂起
            try { permissionRespond(ev.permId, { behavior: 'deny', message: '自动化任务（无人值守）：请按默认/最稳妥方式继续，不要等待用户选择。' }); } catch { /* */ }
            break;
          case 'error':
            finish({ ok: false, error: String(ev.error || 'error'), output: lastAssistant });
            break;
          case 'result':
            finish({ ok: ev.subtype === 'success' || !ev.subtype, output: lastAssistant, subtype: ev.subtype || 'success' });
            break;
          case 'session_closed':
            finish({ ok: !!lastAssistant, output: lastAssistant });
            break;
          default: break;
        }
      },
    };
    timer = setTimeout(() => finish({ ok: false, error: 'timeout', output: lastAssistant }), timeoutMs || 30 * 60 * 1000);
    if (timer.unref) timer.unref();
    if (signal) signal.addEventListener('abort', () => { try { sessionInterrupt({ cwd, lane: useLane }); } catch { /* */ } finish({ ok: false, error: 'aborted', output: lastAssistant }); });
    Promise.resolve()
      .then(() => sessionSend(fakeSender, { provider, cwd, lane: useLane, sessionId, prompt, permMode, model, mcp }))
      .then((r) => { if (!r || r.ok === false) finish({ ok: false, error: 'start failed', output: '' }); })
      .catch((e) => finish({ ok: false, error: String(e && e.message || e), output: '' }));
  });
}

/* ------------------------------------------------------------------ *
 * IPC 注册
 * ------------------------------------------------------------------ */
let _reaperTimer = null;
/* ============================================================
 * CLI 登录 —— 给需要交互式 OAuth/设备码的 CLI 一个真 TTY（用系统 `script` 包 pty，
 *   零原生依赖、不碰打包）。输出流式推渲染层的「登录终端」，键入回传 stdin；用户完成
 *   浏览器授权后关终端 → 前端重探模型。claude 另有 `auth status` 可精确判断已登录。
 * ============================================================ */
const loginProcs = new Map();   // id -> node-pty IPty
const LOGIN_SPEC = {
  claude:  { bin: 'claude',  args: ['auth', 'login'] },   // 浏览器 OAuth
  copilot: { bin: 'copilot', args: ['login'] },           // 设备码流（需 TTY 按 Enter）
  gemini:  { bin: 'gemini',  args: [] },                   // 无 login 子命令 → 交互式首跑触发 OAuth
};

let _pty = null;   // 懒加载原生模块；未 rebuild/缺失则报错而非崩进程
function getPty() {
  if (_pty === null) { try { _pty = require('node-pty'); } catch (e) { _pty = e; } }
  if (_pty instanceof Error) throw _pty;
  return _pty;
}

/** 起一个登录 pty 会话（真 pty，CLI 当成在终端里跑）；输出/退出经 'localAgent:login' 按 id 路由回渲染层。 */
function loginStart(sender, { provider, cols, rows }) {
  const spec = LOGIN_SPEC[provider];
  if (!spec) return { ok: false, error: `${provider} 不支持登录` };
  const bin = resolveBin(spec.bin);
  if (!bin) return { ok: false, error: `未找到 ${spec.bin}` };
  let pty;
  try { pty = getPty(); } catch (e) { return { ok: false, error: 'pty 模块加载失败（需 electron-rebuild node-pty）：' + (e && e.message || e) }; }
  const id = `login-${Math.random().toString(36).slice(2, 10)}`;
  let p;
  try {
    p = pty.spawn(bin, spec.args, {
      name: 'xterm-256color',
      cols: Math.max(20, cols || 80), rows: Math.max(6, rows || 24),
      cwd: os.homedir(), env: { ...childEnv(), TERM: 'xterm-256color' },
    });
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  loginProcs.set(id, p);
  const emit = (ev) => { if (!sender.isDestroyed()) { try { sender.send('localAgent:login', { id, ...ev }); } catch { /* */ } } };
  p.onData((d) => emit({ type: 'data', data: String(d) }));
  p.onExit(({ exitCode }) => { loginProcs.delete(id); emit({ type: 'exit', code: exitCode }); });
  return { ok: true, id };
}
function loginInput({ id, data }) {
  const p = loginProcs.get(id);
  if (p) { try { p.write(data); return { ok: true }; } catch { /* */ } }
  return { ok: false };
}
function loginResize({ id, cols, rows }) {
  const p = loginProcs.get(id);
  if (p) { try { p.resize(Math.max(20, cols || 80), Math.max(6, rows || 24)); return { ok: true }; } catch { /* */ } }
  return { ok: false };
}
function loginKill({ id }) {
  const p = loginProcs.get(id);
  if (p) { try { p.kill(); } catch { /* */ } loginProcs.delete(id); }
  return { ok: true };
}
/** 登录状态：claude 用 `auth status`（JSON loggedIn）；其余无 status 命令的 provider 返回 null（前端不靠它）。 */
async function loginStatus({ provider }) {
  if (provider !== 'claude') return { loggedIn: null };   // copilot/gemini 无可靠 status，前端按需手动登录
  const bin = resolveBin('claude');
  if (!bin) return { loggedIn: false };
  return await new Promise((res) => {
    execFile(bin, ['auth', 'status'], { env: childEnv(), timeout: 8000 }, (err, stdout) => {
      if (err) return res({ loggedIn: false });
      try { const j = JSON.parse(stdout); res({ loggedIn: !!j.loggedIn, email: j.email || null }); }
      catch { res({ loggedIn: /["']?loggedIn["']?\s*:\s*true/i.test(stdout) }); }
    });
  });
}

function registerLocalAgent(ipcMain, dialog) {
  console.log('[localAgent] ready · multi-session lane routing (runKey=cwd#@#lane)');
  // 每 60s 扫一遍，收掉闲置 >15min 的常驻会话（防多会话/预热进程长期占内存）。
  if (!_reaperTimer) { _reaperTimer = setInterval(reapIdleSessions, 60_000); if (_reaperTimer.unref) _reaperTimer.unref(); }
  ipcMain.handle('localAgent:detect', (_e, only) => detect(only));
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
  ipcMain.handle('localAgent:listModels', (_e, { provider, apiKey } = {}) => listModels(provider, { apiKey }));
  ipcMain.handle('localAgent:listSessions', (_e, { provider, cwd }) => listSessions(provider, cwd));
  ipcMain.handle('localAgent:scanCodexSessions', () => codexListAllSessions());
  ipcMain.handle('localAgent:readSession', (_e, { provider, cwd, sessionId }) => readSession(provider, cwd, sessionId));
  ipcMain.handle('localAgent:deleteSession', (_e, { provider, cwd, sessionId }) => deleteSession(provider, cwd, sessionId));
  ipcMain.handle('localAgent:listCommands', (_e, { provider, cwd }) => listCommands(provider, cwd));
  ipcMain.handle('localAgent:scanCliSkills', () => scanCliSkills());
  ipcMain.handle('localAgent:send', (e, payload) => sessionSend(e.sender, payload));
  ipcMain.handle('localAgent:warm', (e, payload) => sessionWarm(e.sender, payload));
  ipcMain.handle('localAgent:permissionRespond', (_e, { permId, decision }) => permissionRespond(permId, decision));
  ipcMain.handle('localAgent:interrupt', (_e, { cwd, lane }) => sessionInterrupt({ cwd, lane }));
  ipcMain.handle('localAgent:sessionClose', (_e, { cwd, lane }) => sessionClose({ cwd, lane }));
  ipcMain.handle('localAgent:setPermMode', (_e, { cwd, permMode, lane }) => sessionSetPermMode({ cwd, permMode, lane }));
  ipcMain.handle('localAgent:setModel', (_e, { cwd, model, lane }) => sessionSetModel({ cwd, model, lane }));
  ipcMain.handle('localAgent:setReasoning', (_e, { cwd, reasoning, lane }) => sessionSetReasoning({ cwd, reasoning, lane }));
  ipcMain.handle('localAgent:listMcp', (_e, { cwd }) => listMcpConfigs(cwd));
  ipcMain.handle('localAgent:setMcp', (_e, { cwd, mcp, lane }) => sessionSetMcp({ cwd, mcp, lane }));
  ipcMain.handle('localAgent:mcpStatus', (_e, { cwd, lane }) => sessionMcpStatus({ cwd, lane }));
  ipcMain.handle('localAgent:reconnectMcp', (_e, { cwd, name, lane }) => sessionReconnectMcp({ cwd, name, lane }));
  ipcMain.handle('localAgent:detectEditors', () => detectEditors());
  ipcMain.handle('localAgent:openInEditor', (_e, { editor, dir }) => openInEditor(editor, dir));
  ipcMain.handle('localAgent:gitStatus', (_e, { dir }) => gitStatus(dir));
  ipcMain.handle('localAgent:gitDiffFile', (_e, { dir, file, untracked }) => gitDiffFile(dir, file, untracked));
  ipcMain.handle('localAgent:gitRevertFile', (_e, { dir, file, untracked }) => gitRevertFile(dir, file, untracked));
  ipcMain.handle('localAgent:gitRevertAll', (_e, { dir }) => gitRevertAll(dir));
  // CLI 登录 pty
  ipcMain.handle('localAgent:loginStart', (e, { provider, cols, rows }) => loginStart(e.sender, { provider, cols, rows }));
  ipcMain.handle('localAgent:loginInput', (_e, { id, data }) => loginInput({ id, data }));
  ipcMain.handle('localAgent:loginResize', (_e, { id, cols, rows }) => loginResize({ id, cols, rows }));
  ipcMain.handle('localAgent:loginKill', (_e, { id }) => loginKill({ id }));
  ipcMain.handle('localAgent:loginStatus', (_e, { provider }) => loginStatus({ provider }));
}

module.exports = {
  registerLocalAgent,
  runHeadless,       // automation.cjs：无人值守跑一条 prompt
  gitBin,            // automation.cjs：解析好的 git 全路径（GUI PATH 兜底）
  childEnv,          // automation.cjs：带补充 PATH 的环境
  killAllSessions,   // main.cjs 在渲染进程重载/崩溃/退出时调，回收孤儿 claude 子进程
  // 仅供本地冒烟测试，不在渲染进程使用。
  _internals: { detect, findProjectDir, listSessions, readSession, listCommands, deleteSession, codexListAllSessions, scanCliSkills },
};
