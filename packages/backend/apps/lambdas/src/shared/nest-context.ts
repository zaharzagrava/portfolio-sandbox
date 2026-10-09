import { INestApplicationContext, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

const contexts = new Map<Type<unknown>, Promise<INestApplicationContext>>();

/**
 * For handlers that need the domain services: the Nest application context
 * is created ONCE per container (module scope, outside the handler) and
 * reused by every warm invocation - cold start pays DI + DB connect once.
 * Small handlers (thumbnails) skip Nest entirely.
 */
export function nestContext(
  module: Type<unknown>,
): Promise<INestApplicationContext> {
  let ctx = contexts.get(module);
  if (!ctx) {
    ctx = NestFactory.createApplicationContext(module, {
      bufferLogs: true,
      abortOnError: false,
    });
    ctx.catch(() => contexts.delete(module)); // a failed init must not poison the warm container
    contexts.set(module, ctx);
  }
  return ctx;
}
