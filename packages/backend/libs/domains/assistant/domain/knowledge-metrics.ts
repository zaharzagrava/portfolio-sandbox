import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/**
 * Instruments of the knowledge half (S47 AS-53). Labels are bounded outcomes only: never a question, a document, a
 * title, a user or a shop id.
 */
export const ragIngestCounter = MetricsRegistry.counter({
  name: 'rag_ingest_total',
  help: 'Ingestion passes by outcome (ready, failed, requeued, dead_lettered, noop, rejected)',
  labels: ['outcome'],
});

export const ragIngestDuration = MetricsRegistry.histogram({
  name: 'rag_ingest_duration_seconds',
  help: 'Time of one ingestion pass, claim to commit',
  labels: ['outcome'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120],
});

export const ragRetrievalDuration = MetricsRegistry.histogram({
  name: 'rag_retrieval_duration_seconds',
  help: 'Time of one retrieval (embedding of the question included) by mode',
  labels: ['mode'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
});

export const ragRetrievalDegraded = MetricsRegistry.counter({
  name: 'rag_retrieval_degraded_total',
  help: 'Retrievals that fell back to keyword-only search, by reason (embed_failed, embed_timeout)',
  labels: ['reason'],
});

export const ragRetrievalDeadline = MetricsRegistry.counter({
  name: 'rag_retrieval_deadline_total',
  help: 'Retrievals that exceeded their statement deadline',
  labels: [],
});

export const ragAnswers = MetricsRegistry.counter({
  name: 'rag_answers_total',
  help: 'Questions by outcome (answered, not_found, refused, error, aborted)',
  labels: ['outcome'],
});

export const ragDocuments = MetricsRegistry.gauge({
  name: 'rag_documents',
  help: 'Knowledge documents by status',
  labels: ['status'],
});

export const ragCacheErrors = MetricsRegistry.counter({
  name: 'rag_cache_errors_total',
  help: 'Question-embedding cache calls that failed and were ignored',
  labels: ['op'],
});

export const ragModerationRejected = MetricsRegistry.counter({
  name: 'rag_moderation_rejected_total',
  help: 'Questions rejected before retrieval, by category',
  labels: ['category'],
});
