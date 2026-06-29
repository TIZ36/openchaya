/* configDb —— 纯本地 SQLite 配置库（取代散落的 localStorage 凭证 / 后端 LLM 配置）。
 *
 * 转纯客户端后唯一的「用户配置」真源：用户 API 信息、SmartNote Cloud 凭证、cursor 凭证、
 * MCP OAuth 凭证等都落这里（userData/chaya.db）。自进化引擎（evolve.cjs）复用同一个连接，
 * 通过 getDb() 在同库里建 agent_memory / agent_skill 表。
 *
 * 两类存储：
 *   kv      —— 通用键值（JSON 文本），存非敏感配置（base url、偏好等需要主进程也能读的项）。
 *   secrets —— 凭证（value + meta JSON），与 kv 分表只为语义清晰 / 便于将来单独加密。
 *
 * 渲染层经 preload 的 sendSync('config:snapshot') 在启动时同步拿到全量快照，
 * 使现有同步读取的调用点（getSmartnoteApiKey 等）无需改成异步；写入走 invoke 异步落库。
 */
const path = require('path');

let _db = null;
let _Database = null;

function dbPath(app) {
  return path.join(app.getPath('userData'), 'chaya.db');
}

/** 打开（或复用）SQLite 连接并建表。better-sqlite3 是原生模块，需 electron-rebuild；
 *  若加载失败（未 rebuild）抛错——配置库是核心，不做静默降级，让问题显性暴露。 */
function getDb(app) {
  if (_db) return _db;
  if (!_Database) _Database = require('better-sqlite3');
  _db = new _Database(dbPath(app));
  _db.pragma('journal_mode = WAL');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS secrets (
      name TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      meta TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
    );
  `);
  return _db;
}

// ── kv ────────────────────────────────────────────────────────────────────────
function kvGet(app, k) {
  const row = getDb(app).prepare('SELECT v FROM kv WHERE k = ?').get(k);
  return row ? row.v : null;
}
function kvSet(app, k, v) {
  getDb(app)
    .prepare('INSERT INTO kv(k, v, updated_at) VALUES(?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at')
    .run(k, String(v ?? ''), Date.now());
}
function kvDel(app, k) {
  getDb(app).prepare('DELETE FROM kv WHERE k = ?').run(k);
}

// ── secrets ─────────────────────────────────────────────────────────────────
function secretGet(app, name) {
  const row = getDb(app).prepare('SELECT value, meta FROM secrets WHERE name = ?').get(name);
  if (!row) return null;
  let meta = {};
  try { meta = JSON.parse(row.meta || '{}'); } catch { /* */ }
  return { value: row.value || '', meta };
}
function secretSet(app, name, value, meta) {
  getDb(app)
    .prepare('INSERT INTO secrets(name, value, meta, updated_at) VALUES(?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, meta = excluded.meta, updated_at = excluded.updated_at')
    .run(name, String(value ?? ''), JSON.stringify(meta || {}), Date.now());
}
function secretDel(app, name) {
  getDb(app).prepare('DELETE FROM secrets WHERE name = ?').run(name);
}

/** 启动期全量快照：渲染层同步注入用，使凭证读取保持同步语义。 */
function snapshot(app) {
  const db = getDb(app);
  const kv = {};
  for (const row of db.prepare('SELECT k, v FROM kv').all()) kv[row.k] = row.v;
  const secrets = {};
  for (const row of db.prepare('SELECT name, value, meta FROM secrets').all()) {
    let meta = {};
    try { meta = JSON.parse(row.meta || '{}'); } catch { /* */ }
    secrets[row.name] = { value: row.value || '', meta };
  }
  return { kv, secrets };
}

function registerConfig(ipcMain, app) {
  // 同步快照（preload 在加载时 sendSync 取一次，挂到 window，供渲染层同步读）。
  ipcMain.on('config:snapshot', (e) => {
    try { e.returnValue = snapshot(app); }
    catch (err) { console.error('[configDb] snapshot failed:', err); e.returnValue = { kv: {}, secrets: {} }; }
  });

  ipcMain.handle('config:get', (_e, { key }) => kvGet(app, key));
  ipcMain.handle('config:set', (_e, { key, value }) => { kvSet(app, key, value); return true; });
  ipcMain.handle('config:del', (_e, { key }) => { kvDel(app, key); return true; });

  ipcMain.handle('secret:get', (_e, { name }) => secretGet(app, name));
  ipcMain.handle('secret:set', (_e, { name, value, meta }) => { secretSet(app, name, value, meta); return true; });
  ipcMain.handle('secret:del', (_e, { name }) => { secretDel(app, name); return true; });
}

module.exports = {
  registerConfig,
  getDb,
  // 给其它主进程模块（evolve.cjs）直接读写配置/凭证用：
  kvGet, kvSet, kvDel, secretGet, secretSet, secretDel, snapshot,
};
