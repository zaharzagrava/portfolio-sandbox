import { Logger } from '@nestjs/common';
import { Kafka, logLevel, type LogEntry } from 'kafkajs';
import { ApiConfigService } from '@app/common/config';
import { Environment } from '@app/common/types';
import type { KafkaClientOverrides } from './kafka-client.options';
import { shardKafka } from './shard-kafka';

/**
 * kafkajs prints its own unstructured JSON lines to stdout (no requestId, no
 * redaction). Send them through the application logger instead so every line has
 * the same shape (J03 AS-39).
 */
const kafkaLogCreator = () => {
  const logger = new Logger('kafkajs');
  return ({ level, log }: LogEntry): void => {
    const { message, timestamp: _timestamp, logger: _logger, ...extra } = log;
    // Client work has no request or span: the client id is its correlation id, so the line is never without one
    const fields = {
      traceId: `kafkajs:${String(extra.clientId ?? 'unknown')}`,
      ...extra,
    };
    if (level === logLevel.ERROR) logger.error(fields, message);
    else logger.warn(fields, message);
  };
};

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
  return shardKafka(
    new Kafka({
      clientId,
      brokers: config.get('kafka_broker').split(','),
      logLevel: logLevel.WARN,
      logCreator: kafkaLogCreator,
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
    }),
  );
}
