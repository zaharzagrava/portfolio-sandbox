import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';
import type { ProblemCatalogEntry } from '@app/common/errors';

/**
 * Problem codes of the booking half of `launch-events` (S22 FR-051). Every error of the capability is a
 * `LaunchEventError`; the platform filter renders the problem document. Titles and details are fixed text: no value,
 * store error, token or ticket is part of one, and 5xx details are generic (AS-59).
 */
const DEFINITIONS = {
  ADMISSION_REQUIRED: [
    HttpStatus.FORBIDDEN,
    'Forbidden',
    'A valid admission token for this event is required.',
  ],
  HUMAN_CHECK_FAILED: [
    HttpStatus.FORBIDDEN,
    'Forbidden',
    'The human check was missing, invalid or already used.',
  ],
  EVENT_NOT_FOUND: [
    HttpStatus.NOT_FOUND,
    'Not found',
    'Launch event not found.',
  ],
  TICKET_NOT_FOUND: [HttpStatus.NOT_FOUND, 'Not found', 'Ticket not found.'],
  HOLD_NOT_FOUND: [HttpStatus.NOT_FOUND, 'Not found', 'Hold not found.'],
  EVENT_NOT_ON_SALE: [
    HttpStatus.CONFLICT,
    'Conflict',
    'The event is not on sale yet.',
  ],
  EVENT_SOLD_OUT: [HttpStatus.CONFLICT, 'Conflict', 'The event is sold out.'],
  EVENT_CLOSED: [HttpStatus.CONFLICT, 'Conflict', 'The event is closed.'],
  EVENT_ALREADY_CLOSED: [
    HttpStatus.CONFLICT,
    'Conflict',
    'The event is already closed.',
  ],
  SEAT_TAKEN: [HttpStatus.CONFLICT, 'Conflict', 'The seat is already taken.'],
  NO_SEATS_AVAILABLE: [
    HttpStatus.CONFLICT,
    'Conflict',
    'Not enough seats are available.',
  ],
  HOLD_EXPIRED: [HttpStatus.CONFLICT, 'Conflict', 'The hold has expired.'],
  HOLD_RELEASED: [HttpStatus.CONFLICT, 'Conflict', 'The hold was released.'],
  HOLD_ALREADY_CONFIRMED: [
    HttpStatus.CONFLICT,
    'Conflict',
    'The hold is already confirmed.',
  ],
  UNKNOWN_SEAT: [
    HttpStatus.UNPROCESSABLE_ENTITY,
    'Unprocessable Entity',
    'The seat does not exist in this event.',
  ],
  SEATS_NOT_SELECTABLE: [
    HttpStatus.UNPROCESSABLE_ENTITY,
    'Unprocessable Entity',
    'Seats cannot be chosen in a general-admission event.',
  ],
  TICKET_LIMIT_EXCEEDED: [
    HttpStatus.UNPROCESSABLE_ENTITY,
    'Unprocessable Entity',
    'The per-person ticket limit of this event would be exceeded.',
  ],
  invalid_schedule: [
    HttpStatus.UNPROCESSABLE_ENTITY,
    'Unprocessable Entity',
    'The sales and start times are not a valid schedule.',
  ],
  WAITING_ROOM_FULL: [
    HttpStatus.SERVICE_UNAVAILABLE,
    'Service Unavailable',
    'The waiting room is full. Retry shortly.',
  ],
  WAITING_ROOM_UNAVAILABLE: [
    HttpStatus.SERVICE_UNAVAILABLE,
    'Service Unavailable',
    'The waiting room is temporarily unavailable. Retry shortly.',
  ],
  HOLDS_UNAVAILABLE: [
    HttpStatus.SERVICE_UNAVAILABLE,
    'Service Unavailable',
    'Seat holds are temporarily unavailable. Retry shortly.',
  ],
} as const;

export type LaunchEventProblemCode = keyof typeof DEFINITIONS;
export const LAUNCH_EVENT_ERROR_CODES = Object.keys(
  DEFINITIONS,
) as LaunchEventProblemCode[];

export class LaunchEventError extends AppError {
  constructor(
    readonly launchCode: LaunchEventProblemCode,
    options: {
      extensions?: Record<string, unknown>;
      retryAfterSeconds?: number;
    } = {},
  ) {
    const [status, title, detail] = DEFINITIONS[launchCode];
    super({
      status,
      code: launchCode,
      title,
      detail,
      area:
        options.retryAfterSeconds !== undefined
          ? ErrorArea.TRANSIENT
          : ErrorArea.DOMAIN,
      extensions: options.extensions,
      retryAfterSeconds: options.retryAfterSeconds,
      // AS-25: a hold that lost the seat replays the same 409 under the same key.
      idempotencyFinal: launchCode === 'SEAT_TAKEN' ? true : undefined,
    });
  }
}

export const LAUNCH_EVENT_PROBLEMS: ProblemCatalogEntry[] =
  LAUNCH_EVENT_ERROR_CODES.map((code) => ({
    code,
    status: DEFINITIONS[code][0],
    title: DEFINITIONS[code][1],
    detail: DEFINITIONS[code][2],
    owner: 'launch-events',
  }));

/** The platform's field error shape (`errors: [{field, code}]`); the code is fixed text, never the submitted value. */
export interface FieldIssue {
  field: string;
  code: string;
}

/** `400 validation_failed` (a platform code, so it is not registered here). */
export const validationFailed = (errors: FieldIssue[]) =>
  new AppError({
    code: 'validation_failed',
    status: HttpStatus.BAD_REQUEST,
    title: 'Bad Request',
    detail: 'The request is not valid.',
    area: ErrorArea.DOMAIN,
    extensions: { errors },
  });

export const admissionRequired = () =>
  new LaunchEventError('ADMISSION_REQUIRED');
export const humanCheckFailed = () =>
  new LaunchEventError('HUMAN_CHECK_FAILED');
export const eventNotFound = () => new LaunchEventError('EVENT_NOT_FOUND');
export const ticketNotFound = () => new LaunchEventError('TICKET_NOT_FOUND');
export const holdNotFound = () => new LaunchEventError('HOLD_NOT_FOUND');
export const eventNotOnSale = () => new LaunchEventError('EVENT_NOT_ON_SALE');
export const eventSoldOut = () => new LaunchEventError('EVENT_SOLD_OUT');
export const eventClosed = () => new LaunchEventError('EVENT_CLOSED');
export const eventAlreadyClosed = () =>
  new LaunchEventError('EVENT_ALREADY_CLOSED');
export const seatTaken = (seat?: number) =>
  new LaunchEventError('SEAT_TAKEN', {
    extensions: seat === undefined ? undefined : { seat },
  });
export const noSeatsAvailable = () =>
  new LaunchEventError('NO_SEATS_AVAILABLE');
export const holdExpired = () => new LaunchEventError('HOLD_EXPIRED');
export const holdReleased = () => new LaunchEventError('HOLD_RELEASED');
export const holdAlreadyConfirmed = () =>
  new LaunchEventError('HOLD_ALREADY_CONFIRMED');
export const unknownSeat = (seat: number) =>
  new LaunchEventError('UNKNOWN_SEAT', { extensions: { seat } });
export const seatsNotSelectable = () =>
  new LaunchEventError('SEATS_NOT_SELECTABLE');
export const ticketLimitExceeded = (limit: number, remaining: number) =>
  new LaunchEventError('TICKET_LIMIT_EXCEEDED', {
    extensions: { limit, remaining },
  });
export const invalidSchedule = () => new LaunchEventError('invalid_schedule');
export const waitingRoomFull = () =>
  new LaunchEventError('WAITING_ROOM_FULL', { retryAfterSeconds: 5 });
export const waitingRoomUnavailable = () =>
  new LaunchEventError('WAITING_ROOM_UNAVAILABLE', { retryAfterSeconds: 2 });
export const holdsUnavailable = () =>
  new LaunchEventError('HOLDS_UNAVAILABLE', { retryAfterSeconds: 2 });
