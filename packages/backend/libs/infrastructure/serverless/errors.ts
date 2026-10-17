/**
 * Error classes of the toolkit. `TransientError` and `PermanentError` are S53's classes (one identity, so `instanceof`
 * works across the platform); the rest are the idempotency and manifest failures of this capability.
 */
export {
  TransientError,
  PermanentError,
} from '@app/infrastructure/projections/errors';
