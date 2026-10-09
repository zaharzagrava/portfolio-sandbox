import { writeSync } from 'node:fs';
import { INestApplicationContext, Logger } from '@nestjs/common';
import {
  BackoffOptions,
  fullJitterBackoff,
  sleep,
} from '@app/common/core/backoff';
import { StartupService } from '@app/infrastructure/health/startup.service';

export interface Warmup {
  name: string;
  /** Throws while the dependency is not usable yet; retried with jittered backoff until the startup deadline. */
  fn: () => Promise<void>;
}

export interface BootstrapOptions<App extends INestApplicationContext> {
  /** Runs first; a throw ends the process with `1` before anything listens (the message names keys, never values). */
  validateConfig: () => void | Promise<void>;
  create: () => Promise<App>;
  configure?: (app: App) => void | Promise<void>;
  listen?: (app: App) => Promise<void>;
  warmups?: Warmup[];
  /** Default 30 s: past it the process exits `1` instead of hanging half-started. */
  startupDeadlineMs?: number;
  retry?: BackoffOptions;
  /** Test seams. */
  exit?: (code: number) => void;
  random?: () => number;
}

const logger = new Logger('Bootstrap');
const DEFAULT_DEADLINE_MS = 30_000;
const DEFAULT_RETRY: BackoffOptions = { baseMs: 250, maxMs: 4_000 };

function fatal(message: string, exit: (code: number) => void): void {
  try {
    writeSync(2, `${message}\n`);
  } catch {
    // stderr closed
  }
  try {
    logger.error(message);
  } catch {
    // the logger must never prevent the exit
  }
  exit(1);
}

/**
 * Startup order (S54 FR-043): validate configuration → create the app → add warm-ups (dependencies retried with
 * jittered backoff) → listen → `/startupz` turns `200` when every warm-up finished. Invalid configuration or an
 * exceeded deadline exits `1`. Migrations and schema sync never run here (constitution III.11).
 */
export async function bootstrapApp<App extends INestApplicationContext>(
  options: BootstrapOptions<App>,
): Promise<App | undefined> {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const deadlineMs = options.startupDeadlineMs ?? DEFAULT_DEADLINE_MS;
  const retry = options.retry ?? DEFAULT_RETRY;

  try {
    await options.validateConfig();
  } catch (error) {
    fatal(
      `startup failed: ${error instanceof Error ? error.message : String(error)}`,
      exit,
    );
    return undefined;
  }

  let expired = false;
  const deadline = setTimeout(() => {
    expired = true;
    fatal(`startup deadline exceeded after ${deadlineMs}ms`, exit);
  }, deadlineMs);

  try {
    const app = await options.create();
    await options.configure?.(app);

    const startup = app.get(StartupService, { strict: false });
    for (const warmup of options.warmups ?? []) {
      startup.addWarmup(warmup.name, async () => {
        for (let attempt = 0; !expired; attempt++) {
          try {
            await warmup.fn();
            return;
          } catch (error) {
            const waitMs = fullJitterBackoff(attempt, retry, options.random);
            logger.warn(
              `warm-up "${warmup.name}" failed (attempt ${attempt + 1}): ${error instanceof Error ? error.message : String(error)}; retrying in ${waitMs}ms`,
            );
            await sleep(waitMs);
          }
        }
      });
    }

    await options.listen?.(app);
    await startup.whenStarted();
    if (expired) return undefined;
    logger.log('startup complete');
    return app;
  } catch (error) {
    fatal(
      `startup failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      exit,
    );
    return undefined;
  } finally {
    clearTimeout(deadline);
  }
}
