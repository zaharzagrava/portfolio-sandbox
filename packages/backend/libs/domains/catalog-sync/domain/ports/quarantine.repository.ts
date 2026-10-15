import type {
  ListPage,
  PageQuery,
  QuarantineRecord,
  QuarantineResolution,
  QuarantineStatus,
} from './records';

export const QUARANTINE_REPOSITORY = Symbol('QUARANTINE_REPOSITORY');

export interface QuarantineInput {
  integrationId: string;
  entity: string;
  externalId: string | null;
  /** externalId, or the payload digest when there is none. */
  dedupeKey: string;
  payloadDigest: string | null;
  reasonCode: string;
  /** Truncated to 500 characters by the repository. */
  message: string;
  payload: unknown;
}

export interface QuarantineRepository {
  /** `INSERT ... ON CONFLICT (integrationId, entity, dedupeKey) WHERE status='OPEN' DO UPDATE occurrences+1, lastSeenAt`. */
  record(input: QuarantineInput, now: Date): Promise<QuarantineRecord>;
  /** Auto-resolve on a successful apply: OPEN -> RESOLVED(fixed_at_provider). Returns the count. */
  resolveByDedupeKey(
    integrationId: string,
    entity: string,
    dedupeKey: string,
    now: Date,
  ): Promise<number>;
  /** `resolveByDedupeKey` for many keys in one statement. */
  resolveMany(
    integrationId: string,
    entity: string,
    dedupeKeys: string[],
    now: Date,
  ): Promise<number>;
  /** Conditional OPEN -> RESOLVED|DISMISSED; `null` when not OPEN (or not in the integration). */
  close(
    integrationId: string,
    id: string,
    to: Exclude<QuarantineStatus, 'OPEN'>,
    resolution: QuarantineResolution,
    actorId: string | null,
    now: Date,
  ): Promise<QuarantineRecord | null>;
  findInIntegration(
    integrationId: string,
    id: string,
  ): Promise<QuarantineRecord | null>;
  /** `(firstSeenAt DESC, id DESC)`. */
  listPage(
    integrationId: string,
    query: PageQuery & { status?: QuarantineStatus },
  ): Promise<ListPage<QuarantineRecord>>;
  countOpen(integrationId: string): Promise<number>;
  /** Retention (AS-76): `RESOLVED`/`DISMISSED` rows closed before `before`, oldest first. Returns the deleted count. */
  purgeClosedBefore(before: Date, limit: number): Promise<number>;
  /** Retention: `OPEN` rows first seen before `before` become `DISMISSED(expired)`, oldest first. Returns the count. */
  expireOpenBefore(before: Date, now: Date, limit: number): Promise<number>;
  /** All integrations (the `catalog_sync_quarantine_open` gauge). */
  countAllOpen(): Promise<number>;
}
