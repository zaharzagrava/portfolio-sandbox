import { Injectable } from '@nestjs/common';
import { z } from 'zod';

const ms = (def: number, min = 1, max = 3_600_000) =>
  z.coerce.number().int().min(min).max(max).default(def);
const count = (def: number, min = 1, max = 1_000_000) =>
  z.coerce.number().int().min(min).max(max).default(def);

/** Every limit of the hub (S51 FR-050). Out-of-range values fail the boot; tests set millisecond values. */
export const realtimeConfigSchema = z
  .object({
    heartbeatMs: ms(15_000, 5),
    maxBufferedBytes: count(1024 * 1024, 1024, 64 * 1024 * 1024),
    replayPage: count(500, 1, 10_000),
    replayBuffer: count(1_000, 1, 100_000),
    maxTopicsPerConnection: count(10, 1, 10),
    maxPayloadBytes: count(32 * 1024, 1024, 1024 * 1024),
    publishTimeoutMs: ms(1_000, 10, 30_000),
    ruleTimeoutMs: ms(2_000, 10, 30_000),
    discoveryTimeoutMs: ms(1_000, 10, 30_000),
    subscribeTimeoutMs: ms(2_000, 10, 30_000),
    discoveryLimit: count(10_000, 1, 1_000_000),
    maxConnectionsPerUser: count(20),
    maxConnectionsPerAddress: count(10),
    instanceCapacity: count(50_000),
    maxLifetimeMs: ms(30 * 60_000, 50),
    stallMs: ms(30_000, 20),
    drainMs: ms(10_000, 10),
    retentionCount: count(1_000, 10, 1_000_000),
    retentionMs: ms(3_600_000, 1_000, 7 * 86_400_000),
    /** Separate backplane address for the subscriber connection; empty uses the shared store address. */
    subscriberUrl: z.string().default(''),
    retryMinMs: ms(2_000, 1, 60_000),
    retryMaxMs: ms(5_000, 1, 60_000),
  })
  .refine((c) => c.retryMinMs <= c.retryMaxMs, {
    message: 'retryMinMs must not exceed retryMaxMs',
  });

export type RealtimeConfigValues = z.infer<typeof realtimeConfigSchema>;

const ENV: Record<keyof RealtimeConfigValues, string> = {
  heartbeatMs: 'REALTIME_HEARTBEAT_MS',
  maxBufferedBytes: 'REALTIME_MAX_BUFFERED_BYTES',
  replayPage: 'REALTIME_REPLAY_PAGE',
  replayBuffer: 'REALTIME_REPLAY_BUFFER',
  maxTopicsPerConnection: 'REALTIME_MAX_TOPICS',
  maxPayloadBytes: 'REALTIME_MAX_PAYLOAD_BYTES',
  publishTimeoutMs: 'REALTIME_PUBLISH_TIMEOUT_MS',
  ruleTimeoutMs: 'REALTIME_RULE_TIMEOUT_MS',
  discoveryTimeoutMs: 'REALTIME_DISCOVERY_TIMEOUT_MS',
  subscribeTimeoutMs: 'REALTIME_SUBSCRIBE_TIMEOUT_MS',
  discoveryLimit: 'REALTIME_DISCOVERY_LIMIT',
  maxConnectionsPerUser: 'REALTIME_MAX_CONN_PER_USER',
  maxConnectionsPerAddress: 'REALTIME_MAX_CONN_PER_ADDRESS',
  instanceCapacity: 'REALTIME_INSTANCE_CAPACITY',
  maxLifetimeMs: 'REALTIME_MAX_LIFETIME_MS',
  stallMs: 'REALTIME_STALL_MS',
  drainMs: 'REALTIME_DRAIN_MS',
  retentionCount: 'REALTIME_RETENTION_COUNT',
  retentionMs: 'REALTIME_RETENTION_MS',
  subscriberUrl: 'REALTIME_SUBSCRIBER_URL',
  retryMinMs: 'REALTIME_RETRY_MIN_MS',
  retryMaxMs: 'REALTIME_RETRY_MAX_MS',
};

@Injectable()
export class RealtimeConfig {
  constructor(readonly values: RealtimeConfigValues) {}

  /** Environment first, then explicit overrides (tests). Invalid values throw. */
  static from(
    overrides: Partial<RealtimeConfigValues> = {},
    env: NodeJS.ProcessEnv = process.env,
  ): RealtimeConfig {
    const fromEnv: Record<string, string> = {};
    for (const [key, name] of Object.entries(ENV))
      if (env[name] !== undefined && env[name] !== '')
        fromEnv[key] = env[name]!;
    return new RealtimeConfig(
      realtimeConfigSchema.parse({ ...fromEnv, ...overrides }),
    );
  }

  get<K extends keyof RealtimeConfigValues>(key: K): RealtimeConfigValues[K] {
    return this.values[key];
  }
}
