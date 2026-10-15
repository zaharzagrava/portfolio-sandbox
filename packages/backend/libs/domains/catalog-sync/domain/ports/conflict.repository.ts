import type {
  ConflictKind,
  ConflictRecord,
  ConflictStatus,
  ListPage,
  PageQuery,
} from './records';

export const CONFLICT_REPOSITORY = Symbol('CONFLICT_REPOSITORY');

export interface OpenConflictInput {
  integrationId: string;
  shopId: string;
  externalId: string;
  productId: string | null;
  kind: ConflictKind;
  base: number;
  local: number;
  remote: number;
  merged: number | null;
  resolvedTo: number | null;
}

export interface ConflictRepository {
  /** Unique OPEN per `(integration, externalId, base, local, remote)`: a re-run returns the existing row, `created: false`. */
  open(
    input: OpenConflictInput,
    now: Date,
  ): Promise<{ conflict: ConflictRecord; created: boolean }>;
  findInIntegration(
    integrationId: string,
    id: string,
  ): Promise<ConflictRecord | null>;
  /** Conditional OPEN -> DISMISSED; `null` when not OPEN. */
  dismiss(
    integrationId: string,
    id: string,
    actorId: string | null,
    resolution: string | null,
    now: Date,
  ): Promise<ConflictRecord | null>;
  /** `(createdAt DESC, id DESC)`. */
  listPage(
    integrationId: string,
    query: PageQuery & { status?: ConflictStatus },
  ): Promise<ListPage<ConflictRecord>>;
  countOpen(integrationId: string): Promise<number>;
  /** Retention (AS-76): `DISMISSED` rows dismissed before `before`, oldest first. Returns the deleted count. */
  purgeDismissedBefore(before: Date, limit: number): Promise<number>;
  /** Retention: `OPEN` rows created before `before` become `DISMISSED(expired)`, oldest first. Returns the count. */
  expireOpenBefore(before: Date, now: Date, limit: number): Promise<number>;
  /** All integrations (the `catalog_sync_conflicts_open` gauge). */
  countAllOpen(): Promise<number>;
}
