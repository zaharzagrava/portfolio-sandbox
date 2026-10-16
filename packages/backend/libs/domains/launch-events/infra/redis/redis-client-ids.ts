import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { CLIENT_ID_TTL_SEC } from '../../domain/live-constants';
import { clientIdKey } from '../../domain/live-keys';
import type { ClientIdRecord, ClientIds } from '../../domain/live-ports';

/** `clientId` claims: `SET NX` decides who posts, the record lets a retry return the original comment (FR-023). */
@Injectable()
export class RedisClientIds implements ClientIds {
  constructor(private readonly redis: RedisService) {}

  async claim(
    streamId: string,
    userId: string,
    clientId: string,
    record: ClientIdRecord,
  ): Promise<
    { result: 'claimed' } | { result: 'exists'; record: ClientIdRecord }
  > {
    const key = clientIdKey(streamId, userId, clientId);
    for (let attempt = 0; attempt < 3; attempt++) {
      const set = await this.redis.client.set(
        key,
        JSON.stringify(record),
        'EX',
        CLIENT_ID_TTL_SEC,
        'NX',
      );
      if (set === 'OK') return { result: 'claimed' };
      const existing = await this.read(streamId, userId, clientId);
      if (existing) return { result: 'exists', record: existing };
      // The claim expired between the two commands: take it again.
    }
    throw new Error('clientId claim kept racing');
  }

  async read(
    streamId: string,
    userId: string,
    clientId: string,
  ): Promise<ClientIdRecord | null> {
    const raw = await this.redis.client.get(
      clientIdKey(streamId, userId, clientId),
    );
    return raw ? (JSON.parse(raw) as ClientIdRecord) : null;
  }

  async setState(
    streamId: string,
    userId: string,
    clientId: string,
    state: ClientIdRecord['state'],
  ): Promise<void> {
    const key = clientIdKey(streamId, userId, clientId);
    const record = await this.read(streamId, userId, clientId);
    if (!record) return;
    await this.redis.client.set(
      key,
      JSON.stringify({ ...record, state }),
      'EX',
      CLIENT_ID_TTL_SEC,
      'XX',
    );
  }

  async release(
    streamId: string,
    userId: string,
    clientId: string,
  ): Promise<void> {
    await this.redis.client.del(clientIdKey(streamId, userId, clientId));
  }
}
