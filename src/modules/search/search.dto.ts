import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class SearchDto {
  @IsString()
  @MaxLength(100)
  graphId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  query!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  selectedNodeIds?: string[];

  @IsOptional()
  @IsIn(['low', 'medium', 'high'])
  sensitivity?: 'low' | 'medium' | 'high';

  @IsOptional()
  @IsIn(['narrow', 'normal', 'wide'])
  scope?: 'narrow' | 'normal' | 'wide';
}

export type SearchSensitivity = 'low' | 'medium' | 'high';
export type SearchScope = 'narrow' | 'normal' | 'wide';

export type CrawlDirection = 'forward' | 'backward' | 'both';
export type CrawlDepth = 'shallow' | 'default' | 'deep' | 'unlimited';
export type CrawlMatchType = 'seed' | 'dig' | 'link' | 'jump';

export class CrawlDto {
  @IsOptional()
  @IsString()
  jobId?: string;

  @IsString()
  @MaxLength(100)
  graphId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  query!: string;

  @IsArray()
  @IsString({ each: true })
  startingNodeIds!: string[];

  @IsOptional()
  @IsIn(['forward', 'backward', 'both'])
  direction?: CrawlDirection;

  @IsOptional()
  @IsIn(['shallow', 'default', 'deep', 'unlimited'])
  crawlDepth?: CrawlDepth;

  @IsOptional()
  @IsIn(['low', 'medium', 'high'])
  sensitivity?: SearchSensitivity;

  @IsOptional()
  @IsBoolean()
  enableDigs?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  maxDigsPerTopic?: number;

  @IsOptional()
  @IsBoolean()
  enableLinks?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(20)
  maxLinks?: number;

  @IsOptional()
  @IsBoolean()
  enableJumps?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(20)
  maxJumps?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  minScore?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  maxCandidatesPerStep?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  maxDepth?: number;

  @IsOptional()
  @IsBoolean()
  comparativeMode?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  groupBStartingNodeIds?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => HypothesisGroupDto)
  hypothesisGroups?: HypothesisGroupDto[];

  @IsOptional()
  @IsNumber()
  @Min(0.0)
  @Max(1.0)
  maxBranchEntropy?: number;
}

export class HypothesisGroupDto {
  @IsString()
  id!: string;

  @IsString()
  name!: string;

  @IsArray()
  @IsString({ each: true })
  nodeIds!: string[];

  @IsOptional()
  @IsString()
  color?: string;
}

export type ComparativeGroupSummary = {
  id: string;
  name: string;
  count: number;
  color?: string;
  entropy?: number;
  entropyDelta?: number;
  avgScore?: number;
};

export type CrawlNode = {
  id: string;
  level: number;
  matchType?: CrawlMatchType;
  nodeId: string;
  nodeTitle: string;
  chunk: import('../../common/types.js').SearchChunk;
  score: number;
  rerankScore?: number;
  parentCrawlNodeId?: string;
  stepDescription?: string;
  groupOrigin?: 'groupA' | 'groupB' | 'intersection' | string;
  reachedGroupIds?: string[];
  branchEntropy?: number;
  isPruned?: boolean;
};

export type CrawlEdge = {
  id: string;
  source: string;
  target: string;
  level: number;
  matchType?: CrawlMatchType;
  direction?: CrawlDirection;
  similarityScore?: number;
  sharedKeywords?: string[];
};

export type CrawlSummaryStats = {
  digsCount: number;
  linksCount: number;
  jumpsCount: number;
  seedTitle: string;
};

export type CrawlResponse = {
  queryId: string;
  jobId?: string;
  queryType: 'crawl';
  queryText: string;
  expandedKeywords?: string[];
  startingNodeIds: string[];
  crawlDepth: CrawlDepth;
  direction?: CrawlDirection;
  sensitivity: SearchSensitivity;
  nodes: CrawlNode[];
  edges: CrawlEdge[];
  maxLevelReached: number;
  totalMatches: number;
  matchedNodeIds: string[];
  remaining: number;
  searchSpaceMultiplier?: number;
  creditsCost?: number;
  summary?: string;
  stats?: CrawlSummaryStats;
  maxBranchEntropy?: number;
  prunedBranchesCount?: number;
  comparative?: {
    isComparative: boolean;
    groupACount: number;
    groupBCount: number;
    intersectionCount: number;
    intersectionNodeTitles: string[];
    groups?: ComparativeGroupSummary[];
  };
};

export type CrawlProgressPayload = {
  graphId: string;
  level: number;
  status: string;
  message: string;
  matchesCount?: number;
  totalMatches?: number;
  currentNodes?: CrawlNode[];
  currentEdges?: CrawlEdge[];
  stats?: CrawlSummaryStats;
  maxBranchEntropy?: number;
  prunedBranchesCount?: number;
  averageBranchEntropy?: number;
};

export type CancelCrawlResponse = {
  jobId: string;
  cancelled: boolean;
  message: string;
};

export class UpdateQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  title?: string;

  @IsOptional()
  @IsBoolean()
  isPinned?: boolean;
}
