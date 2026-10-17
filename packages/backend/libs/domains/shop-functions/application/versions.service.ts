import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { afterCommit, TransactionRunner } from '@app/infrastructure/context';
import { sourceHash } from '../domain/source-hash';
import {
  functionNotFound,
  versionNotActivatable,
  versionNotFound,
} from '../domain/errors';
import {
  ACTIVE_SET_CACHE,
  FUNCTION_REPOSITORY,
  JUDGE_REQUESTS,
  VERSION_REPOSITORY,
  type ActiveSetCache,
  type FunctionRepository,
  type JudgeRequests,
  type KeysetPage,
  type TimelineEntry,
  type VersionRecord,
  type VersionRepository,
} from '../domain/ports';
import { EntitlementGate } from './entitlement-gate';
import { ShopFunctionsConfig } from './shop-functions.config';

/** Versions of a function: submit, read, roll back (S45 US2). Judging itself is `JudgeService`'s. */
@Injectable()
export class VersionsService {
  constructor(
    @Inject(FUNCTION_REPOSITORY) private readonly functions: FunctionRepository,
    @Inject(VERSION_REPOSITORY) private readonly versions: VersionRepository,
    @Inject(JUDGE_REQUESTS) private readonly judgeRequests: JudgeRequests,
    @Inject(ACTIVE_SET_CACHE) private readonly activeSet: ActiveSetCache,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly gate: EntitlementGate,
    private readonly runner: TransactionRunner,
    private readonly config: ShopFunctionsConfig,
  ) {}

  /**
   * One transaction: the version row, its frozen suite, its history row and the judge request (outbox). The request
   * leaves the service only after commit, through the relay.
   */
  async submit(
    shopId: string,
    functionId: string,
    userId: string,
    source: string,
  ): Promise<{ functionId: string; version: number; createdAt: Date }> {
    await this.gate.require(shopId);
    return this.runner.run(async () => {
      const created = await this.versions.submit({
        shopId,
        functionId,
        userId,
        source,
        sourceHash: sourceHash(source),
        maxVersions: this.config.maxVersionsPerFunction,
        now: this.clock.now(),
      });
      if (!created) throw functionNotFound();
      await this.judgeRequests.request(functionId, created.version);
      return { functionId, ...created };
    });
  }

  async list(
    shopId: string,
    functionId: string,
    limit: number,
    cursor: string | null,
  ): Promise<KeysetPage<VersionRecord>> {
    const page = await this.versions.list(shopId, functionId, limit, cursor);
    if (!page) throw functionNotFound();
    return page;
  }

  async read(
    shopId: string,
    functionId: string,
    version: number,
  ): Promise<{ version: VersionRecord; timeline: TimelineEntry[] }> {
    const found = await this.versions.get(shopId, functionId, version);
    if (!found) {
      if (!(await this.functions.find(shopId, functionId)))
        throw functionNotFound();
      throw versionNotFound();
    }
    return {
      version: found,
      timeline: await this.versions.timeline(functionId, version),
    };
  }

  /** Rollback to a passing `SUPERSEDED` version: one transaction, one winner among concurrent identical requests. */
  async activate(
    shopId: string,
    functionId: string,
    version: number,
    actorId: string,
  ) {
    await this.gate.require(shopId);
    if (!(await this.functions.find(shopId, functionId)))
      throw functionNotFound();
    const outcome = await this.runner.run(async () => {
      const result = await this.versions.activate({
        shopId,
        functionId,
        version,
        actorId,
        now: this.clock.now(),
      });
      if (result === 'activated')
        afterCommit(() => this.activeSet.drop(shopId));
      return result;
    });
    if (outcome === 'not_found') throw versionNotFound();
    if (outcome === 'not_activatable') throw versionNotActivatable();
    return this.read(shopId, functionId, version);
  }
}
