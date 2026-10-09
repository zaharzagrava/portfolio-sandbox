/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion -- ClsService is typed `any` for the lint project but strictly for tsc; the casts are required by tsc */
import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { AppClsStore } from '@app/common/request-context/types';

const MEMO_KEY = '__memo';
const ENVELOPE_KEYS = [
  'requestId',
  'userId',
  'shopId',
  'roles',
  'principalType',
  'clientIp',
  'traceparent',
  'deadlineAt',
] as const;

/**
 * Typed facade over the CLS store. Outside an HTTP/consumer context (e.g. a
 * bootstrap script) `isActive()` is false and getters return undefined
 * instead of throwing.
 */
@Injectable()
export class RequestContext {
  constructor(private readonly cls: ClsService<AppClsStore>) {}

  isActive(): boolean {
    return this.cls.isActive();
  }

  get requestId(): string | undefined {
    return this.isActive() ? this.cls.get('requestId') : undefined;
  }

  get userId(): string | undefined {
    return this.isActive() ? this.cls.get('userId') : undefined;
  }

  get shopId(): string | undefined {
    return this.isActive() ? this.cls.get('shopId') : undefined;
  }

  /**
   * Sets one envelope field; a no-op outside a context. `shopId` is set once: re-setting the same value is a
   * no-op, a different value is a programmer error (a request cannot change tenant half way).
   */
  set<K extends keyof AppClsStore>(key: K, value: AppClsStore[K]): void {
    if (!this.isActive()) return;
    if (key === 'shopId') {
      const current = this.cls.get('shopId');
      if (current !== undefined && current !== value)
        throw new Error(
          'shopId is already set to a different value in this context',
        );
    }
    this.cls.set(key, value);
  }

  /** A copy of the envelope fields, for handing context to work that runs outside the async chain (jobs, messages). */
  snapshot(): Partial<AppClsStore> {
    if (!this.isActive()) return {};
    const out: Record<string, unknown> = {};
    for (const key of ENVELOPE_KEYS) {
      const value = this.cls.get(key);
      if (value !== undefined)
        out[key] = Array.isArray(value) ? [...value] : value;
    }
    return out;
  }

  /** Runs `factory` once per context for `key` and returns the same result afterwards. */
  async memo<T>(key: string, factory: () => Promise<T> | T): Promise<T> {
    if (!this.isActive()) return factory();
    let store = this.cls.get(MEMO_KEY as keyof AppClsStore) as
      Map<string, Promise<T>> | undefined;
    if (!store) {
      store = new Map();
      this.cls.set(MEMO_KEY as keyof AppClsStore, store as never);
    }
    let entry = store.get(key);
    if (!entry) {
      entry = Promise.resolve().then(factory);
      store.set(key, entry);
    }
    return entry;
  }

  /**
   * Runs `fn` in a fresh context - used by Kafka/SQS consumers and jobs so each
   * message gets its own requestId/tenant just like an HTTP request does.
   */
  run<T>(initial: Partial<AppClsStore>, fn: () => Promise<T>): Promise<T> {
    return this.cls.run(async () => {
      for (const [key, value] of Object.entries(initial)) {
        this.cls.set(key as keyof AppClsStore, value as never);
      }
      return fn();
    });
  }
}
