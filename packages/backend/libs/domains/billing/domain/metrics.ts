import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/**
 * Instruments of billing (S17 FR-060). Labels are closed enums only: never a subscription, invoice or payment
 * reference (the registry refuses id-like labels); ids go to logs and traces.
 */
export const renewalsCounter = MetricsRegistry.counter({
  name: 'billing_renewals_total',
  help: 'Subscriptions handled by the billing run, by outcome (invoiced, trial_converted, canceled, expired, already_renewed)',
  labels: ['outcome'],
});

export const renewalDeferredCounter = MetricsRegistry.counter({
  name: 'billing_renewal_deferred_total',
  help: 'Renewals put off to the next run, by reason (usage_unavailable)',
  labels: ['reason'],
});

export const renewalFailedCounter = MetricsRegistry.counter({
  name: 'billing_renewal_failed_total',
  help: 'Renewals that failed for one subscription without stopping the run',
  labels: [],
});

export const chargeAttemptsCounter = MetricsRegistry.counter({
  name: 'billing_charge_attempts_total',
  help: 'Charge attempts by outcome (succeeded, declined, authentication_required, no_payment_method, unknown)',
  labels: ['outcome'],
});

export const unknownAttemptsGauge = MetricsRegistry.gauge({
  name: 'billing_unknown_attempts',
  help: 'Charge attempts whose outcome is not known yet',
  labels: [],
});

export const dunningExhaustedCounter = MetricsRegistry.counter({
  name: 'billing_dunning_exhausted_total',
  help: 'Invoices written off after the last numbered attempt',
  labels: [],
});

export const overdueSubscriptionsGauge = MetricsRegistry.gauge({
  name: 'billing_overdue_subscriptions',
  help: 'Subscriptions due for renewal for more than 30 minutes',
  labels: [],
});

// ---- S18 (FR-040): usage and entitlements. Labels are closed enums; never a subject, event or invoice reference. ---

export const usageIngestedCounter = MetricsRegistry.counter({
  name: 'usage_events_ingested_total',
  help: 'Usage events stored, by metric class (api, llm)',
  labels: ['metric_class'],
});

export const usageRejectedCounter = MetricsRegistry.counter({
  name: 'usage_events_rejected_total',
  help: 'Usage messages dead-lettered, by reason (invalid_payload, unknown_metric, ts_in_future, too_old)',
  labels: ['reason'],
});

export const usageIgnoredCounter = MetricsRegistry.counter({
  name: 'usage_events_ignored_total',
  help: 'Usage messages that record nothing, by reason (zero_quantity, duplicate)',
  labels: ['reason'],
});

export const entitlementChecksCounter = MetricsRegistry.counter({
  name: 'entitlement_checks_total',
  help: 'Entitlement answers, by kind (get, has, limit, quota, guard) and outcome (ok, denied, unavailable)',
  labels: ['kind', 'outcome'],
});

export const entitlementInvalidationsCounter = MetricsRegistry.counter({
  name: 'entitlement_invalidations_total',
  help: 'Entitlement cache invalidations, by outcome (applied, stale_event, duplicate)',
  labels: ['outcome'],
});

export const entitlementsStaleServedCounter = MetricsRegistry.counter({
  name: 'entitlements_stale_served_total',
  help: 'Entitlement answers served from an expired entry because the source failed',
  labels: [],
});

export const entitlementsCacheErrorsCounter = MetricsRegistry.counter({
  name: 'entitlements_cache_errors_total',
  help: 'Entitlement cache store failures that degraded a read or failed an invalidation',
  labels: [],
});

export const usageSettlementConflictsCounter = MetricsRegistry.counter({
  name: 'usage_settlement_conflicts_total',
  help: 'Settlements refused because the plan was stale',
  labels: [],
});

export const usageLedgerDriftGauge = MetricsRegistry.gauge({
  name: 'usage_ledger_drift',
  help: 'Ledger rows that break an invariant at the last reconciliation',
  labels: [],
});
