/**
 * 统一的页面布局组件
 * 为所有面板提供一致的外观和间距
 */

import React from 'react';
import { LucideIcon } from 'lucide-react';

interface PageLayoutProps {
  /** 页面标题 */
  title: string;
  /** 页面描述/副标题 */
  description?: string;
  /** 标题图标 */
  icon?: LucideIcon;
  /** 右上角操作区域 */
  headerActions?: React.ReactNode;
  /** 主要内容区域 */
  children: React.ReactNode;
  /** 是否显示页面头部 */
  showHeader?: boolean;
  /** 自定义内容区域类名 */
  contentClassName?: string;
  /** 是否使用全宽布局（用于编辑器等需要最大化空间的页面） */
  fullWidth?: boolean;
  /** 是否使用紧凑模式（减少内边距） */
  compact?: boolean;
  /** 布局风格：default=原样，persona=与 Persona 管理一致的列状排列（头部+居中滚动区） */
  variant?: 'default' | 'persona';
  /** variant=persona 时是否将内容约束在 max-w-3xl 居中；false 时仅应用头部与背景，不约束内容宽度 */
  personaConstrainContent?: boolean;
}

const PageLayout: React.FC<PageLayoutProps> = ({
  title,
  description,
  icon: Icon,
  headerActions,
  children,
  showHeader = true,
  contentClassName = '',
  fullWidth = false,
  compact = false,
  variant = 'default',
  personaConstrainContent = true,
}) => {
  const isPersona = variant === 'persona';
  const constrainContent = isPersona && personaConstrainContent;

  return (
    <div className={`
      h-full flex flex-col overflow-hidden
      ${isPersona ? 'persona-page-root bg-gray-50 dark:bg-[#1a1a1a]' : ''}
    `}>
      <div className="flex-1 flex flex-col overflow-hidden">
        {showHeader && (
          <div className={`
            flex-shrink-0
            ${isPersona
              ? 'agents-page-header py-4 border-b border-gray-200 dark:border-[#404040] bg-white dark:bg-[#2d2d2d]'
              : 'px-3 py-2 glass-header'
            }
          `}>
            <div className={isPersona ? 'max-w-5xl w-full mx-auto px-6' : ''}>
              <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 min-h-11">
                <div className="flex items-center justify-start min-w-0" />
                <div className="flex flex-col items-center justify-center min-w-0 max-w-full px-2 text-center">
                  <h1 className={`
                    font-bold text-gray-900 dark:text-white [data-skin="niho"]:text-[var(--text-primary)]
                    ${isPersona ? 'text-2xl agents-page-title' : 'text-base font-semibold'}
                  `}>
                    {title}
                  </h1>
                  {description && typeof description === 'string' && description.trim() && description !== '0' && (
                    <p className={`text-gray-500 dark:text-[#858585] [data-skin="niho"]:text-[var(--niho-skyblue-gray)] mt-0.5 ${isPersona ? 'text-xs' : 'text-[10px]'}`}>{description}</p>
                  )}
                </div>
                <div className="flex items-center justify-end min-w-0">
                  {headerActions}
                </div>
              </div>
            </div>
          </div>
        )}

        <div className={`
          flex-1 overflow-auto
          ${isPersona ? 'agents-page-list app-page-content no-scrollbar' : ''}
          ${!isPersona && (fullWidth ? '' : compact ? 'p-2' : 'p-3')}
          ${contentClassName}
        `}>
          {constrainContent ? (
            <div className="max-w-5xl mx-auto space-y-8">
              {children}
            </div>
          ) : (
            children
          )}
        </div>
      </div>
    </div>
  );
};

/**
 * 卡片组件 - 用于内容分组 (带立体阴影)
 * variant=persona 时与 Persona 管理页卡片风格一致
 */
interface CardProps {
  title?: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  /** 是否无内边距 */
  noPadding?: boolean;
  /** 自定义头部操作 */
  headerAction?: React.ReactNode;
  /** 卡片大小: 默认(default)、紧凑(compact)、宽松(relaxed) */
  size?: 'compact' | 'default' | 'relaxed';
  /** 风格：default=毛玻璃卡片，persona=与 Persona 管理一致的圆角边框卡片 */
  variant?: 'default' | 'persona';
}

export const Card: React.FC<CardProps> = ({
  title,
  description,
  children,
  className = '',
  noPadding = false,
  headerAction,
  size = 'default',
  variant = 'default',
}) => {
  const paddingClass = {
    compact: 'p-2',
    default: 'p-3',
    relaxed: 'p-4',
  }[size];

  const isPersona = variant === 'persona';
  const cardClass = isPersona
    ? 'app-card-item agents-page-card rounded-lg'
    : 'glass-card';
  const headerBorderClass = isPersona
    ? 'border-b border-gray-200 dark:border-[#404040] [data-skin="niho"]:border-[var(--niho-text-border)]'
    : 'border-b border-gray-200/30 dark:border-white/5';
  const titleClass = isPersona
    ? 'text-sm font-medium text-gray-900 dark:text-white [data-skin="niho"]:text-[var(--text-primary)]'
    : 'text-xs font-semibold text-gray-900 dark:text-white';
  const descClass = isPersona
    ? 'text-xs text-gray-500 dark:text-[#858585] [data-skin="niho"]:text-[var(--niho-skyblue-gray)] mt-0.5'
    : 'text-[10px] text-gray-500 dark:text-[#808080] mt-0.5';

  return (
    <div className={`${cardClass} ${className}`}>
      {(title || headerAction) && (
        <div className={`flex items-center justify-between px-3 py-2 ${headerBorderClass} ${isPersona ? 'px-4 pt-4 pb-3' : ''}`}>
          <div>
            {title && (
              <h3 className={titleClass}>{title}</h3>
            )}
            {description && typeof description === 'string' && description.trim() && description !== '0' && (
              <p className={descClass}>{description}</p>
            )}
          </div>
          {headerAction}
        </div>
      )}
      <div className={noPadding ? '' : `${paddingClass} ${isPersona ? 'px-4 pb-4' : ''}`}>
        {children}
      </div>
    </div>
  );
};

/**
 * 区块组件 - 用于页面内的大分区
 */
interface SectionProps {
  title?: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  headerAction?: React.ReactNode;
}

export const Section: React.FC<SectionProps> = ({
  title,
  description,
  children,
  className = '',
  headerAction,
}) => {
  return (
    <div className={`glass-section mb-3 ${className}`}>
      {(title || headerAction) && (
        <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200/20 dark:border-white/5">
          <div>
            {title && (
              <h2 className="text-sm font-semibold text-gray-900 dark:text-white">{title}</h2>
            )}
            {description && typeof description === 'string' && description.trim() && description !== '0' && (
              <p className="text-[10px] text-gray-500 dark:text-[#808080] mt-0.5">{description}</p>
            )}
          </div>
          {headerAction}
        </div>
      )}
      <div className="p-2">
        {children}
      </div>
    </div>
  );
};

/**
 * 列表项组件
 */
interface ListItemProps {
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
}

export const ListItem: React.FC<ListItemProps> = ({
  children,
  className = '',
  onClick,
  active = false,
  disabled = false,
}) => {
  return (
    <div
      onClick={!disabled ? onClick : undefined}
      className={`
        app-list-item px-2 py-1.5 rounded-md transition-all duration-150
        ${active ? 'is-active' : ''}
        ${disabled ? 'opacity-50 cursor-not-allowed' : onClick ? 'cursor-pointer' : ''}
        ${className}
      `}
    >
      {children}
    </div>
  );
};


/**
 * 徽章组件 - 状态指示
 */
interface BadgeProps {
  children: React.ReactNode;
  variant?: 'default' | 'success' | 'warning' | 'error' | 'info';
  className?: string;
}

export const Badge: React.FC<BadgeProps> = ({
  children,
  variant = 'default',
  className = '',
}) => {
  const variantClass = {
    default: 'bg-gray-100 text-gray-700 dark:bg-[#404040] dark:text-[#e0e0e0]',
    success: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    warning: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
    error: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
    info: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  }[variant];

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${variantClass} badge-${variant} ${className}`}>
      {children}
    </span>
  );
};

/**
 * 空状态组件
 */
interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon: Icon,
  title,
  description,
  action,
  className = '',
}) => {
  return (
    <div className={`flex flex-col items-center justify-center py-12 text-center ${className}`}>
      {Icon && (
        <div className="text-gray-300 dark:text-gray-600 mb-4 [data-skin='niho']:text-[var(--neon-green-500)]">
          <Icon className="w-12 h-12" strokeWidth={1} />
        </div>
      )}
      <h3 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-2 [data-skin='niho']:text-[#e8f5f0]">{title}</h3>
      {description && (
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4 max-w-md [data-skin='niho']:text-[var(--niho-skyblue-gray)]">{description}</p>
      )}
      {action && (
        <div className="mt-2">
          {action}
        </div>
      )}
    </div>
  );
};

/**
 * 提示框组件
 */
interface AlertProps {
  children: React.ReactNode;
  variant?: 'info' | 'success' | 'warning' | 'error';
  title?: string;
  className?: string;
}

export const Alert: React.FC<AlertProps> = ({
  children,
  variant = 'info',
  title,
  className = '',
}) => {
  const variantClass = {
    info: 'bg-primary-50 border-primary-200 text-primary-800 dark:bg-primary-900/10 dark:border-primary-800/40 dark:text-primary-300 [data-skin="niho"]:bg-[#000] [data-skin="niho"]:border-[rgba(0,229,255,0.18)] [data-skin="niho"]:text-[#00e5ff]',
    success: 'bg-green-50 border-green-200 text-green-800 dark:bg-green-900/20 dark:border-green-800/50 dark:text-green-300 [data-skin="niho"]:bg-[#000] [data-skin="niho"]:border-[rgba(0,255,136,0.18)] [data-skin="niho"]:text-[#00ff88]',
    warning: 'bg-yellow-50 border-yellow-200 text-yellow-800 dark:bg-yellow-900/20 dark:border-yellow-800/50 dark:text-yellow-300 [data-skin="niho"]:bg-[#000] [data-skin="niho"]:border-[rgba(255,215,0,0.18)] [data-skin="niho"]:text-[#ffd700]',
    error: 'bg-red-50 border-red-200 text-red-800 dark:bg-red-900/20 dark:border-red-800/50 dark:text-red-300 [data-skin="niho"]:bg-[#000] [data-skin="niho"]:border-[rgba(255,107,157,0.18)] [data-skin="niho"]:text-[#ff6b9d]',
  }[variant];

  return (
    <div className={`rounded-xl p-4 border ${variantClass} ${className}`}>
      {title && <div className="font-semibold mb-1">{title}</div>}
      <div className="text-sm">{children}</div>
    </div>
  );
};

export default PageLayout;
