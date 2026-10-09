import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { map, Observable } from 'rxjs';

/**
 * Weak ETag from the resource version (`W/"<id>-v<version>"`) and 304 on
 * If-None-Match: clients/CDNs revalidate for free instead of re-downloading.
 * Handlers return `{ version, ... }`; responses without a version pass through.
 */
@Injectable()
export class VersionEtagInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();

    return next.handle().pipe(
      map((body: { id?: string; version?: number } | null) => {
        if (!body || typeof body.version !== 'number') return body;
        const etag = `W/"${body.id ?? 'r'}-v${body.version}"`;
        res.setHeader('ETag', etag);
        if (req.headers['if-none-match'] === etag) {
          res.status(304);
          return undefined;
        }
        return body;
      }),
    );
  }
}
