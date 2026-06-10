/* ------------------------------------------------------------------ *
 * Chaya Skill —— provider 无关的「技能」(可复用的 prompt 模板)。纯本地存 localStorage。
 *
 * 关键点：CLI 原生的斜杠命令(只有 claude 有)各家不互通；Chaya 作为中枢，在 composer 端拦截
 * `/技能名 参数` → 发送前展开成普通 prompt 文本 → 对 claude/codex/cursor/gemini/copilot
 * 一律生效，不依赖 CLI 原生 skill 机制。这样「能力」在 5 个 provider 间共通。
 *
 * 模板占位：{{input}} = 命令后的全部参数（无占位时参数自动追加到末尾）。
 * ------------------------------------------------------------------ */

export interface LocalSkill {
  id: string;
  name: string;          // 触发名，不含斜杠，如 "refactor"（/refactor 触发）
  description: string;   // 斜杠菜单里显示
  body: string;          // prompt 模板，支持 {{input}}
  builtinSeed?: boolean; // 内置示例（可编辑/删除），仅用于首次播种标记
  source?: 'cli';        // CLI 自动导入（claude skill / codex prompt / …）
  origin?: string;       // 导入来源 provider：claude/codex/cursor/gemini
  sourcePath?: string;   // 来源文件路径（同步键；文件删了导入项也跟着删）
  createdAt: number;
  updatedAt: number;
}

const SKILLS_KEY = 'chaya.localAgent.skills';
const SEEDED_KEY = 'chaya.localAgent.skillsSeeded';
const CLI_IGNORE_KEY = 'chaya.localAgent.skillsCliIgnore';
export const SKILLS_CHANGED_EVENT = 'chaya:localAgentSkillsChanged';

/** 归一技能名：去斜杠/空白，小写，非法字符换连字符。 */
export function normalizeSkillName(raw: string): string {
  return String(raw || '').trim().replace(/^\/+/, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

/** 首次进入播种几个示例技能，让功能可发现（用户可改可删）。 */
function seedSkills(): LocalSkill[] {
  const now = Date.now();
  const mk = (name: string, description: string, body: string, i: number): LocalSkill =>
    ({ id: `sk-seed-${i}`, name, description, body, builtinSeed: true, createdAt: now, updatedAt: now });
  return [
    mk('explain', '解释选中/给定的代码或概念', '请清晰地解释下面的内容，分点说明关键设计与取舍：\n\n{{input}}', 1),
    mk('refactor', '重构：在不改变行为的前提下改进可读性/结构', '请重构以下代码：保持外部行为不变，提升可读性与结构，并简述每处改动的理由。\n\n{{input}}', 2),
    mk('review', '只读评审：找 bug 与可简化处', '请只读评审以下改动/代码，按 正确性/安全/性能/可维护性 分类列出问题，标注严重度，不要改文件。\n\n{{input}}', 3),
  ];
}

export function loadSkills(): LocalSkill[] {
  try {
    const raw = localStorage.getItem(SKILLS_KEY);
    if (raw) { const arr = JSON.parse(raw); if (Array.isArray(arr)) return arr; }
  } catch { /* ignore */ }
  // 首次：播种示例（只播一次，之后即便清空也不再自动塞回）
  try {
    if (!localStorage.getItem(SEEDED_KEY)) {
      const seeded = seedSkills();
      localStorage.setItem(SKILLS_KEY, JSON.stringify(seeded));
      localStorage.setItem(SEEDED_KEY, '1');
      return seeded;
    }
  } catch { /* ignore */ }
  return [];
}

function persist(list: LocalSkill[]): void {
  try { localStorage.setItem(SKILLS_KEY, JSON.stringify(list)); } catch { /* quota */ }
  try { window.dispatchEvent(new CustomEvent(SKILLS_CHANGED_EVENT)); } catch { /* non-browser */ }
}

/** 新建或更新（按 id；无 id 视为新建）。名字冲突由调用方决定，这里不强校验。返回最新列表。 */
export function upsertSkill(s: Partial<LocalSkill> & { name: string; body: string }): LocalSkill[] {
  const list = loadSkills();
  const now = Date.now();
  const name = normalizeSkillName(s.name);
  if (s.id) {
    const i = list.findIndex((x) => x.id === s.id);
    if (i >= 0) {
      // 用户手改过的导入技能视为「已脱钩」：去掉 source，后续 CLI 同步不再覆盖它。
      list[i] = { ...list[i], name, description: s.description ?? list[i].description, body: s.body, builtinSeed: false, source: undefined, origin: undefined, sourcePath: undefined, updatedAt: now };
      persist(list); return list;
    }
  }
  list.unshift({ id: `sk-${now}-${Math.random().toString(36).slice(2, 6)}`, name, description: s.description || '', body: s.body, createdAt: now, updatedAt: now });
  persist(list);
  return list;
}

export function deleteSkill(id: string): LocalSkill[] {
  const all = loadSkills();
  const victim = all.find((s) => s.id === id);
  // 删导入技能 = 拉黑其来源文件，避免下次自动同步又把它塞回来。
  if (victim?.source === 'cli' && victim.sourcePath) {
    try {
      const ig: string[] = JSON.parse(localStorage.getItem(CLI_IGNORE_KEY) || '[]');
      if (!ig.includes(victim.sourcePath)) { ig.push(victim.sourcePath); localStorage.setItem(CLI_IGNORE_KEY, JSON.stringify(ig)); }
    } catch { /* ignore */ }
  }
  const list = all.filter((s) => s.id !== id);
  persist(list);
  return list;
}

/* ------------------------------------------------------------------ *
 * Unified Skill Hub —— CLI 安装的技能自动导入。
 * 主进程扫 ~/.claude/skills、~/.claude/commands、~/.codex/prompts、
 * ~/.cursor/commands、~/.gemini/commands → 这里按 sourcePath 增量合并：
 *   · 新文件 → 导入为 source:'cli' 技能（名字撞上用户自建技能则让位，不导）
 *   · 文件内容变了 → 更新导入项（用户编辑过的已脱钩，不会被覆盖）
 *   · 文件没了 / 被用户删过(拉黑) → 移除导入项
 * 调用方：useLocalAgent 挂载时 + 窗口重新聚焦时（CLI 装完切回来就生效）。
 * ------------------------------------------------------------------ */
export async function syncCliSkills(): Promise<void> {
  const { localAgent, isLocalAgentAvailable } = await import('./localAgent');
  if (!isLocalAgentAvailable()) return;
  let scanned;
  try { scanned = await localAgent.scanCliSkills(); } catch { return; }
  if (!Array.isArray(scanned)) return;

  let ignored: string[] = [];
  try { ignored = JSON.parse(localStorage.getItem(CLI_IGNORE_KEY) || '[]'); } catch { /* ignore */ }
  const ignoredSet = new Set(ignored);

  const list = loadSkills();
  const byPath = new Map(list.filter((s) => s.source === 'cli' && s.sourcePath).map((s) => [s.sourcePath as string, s]));
  const manualNames = new Set(list.filter((s) => s.source !== 'cli').map((s) => s.name.toLowerCase()));
  const livePaths = new Set<string>();
  let changed = false;
  const now = Date.now();

  for (const e of scanned) {
    if (!e.path || ignoredSet.has(e.path)) continue;
    livePaths.add(e.path);
    const name = normalizeSkillName(e.name);
    if (!name || !e.body) continue;
    const existing = byPath.get(e.path);
    if (existing) {
      if (existing.name !== name || existing.description !== e.description || existing.body !== e.body) {
        existing.name = name; existing.description = e.description; existing.body = e.body; existing.updatedAt = now;
        changed = true;
      }
      continue;
    }
    if (manualNames.has(name)) continue;                       // 用户自建同名技能优先
    if (list.some((s) => s.source === 'cli' && s.name === name)) continue; // 多 CLI 同名只导第一个
    list.push({
      id: `sk-cli-${now}-${Math.random().toString(36).slice(2, 6)}`,
      name, description: e.description || '', body: e.body,
      source: 'cli', origin: e.origin, sourcePath: e.path,
      createdAt: now, updatedAt: now,
    });
    changed = true;
  }

  // 来源文件消失 → 同步移除导入项。
  const next = list.filter((s) => !(s.source === 'cli' && s.sourcePath && !livePaths.has(s.sourcePath)));
  if (next.length !== list.length) changed = true;

  if (changed) {
    try { localStorage.setItem(SKILLS_KEY, JSON.stringify(next)); } catch { /* quota */ }
    try { window.dispatchEvent(new CustomEvent(SKILLS_CHANGED_EVENT)); } catch { /* non-browser */ }
  }
}

/**
 * 若 input 是 `/技能名 [参数]` 且命中某个 Chaya 技能，返回展开后的 prompt；否则返回 null
 * （null = 不是 Chaya 技能，原样下发，让 CLI 原生命令照常工作）。
 */
export function expandSkill(input: string, skills: LocalSkill[]): string | null {
  const text = (input || '').trimStart();
  if (text[0] !== '/') return null;
  const m = /^\/([a-zA-Z0-9_-]+)(?:[ \t]+([\s\S]*))?$/.exec(text);
  if (!m) return null;
  const name = m[1].toLowerCase();
  const args = (m[2] || '').trim();
  const skill = skills.find((s) => s.name.toLowerCase() === name);
  if (!skill) return null;
  if (skill.body.includes('{{input}}')) return skill.body.split('{{input}}').join(args);
  return args ? `${skill.body}\n\n${args}` : skill.body;
}
