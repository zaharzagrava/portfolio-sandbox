import { writeSync } from 'node:fs';
import { inspect } from 'node:util';
import { Logger } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';

export interface CrashHandlerOptions {
  /** Test seam; defaults to `process.exit`. */
  exit?: (code: number) => void;
  /** How long the structured logger gets to flush before the exit (the stderr line is already written). */
  flushMs?: number;
}

const logger = new Logger('CrashHandlers');
let installed:
  | {
      rejection: (reason: unknown) => void;
      exception: (error: unknown) => void;
    }
  | undefined;

/** Stack for errors, the text for strings, `undefined`/inspect output for anything else: a crash must always say why. */
export function describeCrashReason(reason: unknown): string {
  if (reason instanceof Error)
    return reason.stack ?? `${reason.name}: ${reason.message}`;
  if (typeof reason === 'string') return reason;
  return inspect(reason);
}

function currentRequestId(): string | undefined {
  try {
    return ClsServiceManager.getClsService().get('requestId');
  } catch {
    return undefined;
  }
}

/**
 * Anything reaching these handlers is a programmer error or corrupted state: write the cause synchronously to stderr
 * (the structured logger is asynchronous and would lose it), log it, and exit `1` without draining so the supervisor
 * restarts a clean process (S54 FR-042).
 */
export function installCrashHandlers({
  exit = (code) => process.exit(code),
  flushMs = 100,
}: CrashHandlerOptions = {}): void {
  if (installed) {
    process.off('unhandledRejection', installed.rejection);
    process.off('uncaughtException', installed.exception);
  }

  let dying = false;
  const die = (kind: string, reason: unknown) => {
    if (dying) return;
    dying = true;
    const requestId = currentRequestId();
    const message = `${kind}: ${describeCrashReason(reason)}${requestId ? ` (requestId ${requestId})` : ''}`;
    try {
      writeSync(2, `${message}\n`);
    } catch {
      // stderr closed: nothing left to do but exit
    }
    try {
      logger.error(message);
    } catch {
      // the logger must never prevent the exit
    }
    setTimeout(() => exit(1), flushMs);
  };

  installed = {
    rejection: (reason) => die('Unhandled rejection', reason),
    exception: (error) => die('Uncaught exception', error),
  };
  process.on('unhandledRejection', installed.rejection);
  process.on('uncaughtException', installed.exception);
}
