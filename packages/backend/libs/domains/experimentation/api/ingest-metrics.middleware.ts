import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import {
  analyticsIngestRequestsTotal,
  analyticsRateLimitedTotal,
  analyticsRateLimiterDegradedTotal,
} from '../application/analytics-metrics';

/**
 * Counts every answer of `POST /events` by status, whoever produced it (guard, rate limiter, pipe, handler): the
 * request-level metrics of S39 AS-54. A success without the limiter's `RateLimit-Policy` header means the limiter's store
 * was unavailable and the request was admitted without a decision (fail open); a `429` is a refusal.
 */
@Injectable()
export class IngestMetricsMiddleware implements NestMiddleware {
  use(_req: Request, res: Response, next: NextFunction): void {
    res.once('finish', () => {
      const status = res.statusCode;
      analyticsIngestRequestsTotal.add(1, { status: String(status) });
      if (status === 429) analyticsRateLimitedTotal.add(1);
      else if (status < 400 && !res.getHeader('ratelimit-policy'))
        analyticsRateLimiterDegradedTotal.add(1);
    });
    next();
  }
}
