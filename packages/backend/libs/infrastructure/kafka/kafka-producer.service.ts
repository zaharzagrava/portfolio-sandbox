import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Kafka, Producer } from 'kafkajs';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { Environment } from '@app/common/types';

@Injectable()
export class KafkaProducerService implements OnModuleInit, OnModuleDestroy {
  private kafkaProducer: Producer;
  private connected = false;

  constructor(private readonly configService: ApiConfigService) {
    const isLocalKafka = [Environment.local, Environment.test].includes(
      this.configService.get('node_env'),
    );

    const kafka = new Kafka({
      brokers: [this.configService.get('kafka_broker')],
      ...(isLocalKafka
        ? {}
        : {
            ssl: true,
            sasl: {
              mechanism: 'plain',
              username: this.configService.get('kafka_api_key'),
              password: this.configService.get('kafka_api_secret'),
            },
          }),
    });

    this.kafkaProducer = kafka.producer();
  }

  async onModuleInit() {
    await this.kafkaProducer.connect();
    this.connected = true;
  }

  async onModuleDestroy() {
    if (this.connected) {
      await this.kafkaProducer.disconnect();
    }
  }

  public async send({
    topic,
    key,
    value,
  }: {
    topic: string;
    key: string;
    value: unknown;
  }): Promise<void> {
    await this.kafkaProducer.send({
      topic,
      messages: [{ key, value: JSON.stringify(value) }],
    });
  }

  /** Many messages to one topic in a single produce request (batched per partition by kafkajs). */
  public async sendMany(topic: string, messages: { key: string; value: unknown }[]): Promise<void> {
    if (messages.length === 0) return;
    await this.kafkaProducer.send({ topic, messages: messages.map((m) => ({ key: m.key, value: JSON.stringify(m.value) })) });
  }
}
