import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';

/**
 * Problem responses of the shopping assistant (contracts/http-api.md). Each carries a stable `code`; `Retry-After`
 * comes from `retryAfterSeconds`. Details are generic: no user text, no provider message.
 */

const seconds = (ms: number) => Math.max(1, Math.ceil(ms / 1000));

export class Domain_ConversationNotFound extends AppError {
  constructor() {
    super({
      code: 'not_found',
      status: HttpStatus.NOT_FOUND,
      title: 'Not Found',
      detail: 'Not found.',
      area: ErrorArea.DOMAIN,
    });
  }
}

export class Domain_GenerationNotFound extends AppError {
  constructor() {
    super({
      code: 'generation_not_found',
      status: HttpStatus.NOT_FOUND,
      title: 'Not Found',
      detail: 'Generation not found or expired.',
      area: ErrorArea.DOMAIN,
    });
  }
}

export class Domain_GenerationFinished extends AppError {
  constructor() {
    super({
      code: 'generation_finished',
      status: HttpStatus.CONFLICT,
      title: 'Conflict',
      detail: 'The reply has already finished.',
      area: ErrorArea.DOMAIN,
    });
  }
}

export class Domain_InvalidLastEventId extends AppError {
  constructor() {
    super({
      code: 'invalid_last_event_id',
      status: HttpStatus.BAD_REQUEST,
      title: 'Bad Request',
      detail: 'Last-Event-ID is not a stream id.',
      area: ErrorArea.DOMAIN,
    });
  }
}

export class Domain_InvalidCursor extends AppError {
  constructor() {
    super({
      code: 'invalid_cursor',
      status: HttpStatus.BAD_REQUEST,
      title: 'Bad Request',
      detail: 'The cursor is not valid.',
      area: ErrorArea.DOMAIN,
    });
  }
}

export class Domain_TurnInProgress extends AppError {
  constructor() {
    super({
      code: 'turn_in_progress',
      status: HttpStatus.CONFLICT,
      title: 'Conflict',
      detail: 'A reply is still being generated.',
      area: ErrorArea.DOMAIN,
    });
  }
}

export class Domain_ConversationFull extends AppError {
  constructor() {
    super({
      code: 'conversation_full',
      status: HttpStatus.CONFLICT,
      title: 'Conflict',
      detail: 'This conversation is full; start a new one.',
      area: ErrorArea.DOMAIN,
    });
  }
}

export class Domain_IdempotencyInFlight extends AppError {
  constructor(messageId: string) {
    super({
      code: 'idempotency_in_flight',
      status: HttpStatus.CONFLICT,
      title: 'Conflict',
      detail: 'A send with this key is still being answered.',
      area: ErrorArea.DOMAIN,
      extensions: { messageId },
    });
  }
}

export class Domain_IdempotencyKeyRequired extends AppError {
  constructor() {
    super({
      code: 'idempotency_key_required',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      title: 'Unprocessable Entity',
      detail: 'The Idempotency-Key header is required.',
      area: ErrorArea.DOMAIN,
    });
  }
}

export class Domain_IdempotencyKeyReuse extends AppError {
  constructor() {
    super({
      code: 'idempotency_key_reuse',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      title: 'Unprocessable Entity',
      detail: 'This Idempotency-Key was used with a different request.',
      area: ErrorArea.DOMAIN,
    });
  }
}

export class Domain_InputRejected extends AppError {
  constructor(category: string) {
    super({
      code: 'input_rejected',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      title: 'Unprocessable Entity',
      detail: 'The message cannot be sent.',
      area: ErrorArea.DOMAIN,
      extensions: { category },
    });
  }
}

export class Domain_QuotaExceeded extends AppError {
  constructor(
    retryAfterSecondsValue: number,
    used: number,
    limit: number,
    resetsAt: string,
  ) {
    super({
      code: 'quota_exceeded',
      status: HttpStatus.TOO_MANY_REQUESTS,
      title: 'Too Many Requests',
      detail: 'The monthly assistant allowance is used up.',
      area: ErrorArea.DOMAIN,
      retryAfterSeconds: retryAfterSecondsValue,
      extensions: { used, limit, resetsAt },
    });
  }
}

export class Domain_AssistantBusy extends AppError {
  constructor(retryAfterMs: number) {
    super({
      code: 'assistant_busy',
      status: HttpStatus.TOO_MANY_REQUESTS,
      title: 'Too Many Requests',
      detail: 'The assistant is busy, try again shortly.',
      area: ErrorArea.DOMAIN,
      retryAfterSeconds: seconds(retryAfterMs),
    });
  }
}

export class Domain_TooManyActiveTurns extends AppError {
  constructor(retryAfterMs = 5_000) {
    super({
      code: 'too_many_active_turns',
      status: HttpStatus.TOO_MANY_REQUESTS,
      title: 'Too Many Requests',
      detail: 'Too many replies are being written at once.',
      area: ErrorArea.DOMAIN,
      retryAfterSeconds: seconds(retryAfterMs),
    });
  }
}

/** The assistant cannot take the message now (fail closed); `reason` feeds the admission metric only. */
export class Transient_AssistantUnavailable extends AppError {
  constructor(
    readonly reason: string,
    retryAfterMs = 5_000,
  ) {
    super({
      code: 'assistant_unavailable',
      status: HttpStatus.SERVICE_UNAVAILABLE,
      title: 'Service Unavailable',
      detail: 'The assistant is temporarily unavailable.',
      area: ErrorArea.TRANSIENT,
      retryAfterSeconds: seconds(retryAfterMs),
    });
  }
}

/** The moderation backend could not answer (fail closed). */
export class ModerationUnavailableError extends Error {
  constructor() {
    super('moderation unavailable');
    this.name = 'ModerationUnavailableError';
  }
}
