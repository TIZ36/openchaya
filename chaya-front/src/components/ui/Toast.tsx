import * as React from 'react';
import * as ToastPrimitives from '@radix-ui/react-toast';

type Variant = 'default' | 'destructive' | 'success';

const ToastProvider = ToastPrimitives.Provider;

const ToastViewport = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Viewport>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Viewport>
>(({ style, ...props }, ref) => (
  <ToastPrimitives.Viewport
    ref={ref}
    style={{ ...viewportStyle, ...style }}
    {...props}
  />
));
ToastViewport.displayName = ToastPrimitives.Viewport.displayName;

const Toast = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Root> & { variant?: Variant }
>(({ variant = 'default', style, ...props }, ref) => (
  <ToastPrimitives.Root
    ref={ref}
    style={{ ...rootStyle, ...variantStyle(variant), ...style }}
    {...props}
  />
));
Toast.displayName = ToastPrimitives.Root.displayName;

const ToastTitle = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Title>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Title>
>(({ style, ...props }, ref) => (
  <ToastPrimitives.Title ref={ref} style={{ ...titleStyle, ...style }} {...props} />
));
ToastTitle.displayName = ToastPrimitives.Title.displayName;

const ToastDescription = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Description>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Description>
>(({ style, ...props }, ref) => (
  <ToastPrimitives.Description ref={ref} style={{ ...descStyle, ...style }} {...props} />
));
ToastDescription.displayName = ToastPrimitives.Description.displayName;

const ToastClose = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Close>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Close>
>(({ style, ...props }, ref) => (
  <ToastPrimitives.Close ref={ref} style={{ ...closeStyle, ...style }} {...props} />
));
ToastClose.displayName = ToastPrimitives.Close.displayName;

export {
  ToastProvider,
  ToastViewport,
  Toast,
  ToastTitle,
  ToastDescription,
  ToastClose,
};

const viewportStyle: React.CSSProperties = {
  position: 'fixed',
  top: 2,
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 100,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 8,
  pointerEvents: 'none',
};

const rootStyle: React.CSSProperties = {
  position: 'relative',
  pointerEvents: 'auto',
  display: 'flex',
  alignItems: 'flex-start',
  gap: 12,
  padding: '12px 16px',
  minWidth: 240,
  maxWidth: 420,
  borderRadius: 4,
  border: '1px solid var(--rule-strong)',
  background: 'var(--page-elev)',
  color: 'var(--ink)',
  fontFamily: 'var(--font-sans)',
  boxShadow: '0 2px 4px oklch(0.18 0.02 310 / 0.06), 0 10px 24px oklch(0.18 0.02 310 / 0.04)',
};

function variantStyle(v: Variant): React.CSSProperties {
  if (v === 'destructive') {
    return { borderColor: 'color-mix(in oklch, var(--status-error) 45%, var(--rule-strong))' };
  }
  if (v === 'success') {
    return { borderColor: 'color-mix(in oklch, var(--status-success) 45%, var(--rule-strong))' };
  }
  return {};
}

const titleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  lineHeight: 1.2,
  color: 'var(--ink-strong)',
};

const descStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--pencil)',
  lineHeight: 1.45,
  marginTop: 4,
};

const closeStyle: React.CSSProperties = {
  position: 'absolute',
  right: 6,
  top: 6,
  width: 20,
  height: 20,
  padding: 0,
  lineHeight: '18px',
  textAlign: 'center',
  background: 'transparent',
  border: 0,
  color: 'var(--pencil)',
  cursor: 'pointer',
  borderRadius: 2,
};
