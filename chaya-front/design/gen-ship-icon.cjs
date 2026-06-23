/* 上线图标专用：在 M6 Ink&Gold 基础上 ① 放大 ∞ 填满瓷砖(去内边距) ② 挤出侧壁做「厚度」体积感。
 * 复用 favicon Möbius 几何。产出 design/icon-ship.svg，渲染确认后再铺到 favicon/icon。 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../public/favicon.svg'), 'utf8');
// 注意：当前 public/favicon.svg 已是 M6（ig 前缀），其 url(#mobGlass) 不在了；改从 build/icon-source 取原始几何。
const geomSrc = fs.readFileSync(path.join(__dirname, 'favicon-m6.svg'), 'utf8').includes('mobGlass')
  ? fs.readFileSync(path.join(__dirname, 'favicon-m6.svg'), 'utf8') : null;
// 原始几何始终从未被覆盖的 drafts 里拿（favicon.svg 早期版本含 mobGlass）。这里直接内联从 git 原稿提取的四段。
const orig = fs.readFileSync(path.join(__dirname, 'logo-drafts.html'), 'utf8'); // 兜底
function pick(re, ...srcs){ for(const s of srcs){ if(!s) continue; const m=s.match(re); if(m) return m[1]; } return null; }

// 最稳妥：四段几何从原始 favicon 的备份提取。我们在 gen-mobius.cjs 已能拿到，这里复制其提取逻辑、读原始 favicon 历史。
// 但 favicon 现已被覆盖；改用 git 仍保存的原稿不可得 → 直接复用 gen-mobius 的来源文件路径（它读 public/favicon.svg）。
// 解决：gen-mobius 第一次运行时几何来自原 favicon；现在 favicon 是 M6（含 ig 前缀的 frontD/backD/rimD 仍在！）。
const F = src;
const backD  = pick(/<path d="([^"]+)"\s+fill="#000000" fill-opacity="0.7"/, F)            // M6 的 back 层
            || pick(/<path d="([^"]+)"\s+fill="#1c2430"/, F);
const frontD = pick(/<path d="([^"]+)"\s+fill="url\(#igg\)"/, F)
            || pick(/<path d="([^"]+)"\s+fill="url\(#mobGlass\)"/, F);
const rimD   = pick(/<path d="([^"]+)"\s+fill="none"\s+stroke="url\(#igrim\)"/, F)
            || pick(/<path d="([^"]+)"\s+fill="none"\s+stroke="url\(#mobRim\)"/, F);
const linesG = (F.match(/<g stroke="#e6bd6a"[\s\S]*?<\/g>/) || F.match(/<g stroke="#ffffff"[\s\S]*?<\/g>/) || F.match(/<g stroke="#fff0cf"[\s\S]*?<\/g>/))[0]
  .replace(/<g[^>]*>/, '').replace(/<\/g>/, '').trim();

if(!frontD || !backD || !rimD){ console.error('几何提取失败', {backD:!!backD,frontD:!!frontD,rimD:!!rimD}); process.exit(1); }

const g = '#e6bd6a';
// macOS Big Sur 图标栅格：圆角瓷砖 = 824/1024 ≈ 80.5%，四周留 ~9.77% 透明边（否则比邻居大一圈）。
const M = 64 * 0.0977;            // ≈6.25 边距
const TILE = 64 - 2 * M;          // ≈51.5 瓷砖边长
const RX = TILE * 0.2237;         // ≈11.5 连续圆角
// 几何质心 (34.05,30.70)。∞ 缩放到瓷砖内、留内边距(占瓷砖宽 ~78%)，居中到瓷砖中心(32,32)。
const S = (TILE * 0.78) / 46.19;  // 46.19 = ∞ 原始宽(57.15-10.96)
const T = `translate(32 32) scale(${S.toFixed(4)}) translate(-34.05 -30.70)`;

// 挤出侧壁：front 形状向下复制 N 份做厚度墙（深铜色，底部更暗）。
const EXT_STEPS = 8, EXT_DY = 0.42;
const extrude = Array.from({length: EXT_STEPS}, (_, i) => {
  const k = EXT_STEPS - i;                      // 最远(最底)先画
  return `<path d="${frontD}" fill="url(#shipWall)" fill-rule="nonzero" transform="translate(0 ${(k * EXT_DY).toFixed(2)})"/>`;
}).join('\n      ');

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Chaya icon — Ink&Gold Möbius: 放大填满 + 挤出厚度 + 暖金 rim/glow。 -->
<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" width="64" height="64">
  <defs>
    <radialGradient id="shipTile" cx="0.42" cy="0.34" r="0.85"><stop offset="0" stop-color="#211b18"/><stop offset="0.6" stop-color="#140f0d"/><stop offset="1" stop-color="#070605"/></radialGradient>
    <linearGradient id="shipG" x1="0" y1="0" x2="0.3" y2="1"><stop offset="0" stop-color="#5a5f6b"/><stop offset="0.5" stop-color="#33373f"/><stop offset="1" stop-color="#1a1d22"/></linearGradient>
    <linearGradient id="shipWall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4a3a1c"/><stop offset="0.5" stop-color="#2a2010"/><stop offset="1" stop-color="#120c05"/></linearGradient>
    <linearGradient id="shipRim" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="#fff0c8"/><stop offset="0.5" stop-color="${g}"/><stop offset="1" stop-color="#8a6a2e"/></linearGradient>
    <radialGradient id="shipSpec" cx="0.34" cy="0.26" r="0.5"><stop offset="0" stop-color="#fff3d6" stop-opacity="0.9"/><stop offset="1" stop-color="#fff3d6" stop-opacity="0"/></radialGradient>
    <radialGradient id="shipAmb" cx="0.5" cy="0.52" r="0.5"><stop offset="0" stop-color="${g}" stop-opacity="0.22"/><stop offset="1" stop-color="${g}" stop-opacity="0"/></radialGradient>
    <clipPath id="shipClip"><path d="${frontD}"/></clipPath>
    <filter id="shipSh" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="1.6"/></filter>
    <filter id="shipGl" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="2.6"/></filter>
  </defs>
  <rect x="${M.toFixed(2)}" y="${M.toFixed(2)}" width="${TILE.toFixed(2)}" height="${TILE.toFixed(2)}" rx="${RX.toFixed(2)}" fill="url(#shipTile)"/>
  <ellipse cx="32" cy="34" rx="${(TILE*0.42).toFixed(1)}" ry="${(TILE*0.25).toFixed(1)}" fill="url(#shipAmb)"/>
  <g transform="${T}">
    <path d="${frontD}" fill="#040206" fill-opacity="0.55" fill-rule="nonzero" transform="translate(0.4 ${(EXT_STEPS*EXT_DY+1.6).toFixed(2)})" filter="url(#shipSh)"/>
    <path d="${frontD}" fill="${g}" fill-opacity="0.4" fill-rule="nonzero" filter="url(#shipGl)"/>
      ${extrude}
    <path d="${frontD}" fill="url(#shipG)" fill-rule="nonzero"/>
    <g stroke="${g}" stroke-opacity="0.28" stroke-width="0.42" stroke-linecap="round">${linesG}</g>
    <path d="${rimD}" fill="none" stroke="url(#shipRim)" stroke-width="1.3" stroke-linecap="round"/>
    <g clip-path="url(#shipClip)"><ellipse cx="22" cy="21" rx="11" ry="7" fill="url(#shipSpec)" opacity="0.7"/></g>
  </g>
</svg>`;

fs.writeFileSync(path.join(__dirname, 'icon-ship.svg'), svg);
console.log('wrote design/icon-ship.svg  (scale', S, '+ extrude', EXT_STEPS, 'steps)');
