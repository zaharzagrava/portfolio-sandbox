import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { Domain_UnsupportedMediaTypeError } from '../../domain/errors';

/**
 * State-changing auth endpoints accept only `application/json` bodies (S01 FR-053). A request without a body passes;
 * one that carries a body in any other type is 415, so a form post or `text/plain` never reaches the handler.
 */
@Injectable()
export class JsonOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const hasBody =
      Number(req.headers['content-length'] ?? 0) > 0 ||
      req.headers['transfer-encoding'] !== undefined;
    if (!hasBody) return true;
    const type = String(req.headers['content-type'] ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (type !== 'application/json')
      throw new Domain_UnsupportedMediaTypeError();
    return true;
  }
}
