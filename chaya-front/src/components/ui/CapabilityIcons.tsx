/**
 * 模型能力图标（识图/生图/生视频/生语音/思考）
 * 与 utils/modelCapabilities 配合使用
 */

import React from 'react';
import { Eye, Image as ImageIcon, Video, Mic, Brain } from 'lucide-react';
import type { ModelCapabilities } from '../../services/modelListService';
import { getDisplayCapabilities, CAPABILITY_TITLES } from '../../utils/modelCapabilities';

export interface CapabilityIconsProps {
  capabilities: ModelCapabilities | null | undefined;
  modelName?: string;
  className?: string;
}

export function CapabilityIcons({ capabilities, modelName, className = 'w-3 h-3' }: CapabilityIconsProps) {
  const display = getDisplayCapabilities(capabilities, modelName);
  if (!display) return null;
  return (
    <div className="flex items-center gap-1 shrink-0">
      {display.vision && <span title={CAPABILITY_TITLES.vision}><Eye className={`${className} text-blue-500 [data-skin='niho']:text-[#00e5ff]`} /></span>}
      {display.image_gen && <span title={CAPABILITY_TITLES.image_gen}><ImageIcon className={`${className} text-purple-500 [data-skin='niho']:text-[#ff6b9d]`} /></span>}
      {display.video_gen && <span title={CAPABILITY_TITLES.video_gen}><Video className={`${className} text-green-500 [data-skin='niho']:text-[#00ff88]`} /></span>}
      {display.speech_gen && <span title={CAPABILITY_TITLES.speech_gen}><Mic className={`${className} text-amber-500 [data-skin='niho']:text-[#ffd700]`} /></span>}
      {display.thinking && <span title={CAPABILITY_TITLES.thinking}><Brain className={`${className} text-indigo-500 [data-skin='niho']:text-[#a78bfa]`} /></span>}
    </div>
  );
}
