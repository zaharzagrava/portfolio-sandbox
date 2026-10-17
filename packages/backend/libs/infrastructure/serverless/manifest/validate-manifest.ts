import {
  DEFAULT_DB_POOL_MAX,
  dlqQueueName,
  type ManifestEntry,
} from './lambda-spec';

/** The declared database connection capacity (the RDS Proxy limit; a placeholder, one line to change). */
export const CONNECTION_BUDGET = 1000;

export interface ManifestProblem {
  function: string;
  field: string;
  message: string;
}

export class ManifestError extends Error {
  constructor(readonly problems: ManifestProblem[]) {
    super(
      `Invalid Lambda manifest: ${problems
        .map((p) => `${p.function}.${p.field}: ${p.message}`)
        .join('; ')}`,
    );
    this.name = 'ManifestError';
  }
}

/** Every rule of contracts/manifest.md, each problem naming the function and field. Expects the expanded manifest. */
export function findManifestProblems(
  entries: ManifestEntry[],
): ManifestProblem[] {
  const problems: ManifestProblem[] = [];
  const add = (fn: string, field: string, message: string) =>
    problems.push({ function: fn, field, message });
  const byQueue = new Map<string, string>();
  const byName = new Map(entries.map((e) => [e.name, e]));

  for (const e of entries) {
    if (e.visibilityTimeoutSec < 6 * e.timeoutSec)
      add(
        e.name,
        'visibilityTimeoutSec',
        `${e.visibilityTimeoutSec} s is below 6 × the function timeout (${e.timeoutSec} s = ${6 * e.timeoutSec} s)`,
      );
    if (e.fifo !== e.queue.endsWith('.fifo'))
      add(
        e.name,
        'fifo',
        `flag is ${e.fifo} but queue "${e.queue}" ${e.queue.endsWith('.fifo') ? 'has' : 'lacks'} the .fifo suffix`,
      );
    if (e.fifo && e.batchSize > 10)
      add(e.name, 'batchSize', `FIFO batch size ${e.batchSize} is above 10`);
    if (e.maxConcurrency < 2)
      add(
        e.name,
        'maxConcurrency',
        `${e.maxConcurrency} is below the platform minimum of 2`,
      );
    if (e.timeoutSec > 900)
      add(e.name, 'timeoutSec', `${e.timeoutSec} s is above 900 s`);
    if (e.memoryMb < 128 || e.memoryMb > 10240)
      add(e.name, 'memoryMb', `${e.memoryMb} MB is outside 128-10240`);
    if (e.maxReceiveCount < 1)
      add(e.name, 'maxReceiveCount', `${e.maxReceiveCount} is below 1`);
    if (e.groupId !== undefined && !e.fifo)
      add(e.name, 'groupId', 'a FIFO-only option is set on a standard queue');
    const other = byQueue.get(e.queue);
    if (other)
      add(e.name, 'queue', `"${e.queue}" is already consumed by ${other}`);
    byQueue.set(e.queue, e.name);
    if (e.deadLetterOf !== undefined) {
      const source = byName.get(e.deadLetterOf);
      if (!source || e.queue !== dlqQueueName(source.queue))
        add(
          e.name,
          'queue',
          `"${e.queue}" is not the dead-letter queue of an existing entry`,
        );
    }
  }

  const connections = entries.reduce(
    (sum, e) => sum + e.maxConcurrency * (e.dbPoolMax ?? DEFAULT_DB_POOL_MAX),
    0,
  );
  if (connections > CONNECTION_BUDGET)
    add(
      '(all)',
      'maxConcurrency × dbPoolMax',
      `sum ${connections} exceeds the connection budget ${CONNECTION_BUDGET}`,
    );
  return problems;
}

export function connectionBudgetUse(entries: ManifestEntry[]): number {
  return entries.reduce(
    (sum, e) => sum + e.maxConcurrency * (e.dbPoolMax ?? DEFAULT_DB_POOL_MAX),
    0,
  );
}

/** Throws `ManifestError` listing every problem. Run by the build, the runner at start-up and CI. */
export function validateManifest(entries: ManifestEntry[]): void {
  const problems = findManifestProblems(entries);
  if (problems.length) throw new ManifestError(problems);
}
