/* evolve —— 本地自进化引擎（借鉴 ~/aiproj/eva 的 reflect + consolidate，单机简化版）。
 *
 * 只服务「升格为 agent」的会话：每回合结束后台异步反思 → 蒸馏偏好(block)/笔记(note)/
 * 可复用 SOP(induced skill) + 负反馈闭环(否决/修订草稿) → 落本地 SQLite（与 configDb 同库）。
 * **不做 skill 物化**：把 block + 已认可(trusted/promoted)技能写成单个「被引用的记忆文件」
 * <cwd>/.chaya/AGENT_MEMORY.md，agent 自行阅读（systemPrompt 里加一行指引）。
 *
 * 反思的 LLM 调用复用 localAgent.runHeadless（provider 无关的一次性补全，fresh session，
 * 不续接主对话、bypass 权限、自动拒绝交互），与主对话同一套 CLI/鉴权。best-effort：
 * 反思失败绝不影响主回合（renderer 后台 fire-and-forget）。
 *
 * 成熟阶梯：draft ──人工 approve──▶ trusted ──uses≥promote_at──▶ promoted
 *           draft ──revise──▶ draft（救回）; draft ──veto──▶ rejected（不进记忆文件、不删、留痕）
 */
const fs = require('fs');
const path = require('path');
const { getDb } = require('./configDb.cjs');
const { runHeadless } = require('./localAgent.cjs');

const PROMOTE_AT = 3;          // trusted + uses≥3 → promoted
const REFLECT_TIMEOUT = 90_000;
// 优化 A：蒸馏是轻活，固定走各 provider 的「快模型」，省时省钱（质量对结构化抽取足够）。
// 只对能稳妥指定快模型的 provider 覆盖；其余沿用会话模型。
const FAST_MODEL = { claude: 'haiku' };

let _app = null;
function db() { return getDb(_app); }

function ensureSchema() {
  db().exec(`
    CREATE TABLE IF NOT EXISTS agent_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      kind TEXT NOT NULL,                 -- 'block' | 'note'
      label TEXT,                          -- block 的唯一键（同 agent 同 label 覆盖）；note 为 NULL
      value TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      uses INTEGER NOT NULL DEFAULT 0,
      consolidated INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_memory_aid ON agent_memory(agent_id, kind);
    CREATE TABLE IF NOT EXISTS agent_skill (
      agent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      keywords TEXT NOT NULL DEFAULT '[]',
      maturity TEXT NOT NULL DEFAULT 'draft',  -- draft|trusted|promoted|rejected|archived
      uses INTEGER NOT NULL DEFAULT 0,
      reject_reason TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'induced',
      last_used_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (agent_id, name)
    );
  `);
}

// ── 写入原语 ────────────────────────────────────────────────────────────────
function setBlock(agentId, label, value, description = '') {
  const now = Date.now();
  const row = db().prepare(`SELECT id FROM agent_memory WHERE agent_id=? AND kind='block' AND label=?`).get(agentId, label);
  if (row) {
    db().prepare(`UPDATE agent_memory SET value=?, description=?, updated_at=? WHERE id=?`).run(value, description, now, row.id);
  } else {
    db().prepare(`INSERT INTO agent_memory(agent_id,kind,label,value,description,tags,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`)
      .run(agentId, 'block', label, value, description, '[]', now, now);
  }
}

function addNote(agentId, content, tags = []) {
  const now = Date.now();
  db().prepare(`INSERT INTO agent_memory(agent_id,kind,label,value,tags,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`)
    .run(agentId, 'note', null, content, JSON.stringify(tags || []), now, now);
}

function getSkill(agentId, name) {
  return db().prepare(`SELECT * FROM agent_skill WHERE agent_id=? AND name=?`).get(agentId, name);
}

function induceSkill(agentId, { name, description = '', body = '', keywords = [] }) {
  if (!name || !body) return;
  const now = Date.now();
  const ex = getSkill(agentId, name);
  if (!ex) {
    db().prepare(`INSERT INTO agent_skill(agent_id,name,description,body,keywords,maturity,uses,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(agentId, name, description, body, JSON.stringify(keywords || []), 'draft', 1, 'induced', now, now);
    return 'induced';
  }
  if (ex.maturity === 'rejected') return null;             // 被否决的不复活（要 revise 救）
  if (ex.maturity === 'draft') {                            // 仍是草稿 → 更新正文 + 复用计数
    db().prepare(`UPDATE agent_skill SET description=?, body=?, keywords=?, uses=uses+1, updated_at=? WHERE agent_id=? AND name=?`)
      .run(description || ex.description, body, JSON.stringify(keywords || []), now, agentId, name);
  } else {                                                  // 已认可 → 只记复用信号
    db().prepare(`UPDATE agent_skill SET uses=uses+1, last_used_at=?, updated_at=? WHERE agent_id=? AND name=?`)
      .run(now, now, agentId, name);
  }
  return 'induced';
}

function reviseSkill(agentId, name, { description, body, keywords } = {}) {
  const ex = getSkill(agentId, name);
  if (!ex) return false;
  const now = Date.now();
  db().prepare(`UPDATE agent_skill SET description=?, body=?, keywords=?, maturity='draft', reject_reason='', updated_at=? WHERE agent_id=? AND name=?`)
    .run(description || ex.description, body || ex.body, JSON.stringify(keywords || JSON.parse(ex.keywords || '[]')), now, agentId, name);
  return true;
}

function vetoSkill(agentId, name, reason = '') {
  const ex = getSkill(agentId, name);
  if (!ex) return false;
  db().prepare(`UPDATE agent_skill SET maturity='rejected', reject_reason=?, updated_at=? WHERE agent_id=? AND name=?`)
    .run(reason, Date.now(), agentId, name);
  return true;
}

function approveSkill(agentId, name) {
  const ex = getSkill(agentId, name);
  if (!ex || ex.maturity !== 'draft') return false;        // 仅 draft 可认可
  db().prepare(`UPDATE agent_skill SET maturity='trusted', updated_at=? WHERE agent_id=? AND name=?`).run(Date.now(), agentId, name);
  return true;
}

function deleteSkill(agentId, name) {
  db().prepare(`DELETE FROM agent_skill WHERE agent_id=? AND name=?`).run(agentId, name);
  return true;
}

function recordHit(agentId, name) {
  const now = Date.now();
  db().prepare(`UPDATE agent_skill SET uses=uses+1, last_used_at=?, updated_at=? WHERE agent_id=? AND name=?`).run(now, now, agentId, name);
}

/** 成熟阶梯：trusted 且 uses≥promote_at → promoted（仍个人私有，单机无共享维度）。 */
function consolidate(agentId, promoteAt = PROMOTE_AT) {
  const rows = db().prepare(`SELECT name, uses FROM agent_skill WHERE agent_id=? AND maturity='trusted'`).all(agentId);
  const promoted = [];
  for (const r of rows) {
    if ((r.uses || 0) >= promoteAt) {
      db().prepare(`UPDATE agent_skill SET maturity='promoted', updated_at=? WHERE agent_id=? AND name=?`).run(Date.now(), agentId, r.name);
      promoted.push(r.name);
    }
  }
  return promoted;
}

// ── 读取 ─────────────────────────────────────────────────────────────────────
function listSkills(agentId) {
  return db().prepare(`SELECT name,description,body,keywords,maturity,uses,reject_reason,source,updated_at FROM agent_skill WHERE agent_id=? ORDER BY updated_at DESC`).all(agentId)
    .map((r) => ({ ...r, keywords: JSON.parse(r.keywords || '[]') }));
}
function listMemory(agentId) {
  const blocks = db().prepare(`SELECT id,label,value,description,updated_at FROM agent_memory WHERE agent_id=? AND kind='block' ORDER BY updated_at DESC`).all(agentId);
  const notes = db().prepare(`SELECT id,value,tags,consolidated,updated_at FROM agent_memory WHERE agent_id=? AND kind='note' ORDER BY updated_at DESC LIMIT 100`).all(agentId)
    .map((r) => ({ ...r, tags: JSON.parse(r.tags || '[]') }));
  return { blocks, notes };
}

// ── 被引用的记忆文件 ───────────────────────────────────────────────────────────
function memoryMarkdown(agentId) {
  const { blocks } = listMemory(agentId);
  const skills = db().prepare(`SELECT name,description,body,keywords FROM agent_skill WHERE agent_id=? AND maturity IN ('trusted','promoted') ORDER BY uses DESC`).all(agentId);
  const parts = ['# Agent 长期记忆（自动维护，请勿手改）', ''];
  if (blocks.length) {
    parts.push('## 用户偏好 / 长期事实');
    for (const b of blocks) parts.push(`- **${b.label}**：${b.value}`);
    parts.push('');
  }
  if (skills.length) {
    parts.push('## 已掌握的方法 / SOP');
    for (const s of skills) {
      parts.push(`### ${s.name}${s.description ? ` — ${s.description}` : ''}`);
      const kw = JSON.parse(s.keywords || '[]');
      if (kw.length) parts.push(`_触发场景_：${kw.join('、')}`);
      parts.push((s.body || '').trim());
      parts.push('');
    }
  }
  if (!blocks.length && !skills.length) parts.push('_（暂无沉淀）_');
  return parts.join('\n') + '\n';
}

function memoryFilePath(cwd) { return path.join(cwd, '.chaya', 'AGENT_MEMORY.md'); }

function writeMemoryFile(agentId, cwd) {
  if (!cwd) return null;
  try {
    const fp = memoryFilePath(cwd);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, memoryMarkdown(agentId), 'utf8');
    return fp;
  } catch (e) { console.error('[evolve] writeMemoryFile failed:', e); return null; }
}

// ── 反思 ─────────────────────────────────────────────────────────────────────
const REFLECT_SYSTEM =
  '你是记忆/技能蒸馏器。看一回合对话，主动判断该不该沉淀（不必等用户开口）。记忆从严（宁缺毋滥），' +
  '技能从宽（出现可复用多步方法/SOP 就固化成草稿）。还要做负反馈闭环：用户纠正/否定上一轮产出时，' +
  '对相关现存草稿做修订或否决。只输出一个 JSON 对象，不要任何解释文字，不要使用任何工具。';

function buildReflectPrompt({ task, response, blocks, drafts, skills }) {
  const blockLines = blocks.length ? blocks.map((b) => `- ${b.label}：${b.value}`).join('\n') : '（无）';
  const draftLines = drafts.length ? drafts.map((d) => `- ${d.name}：${d.description || ''}`).join('\n') : '（无）';
  const skillLines = skills.length ? skills.map((s) => `- ${s.name}：${s.description || ''}`).join('\n') : '（无）';
  return `看这一回合对话，判断该沉淀什么，只输出 JSON：
{
  "blocks": [{"label":"英文短名","value":"一句话偏好/事实","description":""}],
  "notes": [{"content":"值得归档的一次性结论","tags":[]}],
  "skill": {"name":"英文短横名","description":"一行","body":"可复用步骤(不写本次具体数值)","keywords":[]} 或 null,
  "skill_revisions": [{"name":"命中下方现存草稿名","description":"","body":"改对后的步骤","keywords":[]}],
  "skill_vetoes": [{"name":"命中现存草稿名","reason":"中文一句否决理由"}],
  "used_skills": ["本轮真正参与作答的现存技能名"],
  "summary": "一句中文：这次记/学/修订/否决了什么"
}
规则：
- blocks：持久偏好/身份事实，从严。若与【现存记忆块】同维度，必须复用其 label（覆盖即更新）。没有就空数组。
- notes：值得归档的一次性事件/结论，从严。没有就空数组。
- skill：本轮出现可复用多步 SOP 且可能再用就归纳（即便用户没说保存）。纯闲聊/简单问答给 null。
- skill_revisions / skill_vetoes：仅当用户纠正/否定上一轮草稿时用；name 必须命中【现存草稿】；能改对用 revisions，改不动用 vetoes，二选一。
- used_skills：只能填【现存技能】里、其 SOP 真正参与了本轮作答的名字；没有就空数组。

【现存记忆块】\n${blockLines}
【现存草稿】\n${draftLines}
【现存技能】\n${skillLines}

【用户】${String(task).slice(0, 4000)}

【助手】${String(response).slice(0, 4000)}`;
}

function extractJson(text) {
  if (!text) return null;
  // 优先 ```json ... ``` 代码块
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [];
  if (fence) candidates.push(fence[1]);
  // 退回：第一个 { 到最后一个 } 的平衡片段
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try { return JSON.parse(c); } catch { /* next */ }
  }
  return null;
}

function applyObservation(agentId, obs, draftNames, skillNames) {
  const ev = { blocks: [], notes: [], skills: [], summary: (obs.summary || '').trim() };
  for (const b of (obs.blocks || [])) {
    if (b && b.label && b.value) { try { setBlock(agentId, String(b.label), String(b.value), String(b.description || '')); ev.blocks.push({ label: b.label, value: b.value }); } catch { /* */ } }
  }
  for (const n of (obs.notes || [])) {
    if (n && n.content) { try { addNote(agentId, String(n.content), Array.isArray(n.tags) ? n.tags : []); ev.notes.push({ content: n.content }); } catch { /* */ } }
  }
  if (obs.skill && obs.skill.name && obs.skill.body) {
    try { const a = induceSkill(agentId, obs.skill); if (a) ev.skills.push({ name: obs.skill.name, action: 'induced' }); } catch { /* */ }
  }
  for (const r of (obs.skill_revisions || [])) {
    if (r && r.name && draftNames.has(r.name)) { try { if (reviseSkill(agentId, r.name, r)) ev.skills.push({ name: r.name, action: 'revised' }); } catch { /* */ } }
  }
  for (const v of (obs.skill_vetoes || [])) {
    if (v && v.name && draftNames.has(v.name)) { try { if (vetoSkill(agentId, v.name, v.reason || '')) ev.skills.push({ name: v.name, action: 'vetoed' }); } catch { /* */ } }
  }
  for (const nm of (obs.used_skills || [])) {
    if (nm && skillNames.has(nm)) { try { recordHit(agentId, nm); } catch { /* */ } }
  }
  if (!ev.summary) ev.summary = autoSummary(ev);
  return ev;
}

function autoSummary(ev) {
  const parts = [];
  if (ev.blocks.length) parts.push(`记住 ${ev.blocks.length} 条偏好`);
  if (ev.notes.length) parts.push(`存 ${ev.notes.length} 条笔记`);
  const ind = ev.skills.filter((s) => s.action === 'induced').length;
  const rev = ev.skills.filter((s) => s.action === 'revised').length;
  const vet = ev.skills.filter((s) => s.action === 'vetoed').length;
  if (ind) parts.push(`学会 ${ind} 个 skill`);
  if (rev) parts.push(`修订 ${rev} 个 skill`);
  if (vet) parts.push(`否决 ${vet} 个 skill`);
  return parts.length ? parts.join('、') : '无变更';
}

/** 跑一次 post-turn 反思（best-effort）。返回 {ok, event?} 。 */
async function reflect({ agentId, provider, cwd, model, mcp, task, response, promoteAt = PROMOTE_AT }) {
  if (!agentId || !task || !response) return { ok: false, error: 'missing args' };
  ensureSchema();
  const blocks = db().prepare(`SELECT label,value FROM agent_memory WHERE agent_id=? AND kind='block'`).all(agentId);
  const drafts = db().prepare(`SELECT name,description FROM agent_skill WHERE agent_id=? AND maturity='draft'`).all(agentId);
  const skills = db().prepare(`SELECT name,description FROM agent_skill WHERE agent_id=? AND maturity IN ('draft','trusted','promoted')`).all(agentId);
  const draftNames = new Set(drafts.map((d) => d.name));
  const skillNames = new Set(skills.map((s) => s.name));

  const prompt = REFLECT_SYSTEM + '\n\n' + buildReflectPrompt({ task, response, blocks, drafts, skills });
  const prov = provider || 'claude';
  const reflectModel = FAST_MODEL[prov] || model;   // 优化 A：能指定快模型就用快的
  let res;
  try {
    res = await runHeadless({
      provider: prov, cwd: cwd || require('os').homedir(), model: reflectModel, mcp,
      sessionId: null, prompt, permMode: 'bypassPermissions', timeoutMs: REFLECT_TIMEOUT,
    });
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  if (!res || res.ok === false) return { ok: false, error: (res && res.error) || 'reflect run failed' };

  const obs = extractJson(res.output || '');
  if (!obs) return { ok: false, error: 'no json in reflection output' };
  const ev = applyObservation(agentId, obs, draftNames, skillNames);
  consolidate(agentId, promoteAt);                 // 顺带跑一次成熟阶梯
  if (cwd) writeMemoryFile(agentId, cwd);          // 刷新被引用的记忆文件
  return { ok: true, event: ev };
}

// ── IPC ───────────────────────────────────────────────────────────────────────
function registerEvolve(ipcMain, app) {
  _app = app;
  try { ensureSchema(); } catch (e) { console.error('[evolve] ensureSchema failed:', e); }

  ipcMain.handle('evolve:reflect', async (_e, args) => {
    try { return await reflect(args || {}); }
    catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  });
  ipcMain.handle('evolve:listSkills', (_e, { agentId }) => { try { return listSkills(agentId); } catch { return []; } });
  ipcMain.handle('evolve:listMemory', (_e, { agentId }) => { try { return listMemory(agentId); } catch { return { blocks: [], notes: [] }; } });
  ipcMain.handle('evolve:approveSkill', (_e, { agentId, name }) => { try { return approveSkill(agentId, name); } catch { return false; } });
  ipcMain.handle('evolve:vetoSkill', (_e, { agentId, name, reason }) => { try { return vetoSkill(agentId, name, reason); } catch { return false; } });
  ipcMain.handle('evolve:reviseSkill', (_e, { agentId, name, patch }) => { try { return reviseSkill(agentId, name, patch || {}); } catch { return false; } });
  ipcMain.handle('evolve:deleteSkill', (_e, { agentId, name }) => { try { return deleteSkill(agentId, name); } catch { return false; } });
  ipcMain.handle('evolve:consolidate', (_e, { agentId, promoteAt }) => { try { return consolidate(agentId, promoteAt || PROMOTE_AT); } catch { return []; } });
  ipcMain.handle('evolve:writeMemoryFile', (_e, { agentId, cwd }) => { try { return writeMemoryFile(agentId, cwd); } catch { return null; } });
  ipcMain.handle('evolve:memoryMarkdown', (_e, { agentId }) => { try { return memoryMarkdown(agentId); } catch { return ''; } });
}

module.exports = {
  registerEvolve,
  // 供测试 / 其它主进程模块复用：
  reflect, consolidate, listSkills, listMemory, writeMemoryFile, memoryMarkdown,
  approveSkill, vetoSkill, reviseSkill, deleteSkill,
};
