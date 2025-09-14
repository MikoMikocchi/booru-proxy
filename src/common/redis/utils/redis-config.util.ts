import { ConfigService } from '@nestjs/config'
import * as fs from 'node:fs'
import type { ConnectionOptions } from 'node:tls'
import { Logger } from '@nestjs/common'

export function createRedisConfig(
  configService: ConfigService,
  logger: Logger,
): {
  host: string
  port: number
  username?: string
  password?: string
  tls?: ConnectionOptions
  retryStrategy: (times: number) => number | null
} {
  const redisPassword = configService.get<string>('REDIS_PASSWORD')
  const redisUrlRaw =
    configService.get<string>('REDIS_URL') || 'redis://localhost:6379'
  const useTls = configService.get<boolean>('REDIS_USE_TLS', false)

  logger.debug(
    `DEBUG: REDIS_PASSWORD=${redisPassword ? '[REDACTED]' : undefined}`,
  )
  logger.debug(`DEBUG: REDIS_URL raw=${redisUrlRaw}`)
  logger.debug(`DEBUG: REDIS_USE_TLS=${useTls}`)

  // Always parse the raw URL (assumes redis:// protocol)
  const parsedUrl = new URL(redisUrlRaw)
  const host = parsedUrl.hostname
  const port = Number(parsedUrl.port) || 6379
  const username = parsedUrl.username || undefined
  const password = parsedUrl.password || redisPassword || undefined

  logger.debug(
    `DEBUG: Parsed - host: ${host}, port: ${port}, username: ${username}, useTls: ${useTls}`,
  )

  let tlsConfig: ConnectionOptions | undefined = undefined
  if (useTls) {
    const caPath = configService.get<string>('REDIS_TLS_CA')
    const certPath = configService.get<string>('REDIS_TLS_CERT')
    const keyPath = configService.get<string>('REDIS_TLS_KEY')

    if (caPath && certPath && keyPath) {
      try {
        const caContent = fs.readFileSync(caPath, 'utf8')
        const certContent = fs.readFileSync(certPath, 'utf8')
        const keyContent = fs.readFileSync(keyPath, 'utf8')

        // Validate PEM format
        if (
          !caContent.includes('-----BEGIN CERTIFICATE-----') ||
          !certContent.includes('-----BEGIN CERTIFICATE-----') ||
          (!keyContent.includes('-----BEGIN PRIVATE KEY-----') &&
            !keyContent.includes('-----BEGIN RSA PRIVATE KEY-----'))
        ) {
          throw new Error('Invalid PEM format in certificate files')
        }

        tlsConfig = {
          ca: [caContent],
          cert: [certContent],
          key: keyContent,
          rejectUnauthorized: process.env.NODE_ENV !== 'development', // Skip validation in dev for self-signed certs
        } as ConnectionOptions
      } catch (error) {
        logger.warn('Failed to load TLS certificates', error as Error)
        tlsConfig = {
          rejectUnauthorized: false, // Fallback for dev
        } as ConnectionOptions
      }
    } else {
      tlsConfig = {
        rejectUnauthorized: false, // Fallback if paths not provided
      } as ConnectionOptions
    }
  }

  const retryStrategy = (times: number) => {
    if (times > 10) {
      return null
    }
    return Math.min(times * 500, 3000)
  }

  return {
    host,
    port,
    username,
    password,
    tls: tlsConfig,
    retryStrategy,
  }
}
