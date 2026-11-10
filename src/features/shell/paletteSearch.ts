/**
 * fuzzy match for the command palette. every typed word must match. per word, best tier wins:
 * 0 prefix of the title, 1 start of a word, 2 substring, 3 letters in order, 4 found in the group name.
 * rank = sum of the tiers (lower is better), ties keep the input order.
 */

export interface Searchable {
  title: string;
  group?: string;
}

export function words(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function inOrder(word: string, text: string): boolean {
  let at = 0;
  for (const ch of text) {
    if (ch === word[at]) at++;
    if (at === word.length) return true;
  }
  return false;
}

/** tier of one word against a title (+ group), or null when it does not match */
export function wordTier(word: string, title: string, group = ''): number | null {
  const t = title.toLowerCase();
  if (t.startsWith(word)) return 0;
  let first = -1;
  for (let i = t.indexOf(word); i >= 0; i = t.indexOf(word, i + 1)) {
    if (first < 0) first = i;
    if (/[^a-z0-9]/.test(t[i - 1]!)) return 1;
  }
  if (first >= 0) return 2;
  if (inOrder(word, t)) return 3;
  if (group.toLowerCase().includes(word)) return 4;
  return null;
}

/** rank of an item for a query (lower = better), or null when it does not match. empty query = 0 */
export function rankItem(query: string, item: Searchable): number | null {
  const ws = words(query);
  let sum = 0;
  for (const w of ws) {
    const tier = wordTier(w, item.title, item.group);
    if (tier === null) return null;
    sum += tier;
  }
  return sum;
}

/** the matching items, best first; ties keep the input order */
export function searchItems<T extends Searchable>(query: string, items: readonly T[]): T[] {
  if (words(query).length === 0) return items.slice();
  const ranked: { item: T; rank: number; index: number }[] = [];
  items.forEach((item, index) => {
    const rank = rankItem(query, item);
    if (rank !== null) ranked.push({ item, rank, index });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return ranked.map((r) => r.item);
}
