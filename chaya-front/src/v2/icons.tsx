/* ============================================================
   Icon system —— 24×24 linear strokes, round caps/joins by default.
   - 默认 stroke 1.7px（hover/active 时配合 css color 切换更克制）
   - strokeLinecap / strokeLinejoin = 'round' 让所有线条收尾柔和，
     摆脱"工程线框图"的冷感；polish 后的"hand-drawn ink"质感
   - 复杂图标增加 1-2 个细节 path（小圆点 / 高光 / 分割线）让每个图标都有
     "辨识细节"而不是泛 outline 集合
   - 所有 path 必须有显式 strokeWidth 才会绘制；继承 stroke 已设
   ============================================================ */
const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export const IconSidebar = () => (
  <svg viewBox="0 0 24 24" {...stroke}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
    <line x1="9.5" y1="4.5" x2="9.5" y2="19.5" />
    {/* 折叠 chip 暗示 */}
    <line x1="5.5" y1="9.5" x2="7.5" y2="9.5" />
    <line x1="5.5" y1="12.5" x2="7.5" y2="12.5" />
  </svg>
);

export const IconSearch = () => (
  <svg viewBox="0 0 24 24" {...stroke} strokeWidth={1.9}>
    <circle cx="11" cy="11" r="7" />
    <line x1="16.5" y1="16.5" x2="21" y2="21" />
  </svg>
);

// 对话泡 + 内部省略号（visible "对话进行中"细节），比纯泡更可读
export const IconChat = () => (
  <svg viewBox="0 0 24 24" {...stroke}>
    <path d="M4 12c0-4.4 3.6-8 8-8s8 3.6 8 8-3.6 8-8 8H4l2.5-3A8 8 0 0 1 4 12z" />
    <circle cx="9" cy="12" r="0.75" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="0.75" fill="currentColor" stroke="none" />
    <circle cx="15" cy="12" r="0.75" fill="currentColor" stroke="none" />
  </svg>
);

// 画廊：3 列分割 + 每列里一个小元素，"内容存在"
export const IconGallery = () => (
  <svg viewBox="0 0 24 24" {...stroke}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
    <path d="M9 4.5v15M15 4.5v15" />
    <circle cx="6.25" cy="9" r="0.9" fill="currentColor" stroke="none" />
    <path d="M11.25 16l1.6-1.6 1.4 1.4" />
  </svg>
);

// 书本/笔记本：左侧装订线加粗 + 两条内容横线，比纯"三条横线"更具体
export const IconKB = () => (
  <svg viewBox="0 0 24 24" {...stroke}>
    <rect x="4.5" y="4" width="15" height="16" rx="2.5" />
    <line x1="4.5" y1="4" x2="4.5" y2="20" strokeWidth={2.2} />
    <path d="M9 9h7M9 13h5" strokeWidth={1.5} />
  </svg>
);

// 三层堆叠（agent 顶端 + 工具链），主 agent 端点加圆点强调"主"
export const IconAgentPrimary = () => (
  <svg viewBox="0 0 24 24" {...stroke}>
    <path d="M3 8l9-5 9 5-9 5-9-5z" />
    <path d="M3 12l9 5 9-5M3 16l9 5 9-5" />
    <circle cx="12" cy="3" r="1.1" fill="currentColor" stroke="none" />
  </svg>
);

export const IconAgentPainter = () => (
  <svg viewBox="0 0 24 24" {...stroke}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
    <path d="M3.5 16l5-5 4 4 3-3 5 5" />
    <circle cx="9" cy="9" r="1.6" />
  </svg>
);

export const IconAgentDoc = () => (
  <svg viewBox="0 0 24 24" {...stroke}>
    <path d="M5.5 3.5h9l4 4v13h-13z" />
    <path d="M14 3.5v4h4" />
    <path d="M8 11h8M8 14h8M8 17h5" />
  </svg>
);

export const IconAgentCode = () => (
  <svg viewBox="0 0 24 24" {...stroke}>
    <polyline points="9 6 3 12 9 18" />
    <polyline points="15 6 21 12 15 18" />
    <line x1="13.5" y1="5" x2="10.5" y2="19" strokeWidth={1.4} opacity={0.55} />
  </svg>
);

export const IconPlus = () => (
  <svg viewBox="0 0 24 24" {...stroke} strokeWidth={2}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

export const IconGear = () => (
  <svg viewBox="0 0 24 24" {...stroke}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1A1.7 1.7 0 0 0 10 3.1V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1A1.7 1.7 0 0 0 20.9 10H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
);

// 真正的回形针，而不是之前误用 IconPlus 复制
export const IconAttach = () => (
  <svg viewBox="0 0 24 24" {...stroke}>
    <path d="M20 11.5l-8.4 8.4a5 5 0 0 1-7-7L13.3 4a3.5 3.5 0 0 1 5 4.95l-8.3 8.3a2 2 0 0 1-2.83-2.83l7.6-7.6" />
  </svg>
);

// 创作魔法棒（之前的"三角"实在太泛）
export const IconSkill = () => (
  <svg viewBox="0 0 24 24" {...stroke}>
    <path d="M5 19L14 10" />
    <path d="M15 5l2 2M19 9l2 2M11 5l1 2M18 14l2 1" />
    <path d="M14 10l2-2 4 4-2 2-4-4z" />
  </svg>
);

export const IconSend = () => (
  <svg viewBox="0 0 24 24" {...stroke} strokeWidth={2.1}>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
);

export const IconChevron = () => (
  <svg viewBox="0 0 24 24" {...stroke} strokeWidth={2}>
    <path d="M6 9l6 6 6-6" />
  </svg>
);

// 图片框 + 比例山尖；显式 layer
export const IconAspect = () => (
  <svg viewBox="0 0 24 24" {...stroke}>
    <rect x="3.5" y="6" width="17" height="12" rx="2.5" />
    <path d="M7.5 14.5l3-3 2.5 2 2-1.5" />
    <circle cx="8" cy="9.5" r="0.9" fill="currentColor" stroke="none" />
  </svg>
);

export const IconPin = ({ filled }: { filled?: boolean }) => (
  <svg viewBox="0 0 24 24" {...stroke} fill={filled ? 'currentColor' : 'none'}>
    <path d="M12 3.5l2.6 5.27 5.82.85-4.21 4.1.99 5.78L12 16.77 6.8 19.5l.99-5.78-4.21-4.1 5.82-.85z" />
  </svg>
);

export const IconEdit = () => (
  <svg viewBox="0 0 24 24" {...stroke}>
    <path d="M14.5 5.5l4 4" />
    <path d="M19 8.5a2 2 0 0 0-3-3L5 16l-1 4 4-1L19 8.5z" />
  </svg>
);

export const IconTrash = () => (
  <svg viewBox="0 0 24 24" {...stroke}>
    <path d="M4 7h16" />
    <path d="M9 7V5.5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5.5V7" />
    <path d="M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7" />
    <path d="M10 11v6M14 11v6" strokeWidth={1.4} opacity={0.65} />
  </svg>
);

export const IconDoc = () => (
  <svg viewBox="0 0 24 24" {...stroke}>
    <path d="M6 3h7l5 5v13H6z" />
    <path d="M13 3v5h5" />
    <path d="M9 13h6M9 16h4" strokeWidth={1.4} opacity={0.7} />
  </svg>
);

// Two stacked sheets — quick-copy affordance on code blocks.
export const IconCopy = () => (
  <svg viewBox="0 0 24 24" {...stroke}>
    <rect x="8.5" y="8.5" width="11" height="11" rx="2.5" />
    <path d="M5.5 15.5V6.5A2 2 0 0 1 7.5 4.5h9" />
  </svg>
);

// Lightweight tick — pairs with IconCopy for the "已复制" state.
export const IconCheck = () => (
  <svg viewBox="0 0 24 24" {...stroke} strokeWidth={1.9}>
    <polyline points="5 12.5 10 17 19 7.5" />
  </svg>
);

// Curved arrow rewinding to an earlier point — used for 回退 / 回退并编辑.
export const IconRevert = () => (
  <svg viewBox="0 0 24 24" {...stroke}>
    <path d="M4 8h9a5 5 0 1 1 0 10H7" />
    <path d="M7 5L4 8l3 3" />
  </svg>
);

// Quotation marks — used for 引用消息.
export const IconQuote = () => (
  <svg viewBox="0 0 24 24" {...stroke}>
    <path d="M7 7H4v6h4v-2c0-1.5-.4-2.6-1-3.3" />
    <path d="M17 7h-3v6h4v-2c0-1.5-.4-2.6-1-3.3" />
  </svg>
);
