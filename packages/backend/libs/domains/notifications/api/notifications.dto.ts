import { Injectable, PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import {
  deviceIdParamSchema,
  listNotificationsQuerySchema,
  markReadRequestSchema,
  phoneVerifyRequestSchema,
  registerDeviceRequestSchema,
  unsubscribeQuerySchema,
  updatePreferenceRequestSchema,
  updateSettingsRequestSchema,
} from '@marketplace-sandbox/contracts';
import { AppError, ErrorArea, PlatformCodes } from '@app/common/errors';
import { invalidUnsubscribeToken } from '../domain/errors';

/** Parses a body, query or path value with a contract schema; failures are `400 validation_failed` without echoed values. */
@Injectable()
export class ZodPipe<S extends z.ZodType> implements PipeTransform<
  unknown,
  z.output<S>
> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    const parsed = this.schema.safeParse(value);
    if (parsed.success) return parsed.data;
    throw new AppError({
      code: PlatformCodes.validation_failed,
      status: 400,
      title: 'Bad Request',
      detail: 'The request is not valid.',
      area: ErrorArea.DOMAIN,
      extensions: {
        errors: parsed.error.issues.slice(0, 20).map((issue) => ({
          field: issue.path.join('.') || 'value',
          code: issue.code,
        })),
      },
    });
  }
}

/** The token of an unsubscribe link: anything unusable is the one `invalid_unsubscribe_token`, never a format error. */
export class UnsubscribeTokenPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    const parsed = unsubscribeQuerySchema.safeParse({ token: value });
    if (!parsed.success) throw invalidUnsubscribeToken();
    return parsed.data.token;
  }
}

export const listNotificationsQuery = new ZodPipe(listNotificationsQuerySchema);
export const markReadBody = new ZodPipe(markReadRequestSchema);
export const updatePreferenceBody = new ZodPipe(updatePreferenceRequestSchema);
export const updateSettingsBody = new ZodPipe(updateSettingsRequestSchema);
export const phoneVerifyBody = new ZodPipe(phoneVerifyRequestSchema);
export const registerDeviceBody = new ZodPipe(registerDeviceRequestSchema);
export const deviceIdParam = new ZodPipe(deviceIdParamSchema);
