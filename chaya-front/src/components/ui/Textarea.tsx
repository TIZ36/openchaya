import * as React from 'react';

import { cn } from '@/utils/cn';

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        className={cn(
          [
            'flex min-h-[100px] w-full rounded-sm border border-inputToken bg-background px-4 py-3 text-sm text-foreground',
            'placeholder:text-mutedToken-foreground',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ringToken',
            'disabled:cursor-not-allowed disabled:opacity-50',
            'resize-y',
          ].join(' '),
          className,
        )}
        {...props}
      />
    );
  },
);
Textarea.displayName = 'Textarea';

