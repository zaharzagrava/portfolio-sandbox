import { Logger } from '@nestjs/common';
import { Clock } from '@app/common/core/clock';
import { keyDigest, keyNamespace } from './cache-key';

const MAX_LIMITER_ENTRIES = 1_000;

/**
 * Toolkit logging (FR-043): every line carries the namespace and an 8-hex key digest, plus the request id when one
 * is active; never a full key or a value. Warnings are rate-limited per namespace and category on the injected clock.
 */
export class CacheLog {
  private readonly logger = new Logger('CacheToolkit');
  private readonly lastAt = new Map<string, number>();

  constructor(
    private readonly clock: Clock,
    private readonly requestId: () => string | undefined = () => undefined,
  ) {}

  /** A warning at most once per `intervalMs` for the same namespace and category. */
  warnLimited(
    namespace: string,
    category: string,
    intervalMs: number,
    message: string,
    key?: string,
  ): void {
    const limiter = `${namespace}|${category}`;
    const now = this.clock.nowMs();
    const last = this.lastAt.get(limiter);
    if (last !== undefined && now - last < intervalMs) return;
    if (this.lastAt.size >= MAX_LIMITER_ENTRIES && last === undefined)
      this.lastAt.delete(this.lastAt.keys().next().value as string);
    this.lastAt.set(limiter, now);
    this.logger.warn(this.format(message, namespace, key));
  }

  /** State changes (breaker transitions, reconnects); callers guarantee one call per change. */
  info(message: string, namespace?: string, key?: string): void {
    this.logger.log(this.format(message, namespace, key));
  }

  /** The namespace of a key, for callers that only hold the key. */
  namespaceOf(key: string): string {
    return keyNamespace(key);
  }

  private format(message: string, namespace?: string, key?: string): string {
    const parts = [message];
    if (namespace) parts.push(`namespace=${namespace}`);
    if (key) parts.push(`key=${keyDigest(key)}`);
    const requestId = this.requestId();
    if (requestId) parts.push(`requestId=${requestId}`);
    return parts.join(' ');
  }
}
