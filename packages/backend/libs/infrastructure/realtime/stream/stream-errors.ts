import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';

/**
 * Refusals that happen before the stream starts (S51 FR-007): RFC 9457 problems with the codes of the contract.
 * 5xx details are generic; 403 never names the topic.
 */
const refusal = (
  status: HttpStatus,
  code: string,
  title: string,
  detail: string,
  area: ErrorArea,
  retryAfterSeconds?: number,
) => ({ status, code, title, detail, area, retryAfterSeconds });

export class StreamInvalidTopicsError extends AppError {
  constructor() {
    super(
      refusal(
        HttpStatus.BAD_REQUEST,
        'invalid_topics',
        'Bad Request',
        'topics must list 1 to 10 distinct, valid, known topics.',
        ErrorArea.DOMAIN,
      ),
    );
  }
}

export class StreamInvalidQueryError extends AppError {
  constructor() {
    super(
      refusal(
        HttpStatus.BAD_REQUEST,
        'invalid_query',
        'Bad Request',
        'Only the topics query parameter is accepted. Send credentials in a header or cookie.',
        ErrorArea.DOMAIN,
      ),
    );
  }
}

export class StreamUnauthenticatedError extends AppError {
  constructor() {
    super({
      ...refusal(
        HttpStatus.UNAUTHORIZED,
        'unauthenticated',
        'Unauthorized',
        'Authentication is required for this stream.',
        ErrorArea.DOMAIN,
      ),
      headers: { 'WWW-Authenticate': 'Bearer' },
    });
  }
}

export class StreamForbiddenError extends AppError {
  constructor() {
    super(
      refusal(
        HttpStatus.FORBIDDEN,
        'forbidden',
        'Forbidden',
        'You may not listen to one of the requested topics.',
        ErrorArea.DOMAIN,
      ),
    );
  }
}

export class StreamTooManyConnectionsError extends AppError {
  constructor() {
    super(
      refusal(
        HttpStatus.TOO_MANY_REQUESTS,
        'too_many_connections',
        'Too Many Requests',
        'Too many open streams. Close one or retry shortly.',
        ErrorArea.DOMAIN,
        5,
      ),
    );
  }
}

export class StreamPolicyUnavailableError extends AppError {
  constructor() {
    super(
      refusal(
        HttpStatus.SERVICE_UNAVAILABLE,
        'realtime_policy_unavailable',
        'Service Unavailable',
        'The stream could not be authorized right now. Retry shortly.',
        ErrorArea.TRANSIENT,
        2,
      ),
    );
  }
}

export class StreamCapacityError extends AppError {
  constructor(retryAfterSeconds: number) {
    super(
      refusal(
        HttpStatus.SERVICE_UNAVAILABLE,
        'realtime_capacity',
        'Service Unavailable',
        'This instance cannot take more streams right now. Retry shortly.',
        ErrorArea.TRANSIENT,
        retryAfterSeconds,
      ),
    );
  }
}

export class StreamUnavailableError extends AppError {
  constructor() {
    super(
      refusal(
        HttpStatus.SERVICE_UNAVAILABLE,
        'realtime_unavailable',
        'Service Unavailable',
        'Live updates are unavailable right now. Retry shortly.',
        ErrorArea.TRANSIENT,
        2,
      ),
    );
  }
}
