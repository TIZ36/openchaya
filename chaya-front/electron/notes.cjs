/* ============================================================
   Local notes file IO (本地优先笔记).
   Notes live as .md files in a user-picked directory; the cloud is a
   mirror + search index. This module is the Electron side: pick dir,
   list / read / write / create / rename / delete. The renderer's
   localNotes service wraps these; sync-to-cloud happens in the renderer
   (it already has the Smartnote Cloud client).
   ============================================================ */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { shell } = require('electron');

const NOTE_EXT = new Set(['.md', '.markdown', '.txt', '.mdown']);

function isNoteFile(name) {
  return NOTE_EXT.has(path.extname(name).toLowerCase());
}

async function listDir(dir) {
  if (!dir) return { ok: false, error: 'no dir', files: [] };
  try {
    const ents = await fsp.readdir(dir, { withFileTypes: true });
    const files = [];
    for (const e of ents) {
      if (!e.isFile() || !isNoteFile(e.name) || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      let mtimeMs = 0, size = 0;
      try { const st = await fsp.stat(full); mtimeMs = st.mtimeMs; size = st.size; } catch { /* */ }
      files.push({ name: e.name, path: full, mtimeMs, size });
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return { ok: true, files };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err), files: [] };
  }
}

async function statNote(p) {
  try {
    const st = await fsp.stat(p);
    return { ok: true, path: p, name: path.basename(p), mtimeMs: st.mtimeMs, size: st.size, exists: st.isFile() };
  } catch {
    return { ok: true, path: p, name: path.basename(p), mtimeMs: 0, size: 0, exists: false };
  }
}

async function readNote(p) {
  try { return { ok: true, content: await fsp.readFile(p, 'utf8') }; }
  catch (err) { return { ok: false, error: String(err && err.message || err), content: '' }; }
}

async function writeNote(p, content) {
  try { await fsp.writeFile(p, content ?? '', 'utf8'); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err && err.message || err) }; }
}

/** Create a uniquely-named .md under dir. base is the desired title (no ext). */
async function createNote(dir, base) {
  try {
    const safe = (base || '未命名笔记').replace(/[\/\\:*?"<>|]/g, '_').slice(0, 80) || '未命名笔记';
    let name = `${safe}.md`;
    let full = path.join(dir, name);
    let i = 1;
    while (fs.existsSync(full)) { name = `${safe} ${i}.md`; full = path.join(dir, name); i++; }
    await fsp.writeFile(full, '', 'utf8');
    return { ok: true, path: full, name };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

async function renameNote(p, base) {
  try {
    const dir = path.dirname(p);
    const safe = (base || '未命名笔记').replace(/[\/\\:*?"<>|]/g, '_').slice(0, 80) || '未命名笔记';
    let name = `${safe}.md`;
    let dst = path.join(dir, name);
    let i = 1;
    while (fs.existsSync(dst) && dst !== p) { name = `${safe} ${i}.md`; dst = path.join(dir, name); i++; }
    if (dst !== p) await fsp.rename(p, dst);
    return { ok: true, path: dst, name };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

async function deleteNote(p) {
  try { await shell.trashItem(p); return { ok: true }; }
  catch (err) {
    // Fallback to unlink if trash unavailable.
    try { await fsp.unlink(p); return { ok: true }; }
    catch (e2) { return { ok: false, error: String(e2 && e2.message || e2) }; }
  }
}

function registerNotes(ipcMain, dialog) {
  // 平铺管理：从任意目录导入 .md/.txt 文件（多选）。
  ipcMain.handle('notes:pickFiles', async () => {
    const res = await dialog.showOpenDialog({
      title: '选择本地笔记文件',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Notes', extensions: ['md', 'markdown', 'txt', 'mdown'] }, { name: 'All', extensions: ['*'] }],
    });
    if (res.canceled) return [];
    return res.filePaths || [];
  });
  // 新建：保存对话框选位置 + 文件名，建空文件。
  ipcMain.handle('notes:createFile', async (_e, { defaultName }) => {
    const res = await dialog.showSaveDialog({
      title: '新建笔记',
      defaultPath: defaultName || '未命名笔记.md',
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false };
    try { await fsp.writeFile(res.filePath, '', 'utf8'); return { ok: true, path: res.filePath }; }
    catch (err) { return { ok: false, error: String(err && err.message || err) }; }
  });
  ipcMain.handle('notes:stat', (_e, { path: p }) => statNote(p));
  ipcMain.handle('notes:read', (_e, { path: p }) => readNote(p));
  ipcMain.handle('notes:write', (_e, { path: p, content }) => writeNote(p, content));
  ipcMain.handle('notes:rename', (_e, { path: p, name }) => renameNote(p, name));
  ipcMain.handle('notes:delete', (_e, { path: p }) => deleteNote(p));
  // 兼容旧入口（不再用，但保留以防外部调用）
  ipcMain.handle('notes:pickDir', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    return res.canceled ? null : (res.filePaths[0] || null);
  });
  ipcMain.handle('notes:list', (_e, { dir }) => listDir(dir));
  ipcMain.handle('notes:create', (_e, { dir, name }) => createNote(dir, name));
}

module.exports = { registerNotes };
