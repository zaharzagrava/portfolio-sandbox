import { z } from 'zod';

/**
 * S03 HTTP contracts (specs/domains/S03-shops-rbac/contracts/http.md). Response schemas are strict: a field added
 * on the server without a contract change (the payment-provider account id, a token digest) fails the e2e parse.
 */
export const shopRoleSchema = z.enum(['OWNER', 'ADMIN', 'STAFF', 'VIEWER']);
export const shopStatusSchema = z.enum([
  'ACTIVE',
  'SUSPENDED',
  'DELETING',
  'DELETED',
]);
export const shopPlanSchema = z.enum(['STARTER', 'PRO', 'ENTERPRISE']);

/** `{items, nextCursor}` (III.10): the cursor is opaque. */
export const pageSchema = <T extends z.ZodType>(item: T) =>
  z
    .object({ items: z.array(item), nextCursor: z.string().nullable() })
    .strict();

export const shopSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    slug: z.string(),
    plan: shopPlanSchema,
    status: shopStatusSchema,
    verificationStatus: z.enum([
      'UNVERIFIED',
      'PENDING',
      'VERIFIED',
      'REJECTED',
    ]),
    payoutsEnabled: z.boolean(),
    region: z.string(),
    shopVersion: z.number().int(),
    createdAt: z.string(),
    purgeAt: z.string().nullable(),
    myRole: shopRoleSchema.optional(),
    myPermissions: z.array(z.string()).optional(),
  })
  .strict();
export type ShopDto = z.infer<typeof shopSchema>;

export const shopListItemSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    slug: z.string(),
    plan: shopPlanSchema,
    status: shopStatusSchema,
    role: shopRoleSchema,
  })
  .strict();

export const shopMemberSchema = z
  .object({
    userId: z.string().uuid(),
    email: z.string().nullable(),
    role: shopRoleSchema,
    source: z.enum(['owner', 'invite', 'sso', 'provisioned']),
    joinedAt: z.string(),
  })
  .strict();

export const shopInviteSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string(),
    role: z.enum(['ADMIN', 'STAFF', 'VIEWER']),
    status: z.enum(['pending', 'accepted', 'revoked', 'expired']),
    invitedBy: z.string().uuid(),
    expiresAt: z.string(),
    createdAt: z.string(),
  })
  .strict();

export const inviteAcceptedSchema = z
  .object({
    shopId: z.string().uuid(),
    role: shopRoleSchema,
    alreadyMember: z.literal(true).optional(),
  })
  .strict();

/** `{roles: {OWNER: [...permissions], ...}, permissions: [every permission]}` (S03 AS-82). */
export const shopRolesSchema = z
  .object({
    roles: z.object({
      OWNER: z.array(z.string()),
      ADMIN: z.array(z.string()),
      STAFF: z.array(z.string()),
      VIEWER: z.array(z.string()),
    }),
    permissions: z.array(z.string()),
  })
  .strict();

export const shopSummarySchema = z
  .object({ id: z.string().uuid(), name: z.string(), slug: z.string() })
  .strict();
