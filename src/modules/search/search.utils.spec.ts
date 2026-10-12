import {
  computeChunkSimilarity,
  calculateMmrScore,
  computeCentroid,
  calculateComparativeMmrScore,
  selectDiverseCandidatesMmr,
  pruneAndDeduplicateBranches,
  connectedNodes,
  computeGraphDepthMetrics,
  chunkArray,
  classifyQueryIntent,
  calculateDynamicAlpha,
  filterLeadAnswerCandidate,
  extractSalientAnswerSentence,
  formatRerankPassage,
  blendVectorMomentum,
  classifyCrawlCandidate,
  isHeadingOrTitleChunk,
  type ClassifiedCandidateItem,
  type CrawlBranchLike,
} from './search.utils.js';

describe('Search Utils - MMR Diversity & Beam Pruning', () => {
  describe('computeChunkSimilarity', () => {
    it('computes cosine similarity when vectors are present', () => {
      const chunkA = {
        content: 'Alpha text',
        vector: [1, 0, 0],
      };
      const chunkB = {
        content: 'Beta text',
        vector: [1, 0, 0],
      };
      const chunkC = {
        content: 'Gamma text',
        vector: [0, 1, 0],
      };

      expect(computeChunkSimilarity(chunkA, chunkB)).toBeCloseTo(1.0);
      expect(computeChunkSimilarity(chunkA, chunkC)).toBeCloseTo(0.0);
    });

    it('falls back to lexical word overlap when vectors are absent', () => {
      const chunkA = {
        content: 'distributed consensus raft algorithm leader election',
      };
      const chunkB = {
        content: 'distributed consensus paxos algorithm leader election',
      };
      const chunkC = {
        content: 'completely unrelated biology cells photosynthesis',
      };

      const simHigh = computeChunkSimilarity(chunkA, chunkB);
      const simLow = computeChunkSimilarity(chunkA, chunkC);

      expect(simHigh).toBeGreaterThan(0.5);
      expect(simLow).toBe(0);
    });
  });

  describe('calculateMmrScore', () => {
    it('applies lambda weighting between candidate score and maximum similarity', () => {
      // MMR = 0.7 * score - 0.3 * maxSim
      // For score = 0.9, maxSim = 0.2: 0.7 * 0.9 - 0.3 * 0.2 = 0.63 - 0.06 = 0.57
      const mmr = calculateMmrScore(0.9, 0.2, 0.7);
      expect(mmr).toBeCloseTo(0.57);
    });
  });

  describe('computeCentroid', () => {
    it('computes unit-normalized mean vector across multiple vectors', () => {
      const v1 = [1, 0, 0];
      const v2 = [0, 1, 0];
      const centroid = computeCentroid([v1, v2]);
      expect(centroid[0]).toBeCloseTo(1 / Math.sqrt(2));
      expect(centroid[1]).toBeCloseTo(1 / Math.sqrt(2));
      expect(centroid[2]).toBeCloseTo(0);
    });

    it('returns empty array when vectors list is empty', () => {
      expect(computeCentroid([])).toEqual([]);
    });
  });

  describe('calculateComparativeMmrScore', () => {
    it('penalizes proximity to competing hypothesis group centroid', () => {
      // candidate A: score 0.90, intraSim 0.20, interSim 0.10
      // MMR = 0.65 * 0.90 - 0.20 * 0.20 - 0.15 * 0.10 = 0.585 - 0.040 - 0.015 = 0.530
      const scoreA = calculateComparativeMmrScore(0.9, 0.2, 0.1);
      expect(scoreA).toBeCloseTo(0.53);

      // candidate B: same score 0.90, same intraSim 0.20, but high interSim 0.80 (too close to other group!)
      // MMR = 0.65 * 0.90 - 0.20 * 0.20 - 0.15 * 0.80 = 0.585 - 0.040 - 0.120 = 0.425
      const scoreB = calculateComparativeMmrScore(0.9, 0.2, 0.8);
      expect(scoreB).toBeCloseTo(0.425);
      expect(scoreA).toBeGreaterThan(scoreB);
    });
  });

  describe('selectDiverseCandidatesMmr', () => {
    it('selects highest scoring candidate first and penalizes duplicate chunks', () => {
      const candidates: ClassifiedCandidateItem<string>[] = [
        {
          candidate: 'c1',
          matchType: 'dig',
          score: 0.95,
          nodeId: 'node-1',
          content: 'Gradient descent optimization in neural networks.',
          vector: [1, 0, 0],
        },
        {
          candidate: 'c2-duplicate',
          matchType: 'dig',
          score: 0.92,
          nodeId: 'node-1',
          content:
            'Gradient descent optimization in neural networks duplicated.',
          vector: [0.99, 0.05, 0], // Sim > 0.98 with c1, same node, same matchType -> should be skipped!
        },
        {
          candidate: 'c3-diverse',
          matchType: 'dig',
          score: 0.85,
          nodeId: 'node-1',
          content: 'Backpropagation calculus and chain rule derivatives.',
          vector: [0.2, 0.9, 0], // Diverse vector
        },
        {
          candidate: 'c4-jump',
          matchType: 'jump',
          score: 0.8,
          nodeId: 'node-2',
          content: 'Convolutional filters and computer vision.',
          vector: [0, 0, 1],
        },
      ];

      const selected = selectDiverseCandidatesMmr(candidates, 3, 0.7, 0.85);

      expect(selected).toHaveLength(3);
      expect(selected[0]?.candidate).toBe('c1');
      // c2-duplicate should have been filtered out due to >0.85 similarity to c1 on same node & matchType
      expect(selected.map((s) => s.candidate)).not.toContain('c2-duplicate');
      expect(selected.map((s) => s.candidate)).toContain('c3-diverse');
      expect(selected.map((s) => s.candidate)).toContain('c4-jump');
    });

    it('returns all candidates if count is less than maxCandidates and no duplicates', () => {
      const candidates: ClassifiedCandidateItem<string>[] = [
        {
          candidate: 'c1',
          matchType: 'dig',
          score: 0.9,
          nodeId: 'node-1',
          content: 'Text 1',
          vector: [1, 0],
        },
        {
          candidate: 'c2',
          matchType: 'link',
          score: 0.8,
          nodeId: 'node-2',
          content: 'Text 2',
          vector: [0, 1],
        },
      ];

      const selected = selectDiverseCandidatesMmr(candidates, 3);
      expect(selected).toHaveLength(2);
    });

    it('penalizes candidates too close to competing hypothesis centroid in comparative mode', () => {
      const otherGroupCentroid = [[0, 1, 0]]; // Competing group focuses on Y-axis
      const candidates: ClassifiedCandidateItem<string>[] = [
        {
          candidate: 'c1-seed',
          matchType: 'dig',
          score: 0.95,
          nodeId: 'node-1',
          content: 'Foundational topic on X axis',
          vector: [1, 0, 0],
        },
        {
          candidate: 'c2-near-other-group',
          matchType: 'link',
          score: 0.9,
          nodeId: 'node-2',
          content: 'Content overlapping with other group Y axis',
          vector: [0.1, 0.95, 0], // Highly similar to otherGroupCentroid [0, 1, 0]!
        },
        {
          candidate: 'c3-pure-own-path',
          matchType: 'link',
          score: 0.86,
          nodeId: 'node-3',
          content: 'Content exploring unique Z dimension',
          vector: [0.7, 0, 0.7], // Independent from otherGroupCentroid!
        },
      ];

      const selected = selectDiverseCandidatesMmr(
        candidates,
        2,
        0.7,
        0.85,
        otherGroupCentroid,
      );

      expect(selected).toHaveLength(2);
      expect(selected[0]?.candidate).toBe('c1-seed');
      // c3 should be preferred over c2 because c2 is penalized by proximity to otherGroupCentroid!
      expect(selected[1]?.candidate).toBe('c3-pure-own-path');
    });
  });

  describe('pruneAndDeduplicateBranches', () => {
    it('prunes near-duplicate branch on same node with same match type and retains higher scoring branch', () => {
      const branches: CrawlBranchLike[] = [
        {
          currentNode: {
            id: 'b1-node',
            nodeId: 'node-A',
            matchType: 'dig',
            score: 0.95,
            chunk: {
              content: 'Primary detail on node A',
              vector: [1, 0, 0],
            },
          },
          currentVector: [1, 0, 0],
        },
        {
          currentNode: {
            id: 'b2-duplicate-node',
            nodeId: 'node-A',
            matchType: 'dig',
            score: 0.85,
            chunk: {
              content: 'Primary detail on node A duplicated',
              vector: [0.98, 0.05, 0], // Sim > 0.85 with b1
            },
          },
          currentVector: [0.98, 0.05, 0],
        },
        {
          currentNode: {
            id: 'b3-link-node',
            nodeId: 'node-A',
            matchType: 'link', // Different match type ('link' vs 'dig') on same node -> PRESERVED!
            score: 0.88,
            chunk: {
              content: 'Perspective connecting node A to elsewhere',
              vector: [0.7, 0.7, 0],
            },
          },
          currentVector: [0.7, 0.7, 0],
        },
        {
          currentNode: {
            id: 'b4-jump-node',
            nodeId: 'node-B', // Different node -> PRESERVED!
            matchType: 'jump',
            score: 0.82,
            chunk: {
              content: 'Jumped to topic B',
              vector: [0, 0, 1],
            },
          },
          currentVector: [0, 0, 1],
        },
      ];

      const pruned = pruneAndDeduplicateBranches(branches, 8, 0.85);

      expect(pruned).toHaveLength(3);
      expect(pruned.map((b) => b.currentNode.id)).toContain('b1-node');
      expect(pruned.map((b) => b.currentNode.id)).not.toContain(
        'b2-duplicate-node',
      );
      expect(pruned.map((b) => b.currentNode.id)).toContain('b3-link-node');
      expect(pruned.map((b) => b.currentNode.id)).toContain('b4-jump-node');
    });

    it('enforces maxBranches ceiling', () => {
      const branches: CrawlBranchLike[] = Array.from(
        { length: 12 },
        (_, i) => ({
          currentNode: {
            id: `branch-${i}`,
            nodeId: `node-${i}`,
            matchType: 'jump',
            score: 0.5 + i * 0.03,
            chunk: { content: `Unique content for branch ${i}` },
          },
        }),
      );

      const pruned = pruneAndDeduplicateBranches(branches, 5);
      expect(pruned).toHaveLength(5);
      // Highest scoring first
      expect(pruned[0]?.currentNode.score).toBeCloseTo(0.5 + 11 * 0.03);
    });

    it('allocates balanced slots across hypothesis groups in comparative mode', () => {
      const branches: CrawlBranchLike[] = [
        // 4 branches from groupA (scores: 0.99, 0.95, 0.90, 0.85)
        {
          currentNode: {
            id: 'a1',
            nodeId: 'na1',
            matchType: 'dig',
            score: 0.99,
            chunk: { content: 'A1' },
          },
          groupOrigin: 'groupA',
        },
        {
          currentNode: {
            id: 'a2',
            nodeId: 'na2',
            matchType: 'dig',
            score: 0.95,
            chunk: { content: 'A2' },
          },
          groupOrigin: 'groupA',
        },
        {
          currentNode: {
            id: 'a3',
            nodeId: 'na3',
            matchType: 'dig',
            score: 0.9,
            chunk: { content: 'A3' },
          },
          groupOrigin: 'groupA',
        },
        {
          currentNode: {
            id: 'a4',
            nodeId: 'na4',
            matchType: 'dig',
            score: 0.85,
            chunk: { content: 'A4' },
          },
          groupOrigin: 'groupA',
        },
        // 2 branches from groupB with slightly lower scores (0.75, 0.70)
        {
          currentNode: {
            id: 'b1',
            nodeId: 'nb1',
            matchType: 'dig',
            score: 0.75,
            chunk: { content: 'B1' },
          },
          groupOrigin: 'groupB',
        },
        {
          currentNode: {
            id: 'b2',
            nodeId: 'nb2',
            matchType: 'dig',
            score: 0.7,
            chunk: { content: 'B2' },
          },
          groupOrigin: 'groupB',
        },
      ];

      // In non-comparative mode with maxBranches = 4, groupA would dominate all 4 slots (0.99, 0.95, 0.90, 0.85).
      // In comparative mode with maxBranches = 4, each group gets at least 2 slots (floor(4 / 2) = 2)!
      const comparativePruned = pruneAndDeduplicateBranches(
        branches,
        4,
        0.85,
        true,
      );

      expect(comparativePruned).toHaveLength(4);
      const groupOrigins = comparativePruned.map((b) => b.groupOrigin);
      expect(groupOrigins.filter((g) => g === 'groupA')).toHaveLength(2);
      expect(groupOrigins.filter((g) => g === 'groupB')).toHaveLength(2);
    });
  });

  describe('connectedNodes in global mode', () => {
    it('returns all other node IDs when direction is global and allNodeIds provided', () => {
      const edges = [{ id: 'e1', source: 'node-a', target: 'node-b' }];
      const allNodeIds = ['node-a', 'node-b', 'node-c', 'node-d'];
      const result = connectedNodes('node-a', edges, 'global', allNodeIds);
      expect(result).toEqual(['node-b', 'node-c', 'node-d']);
    });

    it('extracts all distinct edge endpoints except current node when allNodeIds not provided', () => {
      const edges = [
        { id: 'e1', source: 'node-a', target: 'node-b' },
        { id: 'e2', source: 'node-b', target: 'node-c' },
        { id: 'e3', source: 'node-d', target: 'node-e' },
      ];
      const result = connectedNodes('node-a', edges, 'global');
      expect(result.sort()).toEqual(
        ['node-b', 'node-c', 'node-d', 'node-e'].sort(),
      );
    });
  });

  describe('computeGraphDepthMetrics in global mode', () => {
    it('returns depth metrics reflecting entire graph reachability without traversing edges', () => {
      const nodes = [{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }, { id: 'n4' }];
      const edges = [{ id: 'e1', source: 'n1', target: 'n2' }]; // n3 and n4 have no edges
      const metrics = computeGraphDepthMetrics(nodes, edges, ['n1'], 'global');

      expect(metrics.totalReachableNodes).toBe(4);
      expect(metrics.maxReachableHops).toBe(3);
      expect(metrics.depthLimits).toEqual({
        shallow: 3,
        default: 6,
        deep: 10,
        unlimited: 15,
      });
    });
  });

  describe('chunkArray', () => {
    it('returns empty array when input is empty', () => {
      expect(chunkArray([], 5)).toEqual([]);
    });

    it('splits an array into chunks of specified size', () => {
      const items = [1, 2, 3, 4, 5, 6, 7];
      expect(chunkArray(items, 3)).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
    });

    it('returns single chunk when size is greater than array length', () => {
      const items = ['a', 'b', 'c'];
      expect(chunkArray(items, 10)).toEqual([['a', 'b', 'c']]);
    });

    it('throws error when chunk size is zero or negative', () => {
      expect(() => chunkArray([1, 2], 0)).toThrow(
        'Chunk size must be greater than 0.',
      );
      expect(() => chunkArray([1, 2], -2)).toThrow(
        'Chunk size must be greater than 0.',
      );
    });
  });

  describe('classifyQueryIntent & calculateDynamicAlpha', () => {
    it('classifies definitional queries and returns high dense alpha 0.85', () => {
      expect(classifyQueryIntent('what is backpropagation?')).toBe(
        'definitional',
      );
      expect(classifyQueryIntent('define neural network')).toBe('definitional');
      expect(calculateDynamicAlpha('what is backpropagation?')).toBe(0.85);
    });

    it('classifies procedural queries and returns high dense alpha 0.85', () => {
      expect(
        classifyQueryIntent('how do we compute gradients in PyTorch?'),
      ).toBe('procedural');
      expect(classifyQueryIntent('steps to rebalance an AVL tree')).toBe(
        'procedural',
      );
      expect(calculateDynamicAlpha('how to implement quicksort')).toBe(0.85);
    });

    it('classifies tabular queries and returns balanced alpha 0.60', () => {
      expect(classifyQueryIntent('course grading breakdown')).toBe('tabular');
      expect(calculateDynamicAlpha('exam schedule and dates')).toBe(0.6);
    });

    it('classifies comparative queries and returns alpha 0.75', () => {
      expect(classifyQueryIntent('paxos vs raft consensus')).toBe(
        'comparative',
      );
      expect(calculateDynamicAlpha('difference between L1 and L2')).toBe(0.75);
    });

    it('classifies exact queries with quotes or short symbols and returns low alpha 0.40', () => {
      expect(classifyQueryIntent('"exact match string"')).toBe('exact');
      expect(classifyQueryIntent('O(n log n)')).toBe('exact');
      expect(calculateDynamicAlpha('"exact match"')).toBe(0.4);
    });

    it('defaults to conceptual intent with alpha 0.70', () => {
      expect(classifyQueryIntent('distributed consensus')).toBe('conceptual');
      expect(calculateDynamicAlpha('distributed consensus')).toBe(0.7);
    });
  });

  describe('filterLeadAnswerCandidate', () => {
    const headingChunk = {
      graphId: 'g1',
      sourceId: 's1',
      sourceName: 'notes.md',
      nodeId: 'n1',
      content: '## 3. Backpropagation Algorithm',
      context: 'Full context',
      startChar: 0,
      endChar: 32,
      pageNum: 1,
      elementType: 'heading',
      score: 0.95,
    };

    const shortFragmentChunk = {
      graphId: 'g1',
      sourceId: 's1',
      sourceName: 'notes.md',
      nodeId: 'n1',
      content: 'Brief bullet point.',
      context: 'Full context',
      startChar: 35,
      endChar: 55,
      pageNum: 1,
      elementType: 'text',
      score: 0.88,
    };

    const substantiveBodyChunk = {
      graphId: 'g1',
      sourceId: 's1',
      sourceName: 'notes.md',
      nodeId: 'n1',
      content:
        'The backpropagation algorithm calculates the gradient of the loss function with respect to each weight by the chain rule, iteratively propagating error backward through the layers.',
      context: 'Full context',
      startChar: 60,
      endChar: 240,
      pageNum: 1,
      elementType: 'text',
      score: 0.85,
    };

    it('skips top-ranking heading chunks and selects first substantive body passage', () => {
      const candidates = [headingChunk, substantiveBodyChunk];
      const selected = filterLeadAnswerCandidate(candidates);
      expect(selected).toBeDefined();
      expect(selected?.elementType).toBe('text');
      expect(selected?.content).toBe(substantiveBodyChunk.content);
    });

    it('skips short text fragments when a substantive passage exists', () => {
      const candidates = [
        headingChunk,
        shortFragmentChunk,
        substantiveBodyChunk,
      ];
      const selected = filterLeadAnswerCandidate(candidates);
      expect(selected).toBe(substantiveBodyChunk);
    });

    it('falls back to non-heading chunk if all text chunks are short', () => {
      const candidates = [headingChunk, shortFragmentChunk];
      const selected = filterLeadAnswerCandidate(candidates);
      expect(selected).toBe(shortFragmentChunk);
    });

    it('falls back to top chunk if all candidates are headings', () => {
      const candidates = [headingChunk];
      const selected = filterLeadAnswerCandidate(candidates);
      expect(selected).toBe(headingChunk);
    });

    it('returns undefined when candidate list is empty', () => {
      expect(filterLeadAnswerCandidate([])).toBeUndefined();
    });
  });

  describe('extractSalientAnswerSentence', () => {
    const passage =
      'Machine learning algorithms learn from data. The backpropagation algorithm computes gradients using the chain rule. It updates weights with gradient descent.';

    it('extracts the sentence with highest query term overlap', () => {
      const salient = extractSalientAnswerSentence(
        passage,
        'How does backpropagation compute gradients?',
      );
      expect(salient).toBe(
        'The backpropagation algorithm computes gradients using the chain rule.',
      );
    });

    it('returns trimmed passage if passage is a single sentence', () => {
      const single = 'A hash table provides constant time lookups on average.';
      expect(
        extractSalientAnswerSentence(single, 'hash table time complexity'),
      ).toBe(single);
    });

    it('handles empty input gracefully', () => {
      expect(extractSalientAnswerSentence('', 'query')).toBe('');
    });
  });

  describe('formatRerankPassage', () => {
    it('prepends leading heading from context when present and distinct', () => {
      const chunk = {
        content: 'Weights are adjusted using gradient descent optimization.',
        context:
          'Backpropagation Mechanics\nWeights are adjusted using gradient descent optimization.',
      };
      const formatted = formatRerankPassage(chunk);
      expect(formatted).toBe(
        'Backpropagation Mechanics: Weights are adjusted using gradient descent optimization.',
      );
    });

    it('returns raw content when context is identical or missing', () => {
      const chunk1 = {
        content: 'Weights are adjusted using gradient descent optimization.',
      };
      const chunk2 = {
        content: 'Weights are adjusted using gradient descent optimization.',
        context: 'Weights are adjusted using gradient descent optimization.',
      };
      expect(formatRerankPassage(chunk1)).toBe(chunk1.content);
      expect(formatRerankPassage(chunk2)).toBe(chunk2.content);
    });

    it('does not prepend if content already contains the first line', () => {
      const chunk = {
        content: 'Backpropagation Mechanics: Weights are adjusted.',
        context: 'Backpropagation Mechanics\nWeights are adjusted.',
      };
      expect(formatRerankPassage(chunk)).toBe(chunk.content);
    });
  });

  describe('blendVectorMomentum', () => {
    it('blends candidate and anchor vectors and produces unit-normalized vector', () => {
      const vCandidate = [1, 0, 0];
      const vAnchor = [0, 1, 0];
      const blended = blendVectorMomentum(vCandidate, vAnchor, 0.35);

      expect(blended).toHaveLength(3);
      // blended before norm: [0.65, 0.35, 0]
      // norm: sqrt(0.65^2 + 0.35^2) = sqrt(0.4225 + 0.1225) = sqrt(0.545) = 0.73824
      const norm = Math.sqrt(blended.reduce((sum, val) => sum + val * val, 0));
      expect(norm).toBeCloseTo(1.0, 5);
      expect(blended[0]!).toBeGreaterThan(blended[1]!); // candidate weight > anchor weight
      expect(blended[1]!).toBeGreaterThan(0); // anchor retained
      expect(blended[2]!).toBe(0);
    });

    it('returns candidate vector directly if anchor vector is empty or absent', () => {
      const vCandidate = [0.6, 0.8];
      expect(blendVectorMomentum(vCandidate, undefined)).toEqual(vCandidate);
      expect(blendVectorMomentum(vCandidate, [])).toEqual(vCandidate);
    });
  });

  describe('classifyCrawlCandidate - heading filter', () => {
    it('rejects short heading candidates with fewer than 10 words', () => {
      const match = classifyCrawlCandidate({
        candidateNodeId: 'node-A',
        currentNodeId: 'node-A',
        candidateContent: '# Introduction and Background',
        candidateElementType: 'heading',
        isAdjacentInGraph: true,
      });
      expect(match).toBeNull();
    });

    it('allows substantive heading or regular body candidates', () => {
      const match = classifyCrawlCandidate({
        candidateNodeId: 'node-A',
        currentNodeId: 'node-A',
        candidateContent:
          'This is a substantive paragraph explaining the key algorithmic trade-offs in distributed consensus protocols.',
        candidateElementType: 'paragraph',
        isAdjacentInGraph: true,
        enableDigs: true,
        digsInCurrentTopic: 0,
        maxDigsPerTopic: 3,
      });
      expect(match).toBe('dig');
    });
  });

  describe('isHeadingOrTitleChunk', () => {
    it('identifies pure markdown headers without body text', () => {
      expect(
        isHeadingOrTitleChunk({
          content: '# Chapter 1: Introduction to Machine Learning',
        }),
      ).toBe(true);

      expect(
        isHeadingOrTitleChunk({
          content: '### 3.2 Raft Leader Election State Machine',
        }),
      ).toBe(true);
    });

    it('identifies explicit elementType heading or section_header with short text', () => {
      expect(
        isHeadingOrTitleChunk({
          content: 'Neural Network Architectures',
          elementType: 'heading',
        }),
      ).toBe(true);

      expect(
        isHeadingOrTitleChunk({
          content: 'Section 4: Data Structures Overview',
          elementType: 'section_header',
        }),
      ).toBe(true);
    });

    it('identifies short standalone title lines lacking terminal punctuation', () => {
      expect(
        isHeadingOrTitleChunk({
          content: 'Distributed Systems Course Syllabus',
        }),
      ).toBe(true);

      expect(
        isHeadingOrTitleChunk({
          content: 'Module 5: Graph Algorithms',
        }),
      ).toBe(true);
    });

    it('does NOT exclude substantive passages that happen to start with a section heading', () => {
      const substantiveWithHeader = {
        content:
          '### 2.3 Backpropagation Algorithm\nBackpropagation computes the gradient of the loss function with respect to each network weight using the chain rule, iteratively calculating error contributions backwards across intermediate layers.',
      };
      expect(isHeadingOrTitleChunk(substantiveWithHeader)).toBe(false);
    });

    it('does NOT exclude standard body paragraphs or tables', () => {
      const bodyParagraph = {
        content:
          'In a distributed hash table, each node is assigned a unique identifier in the key space and maintains routing tables to forward lookup queries efficiently.',
        elementType: 'text',
      };
      expect(isHeadingOrTitleChunk(bodyParagraph)).toBe(false);

      const tableChunk = {
        content: '| Operation | Array | Hash Table |\n| Search | O(n) | O(1) |',
        elementType: 'table',
      };
      expect(isHeadingOrTitleChunk(tableChunk)).toBe(false);
    });
  });
});
