/**
 * Redrives the dead letters of a consumer (S53 FR-038).
 *
 *   pnpm projections:redrive --consumer <name> [--limit <n>]
 *
 * Each dead letter in `<name>.dlq` is republished to its source topic with the original key and bytes and an
 * incremented `x-redrive-count`; a letter already redriven 3 times is left in place. Progress is kept in the
 * consumer group `<name>.redrive`, so running it again only redrives dead letters written since.
 * Fix the cause first (deploy the consumer fix): a redriven message that fails again is dead-lettered again.
 */
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ApiConfigModule } from '@app/common/config';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { RedriveService } from '@app/infrastructure/projections/redrive.service';

export function parseRedriveArgs(argv: string[]): {
  consumer: string;
  limit?: number;
} {
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const consumer = value('--consumer');
  if (!consumer)
    throw new Error('usage: redrive.ts --consumer <name> [--limit <n>]');
  const limit = value('--limit');
  if (limit !== undefined && !/^[1-9]\d*$/.test(limit))
    throw new Error('--limit must be a positive integer');
  return { consumer, ...(limit !== undefined && { limit: Number(limit) }) };
}

@Module({
  imports: [ApiConfigModule, KafkaProducerModule],
  providers: [RedriveService],
})
class RedriveModule {}

async function main() {
  const { consumer, limit } = parseRedriveArgs(process.argv.slice(2));
  const app = await NestFactory.createApplicationContext(RedriveModule, {
    logger: ['error', 'warn'],
  });
  try {
    const result = await app.get(RedriveService).redrive(consumer, { limit });
    console.log(
      `redriven ${result.redriven}, refused ${result.refused} (limit reached) for ${consumer}`,
    );
  } finally {
    await app.close();
  }
}

if (require.main === module)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
