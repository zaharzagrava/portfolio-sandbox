import {
  applyDecorators,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
  UseInterceptors,
} from '@nestjs/common';

export const SENSITIVE_PATH_PARAMS_KEY = 'sensitivePathParams';
/** Request property the filter reads: names of path params whose values must not appear in `instance` or logs. */
export const SENSITIVE_PATH_PARAMS_REQUEST_KEY = 'sensitivePathParams';

@Injectable()
class SensitivePathParamsInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const names = Reflect.getMetadata(
      SENSITIVE_PATH_PARAMS_KEY,
      context.getHandler(),
    ) as string[] | undefined;
    context.switchToHttp().getRequest()[SENSITIVE_PATH_PARAMS_REQUEST_KEY] =
      names ?? [];
    return next.handle();
  }
}

/** Path params whose values must not reach `instance` or logs: the filter substitutes the route template. */
export const SensitivePathParams = (...names: string[]) =>
  applyDecorators(
    SetMetadata(SENSITIVE_PATH_PARAMS_KEY, names),
    UseInterceptors(SensitivePathParamsInterceptor),
  );
