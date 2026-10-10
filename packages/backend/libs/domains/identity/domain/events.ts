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
