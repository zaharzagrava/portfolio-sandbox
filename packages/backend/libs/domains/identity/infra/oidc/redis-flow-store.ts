import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import type { OidcFlow, OidcFlowStore } from '../../domain/ports';

const KEY = (stateDigest: string) => `oidc:flow:${stateDigest}`;

/**
 * `OIDC_FLOW_STORE`: one record per sign-in attempt, 10 minutes, consumed atomically (`GETDEL`) so exactly one
 * callback can use it. Losing it (a Redis restart) only makes an in-flight sign-in fail with `oidc_state_invalid`;
 * nothing durable lives here (III.9). The key is the digest of `state`, never the state itself.
 */
@Injectable()
export class RedisOidcFlowStore implements OidcFlowStore {
  constructor(private readonly redis: RedisService) {}

  async put(
    stateDigest: string,
    flow: OidcFlow,
    ttlSec: number,
  ): Promise<void> {
    await this.redis.client.set(
      KEY(stateDigest),
      JSON.stringify(flow),
      'EX',
      ttlSec,
    );
  }

  async consume(stateDigest: string): Promise<OidcFlow | undefined> {
    const raw = await this.redis.client.getdel(KEY(stateDigest));
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as OidcFlow;
    } catch {
      return undefined;
    }
  }
}
