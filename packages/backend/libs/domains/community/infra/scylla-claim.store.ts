import { Injectable } from '@nestjs/common';
import {
  IDEMPOTENCY_WINDOW_MS,
  type ClaimResult,
  type ClaimStore,
} from '../domain/ports';
import { ScyllaStore } from './scylla-store';

/** 25 hours: the platform idempotency record lives 24 h, the claim must outlive any replay of it. */
const CLAIM_TTL_SECONDS = 90_000;

/**
 * `create_claims` (S25 A2, R-4): before a post or comment batch, the first caller of (user, key) owns the entity id.
 * A retry of a request that crashed between the batch and the response finds the same id and writes the same rows.
 */
@Injectable()
export class ScyllaClaimStore implements ClaimStore {
  constructor(private readonly store: ScyllaStore) {}

  async claim(
    userId: string,
    keyHash: string,
    kind: 'post' | 'comment',
    entityId: string,
    note: string,
    createdAt: Date,
  ): Promise<ClaimResult> {
    const { applied, row } = await this.store.lwt(
      `INSERT INTO create_claims (user_id, key_hash, kind, entity_id, fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?) IF NOT EXISTS USING TTL ${CLAIM_TTL_SECONDS}`,
      [userId, keyHash, kind, entityId, note, createdAt],
    );
    if (applied) return { claimed: true, entityId, note };

    const existing: Date = row.get('created_at');
    if (createdAt.getTime() - existing.getTime() >= IDEMPOTENCY_WINDOW_MS) {
      const taken = await this.store.lwt(
        `UPDATE create_claims USING TTL ${CLAIM_TTL_SECONDS} SET kind = ?, entity_id = ?, fingerprint = ?, created_at = ? WHERE user_id = ? AND key_hash = ? IF created_at = ?`,
        [kind, entityId, note, createdAt, userId, keyHash, existing],
      );
      if (taken.applied) return { claimed: true, entityId, note };
    }
    return {
      claimed: false,
      entityId: row.get('entity_id').toString(),
      note: row.get('fingerprint') ?? '',
    };
  }
}
