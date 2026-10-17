import type { Integration } from '@/lib/api/seller-integrations';

/** The words for the closed vocabularies of S08 and S09 (an unknown value is shown as it came, in sentence case). */

const sentence = (value: string): string => {
  const text = value.toLowerCase().replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

export const providerLabel = (provider: string): string => (provider === 'shopify' ? 'Shopify' : provider === 'woocommerce' ? 'WooCommerce' : sentence(provider));

export function statusLabel(integration: Pick<Integration, 'status' | 'pausedReason'>): string {
  switch (integration.status) {
    case 'ACTIVE':
      return 'Active';
    case 'PAUSED':
      return integration.pausedReason === 'shop_offboarding' ? 'Paused while the shop closes' : 'Paused by you';
    case 'NEEDS_REAUTH':
      return 'Needs to be reconnected';
    case 'DISCONNECTED':
      return 'Disconnected';
    default:
      return sentence(integration.status);
  }
}

export const statusVariant = (status: string): 'default' | 'secondary' | 'outline' | 'destructive' =>
  status === 'ACTIVE' ? 'default' : status === 'NEEDS_REAUTH' ? 'destructive' : status === 'PAUSED' ? 'secondary' : 'outline';

/** "2 min behind"; `null` (never synced) is "Never". */
export function lagLabel(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return 'Never';
  if (seconds < 60) return seconds <= 5 ? 'Up to date' : `${seconds} s behind`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min behind`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h behind` : `${Math.round(hours / 24)} days behind`;
}

export const KIND_LABEL: Record<string, string> = {
  oversold: 'Oversold',
  quantity_limit: 'Over the quantity limit',
};
export const kindLabel = (kind: string): string => KIND_LABEL[kind] ?? sentence(kind);

export const FINDING_LABEL: Record<string, string> = {
  matched: 'Matches',
  missing_at_provider: 'Missing in the store',
  missing_locally: 'Missing here',
  content_drift: 'Content differs',
  stock_drift: 'Stock differs',
  list_inconsistent: 'Store list changed during the check',
};
export const findingLabel = (kind: string): string => FINDING_LABEL[kind] ?? sentence(kind);

export const OUTCOME_LABEL: Record<string, string> = {
  completed: 'Completed',
  aborted_mass_delete: 'Stopped: too many items missing in the store',
  failed: 'Failed',
};
export const outcomeLabel = (outcome: string | null): string => (outcome === null ? 'Running' : (OUTCOME_LABEL[outcome] ?? sentence(outcome)));

/** The connect result codes of the OAuth redirect (`?error=`). */
export const CONNECT_ERROR_COPY: Record<string, string> = {
  oauth_exchange_failed: "We couldn't finish connecting the store. Try again.",
  currency_mismatch: "The store's currency doesn't match this shop's currency.",
  store_already_connected: 'This store is already connected to a shop.',
  integration_limit_reached: "You've reached the maximum number of integrations. Disconnect one to add another.",
};
export const connectErrorCopy = (code: string): string => (Object.hasOwn(CONNECT_ERROR_COPY, code) ? CONNECT_ERROR_COPY[code] : "Connecting the store didn't work. Try again.");

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isId = (value: string | null | undefined): value is string => typeof value === 'string' && ID.test(value);
