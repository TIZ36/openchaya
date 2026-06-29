/* Ink&Gold 精修：复用 favicon Möbius 几何，重做成「金箔 ∞ 压入深紫墨瓷砖」的烫金印记。
 * 对齐品牌 brief（.impeccable.md）：墨=深紫黑(hue 310，非纯黑)、金=ochre marginalia(hue 75)；
 * 杀掉 neon glow（brief 明令），改用 图底对比 + 浮雕接触投影 取得「跃然纸上」；并做光学居中。
 * 产物：logo-inkgold.html(预览,含纸面印章语境+缩放) + design/favicon-inkgold-*.svg(候选,待确认上线)。 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../public/favicon.svg'), 'utf8');
const backD  = src.match(/<path d="([^"]+)"\s+fill="#1c2430"/)[1];
const frontD = src.match(/<path d="([^"]+)"\s+fill="url\(#mobGlass\)"/)[1];
const rimD   = src.match(/<path d="([^"]+)"\s+fill="none"\s+stroke="url\(#mobRim\)"/)[1];
const linesG = src.match(/<g stroke="#ffffff"[\s\S]*?<\/g>/)[0].replace(/<g[^>]*>/, '').replace(/<\/g>/, '').trim();

// 几何质心 (34.05, 30.70) → 平移到瓷砖中心 (32,32) 做光学居中。
const DX = -2.05, DY = 1.30;

// 三档金调。band=正面金箔渐变, back=底面暗铜(厚度), rim=边缘高光, tileMid/Edge=墨瓷砖径向。
const TONES = {
  gilt: {
    band: [['0', '#f6e6ad'], ['0.3', '#ddba6c'], ['0.6', '#c49a4c'], ['0.85', '#8f6c34'], ['1', '#5f4720']],
    rim:  [['0', '#fff7df'], ['0.45', '#ecca7e'], ['1', '#6e5021']],
    back: '#3a2912', tileMid: '#241b27', tileEdge: '#0a070c', spec: 0.52, sheen: 0.16,
  },
  deep: {  // 更含蓄、墨更进、金更沉
    band: [['0', '#e6d295'], ['0.3', '#c9a458'], ['0.6', '#a8843e'], ['0.85', '#6f5328'], ['1', '#46331a']],
    rim:  [['0', '#f7ecc8'], ['0.45', '#d7b266'], ['1', '#5c441f']],
    back: '#2c2010', tileMid: '#1d1620', tileEdge: '#08060a', spec: 0.42, sheen: 0.13,
  },
};

const stops = (arr) => arr.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('');

function build(p, tone, { bezel = false } = {}) {
  const t = TONES[tone];
  const defs = `
    <radialGradient id="${p}tile" cx="0.42" cy="0.36" r="0.85">
      <stop offset="0" stop-color="${t.tileMid}"/><stop offset="0.62" stop-color="${mix(t.tileMid, t.tileEdge, 0.6)}"/><stop offset="1" stop-color="${t.tileEdge}"/>
    </radialGradient>
    <linearGradient id="${p}band" x1="0" y1="0" x2="0.38" y2="1">${stops(t.band)}</linearGradient>
    <linearGradient id="${p}rim" x1="0" y1="0" x2="0.5" y2="1">${stops(t.rim)}</linearGradient>
    <radialGradient id="${p}spec" cx="0.34" cy="0.26" r="0.5"><stop offset="0" stop-color="#fff6e0" stop-opacity="0.95"/><stop offset="1" stop-color="#fff6e0" stop-opacity="0"/></radialGradient>
    <clipPath id="${p}clip"><path d="${frontD}"/></clipPath>
    <filter id="${p}sh" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="1.5"/></filter>
    ${bezel ? `<linearGradient id="${p}bz" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0.5"/><stop offset="1" stop-color="#e8c878" stop-opacity="0.22"/></linearGradient>` : ''}`;

  const mark = [
    // 浮雕接触投影：金箔为「凸起」，光自左上 → 影落右下。物理阴影，非 neon glow。
    `<path d="${frontD}" fill="#050307" fill-opacity="0.5" fill-rule="nonzero" transform="translate(0.6 2.4)" filter="url(#${p}sh)"/>`,
    `<path d="${backD}" fill="${t.back}" fill-rule="nonzero" transform="translate(0.7 1.1)"/>`,  // 底面暗铜=厚度
    `<path d="${frontD}" fill="url(#${p}band)" fill-rule="nonzero"/>`,                              // 金箔正面
    `<g stroke="#fff0cf" stroke-opacity="${t.sheen}" stroke-width="0.42" stroke-linecap="round">${linesG}</g>`, // 拉丝光泽
    `<path d="${rimD}" fill="none" stroke="url(#${p}rim)" stroke-width="1.1" stroke-linecap="round"/>`,           // 边缘烫金高光
    `<g clip-path="url(#${p}clip)"><ellipse cx="21" cy="20" rx="12" ry="7.5" fill="url(#${p}spec)" opacity="${t.spec}"/></g>`,  // 左上高光（裁剪到金箔内，不溢到瓷砖）
  ].join('\n    ');

  return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
  <defs>${defs}</defs>
  <rect width="64" height="64" rx="15" fill="url(#${p}tile)"/>
  ${bezel ? `<rect x="3.5" y="3.5" width="57" height="57" rx="12.5" fill="none" stroke="url(#${p}bz)" stroke-width="1"/>` : ''}
  <g transform="translate(${DX} ${DY})">
    ${mark}
  </g>
</svg>`;
}

// 颜色混合
function hx(h){h=h.replace('#','');return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)];}
function rgb(a){return '#'+a.map(x=>Math.round(Math.max(0,Math.min(255,x))).toString(16).padStart(2,'0')).join('');}
function mix(a,b,t=0.5){const pa=hx(a),pb=hx(b);return rgb(pa.map((v,i)=>v+(pb[i]-v)*t));}

const VARIANTS = [
  ['gilt',  'A · Gilt 烫金',   build('a', 'gilt'),               '金箔 ∞ 压入深紫墨瓷砖，浮雕浮起。明亮、热烈，silhouette 在小尺寸也立得住。推荐。'],
  ['deep',  'B · Deep 沉金',   build('b', 'deep'),               '墨更进、金更沉，更含蓄克制，偏「老金」质感。'],
  ['bezel', 'C · Bezel 压框',  build('c', 'gilt', { bezel: true }), 'Gilt + 一圈极细 letterpress 压凹内框，最「印刷/手作」的触感。'],
];

// 候选 SVG 落盘（待确认再写 favicon/icon）
VARIANTS.forEach(([key, , svg]) => fs.writeFileSync(path.join(__dirname, `favicon-inkgold-${key}.svg`), '<?xml version="1.0" encoding="UTF-8"?>\n' + svg.replace('width="100%" height="100%"', 'width="64" height="64"')));

const html = `<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ink&Gold — 精修</title>
<style>
:root{--bg:#0c0d10;--line:#23262e;--ink:#e9ecf1;--mut:#8b93a1;--paper:#f1e9d8;}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 -apple-system,"SF Pro Text",system-ui,sans-serif;-webkit-font-smoothing:antialiased;padding:56px 40px 120px}
header{max-width:1080px;margin:0 auto 36px}h1{font-size:28px;letter-spacing:-.02em;margin:0 0 8px;font-weight:680}.lede{color:var(--mut);max-width:740px;margin:0}
.grid{max-width:1080px;margin:0 auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:24px}
.card{background:linear-gradient(180deg,#17191f,#121317);border:1px solid var(--line);border-radius:18px;padding:24px;display:flex;flex-direction:column;gap:18px}
.hero{display:flex;gap:20px;align-items:center}
.tile{width:120px;height:120px;flex:0 0 auto;border-radius:27px;overflow:hidden;box-shadow:0 12px 30px rgba(0,0,0,.55)}
.scales{display:flex;gap:14px;align-items:flex-end}.sc{display:flex;flex-direction:column;align-items:center;gap:6px}.sc .l{font-size:10px;color:var(--mut)}.sq{border-radius:22%;overflow:hidden}
.paper{background:var(--paper);border-radius:14px;padding:18px 20px;display:flex;align-items:center;gap:16px}
.paper .seal{width:54px;height:54px;border-radius:13px;overflow:hidden;flex:0 0 auto}
.paper .pt{color:#5b5043;font-size:13px;line-height:1.45}.paper .pt b{color:#2c2117;font-weight:650}
.meta{border-top:1px solid var(--line);padding-top:14px}.meta .nm{font-size:17px;font-weight:640;margin:0 0 4px}.meta .desc{color:var(--mut);font-size:13px;margin:0}
.note{max-width:1080px;margin:42px auto 0;color:var(--mut);font-size:13px;border-top:1px solid var(--line);padding-top:18px}code{background:#0a0a0c;padding:1px 6px;border-radius:6px;color:#cdd5e0}
</style></head><body>
<header><h1>Ink&Gold — 精修候选</h1>
<p class="lede">金箔 Möbius 压入深紫墨瓷砖（hue 310，非纯黑）；金调取品牌 ochre。已做：光学居中（原几何偏右上 2px）、浮雕接触投影替代 neon glow（遵 brief 杀光）、烫金边缘高光、拉丝光泽、暖白点高光。每张含 96/48/32/16 缩放 + 纸面印章语境（品牌默认浅色）。</p></header>
<main class="grid">
${VARIANTS.map(([key, nm, svg, desc]) => `
  <div class="card">
    <div class="hero">
      <div class="tile">${svg}</div>
      <div class="scales">
        <div class="sc"><div class="sq" style="width:48px;height:48px">${svg}</div><div class="l">48</div></div>
        <div class="sc"><div class="sq" style="width:32px;height:32px">${svg}</div><div class="l">32</div></div>
        <div class="sc"><div class="sq" style="width:16px;height:16px">${svg}</div><div class="l">16</div></div>
      </div>
    </div>
    <div class="paper"><div class="seal">${svg}</div><div class="pt"><b>纸面印章语境</b><br>品牌默认浅色——验证金印在 cream paper 上是否成立。</div></div>
    <div class="meta"><div class="nm">${nm}</div><p class="desc">${desc}</p></div>
  </div>`).join('')}
</main>
<p class="note">候选已落盘 <code>design/favicon-inkgold-{gilt,deep,bezel}.svg</code>。确认哪个后我写回 <code>public/favicon.svg</code> + <code>build/icon.svg</code> 并跑 <code>build/gen-icon.sh</code> 出 .icns/.png（librsvg 支持滤镜，导出与预览一致）。</p>
</body></html>`;

fs.writeFileSync(path.join(__dirname, 'logo-inkgold.html'), html);
console.log('wrote logo-inkgold.html + favicon-inkgold-{gilt,deep,bezel}.svg');
