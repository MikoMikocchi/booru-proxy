import { ConfigService } from '@nestjs/config'
import * as fs from 'node:fs'
import type { ConnectionOptions, PeerCertificate } from 'node:tls'
import { Logger } from '@nestjs/common'
import { RedisOptions } from 'ioredis'

/* eslint-disable @typescript-eslint/no-unused-vars */
export const ignoreServerIdentity = (
  _hostname: string,
  _cert: PeerCertificate,
) => undefined
/* eslint-enable @typescript-eslint/no-unused-vars */

function parseRedisUrl(redisUrl: string): URL {
  try {
    const url = new URL(redisUrl)
    if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
      throw new Error(
        'Invalid protocol for Redis URL. Must be redis: or rediss:',
      )
    }
    return url
  } catch {
    throw new Error('Invalid Redis URL format')
  }
}

export function createRedisConfig(
  configService: ConfigService,
  logger?: Logger,
): RedisOptions {
  const log = (msg: string, ...args: unknown[]) => logger?.debug(msg, ...args)

  const redisUrlRaw =
    configService.get<string>('REDIS_URL') || 'redis://localhost:6379'
  const useTls = configService.get<boolean>('REDIS_USE_TLS', false)
  const redisPassword = configService.get<string>('REDIS_PASSWORD')

  log(`REDIS_URL raw=${redisUrlRaw}`)
  log(`REDIS_USE_TLS=${useTls}`)

  // Parse and validate URL
  let parsedUrl: URL
  try {
    parsedUrl = parseRedisUrl(redisUrlRaw)
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error'
    throw new Error(`Invalid REDIS_URL: ${errMsg}`)
  }

  // Handle TLS URL transformation
  if (useTls && parsedUrl.protocol === 'redis:') {
    parsedUrl.protocol = 'rediss:'
    const password = parsedUrl.password || redisPassword || ''
    const authPart = parsedUrl.username
      ? `${parsedUrl.username}:${password}`
      : `:${password}`
    parsedUrl = new URL(`rediss://${authPart}@${parsedUrl.host}`)
  }

  const host = parsedUrl.hostname
  const port = Number(parsedUrl.port) || (useTls ? 6380 : 6379)
  const username = parsedUrl.username || undefined
  const password = parsedUrl.password || undefined

  log(
    `Parsed - host: ${host}, port: ${port}, username: ${!!username}, useTls: ${useTls}`,
  )

  const tlsConfig = useTls ? createTlsConfig(configService, log) : undefined

  const retryStrategy = (times: number) => {
    if (times > 15) {
      return null
    }
    return Math.min(100 * Math.pow(3, times - 1), 5000)
  }

  const options: RedisOptions = {
    host,
    port,
    username,
    password,
    ...(tlsConfig ? { tls: tlsConfig } : {}),
    retryStrategy,
    reconnectOnError: () => 2.0,
    lazyConnect: true,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    enableAutoPipelining: true,
  }

  return options
}

function createTlsConfig(
  configService: ConfigService,
  log: (msg: string, ...args: unknown[]) => void,
): ConnectionOptions {
  const caPath = configService.get<string>('REDIS_TLS_CA')
  const certPath = configService.get<string>('REDIS_TLS_CERT')
  const keyPath = configService.get<string>('REDIS_TLS_KEY')

  if (!caPath || !certPath || !keyPath) {
    log('TLS paths not provided, using insecure fallback')
    return {
      rejectUnauthorized: false,
      checkServerIdentity: ignoreServerIdentity,
    }
  }

  try {
    const caContent = fs.readFileSync(caPath, 'utf8')
    const certContent = fs.readFileSync(certPath, 'utf8')
    const keyContent = fs.readFileSync(keyPath, 'utf8')

    validatePem(caContent, 'CA')
    validatePem(certContent, 'Cert')
    validatePemKey(keyContent)

    return {
      ca: [caContent],
      cert: [certContent],
      key: keyContent,
      rejectUnauthorized: process.env.NODE_ENV !== 'development',
      checkServerIdentity: ignoreServerIdentity,
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    log('Failed to load TLS certificates, using insecure fallback', err)
    return {
      rejectUnauthorized: false,
      checkServerIdentity: ignoreServerIdentity,
    }
  }
}

function validatePem(content: string, type: string): void {
  if (!content.includes('-----BEGIN CERTIFICATE-----')) {
    throw new Error(`Invalid PEM format in ${type} file`)
  }
}

function validatePemKey(content: string): void {
  if (
    !content.includes('-----BEGIN PRIVATE KEY-----') &&
    !content.includes('-----BEGIN RSA PRIVATE KEY-----')
  ) {
    throw new Error('Invalid PEM format in key file')
  }
}
