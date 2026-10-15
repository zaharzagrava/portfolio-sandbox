export const SYNC_CLOCK = Symbol('SYNC_CLOCK');

/** Time source of the capability; the domain never calls `new Date()`. */
export interface Clock {
  now(): Date;
}
