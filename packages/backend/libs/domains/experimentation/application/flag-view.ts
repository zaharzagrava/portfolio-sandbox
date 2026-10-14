import type { Flag } from '@marketplace-sandbox/contracts';
import type { StoredFlag } from '../domain/flag-types';

/** The explicit response shape of a flag (`flagSchema`): no internal column ever reaches the wire, the audit rows hold this too. */
export function toFlagView(flag: StoredFlag): Flag {
  const d = flag.definition;
  return {
    key: flag.key,
    description: d.description,
    owner: d.owner,
    status: flag.status,
    enabled: flag.status === 'enabled',
    variants: d.variants.map((v) => ({ key: v.key, value: v.value })),
    defaultVariant: d.defaultVariant,
    offVariant: d.offVariant,
    rules: d.rules.map((rule) => ({
      id: rule.id,
      conditions: rule.conditions.map((c) => ({
        attribute:
          c.attribute as Flag['rules'][number]['conditions'][number]['attribute'],
        op: c.op,
        values: c.values,
      })),
      ...(rule.variant !== undefined && { variant: rule.variant }),
      ...(rule.rollout !== undefined && { rollout: rule.rollout }),
    })),
    bucketBy: d.bucketBy,
    clientSide: d.clientSide,
    expiresAt: d.expiresAt,
    version: flag.version,
    createdAt: flag.createdAt,
    updatedAt: flag.updatedAt,
  };
}
