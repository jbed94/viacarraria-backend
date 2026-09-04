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
  kind?: 'MATCH' | 'EXTENDED';
  extendedContext?: SearchChunk[];
};
