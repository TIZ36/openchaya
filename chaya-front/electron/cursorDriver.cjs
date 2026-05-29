/**
 * Cursor Agent 驱动 —— 把 `cursor-agent -p --output-format stream-json` 的事件流
 * 翻译成渲染层吃的「SDK 形状」事件（与 Claude 路径同构，渲染层零改动）。
 *
 * 与 Claude（Agent SDK 常驻 query）不同：cursor 是无状态一次性进程，每个用户回合
 * spawn 一次 `cursor-agent -p ... --resume <sessionId>`，靠 session_id 续上下文。
 * headless 模式必须 CURSOR_API_KEY（由渲染层从后端凭据拉到、随 payload 传入）。
 *
 * 实测事件结构（2026-05，cursor-agent 2026.01）：
 *   system/init        {session_id, model, permissionMode}
 *   user               回显用户输入（丢弃——渲染层已乐观显示）
 *   thinking/delta      {text}        ；thinking/completed
 *   assistant          {message.content:[{type:'text',text}]}
 *                       带 timestamp_ms = 流式增量；不带 = 本段定稿
 *   tool_call/started   {call_id, tool_call:{<name>ToolCall:{args}}}
 *   tool_call/completed 同上 + .result.success|.error
 *   result/success     {result(全文), session_id, usage}
 */

/** cursor 支持的权限档（对应渲染层 PERM 三档）。 */
const PERM_MODES = ['plan', 'ask', 'force'];

/** 权限档 → 命令行参数。plan/ask 只读但仍读文件，需 --trust 跳过 workspace 信任闸门；
 *  force = -f（自动放行 + 同时满足信任）。未知档位按 force 兜底（与现有 bypass 体感一致）。 */
function permArgs(permMode) {
  switch (permMode) {
    case 'plan': return ['--mode', 'plan', '--trust'];
    case 'ask': return ['--mode', 'ask', '--trust'];
    case 'force':
    default: return ['-f'];
  }
}

/** 拼一次回合的命令行。prompt 放最后（positional），避免吃掉后面的 flag。 */
function spawnArgs({ prompt, sessionId, model, permMode }) {
  const args = ['-p', '--output-format', 'stream-json', '--stream-partial-output'];
  args.push(...permArgs(permMode));
  if (model && model !== 'auto') args.push('--model', model);
  if (sessionId) args.push('--resume', sessionId);
  args.push(prompt);
  return args;
}

/** 每个回合一个解析上下文（记录 session_id、是否已发定稿文本）。 */
function makeTurnState() {
  return { sessionId: null, emittedFinalText: false };
}

/** 工具包装名 `readToolCall` → `read`。 */
function toolName(wrapper) {
  const key = wrapper && Object.keys(wrapper)[0];
  if (!key) return { name: 'tool', inner: {} };
  return { name: key.replace(/ToolCall$/, ''), inner: wrapper[key] || {} };
}

/** tool_call.completed 的 result → 可读字符串。 */
function toolResultText(inner) {
  const r = (inner && inner.result) || {};
  if (r.success) {
    const s = r.success;
    if (typeof s === 'string') return s;
    if (typeof s.content === 'string') return s.content;
    try { return JSON.stringify(s); } catch { return String(s); }
  }
  if (r.error) return typeof r.error === 'string' ? r.error : JSON.stringify(r.error);
  try { return JSON.stringify(r); } catch { return ''; }
}

/**
 * 把一条 cursor stream-json 事件翻成 0..N 条渲染层事件。
 * @param o    cursor 原始事件对象
 * @param ctx  makeTurnState() 的回合上下文（有状态）
 * @returns    渲染层事件数组（SDK 形状）
 */
function normalizeEvent(o, ctx) {
  const t = o && o.type;
  if (!t) return [];

  if (t === 'system' && o.subtype === 'init') {
    ctx.sessionId = o.session_id || ctx.sessionId;
    return [{ type: 'system', subtype: 'init', session_id: o.session_id, model: o.model, permissionMode: o.permissionMode }];
  }

  if (t === 'user') return []; // 回显——渲染层已乐观显示，丢弃避免重复

  // cursor 的 reasoning 在落盘里是 redacted（加密不可读），为与历史显示一致，实时也不展示 thinking。
  if (t === 'thinking') return [];

  if (t === 'assistant') {
    const content = (o.message && o.message.content) || [];
    const text = content.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('');
    const isDelta = o.timestamp_ms != null; // 增量块带 timestamp_ms；定稿块不带
    if (isDelta) {
      return text
        ? [{ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } }]
        : [];
    }
    const parts = [];
    for (const c of content) if (c && c.type === 'text' && c.text) parts.push({ type: 'text', text: c.text });
    if (parts.length === 0) return [];
    if (text) ctx.emittedFinalText = true;
    return [{ type: 'assistant', message: { role: 'assistant', content: parts } }];
  }

  if (t === 'tool_call') {
    const { name, inner } = toolName(o.tool_call);
    if (o.subtype === 'started') {
      return [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: o.call_id, name, input: inner.args || {} }] } }];
    }
    if (o.subtype === 'completed') {
      const r = inner.result || {};
      return [{ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: o.call_id, content: toolResultText(inner), is_error: !!r.error }] } }];
    }
    return [];
  }

  if (t === 'result') {
    const out = [];
    // 兜底：若整回合没发过定稿文本（只来过增量），用 result 全文补一条气泡，避免预览丢失。
    if (!ctx.emittedFinalText && o.result) {
      out.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: o.result }] } });
    }
    out.push({ type: 'result', subtype: o.subtype || 'success', session_id: o.session_id || ctx.sessionId });
    return out;
  }

  return [];
}

/** 解析 `cursor-agent models` 的纯文本输出 → 渲染层 ModelInfo。
 *  行形如 `gpt-5.2 - GPT-5.2` 或 `auto - Auto (current)`。 */
function parseModels(stdout) {
  const out = [];
  for (const raw of String(stdout || '').split('\n')) {
    const line = raw.trim();
    const m = /^(\S+)\s+-\s+(.+?)(\s+\(current\))?$/.exec(line);
    if (!m) continue;
    out.push({ value: m[1], displayName: m[2].trim() });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 历史落盘解析（store.db）—— 纯逻辑，不碰 IO（IO 在 localAgent.cjs 用 sqlite3 CLI）。
 *   根 blob = protobuf：field 1 = 有序子 blob 哈希（=消息顺序）。
 *   未公开格式 → 防御性只取「所有长度==32 的 field-1 值」，不依赖其他 field。
 *   消息 blob = JSON（Vercel AI SDK 形状）。
 * ------------------------------------------------------------------ */

/** 走 protobuf wire，提取根 blob 里有序的 32 字节子哈希（hex）。 */
function rootChildHashes(rootBuf) {
  const out = [];
  let i = 0;
  const b = rootBuf;
  while (i < b.length) {
    const tag = b[i]; i += 1;
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire === 2) {
      let len = 0, shift = 0;
      while (i < b.length) { const x = b[i]; i += 1; len |= (x & 0x7f) << shift; shift += 7; if (!(x & 0x80)) break; }
      const val = b.subarray(i, i + len); i += len;
      if (field === 1 && val.length === 32) out.push(val.toString('hex'));
    } else if (wire === 0) {
      while (i < b.length) { const x = b[i]; i += 1; if (!(x & 0x80)) break; }
    } else if (wire === 5) { i += 4; }
    else if (wire === 1) { i += 8; }
    else break;
  }
  return out;
}

/** 清洗 user 文本：cursor 把环境/上下文（<rules>/<agent_transcripts>/<user_info>…）
 *  和真实提问塞进同一条 user 消息，真实提问总在 <user_query>…</user_query> 里。
 *  - 有 user_query → 只取它（真实提问）。
 *  - 无 user_query 但含任何注入标签 → 系统前导，返回 ''（调用方跳过该消息、不计回合）。
 *  - 纯文本（无标签）→ 原样返回（防御：非 cursor 包裹的内容）。 */
function cleanUserText(s) {
  if (typeof s !== 'string') return '';
  const q = [...s.matchAll(/<user_query>([\s\S]*?)<\/user_query>/gi)].map((m) => m[1].trim()).filter(Boolean);
  if (q.length) return q.join('\n\n').trim();
  if (/<[a-z][a-z0-9_]*>/i.test(s)) return ''; // 含注入标签且无 user_query → 系统前导
  return s.trim();
}

/** 落盘消息 JSON → 渲染层 TranscriptMessage（parts 用 MsgPart 形状）。返回 null = 跳过。 */
function mapStoredMessage(o) {
  if (!o || !o.role) return null;
  const role = o.role; // system / user / assistant / tool
  if (role === 'system') return null; // 与 claude 一致：不展示 system

  const c = o.content;
  const parts = [];

  if (typeof c === 'string') {
    const text = role === 'user' ? cleanUserText(c) : c;
    if (text) parts.push({ kind: 'text', text });
  } else if (Array.isArray(c)) {
    for (const p of c) {
      if (!p || typeof p !== 'object') continue;
      switch (p.type) {
        case 'text': {
          const text = role === 'user' ? cleanUserText(p.text || '') : (p.text || '');
          if (text) parts.push({ kind: 'text', text });
          break;
        }
        case 'reasoning': // 偶有可读 reasoning（非 redacted）
          if (p.text) parts.push({ kind: 'thinking', text: p.text });
          break;
        case 'redacted-reasoning':
          break; // 加密不可读 → 跳过
        case 'tool-call':
          parts.push({ kind: 'tool_use', name: p.toolName || 'tool', input: p.args, id: p.toolCallId });
          break;
        case 'tool-result': {
          const txt = typeof p.result === 'string'
            ? p.result
            : Array.isArray(p.experimental_content)
              ? p.experimental_content.map((x) => (x && x.text) || '').join('\n')
              : (() => { try { return JSON.stringify(p.result); } catch { return ''; } })();
          const isErr = !!(p.providerOptions && p.providerOptions.cursor && p.providerOptions.cursor.highLevelToolCallResult && p.providerOptions.cursor.highLevelToolCallResult.isError);
          parts.push({ kind: 'tool_result', text: String(txt || '').slice(0, 8000), isError: isErr, toolUseId: p.toolCallId });
          break;
        }
        default:
          break;
      }
    }
  }

  if (parts.length === 0) return null;
  // tool 角色 → 归为 'user'（与 claude 一致：tool_result 收在 user 消息里渲染）。
  return { role: role === 'assistant' ? 'assistant' : 'user', parts, ts: null, uuid: o.id || null };
}

module.exports = {
  PERM_MODES, permArgs, spawnArgs, makeTurnState, normalizeEvent, parseModels, toolName, toolResultText,
  rootChildHashes, cleanUserText, mapStoredMessage,
};
