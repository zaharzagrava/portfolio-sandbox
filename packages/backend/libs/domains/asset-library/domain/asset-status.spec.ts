import { assetTransition, type AssetCommand } from './asset-status';
import type { AssetStatus } from './ports';

describe('S31 asset status machine', () => {
  const statuses: AssetStatus[] = ['ACTIVE', 'DELETED', 'PURGED'];
  const commands: AssetCommand[] = ['delete', 'undelete', 'purge'];
  const applied: Record<string, AssetStatus> = {
    'ACTIVE.delete': 'DELETED',
    'DELETED.undelete': 'ACTIVE',
    'DELETED.purge': 'PURGED',
  };

  it.each(statuses.flatMap((s) => commands.map((c) => [s, c] as const)))(
    'S31 AS-38: %s %s',
    (status, command) => {
      const to = applied[`${status}.${command}`];
      expect(assetTransition(status, command)).toEqual(
        to ? { kind: 'apply', to } : { kind: 'refused' },
      );
    },
  );

  it('S31 AS-39: a purged asset accepts nothing', () => {
    for (const command of commands)
      expect(assetTransition('PURGED', command)).toEqual({ kind: 'refused' });
  });
});
