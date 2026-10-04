import {
  computeChunkSimilarity,
  calculateMmrScore,
  computeCentroid,
  calculateComparativeMmrScore,
  selectDiverseCandidatesMmr,
  pruneAndDeduplicateBranches,
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
});
