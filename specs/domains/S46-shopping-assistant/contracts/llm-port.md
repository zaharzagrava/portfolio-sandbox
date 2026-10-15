# Contract: `@app/infrastructure/llm`

Imports no domain code and no assistant concept.

```ts
LLM_PROVIDER / interface LlmProvider {
  streamTurn(req: LlmRequest, o: { signal: AbortSignal; onText(t: string): void }): Promise<LlmResult>;
  complete(req: LlmRequest, signal?: AbortSignal): Promise<LlmResult>;
  countTokens(req: LlmRequest): Promise<number>;
}
LlmRequest = { model, system, tools, messages, maxTokens, effort?, toolsDisabled?, outputSchema?,
               timeoutMs?, firstTokenTimeoutMs?, maxRetries?, endUserHash? }  // document/image blocks allowed
LlmResult  = { content, stopReason, refusalCategory, model, usage }
Errors: LlmAbortedError
        LlmUnavailableError { retryAfterMs: number | null }   // transient
        LlmRejectedError                                      // non-transient (400/401/403/404/422)
LlmCallRecorder.record({ subjectId, scopeId, callId, purpose, metric, requestedModel, outcome, result,
                         ttftMs, durationMs, usageEstimated? }): Promise<{ billableTokens, costMicros }>  // never throws
billableTokens(u), costMicros(model, u), estimateTokens(chars)   // pure; a model missing from the price table is a startup error
```

Adapter retry rules (AS-50): at most 2 retries, only before the first token, on 429 (honouring `Retry-After`), 502/503/504/529, connection reset and timeout; exponential backoff with full jitter, never past the first-token deadline; never on 400/401/403/404/422; `maxRetries: 0` makes exactly one attempt; the retried attempts of one call count as one call for metering. A provider 429 sets the fleet-wide model cooldown (Retry-After, default 5 s) through an injected `CooldownStore` port that the assistant binds.

The scripted adapter is exported for tests and keyless local development; it is refused when `NODE_ENV=production`.
