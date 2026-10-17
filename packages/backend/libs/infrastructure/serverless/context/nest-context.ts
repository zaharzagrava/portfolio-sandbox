import { INestApplicationContext, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

const contexts = new Map<Type<unknown>, Promise<INestApplicationContext>>();

/**
 * For handlers that need the domain services: the Nest application context
 * is created ONCE per container (module scope, outside the handler) and
 * reused by every warm invocation - cold start pays DI + DB connect once.
 * Small handlers (thumbnails) skip Nest entirely.
 *
 * A failed initialisation is not cached, and only the failing attempt's own entry is removed: a later attempt that
 * already replaced it keeps its entry, and another module's context is never touched (S55 AS-47).
 */
export function nestContext(
  module: Type<unknown>,
  options: { dbPoolMax?: number } = {},
): Promise<INestApplicationContext> {
  let ctx = contexts.get(module);
  if (!ctx) {
    // Connection arithmetic: concurrency × pool is the database budget, so the manifest's `dbPoolMax` sets the pool.
    if (options.dbPoolMax !== undefined)
      process.env.DB_POOL_MAX = String(options.dbPoolMax);
    const created = NestFactory.createApplicationContext(module, {
      bufferLogs: true,
      abortOnError: false,
    });
    ctx = created;
    created.catch(() => {
      if (contexts.get(module) === created) contexts.delete(module);
    });
    contexts.set(module, created);
  }
  return ctx;
}

/** Closes and forgets every cached context (tests, graceful shutdown of the local runner). */
export async function closeNestContexts(): Promise<void> {
  const open = [...contexts.values()];
  contexts.clear();
  await Promise.all(
    open.map((c) => c.then((x) => x.close()).catch(() => undefined)),
  );
}
