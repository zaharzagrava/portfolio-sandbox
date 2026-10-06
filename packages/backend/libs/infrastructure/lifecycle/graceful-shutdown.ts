import { writeSync } from 'node:fs';
import { INestApplication, INestApplicationContext, Logger } from '@nestjs/common';
import type { Server } from 'node:http';
import { ReadinessService } from '@app/infrastructure/health/readiness.service';
import { sleep } from '@app/common/core/backoff';

export interface GracefulShutdownOptions {
  /**
   * Time between "readiness = false" and closing the server: the load balancer
   * needs a few health-check intervals to stop routing here. Without it,
   * requests arrive at a closing socket and fail.
   */
  drainDelayMs?: number;
  /** Hard deadline: exit non-zero if cleanup hangs (systemd/ASG would SIGKILL anyway). */
  hardTimeoutMs?: number;
  /** Must exceed the ALB idle timeout (60 s) so the LB, not Node, closes idle keep-alive sockets. */
  keepAliveTimeoutMs?: number;
}

const logger = new Logger('GracefulShutdown');

/**
 * Replaces `app.enableShutdownHooks()` with the full sequence (lesson 02/04 §4):
 *   SIGTERM → readiness=false → wait drainDelay → stop accepting connections,
 *   close idle keep-alive sockets → Nest hooks (ShutdownRegistry: consumers,
 *   buffers, pools) → exit 0; any hang past hardTimeout → exit 1.
 */
export function installGracefulShutdown(
  app: INestApplication | INestApplicationContext,
  {
    // The drain only exists so the load balancer can deregister us first. Locally there is none, and the delay
    // made `nest start --watch` spawn the new process while the old one still held the port (EADDRINUSE).
    drainDelayMs = process.env.NODE_ENV === 'production' ? 5_000 : 0,
    hardTimeoutMs = 30_000,
    keepAliveTimeoutMs = 65_000,
  }: GracefulShutdownOptions = {},
): void {
  const server: Server | undefined = 'getHttpServer' in app ? (app.getHttpServer() as Server) : undefined;

  if (server) {
    server.keepAliveTimeout = keepAliveTimeoutMs;
    // headersTimeout must be > keepAliveTimeout, otherwise Node drops sockets the LB still considers open.
    server.headersTimeout = keepAliveTimeoutMs + 1_000;
  }

  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log(`${signal} received, starting graceful shutdown`);

    const hardTimer = setTimeout(() => {
      logger.error(`Shutdown exceeded ${hardTimeoutMs}ms, forcing exit`);
      process.exit(1);
    }, hardTimeoutMs);
    hardTimer.unref();

    try {
      app.get(ReadinessService, { strict: false }).markShuttingDown();
    } catch {
      // App without HealthModule - nothing to flip.
    }

    try {
      if (server) {
        await sleep(drainDelayMs);
        server.closeIdleConnections();
      }
      await app.close(); // runs ShutdownRegistry + onApplicationShutdown hooks, closes the HTTP server
      logger.log('Graceful shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error(`Graceful shutdown failed: ${(error as Error).message}`);
      process.exit(1);
    }
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

/**
 * Operational errors are handled where they happen; anything reaching these
 * handlers is a programmer error or corrupted state - log and crash so the
 * supervisor restarts a clean process (lesson 02/04 §1).
 */
export function installCrashHandlers(): void {
  // The structured logger is async (and Nest buffers logs until bootstrap completes), so a crash right before
  // process.exit would vanish without a trace; the synchronous stderr write guarantees the cause is visible.
  const die = (message: string) => {
    logger.error(message);
    writeSync(2, `${message}\n`);
    process.exit(1);
  };
  process.on('unhandledRejection', (reason) => die(`Unhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}`));
  process.on('uncaughtException', (error) => die(`Uncaught exception: ${error.stack}`));
}
