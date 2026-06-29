/**
 * Gemini CLI 驱动 —— 把 `gemini -o stream-json` 的事件流翻成渲染层吃的「SDK 形状」
 * 事件（与 Claude / Cursor 路径同构，渲染层零改动）。
 *
 * 与 Claude（常驻 query）不同，与 Cursor 同：gemini headless 是一次性进程，每个用户
 * 回合 spawn 一次 `gemini -o stream-json [--resume latest] <prompt>`，靠 --resume 续接。
 * gemini 用自身的本地登录态(`gemini` 首次交互登录)，不需要我们传 API key。
 *
 * 实测事件结构（2026-06, gemini-cli 0.17）：
 *   {type:init, session_id, model}
 *   {type:message, role:user, content}                 ← 回显，丢弃
 *   {type:message, role:assistant, content, delta:true} ← 流式文本块
 *   {type:tool_use, tool_name, tool_id, parameters}
 *   {type:tool_result, tool_id, status, output}
 *   {type:result, status, stats}
 *   (非 JSON 行如 "YOLO mode is enabled..." → 调用方跳过)
 */

/** 复用渲染层 PermMode：default / acceptEdits / bypassPermissions（与 claude 同名，省 i18n）。
 *  映射到 gemini --approval-mode：default / auto_edit / yolo。 */
function permArgs(permMode) {
  switch (permMode) {
    case 'bypassPermissions': case 'force': case 'yolo':
      return ['--approval-mode', 'yolo'];
    case 'acceptEdits': case 'auto_edit':
      return ['--approval-mode', 'auto_edit'];
    case 'default': case 'plan': case 'ask':
    default:
      return ['--approval-mode', 'default'];
  }
}

/** 拼一回合命令行。prompt 放最后(positional)，避免吃掉后续 flag。
 *  resume: true/'latest' → 续最近；数字(或数字串) → 按 --list-sessions 的序号续；falsy → 新会话。 */
function spawnArgs({ prompt, resume, model, permMode }) {
  const args = ['-o', 'stream-json'];
  args.push(...permArgs(permMode));
  if (model && model !== 'auto') args.push('-m', model);
  if (resume) args.push('--resume', resume === true ? 'latest' : String(resume));
  args.push(prompt);
  return args;
}

function makeTurnState() { return { sessionId: null, accum: '', emittedFinalText: false }; }

/* gemini 工具名 → 渲染层规范名 + 输入字段映射，复用现有 ToolCard / DiffView。
 * 未知工具：动词用原名，input 原样透传（describeTool 会兜底 firstStr）。 */
const TOOL_MAP = {
  run_shell_command: { verb: 'Bash', map: (p) => ({ command: p.command, description: p.description }) },
  read_file:         { verb: 'Read', map: (p) => ({ file_path: p.absolute_path || p.path || p.file_path }) },
  read_many_files:   { verb: 'Read', map: (p) => ({ file_path: Array.isArray(p.paths) ? p.paths.join(', ') : (p.paths || '') }) },
  write_file:        { verb: 'Write', map: (p) => ({ file_path: p.file_path || p.absolute_path, content: p.content }) },
  replace:           { verb: 'Edit', map: (p) => ({ file_path: p.file_path || p.absolute_path, old_string: p.old_string, new_string: p.new_string }) },
  edit:              { verb: 'Edit', map: (p) => ({ file_path: p.file_path || p.absolute_path, old_string: p.old_string, new_string: p.new_string }) },
  glob:              { verb: 'Glob', map: (p) => ({ pattern: p.pattern }) },
  list_directory:    { verb: 'Glob', map: (p) => ({ pattern: p.path || p.dir || '' }) },
  search_file_content:{ verb: 'Grep', map: (p) => ({ pattern: p.pattern }) },
  google_web_search: { verb: 'WebSearch', map: (p) => ({ query: p.query }) },
  web_fetch:         { verb: 'WebFetch', map: (p) => ({ url: p.url || p.prompt || '' }) },
  save_memory:       { verb: 'Memory', map: (p) => ({ fact: p.fact }) },
};
function mapTool(name, params) {
  const m = TOOL_MAP[name];
  if (m) return { verb: m.verb, input: m.map(params || {}) };
  return { verb: name || 'tool', input: params || {} };
}

/** 把一条 gemini stream-json 事件翻成 0..N 条渲染层事件。ctx = makeTurnState()。 */
function normalizeEvent(o, ctx) {
  const t = o && o.type;
  if (!t) return [];

  if (t === 'init') {
    ctx.sessionId = o.session_id || ctx.sessionId;
    return [{ type: 'system', subtype: 'init', session_id: o.session_id, model: o.model }];
  }

  if (t === 'message') {
    if (o.role === 'user') return [];   // 回显——渲染层已乐观显示
    if (o.role !== 'assistant') return [];
    const text = o.content || '';
    if (!text) return [];
    if (o.delta) {
      // 兼容「增量块」与「累计全文」两种实现：若新文本以已累计前缀开头，只取增量。
      let chunk = text;
      if (ctx.accum && text.startsWith(ctx.accum)) { chunk = text.slice(ctx.accum.length); ctx.accum = text; }
      else { ctx.accum += text; }
      return chunk ? [{ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: chunk } } }] : [];
    }
    // 非 delta 的整段 assistant → 定稿气泡
    ctx.emittedFinalText = true;
    return [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }];
  }

  if (t === 'tool_use') {
    const { verb, input } = mapTool(o.tool_name, o.parameters);
    return [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: o.tool_id, name: verb, input }] } }];
  }

  if (t === 'tool_result') {
    const out = typeof o.output === 'string'
      ? o.output
      : (() => { try { return JSON.stringify(o.output); } catch { return String(o.output); } })();
    return [{ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: o.tool_id, content: out, is_error: !!(o.status && o.status !== 'success') }] } }];
  }

  if (t === 'result') {
    const out = [];
    // 关键：gemini 不在结尾发整段 assistant，只发过 delta；livePreview 在 finalize 时会被丢弃，
    // 所以这里把累计文本补一条 assistant 气泡，落进 liveMsgs 才能持久(与 cursor 兜底同理)。
    if (!ctx.emittedFinalText && ctx.accum) {
      out.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: ctx.accum }] } });
    }
    out.push({ type: 'result', subtype: o.status === 'success' ? 'success' : (o.status || 'error'), session_id: ctx.sessionId });
    return out;
  }

  if (t === 'error') {
    return [{ type: 'error', error: o.message || o.error || 'gemini error' }];
  }

  return [];
}

module.exports = { spawnArgs, makeTurnState, normalizeEvent, mapTool };
