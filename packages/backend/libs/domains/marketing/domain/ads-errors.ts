import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';
import type { ProblemCatalogEntry } from '@app/common/errors';
import {
  AD_PROBLEM_CODES,
  type AdAction,
  type AdProblemCode,
} from '@marketplace-sandbox/contracts';

/**
 * HTTP-visible errors of sponsored listings (specs/domains/S36-sponsored-listings/contracts/ads-api.md). Each is an
 * `AppError` with a stable problem `code`; none echoes a store name, a SQL fragment or a stack (AS-78). Codes that the
 * platform owns (`validation_failed`, `invalid_cursor`, `unauthenticated`, `permission_denied`, `rate_limited`,
 * `rate_limiter_unavailable`, `service_unavailable`) are raised with the platform's wording and not registered again.
 */
type Params = ConstructorParameters<typeof AppError>[0];

interface Definition {
  status: HttpStatus;
  title: string;
  detail: string;
}

const DEFINITIONS: Record<AdProblemCode, Definition> = {
  validation_failed: {
    status: HttpStatus.BAD_REQUEST,
    title: 'Bad Request',
    detail: 'The request is not valid.',
  },
  invalid_cursor: {
    status: HttpStatus.BAD_REQUEST,
    title: 'Bad Request',
    detail: 'The cursor is not valid for this list.',
  },
  invalid_token: {
    status: HttpStatus.UNAUTHORIZED,
    title: 'Unauthorized',
    detail: 'Authentication is required.',
  },
  permission_denied: {
    status: HttpStatus.FORBIDDEN,
    title: 'Forbidden',
    detail: 'You do not have permission to do this.',
  },
  shop_not_found: {
    status: HttpStatus.NOT_FOUND,
    title: 'Not Found',
    detail: 'There is no such shop.',
  },
  product_not_found: {
    status: HttpStatus.NOT_FOUND,
    title: 'Not Found',
    detail: 'There is no such product.',
  },
  campaign_not_found: {
    status: HttpStatus.NOT_FOUND,
    title: 'Not Found',
    detail: 'There is no such campaign.',
  },
  campaign_already_exists: {
    status: HttpStatus.CONFLICT,
    title: 'Conflict',
    detail: 'This product already has a campaign that has not ended.',
  },
  invalid_transition: {
    status: HttpStatus.CONFLICT,
    title: 'Conflict',
    detail: 'The campaign cannot make this change in its current state.',
  },
  product_unavailable: {
    status: HttpStatus.CONFLICT,
    title: 'Conflict',
    detail: 'The product is not available, so the campaign cannot run.',
  },
  shop_inactive: {
    status: HttpStatus.CONFLICT,
    title: 'Conflict',
    detail: 'The shop is not active, so the campaign cannot run.',
  },
  budget_below_cpc: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unprocessable Entity',
    detail: 'The daily budget must be at least the price per click.',
  },
  campaign_limit_reached: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unprocessable Entity',
    detail: 'The shop has reached the number of campaigns it may run.',
  },
  product_not_sponsorable: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unprocessable Entity',
    detail: 'This product cannot be sponsored.',
  },
  rate_limited: {
    status: HttpStatus.TOO_MANY_REQUESTS,
    title: 'Too Many Requests',
    detail: 'Too many requests. Retry shortly.',
  },
  rate_limiter_unavailable: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    title: 'Service Unavailable',
    detail: 'The request could not be checked. Retry shortly.',
  },
  service_unavailable: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    title: 'Service Unavailable',
    detail: 'Sponsored listings are temporarily unavailable. Retry shortly.',
  },
};

export const ADS_RETRY_AFTER_SECONDS = 5;

export class AdsError extends AppError {
  constructor(
    readonly adsCode: AdProblemCode,
    extra: Partial<Params> = {},
  ) {
    const d = DEFINITIONS[adsCode];
    super({
      status: d.status,
      code: adsCode,
      title: d.title,
      detail: d.detail,
      area: ErrorArea.DOMAIN,
      ...extra,
    });
  }
}

export const shopNotFound = () => new AdsError('shop_not_found');
export const productNotFound = () => new AdsError('product_not_found');
export const campaignNotFound = () => new AdsError('campaign_not_found');
export const campaignAlreadyExists = () =>
  new AdsError('campaign_already_exists');
export const budgetBelowCpc = () =>
  new AdsError('budget_below_cpc', {
    extensions: {
      errors: [{ field: 'dailyBudgetMinor', code: 'budget_below_cpc' }],
    },
  });
export const campaignLimitReached = () =>
  new AdsError('campaign_limit_reached');
export const productNotSponsorable = () =>
  new AdsError('product_not_sponsorable');
export const invalidCursor = () => new AdsError('invalid_cursor');
export const productUnavailable = () => new AdsError('product_unavailable');
export const shopInactive = () => new AdsError('shop_inactive');
export const serviceUnavailable = () =>
  new AdsError('service_unavailable', {
    retryAfterSeconds: ADS_RETRY_AFTER_SECONDS,
  });

/** Names the current state and the refused action, never a value of the campaign (AS-09). */
export const invalidTransition = (from: string, action: AdAction) =>
  new AdsError('invalid_transition', {
    extensions: { from, action },
  });

/** A field-level validation failure: platform `validation_failed` with the offending fields (never their values). */
export const validationFailed = (fields: string[]) =>
  new AppError({
    status: HttpStatus.BAD_REQUEST,
    code: 'validation_failed',
    title: 'Bad Request',
    detail: 'The request is not valid.',
    area: ErrorArea.DOMAIN,
    extensions: {
      errors: fields.map((field) => ({ field, code: 'invalid' })),
    },
  });

/** Registered by the platform or by other capabilities; not registered again here. */
const NOT_OWNED: AdProblemCode[] = [
  'validation_failed',
  'invalid_cursor',
  'invalid_token',
  'permission_denied',
  'rate_limited',
  'rate_limiter_unavailable',
  // also raised by S25, S19 and S37 with their own wording; whoever registers it first owns the catalog entry
  'service_unavailable',
  // shared names that S03, S05, S10, S29, S30 and S32 register first with their own wording
  'shop_not_found',
  'product_not_found',
  'invalid_transition',
  'product_unavailable',
];

export const ADS_PROBLEMS: ProblemCatalogEntry[] = AD_PROBLEM_CODES.filter(
  (code) => !NOT_OWNED.includes(code),
).map((code) => ({
  code,
  status: DEFINITIONS[code].status,
  title: DEFINITIONS[code].title,
  detail: DEFINITIONS[code].detail,
  owner: 'marketing',
}));
