import type { ApiConfigService } from '@app/common/config';

/**
 * The key that signs the ledger's list cursors: `LEDGER_CURSOR_SECRET` (at least 32 bytes, required in production).
 * Outside production, where it may be unset, the key is derived from the session secret so a cursor still cannot be
 * forged by a client.
 */
export function ledgerCursorSecret(config: ApiConfigService): string {
  return (
    config.get('ledger_cursor_secret') ||
    `ledger-cursor:${config.get('jwt_secret')}`
  );
}
