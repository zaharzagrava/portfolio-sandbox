import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import {
  API_KEY_LIMITS,
  type ApiKeyListItem,
  type CreatedApiKey,
} from '@marketplace-sandbox/contracts';
import {
  ApiScope,
  generateUniqueApiKey,
  hashSecretWithVersion,
  MintedApiKey,
} from '../domain/api-key-format';
import { ApiError, resourceMissing } from '../domain/errors';
import { assertTransition, deriveKeyStatus } from '../domain/key-status';
import {
  ApiKeyRecord,
  ApiKeyRepository,
  KeyCache,
  NewApiKey,
} from '../domain/ports';
import { latestVersion } from '../domain/version-registry';
import { KeyPeppers } from './key-peppers';

const DAY_MS = 86_400_000;
const MAX_MINT_ATTEMPTS = 5;
const PAGE_DEFAULT = 20;
const PAGE_MAX = 100;

/** Who acts: the signed-in manager (`amr` comes from verified token claims). */
export interface KeyActor {
  userId: string;
  amr: readonly string[];
}

export interface CreateKeyInput {
  name: string;
  scopes: ApiScope[];
  livemode: boolean;
  expiresAt?: Date;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/**
 * Dashboard side of the keys (FR-001…FR-012): create under the per-shop limit, conditional rotate, idempotent revoke,
 * list with the derived status. The clock is injected; secrets exist only in the response of create and rotate.
 */
@Injectable()
export class ApiKeysService {
  constructor(
    private readonly keys: ApiKeyRepository,
    private readonly cache: KeyCache,
    private readonly peppers: KeyPeppers,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async create(
    shopId: string,
    actor: KeyActor,
    input: CreateKeyInput,
  ): Promise<CreatedApiKey> {
    const now = this.clock.now();
    this.assertExpiry(input.expiresAt, now);
    this.assertStepUp(input.livemode, actor);
    for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt += 1) {
      const minted = await this.mint(input.livemode);
      const result = await this.keys.createWithLimit({
        key: this.newKey(shopId, actor.userId, minted, input),
        now,
        limit: API_KEY_LIMITS.perShop,
        latestVersion: latestVersion(),
      });
      if (result.outcome === 'prefix_taken') continue;
      if (result.outcome === 'limit_reached')
        throw new ApiError(
          'key_limit_reached',
          `A shop can have at most ${API_KEY_LIMITS.perShop} active API keys.`,
        );
      return this.toCreated(result.record, minted.key, now);
    }
    throw new Error('Could not mint an unused API key prefix');
  }

  async rotate(
    shopId: string,
    keyId: string,
    actor: KeyActor,
    overlapHours: number = API_KEY_LIMITS.overlapHours.default,
  ): Promise<CreatedApiKey & { previousExpiresAt: string | null }> {
    const existing = await this.keys.findForShop(shopId, keyId);
    if (!existing) throw resourceMissing();
    this.assertStepUp(existing.livemode, actor);
    const now = this.clock.now();
    for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt += 1) {
      const minted = await this.mint(existing.livemode);
      const result = await this.keys.rotate({
        shopId,
        keyId,
        successor: this.newKey(shopId, actor.userId, minted, {
          name: existing.name,
          scopes: existing.scopes,
          livemode: existing.livemode,
          expiresAt: undefined,
        }),
        overlapHours,
        now,
        actorId: actor.userId,
      });
      switch (result.outcome) {
        case 'prefix_taken':
          continue;
        case 'not_found':
          throw resourceMissing();
        case 'illegal':
          assertTransition(deriveKeyStatus(result.current, now), 'rotate');
          throw new ApiError(
            'key_already_rotating',
            'The key cannot be rotated.',
          );
        case 'rotated':
          // the old key's expiry changed: every instance re-reads it
          await this.cache.invalidate(result.old.prefix).catch(() => undefined);
          return {
            ...this.toCreated(result.successor, minted.key, now),
            previousExpiresAt: iso(result.old.expiresAt),
          };
      }
    }
    throw new Error('Could not mint an unused API key prefix');
  }

  /** Idempotent: a repeat answers the same and emits nothing (FR-007). */
  async revoke(shopId: string, keyId: string, actor: KeyActor): Promise<void> {
    const result = await this.keys.revoke({
      shopId,
      keyId,
      now: this.clock.now(),
      actorId: actor.userId,
      reason: 'manual',
    });
    if (result.outcome === 'not_found') throw resourceMissing();
    // after the commit: no verification that started before it may bring the key back (tombstone outlives every entry)
    await this.cache.tombstone(result.record.prefix);
  }

  async list(
    shopId: string,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<{ items: ApiKeyListItem[]; nextCursor: string | null }> {
    const limit = options.limit ?? PAGE_DEFAULT;
    if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX)
      throw new ApiError('validation_failed', 'limit must be 1 to 100.', {
        errors: [{ field: 'limit', code: 'range' }],
      });
    const after = options.cursor ? this.decodeCursor(options.cursor) : null;
    const found = await this.keys.list(shopId, limit + 1, after);
    const page = found.slice(0, limit);
    const last = page[page.length - 1];
    const now = this.clock.now();
    return {
      items: page.map((k) => ({
        id: k.id,
        prefix: k.prefix,
        name: k.name,
        scopes: k.scopes,
        livemode: k.livemode,
        status: deriveKeyStatus(k, now),
        expiresAt: iso(k.expiresAt),
        lastUsedAt: iso(k.lastUsedAt),
        createdBy: k.createdBy,
        createdAt: k.createdAt.toISOString(),
        ...(k.successorId ? { successorId: k.successorId } : {}),
      })),
      nextCursor:
        found.length > limit && last
          ? this.encodeCursor({
              createdAt: last.createdAt.toISOString(),
              id: last.id,
            })
          : null,
    };
  }

  // ---------------------------------------------------------------- internals

  private assertExpiry(expiresAt: Date | undefined, now: Date): void {
    if (!expiresAt) return;
    const t = expiresAt.getTime();
    if (t <= now.getTime())
      throw new ApiError(
        'validation_failed',
        'expiresAt must be in the future.',
        {
          errors: [{ field: 'expiresAt', code: 'must_be_future' }],
        },
      );
    if (t > now.getTime() + API_KEY_LIMITS.expiresInDaysMax * DAY_MS)
      throw new ApiError(
        'validation_failed',
        `expiresAt must be at most ${API_KEY_LIMITS.expiresInDaysMax} days away.`,
        { errors: [{ field: 'expiresAt', code: 'too_far' }] },
      );
  }

  /** Creating or rotating a live key needs a session that passed a second factor (FR-011). */
  private assertStepUp(livemode: boolean, actor: KeyActor): void {
    if (livemode && !actor.amr.includes('mfa'))
      throw new ApiError(
        'mfa_required',
        'A second factor is required to create or rotate a live key.',
      );
  }

  private mint(livemode: boolean): Promise<MintedApiKey> {
    return generateUniqueApiKey(livemode, (prefix) =>
      this.keys.prefixExists(prefix),
    );
  }

  private newKey(
    shopId: string,
    createdBy: string,
    minted: MintedApiKey,
    input: CreateKeyInput,
  ): NewApiKey {
    return {
      shopId,
      createdBy,
      name: input.name,
      scopes: input.scopes,
      livemode: input.livemode,
      expiresAt: input.expiresAt ?? null,
      prefix: minted.prefix,
      hash: hashSecretWithVersion(minted.secret, this.peppers.current, 1),
    };
  }

  private toCreated(
    record: ApiKeyRecord,
    key: string,
    now: Date,
  ): CreatedApiKey {
    return {
      id: record.id,
      key,
      prefix: record.prefix,
      name: record.name,
      scopes: record.scopes,
      livemode: record.livemode,
      status: deriveKeyStatus(record, now),
      expiresAt: iso(record.expiresAt),
      createdAt: record.createdAt.toISOString(),
    };
  }

  private encodeCursor(c: { createdAt: string; id: string }): string {
    return Buffer.from(JSON.stringify({ v: 1, ...c })).toString('base64url');
  }

  private decodeCursor(raw: string): { createdAt: string; id: string } {
    try {
      const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
      if (
        c?.v === 1 &&
        typeof c.createdAt === 'string' &&
        !Number.isNaN(Date.parse(c.createdAt)) &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          c.id,
        )
      )
        return { createdAt: c.createdAt, id: c.id };
    } catch {
      // falls through
    }
    throw new ApiError('invalid_cursor', 'The cursor is not valid.');
  }
}
