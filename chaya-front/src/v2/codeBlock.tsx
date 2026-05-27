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
 * ========================================================================== */
import React from 'react';
import ShikiHighlighter, {
  isInlineCode,
  rehypeInlineCodeProperty,
  type Element,
} from 'react-shiki/web';

/** rehype plugins for the markdown pipeline — reintroduces the `inline` prop on
 *  code nodes (react-markdown v10 dropped it) so we can split inline vs block. */
export const mdRehypePlugins = [rehypeInlineCodeProperty];

const THEME = { light: 'vitesse-light', dark: 'vitesse-dark' } as const;

type CodeProps = {
  node?: Element;
  inline?: boolean;
  className?: string;
  children?: React.ReactNode;
} & React.HTMLAttributes<HTMLElement>;

/** react-markdown `code` component. Inline code stays a plain <code>; fenced
 *  blocks render through Shiki. */
export const CodeBlock: React.FC<CodeProps> = ({ node, inline, className, children, ...props }) => {
  if (inline || (node && isInlineCode(node))) {
    return <code className={className} {...props}>{children}</code>;
  }
  const lang = /language-(\w[\w-]*)/.exec(className || '')?.[1] ?? 'text';
  return (
    <ShikiHighlighter
      language={lang}
      theme={THEME}
      defaultColor="light-dark()"
      addDefaultStyles={false}
      showLanguage={false}
      className="v2-code"
    >
      {String(children ?? '').replace(/\n$/, '')}
    </ShikiHighlighter>
  );
};

/** react-markdown wraps fenced code in <pre><code>; ShikiHighlighter renders its
 *  own <pre>, so we collapse the outer <pre> to avoid invalid nesting and the
 *  legacy pre styling. */
export const PreBlock: React.FC<{ children?: React.ReactNode }> = ({ children }) => <>{children}</>;
