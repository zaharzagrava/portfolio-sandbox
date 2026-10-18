import type { Flag } from '@marketplace-sandbox/contracts';
import { toDraft, type Draft } from './draft';

/**
 * The simplest useful definition (W06 AS-09, FR-020): an "On/off flag" that starts disabled and dark. Creating a flag never
 * serves a feature to anyone; enabling it is a separate, deliberate save.
 */
export const STARTER_DEFINITION = {
  enabled: false,
  variants: [
    { key: 'off', value: false },
    { key: 'on', value: true },
  ],
  defaultVariant: 'off',
  offVariant: 'off',
  rules: [],
  bucketBy: 'userId',
  clientSide: false,
  expiresAt: null,
} as const;

/** The draft of a flag that does not exist yet: version 0, so the save sends `expectedVersion: 0` (create). */
export function starterDraft(input: { key: string; owner: string; description: string }): Draft {
  return toDraft({
    key: input.key,
    owner: input.owner,
    description: input.description,
    status: 'disabled',
    enabled: false,
    variants: STARTER_DEFINITION.variants.map((variant) => ({ ...variant })),
    defaultVariant: STARTER_DEFINITION.defaultVariant,
    offVariant: STARTER_DEFINITION.offVariant,
    rules: [],
    bucketBy: STARTER_DEFINITION.bucketBy as Flag['bucketBy'],
    clientSide: STARTER_DEFINITION.clientSide,
    expiresAt: STARTER_DEFINITION.expiresAt,
    version: 0,
  });
}
