import * as joi from 'joi';
import { ConfigRules, type RuleCheck } from './config-rules';

/**
 * Settings of the collaborative editor (S06 FR-009, FR-010, FR-033). `collab_public_url` and `collab_instance_id` are declared
 * with the other keys of the service; this file adds the ticket key and the origin allowlist and the production rule.
 */
export interface CollabConfig {
  /** Signs editing tickets only (HS256); never the session key. */
  collab_ticket_key?: string;
  /** Comma separated list of origins allowed to open the editing connection. */
  collab_origin_allowlist?: string;
}

type Key = { name: string; verify: joi.AnySchema };
const optional = (name: string): Key => ({
  name,
  verify: joi.string().optional().allow(''),
});

export const collabConfigKeys: Record<keyof CollabConfig, Key> = {
  collab_ticket_key: optional('COLLAB_TICKET_KEY'),
  collab_origin_allowlist: optional('COLLAB_ORIGIN_ALLOWLIST'),
};

const isSet = (value: unknown): boolean =>
  value !== undefined && value !== null && value !== '';

/** The keys a production start needs; the message names the key and never a value. */
export const COLLAB_PRODUCTION_KEYS = [
  'collab_ticket_key',
  'collab_origin_allowlist',
  'collab_public_url',
] as const;

/** S06: production refuses to start without the ticket key, the origin allowlist and the public URL; the ticket key is its own secret. */
export const collabProductionRule: RuleCheck = (ctx) => {
  if (!ctx.production) return [];
  const found: string[] = [];
  for (const key of COLLAB_PRODUCTION_KEYS)
    if (!isSet(ctx.get(key))) found.push(`${key} is required in production`);
  const ticketKey = ctx.get('collab_ticket_key');
  if (isSet(ticketKey)) {
    if (String(ticketKey).length < 32)
      found.push('collab_ticket_key must be at least 32 characters');
    if (ctx.get('jwt_secret') === ticketKey)
      found.push('collab_ticket_key must differ from jwt_secret');
  }
  return found;
};

ConfigRules.register({
  owner: 'catalog',
  keys: [...COLLAB_PRODUCTION_KEYS, 'jwt_secret'],
  validate: collabProductionRule,
});
