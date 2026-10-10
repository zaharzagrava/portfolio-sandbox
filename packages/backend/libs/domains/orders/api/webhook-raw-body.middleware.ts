import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ApiConfigService } from '@app/common/config';
import { PayloadTooLargeError } from '../domain/order-errors';

/**
 * The webhook needs the exact bytes the provider signed. The platform's JSON parser keeps them for JSON bodies; for any
 * other content type nothing has read the stream yet, so this reads it here, capped at the route's limit (S10 FR-042).
 */
@Injectable()
export class WebhookRawBodyMiddleware implements NestMiddleware {
  constructor(private readonly config: ApiConfigService) {}

  use(
    req: Request & { rawBody?: Buffer },
    _res: Response,
    next: NextFunction,
  ): void {
    if (req.rawBody !== undefined || req.readableEnded) return next();
    const limit = this.config.get('orders_webhook_body_limit_bytes');
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        next(new PayloadTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      req.rawBody = Buffer.concat(chunks);
      next();
    });
    req.on('error', (error) => {
      if (done) return;
      done = true;
      next(error);
    });
  }
}
