import type { SyncConfig } from '../sync-config';

export const SYNC_CONFIG = Symbol('SYNC_CONFIG');
export const SYNC_MONOTONIC = Symbol('SYNC_MONOTONIC');
export const SYNC_INSTANCE = Symbol('SYNC_INSTANCE');

export type { SyncConfig };

/**
 * Milliseconds on a monotonic scale, for the push budget only (an elapsed duration, not a point in time); the wall
 * clock stays the injected `SYNC_CLOCK`, which is the one time authority (FR-022).
 */
export type Monotonic = () => number;
