import { z } from 'zod';
import {
  defineEvent,
  type EventDefinition,
} from '@app/infrastructure/events/define-event';
import type { TopicRegistration } from '@app/infrastructure/events/topic-registry';

/**
 * `tenancy.events` (key = shopId). Payloads hold identifiers only: no e-mail, no token, no secret. `shopVersion` is
 * the entity version for read-model version guards (IX.8). Contract: specs/domains/S03-shops-rbac/contracts/events.md.
 */
export const TENANCY_AGGREGATE: TopicRegistration = {
  aggregateType: 'tenancy',
  retention: 'full-history',
};

const id = z.string().min(1);
const role = z.enum(['OWNER', 'ADMIN', 'STAFF', 'VIEWER']);
const status = z.enum(['ACTIVE', 'SUSPENDED', 'DELETING', 'DELETED']);

export const ShopCreated = defineEvent(
  'tenancy.shop_created',
  'tenancy',
  1,
  z.object({
    shopId: id,
    ownerId: id.nullable(),
    name: z.string(),
    slug: z.string(),
    plan: z.string(),
    region: z.string(),
    shopVersion: z.number().int(),
  }),
);

export const ShopUpdated = defineEvent(
  'tenancy.shop_updated',
  'tenancy',
  1,
  z.object({
    shopId: id,
    name: z.string(),
    slug: z.string(),
    shopVersion: z.number().int(),
  }),
);

export const ShopStatusChanged = defineEvent(
  'tenancy.shop_status_changed',
  'tenancy',
  1,
  z.object({
    shopId: id,
    from: status,
    to: status,
    reason: z.string().optional(),
    shopVersion: z.number().int(),
  }),
);

export const ShopVerificationChanged = defineEvent(
  'tenancy.shop_verification_changed',
  'tenancy',
  1,
  z.object({
    shopId: id,
    verificationStatus: z.enum([
      'UNVERIFIED',
      'PENDING',
      'VERIFIED',
      'REJECTED',
    ]),
    payoutsEnabled: z.boolean(),
    shopVersion: z.number().int(),
  }),
);

export const ShopPlanChanged = defineEvent(
  'tenancy.shop_plan_changed',
  'tenancy',
  1,
  z.object({ shopId: id, plan: z.string(), shopVersion: z.number().int() }),
);

export const MemberAdded = defineEvent(
  'tenancy.member_added',
  'tenancy',
  1,
  z.object({
    shopId: id,
    userId: id,
    role,
    source: z.enum(['owner', 'invite', 'sso', 'provisioned']),
  }),
);

export const MemberRoleChanged = defineEvent(
  'tenancy.member_role_changed',
  'tenancy',
  1,
  z.object({ shopId: id, userId: id, from: role, to: role }),
);

export const MemberRemoved = defineEvent(
  'tenancy.member_removed',
  'tenancy',
  1,
  z.object({
    shopId: id,
    userId: id,
    role,
    reason: z.enum(['removed', 'left', 'shop_deleted']),
  }),
);

export const InviteCreated = defineEvent(
  'tenancy.invite_created',
  'tenancy',
  1,
  z.object({ shopId: id, inviteId: id, role }),
);

export const ShopCellMoved = defineEvent(
  'tenancy.shop_cell_moved',
  'tenancy',
  1,
  z.object({
    shopId: id,
    fromCell: z.string(),
    toCell: z.string(),
    region: z.string(),
    version: z.number().int(),
  }),
);

export const ShopOffboardingStarted = defineEvent(
  'tenancy.shop_offboarding_started',
  'tenancy',
  1,
  z.object({ shopId: id, purgeAt: z.string(), shopVersion: z.number().int() }),
);

export const ShopOffboardingCancelled = defineEvent(
  'tenancy.shop_offboarding_cancelled',
  'tenancy',
  1,
  z.object({ shopId: id, shopVersion: z.number().int() }),
);

export const ShopDeleted = defineEvent(
  'tenancy.shop_deleted',
  'tenancy',
  1,
  z.object({ shopId: id, shopVersion: z.number().int() }),
);

/**
 * Single-consumer message to S28 (the mail capability): the only carrier of the invite token. It goes to a queue,
 * never to the fan-out topic, and is never logged.
 */
export const INVITE_REQUESTED_QUEUE = 'tenancy-invite-requested';
export const INVITE_REQUESTED_TYPE = 'tenancy.invite_requested';
export const inviteRequestedSchema = z.object({
  inviteId: id,
  shopId: id,
  shopName: z.string(),
  email: z.string(),
  role,
  token: z.string(),
  expiresAt: z.string(),
  invitedBy: id,
});
export type InviteRequested = z.infer<typeof inviteRequestedSchema>;

/** Consumed events (payload validated with zod before acting; topics of S04 and S17 are provisional constants). */
export const IDENTITY_EVENTS_TOPIC = 'identity.events';
/** S04's events are produced on the `shops` aggregate (`shops.events`), not on a topic named `shop.events`. */
export const SHOP_EVENTS_TOPIC = 'shops.events';
export const BILLING_EVENTS_TOPIC = 'billing.events';

export const federatedIdentityLinkedPayload = z.object({
  userId: id,
  provider: z.string(),
});
export const shopVerificationPayload = z.object({ shopId: z.string().uuid() });
export const planChangedPayload = z.object({
  shopId: id,
  plan: z.enum(['STARTER', 'PRO', 'ENTERPRISE']),
  version: z.number().int(),
});

/**
 * The consumer's reading of an event another capability produces. The producer owns the registered definition
 * (`defineEvent` refuses a second one for the same type), so this is a matcher only: `(type, version)` and the
 * payload fields tenancy reads, validated before acting. Producing through it is a programming error.
 */
function consumedEvent<TType extends string, TSchema extends z.ZodType>(
  type: TType,
  aggregateType: string,
  schema: TSchema,
): EventDefinition<TType, string, TSchema> {
  return {
    type,
    version: 1,
    aggregateType,
    topic: `${aggregateType}.events`,
    schema,
    carries: 'delta',
    create() {
      throw new Error(`${type} is produced by another capability`);
    },
    match(envelope) {
      if (envelope.type !== type || envelope.version !== 1) return null;
      return { ...envelope, type, payload: schema.parse(envelope.payload) };
    },
  } as EventDefinition<TType, string, TSchema>;
}

/** `shop.*` from seller onboarding (S04): the shop id is all tenancy reads. */
export const OnboardingSubmittedSeen = consumedEvent(
  'shop.onboarding_submitted',
  'shops',
  shopVerificationPayload,
);
export const ShopVerifiedSeen = consumedEvent(
  'shop.verified',
  'shops',
  shopVerificationPayload,
);
export const ShopRejectedSeen = consumedEvent(
  'shop.rejected',
  'shops',
  shopVerificationPayload,
);

/** `billing.subscription_plan_changed` (S17, provisional contract): `version` is monotonic per shop. */
export const SubscriptionPlanChanged = defineEvent(
  'billing.subscription_plan_changed',
  'billing',
  1,
  planChangedPayload,
);
