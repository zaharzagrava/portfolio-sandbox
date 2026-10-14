import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/**
 * Metrics of flags (S38 AS-58, FR-064). The only label with many values is `flag`: it is the key of a flag in the
 * ruleset (at most 500) and a key that is not in the ruleset is labelled `unknown`, so an attacker-chosen key never
 * becomes a series (R-22).
 */
export const flagsEvaluationsTotal = MetricsRegistry.counter({
  name: 'flags_evaluations_total',
  help: 'Flag evaluations by flag key and reason (unknown keys are labelled "unknown")',
  labels: ['flag', 'reason'],
});
export const flagsRulesetVersion = MetricsRegistry.gauge({
  name: 'flags_ruleset_version',
  help: 'Version of the ruleset this process evaluates with',
  labels: [],
});
export const flagsRulesetAgeSeconds = MetricsRegistry.gauge({
  name: 'flags_ruleset_age_seconds',
  help: 'Seconds since this process last applied a ruleset',
  labels: [],
});
export const flagsRulesetIgnoredTotal = MetricsRegistry.counter({
  name: 'flags_ruleset_ignored_total',
  help: 'Snapshots ignored because they were not newer than the one in use',
  labels: [],
});
export const flagsRulesetRejectedTotal = MetricsRegistry.counter({
  name: 'flags_ruleset_rejected_total',
  help: 'Snapshots rejected because they were not valid JSON or did not match the snapshot schema',
  labels: [],
});
export const flagsPublishFailuresTotal = MetricsRegistry.counter({
  name: 'flags_publish_failures_total',
  help: 'Ruleset publications to the cache that failed or timed out after a committed change',
  labels: [],
});
export const flagsRefreshFailuresTotal = MetricsRegistry.counter({
  name: 'flags_refresh_failures_total',
  help: 'SDK refreshes that failed on every store and kept the ruleset in use',
  labels: [],
});
export const flagsRepairTotal = MetricsRegistry.counter({
  name: 'flags_repair_total',
  help: 'Runs of the ruleset repair job by outcome',
  labels: ['outcome'],
});
