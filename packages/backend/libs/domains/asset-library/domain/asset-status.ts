import type { AssetStatus } from './ports';

export type AssetCommand = 'delete' | 'undelete' | 'purge';

export type AssetMove =
  { kind: 'apply'; to: AssetStatus } | { kind: 'refused' };

const TABLE: Record<AssetStatus, Partial<Record<AssetCommand, AssetStatus>>> = {
  ACTIVE: { delete: 'DELETED' },
  DELETED: { undelete: 'ACTIVE', purge: 'PURGED' },
  PURGED: {},
};

/**
 * The life of an asset (S31 FR-028, docs/spec/models/asset-status.md): `ACTIVE → DELETED → PURGED`, with undelete
 * from `DELETED` back to `ACTIVE`. `PURGED` is terminal. Pure; the services apply a move with a conditional update
 * (`UPDATE … WHERE status = $from`), so a racing second command finds the status already changed.
 */
export function assetTransition(
  status: AssetStatus,
  command: AssetCommand,
): AssetMove {
  const to = TABLE[status][command];
  return to ? { kind: 'apply', to } : { kind: 'refused' };
}
