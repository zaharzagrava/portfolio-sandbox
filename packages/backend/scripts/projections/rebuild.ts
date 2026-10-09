/**
 * Rebuilds a projection by replaying its topics from the beginning (D26).
 *
 *   pnpm projections:rebuild <consumer-group> [topic ...]
 *
 * Steps (the projector app for this group must be stopped first - Kafka
 * refuses to reset offsets of an active group):
 *  1. reset the group's offsets to the earliest retained offset,
 *  2. start the projector again → it re-projects everything; version-guarded
 *     sinks make replaying already-applied events harmless.
 * For a zero-downtime rebuild into a NEW target (changed ES mapping, new
 * table), run the new projector version under a new group name writing to a
 * shadow index/table, then swap the alias (SD-37) - no offset reset needed.
 */
import { Kafka } from 'kafkajs';

async function main() {
  const [groupId, ...topicsArg] = process.argv.slice(2);
  if (!groupId)
    throw new Error('usage: rebuild.ts <consumer-group> [topic ...]');

  const kafka = new Kafka({
    clientId: 'projection-rebuild',
    brokers: (process.env.KAFKA_BROKER ?? 'localhost:9092').split(','),
  });
  const admin = kafka.admin();
  await admin.connect();

  const topics = topicsArg.length
    ? topicsArg
    : (await admin.fetchOffsets({ groupId })).map((t) => t.topic);

  for (const topic of topics) {
    await admin.resetOffsets({ groupId, topic, earliest: true });
    console.log(`reset ${groupId} @ ${topic} → earliest`);
  }

  await admin.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
