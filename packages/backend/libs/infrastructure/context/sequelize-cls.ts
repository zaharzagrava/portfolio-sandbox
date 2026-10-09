import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { Sequelize } from 'sequelize';

/**
 * Sequelize 6 auto-propagates the current transaction to every query inside
 * `sequelize.transaction(async () => ...)` when given a CLS namespace exposing
 * `run/get/set/bind` (originally cls-hooked). This shim implements that
 * contract on top of AsyncLocalStorage, so services can compose inside one
 * transaction without passing `{ transaction }` through every call.
 *
 * Each `run` copies the parent store, so a nested transaction sees its own
 * value while the outer one is restored after it finishes.
 */
const storage = new AsyncLocalStorage<Map<string, unknown>>();

export const sequelizeClsNamespace = {
  run<T>(fn: (context: Map<string, unknown>) => T): T {
    const parent = storage.getStore();
    const context = new Map(parent);
    return storage.run(context, () => fn(context));
  },
  get(key: string): unknown {
    return storage.getStore()?.get(key);
  },
  set(key: string, value: unknown): void {
    storage.getStore()?.set(key, value);
  },
  bind<F extends (...args: unknown[]) => unknown>(fn: F): F {
    return AsyncResource.bind(fn);
  },
};

let enabled = false;

/** Idempotent; must run before the first managed transaction starts. */
export function enableSequelizeCls(): void {
  if (enabled) return;
  Sequelize.useCLS(sequelizeClsNamespace);
  enabled = true;
}
