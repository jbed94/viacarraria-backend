# Via Carraria — Backend Sub-Repository Specification (`viacarraria-backend`)

The backend microservice provides core REST endpoints, real-time WebSocket progress updates, authorization, rate limiting, and vector search orchestration for the Via Carraria system.

---

## Technical Stack & Dependencies

- **Runtime & Framework**: Node.js, NestJS, TypeScript
- **Database & ORM**: PostgreSQL, Prisma ORM
- **Cache & Rate Limiting**: Redis, `ioredis`, `@upstash/ratelimit`
- **Message Broker**: RabbitMQ (`amqplib`)
- **Vector Database Client**: Weaviate TypeScript SDK v3 (`weaviate-client` via gRPC 50051 / REST 8080)
- **Authorization**: CASL (`@casl/ability`)
- **Payment & Billing**: LemonSqueezy / Stripe SDKs

---

## Submodule Architecture & Environment Management

- **Environment Definition (`environment.yml`)**: Mamba environment `viacarraria-backend` containing minimal platform tools ONLY (`nodejs`, `pnpm`).
- **Dependency Installation**: `mamba run -n viacarraria-backend pnpm install`
- **Submodule Directory Standard**:
   - `platforms/docker/`: Dockerfile definitions for container wrapping and platform serving.
   - Docker Compose and Helm descriptors are owned exclusively by `viacarraria-infrastructure`.

---

## Core Modules & API Architecture

```
src/
├── modules/
│   ├── auth/           # Better Auth credentials, OAuth, anonymous sessions, and identity mapping
│   ├── graphs/         # Graph CRUD, JSONB canvas management & auto-save
│   ├── sources/        # File upload & ingestion pipeline dispatch
│   ├── search/         # Spatial GraphRAG hybrid vector search engine
│   ├── billing/        # Webhooks & subscription tier synchronization
│   └── admin/          # Directus integration & system config
├── common/
│   ├── guards/         # Roles Guard, Rate Limit Guard, CASL Ability Guard
│   ├── middleware/     # Anonymous Session & IP Abuse middleware
│   └── services/       # Weaviate Client, RabbitMQ Producer, Redis Service
└── main.ts
```

### Key API Endpoints Specification

1. **Authentication & Guest Sessions (`/api/auth`)**:
   - Better Auth handles `/api/auth/*`, including `get-session`, email signup/sign-in, Google OAuth, sign-out, anonymous sessions, password changes, and session revocation.
   - **IP Abuse Prevention**: Enforces a strict limit of max 10 anonymous sessions per IP address or subnet within 1 hour.
   - Better Auth's anonymous account-link callback migrates guest query history when a guest signs up with credentials or OAuth.

2. **Graph Management (`/api/graphs`)**:
   - `GET /api/graphs`: Lists user-accessible graphs (public pre-baked templates owned by system user `"jbed94"` + user-owned graphs).
   - `GET /api/graphs/:id`: Fetches JSONB canvas representation (`nodes`, `edges`) plus the caller's permission, edit capability, and privacy-preserving known access count.
   - `POST /api/graphs`: Creates a new canvas graph (restricted to paid `PRO` subscriptions).
   - `PUT /api/graphs/:id`: Auto-save endpoint for canvas updates (Debounce Auto-Save pattern). Updates `nodes` and `edges` JSONB columns.
   - `POST /api/graphs/:id/finalize`: Triggers preparation/ingestion check for newly saved graph sources.
   - `POST /api/graphs/:id/copy`: Copies an accessible graph and its sources into a private graph owned by the caller, subject to the caller's graph quota.

3. **Source Upload & Management (`/api/sources`)**:
   - `POST /api/sources/upload`: Multipart upload for PDF, MD, or TXT files. Upload starts immediately upon selection in the builder UI.
   - Saves file to storage, calculates SHA-256 hash in Redis key `hash:<sha256>` to skip duplicate ingestion, and publishes job payload to RabbitMQ `document_parsing_queue`.
   - Payload includes: `filePath`, `nodeId`, `graphId`, `jobId`, `priority` (10 for PRO, 1 for FREE).

4. **Spatial GraphRAG Engine (`/api/search`)**:
   - `POST /api/search`: Accepts `{ graphId, query, selectedNodeIds, extendedSearch }`.
   - Obtains query vector via HuggingFace TEI service or lightweight embedding model.
   - Executes Weaviate Hybrid Search (`alpha: 0.7` for 70% dense vector + 30% BM25 keyword weighting) with pre-filtering:
     ```typescript
     const results = await chunksCollection.query.hybrid(query, {
       limit: 5,
       alpha: 0.7,
       filters: Filters.and(
         chunksCollection.filter.byProperty('nodeId').containsAny(selectedNodeIds)
       ),
       returnProperties: ['content', 'sourceName', 'nodeId', 'chunkIndex', 'startChar', 'endChar']
     });
     ```
   - Resolves hit hierarchy (`Source` $\to$ `SpanChunk` $\to$ `Chunk`). Maps matched Child Chunks (~200-300 tokens) to their Parent Context `SpanChunk` (~1000 tokens) and returns text coordinates (`startChar`, `endChar`) to the frontend for precise yellow/orange document highlighting.
   - **Extended Search**: Registered users can opt in to retrieve one-hop adjacent-node context using the stored vectors of direct matching chunks. Free users receive up to 3 extended chunks per query; Pro users receive up to 15. Vectors never leave the backend, and anonymous users are rejected.

5. **Billing & Entitlements (`/api/billing`)**:
   - `POST /api/billing/checkout`: Generates LemonSqueezy / Stripe checkout URL for PRO plan.
   - `POST /api/billing/webhook`: Handles `customer.subscription.created`, `invoice.payment_succeeded`, and `customer.subscription.deleted` to update `subscriptionTier` in PostgreSQL.

---

## Authorization & Usage Quota System

### CASL Ability Rules (`defineAbilityFor(user)`)
- **Anonymous**: `can('query', 'DemoGraph')`, max 2 selected nodes. Cannot create custom graphs or upload sources.
- **Free User**: `can('query', 'AllGraphs')` up to 10 selected nodes. `can('create', 'Graph')` up to 3 custom graphs (max 10 nodes, 3 sources/node, 2MB each). Cannot upload custom PDFs.
- **Pro User**: `can('query', 'AllGraphs')` unlimited selected nodes. `can('create', 'Graph')` unlimited. `can('upload', 'CustomSource')`. High RabbitMQ queue priority.
- **System Owner `"jbed94"`**: Exclusive write/edit ability for pre-baked public system graph templates.

### Rate Limiting Middleware (`aiQuotaMiddleware`)
- Tracks daily usage in Redis key: `usage:<identifier>:<YYYY-MM-DD>` with 24h TTL.
- Daily Limits: Anonymous = 3 queries, Free = 20 queries, Pro = 1000 queries.
- Sends response headers: `X-RateLimit-Remaining`. Returns `429 Too Many Requests` when quota is exhausted.

---

## Service Testing & Build Commands

- **Unit Tests**: `pnpm --filter api test`
- **Watch Mode**: `pnpm --filter api test:watch`
- **Integration Tests**: `pnpm --filter api test:e2e`
- **Linting**: `pnpm --filter api lint`
