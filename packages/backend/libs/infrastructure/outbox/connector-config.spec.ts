import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const path = join(
  __dirname,
  '../../../../../infra/debezium/outbox-connector.json',
);
const connector = JSON.parse(readFileSync(path, 'utf8')) as {
  name: string;
  config: Record<string, string>;
};
const config = connector.config;

describe('S53 Debezium outbox connector configuration', () => {
  it('S53 AS-22: the include list is exactly the outbox table', () => {
    expect(config['table.include.list']).toBe('public.Outbox');
    expect(config['schema.include.list'] ?? 'public').toBe('public');
    expect(config['table.exclude.list']).toBeUndefined();
  });

  it('S53 AS-22: events are routed by the row topic and keyed by the aggregate id', () => {
    expect(config['transforms.outbox.type']).toBe(
      'io.debezium.transforms.outbox.EventRouter',
    );
    expect(config['transforms.outbox.route.by.field']).toBe('topic');
    expect(config['transforms.outbox.route.topic.replacement']).toBe(
      '${routedByValue}',
    );
    expect(config['transforms.outbox.table.field.event.key']).toBe(
      'aggregateId',
    );
    expect(config['transforms.outbox.table.field.event.id']).toBe('id');
  });

  it('S53 AS-22: the value is the envelope itself: payload expanded, no wrapper, no schema', () => {
    expect(config['transforms.outbox.table.field.event.payload']).toBe(
      'payload',
    );
    expect(config['transforms.outbox.table.expand.json.payload']).toBe('true');
    expect(config['value.converter.schemas.enable']).toBe('false');
    expect(config['key.converter']).toBe(
      'org.apache.kafka.connect.storage.StringConverter',
    );
  });

  it('S53 AS-22: only event rows are relayed and the headers match the poller (eventId, type, version, traceparent)', () => {
    // Task rows go to a queue, not to the log: the connector drops them before routing.
    expect(config['transforms']).toMatch(/\bonlyEvents\b/);
    expect(config['transforms.onlyEvents.type']).toBe(
      'io.debezium.transforms.Filter',
    );
    expect(config['transforms.onlyEvents.condition']).toContain(
      "kind == 'event'",
    );
    expect(config['transforms']).toMatch(/\bheaders\b/);
    expect(config['transforms.headers.type']).toBe(
      'org.apache.kafka.connect.transforms.HeaderFrom$Value',
    );
    expect(config['transforms.headers.fields']).toBe(
      'eventId,type,version,traceparent',
    );
    expect(config['transforms.headers.headers']).toBe(
      'eventId,type,version,traceparent',
    );
    expect(config['transforms.headers.operation']).toBe('copy');
  });

  it('S53 AS-22: the transform order is filter, route, headers', () => {
    expect(config['transforms'].split(',').map((t) => t.trim())).toEqual([
      'onlyEvents',
      'outbox',
      'headers',
    ]);
  });

  it('S53 AS-22: credentials and host come from the environment, never from the file', () => {
    for (const key of [
      'database.hostname',
      'database.user',
      'database.password',
      'database.dbname',
    ])
      expect(config[key]).toMatch(/^\$\{env:[A-Z_]+\}$/);
  });

  it('S53 AS-22: rows are streamed, not deleted by the connector (retention is the purge job)', () => {
    expect(config['tombstones.on.delete']).toBe('false');
    expect(config['transforms.outbox.table.op.invalid.behavior']).toBe('warn');
  });
});
