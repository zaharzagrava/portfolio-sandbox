import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';
import type { ProblemCatalogEntry } from '@app/common/errors';
import type { MediaProblemCode } from '@marketplace-sandbox/contracts';

/**
 * HTTP-visible errors of the photos (specs/domains/S29-photos/contracts/media-api.md, FR-073): one table, stable
 * `code`s, generic details. None echoes a storage key, a decoder message or an id the caller does not own. The
 * "not yours / unknown / deleted" answers are one and the same `media_not_found` (FR-071).
 */
interface Definition {
  status: HttpStatus;
  title: string;
  detail: string;
}

const DEFINITIONS: Record<MediaProblemCode, Definition> = {
  validation_failed: {
    status: HttpStatus.BAD_REQUEST,
    title: 'Bad Request',
    detail: 'The request is not valid.',
  },
  permission_denied: {
    status: HttpStatus.FORBIDDEN,
    title: 'Forbidden',
    detail: 'You do not have permission to do this.',
  },
  shop_suspended: {
    status: HttpStatus.FORBIDDEN,
    title: 'Forbidden',
    detail: 'The shop is suspended.',
  },
  shop_offboarding: {
    status: HttpStatus.CONFLICT,
    title: 'Conflict',
    detail: 'The shop is being closed.',
  },
  pending_uploads_limit: {
    status: HttpStatus.CONFLICT,
    title: 'Conflict',
    detail:
      'Too many uploads are waiting to be completed. Finish or delete some first.',
  },
  upload_incomplete: {
    status: HttpStatus.CONFLICT,
    title: 'Conflict',
    detail:
      'The file has not arrived in storage yet. Upload it, then confirm again.',
  },
  upload_expired: {
    status: HttpStatus.CONFLICT,
    title: 'Conflict',
    detail: 'This upload expired. Start a new one.',
  },
  media_not_found: {
    status: HttpStatus.NOT_FOUND,
    title: 'Not Found',
    detail: 'There is no such photo.',
  },
  media_in_use: {
    status: HttpStatus.CONFLICT,
    title: 'Conflict',
    detail:
      'The photo is part of a product gallery. Remove it from the gallery first.',
  },
  media_busy: {
    status: HttpStatus.CONFLICT,
    title: 'Conflict',
    detail: 'The photo is being processed. Try again in a moment.',
  },
  media_not_attachable: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unprocessable Entity',
    detail: 'Some photos cannot be used in this gallery.',
  },
  product_not_found: {
    status: HttpStatus.NOT_FOUND,
    title: 'Not Found',
    detail: 'Product not found.',
  },
  product_archived: {
    status: HttpStatus.CONFLICT,
    title: 'Conflict',
    detail: 'An archived product cannot be edited; restore it first.',
  },
  version_conflict: {
    status: HttpStatus.CONFLICT,
    title: 'Conflict',
    detail: 'The gallery was changed by someone else; reload it and retry.',
  },
};

type Params = ConstructorParameters<typeof AppError>[0];

export class MediaError extends AppError {
  constructor(
    readonly mediaCode: MediaProblemCode,
    extra: Partial<Params> = {},
  ) {
    const d = DEFINITIONS[mediaCode];
    super({
      status: d.status,
      code: mediaCode,
      title: d.title,
      detail: d.detail,
      area: ErrorArea.DOMAIN,
      ...extra,
    });
  }
}

export const mediaNotFound = () => new MediaError('media_not_found');
export const uploadIncomplete = () => new MediaError('upload_incomplete');
export const uploadExpired = () => new MediaError('upload_expired');
export const mediaBusy = () => new MediaError('media_busy');
export const productNotFound = () => new MediaError('product_not_found');
export const productArchived = () => new MediaError('product_archived');
export const pendingUploadsLimit = (count: number) =>
  new MediaError('pending_uploads_limit', { extensions: { count } });
export const mediaInUse = (productIds: string[]) =>
  new MediaError('media_in_use', { extensions: { productIds } });
export const versionConflict = (currentVersion: number) =>
  new MediaError('version_conflict', { extensions: { currentVersion } });
export const mediaNotAttachable = (
  failures: { mediaId: string; code: 'not_found' | 'not_ready' }[],
) => new MediaError('media_not_attachable', { extensions: { failures } });
export const validationFailed = (fields: string[]) =>
  new MediaError('validation_failed', {
    extensions: { errors: fields.map((field) => ({ field, code: 'invalid' })) },
  });

/** Codes another capability already owns: raised here with the same wording, registered by their owner. */
const NOT_OWNED: MediaProblemCode[] = [
  'validation_failed',
  'permission_denied',
  'shop_suspended',
  'shop_offboarding',
  'product_not_found',
  'product_archived',
  'version_conflict',
];

export const MEDIA_PROBLEMS: ProblemCatalogEntry[] = (
  Object.keys(DEFINITIONS) as MediaProblemCode[]
)
  .filter((code) => !NOT_OWNED.includes(code))
  .map((code) => ({
    code,
    status: DEFINITIONS[code].status,
    title: DEFINITIONS[code].title,
    detail: DEFINITIONS[code].detail,
    owner: 'media',
  }));
