import type { Condition, Rule, Variant } from './evaluator';

export type FlagStatus = 'enabled' | 'disabled' | 'killed' | 'archived';
export type FlagAction = 'create' | 'update' | 'kill' | 'restore' | 'archive';

/** What an admin edits: everything of a flag except its identity, status and counters. */
export interface FlagDefinitionBody {
  description: string;
  owner: string;
  variants: Variant[];
  defaultVariant: string;
  offVariant: string;
  rules: (Omit<Rule, 'conditions'> & {
    conditions: (Omit<Condition, 'values'> & {
      values: (string | number | boolean)[];
    })[];
  })[];
  bucketBy: 'userId' | 'shopId';
  clientSide: boolean;
  /** ISO instant or null. */
  expiresAt: string | null;
}

/** The part of a stored flag the state machine reads. */
export interface FlagState {
  status: FlagStatus;
  version: number;
  definition: FlagDefinitionBody;
}

/** A stored flag as the repository returns it (`flagSchema` is its response shape). */
export interface StoredFlag extends FlagState {
  key: string;
  createdAt: string;
  updatedAt: string;
}
