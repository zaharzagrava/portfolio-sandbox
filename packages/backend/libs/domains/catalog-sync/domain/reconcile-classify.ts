import { MAX_STOCK, merge, type MergeResult } from './stock-merge';

/**
 * Reconciliation classification (AS-61, AS-62, AS-63, FR-060, FR-061). Pure: compares the links with a COMPLETE
 * provider listing. The caller must not call it with a partial listing (a failed page ends the run `failed`).
 */
export const MASS_DELETE_MIN_MISSING = 10;
/** Fraction as a ratio `1/5`: abort when strictly more than 20% of all links are missing. */
export const MASS_DELETE_RATIO_DENOMINATOR = 5;

export interface LocalLink {
  externalId: string;
  contentDigest: string;
  /** Last stock both sides agreed on (the merge base). */
  syncedStock: number;
  /** Local quantity from the batch catalog read; `undefined` = unreadable, skip the stock comparison. */
  localQuantity?: number;
}

export interface RemoteItem {
  externalId: string;
  digest: string;
  stock: number;
}

export type FindingKind =
  'missing_at_provider' | 'missing_locally' | 'content_drift' | 'stock_drift';

export interface Finding {
  externalId: string;
  kind: FindingKind;
  /** `true` when no safe automatic fix exists (an unresolvable three-way merge). */
  needsReview: boolean;
  /** For `stock_drift`: the plan from the live-sync merge rule. */
  merge?: MergeResult;
}

export interface ReconcileCounts {
  linked: number;
  remote: number;
  matched: number;
  missingAtProvider: number;
  missingLocally: number;
  contentDrift: number;
  stockDrift: number;
  autoFixed: number;
  needsReview: number;
}

export interface ReconcileClassification {
  counts: ReconcileCounts;
  findings: Finding[];
  /** The mass-deletion guard tripped: change nothing. */
  abortMassDelete: boolean;
}

/** At least 10 links missing AND strictly more than 20% of all links. */
export function massDeleteGuard(totalLinks: number, missing: number): boolean {
  return (
    missing >= MASS_DELETE_MIN_MISSING &&
    missing * MASS_DELETE_RATIO_DENOMINATOR > totalLinks
  );
}

/** A direct provider read decides: a 404 confirms the deletion, a present variant means the listing lied. */
export function confirmMissing(
  directRead: 'gone' | 'present',
): 'missing_at_provider' | 'list_inconsistent' {
  return directRead === 'gone' ? 'missing_at_provider' : 'list_inconsistent';
}

const validStock = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_STOCK;

export function classifyReconciliation(
  links: readonly LocalLink[],
  listing: readonly RemoteItem[],
): ReconcileClassification {
  const remoteById = new Map(listing.map((r) => [r.externalId, r]));
  const linkIds = new Set(links.map((l) => l.externalId));
  const findings: Finding[] = [];
  let matched = 0;
  let missingAtProvider = 0;
  let contentDrift = 0;
  let stockDrift = 0;

  for (const link of links) {
    const remote = remoteById.get(link.externalId);
    if (!remote) {
      missingAtProvider++;
      findings.push({
        externalId: link.externalId,
        kind: 'missing_at_provider',
        needsReview: false,
      });
      continue;
    }
    let drifted = false;
    if (remote.digest !== link.contentDigest) {
      drifted = true;
      contentDrift++;
      findings.push({
        externalId: link.externalId,
        kind: 'content_drift',
        needsReview: false,
      });
    }
    if (
      validStock(link.localQuantity) &&
      validStock(link.syncedStock) &&
      validStock(remote.stock)
    ) {
      const plan = merge(link.syncedStock, link.localQuantity, remote.stock);
      if (plan.action !== 'none') {
        drifted = true;
        stockDrift++;
        findings.push({
          externalId: link.externalId,
          kind: 'stock_drift',
          needsReview: plan.conflict !== undefined,
          merge: plan,
        });
      }
    }
    if (!drifted) matched++;
  }

  let missingLocally = 0;
  for (const remote of listing) {
    if (linkIds.has(remote.externalId)) continue;
    missingLocally++;
    findings.push({
      externalId: remote.externalId,
      kind: 'missing_locally',
      needsReview: false,
    });
  }

  const needsReview = findings.filter((f) => f.needsReview).length;
  return {
    counts: {
      linked: links.length,
      remote: listing.length,
      matched,
      missingAtProvider,
      missingLocally,
      contentDrift,
      stockDrift,
      autoFixed: findings.length - needsReview,
      needsReview,
    },
    findings,
    abortMassDelete: massDeleteGuard(links.length, missingAtProvider),
  };
}
