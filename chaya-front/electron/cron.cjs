/* ============================================================
   Cron —— 识别并管理「操作系统级」定时任务（macOS / Linux 用户 crontab）。
   provider 无关：扫的是系统 crontab，与任何 CLI（claude/cursor/…）无关，
   关掉终端 / 重启电脑都照跑（独立于本 app 与任何 Claude 进程）。

   为什么不是 harness（CronCreate）：claude code 的 cron 跑在 harness 内存调度器里，
   只在 Claude 进程空闲时触发，Claude 一关就停；所谓 durable 顶多是重启后从 json 重载，
   且实测该 build 的落盘路径未生效。要「真脱机」只能用 OS crontab/launchd。

   约定（便于扫描归集）：我们建议 CLI 把脚本与日志收进 ~/.chaya/cron/，并在 crontab 行前
   插一行标记注释 `# chaya-cron id=.. :: <name> :: cwd=<dir>`，这样能归属、可一键删/试跑/看日志。
   未按约定的既有 crontab 行也照样列出（标 external，只读偏多）。

   可选「睡眠补跑」：把某条升格成 macOS LaunchAgent —— launchd 会在唤醒后补跑睡眠期间错过的
   日历触发（crontab 不补跑）。升格时注释掉对应 crontab 行避免双触发，取消时再恢复。
   ============================================================ */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { app, BrowserWindow, shell } = require('electron');
const { execFile, spawn } = require('child_process');
const { resolveBin, childEnv } = require('./localAgent.cjs');

const IS_MAC = process.platform === 'darwin';
const HAS_CRONTAB = process.platform !== 'win32';
const CRONTAB_BIN = '/usr/bin/crontab';
const CRON_DIR = path.join(os.homedir(), '.chaya', 'cron');   // 约定的脚本/日志归集目录
const LABEL_PREFIX = 'com.chaya.cron.';
const AGENTS_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
const MARKER = 'chaya-cron';

let DIR = '';            // userData/cron
let REG_FILE = '';       // launchd 升格登记
let registry = {};       // label -> { label, jobId, schedule, scriptPath, logPath, plist, createdAt }

/* ---------------- 持久化（launchd 升格登记） ---------------- */
function ensureDirs() {
  DIR = path.join(app.getPath('userData'), 'cron');
  REG_FILE = path.join(DIR, 'promoted.json');
  try { fs.mkdirSync(DIR, { recursive: true }); } catch { /* */ }
  try { fs.mkdirSync(CRON_DIR, { recursive: true }); } catch { /* */ }
  try { registry = JSON.parse(fs.readFileSync(REG_FILE, 'utf8')) || {}; } catch { registry = {}; }
  if (!registry || typeof registry !== 'object') registry = {};
}
function saveRegistry() {
  try { fs.writeFileSync(`${REG_FILE}.tmp`, JSON.stringify(registry, null, 2), 'utf8'); fs.renameSync(`${REG_FILE}.tmp`, REG_FILE); } catch { /* */ }
}

/* ---------------- 事件广播 ---------------- */
function broadcast(ev) {
  for (const w of BrowserWindow.getAllWindows()) {
    try { if (!w.isDestroyed()) w.webContents.send('cron:event', ev); } catch { /* */ }
  }
}

/* ---------------- crontab 读写 ---------------- */
function readCrontab() {
  return new Promise((resolve) => {
    if (!HAS_CRONTAB) return resolve('');
    execFile(CRONTAB_BIN, ['-l'], { env: childEnv(), timeout: 8000 }, (err, stdout, stderr) => {
      // 无 crontab 时 crontab -l 退出非 0 且 stderr "no crontab for ..." → 当空处理。
      if (err && !/no crontab/i.test(String(stderr || ''))) { resolve(stdout || ''); return; }
      resolve(stdout || '');
    });
  });
}
function writeCrontab(text) {
  return new Promise((resolve) => {
    if (!HAS_CRONTAB) return resolve({ ok: false, error: 'crontab 仅 macOS/Linux' });
    try {
      const p = spawn(CRONTAB_BIN, ['-'], { env: childEnv() });
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', (e) => resolve({ ok: false, error: String(e && e.message || e) }));
      p.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: err || `crontab exit ${code}` }));
      p.stdin.write(text.endsWith('\n') ? text : `${text}\n`);
      p.stdin.end();
    } catch (e) { resolve({ ok: false, error: String(e && e.message || e) }); }
  });
}

/* ---------------- 解析 ----------------
 * 把 crontab 文本解析成任务数组。识别我们的标记注释 + 归集目录命令；
 * 升格 launchd 时被注释掉的任务行也能识别（前缀 #，紧跟在标记之后）。
 */
function isScheduleToken(tok) {
  return /^@(reboot|yearly|annually|monthly|weekly|daily|midnight|hourly)$/.test(tok) || /^[\d*\/,\-]+$/.test(tok);
}
function splitJobLine(line) {
  const s = line.trim();
  if (s.startsWith('@')) {
    const sp = s.search(/\s/);
    if (sp < 0) return null;
    return { schedule: s.slice(0, sp), command: s.slice(sp + 1).trim() };
  }
  const m = s.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/);
  if (!m) return null;
  if (![m[1], m[2], m[3], m[4], m[5]].every(isScheduleToken)) return null;
  return { schedule: `${m[1]} ${m[2]} ${m[3]} ${m[4]} ${m[5]}`, command: m[6].trim() };
}
function parseMarker(line) {
  // # chaya-cron id=ID :: NAME :: cwd=CWD   （NAME / cwd 可缺省）
  const m = /^#\s*chaya-cron\s+id=(\S+)(?:\s*::\s*(.*?))?(?:\s*::\s*cwd=(.*))?$/.exec(line.trim());
  if (!m) return null;
  return { id: m[1], name: (m[2] || '').trim() || undefined, cwd: (m[3] || '').trim() || undefined };
}
function pathsFromCommand(cmd) {
  // 从命令里抠出脚本路径与 `>> x.log` 日志路径（best-effort）。
  const out = {};
  const logM = />>?\s*("?)([^"'>\s]+\.log)\1/.exec(cmd);
  if (logM) out.logPath = logM[2];
  const shM = /("?)((?:\/[^"'\s]+|\$HOME\/[^"'\s]+|~\/[^"'\s]+)\.sh)\1/.exec(cmd);
  if (shM) out.scriptPath = shM[2];
  return out;
}
function jobIdFor(raw) { return 'ext-' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12); }

function parseCrontab(text) {
  const lines = String(text || '').split('\n');
  const jobs = [];
  let pendingMarker = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t) { pendingMarker = null; continue; }
    const mk = parseMarker(line);
    if (mk) { pendingMarker = mk; continue; }
    // 任务行：正常 or 被注释掉（升格 launchd 后，前缀 # 且紧跟在标记之后）。
    let disabled = false; let body = line;
    if (t.startsWith('#')) {
      const uncomment = t.replace(/^#+\s?/, '');
      if (pendingMarker && splitJobLine(uncomment)) { disabled = true; body = uncomment; }
      else { pendingMarker = null; continue; }   // 普通注释/环境行 → 丢弃待定标记
    }
    const parsed = splitJobLine(disabled ? body : line);
    if (!parsed) { pendingMarker = null; continue; }
    const managed = !!pendingMarker || parsed.command.includes(CRON_DIR);
    const id = pendingMarker?.id || jobIdFor(line);
    const paths = pathsFromCommand(parsed.command);
    const label = LABEL_PREFIX + crypto.createHash('sha1').update(id).digest('hex').slice(0, 16);
    jobs.push({
      id,
      schedule: parsed.schedule,
      command: parsed.command,
      managed,
      name: pendingMarker?.name,
      cwd: pendingMarker?.cwd,
      scriptPath: paths.scriptPath,
      logPath: paths.logPath,
      disabled,
      offline: !!registry[label],
      label,
      source: 'crontab',
      lineIndex: i,
    });
    pendingMarker = null;
  }
  return jobs;
}

/* 删除某任务：移除其任务行 + 紧邻的标记注释行；返回新文本。 */
function removeJobFromText(text, job) {
  const lines = String(text || '').split('\n');
  const idx = job.lineIndex;
  if (idx == null || idx < 0 || idx >= lines.length) return text;
  const drop = new Set([idx]);
  if (idx > 0 && parseMarker(lines[idx - 1])) drop.add(idx - 1);
  return lines.filter((_, i) => !drop.has(i)).join('\n');
}
function setJobDisabledInText(text, job, disabled) {
  const lines = String(text || '').split('\n');
  const idx = job.lineIndex;
  if (idx == null || idx < 0 || idx >= lines.length) return text;
  const cur = lines[idx];
  if (disabled) { if (!cur.trim().startsWith('#')) lines[idx] = `#${cur}`; }
  else { lines[idx] = cur.replace(/^#+\s?/, ''); }
  return lines.join('\n');
}

/* ---------------- harness durable（次要源：.claude/scheduled_tasks.json） ---------------- */
function readHarness(cwd) {
  if (!cwd) return [];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'scheduled_tasks.json'), 'utf8'));
    const arr = (j && Array.isArray(j.tasks)) ? j.tasks : [];
    return arr.filter((t) => t && typeof t.id === 'string' && typeof t.cron === 'string').map((t) => ({
      id: `harness-${t.id}`, schedule: t.cron, command: t.prompt || '', managed: false, name: undefined,
      cwd, scriptPath: undefined, logPath: undefined, disabled: false, offline: false, label: '',
      source: 'harness', lineIndex: -1, prompt: t.prompt,
    }));
  } catch { return []; }
}

/* ---------------- launchd 升格（可选「睡眠补跑」） ---------------- */
function xmlEsc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function expandField(field, min, max) {
  if (field == null || field === '*' || field === '') return null;
  const set = new Set();
  for (const part of String(field).split(',')) {
    let step = 1, range = part;
    const slash = part.indexOf('/');
    if (slash >= 0) { step = parseInt(part.slice(slash + 1), 10) || 1; range = part.slice(0, slash); }
    let lo = min, hi = max;
    if (range !== '*' && range !== '') {
      const dash = range.indexOf('-');
      if (dash >= 0) { lo = parseInt(range.slice(0, dash), 10); hi = parseInt(range.slice(dash + 1), 10); }
      else { lo = hi = parseInt(range, 10); }
    }
    if (Number.isNaN(lo) || Number.isNaN(hi)) continue;
    for (let v = lo; v <= hi; v += step) if (v >= min && v <= max) set.add(v);
  }
  return set.size ? [...set].sort((a, b) => a - b) : null;
}
function cronToCalendar(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length < 5) return { ok: false, error: '只支持 5 段 cron 升格 launchd（不支持 @ 简写）' };
  const fs5 = [['Minute', expandField(parts[0], 0, 59)], ['Hour', expandField(parts[1], 0, 23)],
    ['Day', expandField(parts[2], 1, 31)], ['Month', expandField(parts[3], 1, 12)]];
  let dow = expandField(parts[4], 0, 7); if (dow) dow = [...new Set(dow.map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b);
  fs5.push(['Weekday', dow]);
  let prod = 1; for (const [, v] of fs5) prod *= v ? v.length : 1;
  if (prod > 366) return { ok: false, error: 'cron 太复杂，无法转 launchd' };
  let dicts = [{}];
  for (const [k, v] of fs5) { if (!v) continue; const n = []; for (const b of dicts) for (const x of v) n.push({ ...b, [k]: x }); dicts = n; }
  return { ok: true, intervals: dicts };
}
function calXml(intervals) {
  const dictXml = (d) => { const ks = Object.keys(d); return ks.length ? '    <dict>\n' + ks.map((k) => `      <key>${k}</key><integer>${d[k]}</integer>`).join('\n') + '\n    </dict>' : '    <dict/>'; };
  if (intervals.length === 1) {
    const ks = Object.keys(intervals[0]);
    if (!ks.length) return '  <key>StartInterval</key><integer>60</integer>';
    return '  <key>StartCalendarInterval</key>\n  <dict>\n' + ks.map((k) => `    <key>${k}</key><integer>${intervals[0][k]}</integer>`).join('\n') + '\n  </dict>';
  }
  return '  <key>StartCalendarInterval</key>\n  <array>\n' + intervals.map(dictXml).join('\n') + '\n  </array>';
}
function launchctl(args) {
  return new Promise((resolve) => {
    try { execFile('/bin/launchctl', args, { timeout: 10000 }, (e, so, se) => resolve({ ok: !e, stderr: String(se || '') })); }
    catch (e) { resolve({ ok: false, stderr: String(e && e.message || e) }); }
  });
}

async function offline(job, on) {
  if (!IS_MAC) return { ok: false, error: '睡眠补跑(launchd)仅 macOS 支持' };
  const label = job.label;
  const plist = path.join(AGENTS_DIR, `${label}.plist`);
  const txt = await readCrontab();
  if (on) {
    // 需要可执行脚本：优先用任务自带 scriptPath；否则把整条命令包成一个脚本。
    let script = job.scriptPath && fs.existsSync(job.scriptPath) ? job.scriptPath : null;
    const log = job.logPath || path.join(CRON_DIR, `${label}.log`);
    if (!script) {
      script = path.join(CRON_DIR, `${label}.sh`);
      try { await fsp.mkdir(CRON_DIR, { recursive: true }); await fsp.writeFile(script, `#!/bin/zsh -l\n${job.command}\n`, { mode: 0o755 }); await fsp.chmod(script, 0o755); }
      catch (e) { return { ok: false, error: `生成脚本失败：${String(e && e.message || e)}` }; }
    }
    const cal = cronToCalendar(job.schedule);
    if (!cal.ok) return { ok: false, error: cal.error };
    const plistXml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xmlEsc(label)}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/zsh</string><string>-l</string><string>${xmlEsc(script)}</string></array>
${calXml(cal.intervals)}
  <key>StandardOutPath</key><string>${xmlEsc(log)}</string>
  <key>StandardErrorPath</key><string>${xmlEsc(log)}</string>
  <key>RunAtLoad</key><false/>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
    try { await fsp.mkdir(AGENTS_DIR, { recursive: true }); await fsp.writeFile(plist, plistXml, 'utf8'); }
    catch (e) { return { ok: false, error: `写 LaunchAgent 失败：${String(e && e.message || e)}` }; }
    await launchctl(['unload', '-w', plist]);
    const r = await launchctl(['load', '-w', plist]);
    if (!r.ok) return { ok: false, error: `launchctl load 失败：${r.stderr}` };
    // 注释掉 crontab 行避免双触发。
    if (job.lineIndex >= 0) await writeCrontab(setJobDisabledInText(txt, job, true));
    registry[label] = { label, jobId: job.id, schedule: job.schedule, scriptPath: script, logPath: log, plist, createdAt: Date.now() };
    saveRegistry();
  } else {
    await launchctl(['unload', '-w', plist]);
    try { await fsp.unlink(plist); } catch { /* */ }
    delete registry[label];
    saveRegistry();
    // 恢复 crontab 行。
    if (job.lineIndex >= 0) await writeCrontab(setJobDisabledInText(txt, job, false));
  }
  broadcast({ type: 'tasks' });
  return { ok: true };
}

/* ---------------- IPC ---------------- */
function registerCron(ipcMain) {
  ensureDirs();

  ipcMain.handle('cron:list', async (_e, { cwd } = {}) => {
    const jobs = parseCrontab(await readCrontab());
    const harness = readHarness(cwd);
    return {
      ok: true,
      supported: HAS_CRONTAB,
      offlineSupported: IS_MAC,
      platform: process.platform,
      cronDir: CRON_DIR,
      jobs,
      harness,
    };
  });

  ipcMain.handle('cron:delete', async (_e, { id } = {}) => {
    const txt = await readCrontab();
    const job = parseCrontab(txt).find((j) => j.id === id);
    if (!job) return { ok: false, error: 'not found' };
    if (job.offline) await offline(job, false);          // 先卸 launchd
    const after = removeJobFromText(await readCrontab(), job);
    const r = await writeCrontab(after);
    if (!r.ok) return r;
    broadcast({ type: 'tasks' });
    return { ok: true };
  });

  ipcMain.handle('cron:offline', async (_e, { id, on } = {}) => {
    const job = parseCrontab(await readCrontab()).find((j) => j.id === id);
    if (!job) return { ok: false, error: 'not found' };
    return offline(job, !!on);
  });

  // 立即试跑：有脚本跑脚本，否则跑整条命令；登录 shell 取环境，输出经事件回推。
  ipcMain.handle('cron:runNow', async (_e, { id } = {}) => {
    const job = parseCrontab(await readCrontab()).find((j) => j.id === id);
    if (!job) return { ok: false, error: 'not found' };
    const cmd = (job.scriptPath && fs.existsSync(job.scriptPath)) ? `/bin/zsh -l ${JSON.stringify(job.scriptPath)}` : job.command;
    broadcast({ type: 'run', id, status: 'running' });
    return new Promise((resolve) => {
      execFile('/bin/zsh', ['-lc', cmd], { env: childEnv(), timeout: 120000, maxBuffer: 8 * 1024 * 1024, cwd: job.cwd || os.homedir() }, (err, so, se) => {
        const output = `${so || ''}${se ? `\n${se}` : ''}`.slice(0, 100000);
        broadcast({ type: 'run', id, status: err ? 'error' : 'success', output, error: err ? String(err.message || err) : null });
        resolve({ ok: !err, output, error: err ? String(err.message || err) : undefined });
      });
    });
  });

  ipcMain.handle('cron:openLog', (_e, { id } = {}) => {
    return readCrontab().then((txt) => {
      const job = parseCrontab(txt).find((j) => j.id === id);
      const log = job?.logPath || (registry[job?.label]?.logPath);
      if (!log) return { ok: false, error: '该任务没有可识别的日志文件' };
      try { shell.openPath(log); return { ok: true }; } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    });
  });

  // 读日志尾巴（在面板里直接看，不必开外部 app）。
  ipcMain.handle('cron:tailLog', async (_e, { id, lines = 40 } = {}) => {
    const job = parseCrontab(await readCrontab()).find((j) => j.id === id);
    const log = job?.logPath || (registry[job?.label]?.logPath);
    if (!log) return { ok: false, error: 'no log' };
    try {
      const txt = await fsp.readFile(log, 'utf8');
      const arr = txt.split('\n');
      return { ok: true, log, text: arr.slice(-lines).join('\n'), path: log };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  });

  // 打开归集目录（Finder）。
  ipcMain.handle('cron:openDir', () => { try { fs.mkdirSync(CRON_DIR, { recursive: true }); shell.openPath(CRON_DIR); return { ok: true }; } catch (e) { return { ok: false, error: String(e && e.message || e) }; } });
}

module.exports = { registerCron };
