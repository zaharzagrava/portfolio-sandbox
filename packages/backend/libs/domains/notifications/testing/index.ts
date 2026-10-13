/**
 * Shared fixtures of the notifications e2e specs (S28 T021). Specs import from here, never the models of identity or
 * tenancy. `waitFor` is re-exported so a spec waits on a condition and never sleeps.
 */
export { waitFor, inParallel } from '@app/test/utils/async-helpers';
export { createNotificationsApp, FakeRealtimeHub } from './notifications-app';
export type { NotificationsTestApp, TestUser } from './notifications-app';
export { consume, consumeInvite } from './consume';
export { capturingLogs } from './capture-logs';
export { queueDepth, waitForQueueEmpty, purgeDeliveryLines } from './queues';
export { ScriptedProvider } from './scripted-provider';
export { TestClock } from './test-clock';
export { faultSwitch } from './fault-switch';
export type { FaultSwitch } from './fault-switch';
export { envelope, rawEnvelope, orderPaidEnvelope } from './envelopes';
export type { EnvelopeOptions } from './envelopes';
