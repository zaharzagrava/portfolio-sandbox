import { Logger } from '@nestjs/common';
import { AppError } from '@app/common/errors';
import { ServiceUnavailableError } from '../domain/pickup-errors';

const logger = new Logger('Pickup');

/**
 * Runs a write. Domain errors pass through with their stable code; anything else (a store or outbox failure) is logged
 * with its detail and answered as the one generic, retryable `503` - the caller never sees an internal message (FR-051).
 */
export async function guardWrite<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AppError) throw error;
    logger.error(
      `pickup write failed: ${(error as Error).message}`,
      (error as Error).stack,
    );
    throw new ServiceUnavailableError();
  }
}
