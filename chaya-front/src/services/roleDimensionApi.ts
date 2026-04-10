/**
 * 角色生成器自定义维度选项 API
 */

import { getBackendUrl } from '../utils/backendUrl';

const API_BASE = `${getBackendUrl()}/api`;

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
    const response = await fetch(
      `${API_BASE}/role-generator/dimension-options?dimension_type=${encodeURIComponent(dimensionType)}&role_type=${encodeURIComponent(roleType)}`
    );
    if (!response.ok) {
      console.warn(`Failed to fetch dimension options: ${response.statusText}`);
      return [];
    }
    const data = await response.json();
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
    const response = await fetch(`${API_BASE}/role-generator/dimension-options`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        dimension_type: dimensionType,
        role_type: roleType,
        option_value: optionValue,
      }),
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `Failed to save dimension option: ${response.statusText}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error('Error saving dimension option:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

