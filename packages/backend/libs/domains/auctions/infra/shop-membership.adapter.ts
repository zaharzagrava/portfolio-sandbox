import { Injectable } from '@nestjs/common';
import { ShopAccessService } from '@app/domains/tenancy';
import type { ShopMembershipPort } from '../domain/auction-ports';
import { MembershipUnavailableError } from '../domain/auction-errors';
import { withTimeout } from '../domain/with-timeout';

const MEMBERSHIP_TIMEOUT_MS = 200;

/**
 * Membership of the selling shop through tenancy's exported `getRole` (S03 R1, FR-017): any role is a member. A
 * timeout or a failure is `MembershipUnavailableError` and the caller fails closed, so an unchecked identity never
 * bids and an unchecked leader is never awarded.
 */
@Injectable()
export class ShopMembershipAdapter implements ShopMembershipPort {
  constructor(private readonly access: ShopAccessService) {}

  async isMember(shopId: string, userId: string): Promise<boolean> {
    try {
      const role = await withTimeout(
        this.access.getRole(shopId, userId),
        MEMBERSHIP_TIMEOUT_MS,
        () => new MembershipUnavailableError('timeout'),
      );
      return role !== null;
    } catch (error) {
      throw error instanceof MembershipUnavailableError
        ? error
        : new MembershipUnavailableError(error);
    }
  }

  async membersAmong(shopId: string, userIds: string[]): Promise<Set<string>> {
    const members = new Set<string>();
    const answers = await Promise.all(
      userIds.map(async (id) => [id, await this.isMember(shopId, id)] as const),
    );
    for (const [id, member] of answers) if (member) members.add(id);
    return members;
  }
}
