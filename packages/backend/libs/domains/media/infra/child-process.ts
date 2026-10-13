import { spawn } from 'node:child_process';

/** Memory kept per child (S30 FR-027, AS-25): the last 4 KB of standard error and at most 1 MB of standard output. */
export const MAX_STDERR_TAIL = 4 * 1024;
export const MAX_STDOUT = 1024 * 1024;

export class ChildTimeoutError extends Error {
  constructor(
    readonly command: string,
    readonly timeoutMs: number,
  ) {
    super(`${command} did not finish in ${timeoutMs} ms and was killed`);
    this.name = 'ChildTimeoutError';
  }
}

export class ChildAbortedError extends Error {
  constructor(readonly command: string) {
    super(`${command} was killed because the run was aborted`);
    this.name = 'ChildAbortedError';
  }
}

export class ChildExitError extends Error {
  constructor(
    readonly command: string,
    /** Exit code, or null when it was killed by a signal / could not start. */
    readonly exitCode: number | null,
    /** The last bytes of standard error (at most 4 KB): internal, never returned to a caller. */
    readonly stderrTail: string,
  ) {
    super(`${command} exited with ${exitCode ?? 'no code'}`);
    this.name = 'ChildExitError';
  }
}

export interface RunOptions {
  command: string;
  /** One argv entry per element; there is no shell, so nothing here is ever interpreted. */
  args: string[];
  timeoutMs: number;
  signal?: AbortSignal;
  cwd?: string;
}

export interface RunResult {
  stdout: string;
  stderrTail: string;
  pid: number | undefined;
}

/**
 * Runs a child with an argument list (no shell), kills it with SIGKILL on timeout or abort and waits for it to be
 * gone, and keeps memory bounded however much the child writes. Rejects with a typed error: `ChildTimeoutError`,
 * `ChildAbortedError` or `ChildExitError`.
 */
export function runBounded(options: RunOptions): Promise<RunResult> {
  const { command, args, timeoutMs, signal } = options;
  return new Promise<RunResult>((resolve, reject) => {
    if (signal?.aborted) return reject(new ChildAbortedError(command));
    const child = spawn(command, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: options.cwd,
      // Explicit, so the binary is looked up on the PATH of this process as it is now (a test puts a stub first).
      env: process.env,
    });
    let stdout = '';
    let stdoutBytes = 0;
    let stderrTail = '';
    let cause: 'timeout' | 'abort' | null = null;

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= MAX_STDOUT) return; // drain, keep nothing
      const room = MAX_STDOUT - stdoutBytes;
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
      stdoutBytes += kept.length;
      stdout += kept.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(
        -MAX_STDERR_TAIL,
      );
    });

    const kill = (why: 'timeout' | 'abort') => {
      cause ??= why;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => kill('timeout'), timeoutMs);
    const onAbort = () => kill('abort');
    signal?.addEventListener('abort', onAbort, { once: true });

    const settle = (fn: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    // 'error' fires when the binary cannot be started (missing, not executable); no 'close' follows.
    child.on('error', (error) =>
      settle(() =>
        reject(
          new ChildExitError(command, null, `${error.name}: ${error.message}`),
        ),
      ),
    );
    // 'close' (not 'exit') fires after the pipes ended: the process is gone and its output complete.
    child.on('close', (code) =>
      settle(() => {
        if (cause === 'timeout')
          return reject(new ChildTimeoutError(command, timeoutMs));
        if (cause === 'abort') return reject(new ChildAbortedError(command));
        if (code !== 0)
          return reject(new ChildExitError(command, code, stderrTail));
        resolve({ stdout, stderrTail, pid: child.pid });
      }),
    );
  });
}

/** True when no process with this pid exists any more (test helper for "killed and gone from the process table"). */
export function isProcessGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}
