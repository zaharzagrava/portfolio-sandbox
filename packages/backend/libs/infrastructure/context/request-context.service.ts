import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { AppClsStore } from '@app/common/request-context/types';

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

  set<K extends keyof AppClsStore>(key: K, value: AppClsStore[K]): void {
    if (this.isActive()) this.cls.set(key, value);
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
