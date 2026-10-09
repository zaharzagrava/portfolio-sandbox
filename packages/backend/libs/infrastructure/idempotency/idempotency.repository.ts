import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { randomUUID } from 'node:crypto';

export interface IdempotencyRecord {
  scope: string;
  key: string;
  fingerprint: string;
  state: 'in_flight' | 'completed';
  claimToken: string;
  lockExpiresAt: Date;
  responseStatus: number | null;
  responseHeaders: Record<string, string> | null;
  responseBody: Buffer | null;
  bodyStored: boolean;
  expiresAt: Date;
}

export interface ClaimInput {
  scope: string;
  key: string;
  fingerprint: string;
  now: Date;
  ttlMs: number;
  lockMs: number;
}

export type ClaimResult =
  | { claimed: true; token: string }
  | { claimed: false; existing: IdempotencyRecord };

export interface CompleteInput {
  scope: string;
  key: string;
  token: string;
  status: number;
  headers: Record<string, string> | null;
  body: Buffer | null;
  bodyStored: boolean;
}

/** The store cannot be reached or answered with an error; the facility fails closed (FR-067). */
export class IdempotencyStoreUnavailable extends Error {
  constructor(cause: unknown) {
    super('idempotency store unavailable', { cause });
    this.name = 'IdempotencyStoreUnavailable';
  }
}

const COLUMNS = `scope, key, fingerprint, state, claim_token as "claimToken", lock_expires_at as "lockExpiresAt", response_status as "responseStatus",
  response_headers as "responseHeaders", response_body as "responseBody", body_stored as "bodyStored", expires_at as "expiresAt"`;

/**
 * The only code that touches `IdempotencyKey`. Every state change is one conditional statement (III.6, III.7):
 * the claim relies on `UNIQUE (scope, key)`, never check-then-write; completion and release assert the claim token.
 */
@Injectable()
export class IdempotencyRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  /** Atomically claims `(scope, key)`: a new row, an expired record, or a record whose lock expired for the same request. */
  async claim(input: ClaimInput): Promise<ClaimResult> {
    const token = randomUUID();
    const lockExpiresAt = new Date(input.now.getTime() + input.lockMs);
    const expiresAt = new Date(input.now.getTime() + input.ttlMs);
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const claimed = await this.sequelize.query(
          `INSERT INTO "IdempotencyKey" AS t (id, scope, key, fingerprint, state, claim_token, lock_expires_at, body_stored, created_at, expires_at)
           VALUES ($1, $2, $3, $4, 'in_flight', $5, $6, true, $7, $8)
           ON CONFLICT (scope, key) DO UPDATE SET
             fingerprint = EXCLUDED.fingerprint, state = 'in_flight', claim_token = EXCLUDED.claim_token, lock_expires_at = EXCLUDED.lock_expires_at,
             response_status = NULL, response_headers = NULL, response_body = NULL, body_stored = true, created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at
             WHERE t.expires_at <= $7 OR (t.state = 'in_flight' AND t.lock_expires_at <= $7 AND t.fingerprint = EXCLUDED.fingerprint)
           RETURNING 1`,
          {
            bind: [
              randomUUID(),
              input.scope,
              input.key,
              input.fingerprint,
              token,
              lockExpiresAt,
              input.now,
              expiresAt,
            ],
            type: QueryTypes.SELECT,
          },
        );
        if (claimed.length === 1) return { claimed: true, token };
        const existing = await this.find(input.scope, input.key);
        if (existing) return { claimed: false, existing };
        // the record vanished between the two statements (released or purged): claim again
      }
      throw new Error('could not settle the claim');
    } catch (error) {
      throw new IdempotencyStoreUnavailable(error);
    }
  }

  async find(
    scope: string,
    key: string,
  ): Promise<IdempotencyRecord | undefined> {
    const rows = await this.sequelize.query<IdempotencyRecord>(
      `SELECT ${COLUMNS} FROM "IdempotencyKey" WHERE scope = $1 AND key = $2`,
      {
        bind: [scope, key],
        type: QueryTypes.SELECT,
      },
    );
    return rows[0];
  }

  /** Stores the answer; false when the claim was taken over by another attempt in the meantime. */
  async complete(input: CompleteInput): Promise<boolean> {
    try {
      const rows = await this.sequelize.query(
        `UPDATE "IdempotencyKey" SET state = 'completed', response_status = $4, response_headers = $5::jsonb, response_body = $6, body_stored = $7
         WHERE scope = $1 AND key = $2 AND claim_token = $3 AND state = 'in_flight' RETURNING 1`,
        {
          bind: [
            input.scope,
            input.key,
            input.token,
            input.status,
            input.headers ? JSON.stringify(input.headers) : null,
            input.body,
            input.bodyStored,
          ],
          type: QueryTypes.SELECT,
        },
      );
      return rows.length === 1;
    } catch (error) {
      throw new IdempotencyStoreUnavailable(error);
    }
  }

  /** Deletes the claim so the key can be used again; false when the claim is no longer ours. */
  async release(scope: string, key: string, token: string): Promise<boolean> {
    try {
      const rows = await this.sequelize.query(
        `DELETE FROM "IdempotencyKey" WHERE scope = $1 AND key = $2 AND claim_token = $3 AND state = 'in_flight' RETURNING 1`,
        {
          bind: [scope, key, token],
          type: QueryTypes.SELECT,
        },
      );
      return rows.length === 1;
    } catch (error) {
      throw new IdempotencyStoreUnavailable(error);
    }
  }

  /** Deletes at most `batch` records whose retention (expiry + 1 h) is over; returns how many went. */
  async purge(batch: number, now: Date): Promise<number> {
    const rows = await this.sequelize.query<{ n: number }>(
      'SELECT purge_idempotency_keys($1, $2) AS n',
      { bind: [batch, now], type: QueryTypes.SELECT },
    );
    return rows[0]?.n ?? 0;
  }
}
