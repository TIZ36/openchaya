/* evolve（渲染层桥）—— 升格 agent 会话的本地自进化。
 *
 * 真正的引擎在主进程 electron/evolve.cjs（SQLite + reflect/consolidate + 记忆文件）。
 * 这里只是薄封装 + 事件广播，让 AgentsManager 等 UI 拿到进化结果并刷新。 */

export interface EvolveSkill {
  name: string;
  description: string;
  body: string;
  keywords: string[];
  maturity: 'draft' | 'trusted' | 'promoted' | 'rejected' | 'archived';
  uses: number;
  reject_reason: string;
  source: string;
  updated_at: number;
}
export interface EvolveBlock { id: number; label: string; value: string; description: string; updated_at: number }
export interface EvolveNote { id: number; value: string; tags: string[]; consolidated: number; updated_at: number }
export interface EvolutionEvent { summary: string; blocks: { label: string; value: string }[]; notes: { content: string }[]; skills: { name: string; action: string }[] }

export const EVOLUTION_EVENT = 'chaya:agentEvolved';

interface Bridge {
  evolve?: {
    reflect(args: Record<string, unknown>): Promise<{ ok: boolean; event?: EvolutionEvent; error?: string }>;
    listSkills(agentId: string): Promise<EvolveSkill[]>;
    listMemory(agentId: string): Promise<{ blocks: EvolveBlock[]; notes: EvolveNote[] }>;
    approveSkill(agentId: string, name: string): Promise<boolean>;
    vetoSkill(agentId: string, name: string, reason: string): Promise<boolean>;
    reviseSkill(agentId: string, name: string, patch: Record<string, unknown>): Promise<boolean>;
    deleteSkill(agentId: string, name: string): Promise<boolean>;
    consolidate(agentId: string, promoteAt?: number): Promise<string[]>;
    writeMemoryFile(agentId: string, cwd: string): Promise<string | null>;
    memoryMarkdown(agentId: string): Promise<string>;
  };
}

function ev(): Bridge['evolve'] | null {
  const b = (typeof window !== 'undefined' ? (window as unknown as { chateeElectron?: Bridge }).chateeElectron : null) || null;
  return b?.evolve || null;
}

export function isEvolveAvailable(): boolean { return !!ev(); }

/** post-turn 反思：fire-and-forget（失败静默，绝不影响主回合）。成功且有变更 → 广播事件。 */
export async function reflectTurn(args: {
  agentId: string; provider: string; cwd: string; model?: string; mcp?: string[]; task: string; response: string;
}): Promise<void> {
  const e = ev();
  if (!e) return;
  try {
    const r = await e.reflect(args);
    if (r && r.ok && r.event) {
      const changed = r.event.blocks.length || r.event.notes.length || r.event.skills.length;
      if (changed) {
        try { window.dispatchEvent(new CustomEvent(EVOLUTION_EVENT, { detail: { agentId: args.agentId, event: r.event } })); } catch { /* */ }
      }
    }
  } catch { /* best-effort */ }
}

export async function listSkills(agentId: string): Promise<EvolveSkill[]> { const e = ev(); return e ? e.listSkills(agentId).catch(() => []) : []; }
export async function listMemory(agentId: string): Promise<{ blocks: EvolveBlock[]; notes: EvolveNote[] }> { const e = ev(); return e ? e.listMemory(agentId).catch(() => ({ blocks: [], notes: [] })) : { blocks: [], notes: [] }; }
export async function approveSkill(agentId: string, name: string): Promise<boolean> { const e = ev(); return e ? e.approveSkill(agentId, name).catch(() => false) : false; }
export async function vetoSkill(agentId: string, name: string, reason: string): Promise<boolean> { const e = ev(); return e ? e.vetoSkill(agentId, name, reason).catch(() => false) : false; }
export async function reviseSkill(agentId: string, name: string, patch: Record<string, unknown>): Promise<boolean> { const e = ev(); return e ? e.reviseSkill(agentId, name, patch).catch(() => false) : false; }
export async function deleteSkill(agentId: string, name: string): Promise<boolean> { const e = ev(); return e ? e.deleteSkill(agentId, name).catch(() => false) : false; }
export async function writeMemoryFile(agentId: string, cwd: string): Promise<void> { const e = ev(); if (e) await e.writeMemoryFile(agentId, cwd).catch(() => null); }
export async function memoryMarkdown(agentId: string): Promise<string> { const e = ev(); return e ? e.memoryMarkdown(agentId).catch(() => '') : ''; }

export function subscribeEvolution(cb: (detail: { agentId: string; event: EvolutionEvent }) => void): () => void {
  const h = (e: Event) => cb((e as CustomEvent).detail);
  try { window.addEventListener(EVOLUTION_EVENT, h as EventListener); } catch { /* */ }
  return () => { try { window.removeEventListener(EVOLUTION_EVENT, h as EventListener); } catch { /* */ } };
}
