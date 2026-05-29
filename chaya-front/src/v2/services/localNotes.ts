/* ============================================================
   Local-first notes — flat registry of .md/.txt files from ANY directory.
   The app keeps a flat list of file paths (localStorage), so the user can
   import notes from different folders and manage them in one place. The
   cloud (Smartnote) is a mirror + search index; sync-to-cloud is done by
   the caller. Web (non-Electron) builds: isLocalNotesAvailable()=false.
   ============================================================ */

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
export async function newNoteFile(defaultName = '未命名笔记.md'): Promise<string | null> {
  const b = bridge(); if (!b) throw new Error('本地笔记不可用');
  const r = await b.createFile(defaultName);
  if (!r.ok) { if (r.error) throw new Error(r.error); return null; } // user cancelled → ok:false no error
  if (!r.path) return null;
  addFiles([r.path]);
  return r.path;
}

export async function readNote(path: string): Promise<string> {
  const b = bridge(); if (!b) return '';
  const r = await b.read(path);
  if (!r.ok) throw new Error(r.error || '读取失败');
  return r.content;
}
export async function writeNote(path: string, content: string): Promise<void> {
  const b = bridge(); if (!b) throw new Error('本地笔记不可用');
  const r = await b.write(path, content);
  if (!r.ok) throw new Error(r.error || '保存失败');
}
export async function renameNote(path: string, name: string): Promise<string> {
  const b = bridge(); if (!b) throw new Error('本地笔记不可用');
  const r = await b.rename(path, name);
  if (!r.ok || !r.path) throw new Error(r.error || '改名失败');
  if (r.path !== path) { replaceFile(path, r.path); remapSync(path, r.path); }
  return r.path;
}
export async function deleteNote(path: string): Promise<void> {
  const b = bridge(); if (!b) throw new Error('本地笔记不可用');
  const r = await b.delete(path);
  if (!r.ok) throw new Error(r.error || '删除失败');
  removeFile(path); unmapSync(path);
}
/** Remove from the app's list without deleting the file on disk. */
export function forgetNote(path: string): void { removeFile(path); unmapSync(path); }

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
