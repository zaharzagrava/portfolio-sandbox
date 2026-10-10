import Redis from 'ioredis';
import { CacheLog } from './cache-log';

export const INVALIDATION_CHANNEL = 'cache:invalidate';

export type BroadcastMessage =
  | { kind: 'drop'; keys: string[] }
  | { kind: 'versioned'; key: string; version: number };

/** How long `start()` waits for the first subscription before the instance carries on with L1 disabled. */
const START_WAIT_MS = 2_000;

/**
 * The invalidation subscription of one instance (FR-004). L1 may only be used while `healthy`: the flag drops the
 * moment the connection does and returns only after the channel is subscribed again; `onReconnect` runs before
 * that so the owner can clear its L1 first (messages published meanwhile were lost).
 */
export class InvalidationBroadcast {
  private subscriber?: Redis;
  private ready = false;
  private everReady = false;
  private stopped = false;

  constructor(
    private readonly url: string,
    private readonly onMessage: (message: BroadcastMessage) => void,
    private readonly onReconnect: () => void,
    private readonly log: CacheLog,
  ) {}

  get healthy(): boolean {
    return this.ready && !this.stopped;
  }

  async start(): Promise<void> {
    const subscriber = new Redis(this.url, { maxRetriesPerRequest: null });
    this.subscriber = subscriber;
    let firstReady!: () => void;
    const first = new Promise<void>((resolve) => (firstReady = resolve));

    subscriber.on('error', () => undefined); // reconnection is automatic; health is tracked through close/ready
    subscriber.on('close', () => {
      if (this.ready)
        this.log.info('invalidation subscription lost; L1 bypassed');
      this.ready = false;
    });
    subscriber.on('ready', () => {
      void this.subscribe().then(firstReady);
    });
    subscriber.on('message', (_channel, payload: string) => {
      const message = parseMessage(payload);
      if (message) this.onMessage(message);
    });

    let timer: NodeJS.Timeout | undefined;
    const wait = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, START_WAIT_MS);
    });
    try {
      await Promise.race([first, wait]);
    } finally {
      clearTimeout(timer);
    }
  }

  stop(): void {
    this.stopped = true;
    this.ready = false;
    const subscriber = this.subscriber;
    this.subscriber = undefined;
    if (!subscriber) return;
    subscriber.removeAllListeners();
    subscriber.on('error', () => undefined);
    subscriber.disconnect();
  }

  private async subscribe(): Promise<void> {
    const subscriber = this.subscriber;
    if (!subscriber || this.stopped) return;
    try {
      await subscriber.subscribe(INVALIDATION_CHANNEL);
    } catch {
      return; // the next 'ready' tries again
    }
    if (this.stopped) return;
    if (this.everReady) {
      this.onReconnect();
      this.log.info('invalidation subscription restored; L1 cleared');
    }
    this.everReady = true;
    this.ready = true;
  }
}

function parseMessage(payload: string): BroadcastMessage | undefined {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (Array.isArray(parsed))
      return {
        kind: 'drop',
        keys: parsed.filter((k) => typeof k === 'string'),
      };
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { key?: unknown }).key === 'string' &&
      Number.isSafeInteger((parsed as { version?: unknown }).version)
    ) {
      const { key, version } = parsed as { key: string; version: number };
      return { kind: 'versioned', key, version };
    }
  } catch {
    // a malformed message is ignored
  }
  return undefined;
}

export const encodeDrop = (keys: string[]): string => JSON.stringify(keys);
export const encodeVersionedDrop = (key: string, version: number): string =>
  JSON.stringify({ key, version });
