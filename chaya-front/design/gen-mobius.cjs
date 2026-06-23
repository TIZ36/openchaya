/* 从现有 favicon.svg 抽出 Möbius 几何（暗面/玻璃面/纹理线/高光描边），保留不动，
   只重做「层次 + 配色 + 局部色」生成多个精修变体到 logo-mobius.html。 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../public/favicon.svg'), 'utf8');

// 抽四块几何
const backD  = src.match(/<path d="([^"]+)"\s+fill="#1c2430"/)[1];
const frontD = src.match(/<path d="([^"]+)"\s+fill="url\(#mobGlass\)"/)[1];
const rimD   = src.match(/<path d="([^"]+)"\s+fill="none"\s+stroke="url\(#mobRim\)"/)[1];
const linesG = src.match(/<g stroke="#ffffff"[\s\S]*?<\/g>/)[0]
  .replace(/<g[^>]*>/, '').replace(/<\/g>/, '').trim();   // 只取 <line> 列表

// 变体：每个给 defs(命名空间化) + 分层渲染。p=前缀。
function svg(p, defs, layers) {
  return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
  <defs>${defs}</defs>
  ${layers}
</svg>`;
}
// 公共层片段构造器（按变体传色）
const L = {
  back: (fill, op = 1, dx = 0, dy = 0) => `<path d="${backD}" fill="${fill}" fill-opacity="${op}" fill-rule="nonzero" transform="translate(${dx} ${dy})"/>`,
  front: (fill, op = 1) => `<path d="${frontD}" fill="${fill}" fill-opacity="${op}" fill-rule="nonzero"/>`,
  lines: (stroke, op, w = 0.42) => `<g stroke="${stroke}" stroke-opacity="${op}" stroke-width="${w}" stroke-linecap="round">${linesG}</g>`,
  rim: (stroke, w = 0.85) => `<path d="${rimD}" fill="none" stroke="${stroke}" stroke-width="${w}" stroke-linecap="round"/>`,
  spec: (id, op = 0.5, cx = 22, cy = 21, rx = 10, ry = 5.5) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="url(#${id})" opacity="${op}"/>`,
};

// 颜色工具
function hx(h){h=h.replace('#','');return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)];}
function rgb(a){return '#'+a.map(x=>Math.round(Math.max(0,Math.min(255,x))).toString(16).padStart(2,'0')).join('');}
function mix(a,b,t=0.5){const pa=hx(a),pb=hx(b);return rgb(pa.map((v,i)=>v+(pb[i]-v)*t));}

// 「跃然纸上」公共底框 defs：径向瓷砖(中心微亮/四角压暗) + 环境辉光 + 接触投影模糊 + 可选外发光。
function popDefs(p, o = {}) {
  const { ambColor = '#cfe0ff', ambOp = 0.20, glow = null, tileMid = '#181a20', tileEdge = '#050506' } = o;
  return `
    <radialGradient id="${p}tile" cx="0.42" cy="0.34" r="0.82"><stop offset="0" stop-color="${tileMid}"/><stop offset="0.58" stop-color="${mix(tileMid, tileEdge, 0.6)}"/><stop offset="1" stop-color="${tileEdge}"/></radialGradient>
    <radialGradient id="${p}amb" cx="0.5" cy="0.52" r="0.5"><stop offset="0" stop-color="${ambColor}" stop-opacity="${ambOp}"/><stop offset="1" stop-color="${ambColor}" stop-opacity="0"/></radialGradient>
    <filter id="${p}sh" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="1.7"/></filter>
    ${glow ? `<filter id="${p}gl" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="2.4"/></filter>` : ''}`;
}
// 底框层栈：瓷砖 → 接触投影(向下偏移、模糊) → 环境辉光 →（可选）外发光。后续叠真正的带体。
function frame(p, o = {}) {
  const { glow = null } = o;
  return [
    `<rect width="64" height="64" rx="15" fill="url(#${p}tile)"/>`,
    `<path d="${frontD}" fill="#000000" fill-opacity="0.5" fill-rule="nonzero" transform="translate(0 2.6)" filter="url(#${p}sh)"/>`,
    `<ellipse cx="34" cy="40" rx="27" ry="15" fill="url(#${p}amb)"/>`,
    glow ? `<path d="${frontD}" fill="${glow}" fill-opacity="0.45" fill-rule="nonzero" filter="url(#${p}gl)"/>` : '',
  ].filter(Boolean).join('\n  ');
}

const VARIANTS = {};

// M1 · 层次强化：纯灰玻璃，但更亮更实 + 接触投影浮起 + 双层暗面厚度 + 更亮 rim。原案的「精致版」。
VARIANTS.depth = function (p) {
  const defs = popDefs(p, { ambColor: '#cfe0ff', ambOp: 0.22, tileMid: '#1b1d24' }) + `
    <linearGradient id="${p}g" x1="0" y1="0" x2="0.34" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="1"/>
      <stop offset="0.34" stop-color="#eef3f9" stop-opacity="0.94"/>
      <stop offset="0.62" stop-color="#ccd7e4" stop-opacity="0.8"/>
      <stop offset="0.85" stop-color="#9eafc4" stop-opacity="0.62"/>
      <stop offset="1" stop-color="#74849a" stop-opacity="0.5"/>
    </linearGradient>
    <linearGradient id="${p}rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="1"/><stop offset="1" stop-color="#fff" stop-opacity="0.32"/></linearGradient>
    <radialGradient id="${p}spec" cx="0.34" cy="0.26" r="0.55"><stop offset="0" stop-color="#fff" stop-opacity="0.95"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>`;
  return svg(p, defs, [
    frame(p),
    L.back('#070b12', 0.95, 0.7, 1.0),   // 更暗 + 更大偏移 → 厚度更立体
    L.back('#1c2430', 0.45),
    L.front(`url(#${p}g)`),
    L.lines('#ffffff', 0.2),
    L.rim(`url(#${p}rim)`, 1.0),
    L.spec(`${p}spec`, 0.6),
  ].join('\n  '));
};

// M2 · 局部彩·沿带流转：玻璃沿横轴流转 冷→accent→暖 + accent 外发光。两叶不同调，扭结处过渡。
VARIANTS.twist = function (p, a) {
  const defs = popDefs(p, { ambColor: a, ambOp: 0.3, glow: a, tileMid: '#181a20' }) + `
    <linearGradient id="${p}g" x1="0" y1="0.1" x2="1" y2="0.9">
      <stop offset="0" stop-color="#eaf1ff" stop-opacity="1"/>
      <stop offset="0.42" stop-color="${a}" stop-opacity="0.85"/>
      <stop offset="0.7" stop-color="${a}" stop-opacity="0.75"/>
      <stop offset="1" stop-color="#ffe2c8" stop-opacity="0.9"/>
    </linearGradient>
    <linearGradient id="${p}rim" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="0.5" stop-color="${a}"/><stop offset="1" stop-color="#fff" stop-opacity="0.6"/></linearGradient>
    <radialGradient id="${p}spec" cx="0.34" cy="0.26" r="0.55"><stop offset="0" stop-color="#fff" stop-opacity="0.9"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>`;
  return svg(p, defs, [
    frame(p, { glow: a }),
    L.back('#0a0e16', 0.95, 0.6, 0.9),
    L.front(`url(#${p}g)`),
    L.lines('#ffffff', 0.18),
    L.rim(`url(#${p}rim)`, 1.1),
    L.spec(`${p}spec`, 0.55),
  ].join('\n  '));
};

// M3 · 双调：暗面染深 accent、正面冷白；扭结处暗面外露 → 几何自带的局部色。
VARIANTS.duo = function (p, a) {
  const defs = popDefs(p, { ambColor: a, ambOp: 0.24, tileMid: '#181a20' }) + `
    <linearGradient id="${p}g" x1="0" y1="0" x2="0.3" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="1"/>
      <stop offset="0.5" stop-color="#dbe6f2" stop-opacity="0.86"/>
      <stop offset="1" stop-color="#a6b6c8" stop-opacity="0.6"/>
    </linearGradient>
    <linearGradient id="${p}back" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}" stop-opacity="1"/><stop offset="1" stop-color="${a}" stop-opacity="0.6"/></linearGradient>
    <linearGradient id="${p}rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0.32"/></linearGradient>
    <radialGradient id="${p}spec" cx="0.34" cy="0.26" r="0.55"><stop offset="0" stop-color="#fff" stop-opacity="0.95"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>`;
  return svg(p, defs, [
    frame(p),
    `<path d="${backD}" fill="url(#${p}back)" fill-rule="nonzero" transform="translate(0.8 1.0)"/>`,
    L.front(`url(#${p}g)`),
    L.lines('#ffffff', 0.2),
    L.rim(`url(#${p}rim)`, 1.0),
    L.spec(`${p}spec`, 0.6),
  ].join('\n  '));
};

// M4 · 整体染色：整条玻璃偏 accent + 彩色外发光 + 彩色内核辉光。最直接的品牌色版。
VARIANTS.tint = function (p, a) {
  const defs = popDefs(p, { ambColor: a, ambOp: 0.34, glow: a, tileMid: '#171a20' }) + `
    <linearGradient id="${p}g" x1="0" y1="0" x2="0.34" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="1"/>
      <stop offset="0.42" stop-color="${a}" stop-opacity="0.78"/>
      <stop offset="1" stop-color="${a}" stop-opacity="0.5"/>
    </linearGradient>
    <linearGradient id="${p}rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="${a}" stop-opacity="0.7"/></linearGradient>
    <radialGradient id="${p}spec" cx="0.34" cy="0.26" r="0.55"><stop offset="0" stop-color="#fff" stop-opacity="0.9"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>`;
  return svg(p, defs, [
    frame(p, { glow: a }),
    L.back('#0a0e16', 0.95, 0.6, 0.9),
    L.front(`url(#${p}g)`),
    L.lines('#ffffff', 0.18),
    L.rim(`url(#${p}rim)`, 1.0),
    L.spec(`${p}spec`, 0.55),
  ].join('\n  '));
};

// M5 · 极光：蓝→绿→紫 全息玻璃 + 彩色外发光。最 premium。
VARIANTS.aurora = function (p) {
  const defs = popDefs(p, { ambColor: '#5bc8ff', ambOp: 0.3, glow: '#6aa0ff', tileMid: '#0c1018', tileEdge: '#04060b' }) + `
    <linearGradient id="${p}g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#8fd0ff" stop-opacity="1"/>
      <stop offset="0.4" stop-color="#5b8cff" stop-opacity="0.82"/>
      <stop offset="0.7" stop-color="#4fd6a0" stop-opacity="0.78"/>
      <stop offset="1" stop-color="#b06cf0" stop-opacity="0.9"/>
    </linearGradient>
    <linearGradient id="${p}rim" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#dff0ff"/><stop offset="0.6" stop-color="#8af0c8"/><stop offset="1" stop-color="#e2c8ff"/></linearGradient>
    <radialGradient id="${p}spec" cx="0.34" cy="0.26" r="0.55"><stop offset="0" stop-color="#fff" stop-opacity="0.9"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>`;
  return svg(p, defs, [
    frame(p, { glow: '#6aa0ff' }),
    L.back('#081020', 0.95, 0.5, 0.8),
    L.front(`url(#${p}g)`),
    L.lines('#ffffff', 0.18),
    L.rim(`url(#${p}rim)`, 1.1),
    L.spec(`${p}spec`, 0.6),
  ].join('\n  '));
};

// M6 · 墨金：近黑实心玻璃 + 暖金 rim/高光 + 金色外发光halo。极简彩，最「高级感」。
VARIANTS.inkgold = function (p) {
  const g = '#e6bd6a';
  const defs = popDefs(p, { ambColor: g, ambOp: 0.2, glow: g, tileMid: '#191613', tileEdge: '#070605' }) + `
    <linearGradient id="${p}g" x1="0" y1="0" x2="0.3" y2="1">
      <stop offset="0" stop-color="#4a4f59"/>
      <stop offset="0.5" stop-color="#2a2e36"/>
      <stop offset="1" stop-color="#15181d"/>
    </linearGradient>
    <linearGradient id="${p}rim" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="#fff0c8"/><stop offset="0.5" stop-color="${g}"/><stop offset="1" stop-color="#8a6a2e"/></linearGradient>
    <radialGradient id="${p}spec" cx="0.34" cy="0.26" r="0.5"><stop offset="0" stop-color="#fff3d6" stop-opacity="0.9"/><stop offset="1" stop-color="#fff3d6" stop-opacity="0"/></radialGradient>`;
  return svg(p, defs, [
    frame(p, { glow: g }),
    L.back('#000000', 0.7, 0.7, 1.1),
    L.front(`url(#${p}g)`),
    L.lines(g, 0.28),
    L.rim(`url(#${p}rim)`, 1.2),
    L.spec(`${p}spec`, 0.7),
  ].join('\n  '));
};

const CARDS = [
  ['depth', 'depth', 'M1 · Depth 层次', '纯灰玻璃，但加环境光 + 双层暗面偏移做厚度 + 5 段更润渐变 + 更亮 rim。原案的「干净精致版」，最稳。'],
  ['twist', 'twist', 'M2 · Twist 沿带流转', '玻璃沿带轴 冷→accent→暖 流转，两叶不同调、扭结处过渡。最能体现「局部颜色」。', true],
  ['duo', 'duo', 'M3 · Duotone 双调', '暗面染深 accent、正面冷白；扭结处暗面外露，色彩来自几何本身。', true],
  ['tint', 'tint', 'M4 · Tint 整体染色', '整条玻璃偏 accent + 彩色内核辉光。最直接的品牌色版。', true],
  ['aurora', 'aurora', 'M5 · Aurora 极光', '蓝→绿→紫 全息玻璃 + 彩色环境光。最 premium、最抓眼。'],
  ['inkgold', 'inkgold', 'M6 · Ink&Gold 墨金', '近黑玻璃 + 单一暖金 rim/高光，极简彩。最「高级感」、最克制。'],
];

let html = `<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Möbius — 精修</title>
<style>
:root{--bg:#0c0d10;--line:#23262e;--ink:#e9ecf1;--mut:#8b93a1;--accent:#5b8cff;}
*{box-sizing:border-box} body{margin:0;background:radial-gradient(900px 500px at 80% -10%,#1b2230 0%,transparent 60%),var(--bg);color:var(--ink);font:15px/1.6 -apple-system,"SF Pro Text",system-ui,sans-serif;-webkit-font-smoothing:antialiased;padding:56px 40px 120px}
header{max-width:1180px;margin:0 auto 36px} h1{font-size:28px;letter-spacing:-.02em;margin:0 0 8px;font-weight:680} .lede{color:var(--mut);max-width:760px;margin:0}
.controls{display:flex;gap:10px;align-items:center;margin-top:22px;flex-wrap:wrap} .controls label{color:var(--mut);font-size:13px;margin-right:4px}
.sw{width:24px;height:24px;border-radius:50%;border:2px solid transparent;cursor:pointer;transition:.15s} .sw[aria-pressed="true"]{border-color:#fff;transform:scale(1.1)}
.grid{max-width:1180px;margin:0 auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:22px}
.card{background:linear-gradient(180deg,#17191f,#121317);border:1px solid var(--line);border-radius:18px;padding:22px;display:flex;flex-direction:column;gap:16px}
.row{display:flex;gap:16px;align-items:center}
.tile{width:104px;height:104px;flex:0 0 auto;border-radius:24px;overflow:hidden;box-shadow:0 10px 26px rgba(0,0,0,.5)}
.scales{display:flex;gap:12px;align-items:flex-end}
.scell{display:flex;flex-direction:column;align-items:center;gap:5px} .scell .lab{font-size:10px;color:var(--mut)}
.sq{border-radius:8px;overflow:hidden}
.meta{border-top:1px solid var(--line);padding-top:14px} .meta .code{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);font-weight:700} .meta .nm{font-size:17px;font-weight:640;margin:2px 0 4px} .meta .desc{color:var(--mut);font-size:13px;margin:0}
.note{max-width:1180px;margin:42px auto 0;color:var(--mut);font-size:13px;border-top:1px solid var(--line);padding-top:18px} code{background:#0a0a0c;padding:1px 6px;border-radius:6px;color:#cdd5e0}
</style></head><body>
<header><h1>Möbius — 六个精修方向</h1>
<p class="lede">沿用原 Möbius 几何不动，重做层次（环境光 / 双层暗面厚度 / 更润渐变）、配色与局部色。带 accent 的几款顶部可换色实时预览。每张给 104 / 40 / 22px 三档缩放验证。</p>
<div class="controls"><label>Accent（影响 M2/M3/M4）</label>
<button class="sw" data-c="#5b8cff" style="background:#5b8cff" aria-pressed="true"></button>
<button class="sw" data-c="#d97757" style="background:#d97757"></button>
<button class="sw" data-c="#4fb286" style="background:#4fb286"></button>
<button class="sw" data-c="#c7a14a" style="background:#c7a14a"></button>
<button class="sw" data-c="#b06cf0" style="background:#b06cf0"></button>
</div></header>
<main class="grid" id="grid"></main>
<p class="note">挑中后告诉我代号（+accent 颜色），我把它写回 <code>public/favicon.svg</code> + <code>build/icon-source.svg</code> 并跑 <code>build/gen-icon.sh</code> 生成 .icns/.png 全套。</p>
<script>
const A_VARIANTS=${JSON.stringify(Object.fromEntries(CARDS.filter(c=>c[4]).map(c=>[c[0],true])))};
const CARDS=${JSON.stringify(CARDS)};
// 预渲染：无 accent 的固定；有 accent 的存模板，运行时替换颜色占位。
const FIXED=${JSON.stringify({
  depth: VARIANTS.depth('d_'),
  aurora: VARIANTS.aurora('a_'),
  inkgold: VARIANTS.inkgold('i_'),
})};
// accent 变体：用占位符 __A__ 生成，运行时 replace。
const TPL=${JSON.stringify({
  twist: VARIANTS.twist('t_', '__A__'),
  duo: VARIANTS.duo('u_', '__A__'),
  tint: VARIANTS.tint('n_', '__A__'),
})};
let accent='#5b8cff';
function markup(key){ if(FIXED[key]) return FIXED[key]; return TPL[key].split('__A__').join(accent); }
function render(){
  document.getElementById('grid').innerHTML=CARDS.map(([key,_,nm,desc])=>{
    const m=markup(key);
    return '<div class="card"><div class="row">'+
      '<div class="tile">'+m+'</div>'+
      '<div class="scales">'+
        '<div class="scell"><div class="sq" style="width:40px;height:40px;border-radius:9px">'+m+'</div><span class="lab">40</span></div>'+
        '<div class="scell"><div class="sq" style="width:22px;height:22px;border-radius:5px">'+m+'</div><span class="lab">22</span></div>'+
      '</div></div>'+
      '<div class="meta"><div class="code">'+key+'</div><div class="nm">'+nm+'</div><p class="desc">'+desc+'</p></div></div>';
  }).join('');
}
document.querySelectorAll('.sw').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.sw').forEach(x=>x.setAttribute('aria-pressed','false'));b.setAttribute('aria-pressed','true');accent=b.dataset.c;render();}));
render();
</script></body></html>`;

fs.writeFileSync(path.join(__dirname, 'logo-mobius.html'), html);

// 落地：把选定的 M6 Ink&Gold 导出成可上线独立 SVG（64×64 + xml 声明）。
const ship = '<?xml version="1.0" encoding="UTF-8"?>\n<!-- Chaya icon — Ink&Gold Möbius (deep glass band + warm-gold rim + gold glow). -->\n'
  + VARIANTS.inkgold('ig').replace('width="100%" height="100%"', 'width="64" height="64"');
fs.writeFileSync(path.join(__dirname, 'favicon-m6.svg'), ship);
console.log('wrote logo-mobius.html + favicon-m6.svg  (M6 Ink&Gold ready to ship)');
