import * as joi from 'joi';
import { ConfigRules, type RuleCheck } from './config-rules';

/**
 * Settings of the `launch-events` booking half (S22 G-43): the waiting-room maximum and the bot-check provider. The
 * TTLs (hold, token, heartbeat) are constants of the capability, not settings.
 */
export interface LaunchEventsConfig {
  /** Tickets one event's waiting room holds before it sheds new joins (default 2,000,000; 1 to 50,000,000). */
  launch_queue_max_length?: number;
  /** Verification endpoint of the bot-check provider; unset means no provider (events with the flag then refuse joins). */
  launch_human_check_url?: string;
  launch_human_check_secret?: string;
  /** S23 live stream: delivery window in ms (default 250; 1 to 10,000). */
  live_window_ms?: number;
  /** S23: ordinary comments a viewer gets per window (default 5; 1 to 50). */
  live_sample_size?: number;
  /** S23: concurrent viewers one gateway instance carries (default 50,000; at least 1). */
  live_viewer_cap?: number;
  /** S23: toxicity score from which a comment is removed (default 0.7; above 0, at most 1). */
  live_moderation_threshold?: number;
}

type Key = {
  name: string;
  verify: joi.AnySchema;
  postProcess?: (v: string) => number | undefined;
};

export const launchEventsConfigKeys: Record<keyof LaunchEventsConfig, Key> = {
  launch_queue_max_length: {
    name: 'LAUNCH_QUEUE_MAX_LENGTH',
    verify: joi.number().integer().min(1).max(50_000_000).optional(),
    postProcess: (v: string) => (v ? Number(v) : undefined),
  },
  launch_human_check_url: {
    name: 'LAUNCH_HUMAN_CHECK_URL',
    verify: joi
      .string()
      .uri({ scheme: ['https', 'http'] })
      .optional()
      .allow(''),
  },
  launch_human_check_secret: {
    name: 'LAUNCH_HUMAN_CHECK_SECRET',
    verify: joi.string().optional().allow(''),
  },
  live_window_ms: {
    name: 'LIVE_WINDOW_MS',
    verify: joi.number().integer().min(1).max(10_000).optional(),
    postProcess: (v: string) => (v ? Number(v) : undefined),
  },
  live_sample_size: {
    name: 'LIVE_SAMPLE_SIZE',
    verify: joi.number().integer().min(1).max(50).optional(),
    postProcess: (v: string) => (v ? Number(v) : undefined),
  },
  live_viewer_cap: {
    name: 'LIVE_VIEWER_CAP',
    verify: joi.number().integer().min(1).max(100_000_000).optional(),
    postProcess: (v: string) => (v ? Number(v) : undefined),
  },
  live_moderation_threshold: {
    name: 'LIVE_MODERATION_THRESHOLD',
    verify: joi.number().greater(0).max(1).optional(),
    postProcess: (v: string) => (v ? Number(v) : undefined),
  },
};

const isSet = (value: unknown): boolean =>
  value !== undefined && value !== null && value !== '';

/** A provider URL without its secret (or the reverse) is a half-configured provider: refuse to start. */
export const launchEventsRule: RuleCheck = (ctx) => {
  const url = isSet(ctx.get('launch_human_check_url'));
  const secret = isSet(ctx.get('launch_human_check_secret'));
  return url === secret
    ? []
    : ['launch_human_check_url and launch_human_check_secret are set together'];
};

ConfigRules.register({
  owner: 'launch-events',
  keys: ['launch_human_check_url', 'launch_human_check_secret'],
  validate: launchEventsRule,
});

export const DEFAULT_QUEUE_MAX_LENGTH = 2_000_000;
export const DEFAULT_LIVE_WINDOW_MS = 250;
export const DEFAULT_LIVE_SAMPLE_SIZE = 5;
export const DEFAULT_LIVE_VIEWER_CAP = 50_000;
export const DEFAULT_LIVE_MODERATION_THRESHOLD = 0.7;
