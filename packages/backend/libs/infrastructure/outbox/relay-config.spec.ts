import { ConfigUtilsService } from '@app/common/config/config-utils/config-utils.service';
import { ConfigRuleSet } from '@app/common/config/config-rules';
import {
  eventsConfigKeys,
  eventsConfigRule,
  EventsConfig,
} from '@app/common/config/events-config';

const parse = (env: Record<string, string>): EventsConfig =>
  new ConfigUtilsService().parseSrc<EventsConfig>(eventsConfigKeys, [
    env as unknown as Record<string, EventsConfig[keyof EventsConfig]>,
  ]);

describe('S53 relay and consumer configuration', () => {
  it('S53 AS-23: defaults match the spec when nothing is set', () => {
    expect(parse({})).toEqual({
      outbox_relay: 'poller',
      outbox_relay_interval_ms: 2_000,
      outbox_relay_batch: 100,
      outbox_relay_lease_ms: 30_000,
      outbox_relay_max_attempts: 10,
      outbox_retention_days: 7,
      consumer_batch: 100,
      consumer_max_attempts: 3,
      consumer_backoff_min_ms: 200,
      consumer_backoff_max_ms: 5_000,
      consumer_handler_timeout_ms: 30_000,
      consumer_in_flight: 500,
      consumer_graceful_stop_ms: 20_000,
      consumer_session_timeout_ms: 30_000,
      ryw_wait_budget_ms: 500,
      ryw_checkpoint_ttl_s: 86_400,
      projection_promotion_max_lag: 1_000,
      topic_default_partitions: 12,
      topic_hot_partitions: 64,
    });
  });

  it.each([
    ['poller', 'poller'],
    ['cdc', 'cdc'],
  ])('S53 AS-23: OUTBOX_RELAY=%s is accepted', (value, expected) => {
    expect(parse({ OUTBOX_RELAY: value }).outbox_relay).toBe(expected);
  });

  it.each([
    ['OUTBOX_RELAY', 'both'],
    ['OUTBOX_RELAY', ''],
    ['OUTBOX_RELAY_INTERVAL_MS', '0'],
    ['OUTBOX_RELAY_INTERVAL_MS', 'soon'],
    ['OUTBOX_RELAY_BATCH', '-1'],
    ['OUTBOX_RELAY_LEASE_MS', '12.5'],
    ['OUTBOX_RELAY_MAX_ATTEMPTS', '0'],
    ['OUTBOX_RETENTION_DAYS', '0'],
    ['CONSUMER_MAX_ATTEMPTS', '0'],
    ['CONSUMER_IN_FLIGHT', 'many'],
    ['CONSUMER_SESSION_TIMEOUT_MS', '5999'],
    ['CONSUMER_HANDLER_TIMEOUT_MS', '-5'],
    ['RYW_WAIT_BUDGET_MS', '2001'],
    ['TOPIC_DEFAULT_PARTITIONS', '0'],
  ])(
    'S53 AS-23: %s=%j fails startup naming the key, not the value',
    (key, value) => {
      expect(() => parse({ [key]: value })).toThrow(/Config validation error/);
      try {
        parse({ [key]: value });
      } catch (e) {
        expect((e as Error).message).not.toContain(`"${value}"`);
      }
    },
  );

  it('S53 AS-23: a backoff window whose minimum exceeds the maximum fails startup', () => {
    const values = parse({
      CONSUMER_BACKOFF_MIN_MS: '9000',
      CONSUMER_BACKOFF_MAX_MS: '100',
    });
    const rules = new ConfigRuleSet();
    rules.register({
      owner: 'events',
      keys: ['consumer_backoff_min_ms', 'consumer_backoff_max_ms'],
      validate: eventsConfigRule,
    });
    expect(() =>
      rules.assertValid(values as unknown as Record<string, unknown>, {
        production: false,
      }),
    ).toThrow(/consumer_backoff_min_ms/);
  });
});
