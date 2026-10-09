/**
 * Returns parked outbox rows to pending with attempts 0 (S53 FR-017, operator).
 *
 *   pnpm outbox:requeue --id <rowId>
 *   pnpm outbox:requeue [--type <event.type>] [--older-than-minutes <n>]
 *
 * A row is parked after 10 failed publish attempts or when the broker rejects the message as invalid. Requeue only
 * after the cause is fixed (broker reachable, message size, topic exists).
 */
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ApiConfigModule } from '@app/common/config';
import { DatabaseModule } from '@app/infrastructure/database';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';

export function parseRequeueArgs(
  argv: string[],
  now: Date,
): string | { type?: string; olderThan?: Date } {
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const id = value('--id');
  if (id) return id;
  const minutes = value('--older-than-minutes');
  if (minutes !== undefined && !/^\d+$/.test(minutes))
    throw new Error('--older-than-minutes must be a non-negative integer');
  const type = value('--type');
  return {
    ...(type && { type }),
    ...(minutes !== undefined && { olderThan: new Date(now.getTime() - Number(minutes) * 60_000) }),
  };
}

@Module({ imports: [ApiConfigModule, DatabaseModule, EventsModule] })
class RequeueModule {}

async function main() {
  const selector = parseRequeueArgs(process.argv.slice(2), new Date());
  const app = await NestFactory.createApplicationContext(RequeueModule, { logger: ['error', 'warn'] });
  try {
    const requeued = await app.get(OutboxService).requeueParked(selector);
    console.log(`requeued ${requeued} parked outbox row(s)`);
  } finally {
    await app.close();
  }
}

if (require.main === module)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
