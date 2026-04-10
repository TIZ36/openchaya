const DEFAULT_CAREER_PROFESSIONS = [
  '产品经理',
  '工程师',
  '设计师',
  '作家',
  '分析师',
  '教师',
  '医生',
  '咨询师',
  '创业者',
  '研究员',
  '营销专家',
  '财务顾问',
];

const DEFAULT_GAME_PROFESSIONS = [
  '战士',
  '法师',
  '盗贼',
  '牧师',
  '游侠',
  '术士',
  '圣骑士',
  '德鲁伊',
  '野蛮人',
  '吟游诗人',
];

export function getDefaultCareerProfessions() {
  return DEFAULT_CAREER_PROFESSIONS;
}

export function getDefaultGameProfessions() {
  return DEFAULT_GAME_PROFESSIONS;
}

export function extractProfession(
  name: string | null | undefined,
  systemPrompt: string | null | undefined,
  professionList: string[]
): string | null {
  // 先从名称中提取
  if (name) {
    for (const keyword of professionList) {
      if (name.includes(keyword)) {
        return keyword;
      }
    }
  }
  // 再从人设中提取
  if (systemPrompt) {
    // 先尝试匹配 "职业：xxx" 格式
    const professionMatch = systemPrompt.match(/职业[：:]\s*([^\n,，。]+)/);
    if (professionMatch) {
      const matched = professionMatch[1].trim();
      if (professionList.includes(matched)) {
        return matched;
      }
    }
    // 再尝试关键词匹配
    for (const keyword of professionList) {
      if (systemPrompt.includes(keyword)) {
        return keyword;
      }
    }
  }
  return null;
}

export function applyProfessionToNameOrPrompt(
  profession: string | null,
  currentName: string,
  currentSystemPrompt: string,
  professionList: string[]
): { name: string; systemPrompt: string } {
  let newName = currentName;
  let newSystemPrompt = currentSystemPrompt;

  if (!profession) {
    // 如果选择"无"，移除名称中的职业关键词
    for (const keyword of professionList) {
      if (newName.includes(keyword)) {
        newName = newName.replace(keyword, '').trim();
        break;
      }
    }
    // 移除人设中的职业标记
    newSystemPrompt = newSystemPrompt.replace(/职业[：:]\s*[^\n,，。]+/g, '').trim();
    return { name: newName, systemPrompt: newSystemPrompt };
  }

  // 检查名称中是否已有职业关键词
  let nameHasProfession = false;
  for (const keyword of professionList) {
    if (newName.includes(keyword)) {
      nameHasProfession = true;
      // 替换为新的职业
      newName = newName.replace(keyword, profession).trim();
      break;
    }
  }

  // 如果名称中没有职业，添加到名称中
  if (!nameHasProfession && newName) {
    newName = `${profession} ${newName}`.trim();
  }

  // 更新人设中的职业标记
  if (newSystemPrompt.match(/职业[：:]\s*[^\n,，。]+/)) {
    newSystemPrompt = newSystemPrompt.replace(/职业[：:]\s*[^\n,，。]+/, `职业：${profession}`);
  } else if (newSystemPrompt) {
    // 如果人设不为空但没有职业标记，在开头添加
    newSystemPrompt = `职业：${profession}\n\n${newSystemPrompt}`;
  } else {
    newSystemPrompt = `职业：${profession}`;
  }

  return { name: newName, systemPrompt: newSystemPrompt };
}

export function detectProfessionType(
  name: string | null | undefined,
  systemPrompt: string | null | undefined
): 'career' | 'game' {
  const allText = `${name || ''} ${systemPrompt || ''}`;
  for (const keyword of DEFAULT_GAME_PROFESSIONS) {
    if (allText.includes(keyword)) return 'game';
  }
  return 'career';
}


