/* ============================================================================
 *  codeBlock — Shiki-powered code rendering for the markdown surfaces (.v2-md).
 *
 *  Replaces highlight.js (github.css) with Shiki for VSCode-grade highlighting.
 *  react-shiki highlights client-side on mount (a useEffect), so it sidesteps
 *  react-markdown's synchronous rehype pipeline (Shiki's own load is async).
 *
 *  Theme: dual vitesse-light / vitesse-dark — warm, low-saturation, designed as
 *  a pair; fits the letterpress "ink on cream" brand. Dark variant activates
 *  via CSS `color-scheme` (wired to .chaya-v2[data-mode="dark"] in theme.css)
 *  through Shiki's `defaultColor="light-dark()"`.
 *
 *  Styling: addDefaultStyles={false} hands all visual control to theme.css
 *  (.v2-code wrapper = paper surface; inner <pre> transparent so paper shows).
 *
 *  Quick-copy: every fenced block is wrapped in .v2-code-wrap with a small
 *  "复制" pill in the top-right that hover-reveals. On click it writes the
 *  raw source (without the trailing newline) to the clipboard and flips to
 *  "✓ 已复制" for 1.5s. Falls back to textarea+execCommand if the
 *  navigator.clipboard API is unavailable (e.g. non-https contexts).
 * ========================================================================== */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import ShikiHighlighter, {
  isInlineCode,
  rehypeInlineCodeProperty,
  type Element,
} from 'react-shiki/web';
import { IconCopy, IconCheck } from './icons';
import { useI18n } from '../i18n';

/** rehype plugins for the markdown pipeline — reintroduces the `inline` prop on
 *  code nodes (react-markdown v10 dropped it) so we can split inline vs block. */
export const mdRehypePlugins = [rehypeInlineCodeProperty];

const THEME = { light: 'vitesse-light', dark: 'vitesse-dark' } as const;

// Shiki tokenizes the whole block synchronously; on a very large block (agent
// dumping a big file or long command output) that can spike memory enough to take
// the renderer down (render-process-gone: oom). Past this size, skip highlighting
// and render a plain scrollable <pre> — readable, cheap, crash-proof.
const SHIKI_MAX_CHARS = 40_000;

type CodeProps = {
  node?: Element;
  inline?: boolean;
  className?: string;
  children?: React.ReactNode;
} & React.HTMLAttributes<HTMLElement>;

/** react-markdown `code` component. Inline code stays a plain <code>; fenced
 *  blocks render through Shiki, wrapped with a quick-copy affordance.
 *
 *  Memoized on (className, inline, text-content). react-markdown allocates a
 *  fresh `node` Element each render, so the default React.memo shallow compare
 *  would still re-render — we explicitly ignore `node` and compare the actual
 *  text. Without this, every parent re-render (e.g. settings/draft change on
 *  the chat surface) tears down + rebuilds every code block on screen. */
const codeChildrenText = (c: React.ReactNode): string =>
  Array.isArray(c) ? c.map((x) => (typeof x === 'string' ? x : '')).join('') : (typeof c === 'string' ? c : '');

export const CodeBlock = React.memo<CodeProps>(({ node, inline, className, children, ...props }) => {
  if (inline || (node && isInlineCode(node))) {
    return <code className={className} {...props}>{children}</code>;
  }
  const lang = /language-(\w[\w-]*)/.exec(className || '')?.[1] ?? 'text';
  const raw = String(children ?? '').replace(/\n$/, '');
  if (lang === 'mermaid' && raw.length <= SHIKI_MAX_CHARS) {
    return (
      <div className="v2-code-wrap">
        <MermaidBlock source={raw} />
        <CopyButton text={raw} lang={lang} />
      </div>
    );
  }
  // Oversized block → plain <pre>, no Shiki/Mermaid (avoids renderer OOM).
  if (raw.length > SHIKI_MAX_CHARS) {
    return (
      <div className="v2-code-wrap">
        <pre className="v2-code v2-code-plain" data-lang={lang}><code>{raw}</code></pre>
        <CopyButton text={raw} lang={lang} />
      </div>
    );
  }
  return (
    <div className="v2-code-wrap">
      <ShikiHighlighter
        language={lang}
        theme={THEME}
        defaultColor="light-dark()"
        addDefaultStyles={false}
        showLanguage={false}
        className="v2-code"
      >
        {raw}
      </ShikiHighlighter>
      <CopyButton text={raw} lang={lang} />
    </div>
  );
}, (prev, next) =>
  prev.inline === next.inline &&
  prev.className === next.className &&
  codeChildrenText(prev.children) === codeChildrenText(next.children),
);
CodeBlock.displayName = 'CodeBlock';

/* ----------------------------- Mermaid block -----------------------------
 * Lazy-loads `mermaid` on first encounter (≈400KB gz), so cold start of the
 * chat surface isn't penalised for users who never paste a diagram.
 *
 * 渲染策略：
 *   - 流式输入下 source 会一帧帧增长 —— 用 120ms debounce 避免每个 chunk 都炸
 *     一次「Parse error」。
 *   - 先 `parse`（lightweight 校验），失败就降级为原始代码块，正文给一句提示，
 *     不让半截图把对话流搞红。
 *   - 主题切换 (data-mode=dark) 时观察 root 属性变化，重渲染一次。
 * ----------------------------------------------------------------------- */
let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;
function loadMermaid() {
  if (!mermaidPromise) mermaidPromise = import('mermaid').then((m) => m.default);
  return mermaidPromise;
}
function readChayaMode(): 'light' | 'dark' {
  const m = document.querySelector('.chaya-v2')?.getAttribute('data-mode');
  return m === 'dark' ? 'dark' : 'light';
}
function hashSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 100000;
}

/** 把当前主题的 CSS 变量翻译给 mermaid 的 themeVariables —— 让节点/线/分组用
 *  我们的墨/纸/规则色，而不是 mermaid 默认那一套浅蓝灰 + 紫色字。
 *  搭 `look:'handDrawn'`（rough.js 手绘描边）后整张图会像钢笔在纸上勾出来的，
 *  与 letterpress 调性合拍。 */
function buildMermaidThemeVars(): Record<string, string> {
  const root = document.querySelector('.chaya-v2');
  const cs = root ? getComputedStyle(root) : null;
  const v = (name: string, fallback: string) =>
    (cs?.getPropertyValue(name).trim() || fallback);
  const bg = v('--c-bg', '#ffffff');
  const paper = v('--c-sidebar', '#f9f9f9');
  const ink = v('--c-ink', '#0d0d0d');
  const ink2 = v('--c-ink-2', '#3c3c3c');
  const ink3 = v('--c-ink-3', '#6e6e6e');
  const ink4 = v('--c-ink-4', '#a4a4a4');
  const rule = v('--c-rule', '#ececec');
  const hoverSoft = v('--c-hover-soft', '#f2f2f2');
  const warn = v('--c-warn', '#b45309');
  return {
    background: 'transparent',
    // 节点：纸面底 + 墨色字 + 中调描边
    primaryColor: bg,
    primaryTextColor: ink,
    primaryBorderColor: ink3,
    secondaryColor: paper,
    secondaryTextColor: ink,
    secondaryBorderColor: ink3,
    tertiaryColor: hoverSoft,
    tertiaryTextColor: ink2,
    tertiaryBorderColor: rule,
    // 连线 / 标签 / 文本
    lineColor: ink3,
    arrowheadColor: ink2,
    textColor: ink,
    titleColor: ink,
    edgeLabelBackground: bg,
    labelTextColor: ink3,
    labelBackground: bg,
    // 分组容器（subgraph）—— 比节点底色再淡一档，并配虚线边
    clusterBkg: 'transparent',
    clusterBorder: ink4,
    // 备注 / 警告
    noteBkgColor: hoverSoft,
    noteTextColor: ink2,
    noteBorderColor: rule,
    errorBkgColor: hoverSoft,
    errorTextColor: warn,
    // Excalidraw 风：手写字 + 略大字号。字体由 theme.css 的 @import 加载，并兜回 mono。
    fontFamily: '"Architects Daughter", "Kalam", "Caveat", var(--c-mono), system-ui, sans-serif',
    fontSize: '16px',
  };
}

/** Mermaid `themeCSS`：注入到 SVG 内部的样式表（mermaid v11 在 svg 顶部生成
 *  <style> 标签）。在这里精修边线粗细、字色、subgraph 边、箭头大小 ——
 *  外部 CSS 难以稳定命中 mermaid 内部生成的 class，themeCSS 是官方推荐入口。 */
function buildMermaidThemeCSS(): string {
  return `
    /* Excalidraw 调性：描边偏粗、深墨色、圆角线帽 —— 像粗芯钢笔在纸上一笔过去 */
    .node rect, .node circle, .node ellipse, .node polygon, .node path,
    .cluster rect, .cluster polygon {
      stroke-width: 1.8px !important;
      stroke-linecap: round; stroke-linejoin: round;
    }
    .edgePath .path, .flowchart-link {
      stroke-width: 1.6px !important;
      stroke-linecap: round; stroke-linejoin: round;
    }
    /* 节点字：手写字本身就有性格，不再加 tracking；行距给宽一点 */
    .nodeLabel { letter-spacing: 0; font-weight: 400; line-height: 1.25; }
    .node .label { line-height: 1.25; }
    /* 边标签：用同款手写字，比节点小一档；底色 + 4px 同色晕由外部 CSS 给 */
    .edgeLabel, .edgeLabel * {
      font-style: normal !important;
      font-size: 13px !important; font-weight: 400 !important;
      letter-spacing: 0;
    }
    .edgeLabel { padding: 0 6px !important; }
    /* subgraph：虚线（间距更大模仿草图）+ 圆角；标签用手写小标题，不再 caps */
    .cluster rect, .cluster polygon {
      stroke-dasharray: 6 5; rx: 12; ry: 12;
    }
    .cluster-label, .cluster .nodeLabel {
      font-size: 14px !important; font-weight: 400 !important;
      letter-spacing: 0; text-transform: none;
      opacity: 0.85;
    }
    /* 箭头：rough 自带 marker，这里把官方 fallback 也调成深墨 */
    .marker { transform-box: fill-box; transform-origin: center; }
    marker path { stroke-width: 0; }
  `;
}

const MermaidBlock: React.FC<{ source: string }> = ({ source }) => {
  const { t: tr } = useI18n();
  const [svg, setSvg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<'light' | 'dark'>(() =>
    typeof document !== 'undefined' ? readChayaMode() : 'light');
  const idRef = useRef(`mmd-${Math.random().toString(36).slice(2, 9)}`);

  // Watch theme attribute; re-render when it flips so colors track the surface.
  useEffect(() => {
    const root = document.querySelector('.chaya-v2');
    if (!root) return;
    const ob = new MutationObserver(() => setMode(readChayaMode()));
    ob.observe(root, { attributes: true, attributeFilter: ['data-mode'] });
    return () => ob.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const t = window.setTimeout(async () => {
      try {
        const mermaid = await loadMermaid();
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          fontFamily: 'inherit',
          // v11 handDrawn look (rough.js) —— 与品牌手作/letterpress 调性一致
          look: 'handDrawn',
          // 用 source 的稳定哈希作 seed —— 同一张图每次刷新笔触一致，不同图各有性格
          handDrawnSeed: hashSeed(source),
          theme: 'base',
          themeVariables: buildMermaidThemeVars(),
          themeCSS: buildMermaidThemeCSS(),
          // useMaxWidth: false 让 mermaid 输出真实尺寸的 svg，外层容器自己横向滚动；
          // 否则 mermaid 会把 svg 压成 100% 宽 + 等比降高，宽图被挤成一团，标签互相
          // 重叠像「展示不全」。我们的 wrapper 给 overflow-x:auto + 居中即可。
          flowchart: { curve: 'basis', useMaxWidth: false, htmlLabels: true, padding: 22, nodeSpacing: 56, rankSpacing: 64, diagramPadding: 16 },
          sequence: { useMaxWidth: false, wrap: true },
          gantt: { useMaxWidth: false },
          class: { useMaxWidth: false },
          state: { useMaxWidth: false },
          er: { useMaxWidth: false },
        } as any);
        await mermaid.parse(source);
        if (cancelled) return;
        const out = await mermaid.render(idRef.current, source);
        if (cancelled) return;
        // 把 mermaid 注入的 inline `style="max-width:...;"` / `width="100%"` 抹掉，
        // 让 svg 以 viewBox + 自然 width/height 渲染；横向溢出交给外层 .v2-mermaid
        // 的 overflow-x:auto 处理，标签就不会被挤断。
        const cleanedSvg = out.svg
          .replace(/(<svg[^>]*?)\sstyle="[^"]*"/i, '$1')
          .replace(/(<svg[^>]*?)\swidth="100%"/i, '$1');
        setSvg(cleanedSvg);
        setErr(null);
      } catch (e: any) {
        if (cancelled) return;
        const msg = String(e?.message ?? e ?? 'mermaid render error').split('\n')[0];
        setErr(msg);
      }
    }, 120);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, [source, mode]);

  if (err && !svg) {
    return (
      <div className="v2-mermaid v2-mermaid-err" role="img" aria-label="mermaid diagram (failed to render)">
        <div className="v2-mermaid-err-hd">Mermaid · {err}</div>
        <pre className="v2-mermaid-src">{source}</pre>
      </div>
    );
  }
  if (!svg) {
    return <div className="v2-mermaid v2-mermaid-loading" aria-busy>{tr('misc.mermaidRendering')}</div>;
  }
  // Mermaid's SVG output is sanitized under securityLevel:'strict'.
  return <div className="v2-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
};

/** Top-right quick-copy pill. Hover (or focus) on the code block reveals it. */
const CopyButton: React.FC<{ text: string; lang: string }> = ({ text, lang }) => {
  const { t: tr } = useI18n();
  const [done, setDone] = useState(false);
  const timerRef = useRef<number | null>(null);

  const onClick = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      // Modern path — secure contexts (https, file://, electron).
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback — hidden textarea + execCommand. Works almost everywhere else.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* give up quietly */ }
      document.body.removeChild(ta);
    }
    setDone(true);
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setDone(false), 1500);
  }, [text]);

  const title = done
    ? tr('misc.copied')
    : `${tr('misc.copy')}${lang && lang !== 'text' ? ` (${lang})` : ''}`;
  return (
    <button
      type="button"
      className={`v2-code-copy${done ? ' done' : ''}`}
      onClick={onClick}
      title={title}
      aria-label={title}
    >
      {done ? <IconCheck /> : <IconCopy />}
    </button>
  );
};

/** react-markdown wraps fenced code in <pre><code>; ShikiHighlighter renders its
 *  own <pre>, so we collapse the outer <pre> to avoid invalid nesting and the
 *  legacy pre styling. Memoized — children reference changes per render but
 *  we delegate the actual diffing to the inner CodeBlock anyway. */
export const PreBlock = React.memo<{ children?: React.ReactNode }>(({ children }) => <>{children}</>);
PreBlock.displayName = 'PreBlock';
