import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';
import type { ProblemCatalogEntry } from '@app/common/errors';

/**
 * HTTP-visible errors of discussions (specs/domains/S25-discussions/contracts/discussions-api.md). Every one is an
 * `AppError` with a stable problem `code`; none carries a body, title, store name or query text in its detail (FR-070).
 * Codes owned by the platform (`validation_failed`, `forbidden`, `unauthenticated`, the idempotency family) and by the
 * rate limiter (`rate_limited`) are raised here with the platform's definition and not registered again.
 */
type Params = ConstructorParameters<typeof AppError>[0];

export const DISCUSSION_ERROR_CODES = [
  'invalid_cursor',
  'board_not_found',
  'post_not_found',
  'comment_not_found',
  'parent_not_found',
  'target_not_found',
  'user_not_found',
  'board_closed',
  'parent_deleted',
  'target_deleted',
  'vote_in_progress',
  'max_depth_exceeded',
  'self_vote_not_allowed',
  'markdown_too_complex',
  'service_unavailable',
] as const;
export type DiscussionErrorCode = (typeof DISCUSSION_ERROR_CODES)[number];

interface Definition {
  status: HttpStatus;
  title: string;
  detail: string;
}

const DEFINITIONS: Record<DiscussionErrorCode, Definition> = {
  invalid_cursor: {
    status: HttpStatus.BAD_REQUEST,
    title: 'Bad Request',
    detail: 'The cursor is not valid for this list.',
  },
  board_not_found: {
    status: HttpStatus.NOT_FOUND,
    title: 'Not Found',
    detail: 'There is no discussion board for this product.',
  },
  post_not_found: {
    status: HttpStatus.NOT_FOUND,
    title: 'Not Found',
    detail: 'There is no such post.',
  },
  comment_not_found: {
    status: HttpStatus.NOT_FOUND,
    title: 'Not Found',
    detail: 'There is no such comment.',
  },
  parent_not_found: {
    status: HttpStatus.NOT_FOUND,
    title: 'Not Found',
    detail: 'There is no such comment to reply to.',
  },
  target_not_found: {
    status: HttpStatus.NOT_FOUND,
    title: 'Not Found',
    detail: 'There is no such post or comment.',
  },
  user_not_found: {
    status: HttpStatus.NOT_FOUND,
    title: 'Not Found',
    detail: 'There is no such user.',
  },
  board_closed: {
    status: HttpStatus.CONFLICT,
    title: 'Conflict',
    detail: 'The discussion board of this product is closed.',
  },
  parent_deleted: {
    status: HttpStatus.CONFLICT,
    title: 'Conflict',
    detail: 'The comment you reply to was deleted.',
  },
  target_deleted: {
    status: HttpStatus.CONFLICT,
    title: 'Conflict',
    detail: 'The comment was deleted.',
  },
  vote_in_progress: {
    status: HttpStatus.CONFLICT,
    title: 'Conflict',
    detail: 'Another vote on this item is being recorded. Retry shortly.',
  },
  max_depth_exceeded: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unprocessable Entity',
    detail: 'Replies can be nested at most 8 levels deep.',
  },
  self_vote_not_allowed: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unprocessable Entity',
    detail: 'You cannot vote on your own post or comment.',
  },
  markdown_too_complex: {
    status: HttpStatus.BAD_REQUEST,
    title: 'Bad Request',
    detail: 'The text nests quotes or lists too deeply.',
  },
  service_unavailable: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    title: 'Service Unavailable',
    detail: 'The discussions are temporarily unavailable. Retry shortly.',
  },
};

export class DiscussionError extends AppError {
  constructor(
    readonly discussionCode: DiscussionErrorCode,
    extra: Partial<Params> = {},
  ) {
    const d = DEFINITIONS[discussionCode];
    super({
      status: d.status,
      code: discussionCode,
      title: d.title,
      detail: d.detail,
      area: ErrorArea.DOMAIN,
      ...extra,
    });
  }
}

const RETRY_AFTER_SECONDS = 1;

export const boardNotFound = () => new DiscussionError('board_not_found');
export const boardClosed = () => new DiscussionError('board_closed');
export const postNotFound = () => new DiscussionError('post_not_found');
export const commentNotFound = () => new DiscussionError('comment_not_found');
export const parentNotFound = () => new DiscussionError('parent_not_found');
export const parentDeleted = () => new DiscussionError('parent_deleted');
export const targetNotFound = () => new DiscussionError('target_not_found');
export const targetDeleted = () => new DiscussionError('target_deleted');
export const userNotFound = () => new DiscussionError('user_not_found');
export const maxDepthExceeded = () => new DiscussionError('max_depth_exceeded');
export const selfVoteNotAllowed = () =>
  new DiscussionError('self_vote_not_allowed');
export const invalidCursor = () => new DiscussionError('invalid_cursor');
export const voteInProgress = () =>
  new DiscussionError('vote_in_progress', {
    retryAfterSeconds: RETRY_AFTER_SECONDS,
  });
export const serviceUnavailable = () =>
  new DiscussionError('service_unavailable', {
    retryAfterSeconds: RETRY_AFTER_SECONDS,
  });
export const markdownTooComplex = () =>
  new DiscussionError('markdown_too_complex', {
    code: 'validation_failed',
    extensions: { errors: [{ field: 'body', code: 'markdown_too_complex' }] },
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

export const forbidden = () =>
  new AppError({
    status: HttpStatus.FORBIDDEN,
    code: 'forbidden',
    title: 'Forbidden',
    detail: 'You are not allowed to do this.',
    area: ErrorArea.DOMAIN,
  });

/** Codes this domain owns, registered at module definition (S54 problem catalog). */
const NOT_OWNED: DiscussionErrorCode[] = [
  'invalid_cursor',
  'markdown_too_complex',
];

export const DISCUSSION_PROBLEMS: ProblemCatalogEntry[] =
  DISCUSSION_ERROR_CODES.filter((code) => !NOT_OWNED.includes(code)).map(
    (code) => ({
      code,
      status: DEFINITIONS[code].status,
      title: DEFINITIONS[code].title,
      detail: DEFINITIONS[code].detail,
      owner: 'community',
    }),
  );
