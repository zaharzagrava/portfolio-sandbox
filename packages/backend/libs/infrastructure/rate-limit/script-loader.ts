import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import type { LuaScript } from './lua';

/**
 * Loads each script once and calls it by digest (FR-012). A "script not found" reply (the store restarted or flushed
 * its script cache) is recovered by loading again and retrying once; it is not a store failure.
 */
@Injectable()
export class ScriptLoader {
  private readonly digests = new Map<string, string>();

  constructor(private readonly redis: RedisService) {}

  async run(
    script: LuaScript,
    keys: string[],
    args: (string | number)[],
  ): Promise<number[]> {
    const client = this.redis.client;
    let sha = this.digests.get(script.name);
    if (!sha) sha = await this.load(script);
    try {
      return (await client.evalsha(
        sha,
        keys.length,
        ...keys,
        ...args,
      )) as number[];
    } catch (error) {
      if (!String((error as Error)?.message).includes('NOSCRIPT')) throw error;
      sha = await this.load(script);
      return (await client.evalsha(
        sha,
        keys.length,
        ...keys,
        ...args,
      )) as number[];
    }
  }

  private async load(script: LuaScript): Promise<string> {
    const sha = (await this.redis.client.script(
      'LOAD',
      script.source,
    )) as string;
    this.digests.set(script.name, sha);
    return sha;
  }
}
