/* ------------------------------------------------------------------ *
 * AgentFace —— 升格后 Agent 的头像：Notion Faces 风格（faces.notion.com）。
 *
 * 用 DiceBear 的 notionists 合集（即从 Notion 头像素材构建的那套手绘脸），按 seed=agent
 * 名/ID 确定性生成，同一个 agent 永远同一张脸；纯本地生成、不联网、不支持编辑。
 * 透明底，外层头像 chip 提供暖纸底色（黑色线条脸在明暗主题下都清晰）。
 * ------------------------------------------------------------------ */
import React, { useMemo } from 'react';
import { createAvatar } from '@dicebear/core';
import { notionists } from '@dicebear/collection';

// 同一 seed 的 SVG 缓存，避免列表里重复生成（每张约 12KB）。
const cache = new Map<string, string>();
function faceSvg(seed: string): string {
  const key = seed || '?';
  let s = cache.get(key);
  if (!s) {
    s = createAvatar(notionists, { seed: key, backgroundColor: ['transparent'], radius: 0 }).toString();
    cache.set(key, s);
  }
  return s;
}

export const AgentFace: React.FC<{ seed: string; className?: string }> = ({ seed, className }) => {
  const svg = useMemo(() => faceSvg(seed), [seed]);
  // display:contents 让宿主 span 不进盒模型，内部 <svg> 直接受外层 .av chip 的 `svg{width:100%}` 约束。
  return <span className={className} aria-hidden style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: svg }} />;
};
