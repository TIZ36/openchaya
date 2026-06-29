#!/usr/bin/env node
/* ============================================================
   fbotRun —— 独立启动器（不经 Electron，调试/验证用）

   用法：
     FBOT_APP_ID=cli_xxx FBOT_APP_SECRET=xxx node electron/fbotRun.cjs

   它加载 fbot.cjs + fbotMenu.cjs，起长连接，@机器人即自动回菜单卡，
   点选项→表单→提交全链路走 fbotMenu 的业务逻辑。Ctrl+C 退出。

   正式上线走 Electron（registerFbot），这个只是脱壳验证。
   ============================================================ */
const fbot = require('./fbot.cjs');

const appId = process.env.FBOT_APP_ID;
const appSecret = process.env.FBOT_APP_SECRET;
if (!appId || !appSecret) {
  console.error('缺 FBOT_APP_ID / FBOT_APP_SECRET 环境变量');
  process.exit(1);
}

fbot.configure({ appId, appSecret });
(async () => {
  const r = await fbot.start();
  if (!r.ok) { console.error('启动失败:', r.error); process.exit(1); }
  console.log(`[fbotRun] 已上线 bot=${r.botName || appId}，@它试试。Ctrl+C 退出。`);
})();

process.on('SIGINT', async () => { await fbot.stop(); process.exit(0); });
process.on('SIGTERM', async () => { await fbot.stop(); process.exit(0); });
