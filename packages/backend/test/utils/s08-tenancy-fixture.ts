import { QueryTypes, type Sequelize } from 'sequelize';
import { v4 as uuidv4 } from 'uuid';

export type FixtureRole = 'OWNER' | 'ADMIN' | 'STAFF' | 'VIEWER';

export interface FixtureShop {
  id: string;
  slug: string;
  name: string;
}

/**
 * Creates shops and members for the S08 e2e specs without `ShopModel` (D-7: the integrations specs must not import
 * the tenancy models). Test code may write every table (IX.6): this uses raw SQL with explicit columns on the
 * `Shop`, `ShopDirectory` and `ShopMembership` tables, the same rows `libs/test/utils/tenancy-fixtures` writes.
 * `userId` is a plain id (no FK to identity), so a member needs no `User` row unless the spec logs in as that user.
 */
export class TenancyFixture {
  constructor(private readonly db: Sequelize) {}

  async createShop(
    options: {
      id?: string;
      name?: string;
      slug?: string;
      plan?: 'STARTER' | 'PRO' | 'ENTERPRISE';
      status?: 'ACTIVE' | 'SUSPENDED' | 'DELETING' | 'DELETED';
      region?: string;
      cell?: string;
      /** When set, also adds this user as `OWNER`. */
      ownerId?: string;
    } = {},
  ): Promise<FixtureShop> {
    const suffix = uuidv4().slice(0, 8);
    const shop: FixtureShop = {
      id: options.id ?? uuidv4(),
      name: options.name ?? `Shop ${suffix}`,
      slug: options.slug ?? `shop-${suffix}`,
    };
    await this.db.query(
      `INSERT INTO "Shop" ("id", "slug", "name", "plan", "planVersion", "status", "shopVersion", "verificationStatus", "payoutsEnabled", "createdAt", "updatedAt")
       VALUES (:id, :slug, :name, :plan, 0, :status, 1, 'UNVERIFIED', false, NOW(), NOW())`,
      {
        type: QueryTypes.INSERT,
        replacements: {
          ...shop,
          plan: options.plan ?? 'STARTER',
          status: options.status ?? 'ACTIVE',
        },
      },
    );
    await this.db.query(
      `INSERT INTO "ShopDirectory" ("shopId", "cell", "region", "version", "updatedAt")
       VALUES (:shopId, :cell, :region, 1, NOW())`,
      {
        type: QueryTypes.INSERT,
        replacements: {
          shopId: shop.id,
          cell: options.cell ?? 'pooled',
          region: options.region ?? 'eu-central-1',
        },
      },
    );
    if (options.ownerId)
      await this.addMember(shop.id, options.ownerId, 'OWNER', 'owner');
    return shop;
  }

  /** Adds (or re-roles) a member; returns the user id (generated when omitted). */
  async addMember(
    shopId: string,
    userId: string = uuidv4(),
    role: FixtureRole = 'STAFF',
    source: 'owner' | 'invite' | 'sso' | 'provisioned' = 'invite',
  ): Promise<string> {
    await this.db.query(
      `INSERT INTO "ShopMembership" ("shopId", "userId", "role", "source", "createdAt")
       VALUES (:shopId, :userId, :role, :source, NOW())
       ON CONFLICT ("shopId", "userId") DO UPDATE SET "role" = EXCLUDED."role"`,
      {
        type: QueryTypes.INSERT,
        replacements: { shopId, userId, role, source },
      },
    );
    return userId;
  }

  /** A shop with one member per role: the role x route matrix of the management API specs. */
  async createShopWithTeam(
    options: Parameters<TenancyFixture['createShop']>[0] = {},
  ) {
    const ownerId = options.ownerId ?? uuidv4();
    const shop = await this.createShop({ ...options, ownerId });
    return {
      shop,
      ownerId,
      adminId: await this.addMember(shop.id, uuidv4(), 'ADMIN'),
      staffId: await this.addMember(shop.id, uuidv4(), 'STAFF'),
      viewerId: await this.addMember(shop.id, uuidv4(), 'VIEWER'),
    };
  }

  /** Changes the shop's lifecycle status (offboarding / deletion cases). */
  async setShopStatus(
    shopId: string,
    status: 'ACTIVE' | 'SUSPENDED' | 'DELETING' | 'DELETED',
  ): Promise<void> {
    await this.db.query(
      `UPDATE "Shop" SET "status" = :status, "shopVersion" = "shopVersion" + 1, "updatedAt" = NOW() WHERE "id" = :shopId`,
      { type: QueryTypes.UPDATE, replacements: { shopId, status } },
    );
  }
}
