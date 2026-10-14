import {
  definePolicies,
  type PolicyNamesOf,
} from '@app/infrastructure/rate-limit';

/**
 * Rate limit policies owned by `chat` (S24 G-14, S50 follow-up). Every policy is per user and fails open: a limiter
 * outage must never silence a conversation; the outage is counted (`chatLimiterUnavailable`, see chat-metrics.ts).
 * The values keep a busy chatter and a reconnecting client (one sync per reconnect, jittered by the client) well
 * below the limit.
 */
export const chatRatePolicies = definePolicies('chat', {
  'chat.send.user': {
    algorithm: 'slidingWindow',
    limit: 10,
    windowMs: 10_000,
    key: 'user',
    failMode: 'open',
  },
  'chat.sync.user': {
    algorithm: 'slidingWindow',
    limit: 30,
    windowMs: 60_000,
    key: 'user',
    failMode: 'open',
  },
  'chat.read.user': {
    algorithm: 'slidingWindow',
    limit: 240,
    windowMs: 60_000,
    key: 'user',
    failMode: 'open',
  },
  'chat.heartbeat.user': {
    algorithm: 'slidingWindow',
    limit: 6,
    windowMs: 60_000,
    key: 'user',
    failMode: 'open',
  },
  'chat.presence.user': {
    algorithm: 'slidingWindow',
    limit: 60,
    windowMs: 60_000,
    key: 'user',
    failMode: 'open',
  },
  'chat.ws-ticket.user': {
    algorithm: 'slidingWindow',
    limit: 30,
    windowMs: 60_000,
    key: 'user',
    failMode: 'open',
  },
  'chat.join.user': {
    algorithm: 'slidingWindow',
    limit: 60,
    windowMs: 60_000,
    key: 'user',
    failMode: 'open',
  },
  'chat.channel-create.user': {
    algorithm: 'slidingWindow',
    limit: 30,
    windowMs: 60_000,
    key: 'user',
    failMode: 'open',
  },
} as const);

declare module '@app/infrastructure/rate-limit/rate-limit.types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation: adds this owner's names to the union
  interface PolicyNameRegistry extends PolicyNamesOf<
    typeof chatRatePolicies.policies
  > {}
}
