# Contract: Domain Entry Points (batch 5)

The rules are the same as in [batch 1](../../002-phase2-domain-restructuring/contracts/domain-entrypoints.md).
**[T]** marks a transitional export (D-8: an infrastructure internal that apps wire directly; D-14: the LLM adapter).

| Barrel | Exports |
|---|---|
| `@app/domains/developer-platform` | `PublicApiModule`, `PublicApiWorkerModule`, `DevelopersModule`, `WebhooksModule`, `WebhooksCoreModule`, `WebhooksWorkerModule`, `WidgetModule`; `WebhookDeliverer` (used by the webhook-delivery Lambda); `type WebhookDelivery`; `ApiRequestsProjector`, `WebhookRouterProjector` [T] |
| `@app/domains/marketing` | `AdsModule`, `AdsWorkerModule`, `ShareLinksModule`; `LinkClicksProjector` [T] |
| `@app/domains/experimentation` | `FlagsSdkModule`, `FlagsAdminModule`, `AnalyticsModule`; `ANALYTICS_TOPIC`; `PurchaseEventsProjector` [T] |
| `@app/domains/assistant` | `AssistantModule`, `KnowledgeModule`, `KnowledgeWorkerModule`; `Retriever`, `type RetrievalScope`; `LlmCallsProjector` [T]; LLM adapter [T, D-14]: `LlmModule`, `LLM_PROVIDER`, `type LlmProvider`, `type LlmTurnResult`, `LlmUnavailableError`, `textOf`, `LlmMeter`, `ScriptedLlmProvider` |

`murmur3` is no longer part of any domain. Import it as `@app/common/core/murmur3`.
