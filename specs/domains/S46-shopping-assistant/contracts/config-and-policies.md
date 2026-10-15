# Contract: configuration, rate-limit policies, metrics

## Config keys (validated at startup; the message names the key)

`anthropic_api_key`, `assistant_model`, `assistant_fallback_model`, `assistant_summary_model`, `assistant_effort`, `assistant_detach_grace_ms` (10 000), `assistant_max_active_turns` (3), `assistant_first_token_timeout_ms` (30 000), `assistant_call_timeout_ms` (120 000), `assistant_turn_timeout_ms` (240 000), `assistant_tool_timeout_ms` (5 000), `assistant_heartbeat_ms` (15 000, at most 25 000), `assistant_replay_window_ms` (900 000), `assistant_drain_ms` (25 000), `assistant_require_distinct_fallback` (default on in production).

**Removed**: `assistant_buyer_tokens_per_month`.

Startup fails for: real provider without a key; scripted provider in production; a model id missing from the price table; a negative or non-integer limit or timeout; fallback equal to primary when required; heartbeat above 25 s.

## Rate-limit policies (domain-owned, `definePolicies('assistant', …)`)

- `llm.messages`: 20/min per user, token bucket, **fail closed**.
- `llm.provider.tpm`: 2 000 000/min per model, weighted `cost`, **fail open** (the fallback is logged and counted).
- `rag.ask` lives in S47's own policies file.

## Metrics (no user or conversation id in any label)

`assistant_ttft_seconds{model}`, `assistant_turn_duration_seconds{outcome}`, `assistant_tokens_total{model,kind}`, `assistant_turns_total{outcome}`, `assistant_fallbacks_total`, `assistant_aborts_total{reason}`, `assistant_active_streams` (gauge, returns to 0), `assistant_admission_rejected_total{reason}`, `assistant_breaker_state{model,state}`, `assistant_provider_errors_total{kind}`, `assistant_metering_failures_total`.
