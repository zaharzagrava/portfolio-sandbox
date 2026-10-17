import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { configureTelemetry } from '../telemetry/telemetry';
import type { SqsRecord } from '../batch/sqs-types';

/** A clock a test moves by hand (epoch milliseconds). */
export class FakeClock {
  constructor(public current = Date.parse('2026-01-01T00:00:00Z')) {}
  now = (): number => this.current;
  advance(ms: number): void {
    this.current += ms;
  }
}

export interface Capture {
  lines: string[];
  json(): Record<string, any>[];
  logs(message?: string): Record<string, any>[];
  metrics(name?: string): Record<string, any>[];
  restore(): void;
}

/** Capture the log and metric lines written through the toolkit (the output stream), optionally on a fake clock. */
export function captureTelemetry(clock?: FakeClock): Capture {
  const lines: string[] = [];
  const restore = configureTelemetry({
    write: (line) => void lines.push(line),
    ...(clock && { now: clock.now }),
  });
  const json = () => lines.map((l) => JSON.parse(l) as Record<string, any>);
  return {
    lines,
    json,
    logs: (message) =>
      json().filter(
        (l) => l._aws === undefined && (!message || l.message === message),
      ),
    metrics: (name) =>
      json().filter(
        (l) =>
          l._aws !== undefined &&
          (!name || l._aws.CloudWatchMetrics[0].Metrics[0].Name === name),
      ),
    restore,
  };
}

/** Poll until `check` returns a truthy value (no fixed sleeps in specs). */
export async function waitFor<T>(
  check: () => T | Promise<T>,
  { timeoutMs = 15_000, intervalMs = 25 } = {},
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error('waitFor: condition not met');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** A promise a test settles by hand. */
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Counts effects per business key, so a test can assert "one effect". */
export class EffectCounter {
  private readonly rows: string[] = [];
  write(key: string): void {
    this.rows.push(key);
  }
  count(key?: string): number {
    return key === undefined
      ? this.rows.length
      : this.rows.filter((r) => r === key).length;
  }
}

export function sqsRecord(
  id: string,
  options: {
    group?: string;
    fifo?: boolean;
    receiveCount?: number;
    body?: string;
    queue?: string;
    attributes?: Record<string, string>;
  } = {},
): SqsRecord {
  const queue = options.queue ?? 'q';
  return {
    messageId: id,
    receiptHandle: `rh-${id}`,
    body: options.body ?? id,
    attributes: {
      ApproximateReceiveCount: String(options.receiveCount ?? 1),
      ...(options.group && { MessageGroupId: options.group }),
    },
    messageAttributes: Object.fromEntries(
      Object.entries(options.attributes ?? {}).map(([k, v]) => [
        k,
        { stringValue: v, dataType: 'String' },
      ]),
    ),
    eventSource: 'aws:sqs',
    eventSourceARN: `arn:aws:sqs:eu-central-1:000000000000:${queue}${options.fifo ? '.fifo' : ''}`,
    awsRegion: 'eu-central-1',
  };
}

/** The repository root (the directory holding `infra/`), found from this file upward. */
export function repoRoot(): string {
  let dir = __dirname;
  while (!existsSync(join(dir, 'infra', 'stack', 'main.tf'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error('repository root not found');
    dir = parent;
  }
  return dir;
}
