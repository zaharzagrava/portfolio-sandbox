/** A period id that is not a real ISO week / calendar month of the requested kind. */
export class InvalidPeriodError extends Error {
  readonly code = 'invalid_period';
  constructor(readonly periodId: string) {
    super(`invalid period ${periodId}`);
    this.name = 'InvalidPeriodError';
  }
}

/** The requested period starts after the current one. */
export class PeriodInFutureError extends Error {
  constructor(readonly periodId: string) {
    super(`period ${periodId} is in the future`);
    this.name = 'PeriodInFutureError';
  }
}

/** A shop's revenue in a period would pass 2^33 - 1 minor units (the ranking key's exact range). */
export class RevenueLimitExceededError extends Error {
  constructor(readonly revenueMinor: number) {
    super(`revenue ${revenueMinor} passes the ranking key limit`);
    this.name = 'RevenueLimitExceededError';
  }
}

/** The board store (Redis) could not answer within its timeout. */
export class BoardStoreUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('board store unavailable', { cause });
    this.name = 'BoardStoreUnavailableError';
  }
}

/** The analytics store (ClickHouse) could not answer within its timeout. */
export class AnalyticsStoreUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('analytics store unavailable', { cause });
    this.name = 'AnalyticsStoreUnavailableError';
  }
}

/** A snapshot was requested for a period that is not closed (before end + 1 h), future, or whose id is malformed. */
export class PeriodNotClosedError extends Error {
  readonly code = 'period_not_closed';
  constructor(readonly periodId: string) {
    super(`period ${periodId} is not closed`);
    this.name = 'PeriodNotClosedError';
  }
}

/** Why a message was dead-lettered; the consumers throw `PermanentError` carrying one of these codes. */
export type DeadLetterReason =
  | 'invalid_payload'
  | 'unsupported_version'
  | 'unsupported_currency'
  | 'revenue_limit_exceeded'
  | 'partial_refund_unsupported'
  | 'refund_without_sale';
