import { Kafka, logLevel } from 'kafkajs';
import { v4 as uuidv4 } from 'uuid';
import { shardKafka } from '@app/infrastructure/kafka/shard-kafka';

/** Direct connection to the test Redpanda (docker-compose.test.yaml), bypassing any fault proxy. */
export const testKafka = (): Kafka =>
  shardKafka(
    new Kafka({
      clientId: `spec-${uuidv4().slice(0, 6)}`,
      brokers: [process.env.KAFKA_BROKER ?? 'localhost:9192'],
      logLevel: logLevel.NOTHING,
    }),
  );

type Admin = ReturnType<Kafka['admin']>;
const ADMIN_IDLE_MS = 3_000;
let sharedAdmin: Promise<Admin> | null = null;
let adminUsers = 0;
let adminIdleTimer: NodeJS.Timeout | null = null;

function dropAdmin(): void {
  const doomed = sharedAdmin;
  sharedAdmin = null;
  void doomed?.then((a) => a.disconnect()).catch(() => undefined);
}

/**
 * Runs `fn` on one admin connection that is kept for the whole process and closed after a few idle seconds (so the
 * process can still end). A failure on a connection that was reused (broker restarted, socket gone) is retried once
 * on a fresh connection; a failure on a fresh connection is thrown as before.
 */
async function withAdmin<T>(fn: (admin: Admin) => Promise<T>): Promise<T> {
  if (adminIdleTimer) clearTimeout(adminIdleTimer);
  adminIdleTimer = null;
  adminUsers++;
  try {
    for (let attempt = 0; ; attempt++) {
      const reused = sharedAdmin !== null;
      sharedAdmin ??= (async () => {
        const a = testKafka().admin();
        await a.connect();
        return a;
      })();
      const current = sharedAdmin;
      try {
        return await fn(await current);
      } catch (error) {
        if (sharedAdmin === current) dropAdmin();
        if (!reused || attempt > 0) throw error;
      }
    }
  } finally {
    if (--adminUsers === 0)
      adminIdleTimer = setTimeout(dropAdmin, ADMIN_IDLE_MS);
  }
}

export async function createTopics(
  topics: {
    topic: string;
    numPartitions?: number;
    configEntries?: { name: string; value: string }[];
  }[],
): Promise<void> {
  await withAdmin((admin) =>
    admin.createTopics({
      waitForLeaders: true,
      topics: topics.map((t) => ({ numPartitions: 1, ...t })),
    }),
  );
}

/** Deletes the topics whose name matches: specs clean up after themselves (the test broker caps total partitions). */
export async function deleteTopicsMatching(pattern: RegExp): Promise<void> {
  await withAdmin(async (admin) => {
    const doomed = (await admin.listTopics()).filter((t) => pattern.test(t));
    for (let i = 0; i < doomed.length; i += 50)
      await admin
        .deleteTopics({ topics: doomed.slice(i, i + 50), timeout: 30_000 })
        .catch(() => undefined);
  });
}

export interface LogMessage {
  topic: string;
  partition: number;
  offset: string;
  key: string | null;
  value: string | null;
  headers: Record<string, string>;
  json<T = Record<string, unknown>>(): T;
}

/**
 * Everything on `topic` up to its current end, read back through a real consumer with its own group. Returns an
 * empty list for a topic that does not exist. Persisted-state assertion for "what is on the log".
 */
export async function readTopic(topic: string): Promise<LogMessage[]> {
  const kafka = testKafka();
  const admin = kafka.admin();
  await admin.connect();
  let ends: { partition: number; high: string; low: string }[];
  try {
    ends = (await admin.fetchTopicOffsets(topic)).map((o) => ({
      partition: o.partition,
      high: o.high,
      low: o.low,
    }));
  } catch {
    await admin.disconnect();
    return [];
  }
  await admin.disconnect();
  const pending = new Map(
    ends
      .filter((e) => Number(e.high) > Number(e.low))
      .map((e) => [e.partition, Number(e.high)]),
  );
  if (pending.size === 0) return [];

  const consumer = kafka.consumer({ groupId: `read-${uuidv4()}` });
  const out: LogMessage[] = [];
  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: true });
  const done = new Promise<void>((resolve) => {
    void consumer.run({
      eachMessage: async ({ partition, message }) => {
        const text = (b: Buffer | null | undefined) =>
          b ? b.toString('utf8') : null;
        const value = text(message.value);
        out.push({
          topic,
          partition,
          offset: message.offset,
          key: text(message.key),
          value,
          headers: Object.fromEntries(
            Object.entries(message.headers ?? {}).map(([k, v]) => [
              k,
              Buffer.isBuffer(v) ? v.toString('utf8') : String(v),
            ]),
          ),
          json: <T>() => JSON.parse(value ?? 'null') as T,
        });
        if (Number(message.offset) + 1 >= (pending.get(partition) ?? 0))
          pending.delete(partition);
        if (pending.size === 0) resolve();
      },
    });
  });
  await Promise.race([
    done,
    new Promise<void>((_, reject) =>
      setTimeout(
        () => reject(new Error(`readTopic(${topic}) timed out`)),
        15_000,
      ),
    ),
  ]).finally(() => consumer.disconnect());
  return out;
}
