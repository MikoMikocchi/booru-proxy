# Booru-proxy

<div align="center">
  <img src="https://github.com/user-attachments/assets/961d2115-728b-4044-a2d0-a962471212de" alt="Booru-proxy Logo" width="300" />
</div>

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-v24-green.svg)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Supported-blue.svg)](https://www.docker.com/)
[![Redis](https://img.shields.io/badge/Redis-v7+-orange.svg)](https://redis.io/)

[![NestJS](https://img.shields.io/badge/NestJS-v11.0.1-red.svg)](https://nestjs.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-v5.7.3-blue.svg)](https://www.typescriptlang.org/)
[![BullMQ](https://img.shields.io/badge/BullMQ-v5.58.5-purple.svg)](https://bullmq.io/)

## Overview

A robust NestJS microservice proxy for the Danbooru imageboard API. It handles asynchronous image search requests (e.g., tag-based anime artwork queries) via Redis streams, fetches posts with authentication, and publishes structured responses (image URLs, tags, ratings, metadata) to output streams. Designed for reliability with caching, rate limiting, distributed locking, deduplication, and encrypted Dead Letter Queue (DLQ) for errors. Supports SFW/NSFW via ratings ('s' safe, 'q' questionable, 'e' explicit). Ideal for low-to-medium throughput apps like Telegram bots or galleries, respecting Danbooru's rate limits.

### Key Features
- 🚀 **Asynchronous Queued Processing**: Redis streams + BullMQ for scalable handling, retries, and concurrency (default 5 workers).
- 🔒 **Secure API Proxying**: Authenticated Danbooru `/posts.json` calls with retries (3x exponential backoff + jitter, 429 handling), XSS sanitization (`xss` lib), and response validation.
- 💾 **Pluggable Caching**: Redis or Memcached backends; deterministic keys (MD5 hash + seed) with TTL (3600s) and invalidation for tags/random.
- ⏱️ **Rate Limiting**: Redis Lua scripts (per min/hour/day, IP+clientId keys) + NestJS ThrottlerGuard (60/min default).
- 🔐 **Distributed Locking & Deduplication**: Redis locks (SHA256 query hash, 30s TTL) to avoid duplicates; DLQ scans (1h window) + processed keys (24h TTL).
- 🛡️ **Error Handling & DLQ**: Errors to responses; encrypted DLQ (AES-256-GCM) with 5 retries; permanent failures to dead queue.
- ✅ **Input/Output Validation**: Class-validator for requests (UUID jobId, safe query ≤100 chars, HMAC apiKey) and responses (URL checks, enum ratings).
- 🌐 **Security Utils**: HMAC auth, crypto for DLQ, optional TLS for Redis (prod-ready PEM certs), jobId-context logging.
- 🔧 **Extensible**: Modular for multi-API (e.g., Gelbooru prefixes); Dockerized deployment.

## Quick Start

### Prerequisites
- Node.js v24+ & npm v10+
- Redis v7+ (Docker provided)
- Docker & Docker Compose (for Redis/TLS)
- Danbooru account ([API docs](https://danbooru.donmai.us/wiki_pages/api))

Optional: Memcached for caching.

### Dependencies
See [`package.json`](package.json). Prod: NestJS ecosystem, ioredis, BullMQ, axios. Dev: Jest, ESLint, Prettier.

### Setup & Run
1. Clone & navigate:
   ```
   git clone https://github.com/MikoMikocchi/booru-proxy.git
   cd booru-proxy
   ```

2. Automated setup (one command!):
   - **Development (non-TLS Redis)**: `npm run setup:dev`
   - **Production (TLS Redis)**: `npm run setup:prod`

   This handles:
   - 📦 Installs deps (`npm install`).
   - 🔑 Prompts for Danbooru login/API key → `.env` (gitignored).
   - 🛡️ Generates secrets: Redis pass (32 hex), API secret (64 hex), encryption key (64 hex) in `./secrets/` & `.env`.
   - 📜 Templates `.env` from `.env.example`.
   - 🛡️ **Prod only**: Generates self-signed TLS certs (`./certs/redis/`, 4096-bit, 365 days).
   - 🐳 Starts Redis:
     - Dev: Non-TLS Docker (port 6379, password auth).
     - Prod: TLS via `docker-compose up -d --build redis` (port 6380, persistent volume).
   - ⚙️ Launches worker:
     - Dev: `npm run start:dev` (hot-reload).
     - Prod: `docker-compose up -d --build danbooru-worker`.
   - ✅ Verifies: Redis PING, `npm test` (unit), `npm run test:e2e` (E2E).
   - 📝 Shows queue test example.

3. **Cross-Platform Notes**:
   - macOS/Linux: Native.
   - Windows: Use WSL/Git Bash + Docker Desktop. Install OpenSSL: `apt install openssl` (WSL).
   - Missing `envsubst`? `brew install gettext` (macOS).

### Stop & Cleanup
- Dev: Ctrl+C (worker) + `docker stop redis-dev && docker rm redis-dev`.
- Prod: `docker-compose down` (removes containers; `-v` for volumes/data loss).
- Full: `rm -rf secrets/ certs/ .env && docker volume prune -f`.

## Production Deployment

For VPS deployment (e.g., Ubuntu 22.04 on DigitalOcean/Linode, 2GB RAM for low load <100 req/day). Uses Docker Compose; secrets/certs generated locally, not in Git.

### Prerequisites
- VPS with SSH/sudo.
- Install: `sudo apt update && sudo apt install -y nodejs npm docker.io docker-compose git openssl`.
- Add user to Docker: `sudo usermod -aG docker $USER` (logout/login).
- SSH key: Add your public key to VPS `~/.ssh/authorized_keys`.
- Danbooru API key.

### Steps
1. SSH to VPS & clone:
   ```
   git clone https://github.com/MikoMikocchi/booru-proxy.git
   cd booru-proxy
   chmod +x scripts/*.sh
   ```

2. Setup & launch:
   ```
   npm run setup:prod
   ```
   - Generates secrets/certs, starts TLS Redis & worker.
   - `.env` created locally (secure it: `chmod 600 .env`).

3. Verify:
   ```
   docker-compose ps
   docker-compose logs -f danbooru-worker
   ```
   - Test queue (see Usage).

4. Firewall (UFW):
   ```
   sudo ufw allow OpenSSH
   sudo ufw allow 6380/tcp  # Redis; restrict: sudo ufw allow from BOT_IP to any port 6380
   sudo ufw enable
   ```

5. Maintenance:
   - Update: `git pull && docker-compose down && npm run setup:prod`.
   - Rotate secrets: Rerun `node scripts/generate-secrets.js`, update `.env`, `docker-compose restart`.
   - Backup: Tar `./certs ./secrets .env`; `docker volume ls` for data.
   - Scale: `docker-compose up -d --scale danbooru-worker=2` (if load grows).
   - Non-TLS (simpler for bot): Edit `.env` (`REDIS_USE_TLS=false`, port 6379), update `docker-compose.yml` (remove TLS), `docker-compose up -d --build redis`.

### Telegram Bot Integration
Connect bot as producer/consumer to Redis. Use `ioredis` + `telegraf`.

#### Example Code (Node.js Bot)
```javascript
const { Telegraf } = require('telegraf');
const Redis = require('ioredis');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();  // Load VPS .env

const redis = new Redis(process.env.REDIS_URL);  // rediss://... or redis://...
const apiSecret = process.env.API_SECRET;
const bot = new Telegraf(process.env.BOT_TOKEN);

bot.command('search', async (ctx) => {
  const query = ctx.message.text.split(' ').slice(1).join(' ') || 'cat_ears rating:s';
  if (query.length > 100) return ctx.reply('Query too long!');

  const jobId = uuidv4();
  const hmac = crypto.createHmac('sha256', apiSecret).update(jobId + query).digest('hex');

  try {
    await redis.xadd('danbooru:requests', '*', { jobId, query, apiKey: hmac, clientId: ctx.from.id.toString() });
    ctx.reply(`Request sent! Job ID: ${jobId}.`);

    // Poll response
    const [[, messages]] = await redis.xread('BLOCK', 10000, 'STREAMS', 'danbooru:responses', '$');
    if (messages?.[0]) {
      const [, fields] = messages[0];
      const data = JSON.parse(fields.data || '{}');
      if (data.jobId === jobId) {
        ctx.reply(data.type === 'success' 
          ? `Found: ${data.imageUrl}\nTags: ${data.tags}\nRating: ${data.rating}` 
          : `Error: ${data.error}`);
        await redis.xdel('danbooru:responses', messages[0][0]);  // Ack
      }
    }
  } catch (err) {
    ctx.reply(`Error: ${err.message}`);
  }
});

bot.launch();
console.log('Bot started');
```

- **TLS Setup**: For external bot, copy `./certs/redis/redis-client.*` to bot server. In ioredis:
  ```javascript
  const fs = require('fs');
  const redis = new Redis({
    // ... url
    tls: {
      ca: [fs.readFileSync('ca.crt')],
      cert: fs.readFileSync('redis-client.crt'),
      key: fs.readFileSync('redis-client.key'),
      rejectUnauthorized: false  // Dev; prod: trust CA
    }
  });
  ```
- Expose Redis securely: Use VPS firewall to allow only bot IP.

## Usage

Interact via Redis streams (ioredis client example).

### Submitting Requests
Add to `danbooru:requests`:
```javascript
const Redis = require('ioredis');
const crypto = require('crypto');
const redis = new Redis(process.env.REDIS_URL);

const jobId = crypto.randomUUID();
const query = 'cat_ears rating:safe';
const secret = process.env.API_SECRET;
const apiKey = crypto.createHmac('sha256', secret).update(jobId + query).digest('hex');
const clientId = 'bot-user';  // Optional, alphanumeric ≤50

await redis.xadd('danbooru:requests', '*', {
  jobId, query, apiKey, clientId
});
```
- Validation: Query (alphanumeric + spaces/-:() ≤100), HMAC apiKey, UUID jobId.
- Directives: `rating:s`, `limit:10` (env default: 1), `random:true` (deterministic seed).

### Reading Responses
From `danbooru:responses`:
```javascript
const stream = await redis.xread('BLOCK', 0, 'STREAMS', 'danbooru:responses', '0');

for (const [streamName, messages] of stream) {
  for (const [id, fields] of messages) {
    const response = JSON.parse(fields.data || '{}');
    console.log(response);
    // Ack if using consumer groups: await redis.xack('danbooru:responses', 'group', id);
  }
}
```

**Success**:
```json
{
  "type": "success",
  "jobId": "uuid-v4",
  "imageUrl": "https://danbooru.donmai.us/data/...",
  "author": "artist",
  "tags": "cat_ears solo rating:s",
  "rating": "s",
  "source": "https://...",
  "copyright": "character",
  "timestamp": "2025-09-12T19:49:20Z"
}
```

**Error**:
```json
{
  "type": "error",
  "jobId": "uuid-v4",
  "error": "No posts found",
  "timestamp": "2025-09-12T19:49:20Z"
}
```

### Monitoring DLQ/Dead Queue
- DLQ (`danbooru:dlq`): Encrypted failures (query hash, error, retries).
- Dead (`danbooru-dead`): Permanent.
```javascript
await redis.xread('BLOCK', 5000, 'STREAMS', 'danbooru:dlq', '0');  // Poll
```
Scale: Multiple workers; locks prevent duplicates.

## API Reference

### Request DTO
See [`src/danbooru/dto/create-request.dto.ts`](src/danbooru/dto/create-request.dto.ts):
```typescript
export class CreateRequestDto {
  @IsUUID() jobId: string;
  @IsString() @MaxLength(100) @Matches(/^[a-zA-Z0-9\s\-_:()]+$/) query: string;
  @IsString() apiKey: string;  // HMAC validated
  @IsOptional() @IsString() @MaxLength(50) @Matches(/^[a-zA-Z0-9\-_]+$/) clientId?: string;
}
```

### Response DTO
[`src/danbooru/dto/danbooru-post.class.ts`](src/danbooru/dto/danbooru-post.class.ts): Maps Danbooru fields (id, file_url → imageUrl, tags, rating enum 's/q/e', etc.). Interfaces: [`src/danbooru/interfaces/danbooru.interface.ts`](src/danbooru/interfaces/danbooru.interface.ts).

Examples: `query: "cat_ears rating:s"`, `artist:drawr`, random via env.

## Architecture

Pure NestJS microservice (no HTTP) in [`src/main.ts`](src/main.ts): Redis transport (ioredis, TLS opt), global pipes, graceful shutdown.

### Modules
- **AppModule** ([`src/app.module.ts`](src/app.module.ts)): Root; ConfigModule (env), SharedModule, DanbooruModule.
- **SharedModule** ([`src/common/shared.module.ts`](src/common/shared.module.ts)):
  - Cache: [`cache.module.ts`](src/common/cache/cache.module.ts), Redis/Memcached backends.
  - Queues: [`queues.module.ts`](src/common/queues/queues.module.ts), BullMQ consumers (stream/DLQ).
  - RateLimit: [`rate-limit.module.ts`](src/common/rate-limit/rate-limit.module.ts), Lua counters + guard.
  - Redis: [`redis.module.ts`](src/common/redis/redis.module.ts), locks/utils.
  - Validation/Crypto: DTOs, AES for DLQ.
  - Constants: [`constants.ts`](src/common/constants.ts).
- **DanbooruModule** ([`danbooru.module.ts`](src/danbooru/danbooru.module.ts)): Services (orchestrator, API, validation), DTOs.

### Flow
1. Producer: XADD `danbooru:requests`.
2. Consumer: Validate → Lock/Dedup → Rate check → Cache/API → Publish response, DLQ if fail.
3. DLQ Consumer: Retry or dead.

## Scripts & Utilities

In `scripts/`:
- `setup.sh`: Main (deps, secrets, certs, Redis/worker launch; dev/prod).
- `generate-secrets.js`: Random secrets (Node.js).
- `generate-certs.sh`: OpenSSL TLS certs (prod).
- `redis-start.sh`: Docker Redis launch.

`chmod +x scripts/*.sh`. Cross-platform (WSL for Windows).

## Docker

- **`Dockerfile`**: Multi-stage Node 24-alpine (build/prod).
- **`docker-compose.yml`**: Redis (TLS, healthcheck), worker (env from .env, cert volumes).

Commands:
- Build/run: `docker-compose up -d --build`.
- Logs: `docker-compose logs -f`.
- Scale: `--scale danbooru-worker=3`.

`.dockerignore` optimizes (excludes node_modules).

## Testing

### Unit Tests
Jest (mocks: ioredis-mock, nock HTTP):
```
npm test  # Watch: npm run test:watch
npm run test:cov
```
Specs: Services, consumers, guards (e.g., [`danbooru.service.spec.ts`](src/danbooru/danbooru.service.spec.ts)).

### E2E Tests
Supertest + testcontainers (isolated Redis):
```
npm run test:e2e  # Config: test/jest-e2e.json
```
Extend [`app.e2e-spec.ts`](test/app.e2e-spec.ts). Debug: `npm run test:debug`.

Aim: 100% coverage (`./coverage/`).

## Troubleshooting

- **Docker/Redis Issues**:
  - No Docker: Install Docker Desktop.
  - "No space": `docker system prune -f`.
  - Redis PING fail: Check logs (`docker logs redis-dev`), password in `.env`, port/firewall.
  - TLS errors: Verify cert paths; self-signed: `rejectUnauthorized: false` (dev).

- **Setup Errors**:
  - OpenSSL/envsubst missing: Install (brew/apt).
  - Danbooru auth fail: Re-enter credentials in setup.
  - Windows: Use WSL; `chmod` via Git Bash.

- **Runtime/Worker Crashes**:
  - Logs: Console (dev) or `docker-compose logs`.
  - Common: Missing env (e.g., REDIS_URL), Redis down, invalid HMAC.
  - Permissions: `chmod 600 .env ./secrets/*`.

- **TG Bot Specific**:
  - Connection refused: VPS firewall (ufw allow from bot IP), correct REDIS_URL/port.
  - HMAC mismatch: Sync API_SECRET between bot/worker; log/debug hash.
  - No response: Check worker logs (rate limit? API fail?), XLEN streams.
  - TLS cert reject: Copy client certs, set tls options; or switch non-TLS.
  - Latency: Low load ok; scale workers if >100 req/day.
  - Secrets leak: Rotate via generate-secrets.js; never commit .env/certs.

For persistent issues, share logs/error output.

## Contributing

1. Fork repo.
2. Branch: `git checkout -b feature/new`.
3. Commit: `git commit -m "Add feature"`.
4. Push: `git push origin feature/new`.
5. PR.

Run `npm run lint && npm test`. Follow NestJS style; add tests/docs. See `.github/` for workflows.

## License

MIT - see [`LICENSE`](LICENSE).
