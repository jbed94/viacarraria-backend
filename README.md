# Via Carraria Backend

NestJS API for authentication, graph management, source ingestion dispatch,
Spatial GraphRAG search, billing, and real-time ingestion progress.

## Development

```bash
mamba run -n viacarraria-backend pnpm install
mamba run -n viacarraria-backend pnpm dev
```

The API uses Better Auth as its single authentication authority for email and
password accounts, Google OAuth, anonymous sessions, cookies, account linking,
and session lifecycle. It also implements tier quotas, public/custom graph CRUD,
canvas DAG validation, source uploads and worker progress, hybrid GraphRAG
search, query history, and local-first billing. Shared integrations live under
`src/common`; endpoint modules live under `src/modules`.

Authorization decisions are centralized in CASL (`src/common/authorization`).
Transport limits use Upstash Ratelimit with a 120 requests/minute general limit,
a 30 requests/minute search limit, and a 10 anonymous-session-per-hour limit
when `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are configured.
Local Compose uses the equivalent ioredis fixed-window fallback; daily plan
quotas and anonymous IP abuse limits remain Redis-backed business rules.

Copy `.env.example` to `.env` for local development. Cross-service orchestration
is maintained in the infrastructure repository.
