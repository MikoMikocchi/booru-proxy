# Danbooru Gateway

[![Node.js](https://img.shields.io/badge/Node.js-v24-green)](https://nodejs.org/)
[![NestJS](https://img.shields.io/badge/NestJS-v11-red)](https://nestjs.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-v5.7-blue)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/MikoMikocchi/danbooru-gateway/workflows/CI/badge.svg)](https://github.com/MikoMikocchi/danbooru-gateway/actions)

A NestJS worker that processes image search queries to the Danbooru API via Redis streams. It fetches random posts with authentication and publishes structured responses to another stream, including image URL, tags, author, rating, source, and copyright.

## Features

- **Redis Stream Integration**: Consumes requests from `danbooru:requests` stream and publishes responses to `danbooru:responses`.
- **Danbooru API Client**: Authenticated queries for random image posts matching tags.
- **Input Validation**: Uses class-validator and DTOs for request validation.
- **Error Handling**: Logs errors and publishes error responses.
- **Docker Support**: Easy deployment with Docker Compose (includes Redis).
- **Testing**: Unit tests with Jest.
- **CI/CD**: GitHub Actions for linting, testing, and building.

## Architecture

- **Microservice**: Built with NestJS using Redis transport.
- **Flow**:
  1. Producer adds job to Redis stream `danbooru:requests` with `jobId` and `query` (tags).
  2. Consumer (this service) reads, validates, queries Danbooru API.
  3. Publishes response to `danbooru:responses` stream.
- **Dependencies**: Axios for HTTP, ioredis for Redis, class-transformer/validator for DTOs.
- **Configuration**: Env vars for Redis URL, Danbooru login/API key.

## API Retry Strategy

The application implements robust retry logic for API calls using `axios-retry` v4.5.0 with the following configuration:

### Retry Conditions
- **Network timeouts**: `ECONNABORTED` errors
- **Rate limiting**: HTTP 429 status
- **Server errors**: HTTP 5xx status codes (500-599)

### Retry Configuration
- **Maximum retries**: 3 attempts
- **Backoff strategy**: Exponential backoff with jitter
  - Delay formula: `2^retryCount * 1000 + random(0-1000)ms`
  - Example delays: ~1-2s (1st), ~2-3s (2nd), ~4-5s (3rd)

### 429 Rate Limit Handling
- **Retry-After header**: When receiving 429, the service respects the `retry-after` header if present
- **Fallback**: If no header, uses exponential backoff
- **Logging**: Warns when respecting retry-after: "Respecting 429 retry-after header: X seconds"

### Implementation
- **BaseApiService**: Configures axios-retry in constructor after creating the Axios instance
- **DanbooruApiService**: Extends BaseApiService, inherits retry logic
- **Custom delay function**: Checks 429 response headers before applying backoff
- **Inheritance**: All API services inherit this retry behavior

This ensures reliable API communication even under high load or temporary rate limits from Danbooru.

## Quick Start

1. Clone the repo and install dependencies:

   ```bash
   npm install
   ```

2. Set up environment variables (copy `.env.example` to `.env` and fill in):

   ```
   DANBOORU_LOGIN=your_danbooru_login
   DANBOORU_API_KEY=your_danbooru_api_key
   REDIS_URL=redis://localhost:6379
   ```

3. Run with Docker (recommended):

   ```bash
   docker-compose up --build
   ```

4. Or run locally:
   - Start Redis (e.g., via Docker: `docker run -p 6379:6379 redis:alpine`).
   - Run the service: `npm run start:dev`.

## Usage

- **Request Format**: Add to Redis stream `danbooru:requests`:

  ```javascript
  // Example using ioredis
  await redis.xadd(
  	'danbooru:requests',
  	'*',
  	'jobId',
  	'unique-job-id',
  	'query',
  	'cat_ears',
  )
  ```

- **Response Format**: Read from `danbooru:responses`:
  - Success: `{ jobId: string, imageUrl: string, author?: string, tags: string, rating: string, source?: string, copyright: string }`
  - Error: `{ jobId: string, error: string }`

Example query: Tags like "1girl blue_eyes" fetches a random safe/explicit post.

**Note**: Danbooru requires an account for API access. Posts may include NSFW content based on tags/rating.

## Environment Variables

- `REDIS_URL`: Redis connection URL (default: `redis://localhost:6379`).
- `DANBOORU_LOGIN`: Your Danbooru username.
- `DANBOORU_API_KEY`: Your Danbooru API key (from account settings).

See `.env.example` for template.

## Development

- **Start Dev Mode**: `npm run start:dev` (watches for changes).
- **Linting**: `npm run lint` (uses ESLint and Prettier).
- **Formatting**: `npm run format`.

## Testing

- Run tests: `npm run test`.
- Coverage: `npm run test:cov`.
- Watch mode: `npm run test:watch`.
- E2E: `npm run test:e2e` (configure as needed).

Includes unit tests for the Danbooru service.

## Docker

- **Build & Run**: `docker-compose up --build`.
- **Services**:
  - `redis`: Official Redis image with append-only mode.
  - `danbooru-worker`: Builds from Dockerfile, connects to Redis, uses env vars.
- **Production**: Use multi-stage build (Node 24 Alpine) for the worker.

Customize `.env` for production secrets.

## CI/CD

- GitHub Actions workflow (`.github/workflows/ci.yml`):
  - Triggers on push/PR to main.
  - Runs on Node 20.
  - Installs deps, lints, runs tests with coverage, builds the project.

## Contributing

1. Fork the repo.
2. Create a feature branch.
3. Commit changes and run tests/lint.
4. Open a PR.

## License

This project is MIT licensed. See [LICENSE](LICENSE) for details (or add one if missing).
