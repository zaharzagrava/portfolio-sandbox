import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ParseUUIDPipe,
} from '@nestjs/common';
import { validationFailed } from '../domain/media-errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A malformed `:shopId` / `:productId` is `400 validation_failed` before anything is looked up (AS-32). It runs ahead
 * of the shop guard, which would otherwise answer a malformed shop id with the hidden `404` of an unknown shop.
 */
@Injectable()
export class PathIdsGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const params = ctx
      .switchToHttp()
      .getRequest<{ params: Record<string, string> }>().params;
    const bad = ['shopId', 'productId', 'id'].filter(
      (name) => params[name] !== undefined && !UUID.test(params[name]),
    );
    if (bad.length > 0) throw validationFailed(bad);
    return true;
  }
}

/** `@Param('id', uuidPipe)`: the same `400 validation_failed` for a malformed id. */
export const uuidPipe = (field: string) =>
  new ParseUUIDPipe({ exceptionFactory: () => validationFailed([field]) });
