import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { copyFile, mkdir, rm } from 'fs/promises';
import { extname, join } from 'path';

import { validateCanvas } from '../../common/canvas.js';
import { AuthorizationService } from '../../common/authorization/ability.js';
import { DatabaseService } from '../../common/services/database.service.js';
import type {
  CanvasEdge,
  CanvasNode,
  GraphPermission,
  ViewerIdentity,
} from '../../common/types.js';
import { AuthService } from '../auth/auth.service.js';
import type {
  CopyGraphDto,
  CreateGraphDto,
  UpdateGraphDto,
} from './graphs.dto.js';

export type GraphRecord = {
  id: string;
  title: string;
  description: string | null;
  userId: string;
  isPublic: boolean;
  isPrepared: boolean;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  createdAt: Date;
  updatedAt: Date;
};

export type GraphResponse = GraphRecord & GraphAccessMetadata;

export type GraphDetailResponse = GraphResponse & {
  sources: SourceSummary[];
};

export type GraphAccessMetadata = {
  isOwned: boolean;
  permission: GraphPermission;
  canEdit: boolean;
  accessCount: number;
};

type CopySourceRecord = SourceSummary & {
  fileHash: string;
  content: string | null;
  error: string | null;
};

@Injectable()
export class GraphsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly auth: AuthService,
    private readonly authorization: AuthorizationService,
    config: ConfigService,
  ) {
    this.uploadDirectory =
      config.get<string>('UPLOAD_DIR') ?? join(process.cwd(), 'uploads');
  }

  private readonly uploadDirectory: string;

  async list(identity: ViewerIdentity | undefined): Promise<GraphResponse[]> {
    const graphs = await this.database.query<GraphRecord>(
      `SELECT "id", "title", "description", "userId", "isPublic", "isPrepared", "nodes", "edges", "createdAt", "updatedAt"
       FROM "Graph"
       WHERE "isPublic" = true OR "userId" = $1
       ORDER BY "isPublic" DESC, "updatedAt" DESC`,
      [identity?.userId ?? ''],
    );
    return Promise.all(
      graphs.map(async (graph) => ({
        ...graph,
        ...(await this.accessMetadata(identity, graph)),
      })),
    );
  }

  async get(
    identity: ViewerIdentity | undefined,
    graphId: string,
  ): Promise<GraphDetailResponse> {
    const graph = await this.findAccessible(identity, graphId);
    const sources = await this.database.query<SourceSummary>(
      `SELECT "id", "nodeId", "name", "fileType", "fileUrl", "sizeBytes", "status", "jobId", "createdAt", "updatedAt"
       FROM "NodeSource" WHERE "graphId" = $1 ORDER BY "createdAt" ASC`,
      [graph.id],
    );
    return {
      ...graph,
      sources,
      ...(await this.accessMetadata(identity, graph)),
    };
  }

  async create(
    identity: ViewerIdentity | undefined,
    dto: CreateGraphDto,
  ): Promise<GraphDetailResponse> {
    const viewer = this.auth.requireRegistered(
      this.auth.requireIdentity(identity),
    );
    await this.assertGraphQuota(viewer);
    const id = randomUUID();
    const [graph] = await this.database.query<GraphRecord>(
      `INSERT INTO "Graph" ("id", "title", "description", "userId", "nodes", "edges", "updatedAt")
       VALUES ($1, $2, $3, $4, '[]'::jsonb, '[]'::jsonb, CURRENT_TIMESTAMP)
       RETURNING "id", "title", "description", "userId", "isPublic", "isPrepared", "nodes", "edges", "createdAt", "updatedAt"`,
      [id, dto.title.trim(), dto.description?.trim() || null, viewer.userId],
    );
    if (!graph) {
      throw new NotFoundException('Graph could not be created.');
    }
    return this.get(viewer, graph.id);
  }

  async copy(
    identity: ViewerIdentity | undefined,
    graphId: string,
    dto: CopyGraphDto,
  ): Promise<GraphDetailResponse> {
    const viewer = this.auth.requireRegistered(
      this.auth.requireIdentity(identity),
    );
    const sourceGraph = await this.findAccessible(viewer, graphId);
    this.authorization.assertCan(viewer, 'copy', 'Graph', sourceGraph);
    if (viewer.tier === 'FREE' && sourceGraph.nodes.length > 10) {
      throw new ForbiddenException(
        'Free accounts can copy graphs with up to ten nodes. Upgrade to Pro to copy this graph.',
      );
    }
    await this.assertGraphQuota(viewer);

    const sources = await this.database.query<CopySourceRecord>(
      `SELECT "id", "nodeId", "graphId", "name", "fileType", "fileUrl", "fileHash", "sizeBytes", "status", "jobId", "content", "error", "createdAt", "updatedAt"
       FROM "NodeSource" WHERE "graphId" = $1 ORDER BY "createdAt" ASC`,
      [sourceGraph.id],
    );
    const copiedFiles: string[] = [];
    const copiedGraphId = randomUUID();
    try {
      const isPrepared =
        sourceGraph.isPrepared &&
        sources.every((source) => source.status === 'READY');
      const [copiedGraph] = await this.database.query<GraphRecord>(
        `INSERT INTO "Graph" ("id", "title", "description", "userId", "isPublic", "isPrepared", "nodes", "edges", "updatedAt")
         VALUES ($1, $2, $3, $4, false, $5, $6::jsonb, $7::jsonb, CURRENT_TIMESTAMP)
         RETURNING "id", "title", "description", "userId", "isPublic", "isPrepared", "nodes", "edges", "createdAt", "updatedAt"`,
        [
          copiedGraphId,
          dto.title.trim(),
          sourceGraph.description,
          viewer.userId,
          isPrepared,
          JSON.stringify(sourceGraph.nodes),
          JSON.stringify(sourceGraph.edges),
        ],
      );
      if (!copiedGraph) {
        throw new NotFoundException('Graph could not be copied.');
      }

      for (const source of sources) {
        const copiedSourceId = randomUUID();
        const fileUrl = await this.copySourceFile(
          source,
          copiedSourceId,
          copiedFiles,
        );
        await this.database.query(
          `INSERT INTO "NodeSource" ("id", "nodeId", "graphId", "name", "fileType", "fileUrl", "fileHash", "sizeBytes", "status", "jobId", "content", "error", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::"SourceStatus", NULL, $10, $11, CURRENT_TIMESTAMP)`,
          [
            copiedSourceId,
            source.nodeId,
            copiedGraphId,
            source.name,
            source.fileType,
            fileUrl,
            source.fileHash,
            source.sizeBytes,
            source.status,
            source.content,
            source.error,
          ],
        );
      }
    } catch (error: unknown) {
      await this.database.query('DELETE FROM "Graph" WHERE "id" = $1', [
        copiedGraphId,
      ]);
      await Promise.all(
        copiedFiles.map((filePath) => rm(filePath, { force: true })),
      );
      throw error;
    }
    return this.get(viewer, copiedGraphId);
  }

  async update(
    identity: ViewerIdentity | undefined,
    graphId: string,
    dto: UpdateGraphDto,
  ): Promise<GraphDetailResponse> {
    const viewer = this.auth.requireRegistered(
      this.auth.requireIdentity(identity),
    );
    const graph = await this.findEditable(viewer, graphId);
    const canvas = validateCanvas(dto.nodes, dto.edges);
    if (viewer.tier === 'FREE' && canvas.nodes.length > 10) {
      throw new ForbiddenException('Free graphs are limited to ten nodes.');
    }
    const [updated] = await this.database.query<GraphRecord>(
      `UPDATE "Graph" SET "nodes" = $1::jsonb, "edges" = $2::jsonb, "isPrepared" = false, "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = $3
       RETURNING "id", "title", "description", "userId", "isPublic", "isPrepared", "nodes", "edges", "createdAt", "updatedAt"`,
      [JSON.stringify(canvas.nodes), JSON.stringify(canvas.edges), graph.id],
    );
    if (!updated) {
      throw new NotFoundException('Graph not found.');
    }
    await this.database.query(
      'DELETE FROM "NodeSource" WHERE "graphId" = $1 AND NOT ("nodeId" = ANY($2::text[]))',
      [graph.id, canvas.nodes.map((node) => node.id)],
    );
    return this.get(viewer, graph.id);
  }

  async finalize(
    identity: ViewerIdentity | undefined,
    graphId: string,
  ): Promise<GraphDetailResponse> {
    const viewer = this.auth.requireRegistered(
      this.auth.requireIdentity(identity),
    );
    const graph = await this.findEditable(viewer, graphId);
    const [updated] = await this.database.query<GraphRecord>(
      `UPDATE "Graph" SET "isPrepared" = true, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1
       RETURNING "id", "title", "description", "userId", "isPublic", "isPrepared", "nodes", "edges", "createdAt", "updatedAt"`,
      [graph.id],
    );
    if (!updated) {
      throw new NotFoundException('Graph not found.');
    }
    return this.get(viewer, graph.id);
  }

  async delete(
    identity: ViewerIdentity | undefined,
    graphId: string,
  ): Promise<void> {
    const graph = await this.findEditable(identity, graphId);
    await this.database.query('DELETE FROM "Graph" WHERE "id" = $1', [
      graph.id,
    ]);
  }

  async findAccessible(
    identity: ViewerIdentity | undefined,
    graphId: string,
  ): Promise<GraphRecord> {
    const graph = await this.database.one<GraphRecord>(
      `SELECT "id", "title", "description", "userId", "isPublic", "isPrepared", "nodes", "edges", "createdAt", "updatedAt"
       FROM "Graph" WHERE "id" = $1`,
      [graphId],
    );
    if (!graph) {
      throw new NotFoundException('Graph not found.');
    }
    this.authorization.assertCan(identity, 'read', 'Graph', graph);
    return graph;
  }

  async findEditable(
    identity: ViewerIdentity | undefined,
    graphId: string,
  ): Promise<GraphRecord> {
    const viewer = this.auth.requireRegistered(
      this.auth.requireIdentity(identity),
    );
    this.authorization.assertCan(viewer, 'update', 'Graph', {
      userId: viewer.userId,
      isPublic: false,
    });
    const graph = await this.findAccessible(viewer, graphId);
    this.authorization.assertCan(viewer, 'update', 'Graph', graph);
    return graph;
  }

  private async assertGraphQuota(viewer: ViewerIdentity): Promise<void> {
    if (viewer.tier !== 'FREE') return;
    const row = await this.database.one<{ count: string }>(
      'SELECT COUNT(*)::text AS "count" FROM "Graph" WHERE "userId" = $1',
      [viewer.userId],
    );
    if (Number(row?.count ?? '0') >= 3) {
      throw new ForbiddenException(
        'Free accounts can create up to three custom graphs.',
      );
    }
  }

  private async accessMetadata(
    identity: ViewerIdentity | undefined,
    graph: GraphRecord,
  ): Promise<GraphAccessMetadata> {
    const isOwned = graph.userId === identity?.userId;
    const accessCount = graph.isPublic
      ? Number(
          (
            await this.database.one<{ count: string }>(
              'SELECT COUNT(*)::text AS "count" FROM "User" WHERE "isAnonymous" = false',
            )
          )?.count ?? '0',
        )
      : 1;
    return {
      isOwned,
      permission: isOwned ? 'OWNER' : 'VIEWER',
      canEdit: isOwned,
      accessCount: Math.max(accessCount, 1),
    };
  }

  private async copySourceFile(
    source: CopySourceRecord,
    copiedSourceId: string,
    copiedFiles: string[],
  ): Promise<string> {
    if (source.fileUrl.startsWith('seed://') || source.content !== null) {
      return `seed://copy-${copiedSourceId}`;
    }
    const extension =
      extname(source.fileUrl) || this.extensionFor(source.fileType);
    const target = join(this.uploadDirectory, `${copiedSourceId}${extension}`);
    await mkdir(this.uploadDirectory, { recursive: true });
    await copyFile(source.fileUrl, target);
    copiedFiles.push(target);
    return target;
  }

  private extensionFor(fileType: string): string {
    return fileType === 'application/pdf'
      ? '.pdf'
      : fileType === 'text/markdown'
        ? '.md'
        : '.txt';
  }
}

export type SourceSummary = {
  id: string;
  nodeId: string;
  name: string;
  fileType: string;
  fileUrl: string;
  sizeBytes: number;
  status: 'PENDING' | 'PROCESSING' | 'READY' | 'ERROR';
  jobId: string | null;
  createdAt: Date;
  updatedAt: Date;
};
