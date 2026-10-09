import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';

/** 429s carry how long to wait; the controller turns it into a Retry-After header. */
export abstract class AssistantRetryLaterError extends AppError {
  constructor(
    detail: string,
    title: string,
    readonly retryAfterMs: number,
  ) {
    super({
      detail,
      title,
      status: HttpStatus.TOO_MANY_REQUESTS,
      area: ErrorArea.DOMAIN,
    });
  }
}

export class Domain_AssistantQuotaExceeded extends AssistantRetryLaterError {
  constructor(retryAfterMs: number) {
    super(
      'Monthly assistant allowance used up',
      'Assistant quota exceeded',
      retryAfterMs,
    );
  }
}

export class Domain_AssistantBusy extends AssistantRetryLaterError {
  constructor(retryAfterMs: number) {
    super(
      'The assistant is busy, try again shortly',
      'Assistant busy',
      retryAfterMs,
    );
  }
}

export class Domain_AssistantTurnInProgress extends AppError {
  constructor() {
    super({
      detail: 'A reply is still being generated',
      title: 'Turn in progress',
      status: HttpStatus.CONFLICT,
      area: ErrorArea.DOMAIN,
    });
  }
}

export class Domain_ConversationFull extends AppError {
  constructor() {
    super({
      detail: 'This conversation is full - start a new one',
      title: 'Conversation full',
      status: HttpStatus.CONFLICT,
      area: ErrorArea.DOMAIN,
    });
  }
}
