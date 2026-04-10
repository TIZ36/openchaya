import * as React from 'react';

import { useToast } from './use-toast';
import {
  ToastProvider,
  ToastViewport,
  Toast,
  ToastTitle,
  ToastDescription,
  ToastClose,
} from './Toast';

const DEFAULT_TOAST_DURATION = 1000; // 默认显示时间 1000ms

export function Toaster() {
  const { toasts, dismiss } = useToast();

  return (
    <ToastProvider duration={DEFAULT_TOAST_DURATION}>
      {toasts.map(({ id, title, description, action, variant, duration }) => (
        <Toast
          key={id}
          variant={variant}
          duration={duration ?? DEFAULT_TOAST_DURATION}
          onOpenChange={(open) => {
            if (!open) dismiss(id);
          }}
        >
          <div className="grid gap-1">
            {title ? <ToastTitle>{title}</ToastTitle> : null}
            {description ? (
              <ToastDescription>{description}</ToastDescription>
            ) : null}
          </div>
          {action}
          <ToastClose aria-label="Close">×</ToastClose>
        </Toast>
      ))}
      <ToastViewport />
    </ToastProvider>
  );
}

