// e2e specs always run against docker-compose.test.yaml (D5); ApiConfigService
// loads `.env.test` when NODE_ENV=test (copy env/test.env.example).
process.env.NODE_ENV = 'test';
// The scripted model provider is never selected by a missing key (S46 AS-74): specs choose it explicitly.
process.env.LLM_PROVIDER ??= 'scripted';
// The rate-limit store gets 200 ms per call by default and three slow calls open the breaker; on a busy shard machine
// that happens and (with a frozen test clock) the breaker never closes. Tests give the store a generous allowance, read
// when an app starts. Specs of the timeout itself pass storeTimeoutMs through the limiter config, not this variable.
process.env.RATE_LIMIT_STORE_TIMEOUT_MS ??= '3000';

// Expected failures (401/429 problem responses, retries) make Nest log whole stack traces and drown the signal in
// test output, which both humans and coding agents read. Keep fatal only; TEST_LOGS=1 restores the full output.
//
// Under Vitest all files can run in one process (isolate: false), so what one file leaves behind reaches the next one. Two things leaked:
//  - Nest's static logger: a file that calls `Logger.overrideLogger(<capture object>)` or `app.useLogger(<pino>)` and then only
//    `Logger.overrideLogger(['fatal'])` keeps the capture object / a closed app's logger as the global logger (an array only changes levels,
//    it never replaces the instance). The next file then logged into a dead sink and its own captured log lines were missing
//    (order-export-lifecycle AS-58 failed when it ran after such a file).
//  - a `process.stdout.write` spy that a file did not restore.
// So every file starts (and ends) from the same clean state: a fresh console logger and the real stdout/stderr writers.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConsoleLogger, Logger } from '@nestjs/common';

function resetSharedProcessState(): void {
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write as unknown as { mockRestore?: () => void };
    if (typeof write.mockRestore === 'function') write.mockRestore();
  }
  Logger.overrideLogger(new ConsoleLogger()); // replaces the instance (an array would only set levels on the old one)
  if (!process.env.TEST_LOGS) Logger.overrideLogger(['fatal']);
  else Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose', 'fatal']);
}

// nestjs-pino keeps ONE pino logger for the whole process (a module-level singleton, built by the first app that has LoggingModule).
// If that first app is a worker/projector wiring spec, the logger is bound to the real stdout and a later file's `process.stdout.write`
// spy (structuredLogger: true, rawLogs()) captures nothing. Forget the singleton at the start and end of every file so each file's
// apps build their own logger. The package does not export the reset, so it is reached by file path (both the CJS and the ESM copy).
async function resetSharedPinoLogger(): Promise<void> {
  try {
    const dir = path.dirname(require.resolve('nestjs-pino')); // .../dist/cjs
    require(path.join(dir, 'rootLogger.js')).resetRootLogger();
    const esm = await import(pathToFileURL(path.join(dir, '..', 'esm', 'rootLogger.js')).href);
    esm.resetRootLogger();
  } catch {
    /* nestjs-pino layout changed: the logging specs will show it */
  }
}

resetSharedProcessState();
const afterAllHook = (globalThis as { afterAll?: (fn: () => void) => void }).afterAll;
afterAllHook?.(resetSharedProcessState);

// process.env is shared by all files of a shard as well. A spec that sets a variable in a test and does not undo it (NODE_ENV,
// PROVIDER_DOUBLES, a rate-limit or breaker setting ...) changes the next file's app. The state right after the file's imports
// (when ApiConfigService has already loaded .env.test) is the baseline; every file ends by putting exactly that back.
const hooks = globalThis as { beforeAll?: (fn: () => void | Promise<void>) => void; afterAll?: (fn: () => void | Promise<void>) => void };
let envBaseline: NodeJS.ProcessEnv | undefined;
hooks.beforeAll?.(() => {
  envBaseline = { ...process.env };
  return resetSharedPinoLogger();
});
hooks.afterAll?.(async () => {
  await resetSharedPinoLogger();
  if (!envBaseline) return;
  for (const key of Object.keys(process.env)) if (!(key in envBaseline)) delete process.env[key];
  for (const [key, value] of Object.entries(envBaseline)) if (process.env[key] !== value) process.env[key] = value;
  envBaseline = undefined;
});
