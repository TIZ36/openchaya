/**
 * 表单字段组件 - 封装 Label + Input/Textarea + 错误提示的模式
 * 用于替代重复的表单字段布局代码
 */

import React from 'react';
import { Label } from './Label';
import { Input, InputProps } from './Input';
import { Textarea, TextareaProps } from './Textarea';
import { cn } from '@/utils/cn';

export interface FormFieldProps {
  label: string;
  error?: string;
  hint?: string;
  required?: boolean;
  className?: string;
}

/**
 * 输入框字段 - 封装 Label + Input + 错误提示
 */
// 兼容两种用法：
// 1) 推荐：<InputField inputProps={{ id, value, onChange, ... }} />
// 2) 兼容旧代码：<InputField id value onChange ... />
export type InputFieldProps =
  & FormFieldProps
  & (
    | { inputProps: InputProps }
    | ({ inputProps?: undefined } & InputProps)
  );

export const InputField: React.FC<InputFieldProps> = (props) => {
  const {
    label,
    error,
    hint,
    required,
    className,
    // @ts-expect-error - legacy prop support: inputProps may not exist
    inputProps: nestedInputProps,
    ...legacyInputProps
  } = props as any;

  const reactId = React.useId();
  const inputProps: InputProps = nestedInputProps ?? legacyInputProps;
  const effectiveId = inputProps.id ?? `field-${reactId}`;

  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={effectiveId}>
        {label}
        {required && <span className="text-destructiveToken ml-1">*</span>}
      </Label>
      <Input
        {...inputProps}
        id={effectiveId}
        className={cn(error && 'border-destructiveToken', inputProps.className)}
      />
      {error && (
        <p className="text-xs text-destructiveToken">{error}</p>
      )}
      {hint && !error && (
        <p className="text-xs text-mutedToken-foreground">{hint}</p>
      )}
    </div>
  );
};

/**
 * 文本域字段 - 封装 Label + Textarea + 错误提示
 */
// 兼容两种用法：
// 1) 推荐：<TextareaField textareaProps={{ id, value, onChange, ... }} />
// 2) 兼容旧代码：<TextareaField id value onChange ... />
export type TextareaFieldProps =
  & FormFieldProps
  & (
    | { textareaProps: TextareaProps }
    | ({ textareaProps?: undefined } & TextareaProps)
  );

export const TextareaField: React.FC<TextareaFieldProps> = (props) => {
  const {
    label,
    error,
    hint,
    required,
    className,
    // @ts-expect-error - legacy prop support: textareaProps may not exist
    textareaProps: nestedTextareaProps,
    ...legacyTextareaProps
  } = props as any;

  const reactId = React.useId();
  const textareaProps: TextareaProps = nestedTextareaProps ?? legacyTextareaProps;
  const effectiveId = textareaProps.id ?? `field-${reactId}`;

  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={effectiveId}>
        {label}
        {required && <span className="text-destructiveToken ml-1">*</span>}
      </Label>
      <Textarea
        {...textareaProps}
        id={effectiveId}
        className={cn(error && 'border-destructiveToken', textareaProps.className)}
      />
      {error && (
        <p className="text-xs text-destructiveToken">{error}</p>
      )}
      {hint && !error && (
        <p className="text-xs text-mutedToken-foreground">{hint}</p>
      )}
    </div>
  );
};

/**
 * 表单字段组 - 用于组织多个表单字段
 */
export interface FormFieldGroupProps {
  children: React.ReactNode;
  className?: string;
  spacing?: 'compact' | 'default' | 'relaxed';
}

export const FormFieldGroup: React.FC<FormFieldGroupProps> = ({
  children,
  className,
  spacing = 'default',
}) => {
  const spacingClasses = {
    compact: 'space-y-3',
    default: 'space-y-4',
    relaxed: 'space-y-5',
  };

  return (
    <div className={cn(spacingClasses[spacing], className)}>
      {children}
    </div>
  );
};

