import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/sequelize';
import { v4 as uuidv4 } from 'uuid';
import {
  ShopDirectoryModel,
  ShopInviteModel,
  ShopMembershipModel,
  ShopModel,
} from '@app/domains/tenancy';

/**
 * Shared seeding for specs that need shops (S03 T012). Test code may touch every table (IX.6): these write through
 * the models with explicit columns, including `source` and `shopVersion`, and never through the API under test.
 */
type Role = 'OWNER' | 'ADMIN' | 'STAFF' | 'VIEWER';

export async function createShop(
  app: INestApplication,
  owner: { id: string } | null,
  options: {
    name?: string;
    slug?: string;
    plan?: 'STARTER' | 'PRO' | 'ENTERPRISE';
    status?: 'ACTIVE' | 'SUSPENDED' | 'DELETING' | 'DELETED';
    region?: string;
    cell?: string;
    purgeAt?: Date | null;
    sandboxOf?: string | null;
  } = {},
) {
  const shops = app.get<typeof ShopModel>(getModelToken(ShopModel));
  const directory = app.get<typeof ShopDirectoryModel>(
    getModelToken(ShopDirectoryModel),
  );
  const suffix = uuidv4().slice(0, 8);
  const shop = await shops.create({
    name: options.name ?? `Shop ${suffix}`,
    slug: options.slug ?? `shop-${suffix}`,
    plan: options.plan ?? 'STARTER',
    status: options.status ?? 'ACTIVE',
    purgeAt: options.purgeAt ?? null,
    sandboxOf: options.sandboxOf ?? null,
    shopVersion: 1,
  });
  await directory.create({
    shopId: shop.id,
    region: options.region ?? 'eu-central-1',
    cell: options.cell ?? 'pooled',
    version: 1,
  });
  if (owner) await addMember(app, shop.id, owner.id, 'OWNER', 'owner');
  return shop;
}

export async function addMember(
  app: INestApplication,
  shopId: string,
  userId: string,
  role: Role,
  source: 'owner' | 'invite' | 'sso' | 'provisioned' = 'invite',
  createdAt?: Date,
) {
  return app
    .get<typeof ShopMembershipModel>(getModelToken(ShopMembershipModel))
    .create({
      shopId,
      userId,
      role,
      source,
      ...(createdAt ? { createdAt } : {}),
    });
}

export async function createInvite(
  app: INestApplication,
  shopId: string,
  options: {
    email: string;
    role?: 'ADMIN' | 'STAFF' | 'VIEWER';
    invitedBy: string;
    token?: string;
    expiresAt?: Date;
    acceptedAt?: Date | null;
    revokedAt?: Date | null;
    createdAt?: Date;
  },
) {
  const { createHash } = await import('node:crypto');
  const token = options.token ?? `tok-${uuidv4()}`;
  const invite = await app
    .get<typeof ShopInviteModel>(getModelToken(ShopInviteModel))
    .create({
      shopId,
      email: options.email,
      role: options.role ?? 'STAFF',
      tokenHash: createHash('sha256').update(token).digest('hex'),
      invitedBy: options.invitedBy,
      expiresAt: options.expiresAt ?? new Date(Date.now() + 7 * 86_400_000),
      acceptedAt: options.acceptedAt ?? null,
      revokedAt: options.revokedAt ?? null,
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    });
  return { invite, token };
}
