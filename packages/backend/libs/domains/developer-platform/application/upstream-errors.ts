import { AppError } from '@app/common/errors/error.types';
import { VersionConflictError } from '@app/domains/catalog';
import { ApiError } from '../domain/errors';

/** Field names of the catalog's contract → the names a client of the public API sent (`priceMinor` is `price.amount`). */
const PUBLIC_FIELD: Record<string, string> = {
  priceMinor: 'price.amount',
  currency: 'price.currency',
  quantity: 'stock',
  expectedVersion: 'If-Match',
};

const publicField = (field: string): string => PUBLIC_FIELD[field] ?? field;

/**
 * What an exported service of another capability refuses, in this API's catalogue (FR-059, G-37). Anything that is not a
 * refusal the public contract names is rethrown for the filter (generic `5xx`, never a catalogue leak).
 */
export function translateUpstream(error: unknown): never {
  if (error instanceof ApiError) throw error;
  if (!(error instanceof AppError)) throw error;
  switch (error.code) {
    case 'product_not_found':
    case 'order_not_found':
      throw new ApiError('resource_missing', 'No such resource.');
    case 'version_conflict':
      throw new ApiError(
        'version_conflict',
        error instanceof VersionConflictError
          ? `The product is at version ${error.currentVersion}.`
          : 'The product was changed by someone else.',
        {
          extensions:
            error instanceof VersionConflictError
              ? { currentVersion: error.currentVersion }
              : undefined,
        },
      );
    case 'product_archived':
      throw new ApiError(
        'product_archived',
        'An archived product cannot be edited.',
      );
    case 'shop_suspended':
      throw new ApiError('shop_suspended', 'This shop is suspended.');
    case 'shop_offboarding':
      throw new ApiError('shop_offboarding', 'This shop is being closed.');
    case 'invalid_cursor':
      throw new ApiError(
        'invalid_cursor',
        'The cursor is not valid for this list.',
      );
    case 'currency_not_supported':
      throw new ApiError(
        'validation_failed',
        'The currency is not supported.',
        {
          errors: [{ field: 'price.currency', code: 'unsupported' }],
        },
      );
    case 'stock_operation_conflict':
      throw new ApiError(
        'operation_conflict',
        'The operation id was already used for a different change.',
      );
    case 'validation_failed': {
      const given = (error.extensions?.errors ?? []) as {
        field: string;
        code: string;
      }[];
      throw new ApiError('validation_failed', 'The request is not valid.', {
        errors: given.map((e) => ({
          field: publicField(e.field),
          code: e.code,
        })),
      });
    }
    default:
      throw error;
  }
}
