export type PlanLimits = {
  maxNodes: number | null;
  maxSourcesPerGraph: number | null;
  maxSourceSizeBytes: number;
  maxSelectedNodes: number | null;
  maxGraphs: number | null;
  maxPrivateGraphs: number | null;
  allowedCrawlDepths: string[];
  allowedHypothesisGroups: number;
  pdfUploadsAllowed: boolean;
  maxUploadsPerHour: number;
};

export type PlanDefinitionRecord = {
  id: string;
  tier: 'ANONYMOUS' | 'REGISTERED';
  name: string;
  description: string | null;
  adsEnabled: boolean;
  limits: PlanLimits;
  version: number;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type AdGraphRevenueItem = {
  graphId: string;
  graphName: string;
  isPublic: boolean;
  impressions: number;
  activeViewableSeconds: number;
  estimatedRevenueUsd: number;
};

export type AdAnalyticsSummary = {
  totalImpressions: number;
  totalCulled: number;
  totalRefreshes: number;
  averageViewabilitySeconds: number;
  totalActiveViewableSeconds: number;
  consentBreakdown: {
    personalized: number;
    contextual: number;
    declined: number;
  };
  estimatedRevenueUsd: number;
  effectiveEcpm: number;
  gpuSavingsPercentage: number;
  range?: string;
  topGraphs?: AdGraphRevenueItem[];
};
