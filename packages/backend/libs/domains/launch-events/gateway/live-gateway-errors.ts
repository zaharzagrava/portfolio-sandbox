import { Logger } from '@nestjs/common';
import { AppError } from '@app/common/errors';
import { logLiveError } from '../application/live-log';
import { liveUnavailable } from '../domain/live-errors';

export {
  gatewayFull,
  streamEnded,
  streamNotFound,
} from '../domain/live-errors';

const logger = new Logger('LiveGateway');

/** Runs a store-backed step of opening a connection; anything that is not already a problem answers `503 live_unavailable`. */
export async function or503<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (error instanceof AppError) throw error;
    logLiveError(logger, 'connection_step_failed', {}, error);
    throw liveUnavailable();
  }
}
