import type { KafkaConfig } from 'kafkajs';

/**
 * Optional overrides merged into the kafkajs client configuration (`createKafka`). Production leaves it unbound;
 * specs bind a `socketFactory` to route traffic through the TCP fault proxy (`test/fakes/tcp-fault-proxy.ts`).
 */
export const KAFKA_CLIENT_OVERRIDES = Symbol('KAFKA_CLIENT_OVERRIDES');
export type KafkaClientOverrides = Partial<KafkaConfig>;

/**
 * Same for the consumers of the projection framework (and their admin calls): a spec binds a socket factory
 * to cut or delay the consumer's connection without touching the producers.
 */
export const KAFKA_CONSUMER_OVERRIDES = Symbol('KAFKA_CONSUMER_OVERRIDES');
