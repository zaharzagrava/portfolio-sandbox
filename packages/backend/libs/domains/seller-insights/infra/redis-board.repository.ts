import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { CLOCK, type Clock } from '@app/common/core/clock';
import {
  BoardStoreUnavailableError,
  RevenueLimitExceededError,
} from '../domain/errors';
import { expiresAtMs, type Period } from '../domain/periods';
import type {
  ApplyOutcome,
  BoardRepository,
  RankedShop,
  ShopPosition,
} from '../domain/ports';
import { revenueOfKey, slotOf } from '../domain/ranking-key';
import type { BoardUpdate } from '../domain/sale-facts';
import { APPLY_ORDER_SCRIPT, POSITION_SCRIPT } from './board.lua';
import {
  appliedKey,
  boardKey,
  BOARDS_KEY_PATTERN,
  boardsKey,
  lastSlotKey,
  revenueKey,
  sealedKey,
} from './redis-keys';

/** The Redis client of the boards; a spec swaps it for one that fails on demand. */
export const INSIGHTS_REDIS = Symbol('SELLER_INSIGHTS_REDIS');
/** Board store calls give up after 500 ms (S40 FR-045). */
export const BOARD_TIMEOUT_MS = 500;

@Injectable()
export class RedisBoardRepository implements BoardRepository {
  constructor(
    @Inject(INSIGHTS_REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private async guarded<T>(call: () => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        call(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new BoardStoreUnavailableError('timeout')),
            BOARD_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (error) {
      throw error instanceof BoardStoreUnavailableError
        ? error
        : new BoardStoreUnavailableError(error);
    } finally {
      clearTimeout(timer);
    }
  }

  async apply(
    period: Period,
    orderId: string,
    saleAt: Date,
    updates: BoardUpdate[],
  ): Promise<ApplyOutcome> {
    const boards = [...new Set(updates.map((u) => u.board))];
    const keys = [
      appliedKey(period),
      sealedKey(period),
      revenueKey(period),
      lastSlotKey(period),
      boardsKey(period),
      ...boards.map((board) => boardKey(period, board)),
    ];
    const args: Array<string | number> = [
      this.ttlMs(period),
      orderId,
      slotOf(period, saleAt),
      updates.length,
    ];
    for (const u of updates)
      args.push(boards.indexOf(u.board) + 1, u.board, u.shopId, u.amountMinor);
    const [status, value] = await this.guarded(
      () =>
        this.redis.eval(
          APPLY_ORDER_SCRIPT,
          keys.length,
          ...keys,
          ...args,
        ) as Promise<[string, string]>,
    );
    if (status === 'limit') throw new RevenueLimitExceededError(Number(value));
    return status as ApplyOutcome;
  }

  top(period: Period, board: string, limit: number): Promise<string[]> {
    return this.guarded(() =>
      this.redis.zrevrange(boardKey(period, board), 0, limit - 1),
    );
  }

  async position(
    period: Period,
    board: string,
    shopId: string,
  ): Promise<ShopPosition | null> {
    const result = await this.guarded(
      () =>
        this.redis.eval(
          POSITION_SCRIPT,
          2,
          boardKey(period, board),
          revenueKey(period),
          `${board}|${shopId}`,
          shopId,
        ) as Promise<[number, number, string] | null>,
    );
    if (!result) return null;
    return {
      rank: Number(result[0]),
      of: Number(result[1]),
      revenueMinor: Number(result[2]),
    };
  }

  async topWithRevenue(
    period: Period,
    board: string,
    limit: number,
  ): Promise<RankedShop[]> {
    const flat = await this.guarded(() =>
      this.redis.zrevrange(boardKey(period, board), 0, limit - 1, 'WITHSCORES'),
    );
    const out: RankedShop[] = [];
    for (let i = 0; i < flat.length; i += 2)
      out.push({
        shopId: flat[i],
        revenueMinor: revenueOfKey(Number(flat[i + 1])),
      });
    return out;
  }

  size(period: Period, board: string): Promise<number> {
    return this.guarded(() => this.redis.zcard(boardKey(period, board)));
  }

  boards(period: Period): Promise<string[]> {
    return this.guarded(() => this.redis.smembers(boardsKey(period)));
  }

  async isSealed(period: Period): Promise<boolean> {
    return (
      (await this.guarded(() => this.redis.exists(sealedKey(period)))) === 1
    );
  }

  async seal(period: Period): Promise<void> {
    await this.guarded(() =>
      this.redis.set(sealedKey(period), '1', 'PX', this.ttlMs(period)),
    );
  }

  /** Every key of a period lives until the period end plus 35 days, counted from the injected clock. */
  private ttlMs(period: Period): number {
    return Math.max(1, expiresAtMs(period) - this.clock.nowMs());
  }

  async removeShop(shopId: string): Promise<void> {
    let cursor = '0';
    do {
      const [next, keys] = await this.guarded(() =>
        this.redis.scan(cursor, 'MATCH', BOARDS_KEY_PATTERN, 'COUNT', 500),
      );
      cursor = next;
      for (const key of keys) {
        const periodId = /^lb:\{(.+)\}:boards$/.exec(key)?.[1];
        if (!periodId) continue;
        const period = { id: periodId };
        const boards = await this.guarded(() => this.redis.smembers(key));
        const pipeline = this.redis.pipeline();
        for (const board of boards) {
          pipeline.zrem(boardKey(period, board), shopId);
          pipeline.hdel(revenueKey(period), `${board}|${shopId}`);
          pipeline.hdel(lastSlotKey(period), `${board}|${shopId}`);
        }
        await this.guarded(() => pipeline.exec());
      }
    } while (cursor !== '0');
  }
}
