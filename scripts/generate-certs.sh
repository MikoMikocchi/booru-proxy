#!/bin/bash

set -e  # Exit on error

CERTS_DIR="$(pwd)/certs/redis"
mkdir -p "$CERTS_DIR"

echo "Generating CA certificate..."

openssl req -x509 -newkey rsa:4096 -keyout "$CERTS_DIR/ca.key" -out "$CERTS_DIR/ca.crt" -days 365 -nodes -subj "/CN=RedisCA"

echo "Generating server certificate..."

openssl req -newkey rsa:4096 -keyout "$CERTS_DIR/redis.key" -out "$CERTS_DIR/redis.csr" -nodes -subj "/CN=RedisServer"

openssl x509 -req -in "$CERTS_DIR/redis.csr" -CA "$CERTS_DIR/ca.crt" -CAkey "$CERTS_DIR/ca.key" -CAcreateserial -out "$CERTS_DIR/redis.crt" -days 365

echo "Generating client certificate..."

openssl req -newkey rsa:4096 -keyout "$CERTS_DIR/redis-client.key" -out "$CERTS_DIR/redis-client.csr" -nodes -subj "/CN=RedisClient"

openssl x509 -req -in "$CERTS_DIR/redis-client.csr" -CA "$CERTS_DIR/ca.crt" -CAkey "$CERTS_DIR/ca.key" -CAcreateserial -out "$CERTS_DIR/redis-client.crt" -days 365

# Clean up CSRs
rm -f "$CERTS_DIR"/*.csr

echo "Certificates generated in $CERTS_DIR/"
