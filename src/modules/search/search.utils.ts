import type { LeadAnswerType, SearchChunk } from '../../common/types.js';
import type {
  CrawlEdge,
  CrawlMatchType,
  CrawlNode,
  SearchScope,
  SearchSensitivity,
} from './search.dto.js';

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

export type GraphEdgeLike = {
  source: string;
  target: string;
  label?: string;
  type?: string;
  data?: {
    relation?: string;
    weight?: number;
    [key: string]: unknown;
  };
};

export const RELATION_WEIGHTS: Record<string, number> = {
  parent_of: 1.5,
  contains: 1.4,
  implements: 1.3,
  causes: 1.3,
  depends_on: 1.2,
  part_of: 1.2,
  relates_to: 1.0,
  references: 0.9,
};

export function getEdgeWeight(edge: GraphEdgeLike): number {
  if (edge.data?.weight && typeof edge.data.weight === 'number') {
    return edge.data.weight;
  }
  const rel = (
    edge.data?.relation ||
    edge.label ||
    edge.type ||
    ''
  ).toLowerCase();
  for (const [key, weight] of Object.entries(RELATION_WEIGHTS)) {
    if (rel.includes(key)) return weight;
  }
  return 1.0;
}

export function adjacentNodes(
  nodeId: string,
  edges: GraphEdgeLike[],
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

export function connectedNodes(
  nodeId: string,
  edges: GraphEdgeLike[],
  direction: 'forward' | 'backward' | 'both' = 'forward',
): string[] {
  let matchedEdges: Array<{ neighborId: string; weight: number }> = [];

  if (direction === 'forward') {
    matchedEdges = edges
      .filter((edge) => edge.source === nodeId && edge.target !== nodeId)
      .map((edge) => ({
        neighborId: edge.target,
        weight: getEdgeWeight(edge),
      }));
  } else if (direction === 'backward') {
    matchedEdges = edges
      .filter((edge) => edge.target === nodeId && edge.source !== nodeId)
      .map((edge) => ({
        neighborId: edge.source,
        weight: getEdgeWeight(edge),
      }));
  } else {
    matchedEdges = edges.flatMap((edge) => {
      const results: Array<{ neighborId: string; weight: number }> = [];
      const weight = getEdgeWeight(edge);
      if (edge.source === nodeId && edge.target !== nodeId) {
        results.push({ neighborId: edge.target, weight });
      }
      if (edge.target === nodeId && edge.source !== nodeId) {
        results.push({ neighborId: edge.source, weight });
      }
      return results;
    });
  }

  // Deduplicate keeping highest weight per neighbor
  const weightMap = new Map<string, number>();
  for (const item of matchedEdges) {
    const existing = weightMap.get(item.neighborId) ?? -Infinity;
    if (item.weight > existing) {
      weightMap.set(item.neighborId, item.weight);
    }
  }

  // Sort descending by edge weight so semantically authoritative relationships are explored first
  return Array.from(weightMap.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([neighborId]) => neighborId);
}

export type GraphDepthMetrics = {
  maxReachableHops: number;
  totalReachableNodes: number;
  depthLimits: {
    shallow: number;
    default: number;
    deep: number;
    unlimited: number;
  };
};

export function computeGraphDepthMetrics(
  _nodes: Array<{ id: string }>,
  edges: GraphEdgeLike[],
  startingNodeIds: string[],
  direction: 'forward' | 'backward' | 'both' = 'forward',
): GraphDepthMetrics {
  const visited = new Set<string>(startingNodeIds);
  const queue: Array<{ id: string; depth: number }> = startingNodeIds.map(
    (id) => ({ id, depth: 0 }),
  );
  let maxReachableHops = 0;

  while (queue.length > 0) {
    const current = queue.shift()!;
    const neighbors = connectedNodes(current.id, edges, direction);
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        const nextDepth = current.depth + 1;
        if (nextDepth > maxReachableHops) {
          maxReachableHops = nextDepth;
        }
        queue.push({ id: neighbor, depth: nextDepth });
      }
    }
  }

  const D = maxReachableHops;
  const shallow =
    D <= 1 ? Math.max(1, D) : Math.max(1, Math.min(2, Math.round(D * 0.35)));
  const defaultDepth =
    D <= 2 ? Math.max(1, D) : Math.max(2, Math.min(4, Math.round(D * 0.65)));
  const deep = D <= 3 ? Math.max(1, D) : Math.max(3, Math.min(8, D));
  const unlimited = Math.min(20, Math.max(D, 1));

  return {
    maxReachableHops,
    totalReachableNodes: visited.size,
    depthLimits: {
      shallow,
      default: defaultDepth,
      deep,
      unlimited,
    },
  };
}

export function vectorNorm(v: number[]): number {
  let sum = 0;
  for (const x of v) {
    sum += x * x;
  }
  return Math.sqrt(sum);
}

export function normalizeVector(v: number[]): number[] {
  const norm = vectorNorm(v);
  if (norm === 0) return [...v];
  return v.map((x) => x / norm);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const valA = a[i]!;
    const valB = b[i]!;
    dot += valA * valB;
    normA += valA * valA;
    normB += valB * valB;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Rocchio Relevance Feedback vector steering:
 * v_next = norm(alpha * v0 + beta * vCurrent - gamma * vPrev)
 * Subtraction of previous state vector biases query away from already covered narrative.
 */
export function adjustCrawlVector(
  v0: number[],
  vCurrent: number[],
  vPrev?: number[],
  alpha = 0.5,
  beta = 0.4,
  gamma = 0.2,
): number[] {
  const dim = v0.length;
  if (vCurrent.length !== dim) {
    return normalizeVector(v0);
  }
  const result = new Array<number>(dim);
  for (let i = 0; i < dim; i++) {
    const term0 = alpha * (v0[i] ?? 0);
    const termCurrent = beta * (vCurrent[i] ?? 0);
    const termPrev =
      vPrev && vPrev.length === dim ? gamma * (vPrev[i] ?? 0) : 0;
    result[i] = term0 + termCurrent - termPrev;
  }
  return normalizeVector(result);
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

const COMMON_STOP_WORDS = new Set([
  'a',
  'about',
  'above',
  'after',
  'again',
  'against',
  'all',
  'also',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'because',
  'been',
  'before',
  'being',
  'below',
  'between',
  'both',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'doing',
  'down',
  'during',
  'each',
  'few',
  'for',
  'from',
  'further',
  'had',
  'has',
  'have',
  'having',
  'he',
  'her',
  'here',
  'hers',
  'herself',
  'him',
  'himself',
  'his',
  'how',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'itself',
  'just',
  'me',
  'more',
  'most',
  'my',
  'myself',
  'no',
  'nor',
  'not',
  'now',
  'of',
  'off',
  'on',
  'once',
  'only',
  'or',
  'other',
  'our',
  'ours',
  'ourselves',
  'out',
  'over',
  'own',
  'same',
  'should',
  'so',
  'some',
  'such',
  'than',
  'that',
  'the',
  'their',
  'theirs',
  'them',
  'themselves',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'to',
  'too',
  'under',
  'until',
  'up',
  'very',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'whom',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
  'yours',
  'yourself',
  'yourselves',
]);

export function extractSharedKeywords(
  textA: string,
  textB: string,
  limit = 5,
): string[] {
  if (!textA || !textB) return [];

  const extractWordCounts = (text: string): Map<string, number> => {
    const counts = new Map<string, number>();
    const words = text.toLowerCase().split(/[^a-z0-9_-]+/);
    for (const w of words) {
      if (w.length >= 3 && !COMMON_STOP_WORDS.has(w) && !/^\d+$/.test(w)) {
        counts.set(w, (counts.get(w) ?? 0) + 1);
      }
    }
    return counts;
  };

  const countsA = extractWordCounts(textA);
  const countsB = extractWordCounts(textB);

  const shared: Array<{ keyword: string; score: number }> = [];
  for (const [word, countA] of countsA.entries()) {
    if (countsB.has(word)) {
      const countB = countsB.get(word)!;
      shared.push({ keyword: word, score: countA + countB });
    }
  }

  return shared
    .sort((a, b) => b.score - a.score || b.keyword.length - a.keyword.length)
    .slice(0, limit)
    .map((item) => item.keyword);
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
  _sensitivity: SearchSensitivity = 'medium',
): {
  vectorThreshold: number;
  minLexScore: number;
  rerankThreshold: number;
} {
  return { vectorThreshold: 0.05, minLexScore: 1, rerankThreshold: 0.05 };
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

export function determineAnswerType(chunk: SearchChunk): LeadAnswerType {
  if (isTableChunk(chunk)) {
    return 'tabular';
  }
  if (
    /```[\s\S]*?```/.test(chunk.content) ||
    /(^|\n)\s*(\d+\.|\([0-9]+\)|step\s+\d+)/i.test(chunk.content)
  ) {
    return 'procedural';
  }
  if (
    /(^|\n)#+\s+/m.test(chunk.content) ||
    /\b(is defined as|refers to|meaning of|overview|conceptually|definition|in essence)\b/i.test(
      chunk.content,
    )
  ) {
    return 'definitional';
  }
  return 'direct';
}

export type BranchWithScore = {
  crawlNode: {
    score: number;
    nodeId: string;
    groupOrigin?: string;
    rerankScore?: number;
  };
  groupId?: string;
};

export function selectDiverseBranches<T extends BranchWithScore>(
  branches: T[],
  maxBranches = 8,
  isComparative = false,
): T[] {
  if (branches.length <= maxBranches) {
    return branches.slice().sort((a, b) => {
      const scoreA = a.crawlNode.rerankScore ?? a.crawlNode.score;
      const scoreB = b.crawlNode.rerankScore ?? b.crawlNode.score;
      return scoreB - scoreA;
    });
  }

  const scoreOf = (item: T) =>
    item.crawlNode.rerankScore ?? item.crawlNode.score;

  if (isComparative) {
    // Partition by hypothesis group
    const groups = new Map<string, T[]>();
    for (const b of branches) {
      const gId = b.groupId || b.crawlNode.groupOrigin || 'default';
      const list = groups.get(gId) ?? [];
      list.push(b);
      groups.set(gId, list);
    }

    // Sort items within each group partition
    for (const [, items] of groups) {
      items.sort((a, b) => scoreOf(b) - scoreOf(a));
    }

    const groupKeys = Array.from(groups.keys());
    const slotsPerGroup = Math.max(
      1,
      Math.floor(maxBranches / groupKeys.length),
    );
    const selected: T[] = [];
    const remaining: T[] = [];

    for (const key of groupKeys) {
      const items = groups.get(key)!;
      selected.push(...items.slice(0, slotsPerGroup));
      remaining.push(...items.slice(slotsPerGroup));
    }

    // Fill any remaining slots with the globally highest-scoring leftover candidates
    if (selected.length < maxBranches && remaining.length > 0) {
      remaining.sort((a, b) => scoreOf(b) - scoreOf(a));
      selected.push(...remaining.slice(0, maxBranches - selected.length));
    }

    return selected.sort((a, b) => scoreOf(b) - scoreOf(a));
  }

  // Non-comparative mode: ensure multi-topic diversity across distinct graph nodes
  const byNode = new Map<string, T[]>();
  for (const b of branches) {
    const nId = b.crawlNode.nodeId;
    const list = byNode.get(nId) ?? [];
    list.push(b);
    byNode.set(nId, list);
  }

  for (const [, items] of byNode) {
    items.sort((a, b) => scoreOf(b) - scoreOf(a));
  }

  const selected: T[] = [];
  const remaining: T[] = [];

  // Pick top 1 from each distinct topic first
  for (const [, items] of byNode) {
    selected.push(items[0]!);
    remaining.push(...items.slice(1));
  }

  if (selected.length > maxBranches) {
    // More topics than maxBranches: pick highest scoring topics
    selected.sort((a, b) => scoreOf(b) - scoreOf(a));
    return selected.slice(0, maxBranches);
  }

  if (selected.length < maxBranches && remaining.length > 0) {
    remaining.sort((a, b) => scoreOf(b) - scoreOf(a));
    selected.push(...remaining.slice(0, maxBranches - selected.length));
  }

  return selected.sort((a, b) => scoreOf(b) - scoreOf(a));
}

/**
 * Computes information-theoretic Graph Entropy H_G in [0, 1] for a set of crawl nodes and edges.
 * Modeled after Shannon Entropy in decision tree induction (information purity):
 * - H_node: Normalized Shannon entropy over the node relevance/similarity probability distribution.
 * - H_edge: Normalized Shannon entropy over the edge transition similarity weights.
 * Lower entropy indicates high cohesion and sharp semantic focus (fewer ambiguous/dispersed branches).
 */
export function computeGraphEntropy(
  nodes: CrawlNode[],
  edges: CrawlEdge[] = [],
): number {
  if (!nodes || nodes.length <= 1) {
    return 0;
  }

  // 1. Node relevance / similarity distribution
  const nodeScores = nodes.map((n) =>
    Math.max(n.rerankScore ?? n.score ?? 0.1, 0.001),
  );
  const sumScores = nodeScores.reduce((acc, s) => acc + s, 0);

  let nodeEntropy = 0;
  if (sumScores > 0) {
    for (const s of nodeScores) {
      const p = s / sumScores;
      if (p > 0) {
        nodeEntropy -= p * Math.log2(p);
      }
    }
  }

  const maxNodeEntropy = Math.log2(nodes.length);
  const normalizedNodeEntropy =
    maxNodeEntropy > 0 ? nodeEntropy / maxNodeEntropy : 0;

  // 2. Edge transition similarity distribution
  let normalizedEdgeEntropy = 0;
  if (edges && edges.length > 1) {
    const edgeWeights = edges.map((e) =>
      Math.max(e.similarityScore ?? 0.5, 0.001),
    );
    const sumWeights = edgeWeights.reduce((acc, w) => acc + w, 0);
    let edgeEntropy = 0;
    if (sumWeights > 0) {
      for (const w of edgeWeights) {
        const q = w / sumWeights;
        if (q > 0) {
          edgeEntropy -= q * Math.log2(q);
        }
      }
    }
    const maxEdgeEntropy = Math.log2(edges.length);
    normalizedEdgeEntropy =
      maxEdgeEntropy > 0 ? edgeEntropy / maxEdgeEntropy : 0;
  }

  const combined =
    edges && edges.length > 1
      ? 0.6 * normalizedNodeEntropy + 0.4 * normalizedEdgeEntropy
      : normalizedNodeEntropy;

  return Math.round(combined * 1000) / 1000;
}

/**
 * Computes the branch entropy H_branch in [0, 1] along an exploratory crawl path
 * from seed node v_0 to candidate leaf v_k.
 *
 * Models cumulative Markov transition cohesion and topic dissipation:
 * - C_trans: Weighted edge similarity along the branch path (70% mean, 30% bottleneck minimum).
 * - s_candidate: Relevance score of the latest frontier candidate.
 * - delta_s: Semantic decay relative to seed node match.
 *
 * Returns a value in [0, 1] where:
 * - <= 0.30: Pristine / tight semantic alignment
 * - 0.31 - 0.65: Moderate cohesion
 * - > 0.65: High entropy / topic drift (candidate for branch pruning)
 */
export function computeBranchEntropy(
  pathNodes: CrawlNode[],
  pathEdges: CrawlEdge[] = [],
): number {
  if (!pathNodes || pathNodes.length <= 1) {
    return 0;
  }

  const latestNode = pathNodes[pathNodes.length - 1]!;
  const seedNode = pathNodes[0]!;

  const candidateScore = Math.max(
    0.01,
    Math.min(1.0, latestNode.rerankScore ?? latestNode.score ?? 0.5),
  );
  const seedScore = Math.max(
    0.01,
    Math.min(1.0, seedNode.rerankScore ?? seedNode.score ?? 0.8),
  );

  let transitionCohesion = 1.0;
  if (pathEdges && pathEdges.length > 0) {
    const edgeSims = pathEdges.map((e) =>
      Math.max(0.01, Math.min(1.0, e.similarityScore ?? 0.5)),
    );
    const avgSim = edgeSims.reduce((sum, s) => sum + s, 0) / edgeSims.length;
    const minSim = Math.min(...edgeSims);
    transitionCohesion = 0.7 * avgSim + 0.3 * minSim;
  }

  const scoreDecay = Math.max(0, seedScore - candidateScore);
  const retainedTopicProbability = transitionCohesion * candidateScore;
  const rawEntropy = 1.0 - retainedTopicProbability + 0.15 * scoreDecay;

  const clamped = Math.max(0.0, Math.min(1.0, rawEntropy));
  return Math.round(clamped * 1000) / 1000;
}

export type AdaptiveEntropyParams = {
  nodeCount: number;
  edgeCount: number;
  sensitivity?: 'low' | 'medium' | 'high';
  crawlDepth?: 'shallow' | 'default' | 'deep' | 'unlimited';
};

/**
 * Dynamically computes an optimal adaptive branch entropy threshold tau_adaptive in [0.30, 0.80]
 * based on knowledge graph topological density and query search sensitivity.
 *
 * Dense graph topology (avg degree >= 4 edges/node) triggers tighter gating (tau ~ 0.40 - 0.48)
 * to prevent runaway branch explosion and tangential hallucinations.
 * Sparse graph topology (avg degree <= 1.5 edges/node) triggers relaxed gating (tau ~ 0.65 - 0.75)
 * to prevent starving the frontier across sparse bridge connections.
 *
 * Sensitivity modifiers:
 * - 'high': Stricter relevance focus (-0.06)
 * - 'low': Permissive exploratory discovery (+0.06)
 * - 'medium': Neutral (0.00)
 */
export function determineAdaptiveMaxBranchEntropy(
  params: AdaptiveEntropyParams,
): number {
  const {
    nodeCount,
    edgeCount,
    sensitivity = 'medium',
    crawlDepth = 'default',
  } = params;
  const safeNodeCount = Math.max(1, nodeCount);
  const avgDegree = (2 * edgeCount) / safeNodeCount;

  // Base density threshold: maps avgDegree in [1.0, 6.0] to threshold in [0.72, 0.40]
  // avgDegree <= 1.0 -> 0.72 (sparse)
  // avgDegree >= 6.0 -> 0.40 (dense)
  const normalizedDegree = Math.max(0, Math.min(5, avgDegree - 1));
  const densityBase = 0.72 - normalizedDegree * (0.32 / 5);

  let sensitivityAdjustment = 0;
  if (sensitivity === 'high') {
    sensitivityAdjustment = -0.06;
  } else if (sensitivity === 'low') {
    sensitivityAdjustment = 0.06;
  }

  let depthAdjustment = 0;
  if (crawlDepth === 'deep' || crawlDepth === 'unlimited') {
    // 3+ hops naturally accumulate small edge dissipation, allow slight slack (+0.03)
    depthAdjustment = 0.03;
  } else if (crawlDepth === 'shallow') {
    // 1 hop should be tightly focused (-0.03)
    depthAdjustment = -0.03;
  }

  const rawThreshold = densityBase + sensitivityAdjustment + depthAdjustment;
  const clamped = Math.max(0.3, Math.min(0.8, rawThreshold));
  return Math.round(clamped * 100) / 100;
}

export type AdaptiveJumpThresholdParams = {
  nodeCount?: number;
  edgeCount?: number;
  localDegree?: number;
  avgDegree?: number;
  sensitivity?: 'low' | 'medium' | 'high';
};

export type AdaptiveJumpThresholds = {
  minJumpSimilarity: number;
  similarityGapThreshold: number;
};

/**
 * Dynamically computes optimal jump similarity thresholds:
 * - minJumpSimilarity: minimum cosine similarity required to qualify as a valid semantic jump to a new topic.
 * - similarityGapThreshold: upper similarity threshold where a candidate is considered a direct perspective
 *   bridge (link) rather than a transition to a new topic (jump).
 *
 * In sparse graphs / isolated subgraphs (degree <= 1):
 *   Relaxes thresholds (minJump ~ 0.28, gap ~ 0.75) to prevent starving exploratory transitions across sparse bridges.
 * In dense clusters / hub nodes (degree >= 4):
 *   Tightens thresholds (minJump ~ 0.42, gap ~ 0.65) to maintain sharp thematic focus and avoid tangential branch explosion.
 */
export function determineAdaptiveJumpThresholds(
  params: AdaptiveJumpThresholdParams = {},
): AdaptiveJumpThresholds {
  const {
    nodeCount = 10,
    edgeCount = 10,
    localDegree,
    sensitivity = 'medium',
  } = params;

  let computedAvgDegree = params.avgDegree;
  if (computedAvgDegree === undefined) {
    const safeNodeCount = Math.max(1, nodeCount);
    computedAvgDegree = (2 * edgeCount) / safeNodeCount;
  }

  // Combine local degree (60% weight if available) with global average degree (40%)
  const effectiveDegree =
    typeof localDegree === 'number'
      ? 0.6 * localDegree + 0.4 * computedAvgDegree
      : computedAvgDegree;

  // Normalized degree in [0, 1] for degrees between 1 and 5
  // degree <= 1: 0 (sparse)
  // degree >= 5: 1 (dense)
  const clampedDegree = Math.max(1, Math.min(5, effectiveDegree));
  const normalized = (clampedDegree - 1) / 4;

  // Base thresholds
  // minJumpSimilarity: 0.26 (sparse) -> 0.40 (dense)
  const baseMinJump = 0.26 + normalized * 0.14;
  // similarityGapThreshold: 0.76 (sparse) -> 0.64 (dense)
  const baseGap = 0.76 - normalized * 0.12;

  // Sensitivity adjustment
  let sensMinJump = 0;
  let sensGap = 0;
  if (sensitivity === 'high') {
    sensMinJump = 0.03; // stricter minimum similarity
    sensGap = -0.03; // tighter link boundary
  } else if (sensitivity === 'low') {
    sensMinJump = -0.03; // more permissive jump discovery
    sensGap = 0.03; // broader link boundary
  }

  const minJumpSimilarity =
    Math.round(
      Math.max(0.18, Math.min(0.46, baseMinJump + sensMinJump)) * 100,
    ) / 100;
  const similarityGapThreshold =
    Math.round(
      Math.max(minJumpSimilarity + 0.15, Math.min(0.82, baseGap + sensGap)) *
        100,
    ) / 100;

  return {
    minJumpSimilarity,
    similarityGapThreshold,
  };
}

export function matchesTopicTerms(
  topicTitle: string | undefined,
  content: string,
): boolean {
  if (!topicTitle || topicTitle.trim().length < 3) return false;
  const trimmed = topicTitle.trim();
  // 1. Direct full-phrase match
  if (new RegExp(`\\b${escapeRegExp(trimmed)}\\b`, 'i').test(content)) {
    return true;
  }
  // 2. Significant individual term match (terms >= 4 characters excluding generic stop words)
  const stopWords = new Set([
    'with',
    'from',
    'into',
    'that',
    'this',
    'have',
    'more',
    'some',
    'than',
    'which',
    'their',
    'there',
    'about',
    'these',
  ]);
  const tokens = trimmed
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((t) => t.length >= 4 && !stopWords.has(t));
  return tokens.some((token) =>
    new RegExp(`\\b${escapeRegExp(token)}\\b`, 'i').test(content),
  );
}

export const TECHNICAL_SYNONYMS: Record<string, string[]> = {
  k8s: ['kubernetes'],
  kubernetes: ['k8s'],
  db: ['database'],
  database: ['db'],
  bfs: ['breadth-first search'],
  dfs: ['depth-first search'],
  mst: ['minimum spanning tree'],
  api: ['application programming interface'],
  ai: ['artificial intelligence'],
  ml: ['machine learning'],
  nlp: ['natural language processing'],
  orm: ['object relational mapping'],
  sql: ['structured query language'],
  dag: ['directed acyclic graph'],
  rag: ['retrieval-augmented generation'],
};

export type ExpandedQueryResult = {
  expandedQuery: string;
  expandedKeywords: string[];
};

export function expandQueryKeywords(
  query: string,
  customSynonyms?: Record<string, string[]>,
): ExpandedQueryResult {
  if (!query || !query.trim()) {
    return { expandedQuery: query, expandedKeywords: [] };
  }

  const dictionary: Record<string, string[]> = {
    ...TECHNICAL_SYNONYMS,
    ...(customSynonyms ?? {}),
  };

  const lowerQuery = query.toLowerCase();
  const tokens = lowerQuery.split(/[^a-z0-9_-]+/).filter(Boolean);
  const expansions: string[] = [];

  for (const token of tokens) {
    const synonyms = dictionary[token];
    if (synonyms) {
      for (const syn of synonyms) {
        if (
          !lowerQuery.includes(syn.toLowerCase()) &&
          !expansions.includes(syn)
        ) {
          expansions.push(syn);
        }
      }
    }
  }

  if (expansions.length === 0) {
    return { expandedQuery: query, expandedKeywords: [] };
  }

  return {
    expandedQuery: `${query} ${expansions.join(' ')}`,
    expandedKeywords: expansions,
  };
}

export function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export type ClassifyCrawlCandidateOptions = {
  candidateNodeId: string;
  currentNodeId: string;
  currentTopicTitle?: string;
  candidateContent: string;
  isAdjacentInGraph: boolean;
  connectedTopicTitles?: string[];
  enableDigs?: boolean;
  digsInCurrentTopic?: number;
  maxDigsPerTopic?: number;
  enableLinks?: boolean;
  totalLinks?: number;
  maxLinks?: number;
  enableJumps?: boolean;
  totalJumps?: number;
  maxJumps?: number;
  semanticSimilarity?: number;
  similarityGapThreshold?: number;
  minJumpSimilarity?: number;
  densityParams?: AdaptiveJumpThresholdParams;
};

export function classifyCrawlCandidate(
  options: ClassifyCrawlCandidateOptions,
): CrawlMatchType | null {
  const {
    candidateNodeId,
    currentNodeId,
    currentTopicTitle,
    candidateContent,
    isAdjacentInGraph,
    connectedTopicTitles = [],
    enableDigs = true,
    digsInCurrentTopic = 0,
    maxDigsPerTopic = 3,
    enableLinks = true,
    totalLinks = 0,
    maxLinks = 3,
    enableJumps = true,
    totalJumps = 0,
    maxJumps = 3,
    semanticSimilarity,
  } = options;

  let { minJumpSimilarity, similarityGapThreshold } = options;

  if (minJumpSimilarity === undefined || similarityGapThreshold === undefined) {
    if (options.densityParams) {
      const adaptive = determineAdaptiveJumpThresholds(options.densityParams);
      if (minJumpSimilarity === undefined) {
        minJumpSimilarity = adaptive.minJumpSimilarity;
      }
      if (similarityGapThreshold === undefined) {
        similarityGapThreshold = adaptive.similarityGapThreshold;
      }
    } else {
      if (minJumpSimilarity === undefined) minJumpSimilarity = 0.3;
      if (similarityGapThreshold === undefined) similarityGapThreshold = 0.65;
    }
  }

  const isSameNode = candidateNodeId === currentNodeId;

  // 1. Same node: can be either a link to another perspective/topic or a dig into current topic
  if (isSameNode) {
    const mentionsConnectedTopic = connectedTopicTitles.some((title) =>
      matchesTopicTerms(title, candidateContent),
    );

    if (mentionsConnectedTopic && enableLinks && totalLinks < maxLinks) {
      return 'link';
    }

    if (enableDigs && digsInCurrentTopic < maxDigsPerTopic) {
      return 'dig';
    }

    return null;
  }

  // 2. Different node:
  // Check if it's an explicit "link": connects with other definitions/perspectives/applications of current topic
  const mentionsCurrentTopic = matchesTopicTerms(
    currentTopicTitle,
    candidateContent,
  );

  if (mentionsCurrentTopic && enableLinks && totalLinks < maxLinks) {
    return 'link';
  }

  // Evaluate semantic similarity if available
  const hasSim = typeof semanticSimilarity === 'number';

  // If candidate is adjacent in graph, OR semantic similarity falls within the related-topic transition band [minJumpSim, gapThreshold]
  const qualifiesForJump =
    isAdjacentInGraph ||
    (hasSim &&
      semanticSimilarity >= minJumpSimilarity &&
      semanticSimilarity <= similarityGapThreshold);

  if (qualifiesForJump) {
    if (enableJumps && totalJumps < maxJumps) {
      return 'jump';
    }
    if (enableLinks && totalLinks < maxLinks) {
      return 'link';
    }
  }

  // High semantic similarity (> gapThreshold) across nodes without explicitly mentioning current topic:
  // acts as a conceptual bridge or perspective elaboration -> link
  if (hasSim && semanticSimilarity > similarityGapThreshold) {
    if (enableLinks && totalLinks < maxLinks) {
      return 'link';
    }
    if (enableJumps && totalJumps < maxJumps) {
      return 'jump';
    }
  }

  // Fallback for reachable nodes if links are enabled and not below minimal similarity threshold
  if (enableLinks && totalLinks < maxLinks) {
    if (!hasSim || semanticSimilarity >= minJumpSimilarity) {
      return 'link';
    }
  }

  return null;
}

export function computeChunkSimilarity(
  chunkA: { content: string; vector?: number[] },
  chunkB: { content: string; vector?: number[] },
): number {
  if (
    Array.isArray(chunkA.vector) &&
    chunkA.vector.length > 0 &&
    Array.isArray(chunkB.vector) &&
    chunkB.vector.length > 0
  ) {
    return cosineSimilarity(chunkA.vector, chunkB.vector);
  }
  const wordsA = new Set(
    chunkA.content
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2),
  );
  const wordsB = new Set(
    chunkB.content
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2),
  );
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : intersection / union;
}

export function calculateMmrScore(
  candidateScore: number,
  maxSimToSelected: number,
  lambda = 0.7,
): number {
  return lambda * candidateScore - (1 - lambda) * maxSimToSelected;
}

export function computeCentroid(vectors: number[][]): number[] {
  if (!vectors || vectors.length === 0) return [];
  const dim = vectors[0]?.length ?? 0;
  if (dim === 0) return [];
  const centroid = new Array<number>(dim).fill(0);
  let count = 0;
  for (const v of vectors) {
    if (v.length === dim) {
      for (let i = 0; i < dim; i++) {
        centroid[i] = (centroid[i] ?? 0) + (v[i] ?? 0);
      }
      count++;
    }
  }
  if (count === 0) return [];
  for (let i = 0; i < dim; i++) {
    centroid[i] = (centroid[i] ?? 0) / count;
  }
  return normalizeVector(centroid);
}

export function calculateComparativeMmrScore(
  candidateScore: number,
  maxSimToSelected: number,
  maxSimToOtherGroups: number,
  lambda = 0.65,
  muIntra = 0.2,
  muInter = 0.15,
): number {
  return (
    lambda * candidateScore -
    muIntra * maxSimToSelected -
    muInter * maxSimToOtherGroups
  );
}

export type ClassifiedCandidateItem<T> = {
  candidate: T;
  matchType: CrawlMatchType;
  score: number;
  nodeId: string;
  content: string;
  vector?: number[];
};

export function selectDiverseCandidatesMmr<T>(
  candidates: ClassifiedCandidateItem<T>[],
  maxCandidates: number,
  lambda = 0.7,
  similarityDeduplicationThreshold = 0.85,
  otherGroupCentroids?: number[][],
): ClassifiedCandidateItem<T>[] {
  if (candidates.length <= 1 || maxCandidates <= 1) {
    return candidates.slice(0, maxCandidates);
  }

  const pool = [...candidates];
  const selected: ClassifiedCandidateItem<T>[] = [];
  const hasOtherCentroids =
    Array.isArray(otherGroupCentroids) && otherGroupCentroids.length > 0;

  while (selected.length < maxCandidates && pool.length > 0) {
    if (selected.length === 0) {
      pool.sort((a, b) => b.score - a.score);
      const best = pool.shift();
      if (best) {
        selected.push(best);
      }
      continue;
    }

    let bestMmrScore = Number.NEGATIVE_INFINITY;
    let bestIndex = -1;

    for (let i = 0; i < pool.length; i++) {
      const cand = pool[i]!;

      let maxSim = 0;
      let hasNearDuplicate = false;

      for (const sel of selected) {
        const sim = computeChunkSimilarity(
          { content: cand.content, vector: cand.vector },
          { content: sel.content, vector: sel.vector },
        );
        if (sim > maxSim) {
          maxSim = sim;
        }

        if (
          sim > similarityDeduplicationThreshold &&
          cand.nodeId === sel.nodeId &&
          cand.matchType === sel.matchType
        ) {
          hasNearDuplicate = true;
          break;
        }
      }

      if (hasNearDuplicate) {
        continue;
      }

      let mmr: number;
      if (
        hasOtherCentroids &&
        Array.isArray(cand.vector) &&
        cand.vector.length > 0
      ) {
        let maxSimToOtherGroups = 0;
        for (const centroid of otherGroupCentroids!) {
          if (centroid.length === cand.vector.length) {
            const sim = cosineSimilarity(cand.vector, centroid);
            if (sim > maxSimToOtherGroups) {
              maxSimToOtherGroups = sim;
            }
          }
        }
        mmr = calculateComparativeMmrScore(
          cand.score,
          maxSim,
          maxSimToOtherGroups,
          0.65,
          0.2,
          0.15,
        );
      } else {
        mmr = calculateMmrScore(cand.score, maxSim, lambda);
      }

      if (mmr > bestMmrScore) {
        bestMmrScore = mmr;
        bestIndex = i;
      }
    }

    if (bestIndex >= 0) {
      const [chosen] = pool.splice(bestIndex, 1);
      if (chosen) {
        selected.push(chosen);
      }
    } else {
      break;
    }
  }

  return selected;
}

export type CrawlBranchLike = {
  currentNode: {
    id: string;
    nodeId: string;
    matchType?: CrawlMatchType;
    score?: number;
    rerankScore?: number;
    groupOrigin?: string;
    chunk: {
      content: string;
      vector?: number[];
    };
  };
  currentVector?: number[];
  groupOrigin?: string;
};

export function pruneAndDeduplicateBranches<T extends CrawlBranchLike>(
  branches: T[],
  maxBranches = 8,
  similarityThreshold = 0.85,
  isComparative = false,
): T[] {
  if (branches.length === 0) return [];

  const scoreOf = (b: T) =>
    b.currentNode.rerankScore ?? b.currentNode.score ?? 0;

  if (isComparative) {
    // Partition by hypothesis group
    const groups = new Map<string, T[]>();
    for (const b of branches) {
      const gId = b.groupOrigin || b.currentNode.groupOrigin || 'default';
      const list = groups.get(gId) ?? [];
      list.push(b);
      groups.set(gId, list);
    }

    // Deduplicate within each group and sort by score
    const deduplicatedGroups = new Map<string, T[]>();
    for (const [gId, groupBranches] of groups.entries()) {
      const sorted = [...groupBranches].sort((a, b) => scoreOf(b) - scoreOf(a));
      const kept: T[] = [];
      for (const branch of sorted) {
        const isDuplicate = kept.some((k) => {
          if (k.currentNode.nodeId !== branch.currentNode.nodeId) return false;
          if (k.currentNode.matchType !== branch.currentNode.matchType) {
            return (
              k.currentNode.chunk.content === branch.currentNode.chunk.content
            );
          }
          const sim = computeChunkSimilarity(
            {
              content: branch.currentNode.chunk.content,
              vector: branch.currentVector ?? branch.currentNode.chunk.vector,
            },
            {
              content: k.currentNode.chunk.content,
              vector: k.currentVector ?? k.currentNode.chunk.vector,
            },
          );
          return sim > similarityThreshold;
        });
        if (!isDuplicate) {
          kept.push(branch);
        }
      }
      deduplicatedGroups.set(gId, kept);
    }

    const groupKeys = Array.from(deduplicatedGroups.keys());
    const slotsPerGroup = Math.max(
      1,
      Math.floor(maxBranches / groupKeys.length),
    );
    const selected: T[] = [];
    const remaining: T[] = [];

    for (const key of groupKeys) {
      const items = deduplicatedGroups.get(key) ?? [];
      selected.push(...items.slice(0, slotsPerGroup));
      remaining.push(...items.slice(slotsPerGroup));
    }

    if (selected.length < maxBranches && remaining.length > 0) {
      remaining.sort((a, b) => scoreOf(b) - scoreOf(a));
      selected.push(...remaining.slice(0, maxBranches - selected.length));
    }

    return selected.sort((a, b) => scoreOf(b) - scoreOf(a));
  }

  // Non-comparative mode: global deduplication and sorting
  const sorted = [...branches].sort((a, b) => scoreOf(b) - scoreOf(a));
  const keptBranches: T[] = [];

  for (const branch of sorted) {
    const isDuplicate = keptBranches.some((kept) => {
      if (kept.currentNode.nodeId !== branch.currentNode.nodeId) {
        return false;
      }

      if (kept.currentNode.matchType !== branch.currentNode.matchType) {
        return (
          kept.currentNode.chunk.content === branch.currentNode.chunk.content
        );
      }

      const sim = computeChunkSimilarity(
        {
          content: branch.currentNode.chunk.content,
          vector: branch.currentVector ?? branch.currentNode.chunk.vector,
        },
        {
          content: kept.currentNode.chunk.content,
          vector: kept.currentVector ?? kept.currentNode.chunk.vector,
        },
      );

      return sim > similarityThreshold;
    });

    if (!isDuplicate) {
      keptBranches.push(branch);
    }
  }

  return keptBranches.slice(0, maxBranches);
}
