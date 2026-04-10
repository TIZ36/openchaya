/**
 * 角色生成器 API 服务
 * 使用 LLM 生成和优化角色人设、头像及标签
 */

import { getCurrentLLMClient, LLMMessage } from './llmClient';

export type RolePropertyType = 'name' | 'system_prompt' | 'description' | 'tags';

export interface RoleGenerationResult {
  name: string;
  system_prompt: string;
  description: string;
  tags: string[];
  avatar?: string;
}

/**
 * 根据用户描述生成角色完整信息
 */
export async function generateRole(prompt: string): Promise<RoleGenerationResult> {
  const client = getCurrentLLMClient();
  if (!client) {
    throw new Error('未配置有效的 LLM 模型，请先在设置中配置');
  }

  const systemPrompt = `你是一个资深的角色设计专家和人设架构师。
你的任务是根据用户提供的简单描述，设计一个极具个性、背景丰满、对话风格独特的 AI 角色。

请以 JSON 格式返回结果，包含以下字段：
- name: 角色的名字
- system_prompt: 详细的角色系统提示词（System Prompt），定义其性格、说话方式、知识背景、禁忌等。
- description: 对角色的简短介绍（用于列表展示）。
- tags: 角色的标签数组（如：毒舌, 程序员, 侦探, 冷静, 幽默 等）。

注意：system_prompt 应该是高质量、专业的，能够直接指导大模型扮演该角色。`;

  const messages: LLMMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `请为我设计一个角色，描述如下：${prompt}` }
  ];

  const response = await client.chat(messages);
  
  // 尝试从响应中提取 JSON
  const content = response.content;
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('模型返回格式不正确，未能解析 JSON');
  }

  try {
    const result = JSON.parse(jsonMatch[0]);
    return {
      name: result.name || '未知角色',
      system_prompt: result.system_prompt || '',
      description: result.description || '',
      tags: Array.isArray(result.tags) ? result.tags : [],
    };
  } catch (e) {
    throw new Error('解析角色数据失败');
  }
}

/**
 * 针对角色的某个属性进行单独优化或重试
 */
export async function refineRoleProperty(currentRole: RoleGenerationResult, type: RolePropertyType): Promise<string> {
  const client = getCurrentLLMClient();
  if (!client) {
    throw new Error('未配置有效的 LLM 模型');
  }

  const typeNames: Record<string, string> = {
    name: '名字',
    system_prompt: '人设指令 (System Prompt)',
    description: '简短描述',
    tags: '标签'
  };

  const systemPrompt = `你是一个资深的角色设计专家。
当前我们正在设计一个角色：
名字：${currentRole.name}
简介：${currentRole.description}
标签：${currentRole.tags.join(', ')}

请针对该角色的「${typeNames[type]}」进行重新设计或优化。
如果是名字，请给出一个更有创意、更符合人设的名字。
如果是系统提示词，请扩充细节，增强性格特色。
如果是标签，请提供一组更精准、更具辨识度的标签（逗号分隔）。

只需返回优化后的「${typeNames[type]}」内容本身，不要返回其他解释。`;

  const messages: LLMMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: '请开始优化。' }
  ];

  const response = await client.chat(messages);
  return response.content.trim();
}

/**
 * 为角色生成头像（支持指定 LLM 配置）
 * @param role 角色信息
 * @param llmConfigId 指定 LLM 配置 ID（可选，不指定时使用当前配置）
 * @param llmClient 指定 LLM 客户端（可选，用于自定义配置）
 */
export async function generateRoleAvatar(
  role: RoleGenerationResult,
  llmConfigId?: string,
  llmClient?: any
): Promise<string> {
  let client = llmClient;
  
  if (!client) {
    // 如果未提供客户端，使用当前配置
    client = getCurrentLLMClient();
    if (!client) {
      throw new Error('未配置有效的 LLM 模型');
    }
  }

  // 如果模型支持图片生成（如 Gemini 2.0 Flash Image），则可以尝试直接生成
  // 否则，这里可能需要调用专门的绘图 API 或返回一个特定的 placeholder
  
  // 临时方案：如果是支持媒体输出的模型，尝试请求图片
  const messages: LLMMessage[] = [
    { 
      role: 'system', 
      content: `你是一个 AI 画师。请为以下角色设计并生成一张头像：
名字：${role.name}
描述：${role.description}
标签：${role.tags.join(', ')}

请根据角色的性格和背景，生成一张高质量、符合气质的头像。` 
    },
    { role: 'user', content: '请为我生成头像。' }
  ];

  const response = await client.chat(messages);
  
  if (response.media && response.media.length > 0) {
    const item = response.media[0];
    return `data:${item.mimeType};base64,${item.data}`;
  }

  // 如果模型不支持直接生成图片，目前返回一个基于名字的 placeholder URL 
  // 或者提示用户该模型不支持图片生成
  throw new Error('当前选中的模型不支持直接生成图片，请手动上传头像。');
}

