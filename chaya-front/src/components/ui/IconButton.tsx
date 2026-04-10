/**
 * 图标按钮组件 - 封装常用的图标按钮模式
 * 用于替代重复的 Button variant="ghost" size="icon" 模式
 */

import React from 'react';
import { LucideIcon } from 'lucide-react';
import { Button, ButtonProps } from './Button';
import { cn } from '@/utils/cn';

export interface IconButtonProps extends Omit<ButtonProps, 'children'> {
  icon: LucideIcon;
  label?: string; // 用于无障碍访问
  iconClassName?: string;
}

/**
 * 图标按钮 - 用于工具栏、操作按钮等场景
 * 
 * @example
 * <IconButton icon={Plus} onClick={handleAdd} label="添加" />
 * <IconButton icon={Trash2} variant="destructive" onClick={handleDelete} />
 */
export const IconButton: React.FC<IconButtonProps> = ({
  icon: Icon,
  label,
  iconClassName,
  className,
  variant = 'ghost',
  size = 'icon',
  ...props
}) => {
  return (
    <Button
      variant={variant}
      size={size}
      className={cn(className)}
      aria-label={label}
      {...props}
    >
      <Icon className={cn('w-4 h-4', iconClassName)} />
    </Button>
  );
};

/**
 * 带文本的图标按钮 - 用于需要同时显示图标和文本的场景
 */
export interface IconButtonWithTextProps extends Omit<ButtonProps, 'children'> {
  icon: LucideIcon;
  children: React.ReactNode;
  iconPosition?: 'left' | 'right';
  iconClassName?: string;
}

export const IconButtonWithText: React.FC<IconButtonWithTextProps> = ({
  icon: Icon,
  children,
  iconPosition = 'left',
  iconClassName,
  className,
  ...props
}) => {
  return (
    <Button className={cn(className)} {...props}>
      {iconPosition === 'left' && (
        <Icon className={cn('w-4 h-4', iconClassName)} />
      )}
      {children}
      {iconPosition === 'right' && (
        <Icon className={cn('w-4 h-4', iconClassName)} />
      )}
    </Button>
  );
};

