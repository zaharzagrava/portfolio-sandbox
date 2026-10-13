import { Injectable } from '@nestjs/common';
import { UserDirectoryService } from '@app/domains/identity';
import { MembershipQueryService } from '@app/domains/tenancy';
import type { DirectoryUser, RecipientDirectory } from '../domain/ports';
import { DIRECTORY_TIMEOUT_MS, withTimeout } from './with-timeout';

const MAX_IDS = 500;

const chunks = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
};

/**
 * `RECIPIENT_DIRECTORY` over the exported services of the owning domains (IX.7 R1): identity's `UserDirectoryService`
 * for users and e-mail addresses, tenancy's `MembershipQueryService` for shop owners. At most 500 ids per call, each
 * call with a 2 s timeout; no table of either domain is read here.
 */
@Injectable()
export class RecipientDirectoryAdapter implements RecipientDirectory {
  constructor(
    private readonly userDirectory: UserDirectoryService,
    private readonly memberships: MembershipQueryService,
  ) {}

  async users(userIds: string[]): Promise<Map<string, DirectoryUser>> {
    const out = new Map<string, DirectoryUser>();
    for (const ids of chunks([...new Set(userIds)], MAX_IDS)) {
      const found = await withTimeout(
        this.userDirectory.getUsersByIds(ids),
        DIRECTORY_TIMEOUT_MS,
        'user directory',
      );
      for (const [id, user] of found)
        out.set(id, { userId: id, email: user.email });
    }
    return out;
  }

  async shopOwners(shopIds: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    for (const ids of chunks([...new Set(shopIds)], MAX_IDS)) {
      const found = await withTimeout(
        this.memberships.getMembersByShopIds(ids, ['OWNER']),
        DIRECTORY_TIMEOUT_MS,
        'membership query',
      );
      for (const id of ids)
        out.set(
          id,
          (found.get(id) ?? []).map((m) => m.userId),
        );
    }
    return out;
  }
}
