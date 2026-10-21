// e2e specs always run against docker-compose.test.yaml (D5); ApiConfigService
// loads `.env.test` when NODE_ENV=test (copy env/test.env.example).
process.env.NODE_ENV = 'test';
// The scripted model provider is never selected by a missing key (S46 AS-74): specs choose it explicitly.
process.env.LLM_PROVIDER ??= 'scripted';

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

resetSharedProcessState();
const afterAllHook = (globalThis as { afterAll?: (fn: () => void) => void }).afterAll;
afterAllHook?.(resetSharedProcessState);
