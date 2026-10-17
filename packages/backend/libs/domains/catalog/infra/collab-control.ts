import { Inject, Injectable } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { CollabUnavailableError } from '../domain/draft-errors';
import { DRAFT_LIMITS } from '../domain/draft-limits';
import {
  RING_REGISTRY,
  type CollabControl,
  type RingRegistry,
} from '../domain/draft-ports';
import { signInternal } from '../domain/internal-signature';

export const INTERNAL_PATH = '/api/internal/collab';

/** `ws://host:port` -> `http://host:port`. */
const httpBase = (wsUrl: string) => wsUrl.replace(/^ws(s?):/, 'http$1:');

/**
 * Instance-to-instance calls to the owner of a draft's room (S06 collab-ws.md): authenticated with an HMAC under the ticket
 * key, 3 s timeout. An owner that does not confirm in time is `collab_unavailable` (503); with no instance in the ring there
 * is no room to ask and the caller reads the stored state.
 */
@Injectable()
export class HttpCollabControl implements CollabControl {
  constructor(
    @Inject(RING_REGISTRY) private readonly ring: RingRegistry,
    private readonly config: ApiConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  freeze(draftId: string, leaseId: string) {
    return this.call('freeze', draftId, leaseId);
  }

  async unfreeze(draftId: string, leaseId: string): Promise<void> {
    await this.call('unfreeze', draftId, leaseId);
  }

  flush(draftId: string) {
    return this.call('flush', draftId, '');
  }

  private async call(
    action: 'freeze' | 'unfreeze' | 'flush',
    draftId: string,
    leaseId: string,
  ): Promise<{ seq: number | null }> {
    const owner = await this.ring.ownerOf(draftId);
    if (!owner) return { seq: null };
    const key = this.config.get('collab_ticket_key');
    if (!key) throw new Error('collab_ticket_key is not configured');
    const timestamp = this.clock.nowMs();
    const signature = signInternal(key, {
      action,
      draftId,
      leaseId,
      timestamp,
    });
    try {
      const res = await fetch(
        `${httpBase(owner.url)}${INTERNAL_PATH}/${draftId}/${action}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-collab-timestamp': String(timestamp),
            'x-collab-signature': signature,
          },
          body: JSON.stringify({ leaseId }),
          signal: AbortSignal.timeout(DRAFT_LIMITS.freezeTimeoutMs),
        },
      );
      if (!res.ok) throw new Error(`owner answered ${res.status}`);
      const body = (await res.json()) as { seq: number | null };
      return { seq: typeof body.seq === 'number' ? body.seq : null };
    } catch (error) {
      throw new CollabUnavailableError(error as Error);
    }
  }
}
