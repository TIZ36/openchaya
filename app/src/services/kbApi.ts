/**
 * Knowledge-base RAG "answer with citations" —— 原本走 Chaya 自有后端的
 * POST /api/kb/answer。纯客户端化后该后端已退役；检索仍由 SmartNote Cloud 提供，
 * 但「带引用的成文回答」这步暂无本地替代，故明确报不可用，而非抛 fetch 异常。
 */

export interface KBAnswerChunk {
  n: number;             // citation index the answer will reference as [n]
  document_name: string;
  text: string;
}

/** 已退役：成文回答依赖已删除的 Chaya 后端。改用知识库检索 + 本地 agent 自行作答。 */
export async function kbAnswer(
  _query: string,
  _chunks: KBAnswerChunk[],
  _configId?: string,
): Promise<string> {
  throw new Error('「带引用的成文回答」已随 Chaya 服务器退役；请用知识库检索结果在本地 agent 中提问。');
}
