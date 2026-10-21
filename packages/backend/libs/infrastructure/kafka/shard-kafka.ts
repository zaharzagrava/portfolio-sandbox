/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Kafka } from 'kafkajs';
import {
  shardId,
  shardName,
  shardPrefix,
  unshardName,
} from '@app/common/shard';

/**
 * Test sharding (TEST_SHARD, see `@app/common/shard`): one broker for several shards. Every topic name and consumer group the
 * code passes to kafkajs gets the shard prefix, and every name read back (messages, topic lists, offsets, group lists) loses
 * it, so no caller sees a difference. Without a shard `shardKafka` returns the client itself: production is unchanged.
 */
const TOPIC_CONFIG_RESOURCE = 2; // ConfigResourceTypes.TOPIC

const t = (topic: string): string => shardName(topic);
const u = (topic: string): string => unshardName(topic) ?? topic;
const mine = (topic: string): boolean => unshardName(topic) !== undefined;

const topicRegex = (re: RegExp): RegExp =>
  new RegExp(
    `^${shardPrefix().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:${re.source.replace(/^\^/, '')})`,
    re.flags,
  );

/** The target's own members, with `overrides` on top (functions stay bound to the target). */
function overlay<T extends object>(
  target: T,
  overrides: Record<string, any>,
): T {
  return new Proxy(target, {
    get(obj, prop) {
      if (typeof prop === 'string' && prop in overrides) return overrides[prop];
      const value = Reflect.get(obj, prop, obj);
      return typeof value === 'function' ? value.bind(obj) : value;
    },
  });
}

const mapTopicField = <T extends { topic: string }>(item: T): T => ({
  ...item,
  topic: t(item.topic),
});

function wrapSender(sender: any): any {
  const send = (record: any) =>
    sender.send({ ...record, topic: t(record.topic) });
  const sendBatch = (batch: any) =>
    sender.sendBatch({
      ...batch,
      topicMessages: (batch.topicMessages ?? []).map(mapTopicField),
    });
  return { send, sendBatch };
}

function wrapProducer(producer: any): any {
  return overlay(producer, {
    ...wrapSender(producer),
    transaction: async () => {
      const tx = await producer.transaction();
      return overlay(tx, {
        ...wrapSender(tx),
        sendOffsets: (args: any) =>
          tx.sendOffsets({
            ...args,
            consumerGroupId: t(args.consumerGroupId),
            topics: (args.topics ?? []).map(mapTopicField),
          }),
      });
    },
  });
}

function wrapConsumer(consumer: any): any {
  const mapTopics = (list: any[]) => list.map(mapTopicField);
  return overlay(consumer, {
    subscribe: (args: any) => {
      const topicOf = (x: any) => (x instanceof RegExp ? topicRegex(x) : t(x));
      return consumer.subscribe({
        ...args,
        ...(args.topic !== undefined && { topic: topicOf(args.topic) }),
        ...(args.topics !== undefined && { topics: args.topics.map(topicOf) }),
      });
    },
    run: (config: any = {}) =>
      consumer.run({
        ...config,
        ...(config.eachMessage && {
          eachMessage: (payload: any) =>
            config.eachMessage({ ...payload, topic: u(payload.topic) }),
        }),
        ...(config.eachBatch && {
          eachBatch: (payload: any) =>
            config.eachBatch({
              ...payload,
              // the batch keeps its methods through the prototype; only its topic name changes
              batch: Object.create(payload.batch, {
                topic: { value: u(payload.batch.topic), enumerable: true },
              }),
            }),
        }),
      }),
    seek: (args: any) => consumer.seek(mapTopicField(args)),
    pause: (list: any[]) => consumer.pause(mapTopics(list)),
    resume: (list: any[]) => consumer.resume(mapTopics(list)),
    commitOffsets: (list: any[]) => consumer.commitOffsets(mapTopics(list)),
    on: (event: string, listener: (e: any) => void) =>
      consumer.on(event, (e: any) =>
        // the group-join event names the topics it assigned
        e?.payload?.memberAssignment
          ? listener({
              ...e,
              payload: {
                ...e.payload,
                memberAssignment: Object.fromEntries(
                  Object.entries(e.payload.memberAssignment).map(([k, v]) => [
                    u(k),
                    v,
                  ]),
                ),
              },
            })
          : listener(e),
      ),
  });
}

function wrapAdmin(admin: any): any {
  const topicsArg = (args: any) => ({
    ...args,
    ...(args?.topics && {
      topics: args.topics.map((x: any) =>
        typeof x === 'string' ? t(x) : mapTopicField(x),
      ),
    }),
  });
  return overlay(admin, {
    listTopics: async () =>
      ((await admin.listTopics()) as string[]).filter(mine).map(u),
    createTopics: (args: any) =>
      admin.createTopics({ ...args, topics: args.topics.map(mapTopicField) }),
    deleteTopics: (args: any) =>
      admin.deleteTopics({ ...args, topics: args.topics.map(t) }),
    createPartitions: (args: any) =>
      admin.createPartitions({
        ...args,
        topicPartitions: args.topicPartitions.map(mapTopicField),
      }),
    fetchTopicMetadata: async (args: any = {}) => {
      const res = await admin.fetchTopicMetadata(
        args.topics?.length ? topicsArg(args) : args,
      );
      return {
        ...res,
        topics: res.topics
          .filter((x: any) => mine(x.name))
          .map((x: any) => ({ ...x, name: u(x.name) })),
      };
    },
    fetchTopicOffsets: (topic: string) => admin.fetchTopicOffsets(t(topic)),
    fetchTopicOffsetsByTimestamp: (topic: string, timestamp?: number) =>
      admin.fetchTopicOffsetsByTimestamp(t(topic), timestamp),
    fetchOffsets: async (args: any) => {
      const res = await admin.fetchOffsets({
        ...args,
        groupId: t(args.groupId),
        ...(args.topics && { topics: args.topics.map(t) }),
        ...(args.topic && { topic: t(args.topic) }),
      });
      return Array.isArray(res)
        ? res.map((x: any) => ({ ...x, topic: u(x.topic) }))
        : res;
    },
    setOffsets: (args: any) =>
      admin.setOffsets({
        ...args,
        groupId: t(args.groupId),
        topic: t(args.topic),
      }),
    resetOffsets: (args: any) =>
      admin.resetOffsets({
        ...args,
        groupId: t(args.groupId),
        topic: t(args.topic),
      }),
    deleteTopicRecords: (args: any) =>
      admin.deleteTopicRecords({ ...args, topic: t(args.topic) }),
    deleteGroups: (ids: string[]) => admin.deleteGroups(ids.map(t)),
    describeGroups: async (ids: string[]) => {
      const res = await admin.describeGroups(ids.map(t));
      return {
        ...res,
        groups: res.groups.map((g: any) => ({ ...g, groupId: u(g.groupId) })),
      };
    },
    listGroups: async () => {
      const res = await admin.listGroups();
      return {
        ...res,
        groups: res.groups
          .filter((g: any) => mine(g.groupId))
          .map((g: any) => ({ ...g, groupId: u(g.groupId) })),
      };
    },
    describeConfigs: async (args: any) => {
      const res = await admin.describeConfigs({
        ...args,
        resources: args.resources.map((r: any) =>
          r.type === TOPIC_CONFIG_RESOURCE ? { ...r, name: t(r.name) } : r,
        ),
      });
      return {
        ...res,
        resources: res.resources.map((r: any) =>
          r.resourceType === TOPIC_CONFIG_RESOURCE
            ? { ...r, resourceName: u(r.resourceName) }
            : r,
        ),
      };
    },
    alterConfigs: (args: any) =>
      admin.alterConfigs({
        ...args,
        resources: args.resources.map((r: any) =>
          r.type === TOPIC_CONFIG_RESOURCE ? { ...r, name: t(r.name) } : r,
        ),
      }),
  });
}

export function shardKafka(kafka: Kafka): Kafka {
  if (shardId() === '') return kafka;
  return overlay(kafka, {
    producer: (config?: any) => wrapProducer(kafka.producer(config)),
    consumer: (config: any) =>
      wrapConsumer(kafka.consumer({ ...config, groupId: t(config.groupId) })),
    admin: (config?: any) => wrapAdmin(kafka.admin(config)),
  });
}
