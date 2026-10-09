import { Kafka, logLevel } from 'kafkajs';
import { ApiConfigService } from '@app/common/config';
import { Environment } from '@app/common/types';
import type { KafkaClientOverrides } from './kafka-client.options';

/**
 * One place for "local Redpanda vs Confluent Cloud (SASL/SSL)" (D12) instead
 * of repeating it in every producer/consumer.
 */
export function createKafka(
  config: ApiConfigService,
  clientId = 'marketplace',
  overrides: KafkaClientOverrides = {},
): Kafka {
  const isLocal = [Environment.local, Environment.test].includes(
    config.get('node_env'),
  );
  return new Kafka({
    clientId,
    brokers: config.get('kafka_broker').split(','),
    logLevel: logLevel.WARN,
    ...(isLocal
      ? {}
      : {
          ssl: true,
          sasl: {
            mechanism: 'plain',
            username: config.get('kafka_api_key'),
            password: config.get('kafka_api_secret'),
          },
        }),
    ...overrides,
  });
}
