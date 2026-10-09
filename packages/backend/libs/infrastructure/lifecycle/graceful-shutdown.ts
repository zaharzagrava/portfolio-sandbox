import {
  INestApplication,
  INestApplicationContext,
  Logger,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { writeSync } from 'node:fs';
import { sleep } from '@app/common/core/backoff';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { Environment } from '@app/common/types';
import { ReadinessService } from '@app/infrastructure/health/readiness.service';
import {
  mergeShutdownConfig,
  resolveShutdownConfig,
  ShutdownConfig,
} from './shutdown-config';
import { ShutdownRegistry } from './shutdown-registry.service';

export { installCrashHandlers } from './crash-handlers';

export interface GracefulShutdownOptions {
  /** Overrides on top of the validated configuration (tests use tiny values). */
  config?: Partial<ShutdownConfig>;
  /** Test seam; defaults to `process.exit`. */
  exit?: (code: number) => void;
}

const logger = new Logger('GracefulShutdown');

type App = INestApplication | INestApplicationContext;

function httpServerOf(app: App): Server | undefined {
  return 'getHttpServer' in app ? (app.getHttpServer() as Server) : undefined;
}

function optional<T>(
  app: App,
  token: new (...args: never[]) => T,
): T | undefined {
  try {
    // Through ModuleRef: `app.get` runs in Nest's exception zone, which exits the process on a missing provider.
    return app.get(ModuleRef).get(token, { strict: false });
  } catch {
    return undefined;
  }
}

/**
 * Timings come from the validated configuration (`shutdown_*`, `server_*` keys); locally there is no load balancer to
 * wait for, and a drain delay made `nest start --watch` spawn the new process while the old one still held the port.
 */
export function resolveShutdownConfigFor(
  app: App,
  overrides: Partial<ShutdownConfig> = {},
): ShutdownConfig {
  const config = optional(app, ApiConfigService);
  const local =
    config !== undefined &&
    [Environment.local, Environment.test].includes(config.get('node_env'));
  const fromConfig = config
    ? resolveShutdownConfig({
        shutdown_drain_delay_ms: config.get('shutdown_drain_delay_ms'),
        shutdown_request_drain_ms: config.get('shutdown_request_drain_ms'),
        shutdown_hard_timeout_ms: config.get('shutdown_hard_timeout_ms'),
        server_keep_alive_ms: config.get('server_keep_alive_ms'),
        server_headers_timeout_ms: config.get('server_headers_timeout_ms'),
        server_request_timeout_ms: config.get('server_request_timeout_ms'),
      })
    : undefined;
  const base: Partial<ShutdownConfig> = { ...fromConfig };
  if (local && config?.get('shutdown_drain_delay_ms') === undefined)
    base.drainDelayMs = 0;
  return mergeShutdownConfig({ ...base, ...overrides });
}

/** Keep-alive above the load balancer idle timeout and headers above keep-alive, or the balancer reuses sockets Node just closed. */
export function applyServerTimeouts(
  server: Server,
  config: ShutdownConfig,
): void {
  server.keepAliveTimeout = config.keepAliveMs;
  server.headersTimeout = config.headersTimeoutMs;
  server.requestTimeout = config.requestTimeoutMs;
}

/**
 * Builds the shutdown sequence (S54 FR-038): mark not-ready → drain delay → stop accepting and close idle sockets →
 * let in-flight requests finish up to the request-drain deadline, then destroy their sockets → registry tasks in
 * ascending order → `app.close()` → exit. `drain`-phase tasks start together with the HTTP drain. A later signal is
 * ignored; the hard timeout ends the process with `1` and `forced shutdown`.
 */
export function createGracefulShutdown(
  app: App,
  {
    config: overrides,
    exit = (code) => process.exit(code),
  }: GracefulShutdownOptions = {},
): (signal: string) => Promise<void> {
  const config = resolveShutdownConfigFor(app, overrides);
  const server = httpServerOf(app);
  let shuttingDown = false;
  const inFlight = new Set<ServerResponse>();

  server?.on('request', (_req: IncomingMessage, res: ServerResponse) => {
    if (shuttingDown) res.setHeader('Connection', 'close');
    inFlight.add(res);
    const release = () => inFlight.delete(res);
    res.once('finish', release);
    res.once('close', release);
  });

  return async (signal: string) => {
    if (shuttingDown) {
      logger.log(`shutdown_signal_ignored signal=${signal}`);
      return;
    }
    shuttingDown = true;
    logger.log(`shutdown_begin signal=${signal}`);

    const hardTimer = setTimeout(() => {
      try {
        writeSync(2, `forced shutdown: exceeded ${config.hardTimeoutMs}ms\n`);
      } catch {
        // stderr closed
      }
      logger.error(
        `forced shutdown: sequence exceeded ${config.hardTimeoutMs}ms`,
      );
      exit(1);
    }, config.hardTimeoutMs);
    hardTimer.unref();

    const registry = optional(app, ShutdownRegistry);
    registry?.begin();
    let failed = false;

    try {
      optional(app, ReadinessService)?.markShuttingDown();
      for (const res of inFlight)
        if (!res.headersSent) res.setHeader('Connection', 'close');
      logger.log('shutdown_not_ready');

      await sleep(config.drainDelayMs);
      logger.log('shutdown_drain_delay_elapsed');

      const drainTasks = registry?.run('drain');
      if (server) await drainHttp(server, inFlight, config.requestDrainMs);
      const drained = await drainTasks;
      if (drained?.failed.length) failed = true;
      logger.log('shutdown_inflight_drained');

      const stopped = await registry?.run('stop');
      if (stopped?.failed.length) failed = true;
      logger.log('shutdown_tasks_done');

      await app.close(); // Nest hooks (onApplicationShutdown) and the Nest-owned HTTP adapter
    } catch (error) {
      failed = true;
      logger.error(
        `Graceful shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    logger.log(`shutdown_complete exit=${failed ? 1 : 0}`);
    exit(failed ? 1 : 0);
  };
}

async function drainHttp(
  server: Server,
  inFlight: Set<ServerResponse>,
  requestDrainMs: number,
): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  logger.log('shutdown_server_closed');

  const deadline = new AbortController();
  const timedOut = await Promise.race([
    closed.then(() => false),
    sleep(requestDrainMs, deadline.signal).then(
      () => true,
      () => false, // aborted because the drain finished first
    ),
  ]);
  deadline.abort();
  if (timedOut) {
    logger.warn(`shutdown_request_drain_timeout count=${inFlight.size}`);
    server.closeAllConnections();
    await closed;
  }
}

/**
 * The single owner of process signals (S54 FR-047): replaces `app.enableShutdownHooks()`, which must not be used
 * next to it. Also applies the server timeouts.
 */
export function installGracefulShutdown(
  app: App,
  options: GracefulShutdownOptions = {},
): { shutdown: (signal: string) => Promise<void> } {
  const server = httpServerOf(app);
  if (server)
    applyServerTimeouts(server, resolveShutdownConfigFor(app, options.config));
  const shutdown = createGracefulShutdown(app, options);
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  return { shutdown };
}
