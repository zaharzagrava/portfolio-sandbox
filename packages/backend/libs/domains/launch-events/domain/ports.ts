import type { EventStatus } from './event-state';
import type { HoldState } from './hold-state';
import type { BucketState } from './token-bucket';

/**
 * Ports of the booking half (S22 G-36, D-6): `application/` talks to these tokens only; the adapters live in `infra/`.
 * Every store behind a port is replaceable in tests by a switchable wrapper (fault injection at the system edge).
 */

export type SeatingMode = 'SEATED' | 'GENERAL';
export type ClosedReason = 'organizer' | 'started';
export type SeatChange = 'held' | 'booked' | 'released';

export interface LaunchEventRecord {
  id: string;
  shopId: string;
  title: string;
  venue: string;
  startsAt: Date;
  salesOpenAt: Date;
  seatCount: number;
  seatsPerRow: number;
  seatingMode: SeatingMode;
  perUserLimit: number;
  admissionRatePerSec: number;
  humanCheckRequired: boolean;
  status: EventStatus;
  closedReason: ClosedReason | null;
}

export type NewLaunchEvent = Omit<
  LaunchEventRecord,
  'id' | 'status' | 'closedReason'
>;

export interface BookingRecord {
  id: string;
  eventId: string;
  seat: number;
  userId: string;
  holdId: string;
  confirmedAt: Date;
}

/** Position of the keyset page: `confirmedAt DESC, id DESC` (FR-042). */
export interface BookingCursor {
  confirmedAt: string;
  id: string;
}

/** Thrown inside the booking transaction by the unique index; the service rolls back and answers `SEAT_TAKEN`. */
export class SeatConflictError extends Error {
  constructor(readonly seat?: number) {
    super('seat already booked');
    this.name = 'SeatConflictError';
  }
}

/** Thrown by the ledger when one seat of a hold request is held by someone else. */
export class SeatHeldError extends Error {
  constructor(readonly seat: number) {
    super('seat already held');
    this.name = 'SeatHeldError';
  }
}

export interface EventRepository {
  create(input: NewLaunchEvent): Promise<LaunchEventRecord>;
  findById(id: string): Promise<LaunchEventRecord | null>;
  /**
   * Reads the event with `FOR UPDATE` inside the active transaction: confirms of one event queue up, and a close that
   * commits first is seen (never a booking after a committed close, FR-043).
   */
  lockById(id: string): Promise<LaunchEventRecord | null>;
  /**
   * `UPDATE … WHERE status = :from`, asserting one row; the history row is written with it. `true` when this call moved
   * the status. Joins the active transaction when there is one.
   */
  transition(
    id: string,
    from: EventStatus,
    to: EventStatus,
    options?: { reason?: string; closedReason?: ClosedReason },
  ): Promise<boolean>;
  /** Events the reconciler looks at: on sale, sold out, or closed within `closedSince`. */
  listReconcilable(closedSince: Date): Promise<LaunchEventRecord[]>;
}

export interface BookingRepository {
  forHold(holdId: string): Promise<BookingRecord[]>;
  /** One row per seat plus the history rows; joins the active transaction; throws `SeatConflictError`. */
  insertConfirmed(input: {
    eventId: string;
    holdId: string;
    userId: string;
    seats: number[];
    at: Date;
  }): Promise<BookingRecord[]>;
  seatsOfUser(eventId: string, userId: string): Promise<number[]>;
  count(eventId: string): Promise<number>;
  /** Every confirmed seat of the event with its booking (reconciler, map rebuild). */
  confirmedSeats(eventId: string): Promise<BookingRecord[]>;
  page(
    eventId: string,
    limit: number,
    after: BookingCursor | null,
  ): Promise<BookingRecord[]>;
  forUser(eventId: string, userId: string): Promise<BookingRecord[]>;
  /** Seats with more than one confirmed booking (must stay 0, SC-001). */
  countDoubleBooked(): Promise<number>;
}

export interface HoldRecord {
  holdId: string;
  eventId: string;
  userId: string;
  seats: number[];
  /** Fencing number of each seat record at the time of this hold. */
  fences: Record<string, number>;
  state: HoldState;
  expiresAtMs: number;
  createdAtMs: number;
  confirmedAtMs?: number;
}

export interface SeatRecord {
  seat: number;
  holdId: string;
  userId: string;
  fence: number;
  state: 'HELD' | 'CONFIRMED' | 'FREE';
  expiresAtMs: number;
}

/** The durable hold ledger (DynamoDB): the authority for who holds a seat (FR-017). */
export interface HoldLedger {
  /** All-or-nothing over the seats; throws `SeatHeldError(seat)`; rollback removes only this hold's records. */
  create(input: {
    holdId: string;
    eventId: string;
    userId: string;
    seats: number[];
    createdAtMs: number;
    expiresAtMs: number;
  }): Promise<HoldRecord>;
  get(holdId: string): Promise<HoldRecord | null>;
  /**
   * Conditional state change of the hold item. `lapsed: true` additionally requires `expiresAtMs <= nowMs`,
   * `lapsed: false` requires `expiresAtMs > nowMs` (confirm seals only a live hold).
   */
  transition(
    holdId: string,
    from: HoldState,
    to: HoldState,
    options?: { nowMs?: number; lapsed?: boolean },
  ): Promise<boolean>;
  /**
   * Repair path of the reconciler only (outside the public state machine): a hold the ledger calls confirmed (or sealed)
   * for which no booking exists becomes `RELEASED`. `true` when this call did it.
   */
  revokeConfirmation(holdId: string): Promise<boolean>;
  /**
   * Frees the seat records of the hold, each conditional on hold ID and fence. `freed`: seats this call freed; `failed`:
   * seats the store could not be asked about. A seat a newer hold took over is in neither list (not ours to touch).
   */
  freeSeats(hold: HoldRecord): Promise<{ freed: number[]; failed: number[] }>;
  /** Turns the seat records of a sealed hold into permanent `CONFIRMED` records (conditional on hold ID and fence). */
  confirmSeats(hold: HoldRecord): Promise<void>;
  /** Every seat record of the event, free ones and lapsed ones included (best-available, reconciler, rebuild). */
  records(eventId: string): Promise<SeatRecord[]>;
}

/** First-filter lock per seat (Redis `SET NX PX`); never the authority. */
export interface SeatLockStore {
  /** `true` when the seat may be tried in the ledger (lock taken, or the holder of the lock had lapsed). */
  tryLock(
    eventId: string,
    seat: number,
    holdId: string,
    expiresAtMs: number,
    nowMs: number,
  ): Promise<boolean>;
  /** Deletes the lock only if `holdId` still owns it. */
  release(eventId: string, seat: number, holdId: string): Promise<void>;
  /** Keeps the lock of a booked seat (long expiry) so later tries are rejected without a ledger read. */
  keepBooked(eventId: string, seat: number, holdId: string): Promise<void>;
}

export interface SeatMapSnapshot {
  bitmap: Buffer;
  seq: number;
}

export interface SeatMapStore {
  /** `null` when the map key is missing (lost or expired): the caller rebuilds. */
  read(eventId: string, seatCount: number): Promise<SeatMapSnapshot | null>;
  /**
   * Sets or clears the seats' bits and assigns the next `seq` in one atomic step; `null` when the map is absent (the
   * change is then part of the next rebuild).
   */
  apply(
    eventId: string,
    seats: number[],
    set: boolean,
  ): Promise<{ seq: number } | null>;
  /** Writes a rebuilt map unless one exists; `seq` is seeded from the clock so it never goes backwards after a wipe. */
  seed(eventId: string, bitmap: Buffer, seq: number): Promise<SeatMapSnapshot>;
}

export interface QuotaStore {
  /** Claims `count` seats against `limit`; `'missing'` when the counter does not exist (rebuild, then claim again). */
  claim(
    eventId: string,
    userId: string,
    count: number,
    limit: number,
    ttlSec: number,
  ): Promise<
    { ok: true; used: number } | { ok: false; used: number } | 'missing'
  >;
  /** Seeds a rebuilt counter unless one exists (`SET NX`). */
  seed(
    eventId: string,
    userId: string,
    used: number,
    ttlSec: number,
  ): Promise<void>;
  /** Returns seats of an ended hold. Never below zero; a missing counter is left missing. */
  credit(eventId: string, userId: string, count: number): Promise<void>;
}

export interface GateRecord {
  eventId: string;
  shopId: string;
  status: EventStatus;
  salesOpenAtMs: number;
  startsAtMs: number;
  seatCount: number;
  seatsPerRow: number;
  seatingMode: SeatingMode;
  perUserLimit: number;
  admissionRatePerSec: number;
  humanCheckRequired: boolean;
}

/** Short-TTL mirror of the event facts the hot paths decide on (D-7); rebuilt from the row on a miss. */
export interface EventGate {
  get(eventId: string): Promise<GateRecord | null>;
  put(record: GateRecord): Promise<void>;
  del(eventId: string): Promise<void>;
}

export interface TicketView {
  ticket: string;
  admitted: boolean;
  /** 1-based global rank; absent once admitted. */
  position?: number;
  queueLength: number;
  expiresAtMs: number;
  admissionToken?: string;
  tokenExpiresAtMs?: number;
  /** The stack-clock instant the admitter admitted the ticket (J03). */
  admittedAtMs?: number;
}

export type JoinResult =
  { kind: 'created' | 'existing'; ticket: string } | { kind: 'full' };

export interface AdmitCandidate {
  ticket: string;
  userId: string;
}

export interface AdmittedItem extends AdmitCandidate {
  token: string;
  tokenExpiresAtMs: number;
}

export interface QueueStore {
  join(input: {
    eventId: string;
    userId: string;
    newTicket: string;
    score: number;
    nowMs: number;
    maxLength: number;
  }): Promise<JoinResult>;
  /** Takes back a ticket this call created (the join was refused afterwards). */
  retract(eventId: string, ticket: string, userId: string): Promise<void>;
  /** Refreshes the heartbeat and returns the ticket; `null` for an unknown, foreign, lapsed or finished ticket. */
  view(
    eventId: string,
    ticket: string,
    userId: string,
    nowMs: number,
  ): Promise<TicketView | null>;
  /** Owner of a ticket by its ID alone (the realtime topic policy). */
  ownerOf(ticket: string): Promise<string | null>;
  length(eventId: string): Promise<number>;
  /** Events with a waiting room (the admitter's work list). */
  activeEvents(): Promise<string[]>;
  retire(eventId: string): Promise<void>;
  /** Removes the waiting room of a closed event. */
  clear(eventId: string): Promise<void>;
  bucket(eventId: string): Promise<BucketState | null>;
  /** First tickets in global order that are still alive; lapsed ones are removed on the way. `stale` = fence too old. */
  peek(input: {
    eventId: string;
    want: number;
    fence: number;
    nowMs: number;
  }): Promise<{ stale: boolean; tickets: AdmitCandidate[] }>;
  /** Marks the tickets admitted and stores the bucket, guarded by the fence. */
  commit(input: {
    eventId: string;
    fence: number;
    nowMs: number;
    items: AdmittedItem[];
    bucketBefore: BucketState;
  }): Promise<{ stale: boolean; admitted: AdmittedItem[] }>;
  /** `true` the first time a bot-check result is presented (one-time use). */
  claimHumanResult(fingerprint: string): Promise<boolean>;
}

export interface HumanVerifier {
  /** `true` for a valid result; throws on provider outage or timeout (the caller fails closed). */
  verify(result: string): Promise<boolean>;
}

export interface AdmissionTokenPort {
  issue(input: {
    eventId: string;
    userId: string;
    ticket: string;
  }): Promise<{ token: string; expiresAtMs: number }>;
  /** Throws on any failure (signature, algorithm, issuer, audience, subject, purpose, expiry). */
  verify(
    token: string,
    expected: { eventId: string; userId: string },
  ): Promise<void>;
}

export const EVENT_REPOSITORY = Symbol('EVENT_REPOSITORY');
export const BOOKING_REPOSITORY = Symbol('BOOKING_REPOSITORY');
export const HOLD_LEDGER = Symbol('HOLD_LEDGER');
export const SEAT_LOCK_STORE = Symbol('SEAT_LOCK_STORE');
export const SEAT_MAP_STORE = Symbol('SEAT_MAP_STORE');
export const QUOTA_STORE = Symbol('QUOTA_STORE');
export const EVENT_GATE = Symbol('EVENT_GATE');
export const QUEUE_STORE = Symbol('QUEUE_STORE');
export const HUMAN_VERIFIER = Symbol('HUMAN_VERIFIER');
export const ADMISSION_TOKEN_PORT = Symbol('ADMISSION_TOKEN_PORT');
export const LAUNCH_RANDOM = Symbol('LAUNCH_RANDOM');
export const LAUNCH_EVENTS_CONFIG = Symbol('LAUNCH_EVENTS_CONFIG');

export interface LaunchEventsSettings {
  queueMaxLength: number;
}
