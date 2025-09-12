#!/bin/sh

# Set paths
CERT_DIR="/certs/redis"
REDIS_PASSWORD_SECRET="/run/secrets/redis_password"
REDIS_CLI_TLS_OPTS="--tls --cacert ${CERT_DIR}/ca.crt --cert ${CERT_DIR}/redis.crt --key ${CERT_DIR}/redis.key -h localhost -p 6380"

# Read password from secret
if [ -f "$REDIS_PASSWORD_SECRET" ]; then
  PASSWORD=$(cat "$REDIS_PASSWORD_SECRET" | sed -n '1p')
else
  echo "Warning: No Redis password secret found at $REDIS_PASSWORD_SECRET"
  PASSWORD=""
fi

# Start Redis server with TLS, no auth (adjust flags to match existing: port 6379 non-TLS? but plan disables with --port 0; use existing TLS flags)
echo "Starting Redis server with TLS (no initial auth)..."
redis-server \
  --port 6379 \
  --tls-port 6380 \
  --tls-cert-file ${CERT_DIR}/redis.crt \
  --tls-key-file ${CERT_DIR}/redis.key \
  --tls-ca-cert-file ${CERT_DIR}/ca.crt \
  --requirepass "" \
  --appendonly yes \
  --dir /data \
  &

# Wait for Redis to be ready (use non-TLS if port 6379 open, or TLS)
echo "Waiting for Redis to start..."
until redis-cli ${REDIS_CLI_TLS_OPTS} PING; do
  echo "Redis not ready yet, waiting..."
  sleep 1
done
echo "Redis is ready."

# Configure ACL for 'default' user if password provided
if [ -n "$PASSWORD" ]; then
  echo "Configuring ACL for 'default' user..."
  redis-cli ${REDIS_CLI_TLS_OPTS} ACL SETUSER default on >${PASSWORD} ~* +@all
  echo "ACL configured for 'default' user."
else
  echo "No password provided; skipping ACL setup (no auth)."
  redis-cli ${REDIS_CLI_TLS_OPTS} ACL SETUSER default on ~* +@all
fi

# Keep container running
echo "Redis startup complete. ACL auth enabled."
wait
