import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { FLAG_LIMITS } from '@marketplace-sandbox/contracts';
import { payloadTooLarge } from '../domain/flag-errors';

interface SizedRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody?: Buffer;
}

/**
 * A flag body above 256 KiB is `413` before any validation runs (AS-09, R-18): guards run before pipes, so the oversized
 * definition is never walked. The platform parser already bounds every body at 1 MiB; this narrows it for this route.
 */
@Injectable()
export class BodySizeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<SizedRequest>();
    const declared = Number(req.headers['content-length']);
    const received = req.rawBody?.length ?? 0;
    if (
      (Number.isFinite(declared) && declared > FLAG_LIMITS.bodyBytes) ||
      received > FLAG_LIMITS.bodyBytes
    )
      throw payloadTooLarge();
    return true;
  }
}
