import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';
import type { ProblemCatalogEntry } from '@app/common/errors';

/**
 * Problem codes of the `content` domain (S27 contracts/interfaces.md). Every error of the capability is a `StoryError`;
 * the platform filter renders the problem document. Titles and details are fixed text: no value, SQL or host is part
 * of one, and 5xx details are generic (FR-064).
 *
 * Not registered here, raised with this capability's wording: `slug_taken`, `version_conflict`, `validation_failed`,
 * `payload_too_large`, `invalid_transition`, `version_not_found`, `invalid_cursor` and `dependency_unavailable` have
 * another status or wording in other domains, and the catalog refuses two definitions of one code. `permission_denied`, `shop_not_found`,
 * `shop_suspended`, `shop_offboarding` (tenancy), `rate_limited` (limiter) and the `idempotency_*` codes (platform) are
 * raised by their owners.
 */
const DEFINITIONS = {
  validation_failed: [
    HttpStatus.BAD_REQUEST,
    'Bad Request',
    'The request is not valid.',
  ],
  story_not_found: [HttpStatus.NOT_FOUND, 'Not found', 'Story not found.'],
  draft_not_found: [HttpStatus.NOT_FOUND, 'Not found', 'Draft not found.'],
  version_not_found: [HttpStatus.NOT_FOUND, 'Not found', 'Version not found.'],
  slug_taken: [
    HttpStatus.CONFLICT,
    'Conflict',
    'A story with this slug already exists in the shop.',
  ],
  revision_conflict: [
    HttpStatus.CONFLICT,
    'Conflict',
    'The draft was changed by someone else; reload it and try again.',
  ],
  version_conflict: [
    HttpStatus.CONFLICT,
    'Conflict',
    'The story was published by someone else; reload it and try again.',
  ],
  nothing_to_publish: [
    HttpStatus.CONFLICT,
    'Conflict',
    'The drafts equal the live version; there is nothing to publish.',
  ],
  default_locale_required: [
    HttpStatus.CONFLICT,
    'Conflict',
    'The draft of the default locale cannot be deleted.',
  ],
  not_scheduled: [
    HttpStatus.CONFLICT,
    'Conflict',
    'The story has no schedule.',
  ],
  invalid_transition: [
    HttpStatus.CONFLICT,
    'Conflict',
    'The operation is not allowed in the current state.',
  ],
  story_limit_reached: [
    HttpStatus.UNPROCESSABLE_ENTITY,
    'Unprocessable Entity',
    'The shop reached its maximum number of stories.',
  ],
  locale_limit_reached: [
    HttpStatus.UNPROCESSABLE_ENTITY,
    'Unprocessable Entity',
    'The story reached its maximum number of locales.',
  ],
  invalid_blocks: [
    HttpStatus.UNPROCESSABLE_ENTITY,
    'Unprocessable Entity',
    'The content blocks are not valid.',
  ],
  invalid_title: [
    HttpStatus.UNPROCESSABLE_ENTITY,
    'Unprocessable Entity',
    'The title must have 1 to 200 characters.',
  ],
  payload_too_large: [
    HttpStatus.UNPROCESSABLE_ENTITY,
    'Unprocessable Entity',
    'The draft is too large.',
  ],
  no_drafts: [
    HttpStatus.UNPROCESSABLE_ENTITY,
    'Unprocessable Entity',
    'The story has no drafts to publish.',
  ],
  default_locale_missing: [
    HttpStatus.UNPROCESSABLE_ENTITY,
    'Unprocessable Entity',
    'The story has no draft in its default locale.',
  ],
  unknown_product_reference: [
    HttpStatus.UNPROCESSABLE_ENTITY,
    'Unprocessable Entity',
    'A product block refers to a product that is not in this shop.',
  ],
  schedule_in_past: [
    HttpStatus.UNPROCESSABLE_ENTITY,
    'Unprocessable Entity',
    'The schedule time must be in the future.',
  ],
  schedule_too_far: [
    HttpStatus.UNPROCESSABLE_ENTITY,
    'Unprocessable Entity',
    'The schedule time is too far ahead.',
  ],
  invalid_cursor: [
    HttpStatus.BAD_REQUEST,
    'Bad Request',
    'The cursor is not valid.',
  ],
  dependency_unavailable: [
    HttpStatus.SERVICE_UNAVAILABLE,
    'Service Unavailable',
    'A dependency is temporarily unavailable. Retry shortly.',
  ],
} as const;

export type StoryProblemCode = keyof typeof DEFINITIONS;
export const STORY_ERROR_CODES = Object.keys(DEFINITIONS) as StoryProblemCode[];

const NOT_REGISTERED: StoryProblemCode[] = [
  'slug_taken',
  'version_conflict',
  'validation_failed',
  'payload_too_large',
  'invalid_transition',
  'version_not_found',
  'invalid_cursor',
  'dependency_unavailable',
];

/** The platform's field error shape (`errors: [{field, code}]`); the code is fixed text, never the submitted value. */
export interface FieldIssue {
  field: string;
  code: string;
}

export class StoryError extends AppError {
  constructor(
    readonly storyCode: StoryProblemCode,
    options: {
      extensions?: Record<string, unknown>;
      retryAfterSeconds?: number;
    } = {},
  ) {
    const [status, title, detail] = DEFINITIONS[storyCode];
    super({
      status,
      code: storyCode,
      title,
      detail,
      area:
        options.retryAfterSeconds !== undefined
          ? ErrorArea.TRANSIENT
          : ErrorArea.DOMAIN,
      extensions: options.extensions,
      retryAfterSeconds: options.retryAfterSeconds,
    });
  }
}

export const validationFailed = (errors: FieldIssue[]) =>
  new StoryError('validation_failed', { extensions: { errors } });
export const storyNotFound = () => new StoryError('story_not_found');
export const draftNotFound = () => new StoryError('draft_not_found');
export const versionNotFound = () => new StoryError('version_not_found');
export const slugTaken = () => new StoryError('slug_taken');
export const revisionConflict = (currentRevision: number) =>
  new StoryError('revision_conflict', { extensions: { currentRevision } });
export const versionConflict = (currentVersion: number) =>
  new StoryError('version_conflict', { extensions: { currentVersion } });
export const nothingToPublish = () => new StoryError('nothing_to_publish');
export const defaultLocaleRequired = () =>
  new StoryError('default_locale_required');
export const notScheduled = () => new StoryError('not_scheduled');
/** The extension is `currentStatus`: `status` is the problem document's own HTTP status member. */
export const invalidTransition = (currentStatus: string) =>
  new StoryError('invalid_transition', { extensions: { currentStatus } });
export const storyLimitReached = (limit: number) =>
  new StoryError('story_limit_reached', { extensions: { limit } });
export const localeLimitReached = (limit: number) =>
  new StoryError('locale_limit_reached', { extensions: { limit } });
export const invalidBlocks = (issues: { path: string; code: string }[]) =>
  new StoryError('invalid_blocks', { extensions: { issues } });
export const invalidTitle = () => new StoryError('invalid_title');
export const payloadTooLarge = () => new StoryError('payload_too_large');
export const noDrafts = () => new StoryError('no_drafts');
export const defaultLocaleMissing = () =>
  new StoryError('default_locale_missing');
export const unknownProductReference = (productIds: string[]) =>
  new StoryError('unknown_product_reference', { extensions: { productIds } });
export const scheduleInPast = () => new StoryError('schedule_in_past');
export const scheduleTooFar = () => new StoryError('schedule_too_far');
export const invalidCursor = () => new StoryError('invalid_cursor');
export const dependencyUnavailable = () =>
  new StoryError('dependency_unavailable', { retryAfterSeconds: 1 });

/** Permanent failures of a scheduled publish: the code recorded in `scheduleFailure` (S27 AS-47). */
export const PERMANENT_PUBLISH_CODES = [
  'unknown_product_reference',
  'default_locale_missing',
  'no_drafts',
  'nothing_to_publish',
  'shop_not_active',
] as const;
export type PermanentPublishCode = (typeof PERMANENT_PUBLISH_CODES)[number];

export const isPermanentPublishCode = (
  code: string,
): code is PermanentPublishCode =>
  (PERMANENT_PUBLISH_CODES as readonly string[]).includes(code);

export const STORY_PROBLEMS: ProblemCatalogEntry[] = STORY_ERROR_CODES.filter(
  (code) => !NOT_REGISTERED.includes(code),
).map((code) => ({
  code,
  status: DEFINITIONS[code][0],
  title: DEFINITIONS[code][1],
  detail: DEFINITIONS[code][2],
  owner: 'content',
}));
