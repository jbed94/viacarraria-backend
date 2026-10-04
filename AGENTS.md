# Via Carraria — Backend Specification (`viacarraria-backend`)

Backend NestJS microservice: REST endpoints, WebSocket progress updates, CASL authorization, Redis rate limiting, Weaviate vector search orchestration, S3 document storage, and administrative telemetry.

---

## Tech Stack

- **Runtime & Framework**: Node.js, NestJS, TypeScript
- **Database & ORM**: PostgreSQL, Prisma ORM
- **Cache & Quota Engine**: Redis, `ioredis`, `@upstash/ratelimit`
- **Message Broker**: RabbitMQ (`amqplib`)
- **Vector Database Client**: Weaviate TypeScript SDK v3 (gRPC 50051 / REST 8080)
- **Neural Inference Clients**: HTTP clients for TEI Embedding and TEI BGE Reranking engines
- **Storage Driver**: AWS S3 SDK (`@aws-sdk/client-s3`) targeting local MinIO or upstream cloud storage
- **Authentication**: Better Auth (credentials, OAuth, anonymous sessions)
- **Authorization**: CASL (`@casl/ability`)
- **Billing**: LemonSqueezy and Stripe SDKs

---

## Environment & Directory Rules

- **Env (`environment.yml`)**: Mamba env `viacarraria-backend`. Tools: `nodejs`, `pnpm` only.
- **Install**: `mamba run -n viacarraria-backend pnpm install`
- **Packaging**: `platforms/docker/` contains Dockerfile. Compose and Helm files reside in `viacarraria-infrastructure`.

---

## Core Modules & Implemented Functionality

```
src/
├── modules/
│   ├── auth/           # Better Auth identity, credentials, OAuth, anonymous sessions, account linking
│   ├── graphs/         # Graph CRUD, JSONB canvas persistence, debounced auto-save, graph copying
│   ├── sources/        # Multipart file upload, S3 storage, SHA-256 deduplication, parsing dispatch
│   ├── search/         # Spatial GraphRAG hybrid vector search, TEI reranking, parent-span resolution
│   ├── plans/          # Dynamic plans, credit tracking & top-up, ad telemetry rollups & retention
│   ├── billing/        # Stripe & LemonSqueezy checkout and webhook lifecycle synchronization
│   ├── notifications/  # In-app notifications delivery and tracking
│   └── admin/          # Admin API: user tiers, graph inspection, audit logging, telemetry controls
├── common/
│   ├── guards/         # Roles Guard, Rate Limit Guard, CASL Ability Guard
│   ├── middleware/     # Anonymous session middleware, IP abuse protection
│   └── services/       # Prisma, Redis, RabbitMQ, Weaviate, TEI client, S3 storage client
└── main.ts
```

### Implemented Capabilities

1. **Authentication & Identity (`auth`)**:
   - Manages session lifecycle via Better Auth: email signup/login, Google OAuth, sign-out, password modification, session revocation.
   - Anonymous session engine with IP abuse protection: max 10 anonymous sessions per IP address or subnet per hour.
   - Account linking callback migrates guest query history when upgrading to registered credentials.

2. **Graph Management (`graphs`)**:
   - Lists accessible graphs: pre-baked public templates owned by system user `"jbed94"` plus user-created graphs.
   - Retrieves full canvas data (`nodes`, `edges` JSONB), user edit permissions, and privacy-preserving access counts.
   - Auto-save endpoint updates canvas structures asynchronously from frontend debounced changes.
   - Supports graph copying into private user workspaces (quota-checked) and finalization triggers for document ingestion.

3. **Document Sources & Ingestion Dispatch (`sources`)**:
   - Handles multipart uploads for PDF, Markdown, and TXT files.
   - Stores files in S3-compatible storage (MinIO local or cloud S3/GCS) and computes SHA-256 hashes in Redis (`hash:<sha256>`) to avoid redundant parsing.
   - Publishes ingestion payloads to RabbitMQ `document_parsing_queue` with priority tags (Pro = 10, Free = 1).
   - Real-time WebSocket gateway emits parsing progress to connected frontend clients from Redis updates.

4. **Spatial GraphRAG Engine (`search`)**:
   - Receives search requests with query text, target graph ID, and selected node IDs.
   - Generates dense query embeddings via Text Embeddings Inference (TEI) service.
   - Executes Weaviate Hybrid Search (70% dense vector + 30% BM25 keyword weighting) pre-filtered by selected node IDs.
   - Passes candidate hits through TEI BGE Reranker model for contextual relevance re-scoring.
   - Resolves chunk hierarchy: maps matching child chunks to parent context spans and returns character offsets (`startChar`, `endChar`) for UI document viewer highlighting.
   - Extended Search: retrieves one-hop adjacent-node context snippets using stored vectors without sending vectors to the client.

5. **Plans, Credits & Ad Telemetry (`plans`)**:
   - Dynamic plan configuration defining feature access, daily query quotas, and graph limits.
   - Credit-based accounting: balance management, debiting per action, and credit top-up order processing.
   - Ad telemetry ingestion: collects impressions, clicks, and dismissals from client ad cards.
   - Automated scheduled daily rollup cron: executes daily aggregation sweeps every 24 hours to create rollup summaries.
   - Safe retention purging: prunes raw telemetry records older than 90 days only after verifying pre-aggregation into daily rollups.

6. **Billing & Subscriptions (`billing`)**:
   - Generates checkout sessions for paid tiers via LemonSqueezy and Stripe.
   - Webhook consumers handle subscription creation, recurring payment success, and cancellation, synchronizing user subscription status in PostgreSQL.

7. **System Administration (`admin`)**:
   - Administrative endpoints supporting decoupled admin panel: inspect user lists, alter subscription tiers, audit active sessions.
   - Inspect and edit raw canvas JSON structures.
   - Audit event logging: records administrative operations for compliance.
   - Retention sweep execution, ad telemetry status inspection, manual rollup triggers, and S3 cold storage export archives.

---

## Authorization & Usage Enforcement

- **CASL Abilities**:
  - Anonymous: query demo graphs, max 2 selected nodes; no custom graphs or file uploads.
  - Free: query accessible graphs, max 10 selected nodes; up to 3 custom graphs (limits: 10 nodes, 3 sources/node, 2MB file limit).
  - Pro: query all graphs, unlimited selected nodes; unlimited custom graphs, custom file uploads, priority queue processing.
  - System Owner (`"jbed94"`): exclusive authoring rights on public system templates.
- **Rate Limiting Middleware**:
  - Daily query tracking in Redis key `usage:<identifier>:<YYYY-MM-DD>` with 24-hour expiration.
  - Returns `X-RateLimit-Remaining` header and `429 Too Many Requests` on budget exhaustion.

---

## Operational Commands

- `pnpm --filter api test` (Unit tests)
- `pnpm --filter api test:watch` (Watch mode)
- `pnpm --filter api test:e2e` (Integration tests)
- `pnpm --filter api lint` (Linter)
