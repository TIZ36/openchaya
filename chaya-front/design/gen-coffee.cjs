/* 咖啡 + Möbius 方案探索。复用现有金 ∞ 几何（favicon-m6.svg），底色换浓缩咖啡棕，
 * Möbius 用作 ① 杯面拉花 ② 升腾的热气 ③ 咖啡豆中缝。遵 macOS 栅格(瓷砖内缩~10%)。
 * 产出 design/logo-coffee.html 预览 + design/icon-coffee-*.svg 候选。 */
const fs = require('fs');
const path = require('path');

const m6 = fs.readFileSync(path.join(__dirname, 'favicon-m6.svg'), 'utf8');
const frontD = m6.match(/<path d="([^"]+)"\s+fill="url\(#igg\)"/)[1];
const rimD   = m6.match(/<path d="([^"]+)"\s+fill="none"\s+stroke="url\(#igrim\)"/)[1];

// macOS 栅格
const M = 64 * 0.0977, TILE = 64 - 2 * M, RX = TILE * 0.2237;
const tileRect = (id) => `<rect x="${M.toFixed(2)}" y="${M.toFixed(2)}" width="${TILE.toFixed(2)}" height="${TILE.toFixed(2)}" rx="${RX.toFixed(2)}" fill="url(#${id})"/>`;
// Möbius 质心(34.05,30.70) 宽46.19 → 缩放居中到 (cx,cy)
const mob = (s, cx, cy) => `translate(${cx} ${cy}) scale(${s.toFixed(4)}) translate(-34.05 -30.70)`;

const wrap = (defs, body) => `<?xml version="1.0" encoding="UTF-8"?>
<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" width="64" height="64">
  <defs>${defs}</defs>
  ${body}
</svg>`;

const COFFEE = {  // 共用咖啡色板
  gold: '#d8a35a', cream: '#f3e4c4', creamHi: '#fff7e6',
};

// ── C1 · Latte 拿铁：俯视杯口(金环) + 浓缩咖啡面 + Möbius 奶泡拉花 ──
function C_latte(p) {
  const defs = `
    <radialGradient id="${p}tile" cx="0.42" cy="0.34" r="0.85"><stop offset="0" stop-color="#3a2415"/><stop offset="0.6" stop-color="#1f130a"/><stop offset="1" stop-color="#0c0704"/></radialGradient>
    <radialGradient id="${p}coffee" cx="0.42" cy="0.34" r="0.62"><stop offset="0" stop-color="#6b4222"/><stop offset="0.55" stop-color="#3e2613"/><stop offset="1" stop-color="#23150a"/></radialGradient>
    <linearGradient id="${p}rim" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="#fff0c8"/><stop offset="0.5" stop-color="#d8a35a"/><stop offset="1" stop-color="#7a5320"/></linearGradient>
    <linearGradient id="${p}cream" x1="0" y1="0" x2="0.3" y2="1"><stop offset="0" stop-color="#fff7e6"/><stop offset="0.6" stop-color="#f0dcae"/><stop offset="1" stop-color="#cdaf7e"/></linearGradient>
    <filter id="${p}sh" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="1.1"/></filter>`;
  const body = `
  ${tileRect(p + 'tile')}
  <circle cx="32" cy="32" r="21.5" fill="none" stroke="url(#${p}rim)" stroke-width="2.4"/>
  <circle cx="32" cy="32" r="18.6" fill="url(#${p}coffee)"/>
  <ellipse cx="26" cy="25" rx="8" ry="4.5" fill="#fff" opacity="0.06"/>
  <g transform="${mob(0.6, 32, 32)}">
    <path d="${frontD}" fill="#1a0d05" fill-opacity="0.5" transform="translate(0 1.8)" filter="url(#${p}sh)"/>
    <path d="${frontD}" fill="url(#${p}cream)" fill-rule="nonzero"/>
    <path d="${rimD}" fill="none" stroke="#fff7e6" stroke-width="1.0" stroke-linecap="round" opacity="0.7"/>
  </g>`;
  return wrap(defs, body);
}

// ── C2 · Steam 氤氲：底部咖啡杯(侧视,金描边) + 升腾的 Möbius 热气 ──
function C_steam(p) {
  const defs = `
    <radialGradient id="${p}tile" cx="0.42" cy="0.34" r="0.85"><stop offset="0" stop-color="#34210f"/><stop offset="0.6" stop-color="#1c1207"/><stop offset="1" stop-color="#0a0603"/></radialGradient>
    <linearGradient id="${p}rim" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="#fff0c8"/><stop offset="0.5" stop-color="#d8a35a"/><stop offset="1" stop-color="#7a5320"/></linearGradient>
    <linearGradient id="${p}cup" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4a3018"/><stop offset="1" stop-color="#24160a"/></linearGradient>`;
  // 杯体：上宽下窄；杯口椭圆；右侧把手；底碟。Möbius 作热气浮在杯口上方。
  const body = `
  ${tileRect(p + 'tile')}
  <g transform="${mob(0.46, 32, 24)}" opacity="0.95">
    <path d="${rimD}" fill="none" stroke="url(#${p}rim)" stroke-width="1.6" stroke-linecap="round"/>
  </g>
  <path d="M20 38 L44 38 L41.5 51 Q41 53.5 38.5 53.5 L25.5 53.5 Q23 53.5 22.5 51 Z" fill="url(#${p}cup)" stroke="url(#${p}rim)" stroke-width="1.8" stroke-linejoin="round"/>
  <ellipse cx="32" cy="38" rx="12" ry="2.6" fill="#1a0d05" stroke="url(#${p}rim)" stroke-width="1.6"/>
  <path d="M44 40 Q50 41 49 45 Q48 48.5 43.5 48" fill="none" stroke="url(#${p}rim)" stroke-width="1.8" stroke-linecap="round"/>
  <line x1="20" y1="55.5" x2="44" y2="55.5" stroke="url(#${p}rim)" stroke-width="1.8" stroke-linecap="round"/>`;
  return wrap(defs, body);
}

// ── C3 · Bean 咖啡豆：豆形(金描边,咖啡填充) + 中缝用 Möbius ∞ ──
function C_bean(p) {
  const defs = `
    <radialGradient id="${p}tile" cx="0.42" cy="0.34" r="0.85"><stop offset="0" stop-color="#37230f"/><stop offset="0.6" stop-color="#1d1207"/><stop offset="1" stop-color="#0a0603"/></radialGradient>
    <linearGradient id="${p}bean" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="#6e4422"/><stop offset="0.6" stop-color="#4a2c14"/><stop offset="1" stop-color="#2a190b"/></linearGradient>
    <linearGradient id="${p}rim" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="#fff0c8"/><stop offset="0.5" stop-color="#d8a35a"/><stop offset="1" stop-color="#7a5320"/></linearGradient>`;
  // 豆：竖向椭圆稍倾斜；中缝=横向 Möbius ∞（金）
  const body = `
  ${tileRect(p + 'tile')}
  <g transform="rotate(-18 32 32)">
    <ellipse cx="32" cy="32" rx="13.5" ry="19" fill="url(#${p}bean)" stroke="url(#${p}rim)" stroke-width="1.8"/>
  </g>
  <g transform="${mob(0.42, 32, 32)}">
    <path d="${rimD}" fill="none" stroke="url(#${p}rim)" stroke-width="2.0" stroke-linecap="round"/>
  </g>`;
  return wrap(defs, body);
}

const VARIANTS = [
  ['latte', 'A · Latte 拿铁', C_latte('la'), '俯视一杯浓缩，杯口金环，杯面用 Möbius 做奶泡拉花。最直给、最贴「咖啡馆闲谈」，复用金 ∞ 几何。推荐。'],
  ['steam', 'B · Steam 氤氲', C_steam('st'), '侧视咖啡杯（金描边）+ 升腾的 Möbius 热气。叙事感强，但元素多、小尺寸偏挤。'],
  ['bean',  'C · Bean 咖啡豆', C_bean('bn'),  '咖啡豆造型，中缝换成 Möbius ∞。最简洁的符号化，但「咖啡」识别度依赖豆形。'],
];

VARIANTS.forEach(([k, , svg]) => fs.writeFileSync(path.join(__dirname, `icon-coffee-${k}.svg`), svg));

const html = `<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Coffee + Möbius</title>
<style>:root{--bg:#0c0d10;--line:#23262e;--ink:#e9ecf1;--mut:#8b93a1}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 -apple-system,system-ui,sans-serif;-webkit-font-smoothing:antialiased;padding:56px 40px 120px}
header{max-width:1080px;margin:0 auto 36px}h1{font-size:28px;letter-spacing:-.02em;margin:0 0 8px;font-weight:680}.lede{color:var(--mut);max-width:740px;margin:0}
.grid{max-width:1080px;margin:0 auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:24px}
.card{background:linear-gradient(180deg,#17191f,#121317);border:1px solid var(--line);border-radius:18px;padding:24px;display:flex;flex-direction:column;gap:18px}
.hero{display:flex;gap:20px;align-items:center}.tile{width:120px;height:120px;flex:0 0 auto}.tile svg{width:100%;height:100%;filter:drop-shadow(0 10px 24px rgba(0,0,0,.5))}
.scales{display:flex;gap:14px;align-items:flex-end}.sc{display:flex;flex-direction:column;align-items:center;gap:6px}.sc .l{font-size:10px;color:var(--mut)}.sc svg{display:block}
.dock{display:flex;align-items:center;gap:10px;background:linear-gradient(#2b7fd6,#1e6fc4);border-radius:14px;padding:10px 12px}.dock svg{width:44px;height:44px}.dock .ph{width:40px;height:40px;border-radius:10px;background:#0006}
.meta{border-top:1px solid var(--line);padding-top:14px}.meta .nm{font-size:17px;font-weight:640;margin:0 0 4px}.meta .desc{color:var(--mut);font-size:13px;margin:0}
.note{max-width:1080px;margin:42px auto 0;color:var(--mut);font-size:13px;border-top:1px solid var(--line);padding-top:18px}code{background:#0a0a0c;padding:1px 6px;border-radius:6px;color:#cdd5e0}</style></head><body>
<header><h1>Coffee + Möbius — 方案</h1><p class="lede">复用金 ∞ 几何，底色浓缩咖啡棕，遵 macOS 栅格（瓷砖内缩 ~10%，与系统图标同尺寸）。每张含 48/32/16 缩放 + 蓝 dock 语境对比。</p></header>
<main class="grid">
${VARIANTS.map(([k, nm, svg, desc]) => `<div class="card">
  <div class="hero"><div class="tile">${svg}</div>
    <div class="scales">
      <div class="sc">${svg.replace('width="64" height="64"','width="48" height="48"')}<div class="l">48</div></div>
      <div class="sc">${svg.replace('width="64" height="64"','width="32" height="32"')}<div class="l">32</div></div>
      <div class="sc">${svg.replace('width="64" height="64"','width="16" height="16"')}<div class="l">16</div></div>
    </div>
  </div>
  <div class="dock"><div class="ph"></div>${svg.replace('width="64" height="64"','width="44" height="44"')}<div class="ph"></div></div>
  <div class="meta"><div class="nm">${nm}</div><p class="desc">${desc}</p></div>
</div>`).join('')}
</main>
<p class="note">候选已落盘 <code>design/icon-coffee-{latte,steam,bean}.svg</code>。选定后我铺到 favicon/icon 全套并重建 .icns。</p>
</body></html>`;
fs.writeFileSync(path.join(__dirname, 'logo-coffee.html'), html);
console.log('wrote logo-coffee.html + icon-coffee-{latte,steam,bean}.svg');
