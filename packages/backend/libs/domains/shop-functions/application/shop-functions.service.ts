import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { CheckoutDiscounts, DiscountableLine } from '@app/domains/orders';
import { applyDiscounts, FunctionInput } from '../domain/contract';
import { FunctionSandbox } from '../infra/sandbox';

export const TEST_RUN_QUEUE = 'function-test-runs';
const CHECKOUT_BUDGET_MS = 5;
const TEST_BUDGET_MS = 50;
const BREAKER_FAILURES = 5;
const BREAKER_OPEN_SEC = 300;
const MEMO_SEC = 60;

interface ActiveFunction {
  id: string;
  shopId: string;
  version: number;
  source: string;
  sourceHash: string;
}

/**
 * The "online judge" for seller code (10/09 #40) + its checkout use.
 *   submit → QUEUED → test-run worker runs every seller test case in the
 *   sandbox → all pass: ACTIVE (previous version SUPERSEDED) / else REJECTED
 *   with per-case verdicts (pass / wrong-output / timeout / runtime error).
 */
@Injectable()
export class ShopFunctionsService extends CheckoutDiscounts implements OnModuleDestroy {
  private readonly logger = new Logger(ShopFunctionsService.name);
  readonly sandbox = new FunctionSandbox();

  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly redis: RedisService,
    private readonly queue: TaskQueue,
  ) {
    super();
  }

  onModuleDestroy() {
    this.sandbox.dispose();
  }

  async create(shopId: string, name: string, tests: { name: string; input: FunctionInput; expected: unknown }[]) {
    if (tests.length === 0) throw new BadRequestException('At least one test case is required');
    return this.sequelize.transaction(async (transaction) => {
      const [fn] = await this.sequelize.query<{ id: string }>(`INSERT INTO "ShopFunction" ("shopId", name) VALUES (:shopId, :name) RETURNING id`, { type: QueryTypes.SELECT, replacements: { shopId, name }, transaction });
      for (const t of tests) {
        await this.sequelize.query(`INSERT INTO "ShopFunctionTestCase" ("functionId", name, input, expected) VALUES (:id, :name, CAST(:input AS jsonb), CAST(:expected AS jsonb))`, {
          replacements: { id: fn.id, name: t.name, input: JSON.stringify(t.input), expected: JSON.stringify(t.expected) },
          transaction,
        });
      }
      return { functionId: fn.id };
    });
  }

  async submit(shopId: string, functionId: string, userId: string, source: string) {
    if (source.length > 20_000) throw new BadRequestException('max 20 KB');
    if (!/function\s+run\s*\(/.test(source)) throw new BadRequestException('define `function run(input)`');
    const [v] = await this.sequelize.query<{ version: number }>(
      `INSERT INTO "ShopFunctionVersion" ("functionId", version, source, "sourceHash", "createdBy")
       SELECT f.id, coalesce((SELECT max(version) FROM "ShopFunctionVersion" WHERE "functionId" = f.id), 0) + 1, :source, :hash, :userId FROM "ShopFunction" f WHERE f.id = :functionId AND f."shopId" = :shopId
       RETURNING version`,
      { type: QueryTypes.SELECT, replacements: { functionId, shopId, source, hash: FunctionSandbox.hash(source), userId } },
    );
    if (!v) throw new NotFoundException('Function not found');
    await this.queue.enqueue(TEST_RUN_QUEUE, { functionId, version: v.version });
    return { version: v.version, status: 'QUEUED' };
  }

  /** Test-run worker. Verdicts are stored per case so sellers see exactly what failed. */
  async judge(functionId: string, version: number) {
    const [v] = await this.sequelize.query<{ source: string; status: string; shopId: string }>(
      `UPDATE "ShopFunctionVersion" fv SET status = 'TESTING' FROM "ShopFunction" f WHERE f.id = fv."functionId" AND fv."functionId" = :functionId AND fv.version = :version AND fv.status IN ('QUEUED', 'TESTING')
       RETURNING fv.source, fv.status, f."shopId"`,
      { type: QueryTypes.SELECT, replacements: { functionId, version } },
    );
    if (!v) return null;
    const cases = await this.sequelize.query<{ name: string; input: FunctionInput; expected: unknown }>(`SELECT name, input, expected FROM "ShopFunctionTestCase" WHERE "functionId" = :functionId ORDER BY name`, {
      type: QueryTypes.SELECT,
      replacements: { functionId },
    });
    const verdicts: { case: string; verdict: string; detail?: string; actual?: unknown; ms: number }[] = [];
    for (const c of cases) {
      const res = await this.sandbox.run(v.source, c.input, TEST_BUDGET_MS);
      verdicts.push(
        res.ok
          ? { case: c.name, verdict: isDeepStrictEqual(res.output, c.expected) ? 'pass' : 'wrong-output', actual: res.output, ms: Math.round(res.ms * 100) / 100 }
          : { case: c.name, verdict: res.error, detail: res.detail, ms: Math.round(res.ms * 100) / 100 },
      );
    }
    const accepted = verdicts.every((x) => x.verdict === 'pass');
    await this.sequelize.transaction(async (transaction) => {
      await this.sequelize.query(`UPDATE "ShopFunctionVersion" SET status = :status, verdicts = CAST(:verdicts AS jsonb) WHERE "functionId" = :functionId AND version = :version`, {
        replacements: { status: accepted ? 'ACTIVE' : 'REJECTED', verdicts: JSON.stringify(verdicts), functionId, version },
        transaction,
      });
      if (accepted) {
        await this.sequelize.query(`UPDATE "ShopFunctionVersion" SET status = 'SUPERSEDED' WHERE "functionId" = :functionId AND version <> :version AND status = 'ACTIVE'`, { replacements: { functionId, version }, transaction });
        await this.sequelize.query(`UPDATE "ShopFunction" SET "activeVersion" = :version WHERE id = :functionId`, { replacements: { functionId, version }, transaction });
      }
    });
    await this.redis.client.del(`fn:active:${v.shopId}`);
    return { status: accepted ? 'ACTIVE' : 'REJECTED', verdicts };
  }

  /**
   * Checkout hook: per shop in the cart, run its active functions on THAT
   * shop's lines only, 5 ms each. Timeout, crash, invalid output or an open
   * breaker → that function contributes nothing (fail-safe: customers pay
   * catalogue price, checkout never breaks). Results memoised 60 s per
   * (version, cart lines) - checkout retries and page refreshes don't re-run code.
   */
  async unitPrices(lines: DiscountableLine[]): Promise<number[]> {
    const prices = lines.map((l) => l.unitPrice);
    const byShop = new Map<string, number[]>();
    lines.forEach((l, i) => l.shopId && byShop.set(l.shopId, [...(byShop.get(l.shopId) ?? []), i]));

    for (const [shopId, indexes] of byShop) {
      for (const fn of await this.active(shopId)) {
        if (await this.breakerOpen(fn.id)) continue;
        const input: FunctionInput = { currency: 'usd', lines: indexes.map((i) => ({ productId: lines[i].productId, category: lines[i].category, quantity: lines[i].quantity, unitPrice: prices[i] })) };
        const memoKey = `fn:memo:${fn.sourceHash}:${createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 32)}`;
        let next: number[] | null = JSON.parse((await this.redis.client.get(memoKey)) ?? 'null');
        if (!next) {
          const res = await this.sandbox.run(fn.source, input, CHECKOUT_BUDGET_MS);
          if (!res.ok) {
            await this.recordFailure(fn.id, res.error);
            continue;
          }
          next = applyDiscounts(input.lines, res.output);
          await this.redis.client.set(memoKey, JSON.stringify(next), 'EX', MEMO_SEC);
        }
        indexes.forEach((lineIndex, j) => (prices[lineIndex] = Math.min(prices[lineIndex], next![j])));
      }
    }
    return prices;
  }

  private async active(shopId: string): Promise<ActiveFunction[]> {
    const cached = await this.redis.client.get(`fn:active:${shopId}`);
    if (cached) return JSON.parse(cached) as ActiveFunction[];
    const rows = await this.sequelize.query<ActiveFunction>(
      `SELECT f.id, f."shopId", v.version, v.source, v."sourceHash" FROM "ShopFunction" f JOIN "ShopFunctionVersion" v ON v."functionId" = f.id AND v.version = f."activeVersion"
       WHERE f."shopId" = :shopId AND f.enabled ORDER BY f.name`,
      { type: QueryTypes.SELECT, replacements: { shopId } },
    );
    await this.redis.client.set(`fn:active:${shopId}`, JSON.stringify(rows), 'EX', 60);
    return rows;
  }

  private async breakerOpen(functionId: string) {
    return (await this.redis.client.exists(`fn:breaker:${functionId}`)) === 1;
  }

  /** 5 failures within a minute → skip the function for 5 minutes (a slow function would otherwise add 5 ms to every checkout). */
  private async recordFailure(functionId: string, reason: string) {
    const key = `fn:failures:${functionId}`;
    const n = await this.redis.client.incr(key);
    await this.redis.client.expire(key, 60);
    if (n >= BREAKER_FAILURES) {
      await this.redis.client.set(`fn:breaker:${functionId}`, reason, 'EX', BREAKER_OPEN_SEC);
      this.logger.warn(`shop function ${functionId} breaker opened (${reason})`);
    }
  }
}
