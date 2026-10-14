import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ApiError } from '../domain/errors';

/**
 * State-changing widget bodies are `application/json` only (FR-031, AS-31): a cross-site HTML form can send nothing
 * else without a preflight, so anything other is refused before anything is evaluated.
 */
@Injectable()
export class JsonOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (!req.is('application/json'))
      throw new ApiError(
        'unsupported_media_type',
        'The body must be application/json.',
      );
    return true;
  }
}
