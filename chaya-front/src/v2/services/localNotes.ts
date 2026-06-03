/* ============================================================
   Local-first notes — flat registry of .md/.txt files from ANY directory.
   The app keeps a flat list of file paths (localStorage), so the user can
   import notes from different folders and manage them in one place. The
   cloud (Smartnote) is a mirror + search index; sync-to-cloud is done by
   the caller. Web (non-Electron) builds: isLocalNotesAvailable()=false.
   ============================================================ */
import { t } from '../../i18n';

/** Flat registry: file paths the user has added (from anywhere). */
const LS_FILES = 'chaya_notes_files';
/** Map localFilePath → cloud documentId, so re-sync patches instead of dup. */
const LS_SYNC_MAP = 'chaya_notes_sync_map';

interface NotesBridge {
  pickFiles: () => Promise<string[]>;
  createFile: (defaultName: string) => Promise<{ ok: boolean; error?: string; path?: string }>;
  stat: (path: string) => Promise<{ ok: boolean; path: string; name: string; mtimeMs: number; size: number; exists: boolean }>;
  read: (path: string) => Promise<{ ok: boolean; error?: string; content: string }>;
  write: (path: string, content: string) => Promise<{ ok: boolean; error?: string }>;
  rename: (path: string, name: string) => Promise<{ ok: boolean; error?: string; path?: string; name?: string }>;
  delete: (path: string) => Promise<{ ok: boolean; error?: string }>;
  defaultNote?: () => Promise<{ ok: boolean; error?: string; path?: string; name?: string; mtimeMs?: number; size?: number }>;
  append?: (path: string, text: string) => Promise<{ ok: boolean; error?: string; mtimeMs?: number; size?: number }>;
  chooseDefault?: () => Promise<{ ok: boolean; error?: string; path?: string; name?: string; mtimeMs?: number; size?: number }>;
  pickDefault?: () => Promise<{ ok: boolean; error?: string; path?: string; name?: string; mtimeMs?: number; size?: number }>;
}

export interface LocalNoteFile {
  name: string;       // e.g. "我的笔记.md"
  path: string;       // absolute
  mtimeMs: number;
  size: number;
}

function bridge(): NotesBridge | null {
  const e = (window as any).chateeElectron;
  return e?.notes ?? null;
}

export function isLocalNotesAvailable(): boolean {
  return !!bridge();
}

/* ---- registry ---- */
function readFiles(): string[] {
  try { const a = JSON.parse(localStorage.getItem(LS_FILES) || '[]'); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
function writeFiles(paths: string[]): void {
  try { localStorage.setItem(LS_FILES, JSON.stringify(Array.from(new Set(paths)))); } catch { /* */ }
}
function addFiles(paths: string[]): void { writeFiles([...readFiles(), ...paths]); }
function removeFile(path: string): void { writeFiles(readFiles().filter((p) => p !== path)); }
function replaceFile(oldPath: string, newPath: string): void {
  writeFiles(readFiles().map((p) => (p === oldPath ? newPath : p)));
}

/** Stat every registered file; silently drops ones that no longer exist. */
export async function listNotes(): Promise<LocalNoteFile[]> {
  const b = bridge(); if (!b) return [];
  const paths = readFiles();
  const out: LocalNoteFile[] = [];
  const gone: string[] = [];
  await Promise.all(paths.map(async (p) => {
    try {
      const s = await b.stat(p);
      if (s.ok && s.exists) out.push({ name: s.name, path: s.path, mtimeMs: s.mtimeMs, size: s.size });
      else gone.push(p);
    } catch { /* keep — transient */ }
  }));
  if (gone.length) writeFiles(paths.filter((p) => !gone.includes(p)));
  out.sort((a, b2) => b2.mtimeMs - a.mtimeMs);
  return out;
}

/** Import existing files from anywhere → add to the flat registry. Returns added paths. */
export async function importNotes(): Promise<string[]> {
  const b = bridge(); if (!b) return [];
  const picked = await b.pickFiles();
  if (picked && picked.length) addFiles(picked);
  return picked || [];
}

/** New note: save-dialog to choose where, create empty file, register it. */
export async function newNoteFile(defaultName = `${t('local.notes.untitled')}.md`): Promise<string | null> {
  const b = bridge(); if (!b) throw new Error(t('local.notes.unavailable'));
  const r = await b.createFile(defaultName);
  if (!r.ok) { if (r.error) throw new Error(r.error); return null; } // user cancelled → ok:false no error
  if (!r.path) return null;
  addFiles([r.path]);
  return r.path;
}

export async function readNote(path: string): Promise<string> {
  const b = bridge(); if (!b) return '';
  const r = await b.read(path);
  if (!r.ok) throw new Error(r.error || t('local.notes.readFailed'));
  return r.content;
}
export async function writeNote(path: string, content: string): Promise<void> {
  const b = bridge(); if (!b) throw new Error(t('local.notes.unavailable'));
  const r = await b.write(path, content);
  if (!r.ok) throw new Error(r.error || t('local.notes.saveFailed'));
}
export async function renameNote(path: string, name: string): Promise<string> {
  const b = bridge(); if (!b) throw new Error(t('local.notes.unavailable'));
  const r = await b.rename(path, name);
  if (!r.ok || !r.path) throw new Error(r.error || t('local.notes.renameFailed'));
  if (r.path !== path) { replaceFile(path, r.path); remapSync(path, r.path); }
  return r.path;
}
export async function deleteNote(path: string): Promise<void> {
  const b = bridge(); if (!b) throw new Error(t('local.notes.unavailable'));
  const r = await b.delete(path);
  if (!r.ok) throw new Error(r.error || t('local.notes.deleteFailed'));
  removeFile(path); unmapSync(path);
}
/** Remove from the app's list without deleting the file on disk. */
export function forgetNote(path: string): void { removeFile(path); unmapSync(path); }

/* Default-note location: local-first. By default a fixed ~/Documents/Chaya/速记.md;
 * the user can relocate it (e.g. into an iCloud Drive folder) — the chosen path is
 * remembered here and becomes the append target. Cloud (smartnote) sync stays manual. */
const LS_DEFAULT_NOTE = 'chaya_default_note_path';
export function getDefaultNotePath(): string | null {
  try { return localStorage.getItem(LS_DEFAULT_NOTE) || null; } catch { return null; }
}
function setDefaultNotePath(p: string | null): void {
  try { if (p) localStorage.setItem(LS_DEFAULT_NOTE, p); else localStorage.removeItem(LS_DEFAULT_NOTE); } catch { /* */ }
}

/** The default "速记" note. Honors a user-chosen location if set (creating it when
 *  missing); otherwise the fixed auto path. Auto-registered into the flat list. */
export async function defaultNote(): Promise<LocalNoteFile | null> {
  const b = bridge();
  if (!b) return null;
  const custom = getDefaultNotePath();
  if (custom) {
    try {
      let st = await b.stat(custom);
      if (!st.exists) { await b.write(custom, '# 速记\n\n'); st = await b.stat(custom); }
      addFiles([custom]);
      return { name: st.name, path: custom, mtimeMs: st.mtimeMs, size: st.size };
    } catch { /* relocated file vanished → fall back to auto */ setDefaultNotePath(null); }
  }
  if (!b.defaultNote) return null;
  const r = await b.defaultNote();
  if (!r.ok || !r.path) return null;
  addFiles([r.path]);
  return { name: r.name || '速记.md', path: r.path, mtimeMs: r.mtimeMs || Date.now(), size: r.size || 0 };
}

/** 关联速记到一个**已有**的本地文件（开放对话框选既存 .md，如 iCloud Drive 里的）。
 *  保留该文件内容；之后「记一条」都追加到它。 */
export async function associateDefaultNote(): Promise<LocalNoteFile | null> {
  const b = bridge();
  if (!b?.pickDefault) return null;
  const r = await b.pickDefault();
  if (!r.ok || !r.path) return null;
  setDefaultNotePath(r.path);
  addFiles([r.path]);
  return { name: r.name || '速记', path: r.path, mtimeMs: r.mtimeMs || Date.now(), size: r.size || 0 };
}

/** 新建速记到指定位置（保存对话框 → 可放进 iCloud Drive 文件夹）。已存在文件不清空。 */
export async function chooseDefaultNoteLocation(): Promise<LocalNoteFile | null> {
  const b = bridge();
  if (!b?.chooseDefault) return null;
  const r = await b.chooseDefault();
  if (!r.ok || !r.path) return null;
  setDefaultNotePath(r.path);
  addFiles([r.path]);
  return { name: r.name || '速记.md', path: r.path, mtimeMs: r.mtimeMs || Date.now(), size: r.size || 0 };
}

/** 另存为：把给定内容写到一个新选的本地位置（保存对话框，可在 iCloud Drive），
 *  并把速记关联到它。用于「重新保存到新的本地地址并关联」。 */
export async function saveDefaultNoteAs(content: string): Promise<LocalNoteFile | null> {
  const b = bridge();
  if (!b?.chooseDefault) return null;
  const r = await b.chooseDefault();
  if (!r.ok || !r.path) return null;
  await b.write(r.path, content ?? '');   // 把当前内容写进新位置
  setDefaultNotePath(r.path);
  addFiles([r.path]);
  return { name: r.name || '速记.md', path: r.path, mtimeMs: Date.now(), size: (content || '').length };
}

/** 取消关联，恢复到自动默认位置（~/Documents/Chaya/速记.md）。 */
export function resetDefaultNoteLocation(): void { setDefaultNotePath(null); }

/** Append a block to a note file (used by the selection "记一条" capture). */
export async function appendToNote(path: string, text: string): Promise<void> {
  const b = bridge();
  if (!b?.append) throw new Error(t('local.notes.unavailable'));
  const r = await b.append(path, text);
  if (!r.ok) throw new Error(r.error || t('local.notes.saveFailed'));
}

/** display title = filename without extension. */
export function noteTitle(f: LocalNoteFile): string {
  return f.name.replace(/\.(md|markdown|txt|mdown)$/i, '');
}

/* ---- local path ↔ cloud doc id mapping (for idempotent sync) ---- */
function readMap(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(LS_SYNC_MAP) || '{}'); } catch { return {}; }
}
function writeMap(m: Record<string, string>): void {
  try { localStorage.setItem(LS_SYNC_MAP, JSON.stringify(m)); } catch { /* */ }
}
export function syncedDocId(path: string): string | undefined { return readMap()[path]; }
export function mapSync(path: string, docId: string): void { const m = readMap(); m[path] = docId; writeMap(m); }
export function unmapSync(path: string): void { const m = readMap(); delete m[path]; writeMap(m); }
function remapSync(oldPath: string, newPath: string): void {
  const m = readMap(); if (m[oldPath]) { m[newPath] = m[oldPath]; delete m[oldPath]; writeMap(m); }
}
/** All cloud doc ids that are mirrors of a local note (to dedupe the tree). */
export function syncedDocIds(): Set<string> { return new Set(Object.values(readMap())); }
