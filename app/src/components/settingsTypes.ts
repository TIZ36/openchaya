/* 设置相关共享类型（从已退役的 components/SettingsPage.tsx 抽出）。
 * 纯客户端化后旧 SettingsPage 云端设置组件已删除，但这些类型仍被 v2 设置面板复用。 */
import type { TypeSpeed } from '../v2/typewriter';

export type { TypeSpeed };

export type FontId = 'default' | 'pixel' | 'terminal' | 'firacode' | 'rounded' | 'dotgothic' | 'silkscreen';
export type AppearanceMode = 'light' | 'dark' | 'system';
export type ColorTheme = 'default' | 'anthropic' | 'razer' | 'codex';
/** 可单独开启毛玻璃的界面区域。 */
export type GlassZone = 'composer' | 'sidebar' | 'topbar' | 'menu' | 'modal' | 'bubble' | 'main';
/** 毛玻璃整体强度（模糊+透明度）：subtle 轻 · standard 标准 · strong 强。 */
export type GlassIntensity = 'subtle' | 'standard' | 'strong';

export interface ClientSettings {
  font: FontId;
  appearance?: AppearanceMode;
  theme?: ColorTheme;
  /** 开启了毛玻璃的区域列表。默认 composer / menu / modal。 */
  glassZones?: GlassZone[];
  /** 毛玻璃整体强度。默认 standard。 */
  glassIntensity?: GlassIntensity;
  enableToolCalling: boolean;
  density?: 'relaxed' | 'normal' | 'compact';
  handRule?: boolean;
  cmdEnterToSend?: boolean;
  showTokenCost?: boolean;
  autoTTS?: boolean;
  ragEnabled?: boolean;
  ragTopK?: number;
  ragScope?: 'auto' | 'agent' | 'workspace';
  defaultLLMConfigId?: string;
  /** Local Agents 默认 provider（本地功能，桌面版）。 */
  localAgentProvider?: 'claude' | 'cursor' | 'codex' | 'gemini' | 'copilot';
  /** 对话出字平滑：开关 + 速度档。默认开 / 适中。 */
  chatStreamSmooth?: boolean;
  chatStreamSpeed?: TypeSpeed;
  /** CLI(本地 Agent) 出字平滑：开关 + 速度档。默认开 / 适中。 */
  cliStreamSmooth?: boolean;
  cliStreamSpeed?: TypeSpeed;
}
