import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ApiError } from '../domain/errors';

/** Media ranges that include what this API produces (`application/json`, `application/problem+json`). */
const ACCEPTS_JSON =
  /^(\*\/\*|application\/\*|application\/(problem\+)?json|[a-z]+\/[a-z.+-]*\+json)$/i;

export const acceptsJson = (accept: string | undefined): boolean => {
  if (!accept || accept.trim() === '') return true;
  return accept.split(',').some((part) => {
    const [range, ...params] = part.split(';').map((s) => s.trim());
    const q = params.find((p) => /^q=/i.test(p));
    if (q && Number(q.slice(2)) === 0) return false;
    return ACCEPTS_JSON.test(range);
  });
};

/**
 * What a call may send and ask for (FR-060, AS-66), after the key is known so a refusal is logged against it: an `Accept`
 * that excludes JSON is `406 not_acceptable`, a body that is not `application/json` is `415 unsupported_media_type`.
 * Neither reaches a handler.
 */
@Injectable()
export class ContentGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!acceptsJson(req.headers.accept))
      throw new ApiError(
        'not_acceptable',
        'This API only produces application/json.',
      );
    const length = req.headers['content-length'];
    const hasBody =
      (length !== undefined && length !== '0') ||
      req.headers['transfer-encoding'] !== undefined;
    if (
      hasBody &&
      ['POST', 'PATCH', 'PUT'].includes(req.method) &&
      !/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')
    )
      throw new ApiError(
        'unsupported_media_type',
        'The body must be application/json.',
      );
    return true;
  }
}
