import { ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { ChildConfig } from './child-app';

export interface ChildEvent {
  event: string;
  t: number;
  [key: string]: unknown;
}

export interface Child {
  proc: ChildProcess;
  config: ChildConfig;
  events: ChildEvent[];
  stderr: string;
  exit: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    at: number;
  }>;
  /** Resolves with the first event (already seen or future) matching the predicate. */
  waitFor(
    match: (e: ChildEvent) => boolean,
    timeoutMs?: number,
  ): Promise<ChildEvent>;
  waitForEvent(event: string, timeoutMs?: number): Promise<ChildEvent>;
  log(messagePart: string): ChildEvent | undefined;
  kill(signal?: NodeJS.Signals): void;
  url(path: string): string;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

const APP_ROOT = join(__dirname, '..', '..');

/** Spawns `child-app.ts` with real `ts-node`; the caller waits for the event it needs (`listening`, `started`, exit). */
export async function startChild(
  partial: Partial<ChildConfig> & Pick<ChildConfig, 'mode'>,
): Promise<Child> {
  const config: ChildConfig = {
    port: await freePort(),
    drainDelayMs: 200,
    requestDrainMs: 500,
    hardTimeoutMs: 1_500,
    ...partial,
  };
  const proc = spawn(
    process.execPath,
    [
      '-r',
      'ts-node/register/transpile-only',
      '-r',
      'tsconfig-paths/register',
      join(APP_ROOT, 'test/toolkit/child-app.ts'),
    ],
    {
      cwd: APP_ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        CHILD_CONFIG: JSON.stringify(config),
        TS_NODE_PROJECT: join(APP_ROOT, 'tsconfig.json'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const events: ChildEvent[] = [];
  const listeners = new Set<() => void>();
  let buffer = '';
  let stderr = '';
  proc.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      try {
        events.push(JSON.parse(line) as ChildEvent);
      } catch {
        events.push({ event: 'raw', t: Date.now(), line });
      }
    }
    listeners.forEach((l) => l());
  });
  proc.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
    child.stderr = stderr;
  });

  const exit = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    at: number;
  }>((resolve) => {
    proc.once('exit', (code, signal) => {
      listeners.forEach((l) => l());
      resolve({ code, signal, at: Date.now() });
    });
  });

  const waitFor = (match: (e: ChildEvent) => boolean, timeoutMs = 45_000) =>
    new Promise<ChildEvent>((resolve, reject) => {
      const check = () => {
        const found = events.find(match);
        if (found) {
          listeners.delete(check);
          clearTimeout(timer);
          resolve(found);
        } else if (proc.exitCode !== null || proc.signalCode !== null) {
          listeners.delete(check);
          clearTimeout(timer);
          reject(
            new Error(
              `child exited (code ${proc.exitCode}) before the event; seen: ${events.map((e) => e.event + (e.msg ? `(${String(e.msg).slice(0, 300)})` : '')).join(', ')}\nstderr: ${stderr.slice(0, 2_000)}`,
            ),
          );
        }
      };
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(
          new Error(
            `timed out waiting for a child event; seen: ${events.map((e) => e.event + (e.msg ? `(${String(e.msg).slice(0, 60)})` : '')).join(', ')}\nstderr: ${stderr.slice(0, 2_000)}`,
          ),
        );
      }, timeoutMs);
      listeners.add(check);
      check();
    });

  const child: Child = {
    proc,
    config,
    events,
    stderr,
    exit,
    waitFor,
    waitForEvent: (event, timeoutMs) =>
      waitFor((e) => e.event === event, timeoutMs),
    log: (part) =>
      events.find((e) => e.event === 'log' && String(e.msg).includes(part)),
    kill: (signal = 'SIGTERM') => void proc.kill(signal),
    url: (path) => `http://127.0.0.1:${config.port}${path}`,
  };
  return child;
}

/** Index of the first event matching, to assert order. */
export const indexOf = (child: Child, match: (e: ChildEvent) => boolean) =>
  child.events.findIndex(match);
