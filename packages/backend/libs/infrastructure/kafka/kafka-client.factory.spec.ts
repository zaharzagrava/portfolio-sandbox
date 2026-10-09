import { Kafka } from 'kafkajs';
import { Environment } from '@app/common/types';
import { createKafka } from './kafka-client.factory';

jest.mock('kafkajs', () => ({
  ...jest.requireActual('kafkajs'),
  Kafka: jest.fn(),
}));

const config = (values: Record<string, unknown>) =>
  ({ get: (key: string) => values[key] }) as never;
const lastConfig = () =>
  (Kafka as unknown as jest.Mock).mock.calls.at(-1)![0] as Record<
    string,
    unknown
  >;

describe('createKafka', () => {
  const brokers = 'one:9092,two:9092';

  it.each([Environment.local, Environment.test])(
    'S53 G-15: %s connects in plain text to every broker',
    (node_env) => {
      createKafka(config({ node_env, kafka_broker: brokers }), 'spec-client');
      expect(lastConfig()).toMatchObject({
        clientId: 'spec-client',
        brokers: ['one:9092', 'two:9092'],
      });
      expect(lastConfig()).not.toHaveProperty('ssl');
      expect(lastConfig()).not.toHaveProperty('sasl');
    },
  );

  it('S53 G-15: a deployed environment uses TLS and SASL with the configured key', () => {
    createKafka(
      config({
        node_env: Environment.production,
        kafka_broker: brokers,
        kafka_api_key: 'k',
        kafka_api_secret: 's',
      }),
      'spec-client',
    );
    expect(lastConfig()).toMatchObject({
      ssl: true,
      sasl: { mechanism: 'plain', username: 'k', password: 's' },
    });
  });

  it('S53 G-15: overrides (a spec socket factory) win over the defaults', () => {
    const socketFactory = jest.fn();
    createKafka(
      config({ node_env: Environment.test, kafka_broker: brokers }),
      'spec-client',
      {
        socketFactory,
        clientId: 'other',
      },
    );
    expect(lastConfig()).toMatchObject({ socketFactory, clientId: 'other' });
  });
});
