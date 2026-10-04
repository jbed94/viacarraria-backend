import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type QueryResultRow } from 'pg';

import { authDatabase } from '../../auth.js';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly pool = authDatabase;

  constructor(config: ConfigService) {
    config.getOrThrow<string>('DATABASE_URL');
  }

  async onModuleInit(): Promise<void> {
    await this.pool.query('SELECT 1');
    await this.ensureSeedDefaults();
    this.logger.log(
      'Connected to PostgreSQL and verified system settings and plan defaults',
    );
  }

  private async ensureSeedDefaults(): Promise<void> {
    await this.pool.query(`
      UPDATE "User" SET "subscriptionTier" = 'REGISTERED' WHERE "subscriptionTier" IN ('FREE', 'PRO');

      INSERT INTO "SystemSettings" ("key", "value", "updatedAt")
      VALUES
        ('similarityQuota', '{"anonymousThroughputPerMinute": 30, "registeredThroughputPerMinute": 120}'::jsonb, CURRENT_TIMESTAMP),
        ('storageConfig', '{"defaultStorageLimitMb": 100}'::jsonb, CURRENT_TIMESTAMP),
        ('adConfig', '{"effectiveEcpm": 1.5, "canvasAdDensity": 35, "maxCanvasAds": 5}'::jsonb, CURRENT_TIMESTAMP)
      ON CONFLICT ("key") DO NOTHING;

      DELETE FROM "PlanDefinition" WHERE "tier" = 'PRO';

      INSERT INTO "PlanDefinition" (
        "id", "tier", "name", "description", "adsEnabled", "limits", "version", "updatedAt"
      ) VALUES
      (
        'plan-anon', 'ANONYMOUS', 'Anonymous Guest', 'Public exploration with single-seed shallow crawl.',
        true,
        '{"maxNodes":0,"maxSourcesPerGraph":0,"maxSourceSizeBytes":0,"maxSelectedNodes":2,"maxGraphs":0,"maxPrivateGraphs":0,"allowedCrawlDepths":["shallow"],"allowedHypothesisGroups":0,"pdfUploadsAllowed":false,"maxUploadsPerHour":0}'::jsonb,
        1, CURRENT_TIMESTAMP
      ),
      (
        'plan-registered', 'REGISTERED', 'Registered User', 'Full graph creation and deep multi-hop traversal with 100MB source storage.',
        true,
        '{"maxNodes":null,"maxSourcesPerGraph":null,"maxSourceSizeBytes":52428800,"maxSelectedNodes":null,"maxGraphs":null,"maxPrivateGraphs":null,"allowedCrawlDepths":["shallow","default","deep"],"allowedHypothesisGroups":4,"pdfUploadsAllowed":true,"maxUploadsPerHour":50}'::jsonb,
        1, CURRENT_TIMESTAMP
      )
      ON CONFLICT ("tier") DO UPDATE
      SET "name" = EXCLUDED."name",
          "description" = EXCLUDED."description",
          "limits" = EXCLUDED."limits",
          "adsEnabled" = EXCLUDED."adsEnabled";

      CREATE TABLE IF NOT EXISTS "AdContextTag" (
        "id" TEXT PRIMARY KEY,
        "name" TEXT NOT NULL,
        "slug" TEXT NOT NULL UNIQUE,
        "description" TEXT NOT NULL,
        "enabled" BOOLEAN NOT NULL DEFAULT true,
        "sendCount" INTEGER NOT NULL DEFAULT 0,
        "matchCount" INTEGER NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS "AdContextTag_enabled_idx" ON "AdContextTag"("enabled");
      CREATE INDEX IF NOT EXISTS "AdContextTag_slug_idx" ON "AdContextTag"("slug");

      CREATE TABLE IF NOT EXISTS "SourceAdTag" (
        "id" TEXT PRIMARY KEY,
        "sourceId" TEXT NOT NULL REFERENCES "NodeSource"("id") ON DELETE CASCADE,
        "tagId" TEXT NOT NULL REFERENCES "AdContextTag"("id") ON DELETE CASCADE,
        "score" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "SourceAdTag_sourceId_tagId_key" UNIQUE ("sourceId", "tagId")
      );

      CREATE INDEX IF NOT EXISTS "SourceAdTag_sourceId_idx" ON "SourceAdTag"("sourceId");
      CREATE INDEX IF NOT EXISTS "SourceAdTag_tagId_idx" ON "SourceAdTag"("tagId");

      INSERT INTO "AdContextTag" ("id", "name", "slug", "description", "enabled", "sendCount", "matchCount", "updatedAt")
      VALUES
        ('tag-ai', 'Artificial Intelligence & Machine Learning', 'artificial-intelligence', 'Machine learning algorithms, neural networks, deep learning, NLP, computer vision, LLMs, and generative AI models.', true, 0, 0, CURRENT_TIMESTAMP),
        ('tag-cs', 'Computer Science & Software Architecture', 'computer-science', 'Software engineering, algorithms, data structures, programming languages, system design, and distributed systems.', true, 0, 0, CURRENT_TIMESTAMP),
        ('tag-cloud', 'Cloud Infrastructure & DevOps', 'cloud-infrastructure', 'Cloud platforms, Kubernetes, Docker, container orchestration, CI/CD pipelines, microservices, and serverless architectures.', true, 0, 0, CURRENT_TIMESTAMP),
        ('tag-sec', 'Cybersecurity & Information Protection', 'cybersecurity', 'Network security, cryptography, threat modeling, vulnerability detection, identity management, and data privacy.', true, 0, 0, CURRENT_TIMESTAMP),
        ('tag-data', 'Data Science & Big Data Engineering', 'data-science', 'Big data processing, data analytics, SQL, NoSQL databases, vector search, predictive modeling, and data pipelines.', true, 0, 0, CURRENT_TIMESTAMP),
        ('tag-bio', 'Biotechnology & Bioinformatics', 'biotechnology', 'Computational biology, genetics, genomics, proteomics, molecular modeling, and pharmaceutical research.', true, 0, 0, CURRENT_TIMESTAMP),
        ('tag-med', 'Healthcare & Clinical Medicine', 'healthcare-medicine', 'Medical science, clinical trials, healthcare diagnostics, immunology, public health, and biomedical engineering.', true, 0, 0, CURRENT_TIMESTAMP),
        ('tag-energy', 'Renewable Energy & Climate Tech', 'renewable-energy', 'Clean energy, solar power, wind turbines, battery storage, sustainability, carbon capture, and green technology.', true, 0, 0, CURRENT_TIMESTAMP),
        ('tag-fin', 'Economics, Finance & FinTech', 'economics-finance', 'Financial markets, macroeconomics, algorithmic trading, financial technology, banking, risk management, and quantitative finance.', true, 0, 0, CURRENT_TIMESTAMP),
        ('tag-quantum', 'Physics, Quantum & Robotics', 'physics-engineering', 'Quantum computing, mechanical robotics, theoretical physics, electrical engineering, embedded hardware, and automation.', true, 0, 0, CURRENT_TIMESTAMP)
      ON CONFLICT ("slug") DO UPDATE
      SET "name" = EXCLUDED."name",
          "description" = EXCLUDED."description";
    `);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  async query<Row extends QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<Row[]> {
    const result = await this.pool.query<Row>(text, values);
    return result.rows;
  }

  async one<Row extends QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<Row | undefined> {
    const [row] = await this.query<Row>(text, values);
    return row;
  }
}
