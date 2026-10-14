import { ApiError, assertNever } from './errors';

export type KeyStatus = 'active' | 'rotating' | 'expired' | 'revoked';

export interface KeyState {
  revokedAt: Date | null;
  expiresAt: Date | null;
  successorId: string | null;
}

/** Derived status, evaluated in this order with the injected `now` (data-model §2). */
export function deriveKeyStatus(state: KeyState, now: Date): KeyStatus {
  if (state.revokedAt) return 'revoked';
  if (state.expiresAt && state.expiresAt.getTime() <= now.getTime())
    return 'expired';
  if (state.successorId) return 'rotating';
  return 'active';
}

export type KeyAction = 'rotate' | 'revoke';

/**
 * `active → rotating` (rotate), `active|rotating → revoked` (revoke). Revoking a revoked or expired key is an idempotent
 * no-op; rotating anything but an active key is refused with the code that names the reason (FR-005).
 */
export function assertTransition(status: KeyStatus, action: KeyAction): void {
  if (action === 'revoke') return;
  switch (status) {
    case 'active':
      return;
    case 'rotating':
      throw new ApiError(
        'key_already_rotating',
        'The key is already being rotated.',
      );
    case 'revoked':
      throw new ApiError('key_revoked', 'The key is revoked.');
    case 'expired':
      throw new ApiError('key_expired', 'The key has expired.');
    default:
      return assertNever(status);
  }
}
