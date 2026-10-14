import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';
import type { ProblemCatalogEntry } from '@app/common/errors';

/**
 * Problem codes of S24 (contracts/http.md). One definition per stable snake_case `code`; the platform exception filter
 * renders problem+json from `AppError`, so controllers never branch on errors (II.1). A channel the caller cannot
 * read answers the same `404 channel_not_found` as a missing one, so existence cannot be probed (BOLA).
 */
const NOT_FOUND = { status: HttpStatus.NOT_FOUND, title: 'Not Found' };
const FORBIDDEN = { status: HttpStatus.FORBIDDEN, title: 'Forbidden' };
const CONFLICT = { status: HttpStatus.CONFLICT, title: 'Conflict' };
const UNPROCESSABLE = {
  status: HttpStatus.UNPROCESSABLE_ENTITY,
  title: 'Unprocessable Entity',
};

export const CHAT_PROBLEM_DEFINITIONS = {
  channel_not_found: { ...NOT_FOUND, detail: 'Channel not found.' },
  member_not_found: { ...NOT_FOUND, detail: 'Member not found.' },
  message_not_found: { ...NOT_FOUND, detail: 'Message not found.' },
  product_not_found: { ...NOT_FOUND, detail: 'Product not found.' },
  permission_denied: {
    ...FORBIDDEN,
    detail: 'You do not have permission to do this.',
  },
  banned: { ...FORBIDDEN, detail: 'You are banned from this channel.' },
  muted: { ...FORBIDDEN, detail: 'You are muted in this channel.' },
  channel_archived: { ...CONFLICT, detail: 'The channel is archived.' },
  product_archived: {
    ...CONFLICT,
    detail: 'An archived product cannot have a chat.',
  },
  invalid_transition: {
    ...CONFLICT,
    detail: 'The change is not allowed from the current state.',
  },
  channel_exists: {
    ...CONFLICT,
    detail: 'This product already has a chat channel.',
  },
  idempotency_key_reuse: {
    ...UNPROCESSABLE,
    detail: 'This client message ID was already used with different content.',
  },
  reply_target_invalid: {
    ...UNPROCESSABLE,
    detail: 'The message you reply to is not in this channel.',
  },
  too_many_channels: {
    status: HttpStatus.BAD_REQUEST,
    title: 'Bad Request',
    detail: 'At most 50 channels can be synced in one request.',
  },
  presence_unavailable: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    title: 'Service Unavailable',
    detail: 'Presence is temporarily unavailable; retry.',
  },
} as const;

export type ChatProblemCode = keyof typeof CHAT_PROBLEM_DEFINITIONS;

type Params = ConstructorParameters<typeof AppError>[0];

export class ChatError extends AppError {
  constructor(
    readonly chatCode: ChatProblemCode,
    extra: Partial<Params> = {},
  ) {
    const d = CHAT_PROBLEM_DEFINITIONS[chatCode];
    super({
      status: d.status,
      code: chatCode,
      title: d.title,
      detail: d.detail,
      area:
        chatCode === 'presence_unavailable'
          ? ErrorArea.TRANSIENT
          : ErrorArea.DOMAIN,
      ...(chatCode === 'presence_unavailable' ? { retryAfterSeconds: 2 } : {}),
      ...extra,
    });
  }
}

/** `400 validation_failed` naming the offending fields, never their values. */
export class ChatValidationError extends AppError {
  constructor(fields: string[]) {
    super({
      status: HttpStatus.BAD_REQUEST,
      code: 'validation_failed',
      title: 'Bad Request',
      detail: 'The request is not valid.',
      area: ErrorArea.DOMAIN,
      extensions: {
        errors: fields.map((field) => ({ field, code: 'invalid' })),
      },
    });
  }
}

export const channelNotFound = () => new ChatError('channel_not_found');
export const memberNotFound = () => new ChatError('member_not_found');
export const messageNotFound = () => new ChatError('message_not_found');
export const productNotFound = () => new ChatError('product_not_found');
/** `403 permission_denied` (spec AS-02/AS-50; `contracts/http.md` says `forbidden`, the spec wins, see questions.md). */
export const forbidden = () => new ChatError('permission_denied');
export const banned = () => new ChatError('banned');
export const muted = (mutedUntil: Date) =>
  new ChatError('muted', {
    extensions: { mutedUntil: mutedUntil.toISOString() },
  });
export const channelArchived = () => new ChatError('channel_archived');
export const productArchived = () => new ChatError('product_archived');
export const invalidTransition = () => new ChatError('invalid_transition');
export const channelExists = () => new ChatError('channel_exists');
export const idempotencyKeyReuse = () => new ChatError('idempotency_key_reuse');
export const replyTargetInvalid = () => new ChatError('reply_target_invalid');
export const tooManyChannels = () => new ChatError('too_many_channels');
export const presenceUnavailable = () => new ChatError('presence_unavailable');

/**
 * Entries registered in the problem catalog at module definition (a clash with another owner fails start-up).
 * `validation_failed`, `forbidden`, `idempotency_key_reuse` belong to the platform and `product_not_found`,
 * `product_archived`, `invalid_transition`, `member_not_found` to other owners; the classes above still carry them.
 */
const OWN: ChatProblemCode[] = [
  'channel_not_found',
  'message_not_found',
  'banned',
  'muted',
  'channel_archived',
  'channel_exists',
  'reply_target_invalid',
  'too_many_channels',
  'presence_unavailable',
];
export const CHAT_PROBLEMS: ProblemCatalogEntry[] = OWN.map((code) => {
  const d = CHAT_PROBLEM_DEFINITIONS[code];
  return {
    code,
    status: d.status,
    title: d.title,
    detail: d.detail,
    owner: 'chat',
  };
});
