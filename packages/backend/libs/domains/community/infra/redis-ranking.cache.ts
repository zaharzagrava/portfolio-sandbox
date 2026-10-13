import { Injectable } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import type { RankCache, RankedMember } from '../domain/ports';
import { RANK_PAGE, RANK_PUT, RANK_UPDATE } from './rank-scripts';
import { RedisGuard } from './redis-guard';

const toMembers = (flat: unknown): RankedMember[] => {
  const list = flat as string[];
  const out: RankedMember[] = [];
  for (let i = 0; i < list.length; i += 2)
    out.push({ id: list[i], score: Number(list[i + 1]) });
  return out;
};

/**
 * Board and thread rankings as capped, expiring ZSETs (`dsc:rank:{owner}:name`, hash-tagged on the owner so a
 * board's rankings share a shard). A scope is `"<ownerId>:<name>"`. A "built" marker distinguishes an empty ranking
 * from a lost one (S25 D1-D3, FR-035).
 */
@Injectable()
export class RedisRankingCache implements RankCache {
  constructor(
    private readonly guard: RedisGuard,
    private readonly config: ApiConfigService,
  ) {}

  private keys(scope: string): { zset: string; built: string } {
    const split = scope.indexOf(':');
    const owner = scope.slice(0, split);
    const name = scope.slice(split + 1);
    return {
      zset: `dsc:rank:{${owner}}:${name}`,
      built: `dsc:rankb:{${owner}}:${name}`,
    };
  }

  private get ttl(): number {
    return this.config.get('discussions_ranking_ttl_seconds');
  }

  has(scope: string): Promise<boolean> {
    return this.guard.run(
      async (c) => (await c.exists(this.keys(scope).built)) === 1,
    );
  }

  async page(
    scope: string,
    after: { score: number; member: string } | null,
    limit: number,
  ): Promise<RankedMember[]> {
    const { zset } = this.keys(scope);
    return toMembers(
      await this.guard.run((c) =>
        c.eval(
          RANK_PAGE,
          1,
          zset,
          after ? String(after.score) : '',
          after?.member ?? '',
          limit,
        ),
      ),
    );
  }

  async put(
    scope: string,
    members: RankedMember[],
    cap: number,
  ): Promise<void> {
    const { zset, built } = this.keys(scope);
    const args: Array<string | number> = [cap, this.ttl];
    for (const m of members) args.push(m.id, m.score);
    await this.guard.run((c) => c.eval(RANK_PUT, 2, zset, built, ...args));
  }

  async update(scope: string, member: string, score: number): Promise<void> {
    const { zset } = this.keys(scope);
    await this.guard.run((c) =>
      c.eval(RANK_UPDATE, 1, zset, member, score, this.ttl),
    );
  }

  async remove(scope: string, member: string): Promise<void> {
    const { zset } = this.keys(scope);
    await this.guard.run((c) => c.zrem(zset, member));
  }

  async all(scope: string): Promise<RankedMember[]> {
    const { zset } = this.keys(scope);
    return toMembers(
      await this.guard.run((c) => c.zrevrange(zset, 0, -1, 'WITHSCORES')),
    );
  }

  async drop(scope: string): Promise<void> {
    const { zset, built } = this.keys(scope);
    await this.guard.run((c) => c.del(zset, built));
  }
}
