import { ChannelProvider, type SendResult } from '../domain/provider-ports';
import { PermanentDeliveryError, type DeliveryMessage } from '../domain/types';

type Mode = 'ok' | 'transient' | 'hang' | 'permanent';

/**
 * A provider at the SDK boundary that a spec scripts: succeed, fail transiently, hang until released, or fail
 * permanently. The chain, the breaker, the timeout and the retries run for real above it; only the vendor call is
 * replaced. Every call is recorded (`calls`) with the message it received.
 */
export class ScriptedProvider extends ChannelProvider {
  readonly calls: DeliveryMessage[] = [];
  private mode: Mode = 'ok';
  private failuresLeft = 0;
  private latencyMs = 0;
  private suppress: string[] = [];
  private reason = 'permanent failure';
  private pending: Array<{
    message: DeliveryMessage;
    resolve: (r: SendResult) => void;
    reject: (e: Error) => void;
  }> = [];

  constructor(
    readonly name: string,
    readonly channel: DeliveryMessage['channel'],
    private readonly result: Partial<SendResult> = {},
  ) {
    super();
  }

  /** Fails the next `times` calls with a transient error (any error that is not `PermanentDeliveryError`). */
  failNext(times = 1): this {
    this.failuresLeft = times;
    return this;
  }

  failAlways(): this {
    this.mode = 'transient';
    return this;
  }

  /** The next calls never answer until `release()` (or the caller's timeout). */
  hang(): this {
    this.mode = 'hang';
    return this;
  }

  /** The provider says this address will never work (`PermanentDeliveryError`, optionally naming addresses to suppress). */
  failPermanently(suppress: string[] = [], reason = 'permanent failure'): this {
    this.mode = 'permanent';
    this.suppress = suppress;
    this.reason = reason;
    return this;
  }

  /** Every successful call answers after `ms` (a provider with latency). */
  slow(ms: number): this {
    this.latencyMs = ms;
    return this;
  }

  /** Answers every hanging call with success. */
  release(): void {
    for (const p of this.pending.splice(0)) p.resolve(this.ok(p.message));
  }

  /** Back to answering `ok`, forgetting scripted failures; the call log is kept. */
  heal(): this {
    this.mode = 'ok';
    this.failuresLeft = 0;
    this.suppress = [];
    this.reason = 'permanent failure';
    this.latencyMs = 0;
    this.release();
    return this;
  }

  /** Forgets everything, including the call log. */
  reset(): this {
    this.heal();
    this.calls.length = 0;
    return this;
  }

  callsTo(address: string): DeliveryMessage[] {
    return this.calls.filter((m) => m.to.includes(address));
  }

  private ok(message: DeliveryMessage): SendResult {
    return {
      provider: this.name,
      providerMessageId: `${this.name}-${message.deliveryId}`,
      ...this.result,
    };
  }

  send(message: DeliveryMessage): Promise<SendResult> {
    this.calls.push(message);
    if (this.mode === 'permanent')
      return Promise.reject(
        new PermanentDeliveryError(
          `${this.name}: ${this.reason}`,
          this.suppress,
        ),
      );
    if (this.mode === 'transient' || this.failuresLeft > 0) {
      if (this.failuresLeft > 0) this.failuresLeft--;
      return Promise.reject(new Error(`${this.name}: transient failure`));
    }
    if (this.mode === 'hang')
      return new Promise((resolve, reject) =>
        this.pending.push({ message, resolve, reject }),
      );
    if (this.latencyMs > 0)
      return new Promise((resolve) =>
        setTimeout(() => resolve(this.ok(message)), this.latencyMs),
      );
    return Promise.resolve(this.ok(message));
  }
}
