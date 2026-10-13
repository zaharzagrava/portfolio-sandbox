import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { validationFailed } from '../domain/link-errors';

const MIN = 8;
const MAX = 128;

/**
 * `Idempotency-Key` must be present and 8-128 characters, else `400 validation_failed` naming the header (S37 G1,
 * AS-02). It runs before the platform interceptor, which would answer `422` for a header problem; the platform still
 * owns the key's character set.
 */
@Injectable()
export class IdempotencyHeaderGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const raw = context.switchToHttp().getRequest<Request>().headers[
      'idempotency-key'
    ];
    const key = Array.isArray(raw) ? raw[0] : raw;
    if (typeof key !== 'string' || key.length < MIN || key.length > MAX)
      throw validationFailed(['Idempotency-Key']);
    return true;
  }
}
