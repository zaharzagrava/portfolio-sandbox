import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';
import type { ProblemCatalogEntry } from '@app/common/errors';

/**
 * Problem codes of the asset library (S31 contracts/interfaces.md). Every error of the capability is an `AssetError`;
 * the platform filter renders the problem document. Titles and details are fixed text: no path, hash, token or storage
 * message is ever part of one, and 5xx details are generic (FR-053).
 *
 * Not registered here, raised with the owner's wording: `permission_denied` (guard), `shop_not_found`, `shop_suspended`,
 * `shop_offboarding` (tenancy), `rate_limited` (rate limiter), the three `idempotency_*` codes (platform) and
 * `validation_failed` (platform). `invalid_cursor` (here 422), `invalid_transition`, `quota_exceeded`, `size_mismatch`,
 * `storage_unavailable` and `product_not_found` have another status or wording in other domains, and the catalog
 * refuses two definitions of one code, so this domain raises them without registering them.
 */
const DEFINITIONS = {
  validation_failed: [
    HttpStatus.BAD_REQUEST,
    'Bad Request',
    'The request is not valid.',
  ],
  asset_not_found: [HttpStatus.NOT_FOUND, 'Not found', 'Asset not found.'],
  version_not_found: [HttpStatus.NOT_FOUND, 'Not found', 'Version not found.'],
  share_link_not_found: [
    HttpStatus.NOT_FOUND,
    'Not found',
    'Share link not found.',
  ],
  entitlement_not_found: [
    HttpStatus.NOT_FOUND,
    'Not found',
    'No download is available for this product.',
  ],
  digital_link_not_found: [
    HttpStatus.NOT_FOUND,
    'Not found',
    'The product has no digital file.',
  ],
  product_not_found: [HttpStatus.NOT_FOUND, 'Not found', 'Product not found.'],
  cannot_delete_current_version: [
    HttpStatus.CONFLICT,
    'Conflict',
    'The current version, or the only version, cannot be deleted.',
  ],
  invalid_transition: [
    HttpStatus.CONFLICT,
    'Conflict',
    'The operation is not allowed in the current state.',
  ],
  path_taken: [
    HttpStatus.CONFLICT,
    'Conflict',
    'Another file already uses this path.',
  ],
  asset_in_use: [
    HttpStatus.CONFLICT,
    'Conflict',
    'The file is linked to a digital product or was bought.',
  ],
  asset_deleted: [HttpStatus.CONFLICT, 'Conflict', 'The file is deleted.'],
  digital_product_sold: [
    HttpStatus.CONFLICT,
    'Conflict',
    'The product was sold and keeps its file.',
  ],
  version_limit_reached: [
    HttpStatus.CONFLICT,
    'Conflict',
    'The file reached its maximum number of versions.',
  ],
  quota_exceeded: [
    HttpStatus.CONFLICT,
    'Conflict',
    'The storage quota of the shop is exceeded.',
  ],
  chunks_unknown: [
    HttpStatus.UNPROCESSABLE_ENTITY,
    'Unprocessable Entity',
    'The commit lists chunks this shop does not know; prepare them first.',
  ],
  chunk_not_uploaded: [
    HttpStatus.UNPROCESSABLE_ENTITY,
    'Unprocessable Entity',
    'Some chunks are not in storage; upload them and commit again.',
  ],
  chunk_size_mismatch: [
    HttpStatus.UNPROCESSABLE_ENTITY,
    'Unprocessable Entity',
    'A chunk is known with another size.',
  ],
  size_mismatch: [
    HttpStatus.UNPROCESSABLE_ENTITY,
    'Unprocessable Entity',
    'The size does not match the chunks.',
  ],
  invalid_base_version: [
    HttpStatus.UNPROCESSABLE_ENTITY,
    'Unprocessable Entity',
    'The base version is newer than the file.',
  ],
  invalid_cursor: [
    HttpStatus.UNPROCESSABLE_ENTITY,
    'Unprocessable Entity',
    'The cursor is not valid.',
  ],
  cursor_expired: [
    HttpStatus.GONE,
    'Gone',
    'The cursor is older than the retained changes; list the library again.',
  ],
  link_unavailable: [HttpStatus.GONE, 'Gone', 'This link is not available.'],
  download_unavailable: [
    HttpStatus.GONE,
    'Gone',
    'This download is not available.',
  ],
  storage_unavailable: [
    HttpStatus.SERVICE_UNAVAILABLE,
    'Service Unavailable',
    'Storage is temporarily unavailable. Retry shortly.',
  ],
} as const;

export type AssetProblemCode = keyof typeof DEFINITIONS;
export const ASSET_ERROR_CODES = Object.keys(DEFINITIONS) as AssetProblemCode[];

/** Codes raised here whose definition another owner registers (see the note above). */
const NOT_REGISTERED: AssetProblemCode[] = [
  'validation_failed',
  'invalid_cursor',
  'invalid_transition',
  'quota_exceeded',
  'size_mismatch',
  'storage_unavailable',
  'product_not_found',
];

/** The platform's field error shape (`errors: [{field, code}]`); the code is fixed text, never the submitted value. */
export interface FieldIssue {
  field: string;
  code: string;
}

export class AssetError extends AppError {
  constructor(
    readonly assetCode: AssetProblemCode,
    options: {
      extensions?: Record<string, unknown>;
      retryAfterSeconds?: number;
    } = {},
  ) {
    const [status, title, detail] = DEFINITIONS[assetCode];
    super({
      status,
      code: assetCode,
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
  new AssetError('validation_failed', { extensions: { errors } });
export const assetNotFound = () => new AssetError('asset_not_found');
export const versionNotFound = () => new AssetError('version_not_found');
export const shareLinkNotFound = () => new AssetError('share_link_not_found');
export const entitlementNotFound = () =>
  new AssetError('entitlement_not_found');
export const digitalLinkNotFound = () =>
  new AssetError('digital_link_not_found');
export const productNotFound = () => new AssetError('product_not_found');
export const cannotDeleteCurrentVersion = () =>
  new AssetError('cannot_delete_current_version');
export const invalidTransition = () => new AssetError('invalid_transition');
export const pathTaken = () => new AssetError('path_taken');
export const assetInUse = () => new AssetError('asset_in_use');
export const assetDeleted = () => new AssetError('asset_deleted');
export const digitalProductSold = () => new AssetError('digital_product_sold');
export const versionLimitReached = (limit: number) =>
  new AssetError('version_limit_reached', { extensions: { limit } });
export const quotaExceeded = (limitBytes: number, usedBytes: number) =>
  new AssetError('quota_exceeded', { extensions: { limitBytes, usedBytes } });
export const chunksUnknown = (hashes: string[]) =>
  new AssetError('chunks_unknown', { extensions: { hashes } });
export const chunkNotUploaded = (hashes: string[]) =>
  new AssetError('chunk_not_uploaded', { extensions: { hashes } });
export const chunkSizeMismatch = (hash: string) =>
  new AssetError('chunk_size_mismatch', { extensions: { hash } });
export const sizeMismatch = (expectedBytes: number, actualBytes: number) =>
  new AssetError('size_mismatch', {
    extensions: { expectedBytes, actualBytes },
  });
export const invalidBaseVersion = (currentVersion: number) =>
  new AssetError('invalid_base_version', { extensions: { currentVersion } });
export const invalidCursor = () => new AssetError('invalid_cursor');
export const cursorExpired = () => new AssetError('cursor_expired');
export const linkUnavailable = () => new AssetError('link_unavailable');
export const downloadUnavailable = () => new AssetError('download_unavailable');
export const storageUnavailable = () =>
  new AssetError('storage_unavailable', { retryAfterSeconds: 1 });

export const ASSET_PROBLEMS: ProblemCatalogEntry[] = ASSET_ERROR_CODES.filter(
  (code) => !NOT_REGISTERED.includes(code),
).map((code) => ({
  code,
  status: DEFINITIONS[code][0],
  title: DEFINITIONS[code][1],
  detail: DEFINITIONS[code][2],
  owner: 'asset-library',
}));
