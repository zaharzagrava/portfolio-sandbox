import { Logger } from '@nestjs/common';

/**
 * Everything the process logged while `run` ran (the Nest logger and the console), to prove what never reaches a log.
 * The spies are restored when `run` ends, so `run` must wait for the asynchronous work it starts (workers, queues).
 */
export async function capturingLogs<T>(
  run: () => Promise<T>,
): Promise<{ result: T; logged: string }> {
  const lines: string[] = [];
  const record = (...args: unknown[]) => {
    lines.push(
      args
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' '),
    );
  };
  const spies = (
    ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const
  ).map((method) =>
    jest.spyOn(Logger.prototype, method).mockImplementation(record as never),
  );
  const consoleSpies = (['log', 'info', 'warn', 'error'] as const).map(
    (method) => jest.spyOn(console, method).mockImplementation(record),
  );
  try {
    return { result: await run(), logged: lines.join('\n') };
  } finally {
    [...spies, ...consoleSpies].forEach((s) => s.mockRestore());
  }
}
