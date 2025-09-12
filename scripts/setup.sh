#!/bin/bash

set -e  # Exit on any error

# Parse arguments
MODE="dev"
if [[ "$1" == "--prod" ]]; then
  MODE="prod"
fi

PROD=false
if [[ "$MODE" == "prod" ]]; then
  PROD=true
fi

echo "Starting setup in $MODE mode..."

# Check for Docker
if ! command -v docker &> /dev/null; then
  echo "Error: Docker is required for Redis setup. Please install Docker."
  exit 1
fi

# npm install
echo "Installing dependencies..."
npm install

# Generate secrets and capture exports
echo "Generating secrets..."
SECRETS_OUTPUT=$(node scripts/generate-secrets.js)
eval "$SECRETS_OUTPUT"

# Copy .env.example to .env
cp .env.example .env

# Template .env with captured vars using sed (macOS compatible)
echo "Configuring .env..."

# DANBOORU_LOGIN
sed -i '' "s/^DANBOORU_LOGIN=.*/DANBOORU_LOGIN=$DANBOORU_LOGIN/" .env

# DANBOORU_API_KEY
sed -i '' "s/^DANBOORU_API_KEY=.*/DANBOORU_API_KEY=$DANBOORU_API_KEY/" .env

# REDIS_PASSWORD (uncomment if needed and set)
if ! grep -q "^REDIS_PASSWORD=" .env; then
  sed -i '' '/^# REDIS_PASSWORD=/s/^# //' .env
fi
sed -i '' "s/^REDIS_PASSWORD=.*/REDIS_PASSWORD=$REDIS_PASSWORD/" .env

# API_SECRET
sed -i '' "s/^API_SECRET=.*/API_SECRET=$API_SECRET/" .env

# ENCRYPTION_KEY
sed -i '' "s/^ENCRYPTION_KEY=.*/ENCRYPTION_KEY=$ENCRYPTION_KEY/" .env

# Set mode-specific defaults
if $PROD; then
  sed -i '' "s/^REDIS_USE_TLS=.*/REDIS_USE_TLS=true/" .env
  sed -i '' "s/^REDIS_URL=.*/REDIS_URL=rediss:\/\/default:$REDIS_PASSWORD@localhost:6380/" .env
  # Set TLS paths if not set
  sed -i '' "s|^REDIS_TLS_CA=.*|REDIS_TLS_CA=./certs/redis/ca.crt|" .env
  sed -i '' "s|^REDIS_TLS_CERT=.*|REDIS_TLS_CERT=./certs/redis/redis-client.crt|" .env
  sed -i '' "s|^REDIS_TLS_KEY=.*|REDIS_TLS_KEY=./certs/redis/redis-client.key|" .env
else
  sed -i '' "s/^REDIS_USE_TLS=.*/REDIS_USE_TLS=false/" .env
  sed -i '' "s/^REDIS_URL=.*/REDIS_URL=redis:\/\/:$REDIS_PASSWORD@localhost:6379/" .env
fi

# Generate certs for prod
if $PROD; then
  echo "Generating TLS certificates..."
  ./scripts/generate-certs.sh
fi

# Start Redis
REDIS_CONTAINER_NAME="redis"
if $PROD; then
  echo "Starting Redis in production mode (TLS via docker-compose)..."
  docker-compose up -d --build redis
  sleep 10  # Give time to start
else
  echo "Starting Redis in development mode (non-TLS via docker run)..."
  # Stop if already running
  docker stop redis-dev &>/dev/null || true
  docker rm redis-dev &>/dev/null || true
  docker run -d --name redis-dev -p 6379:6379 \
    -v $(pwd)/secrets/redis_password.txt:/run/secrets/redis_password:ro \
    redis:alpine redis-server --requirepass /run/secrets/redis_password --appendonly yes
  REDIS_CONTAINER_NAME="redis-dev"
  sleep 5
fi

# Verify Redis
echo "Verifying Redis..."
if $PROD; then
  if ! docker-compose exec redis redis-cli -a $REDIS_PASSWORD --tls --cacert ./certs/redis/ca.crt --cert ./certs/redis/redis-client.crt --key ./certs/redis/redis-client.key -p 6380 PING | grep -q PONG; then
    echo "Error: Redis PING failed in prod mode."
    exit 1
  fi
else
  if ! docker exec $REDIS_CONTAINER_NAME redis-cli -a $REDIS_PASSWORD PING | grep -q PONG; then
    echo "Error: Redis PING failed in dev mode."
    exit 1
  fi
fi
echo "Redis is healthy."

# Launch worker
if $PROD; then
  echo "Launching worker in production mode..."
  docker-compose up -d --build danbooru-worker
else
  echo "Launching worker in development mode..."
  npm run start:dev
fi

# Run tests
echo "Running tests..."
npm test
npm run test:e2e

# Queue test example
echo "Queue test command example:"
echo "redis-cli -a $REDIS_PASSWORD XADD danbooru:requests '*' jobId $(uuidgen) query 'cat rating:s' apiKey 'hmac_placeholder'"

echo "Setup complete. Worker ready."
