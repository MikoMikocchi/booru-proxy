import { Injectable, ExecutionContext } from '@nestjs/common'
import { ThrottlerGuard } from '@nestjs/throttler'
import { Request } from 'express'

@Injectable()
export class ApiThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Request): Promise<string> {
    // Extract apiPrefix from path or headers
    const apiPrefix = this.extractApiPrefix(req)
    const ip = this.extractIp(req)
    const clientId = (req.headers['x-client-id'] as string) || 'anonymous'

    return Promise.resolve(`${apiPrefix}:${ip}:${clientId}`)
  }

  protected extractApiPrefix(req: Request): string {
    // Extract API prefix from URL path
    // Examples: /api/danbooru/posts -> 'danbooru'
    //          /api/gelbooru/tags -> 'gelbooru'
    const path = req.path
    const match = path.match(/^\/api\/([^/]+)\//)
    return match?.[1] ?? 'default'
  }

  protected extractIp(req: Request): string {
    return req.ip || req.connection.remoteAddress || 'unknown'
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Let parent ThrottlerGuard handle the logic with our custom tracker
    return super.canActivate(context)
  }
}
