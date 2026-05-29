/**
 * Knowledge-base helpers that hit Chaya's OWN backend (not Smartnote Cloud).
 * Currently: the RAG "answer with citations" endpoint, which runs one LLM
 * completion over chunks the frontend already retrieved from Smartnote Cloud.
 */
import { api } from '../utils/apiClient';

export interface KBAnswerChunk {
  n: number;             // citation index the answer will reference as [n]
  document_name: string;
  text: string;
}

/** POST /api/kb/answer → grounded answer string citing [N]. */
export async function kbAnswer(
  query: string,
  chunks: KBAnswerChunk[],
  configId?: string,
): Promise<string> {
  const res = await api.post<{ answer: string }>('/api/kb/answer', {
    query,
    chunks,
    config_id: configId,
  });
  return res?.answer || '';
}
