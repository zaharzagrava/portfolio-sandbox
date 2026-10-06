import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { Projector } from '@app/infrastructure/projections/projector';
import { JournalPosted } from '../application/events/ledger-events';

/**
 * Applies a journal's lines to the balances hash at most once: the
 * `SET ... NX` marker per journal makes redelivered events no-ops, and
 * HINCRBY on a hash field is atomic, so concurrent journals touching the same
 * account (the platform fee account touched by every sale) never contend on a
 * row lock - the "hot account" problem of a synchronous Postgres balance row
 * doesn't exist on this path.
 */
const APPLY_JOURNAL = `
if not redis.call('SET', KEYS[2], '1', 'NX', 'EX', 1209600) then return 0 end
for i = 1, #ARGV, 2 do
  redis.call('HINCRBY', KEYS[1], ARGV[i], ARGV[i + 1])
end
return 1
`;

export const BALANCES_KEY = 'ledger:balances';

@Injectable()
export class BalanceProjector implements Projector {
  readonly name = 'ledger-balances';
  readonly topics = [JournalPosted.topic];

  constructor(private readonly redis: RedisService) {}

  async project(events: EventEnvelope[]): Promise<void> {
    await Promise.all(
      events.map((raw) => {
        const event = JournalPosted.match(raw);
        if (!event) return undefined;
        const args = event.payload.lines.flatMap((l) => [l.accountId, String(l.amount)]);
        return this.redis.client.eval(APPLY_JOURNAL, 2, BALANCES_KEY, `ledger:applied:${event.aggregateId}`, ...args);
      }),
    );
  }
}
