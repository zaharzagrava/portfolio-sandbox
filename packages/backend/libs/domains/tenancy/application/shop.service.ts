import {
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op, QueryTypes, Sequelize, UniqueConstraintError } from 'sequelize';
import { InjectConnection } from '@nestjs/sequelize';
import { createHash, randomBytes } from 'node:crypto';
import Shop from '../infra/models/shop.model';
import ShopMembership, {
  ShopRole,
} from '../infra/models/shop-membership.model';
import ShopInvite from '../infra/models/shop-invite.model';
import ShopDirectory from '../infra/models/shop-directory.model';
import { UserModel as User, Role } from '@app/domains/identity';
import { CacheService } from '@app/infrastructure/cache/cache.service';
import { TransactionRunner } from '@app/infrastructure/context';
import { ApiConfigService } from '@app/common/config';
import { MembershipService } from './membership.service';
import { ShopTransactionRunner } from '../infra/shop-transaction';

const INVITE_TTL_MS = 7 * 86_400_000;
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

@Injectable()
export class ShopService {
  constructor(
    @InjectModel(Shop) private readonly shopModel: typeof Shop,
    @InjectModel(ShopMembership)
    private readonly membershipModel: typeof ShopMembership,
    @InjectModel(ShopInvite) private readonly inviteModel: typeof ShopInvite,
    @InjectModel(ShopDirectory)
    private readonly directoryModel: typeof ShopDirectory,
    @InjectModel(User) private readonly userModel: typeof User,
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly tx: TransactionRunner,
    private readonly shopTx: ShopTransactionRunner,
    private readonly memberships: MembershipService,
    private readonly config: ApiConfigService,
    @Optional() private readonly cache?: CacheService,
  ) {}

  /**
   * Onboarding: shop + OWNER membership + directory entry (pooled cell) atomically. Opening a shop makes a
   * plain USER a SELLER (staff roles are kept); the new role reaches the access token on the next refresh.
   */
  async create(ownerId: string, name: string, slug: string): Promise<Shop> {
    try {
      const shop = await this.tx.run(async () => {
        const shop = await this.shopModel.create({ name, slug });
        await this.membershipModel.create({
          shopId: shop.id,
          userId: ownerId,
          role: 'OWNER',
        });
        await this.directoryModel.create({ shopId: shop.id });
        await this.userModel.update(
          { role: Role.SELLER },
          { where: { id: ownerId, role: Role.USER } },
        );
        return shop;
      });
      await this.cache?.invalidate([`auth:user:v1:${ownerId}`]);
      return shop;
    } catch (error) {
      if (error instanceof UniqueConstraintError)
        throw new ConflictException('Slug is taken');
      throw error;
    }
  }

  async mine(userId: string) {
    return this.sequelize.query<{
      id: string;
      name: string;
      slug: string;
      plan: string;
      role: ShopRole;
    }>(
      `SELECT s.id, s.name, s.slug, s.plan, m.role FROM "ShopMembership" m JOIN "Shop" s ON s.id = m."shopId"
       WHERE m."userId" = :userId ORDER BY m."createdAt"`,
      { type: QueryTypes.SELECT, replacements: { userId } },
    );
  }

  async get(shopId: string) {
    return this.shopModel.findByPk(shopId, { raw: true });
  }

  async members(shopId: string) {
    return this.sequelize.query<{
      userId: string;
      email: string | null;
      role: ShopRole;
    }>(
      `SELECT m."userId", u.email, m.role FROM "ShopMembership" m JOIN "User" u ON u.id = m."userId"
       WHERE m."shopId" = :shopId ORDER BY m."createdAt"`,
      { type: QueryTypes.SELECT, replacements: { shopId } },
    );
  }

  /** Invite token is random, single-use, stored hashed; the link is delivered by email (SD-17). */
  async invite(
    shopId: string,
    invitedBy: string,
    email: string,
    role: ShopInvite['role'],
  ) {
    const token = randomBytes(24).toString('base64url');
    await this.shopTx.inShop(shopId, () =>
      this.inviteModel.create({
        shopId,
        email,
        role,
        invitedBy,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      }),
    );
    return { inviteUrl: `${this.config.get('front_host')}/invites/${token}` };
  }

  async listInvites(shopId: string) {
    // No explicit WHERE: RLS returns only this shop's invites (the backstop doing the filtering).
    return this.shopTx.inShop(shopId, () =>
      this.inviteModel.findAll({ where: { acceptedAt: null }, raw: true }),
    );
  }

  /** The invitee has no shop context yet → an explicit, audited cross-tenant lookup by token hash. */
  async acceptInvite(userId: string, userEmail: string | null, token: string) {
    return this.shopTx.crossTenant('invite.accept', async () => {
      const invite = await this.inviteModel.findOne({
        where: {
          tokenHash: sha256(token),
          acceptedAt: null,
          expiresAt: { [Op.gt]: new Date() },
        },
      });
      if (!invite) throw new NotFoundException('Invite not found or expired');
      if (invite.email !== userEmail)
        throw new NotFoundException('Invite not found or expired');

      await this.membershipModel.upsert({
        shopId: invite.shopId,
        userId,
        role: invite.role,
      });
      await invite.update({ acceptedAt: new Date() });
      await this.memberships.invalidate(userId, invite.shopId);
      return { shopId: invite.shopId, role: invite.role };
    });
  }

  /**
   * Invariant spanning rows: "a shop always keeps ≥ 1 OWNER". Two owners
   * demoting each other concurrently both see "another owner exists" under
   * READ COMMITTED (write skew, lesson 03/02 §2). SERIALIZABLE detects the
   * conflict and aborts one; runSerializable retries it, and the retry sees
   * the truth and fails the invariant.
   */
  async changeRole(
    shopId: string,
    userId: string,
    role: ShopRole,
  ): Promise<void> {
    await this.tx.runSerializable(async () => {
      const member = await this.membershipModel.findOne({
        where: { shopId, userId },
      });
      if (!member) throw new NotFoundException('Member not found');
      if (member.role === 'OWNER' && role !== 'OWNER')
        await this.assertAnotherOwner(shopId, userId);
      await member.update({ role });
    });
    await this.memberships.invalidate(userId, shopId);
  }

  async removeMember(shopId: string, userId: string): Promise<void> {
    await this.tx.runSerializable(async () => {
      const member = await this.membershipModel.findOne({
        where: { shopId, userId },
      });
      if (!member) throw new NotFoundException('Member not found');
      if (member.role === 'OWNER')
        await this.assertAnotherOwner(shopId, userId);
      await member.destroy();
    });
    await this.memberships.invalidate(userId, shopId);
  }

  private async assertAnotherOwner(shopId: string, exceptUserId: string) {
    const others = await this.membershipModel.count({
      where: { shopId, role: 'OWNER', userId: { [Op.ne]: exceptUserId } },
    });
    if (others === 0)
      throw new UnprocessableEntityException(
        'A shop must keep at least one owner',
      );
  }
}
