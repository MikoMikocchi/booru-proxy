# Danbooru Gateway

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![Node.js](https://img.shields.io/badge/Node.js-v24-green.svg)](https://nodejs.org/) [![Docker](https://img.shields.io/badge/Docker-Supported-blue.svg)](https://www.docker.com/) [![Redis](https://img.shields.io/badge/Redis-v7+-orange.svg)](https://redis.io/)

[![NestJS](https://img.shields.io/badge/NestJS-v11.0.1-red.svg)](https://nestjs.com/) [![TypeScript](https://img.shields.io/badge/TypeScript-v5.7.3-blue.svg)](https://www.typescriptlang.org/) [![BullMQ](https://img.shields.io/badge/BullMQ-v5.58.5-purple.svg)](https://bullmq.io/)

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

## Architecture Overview

The application is a pure NestJS microservice (no HTTP controllers) bootstrapped in [`src/main.ts`](src/main.ts) with Redis transport (ioredis client, TLS optional), global validation pipes, and graceful shutdown (Redis cleanup).

### Core Modules
- **AppModule** ([`src/app.module.ts`](src/app.module.ts)): Root; imports ConfigModule (global env), SharedModule (utilities), DanbooruModule (business logic).
- **SharedModule** ([`src/common/shared.module.ts`](src/common/shared.module.ts)): Exports globals:
  - **CacheModule** ([`src/common/cache/cache.module.ts`](src/common/cache/cache.module.ts)): Backend switcher (Redis/Memcached), CacheService for get/set/invalidate.
  - **QueuesModule** ([`src/common/queues/queues.module.ts`](src/common/queues/queues.module.ts)): BullMQ setup for streams; consumers for main processing (RedisStreamConsumer) and DLQ (DlqConsumer).
  - **RateLimitModule** ([`src/common/rate-limit/rate-limit.module.ts`](src/common/rate-limit/rate-limit.module.ts)): RateLimiterService (Lua scripts), ApiThrottlerGuard.
  - **RedisModule** ([`src/common/redis/redis.module.ts`](src/common/redis/redis.module.ts)): ioredis client (retry/reconnect), LockUtil for distributed locks.
  - **ValidationModule** ([`src/common/validation/validation.module.ts`](src/common/validation/validation.module.ts)): ValidationService for DTOs.
- **DanbooruModule** ([`src/danbooru/danbooru.module.ts`](src/danbooru/danbooru.module.ts)): Core; imports above, provides DanbooruService (orchestrator: lock/cache/rate/API/publish), DanbooruApiService (axios client), ValidationService.

### Key Services & Flow
1. Producer: XADD to `danbooru:requests` with jobId, query, apiKey (HMAC), clientId.
2. RedisStreamConsumer: Validates DTO, dedups, acquires lock → Delegates to DanbooruService.
3. DanbooruService: Rate check → Cache getOrSet (deterministic seed for random) → API call (via DanbooruApiService, extends BaseApiService) → Publish success/error to `danbooru:responses`, cache/invalidate, add to DLQ if failed.
4. DlqConsumer: Polls `danbooru:dlq` (encrypted), retries (up to 5) or moves to `danbooru-dead`.

Utilities: Constants ([`src/common/constants.ts`](src/common/constants.ts)) for streams/TTLs; CryptoUtil for encryption; DLQ utils for add/retry.

## Prerequisites

- Node.js v24+
- npm v10+
- Redis v7+ (for streams; Docker image provided)
- Docker & Docker Compose (recommended for Redis/TLS setup)
- Danbooru account (for login/API key; see [Danbooru API docs](https://danbooru.donmai.us/wiki_pages/api))

Optional: Memcached server for caching backend.

## Setup Instructions

1. Clone the repo:
   ```
   git clone <repo-url> danbooru-gateway
   cd danbooru-gateway
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Configure environment: Copy [`.env.example`](.env.example) to `.env` and edit:
   ```
   DANBOORU_LOGIN=your_danbooru_username
   DANBOORU_API_KEY=your_danbooru_api_key
   REDIS_URL=redis://localhost:6379  # Dev; use rediss:// for TLS prod
   REDIS_PASSWORD=your_redis_password  # For Docker
   REDIS_USE_TLS=false  # true for prod
   REDIS_TLS_CA=/path/to/ca.pem  # Optional PEM paths for TLS
   REDIS_TLS_CERT=/path/to/cert.pem
   REDIS_TLS_KEY=/path/to/key.pem
   API_SECRET=your_shared_hmac_secret  # For apiKey validation
   ENCRYPTION_KEY=your_64_hex_aes_key  # Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   RATE_LIMIT_PER_MINUTE=60
   CACHE_TTL_SECONDS=3600
   CACHE_BACKEND=redis  # or memcached
   DANBOORU_LIMIT=1  # Default query limit
   DANBOORU_RANDOM=true  # Enable random selection
   LOG_LEVEL=info
   ```

4. **Docker Setup (Recommended)**: Starts Redis 8.2-alpine with TLS (port 6380), append-only mode, and password from `./secrets/redis_password.txt` (create if needed).
   ```
   mkdir -p secrets && echo "your_redis_password" > secrets/redis_password.txt
   docker-compose up --build  # Or -d for detached
   ```
   Mount TLS certs if using prod Redis. Healthchecks ensure readiness.

5. **Local Development** (without Docker):
   - Start Redis: `./scripts/redis-start.sh` or `docker run -d -p 6379:6379 --name redis -e REDIS_PASSWORD=pass redis:alpine`
   - Run service: `npm run start:dev` (watches TS changes)
   - Debug: `npm run start:debug`
   - Production build: `npm run build && npm run start:prod`

Lint: `npm run lint`, Format: `npm run format`.

## Usage

Interact via Redis streams (no HTTP endpoints). Use a Redis client like ioredis.

### Submitting Requests

Add to input stream (`danbooru:requests`):
```javascript
const Redis = require('ioredis');
const crypto = require('crypto');
const redis = new Redis(process.env.REDIS_URL);

const jobId = crypto.randomUUID();
const query = 'cat_ears rating:safe';  // Danbooru tags
const secret = process.env.API_SECRET;
const apiKey = crypto.createHmac('sha256', secret).update(jobId + query).digest('hex');
const clientId = 'optional-client-id';  // Alphanumeric, max 50 chars

await redis.xadd('danbooru:requests', '*', {
  jobId,
  query,
  apiKey,
  clientId
});
```

- **Validation**: Query (≤100 chars: alphanumeric, spaces, -, :, (), _); apiKey HMAC match; jobId UUID.
- Limit/random: Fixed via env (default 1/true); query supports directives like `rating:s`.

### Reading Responses

Consume from output stream (`danbooru:responses`):
```javascript
const stream = await redis.xread('BLOCK', 0, 'STREAMS', 'danbooru:responses', '0');

for (const [streamName, messages] of stream) {
  for (const [id, fields] of messages) {
    const response = JSON.parse(fields.data || '{}');  // Fields as key-value
    console.log(response);
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
  "author": "artist_name",  // Or null
  "tags": "cat_ears solo rating:s",  // tag_string_general
  "rating": "s",  // 's', 'q', 'e'
  "source": "https://...",  // Or null
  "copyright": "character_name",  // Or null
  "timestamp": "2025-09-12T19:49:20Z"
}
```

**Error Response** (DanbooruErrorResponse):
```json
{
  "type": "error",
  "jobId": "uuid-v4",
  "error": "No posts found",  // Or "Rate limit exceeded", etc.
  "timestamp": "2025-09-12T19:49:20Z"
}
```

### Monitoring DLQ/Dead Queue
- DLQ (`danbooru:dlq`): Encrypted entries with query hash, error, retryCount.
- Dead (`danbooru-dead`): Permanent failures.
```javascript
await redis.xread('BLOCK', 5000, 'STREAMS', 'danbooru:dlq', '0');  // Poll every 5s
```

Scale: Run multiple instances for higher throughput; locks ensure consistency.

## API Details

### Request DTO (CreateRequestDto)
```typescript
import { IsUUID, IsString, IsOptional, MaxLength, Matches } from 'class-validator';

export class CreateRequestDto {
  @IsUUID()
  jobId: string;

  @IsString()
  @MaxLength(100)
  @Matches(/^[a-zA-Z0-9\s\-_:()]+$/)  // Safe chars
  query: string;

  @IsString()
  apiKey: string;  // HMAC validated separately

  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Matches(/^[a-zA-Z0-9\-_]+$/)
  clientId?: string;
}
```

### Response DTO (DanbooruPost)
Maps Danbooru fields: id, file_url (validated URL), large_file_url, tags (lowercase/trimmed/safe), rating (enum), score, created_at (Date), tag_string_artist/general/copyright, source (sanitized).

Query Examples:
- Safe cats: `query: "cat_ears rating:s"`
- Random explicit: `query: "1girl rating:e"` (with DANBOORU_RANDOM=true)
- Artist: `query: "artist:drawr"`

See [`src/danbooru/interfaces/danbooru.interface.ts`](src/danbooru/interfaces/danbooru.interface.ts) for full types.

## Testing

- **Unit Tests**: Jest for services/consumers (mocks: ioredis-mock, nock for HTTP).
  ```
  npm run test  # Or npm run test:watch
  npm run test:cov  # Coverage
  ```
  Specs: danbooru.service.spec.ts (processing), cache.service.spec.ts, dlq.consumer.spec.ts, etc.

- **E2E Tests**: Supertest + testcontainers (Docker Redis isolation).
  ```
  npm run test:e2e  # Uses test/jest-e2e.json; simulates streams
  ```
  Boilerplate in [`test/app.e2e-spec.ts`](test/app.e2e-spec.ts); extend for full flows.

Debug: `npm run test:debug`.

## Dependencies

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

## Contributing

1. Fork the repo.
2. Create feature branch: `git checkout -b feature/new-feature`.
3. Commit: `git commit -m "Add new feature"`.
4. Push: `git push origin feature/new-feature`.
5. Open PR.

Run `npm run lint` and `npm run test` before submitting. Follow NestJS style; add tests/docs for changes. Issues/PRs welcome!

## License

MIT License - see [`LICENSE`](LICENSE) for details.

## Contact

Open a GitHub issue for support. Maintainer: [your-contact].
