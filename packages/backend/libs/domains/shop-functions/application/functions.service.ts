import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { afterCommit, TransactionRunner } from '@app/infrastructure/context';
import type { TestCase } from '../domain/contract';
import { functionNotFound, functionStateConflict } from '../domain/errors';
import {
  ACTIVE_SET_CACHE,
  BREAKER_STORE,
  FUNCTION_REPOSITORY,
  TEST_CASE_REPOSITORY,
  type ActiveSetCache,
  type BreakerStore,
  type FunctionRepository,
  type FunctionView,
  type KeysetPage,
  type TestCaseRepository,
} from '../domain/ports';
import type { BreakerView } from '../domain/breaker';
import { CLOSED_BREAKER, breakerView } from '../domain/breaker';
import { EntitlementGate } from './entitlement-gate';
import { ShopFunctionsConfig } from './shop-functions.config';

export interface FunctionWithBreaker {
  function: FunctionView;
  breaker: BreakerView;
}

/** Management of functions and their current test suites (S45 US1). One transaction per write; caches dropped after commit. */
@Injectable()
export class FunctionsService {
  private readonly logger = new Logger(FunctionsService.name);

  constructor(
    @Inject(FUNCTION_REPOSITORY) private readonly functions: FunctionRepository,
    @Inject(TEST_CASE_REPOSITORY) private readonly cases: TestCaseRepository,
    @Inject(ACTIVE_SET_CACHE) private readonly activeSet: ActiveSetCache,
    @Inject(BREAKER_STORE) private readonly breakers: BreakerStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly gate: EntitlementGate,
    private readonly runner: TransactionRunner,
    private readonly config: ShopFunctionsConfig,
  ) {}

  async create(
    shopId: string,
    name: string,
    tests: TestCase[],
  ): Promise<FunctionWithBreaker> {
    await this.gate.require(shopId);
    const id = await this.runner.run(async () => {
      const created = await this.functions.create(
        shopId,
        name,
        this.config.maxFunctionsPerShop,
      );
      await this.cases.replaceCurrent(shopId, created.id, tests);
      return created.id;
    });
    return this.read(shopId, id);
  }

  async list(
    shopId: string,
    limit: number,
    cursor: string | null,
  ): Promise<KeysetPage<FunctionWithBreaker>> {
    const page = await this.functions.list(shopId, limit, cursor);
    return {
      nextCursor: page.nextCursor,
      items: await Promise.all(
        page.items.map(async (fn) => ({
          function: fn,
          breaker: await this.breakerOf(fn.id),
        })),
      ),
    };
  }

  async read(shopId: string, functionId: string): Promise<FunctionWithBreaker> {
    const fn = await this.functions.find(shopId, functionId);
    if (!fn) throw functionNotFound();
    return { function: fn, breaker: await this.breakerOf(fn.id) };
  }

  async remove(shopId: string, functionId: string): Promise<void> {
    await this.runner.run(async () => {
      if (!(await this.functions.delete(shopId, functionId)))
        throw functionNotFound();
      this.dropAfterCommit(shopId);
    });
  }

  async enable(shopId: string, functionId: string) {
    await this.gate.require(shopId);
    return this.toggle(shopId, functionId, true);
  }

  disable(shopId: string, functionId: string) {
    return this.toggle(shopId, functionId, false);
  }

  async tests(shopId: string, functionId: string): Promise<TestCase[]> {
    const current = await this.cases.current(shopId, functionId);
    if (!current) throw functionNotFound();
    return current;
  }

  async replaceTests(
    shopId: string,
    functionId: string,
    tests: TestCase[],
  ): Promise<TestCase[]> {
    await this.gate.require(shopId);
    const done = await this.runner.run(() =>
      this.cases.replaceCurrent(shopId, functionId, tests),
    );
    if (!done) throw functionNotFound();
    return tests;
  }

  private async toggle(shopId: string, functionId: string, enabled: boolean) {
    await this.runner.run(async () => {
      const changed = await this.functions.setEnabled(
        shopId,
        functionId,
        enabled,
      );
      if (changed === null) throw functionNotFound();
      if (!changed) throw functionStateConflict();
      this.dropAfterCommit(shopId);
    });
    return this.read(shopId, functionId);
  }

  private dropAfterCommit(shopId: string) {
    afterCommit(() => this.activeSet.drop(shopId));
  }

  private async breakerOf(functionId: string): Promise<BreakerView> {
    try {
      return await this.breakers.view(functionId, this.clock.nowMs());
    } catch (error) {
      // The breaker is operational state: a store outage must not fail a read.
      this.logger.warn(`breaker state unavailable: ${(error as Error).name}`);
      return breakerView(CLOSED_BREAKER, this.clock.nowMs());
    }
  }
}
