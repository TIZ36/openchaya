/**
 * 角色生成器自定义维度选项 API
 */

import { api } from '../utils/apiClient';

export interface DimensionOption {
  option_id: string;
  dimension_type: string;
  role_type: 'career' | 'game';
  option_value: string;
  created_at?: string;
  updated_at?: string;
}

/**
 * 获取自定义维度选项
 */
export async function getDimensionOptions(
  dimensionType: string,
  roleType: 'career' | 'game'
): Promise<string[]> {
  try {
    const data = await api.get<{ options?: string[] }>(
      `/api/role-generator/dimension-options?dimension_type=${encodeURIComponent(dimensionType)}&role_type=${encodeURIComponent(roleType)}`
    );
    return data.options || [];
  } catch (error) {
    console.warn('Error fetching dimension options:', error);
    return [];
  }
}

/**
 * 保存自定义维度选项
 */
export async function saveDimensionOption(
  dimensionType: string,
  roleType: 'career' | 'game',
  optionValue: string
): Promise<{ success: boolean; option_id?: string; option_value?: string; error?: string }> {
  try {
    return await api.post<{ success: boolean; option_id?: string; option_value?: string; error?: string }>(
      '/api/role-generator/dimension-options',
      {
        dimension_type: dimensionType,
        role_type: roleType,
        option_value: optionValue,
      }
    );
  } catch (error) {
    console.error('Error saving dimension option:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
