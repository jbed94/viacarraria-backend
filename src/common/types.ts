import type { Request } from 'express';

export type SubscriptionTier = 'ANONYMOUS' | 'REGISTERED';

export type ViewerIdentity = {
  userId: string;
  tier: SubscriptionTier;
  email: string | null;
  username: string | null;
  isGuest: boolean;
  role?: 'admin' | 'user';
  storageLimitMb?: number | null;
};

export type GraphPermission = 'OWNER' | 'VIEWER';

export type LimitStatus = {
  used: number;
  limit: number | null;
  exceeded: boolean;
};

export type StorageStatus = {
  usedBytes: number;
  limitBytes: number;
  usedMb: number;
  limitMb: number;
  exceeded: boolean;
};

export type QueueOccupation = 'low' | 'mid' | 'high';

export type CrawlEntitlements = {
  allowedDepths: string[];
  maxStartingPoints: number;
  comparativeModeAllowed: boolean;
};

export type LimitsSummary = {
  tier: SubscriptionTier;
  storage: StorageStatus;
  queueOccupation: QueueOccupation;
  canCreateGraphs: boolean;
  crawl: CrawlEntitlements;
  graphs?: LimitStatus;
  privateGraphs?: LimitStatus;
  queries?: LimitStatus;
  uploads?: LimitStatus;
  selectedNodes?: LimitStatus;
  nodesPerGraph?: LimitStatus;
  sourcesPerNode?: LimitStatus;
  sourceSizeBytes?: LimitStatus;
  extendedContext?: LimitStatus;
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
  imageAssetUrl?: string;
  lqip?: string;
  chunkId?: string;
  score: number;
  rerankScore?: number;
  kind?: 'MATCH' | 'EXTENDED';
  extendedContext?: SearchChunk[];
};

export type AdminUserRow = {
  id: string;
  name: string;
  email: string;
  username: string | null;
  isAnonymous: boolean;
  subscriptionTier: SubscriptionTier;
  subscriptionExpiresAt: string | null;
  storageLimitMb: number | null;
  preferredLanguage: string;
  createdAt: Date | string;
  updatedAt: Date | string;
  graphsCount: number;
  sourcesCount: number;
  usedStorageBytes: string | number;
};

export type AdminUserDetailsRow = {
  id: string;
  name: string;
  email: string;
  username: string | null;
  isAnonymous: boolean;
  subscriptionTier: SubscriptionTier;
  subscriptionExpiresAt: string | null;
  storageLimitMb: number | null;
  preferredLanguage: string;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type AdminUserGraphRow = {
  id: string;
  title: string;
  isPublic: boolean;
  isExemptFromRetention: boolean;
  lastAccessedAt: Date | string;
  createdAt: Date | string;
};

export type AdminUserRecentQueryRow = {
  id: string;
  graphId: string;
  queryText: string;
  createdAt: Date | string;
};

export type AdminGraphInspectionRow = {
  id: string;
  title: string;
  description: string | null;
  userId: string;
  isPublic: boolean;
  isPrepared: boolean;
  nodeCount: number;
  sourceCount: number;
  viewerCount: number;
  isExemptFromRetention: boolean;
  scheduledForDeletionAt: Date | string | null;
  lastAccessedAt: Date | string;
  createdAt: Date | string;
  updatedAt: Date | string;
  ownerEmail: string | null;
  ownerName: string | null;
};

export type AdminGraphDetailsRow = {
  id: string;
  title: string;
  description: string | null;
  userId: string;
  isPublic: boolean;
  isPrepared: boolean;
  nodes: any;
  edges: any;
  lastAccessedAt: Date | string;
  scheduledForDeletionAt: Date | string | null;
  isExemptFromRetention: boolean;
  createdAt: Date | string;
  updatedAt: Date | string;
  ownerEmail: string | null;
  ownerName: string | null;
};

export type AdminSourceInspectionRow = {
  id: string;
  nodeId: string;
  name: string;
  fileType: string;
  fileUrl: string;
  sizeBytes: number;
  status: string;
  createdAt: Date | string;
};

export type AdminUserExportRow = {
  id: string;
  name: string;
  email: string;
  username: string | null;
  isAnonymous: boolean;
  subscriptionTier: SubscriptionTier;
  subscriptionExpiresAt: string | null;
  storageLimitMb: number | null;
  createdAt: Date | string;
  graphsCount: number;
  sourcesCount: number;
  usedStorageBytes: string | number;
};
