const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8 } as const;

export const IconSidebar = () => (
  <svg viewBox="0 0 24 24" {...stroke}><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><line x1="9.5" y1="4.5" x2="9.5" y2="19.5" /></svg>
);
export const IconNewChat = () => (
  <svg viewBox="0 0 24 24" {...stroke}><path d="M16 4l4 4-11 11H5v-4L16 4z" /></svg>
);
export const IconSearch = () => (
  <svg viewBox="0 0 24 24" {...stroke} strokeWidth={2}><circle cx="11" cy="11" r="7" /><line x1="16.5" y1="16.5" x2="21" y2="21" /></svg>
);
export const IconChat = () => (
  <svg viewBox="0 0 24 24" {...stroke}><path d="M4 12c0-4.4 3.6-8 8-8s8 3.6 8 8-3.6 8-8 8H4l2.5-3A8 8 0 0 1 4 12z" /></svg>
);
export const IconGallery = () => (
  <svg viewBox="0 0 24 24" {...stroke}><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M9 4.5v15M15 4.5v15" /></svg>
);
export const IconKB = () => (
  <svg viewBox="0 0 24 24" {...stroke}><path d="M4 6h16M4 12h16M4 18h10" /></svg>
);
export const IconAgentPrimary = () => (
  <svg viewBox="0 0 24 24" {...stroke}><path d="M3 8l9-5 9 5-9 5-9-5z" /><path d="M3 12l9 5 9-5M3 16l9 5 9-5" /></svg>
);
export const IconAgentPainter = () => (
  <svg viewBox="0 0 24 24" {...stroke}><rect x="3.5" y="3.5" width="17" height="17" rx="2.5" /><path d="M3.5 16l5-5 4 4 3-3 5 5" /><circle cx="9" cy="9" r="1.5" /></svg>
);
export const IconAgentDoc = () => (
  <svg viewBox="0 0 24 24" {...stroke}><path d="M5 4h11l3 3v13H5z" /><path d="M8 9h8M8 13h8M8 17h5" /></svg>
);
export const IconAgentCode = () => (
  <svg viewBox="0 0 24 24" {...stroke}><polyline points="9 6 3 12 9 18" /><polyline points="15 6 21 12 15 18" /></svg>
);
export const IconPlus = () => (
  <svg viewBox="0 0 24 24" {...stroke} strokeWidth={2}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
);
export const IconGear = () => (
  <svg viewBox="0 0 24 24" {...stroke}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1A1.7 1.7 0 0 0 10 3.1V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1A1.7 1.7 0 0 0 20.9 10H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>
);
export const IconShare = () => (
  <svg viewBox="0 0 24 24" {...stroke}><path d="M12 4v10M8 8l4-4 4 4M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" /></svg>
);
export const IconMore = () => (
  <svg viewBox="0 0 24 24" {...stroke}><circle cx="6" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="18" cy="12" r="1.5" /></svg>
);
export const IconAttach = () => (
  <svg viewBox="0 0 24 24" {...stroke}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
);
export const IconTool = () => (
  <svg viewBox="0 0 24 24" {...stroke}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>
);
export const IconSkill = () => (
  <svg viewBox="0 0 24 24" {...stroke}><path d="M12 4l8 14H4z" /></svg>
);
export const IconMic = () => (
  <svg viewBox="0 0 24 24" {...stroke}><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
);
export const IconSend = () => (
  <svg viewBox="0 0 24 24" {...stroke} strokeWidth={2.2}><path d="M12 19V5M5 12l7-7 7 7" /></svg>
);
export const IconChevron = () => (
  <svg viewBox="0 0 24 24" {...stroke} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
);
export const IconAspect = () => (
  <svg viewBox="0 0 24 24" {...stroke} strokeWidth={1.8} strokeLinejoin="round"><rect x="3.5" y="6" width="17" height="12" rx="2" /><path d="M7.5 14.5l3-3 2.5 2 2-1.5" /></svg>
);
export const IconPin = ({ filled }: { filled?: boolean }) => (
  <svg viewBox="0 0 24 24" {...stroke} fill={filled ? 'currentColor' : 'none'} strokeWidth={1.7} strokeLinejoin="round">
    <path d="M12 3.5l2.6 5.27 5.82.85-4.21 4.1.99 5.78L12 16.77 6.8 19.5l.99-5.78-4.21-4.1 5.82-.85z" />
  </svg>
);
export const IconEdit = () => (
  <svg viewBox="0 0 24 24" {...stroke} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 5.5l4 4M4 20l4.5-1L19 8.5a2 2 0 0 0-3-3L5 16l-1 4z" /></svg>
);
export const IconTrash = () => (
  <svg viewBox="0 0 24 24" {...stroke} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M9 7V5.5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5.5V7M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7" /></svg>
);
export const IconDoc = () => (
  <svg viewBox="0 0 24 24" {...stroke} strokeWidth={1.7} strokeLinejoin="round"><path d="M6 3h7l5 5v13H6z" /><path d="M13 3v5h5" /></svg>
);
// Curved arrow rewinding to an earlier point — used for 回退 / 回退并编辑.
export const IconRevert = () => (
  <svg viewBox="0 0 24 24" {...stroke} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round"><path d="M4 8h9a5 5 0 1 1 0 10H7" /><path d="M7 5L4 8l3 3" /></svg>
);
// Quotation marks — used for 引用消息.
export const IconQuote = () => (
  <svg viewBox="0 0 24 24" {...stroke} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round"><path d="M7 7H4v6h4v-2c0-1.5-.4-2.6-1-3.3" /><path d="M17 7h-3v6h4v-2c0-1.5-.4-2.6-1-3.3" /></svg>
);
