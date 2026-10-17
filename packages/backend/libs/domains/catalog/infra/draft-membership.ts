import { Injectable } from '@nestjs/common';
import {
  MembershipQueryService,
  ShopAccessService,
} from '@app/domains/tenancy';
import type { MemberAccess, MembershipReader } from '../domain/draft-ports';

const codeOf = (error: unknown): string | undefined =>
  (error as { code?: string } | null)?.code;

/**
 * Membership facts for the editor, read through the exported tenancy services only (R1): the role decides read or
 * write through `products.write`, so the permission matrix stays S03's. Events only decide WHEN to ask; every grant is a
 * fresh answer from here.
 *
 * S03 exports no pure `roleHasPermission` yet (gaps.md, Sibling-spec follow-ups), so the write ability is asked per
 * member through `assertMember(..., 'products.write')`; the membership read of a whole shop is one batched call.
 */
@Injectable()
export class TenancyDraftMembership implements MembershipReader {
  constructor(
    private readonly access: ShopAccessService,
    private readonly members: MembershipQueryService,
  ) {}

  async accessOf(shopId: string, userId: string): Promise<MemberAccess> {
    try {
      await this.access.assertMember(shopId, userId, 'products.read');
    } catch (error) {
      return this.refusal(error);
    }
    try {
      await this.access.assertMember(shopId, userId, 'products.write');
      return { kind: 'member', ability: 'write' };
    } catch (error) {
      const code = codeOf(error);
      if (
        code === 'permission_denied' ||
        code === 'shop_suspended' ||
        code === 'shop_offboarding'
      ) {
        // read passed, so the shop is open for reading: a closed shop is refused above for `products.read` as well.
        return code === 'permission_denied'
          ? { kind: 'member', ability: 'read' }
          : this.refusal(error);
      }
      throw error;
    }
  }

  async accessOfMany(
    shopId: string,
    userIds: string[],
  ): Promise<Map<string, MemberAccess>> {
    const out = new Map<string, MemberAccess>();
    const roster = (await this.members.getMembersByShopIds([shopId])).get(
      shopId,
    );
    const present = new Set((roster ?? []).map((m) => m.userId));
    for (const userId of [...new Set(userIds)]) {
      out.set(
        userId,
        present.has(userId)
          ? await this.accessOf(shopId, userId)
          : { kind: 'none' },
      );
    }
    return out;
  }

  private refusal(error: unknown): MemberAccess {
    switch (codeOf(error)) {
      case 'shop_not_found':
      case 'permission_denied':
        return { kind: 'none' };
      case 'shop_suspended':
        return { kind: 'inactive', status: 'SUSPENDED' };
      case 'shop_offboarding':
        return { kind: 'inactive', status: 'DELETING' };
      default:
        throw error;
    }
  }
}
