import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';
import type { ProblemCatalogEntry } from '@app/common/errors';

/**
 * HTTP-visible errors of billing (specs/domains/S17-subscriptions/contracts/http.md). Each is an `AppError` with a
 * stable problem `code`; none echoes SQL, a store name, a stack or a payment reference. `validation_failed` and
 * `invalid_cursor` carry the platform's wording; the idempotency, rate-limit and shop-access codes come from their
 * own facilities.
 */
type Params = ConstructorParameters<typeof AppError>[0];

const problem = (
  status: HttpStatus,
  code: string,
  title: string,
  detail: string,
  extra: Partial<Params> = {},
): AppError =>
  new AppError({
    status,
    code,
    title,
    detail,
    area: ErrorArea.DOMAIN,
    ...extra,
  });

const conflict = (code: string, detail: string) =>
  problem(HttpStatus.CONFLICT, code, 'Conflict', detail);
const unprocessable = (code: string, detail: string) =>
  problem(
    HttpStatus.UNPROCESSABLE_ENTITY,
    code,
    'Unprocessable Entity',
    detail,
  );
const notFound = (code: string, detail: string) =>
  problem(HttpStatus.NOT_FOUND, code, 'Not found', detail);

export const validationFailed = (fields: string[]) =>
  problem(
    HttpStatus.BAD_REQUEST,
    'validation_failed',
    'Bad Request',
    'The request is not valid.',
    {
      extensions: {
        errors: fields.map((field) => ({ field, code: 'invalid' })),
      },
    },
  );

export const invalidCursor = () =>
  problem(
    HttpStatus.BAD_REQUEST,
    'invalid_cursor',
    'Bad Request',
    'The cursor is not valid for this list.',
  );

export const permissionDenied = () =>
  problem(
    HttpStatus.FORBIDDEN,
    'permission_denied',
    'Forbidden',
    'You do not have permission to do this.',
  );

export const planCodeTaken = () =>
  conflict('plan_code_taken', 'A plan with this code already exists.');
export const planNotFound = () =>
  notFound('plan_not_found', 'The plan does not exist.');
export const priceNotFound = () =>
  notFound('price_not_found', 'The price does not exist or is not available.');
export const priceAlreadyRetired = () =>
  conflict('price_already_retired', 'The price is already retired.');

export const alreadySubscribed = () =>
  conflict('already_subscribed', 'There is already a subscription.');
export const paymentMethodRequired = () =>
  unprocessable(
    'payment_method_required',
    'A payment method is required for this price.',
  );
export const trialNotAvailable = () =>
  unprocessable(
    'trial_not_available',
    'A trial was already used by this account.',
  );
export const planNotAvailableForSubject = () =>
  unprocessable(
    'plan_not_available_for_subject',
    'This plan is not available for this kind of account.',
  );
export const sandboxShopNotBillable = () =>
  unprocessable(
    'sandbox_shop_not_billable',
    'A sandbox shop cannot subscribe to a paid plan.',
  );
export const quantityNotApplicable = () =>
  unprocessable(
    'quantity_not_applicable',
    'The quantity must be 1 for a price that is not per seat.',
  );

export const noActiveSubscription = () =>
  notFound('no_active_subscription', 'There is no active subscription.');
export const subscriptionNotChangeable = () =>
  conflict(
    'subscription_not_changeable',
    'The subscription cannot be changed in its current status.',
  );
export const subscriptionChangedConcurrently = () =>
  conflict(
    'subscription_changed_concurrently',
    'The subscription changed meanwhile. Read it again and retry.',
  );
export const billingIntervalChangeNotSupported = () =>
  unprocessable(
    'billing_interval_change_not_supported',
    'The billing interval cannot change; cancel and subscribe again.',
  );
export const noChangeRequested = () =>
  unprocessable('no_change_requested', 'Nothing would change.');
export const alreadyScheduledForCancellation = () =>
  conflict(
    'already_scheduled_for_cancellation',
    'The subscription already ends at the end of the period.',
  );
export const notScheduledForCancellation = () =>
  conflict(
    'not_scheduled_for_cancellation',
    'The subscription is not scheduled for cancellation.',
  );
export const invoiceNotFound = () =>
  notFound('invoice_not_found', 'The invoice does not exist.');

const entry = (
  code: string,
  status: number,
  title: string,
  detail: string,
): ProblemCatalogEntry => ({ code, status, title, detail, owner: 'billing' });

export const BILLING_PROBLEMS: ProblemCatalogEntry[] = [
  entry(
    'plan_code_taken',
    409,
    'Conflict',
    'A plan with this code already exists.',
  ),
  entry('plan_not_found', 404, 'Not found', 'The plan does not exist.'),
  entry(
    'price_not_found',
    404,
    'Not found',
    'The price does not exist or is not available.',
  ),
  entry(
    'price_already_retired',
    409,
    'Conflict',
    'The price is already retired.',
  ),
  entry(
    'already_subscribed',
    409,
    'Conflict',
    'There is already a subscription.',
  ),
  entry(
    'payment_method_required',
    422,
    'Unprocessable Entity',
    'A payment method is required for this price.',
  ),
  entry(
    'trial_not_available',
    422,
    'Unprocessable Entity',
    'A trial was already used by this account.',
  ),
  entry(
    'plan_not_available_for_subject',
    422,
    'Unprocessable Entity',
    'This plan is not available for this kind of account.',
  ),
  entry(
    'sandbox_shop_not_billable',
    422,
    'Unprocessable Entity',
    'A sandbox shop cannot subscribe to a paid plan.',
  ),
  entry(
    'quantity_not_applicable',
    422,
    'Unprocessable Entity',
    'The quantity must be 1 for a price that is not per seat.',
  ),
  entry(
    'no_active_subscription',
    404,
    'Not found',
    'There is no active subscription.',
  ),
  entry(
    'subscription_not_changeable',
    409,
    'Conflict',
    'The subscription cannot be changed in its current status.',
  ),
  entry(
    'subscription_changed_concurrently',
    409,
    'Conflict',
    'The subscription changed meanwhile. Read it again and retry.',
  ),
  entry(
    'billing_interval_change_not_supported',
    422,
    'Unprocessable Entity',
    'The billing interval cannot change; cancel and subscribe again.',
  ),
  entry(
    'no_change_requested',
    422,
    'Unprocessable Entity',
    'Nothing would change.',
  ),
  entry(
    'already_scheduled_for_cancellation',
    409,
    'Conflict',
    'The subscription already ends at the end of the period.',
  ),
  entry(
    'not_scheduled_for_cancellation',
    409,
    'Conflict',
    'The subscription is not scheduled for cancellation.',
  ),
  entry('invoice_not_found', 404, 'Not found', 'The invoice does not exist.'),
];

// ---- S18: entitlements and usage ---------------------------------------------------------------------------------

/** `403 entitlement_required {feature}`: the shop's plan lacks the feature (S18 FR-008; S21 AS-03 relies on the shape). */
export class Domain_EntitlementRequiredError extends AppError {
  constructor(readonly feature: string) {
    super({
      status: HttpStatus.FORBIDDEN,
      code: 'entitlement_required',
      title: 'Forbidden',
      detail: `Your plan doesn't include "${feature}".`,
      area: ErrorArea.DOMAIN,
      extensions: { feature },
    });
  }
}

const unavailable = (code: string, detail: string) =>
  new AppError({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    code,
    title: 'Service Unavailable',
    detail,
    area: ErrorArea.TRANSIENT,
  });

/** Usage could not be read: the caller decides to fail open or closed (S18 AS-08, AS-44, AS-54). */
export class Domain_UsageUnavailableError extends AppError {
  constructor() {
    super({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'usage_unavailable',
      title: 'Service Unavailable',
      detail: 'Usage could not be read.',
      area: ErrorArea.TRANSIENT,
    });
  }
}

export const entitlementsUnavailable = () =>
  unavailable(
    'entitlements_unavailable',
    'Entitlements could not be determined.',
  );
export const entitlementInvalidationFailed = () =>
  unavailable(
    'entitlement_invalidation_failed',
    'The entitlement cache could not be invalidated.',
  );
export const unknownEntitlement = (key: string) =>
  problem(
    HttpStatus.BAD_REQUEST,
    'unknown_entitlement',
    'Bad Request',
    `"${String(key).slice(0, 64)}" is not an entitlement.`,
  );
export const tooManyIds = () =>
  problem(
    HttpStatus.BAD_REQUEST,
    'too_many_ids',
    'Bad Request',
    'At most 500 subjects can be read at once.',
  );
export const notALimit = (key: string) =>
  problem(
    HttpStatus.BAD_REQUEST,
    'not_a_limit',
    'Bad Request',
    `"${String(key).slice(0, 64)}" is not a count limit.`,
  );
export const notAQuota = (key: string) =>
  problem(
    HttpStatus.BAD_REQUEST,
    'not_a_quota',
    'Bad Request',
    `"${String(key).slice(0, 64)}" is not a monthly quota.`,
  );
export const invalidCurrentValue = () =>
  problem(
    HttpStatus.BAD_REQUEST,
    'invalid_current_value',
    'Bad Request',
    'The current value must be a non-negative integer.',
  );
export const invalidInput = (detail = 'The input is not valid.') =>
  problem(HttpStatus.BAD_REQUEST, 'invalid_input', 'Bad Request', detail);
export const amountOutOfRange = () =>
  problem(
    HttpStatus.BAD_REQUEST,
    'amount_out_of_range',
    'Bad Request',
    'The amount is outside the supported range.',
  );
export const settlementConflict = () =>
  conflict(
    'settlement_conflict',
    'The usage settlement changed meanwhile. Measure again.',
  );

export const USAGE_PROBLEMS: ProblemCatalogEntry[] = [
  entry(
    'entitlement_required',
    403,
    'Forbidden',
    'Your plan does not include this feature.',
  ),
  entry(
    'entitlements_unavailable',
    503,
    'Service Unavailable',
    'Entitlements could not be determined.',
  ),
  entry(
    'entitlement_invalidation_failed',
    503,
    'Service Unavailable',
    'The entitlement cache could not be invalidated.',
  ),
  entry(
    'usage_unavailable',
    503,
    'Service Unavailable',
    'Usage could not be read.',
  ),
  entry('unknown_entitlement', 400, 'Bad Request', 'Not an entitlement.'),
  // `too_many_ids` and `amount_out_of_range` are not registered: orders and payments already own those codes with other
  // wording and status, and the catalog refuses two definitions of one code. Billing raises them with its own text.
  entry('not_a_limit', 400, 'Bad Request', 'Not a count limit.'),
  entry('not_a_quota', 400, 'Bad Request', 'Not a monthly quota.'),
  entry('invalid_current_value', 400, 'Bad Request', 'Invalid current value.'),
  entry('invalid_input', 400, 'Bad Request', 'The input is not valid.'),
  entry(
    'settlement_conflict',
    409,
    'Conflict',
    'The usage settlement changed meanwhile.',
  ),
];
