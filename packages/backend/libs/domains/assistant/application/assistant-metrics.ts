import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/**
 * Instruments of the shopping assistant (S46 AS-70, contracts/config-and-policies.md). Labels are bounded sets only:
 * never a user id, a conversation id, a message or a product.
 */
export const assistantTtft = MetricsRegistry.histogram({
  name: 'assistant_ttft_seconds',
  help: 'Time from the provider call start to its first text, by model',
  labels: ['model'],
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
});

export const assistantTurnDuration = MetricsRegistry.histogram({
  name: 'assistant_turn_duration_seconds',
  help: 'Time of one turn, from admission to its terminal event, by outcome',
  labels: ['outcome'],
  buckets: [0.5, 1, 2, 5, 10, 30, 60, 120, 240],
});

export const assistantTokens = MetricsRegistry.counter({
  name: 'assistant_tokens_total',
  help: 'Tokens used by model calls, by model and kind (input, output, cache_read, cache_write)',
  labels: ['model', 'kind'],
});

export const assistantTurns = MetricsRegistry.counter({
  name: 'assistant_turns_total',
  help: 'Turns by outcome (done, refusal, error codes in lower case)',
  labels: ['outcome'],
});

export const assistantFallbacks = MetricsRegistry.counter({
  name: 'assistant_fallbacks_total',
  help: 'Model calls that moved to the fallback model before the first token',
  labels: [],
});

export const assistantAborts = MetricsRegistry.counter({
  name: 'assistant_aborts_total',
  help: 'Generations aborted, by reason (cancel, detached, timeout, shutdown, moderation)',
  labels: ['reason'],
});

export const assistantActiveStreams = MetricsRegistry.gauge({
  name: 'assistant_active_streams',
  help: 'Generations running on this instance',
  labels: [],
});

export const assistantAdmissionRejected = MetricsRegistry.counter({
  name: 'assistant_admission_rejected_total',
  help: 'Sends rejected at admission, by reason',
  labels: ['reason'],
});

export const assistantBreakerState = MetricsRegistry.gauge({
  name: 'assistant_breaker_state',
  help: 'Per model breaker: 1 for the current state, 0 for the others',
  labels: ['model', 'state'],
});

export const assistantProviderErrors = MetricsRegistry.counter({
  name: 'assistant_provider_errors_total',
  help: 'Provider failures by kind (rejected, unavailable, timeout)',
  labels: ['kind'],
});

export const assistantFallbackLimiter = MetricsRegistry.counter({
  name: 'assistant_limiter_fail_open_total',
  help: 'Admission checks answered without the limiter store (policy fail mode applied)',
  labels: ['policy'],
});

export const assistantChargeFailures = MetricsRegistry.counter({
  name: 'assistant_quota_charge_failures_total',
  help: 'Allowance charges that failed after a retry',
  labels: [],
});

export const assistantToolCalls = MetricsRegistry.counter({
  name: 'assistant_tool_calls_total',
  help: 'Tool executions by tool and outcome (ok, error)',
  labels: ['tool', 'outcome'],
});
