import {
  createParamDecorator,
  Injectable,
  PipeTransform,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { DEVICE_ID_PATTERN } from '@marketplace-sandbox/contracts';
import { AppError, ErrorArea, PlatformCodes } from '@app/common/errors';

/** `X-Device-Id`: 4 to 64 of letters, digits, `_` and `-`; anything else is `400 validation_failed` (AS-35). */
@Injectable()
export class DeviceIdPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    if (typeof value === 'string' && DEVICE_ID_PATTERN.test(value))
      return value;
    throw new AppError({
      code: PlatformCodes.validation_failed,
      status: 400,
      title: 'Bad Request',
      detail: 'The request is not valid.',
      area: ErrorArea.DOMAIN,
      extensions: { errors: [{ field: 'X-Device-Id', code: 'invalid' }] },
    });
  }
}

/** The validated `X-Device-Id` of the request (a header parameter cannot take a pipe, so the decorator applies it). */
export const DeviceId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string =>
    new DeviceIdPipe().transform(
      context.switchToHttp().getRequest<Request>().headers['x-device-id'],
    ),
);

/**
 * The rate-limit subject of the device policies: the shop and the device together, so one device cannot spend another
 * shop's budget and a shop with many devices is not throttled as one.
 */
export const deviceSubject = (req: Request): string => {
  const device = req.headers['x-device-id'];
  return `${req.params.shopId}:${typeof device === 'string' ? device : ''}`;
};
