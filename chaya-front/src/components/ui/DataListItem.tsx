/**
 * 数据列表项组件 - 封装常用的列表项展示模式
 * 用于替代重复的列表项布局代码
 */

import React from 'react';
import { ListItem } from './PageLayout';
import { Button } from './Button';
import { IconButton } from './IconButton';
import { cn } from '@/utils/cn';
import { LucideIcon, Edit2, Trash2 } from 'lucide-react';

export interface DataListItemProps {
  // 基础属性
  id: string;
  title: string;
  description?: string;
  avatar?: string | React.ReactNode;
  icon?: LucideIcon;
  
  // 状态
  isSelected?: boolean;
  isActive?: boolean;
  badge?: React.ReactNode;
  
  // 交互
  onClick?: () => void;
  onDelete?: (e: React.MouseEvent) => void;
  onEdit?: (e: React.MouseEvent) => void;
  actions?: React.ReactNode;
  
  // 样式
  className?: string;
  disabled?: boolean;
}

/**
 * 数据列表项 - 用于会话列表、配置列表等场景
 * 
 * @example
 * <DataListItem
 *   id={item.id}
 *   title={item.name}
 *   description={item.description}
 *   avatar={item.avatar}
 *   isSelected={selectedId === item.id}
 *   onClick={() => handleSelect(item.id)}
 *   onDelete={(e) => handleDelete(e, item.id)}
 * />
 */
export const DataListItem: React.FC<DataListItemProps> = ({
  id,
  title,
  description,
  avatar,
  icon: Icon,
  isSelected = false,
  isActive = false,
  badge,
  onClick,
  onDelete,
  onEdit,
  actions,
  className,
  disabled = false,
}) => {
  const handleClick = () => {
    if (!disabled && onClick) {
      onClick();
    }
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onDelete) {
      onDelete(e);
    }
  };

  const handleEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onEdit) {
      onEdit(e);
    }
  };

  return (
    <ListItem
      active={isSelected || isActive}
      onClick={handleClick}
      disabled={disabled}
      className={cn('w-full group', className)}
    >
      <div className="flex items-center gap-3 w-full">
        {/* 左侧操作按钮 */}
        {(onDelete || onEdit || actions) && (
          <div className="flex items-center gap-1 flex-shrink-0">
            {onDelete && (
              <IconButton
                icon={Trash2}
                label="删除"
                onClick={handleDelete}
                variant="ghost"
                size="icon"
                className="w-7 h-7 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
              />
            )}
            {onEdit && (
              <IconButton
                icon={Edit2}
                label="编辑"
                onClick={handleEdit}
                variant="ghost"
                size="icon"
                className="w-7 h-7"
              />
            )}
            {actions}
          </div>
        )}

        {/* 内容区域 */}
        <div className="flex items-center gap-3 flex-1 min-w-0">
          {/* 头像/图标 */}
          {avatar && (
            <div className="flex-shrink-0 w-8 h-8 rounded-full overflow-hidden bg-mutedToken flex items-center justify-center">
              {typeof avatar === 'string' ? (
                <img src={avatar} alt={title} className="w-full h-full object-cover" />
              ) : (
                avatar
              )}
            </div>
          )}
          {Icon && !avatar && (
            <div className="flex-shrink-0 w-8 h-8 rounded-full bg-mutedToken flex items-center justify-center">
              <Icon className="w-4 h-4 text-mutedToken-foreground" />
            </div>
          )}

          {/* 文本内容 */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <div className="font-medium text-sm truncate select-text">{title}</div>
              {badge}
            </div>
            {description && (
              <div className="text-xs text-mutedToken-foreground truncate mt-0.5 select-text">
                {description}
              </div>
            )}
          </div>
        </div>
      </div>
    </ListItem>
  );
};

