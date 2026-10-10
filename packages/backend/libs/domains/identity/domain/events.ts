import { z } from 'zod';
import { defineEvent } from '@app/infrastructure/events/define-event';
import type { TopicRegistration } from '@app/infrastructure/events/topic-registry';

/**
 * `identity.events` (key = userId). Payloads hold identifiers only: no e-mail, no password data (FR-094). The mail
 * for a new or duplicate registration is built by the notification capability, which resolves the address through
 * `UserDirectoryService`.
 */
export const IDENTITY_AGGREGATE: TopicRegistration = {
  aggregateType: 'identity',
  retention: 'full-history',
};

export const UserRegistered = defineEvent(
  'identity.user_registered',
  'identity',
  1,
  z.object({ userId: z.string(), role: z.string() }),
);

export const RegistrationDuplicateAttempted = defineEvent(
  'identity.registration_duplicate_attempted',
  'identity',
  1,
  z.object({ userId: z.string() }),
);

export const PasswordChanged = defineEvent(
  'identity.password_changed',
  'identity',
  1,
  z.object({ userId: z.string() }),
);

export const MfaEnabled = defineEvent(
  'identity.mfa_enabled',
  'identity',
  1,
  z.object({ userId: z.string() }),
);

export const MfaDisabled = defineEvent(
  'identity.mfa_disabled',
  'identity',
  1,
  z.object({
    userId: z.string(),
    reason: z.enum(['user', 'account_linking']),
  }),
);

export const MfaRecoveryCodeUsed = defineEvent(
  'identity.mfa_recovery_code_used',
  'identity',
  1,
  z.object({ userId: z.string(), remaining: z.number().int().min(0) }),
);

export const MfaRecoveryCodesRegenerated = defineEvent(
  'identity.mfa_recovery_codes_regenerated',
  'identity',
  1,
  z.object({ userId: z.string() }),
);

export const FederatedIdentityLinked = defineEvent(
  'identity.federated_identity_linked',
  'identity',
  1,
  z.object({
    userId: z.string(),
    provider: z.string(),
    linkMethod: z.enum(['login', 'email_match', 'explicit']),
    passwordInvalidated: z.boolean(),
    mfaReset: z.boolean(),
  }),
);

export const FederatedIdentityUnlinked = defineEvent(
  'identity.federated_identity_unlinked',
  'identity',
  1,
  z.object({ userId: z.string(), provider: z.string() }),
);
