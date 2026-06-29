import React from 'react';

/* ============================================================
   Paper & Press — thin React wrappers over classes in paper.css
   Use <PaperPage> as the root of any migrated page.
   ============================================================ */

export const PaperPage: React.FC<React.PropsWithChildren<{ className?: string }>> = ({ children, className }) => (
  <div className={`paper-page ${className || ''}`}>{children}</div>
);

export interface PaperTopbarProps {
  crumb?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
}

export const PaperTopbar: React.FC<PaperTopbarProps> = ({ crumb, title, subtitle, meta, actions }) => (
  <header className="paper-topbar">
    <div>
      {crumb && <div className="crumb">{crumb}</div>}
      <h1>{title}</h1>
      {subtitle && <p className="subtitle">{subtitle}</p>}
    </div>
    {(meta || actions) && (
      <div className="actions">
        {meta && <span className="meta">{meta}</span>}
        {actions}
      </div>
    )}
  </header>
);

export const PaperContent: React.FC<React.PropsWithChildren<{ noPad?: boolean; className?: string }>> = ({ children, noPad, className }) => (
  <section className={`paper-content ${noPad ? 'no-pad' : ''} ${className || ''}`}>{children}</section>
);

export const PaperSplit: React.FC<React.PropsWithChildren> = ({ children }) => (
  <div className="paper-split">{children}</div>
);

export interface PaperTOCItem {
  id: string;
  label: React.ReactNode;
}

export interface PaperTOCProps {
  label?: React.ReactNode;
  items: PaperTOCItem[];
  activeId?: string;
  onSelect?: (id: string) => void;
}

export const PaperTOC: React.FC<PaperTOCProps> = ({ label = '目录', items, activeId, onSelect }) => (
  <aside className="paper-toc">
    <div className="paper-toc-label">{label}</div>
    <div className="paper-toc-list">
      {items.map((it, i) => (
        <button
          key={it.id}
          type="button"
          className={`paper-toc-item ${activeId === it.id ? 'is-active' : ''}`}
          onClick={() => onSelect?.(it.id)}
        >
          <span className="n">{String(i + 1).padStart(2, '0')}</span>
          <span>{it.label}</span>
        </button>
      ))}
    </div>
  </aside>
);

export interface PaperSwitchProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  'aria-label'?: string;
}

export const PaperSwitch: React.FC<PaperSwitchProps> = ({ checked, onChange, ...rest }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    className={`paper-switch ${checked ? 'is-on' : ''}`}
    onClick={() => onChange(!checked)}
    {...rest}
  />
);

export interface PaperChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: 'default' | 'soft' | 'ok' | 'warn' | 'err';
}

export const PaperChip: React.FC<PaperChipProps> = ({ tone = 'default', className, children, ...rest }) => (
  <span className={`paper-chip ${tone !== 'default' ? tone : ''} ${className || ''}`} {...rest}>
    {children}
  </span>
);

export const PaperDot: React.FC<{ tone?: 'default' | 'ok' | 'warn' | 'err' }> = ({ tone = 'default' }) => (
  <span className={`paper-dot ${tone !== 'default' ? tone : ''}`} aria-hidden />
);

/* Hand-drawn rule decoration (uneven, looks hand-inked). */
export const PaperHandRule: React.FC<{ width?: number }> = ({ width = 96 }) => (
  <svg className="paper-hand-rule" width={width} height={8} viewBox="0 0 96 8" fill="none" aria-hidden>
    <path
      d="M1 4.2 C 16 2.6, 32 5.8, 48 3.8 S 80 2.2, 95 4.6"
      stroke="var(--accent-ink)"
      strokeWidth={1.2}
      strokeLinecap="round"
      strokeOpacity={0.7}
      fill="none"
    />
  </svg>
);

export interface PaperCardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title' | 'role'> {
  num?: string | number;
  glyph?: React.ReactNode;
  title: React.ReactNode;
  role?: React.ReactNode;
  blurb?: React.ReactNode;
  footLeft?: React.ReactNode;
  footRight?: React.ReactNode;
  primary?: boolean;
  primaryNote?: React.ReactNode;
}

/** Rendered as <article role="button"> to match the mockup's <article class="card">
 *  and avoid cross-browser issues with <button> + flex-column layout. */
export const PaperCard: React.FC<PaperCardProps> = ({
  num, glyph, title, role, blurb, footLeft, footRight,
  primary, primaryNote, className, onClick, ...rest
}) => {
  const handleKey: React.KeyboardEventHandler<HTMLDivElement> = (e) => {
    if (!onClick) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick(e as unknown as React.MouseEvent<HTMLDivElement>);
    }
  };
  return (
    <article
      className={`paper-card ${primary ? 'is-primary' : ''} ${className || ''}`}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? handleKey : undefined}
      {...(rest as React.HTMLAttributes<HTMLElement>)}
    >
      {primaryNote && <span className="c-primary-note">{primaryNote}</span>}
      {num !== undefined && <span className="c-num">{num}</span>}
      {glyph && <span className="c-glyph">{glyph}</span>}
      <h3>{title}</h3>
      {role && <div className="c-role">{role}</div>}
      {blurb && <div className="c-blurb">{blurb}</div>}
      {(footLeft || footRight) && (
        <div className="c-foot">
          <span>{footLeft}</span>
          <span className="c-last">{footRight}</span>
        </div>
      )}
    </article>
  );
};

export const PaperNewCard: React.FC<{
  onClick?: () => void;
  plus?: React.ReactNode;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
}> = ({ onClick, plus = '＋', title = '再养一只', subtitle = 'NEW' }) => {
  const handleKey: React.KeyboardEventHandler<HTMLDivElement> = (e) => {
    if (!onClick) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
  };
  return (
    <article
      className="paper-card new-card"
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? handleKey : undefined}
    >
      <div>
        <div className="plus">{plus}</div>
        <div className="t">{title}</div>
        <div className="s">{subtitle}</div>
      </div>
    </article>
  );
};

export const PaperButton: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: 'default' | 'ghost' | 'link';
    size?: 'default' | 'small';
    danger?: boolean;
  }
> = ({ variant = 'default', size = 'default', danger, className, children, ...rest }) => (
  <button
    type="button"
    className={`paper-btn ${variant !== 'default' ? variant : ''} ${size === 'small' ? 'small' : ''} ${danger ? 'danger' : ''} ${className || ''}`}
    {...rest}
  >
    {children}
  </button>
);

export const PaperInput: React.FC<React.InputHTMLAttributes<HTMLInputElement> & { align?: 'left' | 'right'; mono?: boolean }> = ({
  align, mono, className, ...rest
}) => (
  <input
    className={`paper-input ${align === 'right' ? 'right' : ''} ${mono ? 'mono' : ''} ${className || ''}`}
    {...rest}
  />
);

export const PaperTextarea: React.FC<React.TextareaHTMLAttributes<HTMLTextAreaElement>> = ({ className, ...rest }) => (
  <textarea className={`paper-textarea ${className || ''}`} {...rest} />
);

export const PaperDanger: React.FC<{ title: React.ReactNode; children: React.ReactNode }> = ({ title, children }) => (
  <div className="paper-danger">
    <h3>{title}</h3>
    <p>{children}</p>
  </div>
);
