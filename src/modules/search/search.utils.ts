import type { SearchChunk } from '../../common/types.js';
import type { SearchScope, SearchSensitivity } from './search.dto.js';

export type DatabaseChunk = {
  id: string;
  nodeId: string;
  name: string;
  content: string;
};

export function chunkText(
  source: DatabaseChunk,
  graphId: string,
): SearchChunk[] {
  const text = source.content;
  if (!text || !text.trim()) return [];

  const rawSections = text.split(/\n\s*\n/);
  const chunks: SearchChunk[] = [];
  let currentSearchOffset = 0;

  for (const rawSection of rawSections) {
    const trimmed = rawSection.trim();
    if (!trimmed) continue;

    const matchIndex = text.indexOf(rawSection, currentSearchOffset);
    const sectionStart = matchIndex >= 0 ? matchIndex : currentSearchOffset;
    const sectionEnd = sectionStart + rawSection.length;
    currentSearchOffset = sectionEnd;

    // Single concise paragraph or section kept intact
    if (trimmed.length <= 450) {
      chunks.push({
        graphId,
        sourceId: source.id,
        sourceName: source.name,
        nodeId: source.nodeId,
        content: trimmed,
        context: trimmed,
        startChar: sectionStart,
        endChar: sectionEnd,
        pageNum: 1,
        score: 0,
      });
    } else {
      // Longer section: split along list items or sentence boundaries
      const items = trimmed.split(/(?=\n- )|(?<=[.?!])\s+/);
      let buffer = '';
      let itemStart = sectionStart;

      for (const item of items) {
        if (buffer.length + item.length > 350 && buffer.length > 0) {
          const itemEnd = itemStart + buffer.length;
          chunks.push({
            graphId,
            sourceId: source.id,
            sourceName: source.name,
            nodeId: source.nodeId,
            content: buffer.trim(),
            context: trimmed,
            startChar: itemStart,
            endChar: itemEnd,
            pageNum: 1,
            score: 0,
          });
          itemStart = itemEnd + 1;
          buffer = item;
        } else {
          buffer = buffer ? `${buffer} ${item}` : item;
        }
      }

      if (buffer.trim().length > 0) {
        chunks.push({
          graphId,
          sourceId: source.id,
          sourceName: source.name,
          nodeId: source.nodeId,
          content: buffer.trim(),
          context: trimmed,
          startChar: itemStart,
          endChar: sectionEnd,
          pageNum: 1,
          score: 0,
        });
      }
    }
  }

  return chunks;
}

export function adjacentNodes(
  nodeId: string,
  edges: Array<{ source: string; target: string }>,
): string[] {
  return [
    ...new Set(
      edges.flatMap((edge) =>
        edge.source === nodeId
          ? [edge.target]
          : edge.target === nodeId
            ? [edge.source]
            : [],
      ),
    ),
  ].filter((id) => id !== nodeId);
}

export function lexicalScore(content: string, query: string): number {
  const haystack = content.toLowerCase();
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 1)
    .reduce((score, term) => score + occurrences(haystack, term), 0);
}

export function occurrences(content: string, term: string): number {
  return content.split(term).length - 1;
}

export function groupChunks(
  chunks: SearchChunk[],
  scope: SearchScope = 'normal',
): Array<{ nodeId: string; matchCount: number; chunks: SearchChunk[] }> {
  const maxPerNode = scope === 'narrow' ? 2 : scope === 'wide' ? 8 : 4;
  const byNode = new Map<string, SearchChunk[]>();
  for (const chunk of chunks) {
    const items = byNode.get(chunk.nodeId) ?? [];
    if (items.length < maxPerNode) {
      items.push(chunk);
    }
    byNode.set(chunk.nodeId, items);
  }
  return [...byNode.entries()]
    .map(([nodeId, items]) => ({
      nodeId,
      matchCount: items.length,
      chunks: items,
    }))
    .sort(
      (left, right) =>
        (right.chunks[0]?.score ?? 0) - (left.chunks[0]?.score ?? 0),
    );
}

export function getSensitivityThresholds(
  sensitivity: SearchSensitivity = 'medium',
): {
  vectorThreshold: number;
  minLexScore: number;
} {
  switch (sensitivity) {
    case 'high':
      return { vectorThreshold: 0.55, minLexScore: 3 };
    case 'low':
      return { vectorThreshold: 0.1, minLexScore: 1 };
    case 'medium':
    default:
      return { vectorThreshold: 0.28, minLexScore: 2 };
  }
}

export const TABULAR_INTENT_PATTERN =
  /\b(table|schedule|grad(e|ing)|scores?|percent(age)?|breakdown|weights?|deadlines?|dates?|matrix|compar(e|ison)|credits?|syllabus|distribution|scale|rubric)\b/i;

export function isTabularQuery(query: string): boolean {
  return TABULAR_INTENT_PATTERN.test(query);
}

export function isTableChunk(chunk: {
  elementType?: string;
  content?: string;
}): boolean {
  if (chunk.elementType === 'table') return true;
  if (!chunk.content) return false;
  return /\|.+?\|.+?\|\n\|[- :|]+\|/m.test(chunk.content);
}

export function applyTabularBoosting<T extends { chunk: SearchChunk }>(
  items: T[],
  query: string,
  boostFactor = 1.35,
): T[] {
  if (!isTabularQuery(query)) {
    return items;
  }
  return items
    .map((item) => {
      if (isTableChunk(item.chunk)) {
        return {
          ...item,
          chunk: {
            ...item.chunk,
            score: Number((item.chunk.score * boostFactor).toFixed(4)),
          },
        };
      }
      return item;
    })
    .sort((a, b) => b.chunk.score - a.chunk.score);
}
