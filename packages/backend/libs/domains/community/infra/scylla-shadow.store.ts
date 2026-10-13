import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import type { ShadowStore } from '../domain/ports';
import { ScyllaStore } from './scylla-store';

/** How long a ban lookup is trusted on this instance (S25 F1: a fresh ban may be missed for up to a minute). */
const LOCAL_CACHE_MS = 60_000;

/** `shadow_bans` (S25 FR-051): a row means the user's new content is shadow. */
@Injectable()
export class ScyllaShadowStore implements ShadowStore {
  private readonly local = new Map<
    string,
    { banned: boolean; until: number }
  >();

  constructor(
    private readonly store: ScyllaStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async isBanned(userId: string): Promise<boolean> {
    const now = this.clock.nowMs();
    const cached = this.local.get(userId);
    if (cached && cached.until > now) return cached.banned;
    const banned =
      (
        await this.store.read(
          'SELECT user_id FROM shadow_bans WHERE user_id = ?',
          [userId],
        )
      ).first() !== null;
    this.local.set(userId, { banned, until: now + LOCAL_CACHE_MS });
    return banned;
  }

  async ban(userId: string, setBy: string, at: Date): Promise<void> {
    await this.store.write(
      'INSERT INTO shadow_bans (user_id, set_by, set_at) VALUES (?, ?, ?)',
      [userId, setBy, at],
    );
    this.local.set(userId, {
      banned: true,
      until: at.getTime() + LOCAL_CACHE_MS,
    });
  }

  async lift(userId: string): Promise<void> {
    await this.store.write('DELETE FROM shadow_bans WHERE user_id = ?', [
      userId,
    ]);
    this.local.set(userId, {
      banned: false,
      until: this.clock.nowMs() + LOCAL_CACHE_MS,
    });
  }
}
