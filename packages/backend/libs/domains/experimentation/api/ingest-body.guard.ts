import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { INGEST_LIMITS } from '@marketplace-sandbox/contracts';
import {
  payloadTooLarge,
  unsupportedMediaType,
} from '../domain/experiment-errors';

export interface IngestRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody?: Buffer;
  [Symbol.asyncIterator](): AsyncIterator<Buffer | string>;
}

export const mediaTypeOf = (req: Pick<IngestRequest, 'headers'>): string =>
  String(req.headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();

/**
 * The coarse checks of the ingest body (S39 FR-006), made before any validation runs: a content type other than JSON or
 * plain text is `415`, a body above 128 KiB `413`. The platform parser has already read a JSON body (bounded at 1 MiB, exact
 * bytes in `rawBody`); a `text/plain` body (what `navigator.sendBeacon` sends) has no parser, so it is read here, never
 * past the limit, and left in `rawBody` for the pipe.
 */
@Injectable()
export class IngestBodyGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<IngestRequest>();
    const type = mediaTypeOf(req);
    if (type !== 'application/json' && type !== 'text/plain')
      throw unsupportedMediaType();
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > INGEST_LIMITS.bodyBytes)
      throw payloadTooLarge();
    if (type === 'application/json') {
      if ((req.rawBody?.length ?? 0) > INGEST_LIMITS.bodyBytes)
        throw payloadTooLarge();
      return true;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of req) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += part.length;
      if (received > INGEST_LIMITS.bodyBytes) throw payloadTooLarge();
      chunks.push(part);
    }
    req.rawBody = Buffer.concat(chunks);
    return true;
  }
}
