/* 竖向非对称 Möbius：下叶大=咖啡杯，上叶小=升腾热流，一笔交叉成形。
 * 用伯努利双纽线参数化采样，下/上叶分别缩放得到「下大上小」。咖啡棕底 + 金色缎带笔触。
 * 产出 design/logo-cupflow.html + design/icon-cupflow-*.svg */
const fs = require('fs');
const path = require('path');

// 竖向双纽线采样：t∈[0,2π)。下叶(cos t>0,y>cy)乘 Rlo，上叶乘 Rhi → 下大上小。交叉点在中心(半径→0,连续)。
function lemniscate({ cx = 32, cy = 33, s = 16, Rlo = 1.28, Rhi = 0.66, Hhi = null, Vhi = null, N = 160 }) {
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * 2 * Math.PI;
    const d = 1 + Math.sin(t) ** 2;
    const x = (Math.sin(t) * Math.cos(t)) / d;   // 横向分量
    const y = (Math.cos(t)) / d;                  // 纵向分量
    const lo = Math.cos(t) > 0;                   // 下叶?
    const kx = lo ? Rlo : (Hhi ?? Rhi);           // 上叶可分别给横/纵缩放(做火苗尖瓣)
    const ky = lo ? Rlo : (Vhi ?? Rhi);
    pts.push([cx + s * x * kx, cy + s * y * ky]);
  }
  return pts;
}
// 采样点 → 平滑 path（Catmull-Rom 转三次贝塞尔）
function smooth(pts, close = true) {
  const p = pts.slice();
  let d = `M${p[0][0].toFixed(2)} ${p[0][1].toFixed(2)}`;
  const n = p.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = p[(i - 1 + n) % n], p1 = p[i], p2 = p[i + 1], p3 = p[(i + 2) % n];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C${c1x.toFixed(2)} ${c1y.toFixed(2)} ${c2x.toFixed(2)} ${c2y.toFixed(2)} ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
  }
  return d + (close ? 'Z' : '');
}

const M = 64 * 0.0977, TILE = 64 - 2 * M, RX = TILE * 0.2237;
const tile = (id) => `<rect x="${M.toFixed(2)}" y="${M.toFixed(2)}" width="${TILE.toFixed(2)}" height="${TILE.toFixed(2)}" rx="${RX.toFixed(2)}" fill="url(#${id})"/>`;

const DEFS = (p) => `
  <radialGradient id="${p}tile" cx="0.42" cy="0.34" r="0.85"><stop offset="0" stop-color="#3a2415"/><stop offset="0.6" stop-color="#1f130a"/><stop offset="1" stop-color="#0c0704"/></radialGradient>
  <linearGradient id="${p}gold" x1="0" y1="0" x2="0.25" y2="1"><stop offset="0" stop-color="#fff2cf"/><stop offset="0.45" stop-color="#e6bd6a"/><stop offset="1" stop-color="#8a6a2e"/></linearGradient>
  <radialGradient id="${p}amb" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#e6bd6a" stop-opacity="0.22"/><stop offset="1" stop-color="#e6bd6a" stop-opacity="0"/></radialGradient>
  <filter id="${p}sh" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="1.0"/></filter>
  <filter id="${p}gl" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="2.0"/></filter>`;

const wrap = (defs, body) => `<?xml version="1.0" encoding="UTF-8"?>
<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" width="64" height="64">
  <defs>${defs}</defs>
  ${body}
</svg>`;

// 缎带笔触：阴影 + 金色发光 + 主体（圆头）
function ribbon(p, d, w) {
  return `
  <path d="${d}" fill="none" stroke="#1a0d05" stroke-opacity="0.5" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" transform="translate(0 1.4)" filter="url(#${p}sh)"/>
  <path d="${d}" fill="none" stroke="#e6bd6a" stroke-opacity="0.35" stroke-width="${w + 2}" stroke-linecap="round" stroke-linejoin="round" filter="url(#${p}gl)"/>
  <path d="${d}" fill="none" stroke="url(#${p}gold)" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

// A · 纯竖向非对称 ∞（下大=杯 / 上小=热流），金缎带一笔
function A(p) {
  const d = smooth(lemniscate({ Rlo: 1.3, Rhi: 0.64 }));
  return wrap(DEFS(p), `${tile(p + 'tile')}\n  <ellipse cx="32" cy="34" rx="20" ry="20" fill="url(#${p}amb)"/>${ribbon(p, d, 3.2)}`);
}

// B · 下叶更圆胖像杯、上叶更小更尖像一缕热流；并把上叶尾端拉成开口卷须
function B(p) {
  const pts = lemniscate({ cx: 32, cy: 35, s: 15, Rlo: 1.42, Rhi: 0.6, N: 160 });
  const d = smooth(pts);
  // 额外热流卷须：从中心交叉处向上飘一缕
  const wisp = `M32 19 C30.5 15 34 13 33 9.5 C32.4 7.4 30.6 7 30 5.2`;
  return wrap(DEFS(p), `${tile(p + 'tile')}\n  <ellipse cx="32" cy="36" rx="20" ry="20" fill="url(#${p}amb)"/>${ribbon(p, d, 3.2)}
  <path d="${wisp}" fill="none" stroke="url(#${p}gold)" stroke-width="2" stroke-linecap="round" opacity="0.85"/>`);
}

// C · A + 杯底足线（更明确「杯」语义）
function C(p) {
  const d = smooth(lemniscate({ Rlo: 1.3, Rhi: 0.64 }));
  const base = `<path d="M24 50 Q32 53 40 50" fill="none" stroke="url(#${p}gold)" stroke-width="2.2" stroke-linecap="round" opacity="0.85"/>`;
  return wrap(DEFS(p), `${tile(p + 'tile')}\n  <ellipse cx="32" cy="34" rx="20" ry="20" fill="url(#${p}amb)"/>${ribbon(p, d, 3.2)}\n  ${base}`);
}

// D · 半 Möbius：下方闭环=杯(略收口于交叉点) + 上方开口卷须=热流(向上收细)
function D(p) {
  const cup = `M32 29 C24 29 18 34 18 40 C18 47 24 50.5 32 50.5 C40 50.5 46 47 46 40 C46 34 40 29 32 29 Z`;
  const steam = `M32 29 C36 24 27 21 31 15.5 C32.6 12.4 29.6 10.2 31.4 6`;
  return wrap(DEFS(p), `${tile(p + 'tile')}
  <ellipse cx="32" cy="38" rx="20" ry="20" fill="url(#${p}amb)"/>
  ${ribbon(p, cup, 3.2)}
  <path d="${steam}" fill="none" stroke="url(#${p}gold)" stroke-width="2.6" stroke-linecap="round"/>
  <path d="${steam}" fill="none" stroke="#1a0d05" stroke-opacity="0.4" stroke-width="2.6" stroke-linecap="round" transform="translate(0 1.2)" filter="url(#${p}sh)"/>`);
}

// E · 闭合但上叶拉成「火苗/热流」尖瓣(上窄高、下宽圆=杯)
function E(p) {
  const pts = lemniscate({ cx: 32, cy: 36, s: 15, Rlo: 1.4, Rhi: 0.62, Hhi: 0.5, Vhi: 1.5, N: 160 });
  const d = smooth(pts);
  return wrap(DEFS(p), `${tile(p + 'tile')}\n  <ellipse cx="32" cy="37" rx="20" ry="20" fill="url(#${p}amb)"/>${ribbon(p, d, 3.2)}`);
}

const VARIANTS = [
  ['d', 'D · 半 Möbius·杯+热流', D('d'), '下方闭环=杯(收口于交叉)，上方开口卷须向上收细=热流。最贴你描述：下杯上流。推荐。'],
  ['e', 'E · 火苗顶', E('e'), '闭合一笔，但上叶拉成又高又窄的尖瓣(像热流/火苗)，下叶宽圆像杯。'],
  ['a', 'A · 纯竖 ∞', A('a'), '下大上小的竖向 Möbius，全靠形态暗示，最克制(偏「8」)。'],
  ['b', 'B · 杯+飘须', B('b'), '圆胖下叶 + 分离的一缕飘须(飘须略散)。'],
  ['c', 'C · 带杯底', C('c'), 'A + 杯底足弧。'],
];
VARIANTS.forEach(([k, , svg]) => fs.writeFileSync(path.join(__dirname, `icon-cupflow-${k}.svg`), svg));

const html = `<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cup+Flow Möbius</title>
<style>:root{--bg:#0c0d10;--line:#23262e;--ink:#e9ecf1;--mut:#8b93a1}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 -apple-system,system-ui,sans-serif;-webkit-font-smoothing:antialiased;padding:56px 40px 120px}
header{max-width:1080px;margin:0 auto 36px}h1{font-size:28px;margin:0 0 8px;font-weight:680}.lede{color:var(--mut);max-width:740px;margin:0}
.grid{max-width:1080px;margin:0 auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:24px}
.card{background:linear-gradient(180deg,#17191f,#121317);border:1px solid var(--line);border-radius:18px;padding:24px;display:flex;flex-direction:column;gap:18px}
.hero{display:flex;gap:20px;align-items:center}.tile{width:120px;height:120px;flex:0 0 auto}.tile svg{width:100%;height:100%;filter:drop-shadow(0 10px 24px rgba(0,0,0,.5))}
.scales{display:flex;gap:14px;align-items:flex-end}.sc{display:flex;flex-direction:column;align-items:center;gap:6px}.sc .l{font-size:10px;color:var(--mut)}
.dock{display:flex;align-items:center;gap:10px;background:linear-gradient(#2b7fd6,#1e6fc4);border-radius:14px;padding:10px 12px}.dock .ph{width:40px;height:40px;border-radius:10px;background:#0006}
.meta{border-top:1px solid var(--line);padding-top:14px}.meta .nm{font-size:17px;font-weight:640;margin:0 0 4px}.meta .desc{color:var(--mut);font-size:13px;margin:0}
.note{max-width:1080px;margin:42px auto 0;color:var(--mut);font-size:13px;border-top:1px solid var(--line);padding-top:18px}code{background:#0a0a0c;padding:1px 6px;border-radius:6px;color:#cdd5e0}</style></head><body>
<header><h1>竖向 Möbius · 杯 + 热流</h1><p class="lede">下叶放大=咖啡杯，上叶缩小=升腾热流，交叉一笔成形。伯努利双纽线参数化、金缎带笔触、咖啡棕底，遵 macOS 栅格。每张含 48/32/16 + 蓝 dock。</p></header>
<main class="grid">
${VARIANTS.map(([k, nm, svg, desc]) => `<div class="card"><div class="hero"><div class="tile">${svg}</div>
<div class="scales">
<div class="sc">${svg.replace('width="64" height="64"','width="48" height="48"')}<div class="l">48</div></div>
<div class="sc">${svg.replace('width="64" height="64"','width="32" height="32"')}<div class="l">32</div></div>
<div class="sc">${svg.replace('width="64" height="64"','width="16" height="16"')}<div class="l">16</div></div></div></div>
<div class="dock"><div class="ph"></div>${svg.replace('width="64" height="64"','width="44" height="44"')}<div class="ph"></div></div>
<div class="meta"><div class="nm">${nm}</div><p class="desc">${desc}</p></div></div>`).join('')}
</main>
<p class="note">候选 <code>design/icon-cupflow-{a,b,c}.svg</code>。可调参数：Rlo/Rhi(上下叶大小)、s(整体)、cy(垂直位)、stroke 宽。选定后铺全套。</p>
</body></html>`;
fs.writeFileSync(path.join(__dirname, 'logo-cupflow.html'), html);
console.log('wrote logo-cupflow.html + icon-cupflow-{a,b,c}.svg');
