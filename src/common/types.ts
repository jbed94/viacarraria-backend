import type { Request } from 'express';

export type SubscriptionTier = 'ANONYMOUS' | 'FREE' | 'PRO';

export type ViewerIdentity = {
  userId: string;
  tier: SubscriptionTier;
  email: string | null;
  username: string | null;
  isGuest: boolean;
};

export type GraphPermission = 'OWNER' | 'VIEWER';

export type LimitStatus = {
  used: number;
  limit: number | null;
  exceeded: boolean;
};

export type LimitsSummary = {
  tier: SubscriptionTier;
  graphs: LimitStatus;
  privateGraphs: LimitStatus;
  queries: LimitStatus;
  uploads: LimitStatus;
  selectedNodes: LimitStatus;
  nodesPerGraph: LimitStatus;
  sourcesPerNode: LimitStatus;
  sourceSizeBytes: LimitStatus;
  extendedContext: LimitStatus;
};

export type AuthenticatedRequest = Request & {
  identity?: ViewerIdentity;
};

export type CanvasNode = {
  id: string;
  position: { x: number; y: number };
  data: {
    title: string;
    category?: string;
    description?: string;
  };
};

export type CanvasEdge = {
  id: string;
  source: string;
  target: string;
};

export type LeadAnswerType =
  'direct' | 'procedural' | 'definitional' | 'tabular';

export type LeadAnswer = {
  chunk: SearchChunk;
  score: number;
  answerType: LeadAnswerType;
  prerequisiteNodes?: Array<{ id: string; title: string }>;
  extensionNodes?: Array<{ id: string; title: string }>;
  surroundingContext?: SearchChunk[];
};

export type SearchChunk = {
  graphId: string;
  sourceId: string;
  sourceName: string;
  nodeId: string;
  content: string;
  context: string;
  startChar: number;
  endChar: number;
  pageNum: number;
  coordinates?: number[];
  elementType?: string;
  score: number;
  rerankScore?: number;
  kind?: 'MATCH' | 'EXTENDED';
  extendedContext?: SearchChunk[];
};
