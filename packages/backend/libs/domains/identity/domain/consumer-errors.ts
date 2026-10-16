import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';

/** Consumer operator routes (S53): an unknown group answers like a missing resource. */
export class Domain_ConsumerNotFoundError extends AppError {
  constructor() {
    super({
      status: HttpStatus.NOT_FOUND,
      code: 'consumer_not_found',
      title: 'Not Found',
      detail: 'No such consumer group.',
      area: ErrorArea.DOMAIN,
    });
  }
}

/** A field of a consumer route body that is malformed or out of range (field name and reason, never the value). */
export class Domain_ConsumerRequestInvalidError extends AppError {
  constructor(field: string, code: string) {
    super({
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      code: 'validation_failed',
      title: 'Unprocessable Entity',
      detail: 'The request is not valid.',
      area: ErrorArea.DOMAIN,
      extensions: { errors: [{ field, code }] },
    });
  }
}

export class Domain_ConsumerNotReplayableError extends AppError {
  constructor() {
    super({
      status: HttpStatus.CONFLICT,
      code: 'consumer_not_replayable',
      title: 'Conflict',
      detail: 'This consumer has side effects and cannot be replayed from here.',
      area: ErrorArea.DOMAIN,
    });
  }
}
