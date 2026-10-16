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
