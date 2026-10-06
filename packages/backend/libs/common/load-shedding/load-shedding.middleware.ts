import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { EventLoopMonitor } from './event-loop-monitor.service';
import { ApiConfigService } from '@app/common/config/api-config.service';

const EXEMPT_PATHS = ['/livez', '/readyz', '/api/livez', '/api/readyz', '/metrics'];

/**
 * Rejects new work early with 503 + Retry-After when the event loop is
 * saturated. Better to fail some requests fast than to let every request
 * time out (lesson 06/03 §5). Health endpoints are exempt so an overloaded
 * instance isn't also declared dead.
 */
@Injectable()
export class LoadSheddingMiddleware implements NestMiddleware {
  private readonly thresholdMs: number;

  constructor(
    private readonly monitor: EventLoopMonitor,
    config: ApiConfigService,
  ) {
    this.thresholdMs = config.get('load_shedding_lag_ms') ?? 200;
  }

  use(req: Request, res: Response, next: NextFunction) {
    if (EXEMPT_PATHS.includes(req.path) || this.monitor.p99Ms() < this.thresholdMs) {
      return next();
    }

    res
      .status(503)
      .setHeader('Retry-After', '1')
      .type('application/problem+json')
      .json({
        type: 'https://api.yourdomain.com/errors/ServiceOverloaded',
        title: 'Service Overloaded',
        status: 503,
        detail: 'The server is temporarily overloaded. Retry shortly.',
      });
  }
}
