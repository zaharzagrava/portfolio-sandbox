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
