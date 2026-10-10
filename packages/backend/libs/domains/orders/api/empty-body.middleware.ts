import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * A request without a body arrives with `req.body` undefined, one with `{}` with an empty object, and the idempotency
 * interceptor (which runs before the handler) fingerprints them differently. `POST /checkout` treats "no body" and `{}`
 * as the same request (its only field is optional), so the body is normalised before any guard or interceptor sees it.
 */
@Injectable()
export class EmptyBodyMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    if (req.body === undefined) req.body = {};
    next();
  }
}
