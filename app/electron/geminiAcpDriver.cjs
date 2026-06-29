/**
 * Gemini ACP 驱动 —— 通过 `gemini --experimental-acp` 的 Agent Client Protocol
 * (JSON-RPC over stdio, ndjson) 驱动一个**常驻** gemini agent，比 stream-json 每回合
 * spawn 更优：常驻进程、双向流式、协议自带逐工具权限请求、按 sessionId 精确续接。
 *
 * 角色：我们是 CLIENT，gemini 是 AGENT。用 gemini 自身登录态(oauth)，零鉴权代码。
 *
 * 协议(实测 gemini-cli 0.17, protocolVersion 1)：
 *   Client→Agent: initialize / session/new / session/load / session/prompt / session/cancel
 *   Agent→Client(通知): session/update { sessionId, update:{ sessionUpdate: ... } }
 *   Agent→Client(请求): session/request_permission / fs/read_text_file / fs/write_text_file
 *
 * 本模块只管「传输 + 事件归一」；会话管理/权限桥接在 localAgent.cjs。
 */
const { spawn } = require('node:child_process');

const ACP_PROTOCOL_VERSION = 1;

/* ---- ACP toolKind + rawInput → 渲染层规范工具(复用 ToolCard / DiffView) ---- */
function mapAcpTool(kind, rawInput, title) {
  const i = rawInput && typeof rawInput === 'object' ? rawInput : {};
  switch (kind) {
    case 'execute': return { verb: 'Bash', input: { command: i.command || title || '', description: i.description } };
    case 'edit': return { verb: 'Edit', input: { file_path: i.file_path || i.absolute_path || i.path, old_string: i.old_string, new_string: i.new_string, content: i.content } };
    case 'read': return { verb: 'Read', input: { file_path: i.absolute_path || i.path || i.file_path || title } };
    case 'search': return { verb: 'Grep', input: { pattern: i.pattern || i.query || title } };
    case 'fetch': return { verb: 'WebFetch', input: { url: i.url || i.prompt || title } };
    case 'delete': return { verb: 'Delete', input: { file_path: i.file_path || i.path || title } };
    case 'move': return { verb: 'Move', input: i };
    default: return { verb: title || kind || 'tool', input: i };
  }
}

/** ACP toolCallContent[] → 可读文本(用于 tool_result 显示)。diff 块跳过(已由 tool_use 的
 *  old/new 渲染);text 块拼接。 */
function acpContentText(content) {
  if (!Array.isArray(content)) return '';
  const out = [];
  for (const c of content) {
    if (!c) continue;
    if (c.type === 'content' && c.content && c.content.type === 'text') out.push(c.content.text || '');
    else if (c.type === 'diff' && c.path) out.push(`(diff ${c.path})`);
  }
  return out.join('\n');
}

/** 从 tool_call_update 的 diff 内容里补齐 edit 的 old/new（rawInput 没带时兜底）。 */
function diffFromContent(content) {
  if (!Array.isArray(content)) return null;
  const d = content.find((c) => c && c.type === 'diff');
  return d ? { file_path: d.path, old_string: d.oldText || '', new_string: d.newText || '' } : null;
}

function makeTurnState() { return { accum: '', emittedFinal: false, tools: new Map() }; }

/**
 * 把一条 session/update 翻成 0..N 条渲染层事件(SDK 形状)。ctx = makeTurnState()(每回合)。
 */
function normalizeUpdate(update, ctx) {
  const u = update && update.update;
  if (!u) return [];
  const tag = u.sessionUpdate;

  if (tag === 'user_message_chunk') return [];   // 回显
  if (tag === 'agent_thought_chunk') return [];  // 思考链：实时不展示(与 cursor 一致)

  if (tag === 'agent_message_chunk') {
    const text = (u.content && u.content.type === 'text') ? (u.content.text || '') : '';
    if (!text) return [];
    let chunk = text;
    if (ctx.accum && text.startsWith(ctx.accum)) { chunk = text.slice(ctx.accum.length); ctx.accum = text; }
    else { ctx.accum += text; }
    return chunk ? [{ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: chunk } } }] : [];
  }

  if (tag === 'tool_call') {
    const { verb, input } = mapAcpTool(u.kind, u.rawInput, u.title);
    ctx.tools.set(u.toolCallId, true);
    return [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: u.toolCallId, name: verb, input }] } }];
  }

  if (tag === 'tool_call_update') {
    const status = u.status;
    const events = [];
    // edit 类工具：diff 常在 update 里才给齐 → 补一条带 old/new 的 tool_use(同 id,渲染层覆盖输入)。
    const diff = diffFromContent(u.content);
    if (diff && (u.kind === 'edit' || !u.kind)) {
      events.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: u.toolCallId, name: 'Edit', input: diff }] } });
    }
    if (status === 'completed' || status === 'failed') {
      events.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: u.toolCallId, content: acpContentText(u.content), is_error: status === 'failed' }] } });
    }
    return events;
  }

  // plan / available_commands_update / 其它 → 忽略
  return [];
}

/* ---- JSON-RPC over stdio (ndjson) 连接 ---- */
class AcpConn {
  /** @param {{bin:string, args?:string[], cwd:string, env:object, onNotify:(m,p)=>void, onRequest:(m,p)=>Promise<any>, onClose:(code)=>void, onError:(e)=>void}} o
   *  args 默认 gemini 的 `--experimental-acp`；copilot 传 `['--acp']`。 */
  constructor(o) {
    this.o = o;
    this.id = 0;
    this.pending = new Map();   // id -> {resolve, reject}
    this.buf = '';
    this.child = spawn(o.bin, o.args || ['--experimental-acp'], { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.on('data', (d) => this._onData(d));
    this.child.stderr.on('data', () => {});   // ACP 的 stderr 是日志，忽略
    this.child.on('error', (e) => { try { o.onError && o.onError(e); } catch { /* */ } });
    this.child.on('close', (code) => { for (const p of this.pending.values()) p.reject(new Error('acp closed')); this.pending.clear(); try { o.onClose && o.onClose(code); } catch { /* */ } });
  }
  _write(obj) { try { this.child.stdin.write(JSON.stringify(obj) + '\n'); return true; } catch { return false; } }
  request(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (!this._write({ jsonrpc: '2.0', id, method, params })) { this.pending.delete(id); reject(new Error('write failed')); }
    });
  }
  notify(method, params) { this._write({ jsonrpc: '2.0', method, params }); }
  respond(id, result) { this._write({ jsonrpc: '2.0', id, result }); }
  respondError(id, message) { this._write({ jsonrpc: '2.0', id, error: { code: -32000, message: String(message) } }); }
  kill() { try { this.child.kill('SIGTERM'); } catch { /* */ } }
  async _onData(d) {
    this.buf += d.toString('utf8');
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl); this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.method) {
        // agent → client：通知(无 id) 或 请求(有 id，需回应)
        if (o.id != null) {
          try { const result = await this.o.onRequest(o.method, o.params); this.respond(o.id, result); }
          catch (e) { this.respondError(o.id, e && e.message || e); }
        } else {
          try { this.o.onNotify(o.method, o.params); } catch { /* */ }
        }
      } else if (o.id != null) {
        const p = this.pending.get(o.id);
        if (p) { this.pending.delete(o.id); o.error ? p.reject(new Error(o.error.message || 'rpc error')) : p.resolve(o.result); }
      }
    }
  }
}

module.exports = { ACP_PROTOCOL_VERSION, AcpConn, normalizeUpdate, makeTurnState, mapAcpTool, acpContentText };
