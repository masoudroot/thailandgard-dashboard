/**
 * فیکسچر RAG برای تست یکپارچگی نقد←دانش.
 * ایندکس در حافظه انجام می‌شود؛ جست‌وجو کلیدواژه‌ای ساده است.
 */
export const ragState = {
  indexed: [],
  searchIndex: [],
};

export async function indexKnowledge(knowledgeId, team, title, content) {
  ragState.indexed.push({ knowledgeId, team, title, content });
  ragState.searchIndex.push({
    knowledgeId,
    team,
    title,
    text: `${title}\n${content}`,
  });
}

export async function retrieveKnowledge(query, team, limit = 5) {
  const words = String(query).split(/\s+/).filter((w) => w.length > 2);
  const hits = ragState.searchIndex
    .filter((e) => !team || e.team === team)
    .map((e) => ({ e, score: words.filter((w) => e.text.includes(w)).length }))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  if (hits.length === 0) return '';
  return hits
    .map((h, i) => `[${i + 1}] ${h.e.title}\n${h.e.text.slice(0, 300)}`)
    .join('\n\n');
}

export function resetRag() {
  ragState.indexed = [];
  ragState.searchIndex = [];
}
