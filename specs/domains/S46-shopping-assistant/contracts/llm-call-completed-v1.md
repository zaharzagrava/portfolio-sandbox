# Contract: event `llm.call_completed` v1 (outbox → Kafka)

Envelope `{eventId, type: 'llm.call_completed', version: 1, occurredAt, aggregateId}`; `aggregateId = callId = "<messageId>:<n>"` (summary `:0`; S04 `"<documentId>:<attempt>"`); `eventId` = UUIDv5(callId). At-least-once. Schema `llmCallCompletedV1` in `packages/contracts/src/assistant/llm-call-completed.ts`.

Payload (fields are only ever **added** within v1):

`userId, subjectId, metric ('llm.assistant.tokens' | 'llm.rag.tokens' | extraction metric), billableTokens (int ≥ 0), conversationId (scope id), scopeId?, messageId, callId, purpose ('chat'|'summary'|'extraction'|'rag'), requestedModel, model, outcome ('completed'|'refused'|'aborted'|'failed'; optional for older producers), ttftMs (int or null), durationMs, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costMicros (int ≥ 0), usageEstimated (bool), stopReason, toolCalls`.

Consumers: S18 (usage, identity `llm:<aggregateId>`) and the `llm-calls-log` projector → ClickHouse `llm_requests` (de-duplicated by `eventId`; an invalid payload goes to the DLQ with its reason and later messages continue). The parser stays tolerant of the optional `scopeId` / `outcome` that S47 sends.
