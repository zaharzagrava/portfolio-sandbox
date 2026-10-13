/**
 * Chart of accounts (S14 data-model.md "Account grammar and classes"). Minor units; negative = debit, positive = credit.
 *  PROVIDER_CLEARING    - what the payment provider holds for us: debited on a capture, credited on a refund (sharded)
 *  MARKETPLACE_CLEARING - captured money not yet owed to a shop (sharded)
 *  PLATFORM_FEES        - marketplace revenue (sharded)
 *  PAYOUT_CLEARING      - in flight to a shop's bank; never below zero
 *  PAYOUTS_SENT         - money paid out
 *  SHOP_<uuid>          - what the platform owes a shop (its available balance)
 */
export const LEDGER_ACCOUNTS = {
  PROVIDER_CLEARING: 'PROVIDER_CLEARING',
  CLEARING: 'MARKETPLACE_CLEARING',
  PLATFORM_FEES: 'PLATFORM_FEES',
  PAYOUT_CLEARING: 'PAYOUT_CLEARING',
  PAYOUTS_SENT: 'PAYOUTS_SENT',
} as const;

export const shopAccount = (shopId: string) => `SHOP_${shopId}`;

export type AccountClass =
  | 'PROVIDER_CLEARING'
  | 'CLEARING'
  | 'PLATFORM_FEES'
  | 'PAYOUT_CLEARING'
  | 'PAYOUTS_SENT'
  | 'SHOP';

export interface AccountInfo {
  /** Canonical id: shop uuids are lower-case. */
  id: string;
  cls: AccountClass;
  sharded: boolean;
}

/** The accounts every sale touches: split into shards (research R-5). */
export const HOT_ACCOUNTS: readonly string[] = [
  LEDGER_ACCOUNTS.PROVIDER_CLEARING,
  LEDGER_ACCOUNTS.CLEARING,
  LEDGER_ACCOUNTS.PLATFORM_FEES,
];

const SYSTEM: Record<string, AccountClass> = {
  PROVIDER_CLEARING: 'PROVIDER_CLEARING',
  MARKETPLACE_CLEARING: 'CLEARING',
  PLATFORM_FEES: 'PLATFORM_FEES',
  PAYOUT_CLEARING: 'PAYOUT_CLEARING',
  PAYOUTS_SENT: 'PAYOUTS_SENT',
};

const SHOP_ACCOUNT =
  /^SHOP_([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

/** `CLEARING` is the short name of `MARKETPLACE_CLEARING` (FR-010) and is accepted for it. */
const ALIASES: Record<string, string> = { CLEARING: 'MARKETPLACE_CLEARING' };

/** Null for anything outside the chart, including a shard suffix (`…#07`) and the legacy buyer accounts. */
export function parseAccountId(raw: unknown): AccountInfo | null {
  if (typeof raw !== 'string') return null;
  const named = ALIASES[raw] ?? raw;
  const system = SYSTEM[named];
  if (system)
    return { id: named, cls: system, sharded: HOT_ACCOUNTS.includes(named) };
  const shop = SHOP_ACCOUNT.exec(raw);
  if (shop)
    return { id: `SHOP_${shop[1].toLowerCase()}`, cls: 'SHOP', sharded: false };
  return null;
}

export function shopIdOf(accountId: string): string | null {
  const match = SHOP_ACCOUNT.exec(accountId);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Whether the balance update of a line must keep the balance at or above zero, decided by the same atomic
 * statement that moves it (FR-009): `PAYOUT_CLEARING` for every kind, a seller account only for a `PAYOUT` debit.
 */
export function isGuarded(
  account: AccountInfo,
  kind: string,
  deltaMinor: number,
): boolean {
  if (account.cls === 'PAYOUT_CLEARING') return true;
  return account.cls === 'SHOP' && kind === 'PAYOUT' && deltaMinor < 0;
}
