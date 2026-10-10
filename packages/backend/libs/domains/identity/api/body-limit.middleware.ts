import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { Domain_PayloadTooLargeError } from '../domain/errors';

export const AUTH_BODY_LIMIT_BYTES = 16 * 1024;

/**
 * Credential routes accept at most 16 KB (FR-017). The platform parser allows 1 MiB for the whole API and keeps the
 * exact bytes, so this refuses the larger-than-16 KB case with a 413 before any handler (and any hashing) runs.
 */
@Injectable()
export class AuthBodyLimitMiddleware implements NestMiddleware {
  use(req: Request & { rawBody?: Buffer }, _res: Response, next: NextFunction) {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (
      declared > AUTH_BODY_LIMIT_BYTES ||
      (req.rawBody?.length ?? 0) > AUTH_BODY_LIMIT_BYTES
    )
      throw new Domain_PayloadTooLargeError();
    next();
  }
}
