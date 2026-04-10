import * as React from 'react';
import * as SwitchPrimitives from '@radix-ui/react-switch';

import { cn } from '@/utils/cn';

export const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    ref={ref}
    className={cn(
      'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-borderToken bg-mutedToken transition-colors',
      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ringToken',
      'data-[state=checked]:bg-primaryToken data-[state=unchecked]:bg-mutedToken',
      'disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    {...props}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        // w-9(36px) 轨道、h-4(16px) 滑块：左右各约 2px 内边距，行程 18px（勿用 translate-x-4.5，会与轨道宽度错位）
        'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-sm transition-transform duration-200 ease-out',
        'data-[state=unchecked]:translate-x-[2px]',
        'data-[state=checked]:translate-x-[18px]',
      )}
    />
  </SwitchPrimitives.Root>
));
Switch.displayName = SwitchPrimitives.Root.displayName;

