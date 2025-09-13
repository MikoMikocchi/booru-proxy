# Booru-proxy

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![Node.js](https://img.shields.io/badge/Node.js-v24-green.svg)](https://nodejs.org/) [![Docker](https://img.shields.io/badge/Docker-Supported-blue.svg)](https://www.docker.com/) [![Redis](https://img.shields.io/badge/Redis-v7+-orange.svg)](https://redis.io/)

[![NestJS](https://img.shields.io/badge/NestJS-v11.0.1-red.svg)](https://nestjs.com/) [![TypeScript](https://img.shields.io/badge/TypeScript-v5.7.3-blue.svg)](https://www.typescriptlang.org/) [![BullMQ](https://img.shields.io/badge/BullMQ-v5.58.5-purple.svg)](https://bullmq.io/)

## Project Description

A robust NestJS microservice acting as a proxy and worker for the Danbooru imageboard API. It processes asynchronous image search requests (e.g., tag-based queries for anime-style artwork) via Redis streams, fetches posts using authenticated API calls, and publishes structured responses (including image URLs, tags, ratings, and metadata) to output streams. Key emphases include reliability through caching, rate limiting, distributed locking, deduplication, and error handling with a Dead Letter Queue (DLQ). Sensitive data in the DLQ is encrypted for privacy, and "random" results use deterministic seeding for cache consistency. This service is ideal for high-throughput, fault-tolerant image retrieval in applications like galleries or AI image generators, while respecting Danbooru's rate limits and content policies (handling SFW/NSFW via ratings: 's' safe, 'q' questionable, 'e' explicit).

## Features

- **Asynchronous Queued Processing**: Uses Redis streams and BullMQ for scalable, decoupled request handling with automatic retries and concurrency control (default 5 workers).
- **API Proxying**: Authenticated requests to Danbooru `/posts.json` with retry logic (3 attempts, exponential backoff + jitter, respects 429 headers), XSS sanitization (via `xss` library), and response validation.
- **Pluggable Caching**: Unified API for Redis (ioredis) or Memcached (memjs) backends; deterministic keys (MD5 query hash + seed) with TTL (default 3600s) and proactive invalidation for tags/random patterns.
- **Rate Limiting**: Custom Redis-based Lua scripts for atomic counters (per minute/hour/day, composite keys like IP+clientId) plus NestJS ThrottlerGuard (default 60/min).
- **Distributed Locking & Deduplication**: Redis locks (SHA256 query hash, 30s TTL with heartbeats) to prevent duplicate processing; dedup checks via DLQ scans (1h window) and processed keys (24h TTL).
- **Error Handling & DLQ**: Publishes errors to responses; adds failures to encrypted DLQ (AES-256-GCM) with up to 5 retries for transient issues (e.g., no posts, rate limits); permanent failures to dead queue.
- **Input Validation**: Class-validator for requests (UUID jobId, safe-char query ≤100, HMAC apiKey via shared secret) and responses (DanbooruPost DTO with URL checks, enum ratings).
- **Security & Utilities**: HMAC authentication, crypto for DLQ privacy, TLS support for Redis (production-ready with PEM certs), logging with jobId context.
- **Extensibility**: Modular design for multi-API support (e.g., prefixes for Gelbooru); Dockerized for easy deployment.

## Installation

### Prerequisites

- Node.js v24+
- npm v10+
- Redis v7+ (for streams; Docker image provided)
- Docker & Docker Compose (recommended for Redis/TLS setup)
- Danbooru account (for login/API key; see [Danbooru API docs](https://danbooru.donmai.us/wiki_pages/api))

Optional: Memcached server for caching backend.

### Dependencies

**Production**:
- NestJS: @nestjs/core@11.0.1, @nestjs/microservices@11.1.6, @nestjs/cache-manager@3.0.1, @nestjs/throttler@6.4.0, @nestjs/bullmq@11.0.3
- Redis: ioredis@5.7.0, bullmq@5.58.5
- HTTP: axios@1.11.0, axios-retry@4.5.0
- Utils: class-validator@0.14.2, xss@1.0.15, uuid@13.0.0, memjs@1.3.2 (Memcached)
- Types: @types/node@22.10.7

**Development**:
- Jest@30.0.0, ts-jest@29.2.5, supertest@7.0.0, nock@14.0.10, testcontainers@11.5.1
- Build: typescript@5.7.3, eslint@9.18.0, prettier@3.4.2

See [`package.json`](package.json) for full list/scripts.

### Quick Setup

1. Clone the repo:

   ```
   git clone https://github.com/MikoMikocchi/booru-proxy.git
   cd booru-proxy
   ```

2. Run automated setup:

   - For development (non-TLS Redis): `npm run setup:dev`
   - For production (TLS Redis): `npm run setup:prod`

   This single command handles:
   - Installing dependencies (`npm install`)
   - Prompting for Danbooru credentials (login/API key) if not already set in environment variables
   - Generating secure secrets: Redis password (32 hex), API secret (64 hex), encryption key (64 hex for AES-256)
   - Creating `./secrets/redis_password.txt` and storing secrets securely
   - Copying and templating `.env` from `.env.example` with placeholders replaced (e.g., `${REDIS_PASSWORD}` → actual value)
   - Setting mode-specific defaults: `REDIS_USE_TLS=false` (dev) / `true` (prod); `REDIS_URL=redis://...` (dev) / `rediss://...` (prod)
   - Generating self-signed TLS certificates in `./certs/redis/` (prod only) using OpenSSL (4096-bit, 365 days)
   - Starting Redis:
     - Dev: Non-TLS Docker container on port 6379 with password
     - Prod: TLS-enabled via `docker-compose up -d --build redis` on port 6380
   - Launching the worker:
     - Dev: `npm run start:dev` (watches for changes)
     - Prod: `docker-compose up -d --build danbooru-worker`
   - Verification: Redis PING, unit tests (`npm test`), E2E tests (`npm run test:e2e`), and queue test command example

3. **Cross-Platform Notes**:
   - macOS/Linux: Native Bash support.
   - Windows: Use WSL (Windows Subsystem for Linux) or Git Bash; ensure Docker Desktop is running. OpenSSL must be available (install via `apt install openssl` in WSL).
   - No external dependencies beyond Node.js, npm, Docker, and OpenSSL/envsubst (GNU gettext; install if needed: `brew install gettext` on macOS).

### Troubleshooting

- **Docker Issues**: Ensure Docker Desktop is running (`docker ps`). If "no space left", prune: `docker system prune -f`.
- **OpenSSL Not Found**: Install OpenSSL (macOS: `brew install openssl`; Linux: `apt install openssl`).
- **envsubst Missing** (for .env templating): Install GNU gettext (`brew install gettext` on macOS; add to PATH if needed).
- **Danbooru Credentials Invalid**: Re-run `npm run setup:dev` and enter valid login/API key from [Danbooru](https://danbooru.donmai.us/wiki_pages/api).
- **Redis Connection Fails**: Check `REDIS_URL` in `.env`; verify password in `./secrets/redis_password.txt`. For TLS, ensure cert paths match.
- **Worker Crashes**: View logs: Dev (console); Prod (`docker-compose logs danbooru-worker`). Common: Missing env vars or Redis down.
- **Tests Fail**: Ensure Redis is running before tests. Use `npm run test:debug` for breakpoints.
- **Windows Compatibility**: Prefer WSL; avoid native CMD (use `wsl.exe` for scripts). If cert gen fails, run OpenSSL manually.
- **Permissions**: Ensure `./scripts/*.sh` are executable: `chmod +x scripts/*.sh`.

If issues persist, check Docker logs and share error output.

### Stop and Cleanup

- **Development**:
  ```
  # Stop worker (Ctrl+C in terminal)
  docker stop redis-dev && docker rm redis-dev
  # Optional: docker rmi redis:alpine
  ```

- **Production**:
  ```
  docker-compose down  # Stops and removes containers
  docker-compose down -v  # Also removes volumes (data loss)
  ```

- **Full Cleanup** (dev/prod):
  ```
  rm -rf secrets/ certs/ .env  # Regenerate on next setup
  docker volume prune -f  # Remove unused volumes
  ```

## Usage

Interact via Redis streams. Use a Redis client like ioredis.

### Submitting Requests

Add to input stream (`danbooru:requests`):

```javascript
const Redis = require('ioredis')
const crypto = require('crypto')
const redis = new Redis(process.env.REDIS_URL)

const jobId = crypto.randomUUID()
const query = 'cat_ears rating:safe' // Danbooru tags
const secret = process.env.API_SECRET
const apiKey = crypto
  .createHmac('sha256', secret)
  .update(jobId + query)
  .digest('hex')
const clientId = 'optional-client-id' // Alphanumeric, max 50 chars

await redis.xadd('danbooru:requests', '*', {
  jobId,
  query,
  apiKey,
  clientId,
})
```

- **Validation**: Query (≤100 chars: alphanumeric, spaces, -, :, (), \_); apiKey HMAC match; jobId UUID.
- Limit/random: Fixed via env (default 1/true); query supports directives like `rating:s`.

### Reading Responses

Consume from output stream (`danbooru:responses`):

```javascript
const stream = await redis.xread(
  'BLOCK',
  0,
  'STREAMS',
  'danbooru:responses',
  '0',
)

for (const [streamName, messages] of stream) {
  for (const [id, fields] of messages) {
    const response = JSON.parse(fields.data || '{}') // Fields as key-value
    console.log(response)
    // Ack: await redis.xack('danbooru:responses', 'group', id);  // If using groups
  }
}
```

**Success Response** (DanbooruSuccessResponse):

```json
{
  "type": "success",
  "jobId": "uuid-v4",
  "imageUrl": "https://danbooru.donmai.us/data/...",
  "author": "artist_name", // Or null
  "tags": "cat_ears solo rating:s", // tag_string_general
  "rating": "s", // 's', 'q', 'e'
  "source": "https://...", // Or null
  "copyright": "character_name", // Or null
  "timestamp": "2025-09-12T19:49:20Z"
}
```

**Error Response** (DanbooruErrorResponse):

```json
{
  "type": "error",
  "jobId": "uuid-v4",
  "error": "No posts found", // Or "Rate limit exceeded", etc.
  "timestamp": "2025-09-12T19:49:20Z"
}
```

### Monitoring DLQ/Dead Queue

- DLQ (`danbooru:dlq`): Encrypted entries with query hash, error, retryCount.
- Dead (`danbooru-dead`): Permanent failures.

```javascript
await redis.xread('BLOCK', 5000, 'STREAMS', 'danbooru:dlq', '0') // Poll every 5s
```

Scale: Run multiple instances for higher throughput; locks ensure consistency.

### API Details

#### Request DTO (CreateRequestDto)

See [`src/danbooru/dto/create-request.dto.ts`](src/danbooru/dto/create-request.dto.ts):

```typescript
import {
  IsUUID,
  IsString,
  IsOptional,
  MaxLength,
  Matches,
} from 'class-validator'

export class CreateRequestDto {
  @IsUUID()
  jobId: string

  @IsString()
  @MaxLength(100)
  @Matches(/^[a-zA-Z0-9\s\-_:()]+$/) // Safe chars
  query: string

  @IsString()
  apiKey: string // HMAC validated separately

  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Matches(/^[a-zA-Z0-9\-_]+$/)
  clientId?: string
}
```

#### Response DTO (DanbooruPost)

Maps Danbooru fields: id, file_url (validated URL), large_file_url, tags (lowercase/trimmed/safe), rating (enum), score, created_at (Date), tag_string_artist/general/copyright, source (sanitized).

See [`src/danbooru/dto/danbooru-post.class.ts`](src/danbooru/dto/danbooru-post.class.ts) and [`src/danbooru/interfaces/danbooru.interface.ts`](src/danbooru/interfaces/danbooru.interface.ts) for full types.

Query Examples:
- Safe cats: `query: "cat_ears rating:s"`
- Random explicit: `query: "1girl rating:e"` (with DANBOORU_RANDOM=true)
- Artist: `query: "artist:drawr"`

## Architecture/Modules

The application is a pure NestJS microservice (no HTTP controllers) bootstrapped in [`src/main.ts`](src/main.ts) with Redis transport (ioredis client, TLS optional), global validation pipes, and graceful shutdown (Redis cleanup).

### Core Modules

- **AppModule** ([`src/app.module.ts`](src/app.module.ts)): Root; imports ConfigModule (global env), SharedModule (utilities), DanbooruModule (business logic).
- **SharedModule** ([`src/common/shared.module.ts`](src/common/shared.module.ts)): Exports globals:
  - **CacheModule** ([`src/common/cache/cache.module.ts`](src/common/cache/cache.module.ts)): Backend switcher with [`src/common/cache/cache.service.ts`](src/common/cache/cache.service.ts) for get/set/invalidate. Backends: [`src/common/cache/backends/redis-backend.service.ts`](src/common/cache/backends/redis-backend.service.ts) (ioredis) and [`src/common/cache/backends/memcached-backend.service.ts`](src/common/cache/backends/memcached-backend.service.ts) (memjs). Interfaces: [`src/common/cache/interfaces/icache-backend.interface.ts`](src/common/cache/interfaces/icache-backend.interface.ts).
  - **QueuesModule** ([`src/common/queues/queues.module.ts`](src/common/queues/queues.module.ts)): BullMQ setup for streams; consumers: [`src/common/queues/redis-stream.consumer.ts`](src/common/queues/redis-stream.consumer.ts) for main processing and [`src/common/queues/dlq.consumer.ts`](src/common/queues/dlq.consumer.ts) for DLQ. Interfaces: [`src/common/queues/interfaces/iqueue-provider.interface.ts`](src/common/queues/interfaces/iqueue-provider.interface.ts). Utils: [`src/common/queues/utils/dlq.util.ts`](src/common/queues/utils/dlq.util.ts).
  - **RateLimitModule** ([`src/common/rate-limit/rate-limit.module.ts`](src/common/rate-limit/rate-limit.module.ts)): [`src/common/rate-limit/rate-limiter.service.ts`](src/common/rate-limit/rate-limiter.service.ts) (Lua scripts), [`src/common/rate-limit/rate-limit-manager.service.ts`](src/common/rate-limit/rate-limit-manager.service.ts), and [`src/common/rate-limit/throttler.guard.ts`](src/common/rate-limit/throttler.guard.ts) (NestJS guard).
  - **RedisModule** ([`src/common/redis/redis.module.ts`](src/common/redis/redis.module.ts)): ioredis client (retry/reconnect). Utils: [`src/common/redis/utils/lock.util.ts`](src/common/redis/utils/lock.util.ts) for distributed locks, [`src/common/redis/utils/redis.util.ts`](src/common/redis/utils/redis.util.ts).
  - **ValidationModule** ([`src/common/validation/validation.module.ts`](src/common/validation/validation.module.ts)): [`src/common/validation/validation.service.ts`](src/common/validation/validation.service.ts) for DTOs.
  - **Crypto** ([`src/common/crypto/crypto.util.ts`](src/common/crypto/crypto.util.ts)): Utilities for encryption (AES-256-GCM for DLQ).
  - Constants: [`src/common/constants.ts`](src/common/constants.ts) for streams/TTLs/keys.
- **DanbooruModule** ([`src/danbooru/danbooru.module.ts`](src/danbooru/danbooru.module.ts)): Core; imports above, provides [`src/danbooru/danbooru.service.ts`](src/danbooru/danbooru.service.ts) (orchestrator: lock/cache/rate/API/publish), [`src/danbooru/danbooru-api.service.ts`](src/danbooru/danbooru-api.service.ts) (axios client, extends [`src/common/api/base-api.service.ts`](src/common/api/base-api.service.ts)), [`src/danbooru/validation.service.ts`](src/danbooru/validation.service.ts) (Danbooru-specific). DTOs: [`src/danbooru/dto/create-request.dto.ts`](src/danbooru/dto/create-request.dto.ts), [`src/danbooru/dto/danbooru-post.class.ts`](src/danbooru/dto/danbooru-post.class.ts). Interfaces: [`src/danbooru/interfaces/danbooru.interface.ts`](src/danbooru/interfaces/danbooru.interface.ts).

### Key Services & Flow

1. Producer: XADD to `danbooru:requests` with jobId, query, apiKey (HMAC), clientId.
2. RedisStreamConsumer: Validates DTO, dedups, acquires lock → Delegates to DanbooruService.
3. DanbooruService: Rate check → Cache getOrSet (deterministic seed for random) → API call (via DanbooruApiService) → Publish success/error to `danbooru:responses`, cache/invalidate, add to DLQ if failed.
4. DlqConsumer: Polls `danbooru:dlq` (encrypted), retries (up to 5) or moves to `danbooru-dead`.

## Scripts

The project includes utility scripts in the `scripts/` directory for setup and management:

- **`scripts/setup.sh`**: Main setup script invoked by `npm run setup:dev` or `npm run setup:prod`. Handles dependency installation, credential prompting, .env templating, secret generation (calls generate-secrets.js), certificate generation (prod only, calls generate-certs.sh), Redis startup (calls redis-start.sh), and worker launch. Supports dev/prod modes with TLS toggles.
- **`scripts/generate-secrets.js`**: Node.js script to generate secure random values: Redis password (32 hex chars), API secret (64 hex), encryption key (64 hex). Outputs to `./secrets/` and updates .env.
- **`scripts/generate-certs.sh`**: Bash script using OpenSSL to create self-signed TLS certificates for Redis (CA, server, client certs/keys) in `./certs/redis/`. Generates 4096-bit keys valid for 365 days; requires OpenSSL.
- **`scripts/redis-start.sh`**: Starts Redis Docker container. For dev: non-TLS on port 6379 with password. For prod: TLS-enabled via custom Dockerfile, on port 6380.

Make scripts executable: `chmod +x scripts/*.sh`. These are cross-platform with WSL support on Windows.

## Docker

The project is fully Dockerized for easy deployment and testing:

- **`Dockerfile`**: Builds the NestJS worker image (Node 24-alpine base, copies src/, installs deps, runs `npm run start:prod`). Multi-stage for build/prod optimization.
- **`docker-compose.yml`**: Orchestrates services:
  - `redis`: TLS-enabled Redis (custom config for streams, password auth, port 6380). Uses volume for persistence.
  - `danbooru-worker`: The microservice container (builds from Dockerfile, env from .env, depends on redis). Runs multiple instances via scale if needed.
  - Volumes: For Redis data and certs/secrets mounting.

Usage:
- Build and run: `docker-compose up -d --build`
- Logs: `docker-compose logs -f danbooru-worker`
- Scale workers: `docker-compose up -d --scale danbooru-worker=3`
- For dev: Use `npm run start:dev` outside Docker; for prod/testing, prefer compose.

See `.dockerignore` for optimized builds (excludes node_modules, coverage, etc.). Supports TLS cert mounting from `./certs/`.

## Testing

### Unit Tests

Jest for services/consumers (mocks: ioredis-mock, nock for HTTP).

```
npm run test  # Or npm run test:watch
npm run test:cov  # Coverage
```

Specs: [`src/danbooru/danbooru.service.spec.ts`](src/danbooru/danbooru.service.spec.ts) (processing), [`src/common/cache/cache.service.spec.ts`](src/common/cache/cache.service.spec.ts), [`src/common/queues/dlq.consumer.spec.ts`](src/common/queues/dlq.consumer.spec.ts), [`src/common/rate-limit/rate-limiter.service.spec.ts`](src/common/rate-limit/rate-limiter.service.spec.ts), [`src/common/rate-limit/throttler.guard.spec.ts`](src/common/rate-limit/throttler.guard.spec.ts), [`src/common/validation/validation.service.spec.ts`](src/common/validation/validation.service.spec.ts), etc.

### E2E Tests

Supertest + testcontainers (Docker Redis isolation).

```
npm run test:e2e  # Uses test/jest-e2e.json; simulates streams
```

Boilerplate in [`test/app.e2e-spec.ts`](test/app.e2e-spec.ts); extend for full flows. Config: [`test/jest-e2e.json`](test/jest-e2e.json).

Debug: `npm run test:debug`. Ensure 100% pass; coverage in `./coverage/`.

### Verification

After setup, verify:

1. **Redis Health Check**:
   - Dev: `docker exec redis-dev redis-cli -a $REDIS_PASSWORD PING` (expect "PONG")
   - Prod: `docker-compose exec redis redis-cli -a $REDIS_PASSWORD --tls --cacert ./certs/redis/ca.crt --cert ./certs/redis/redis-client.crt --key ./certs/redis/redis-client.key -p 6380 PING`

   If fails, check logs: `docker logs redis-dev` (dev) or `docker-compose logs redis` (prod).

2. **Queue Example** (Test end-to-end flow):
   - Submit: `redis-cli -a $REDIS_PASSWORD XADD danbooru:requests '*' jobId $(uuidgen) query 'cat_ears rating:s' apiKey 'your_hmac' clientId 'test'`
   - Read: `redis-cli -a $REDIS_PASSWORD XREAD BLOCK 5000 STREAMS danbooru:responses 0`

   (Adjust for TLS in prod; generate real apiKey via HMAC.)

## Contributing

1. Fork the repo.
2. Create feature branch: `git checkout -b feature/new-feature`.
3. Commit: `git commit -m "Add new feature"`.
4. Push: `git push origin feature/new-feature`.
5. Open PR.

Run `npm run lint` and `npm run test` before submitting. Follow NestJS style; add tests/docs for changes. Issues/PRs welcome! See `.github/` for workflows.

## License

MIT License - see [`LICENSE`](LICENSE) for details.
