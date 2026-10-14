/**
 * Public entry point of the `chat` domain (constitution X.4). Code outside this domain imports only from
 * `@app/domains/chat`: the modules, the rate-limit policies and the event definitions. No model, repository, service
 * class or key helper is exported (D-7, FR-045; `check:boundaries`).
 */
export { ChatModule } from './chat.module';
export { ChatSyncModule } from './chat-sync.module';
export { ChatTopicsModule } from './realtime-topics.module';
export { ChatOfflineWorkerModule } from './chat-offline-worker.module';
export { ChatProjectorModule } from './chat-projector.module';
export { chatRatePolicies } from './rate-limit-policies';
export {
  ChatMessageEscalated,
  ChatMessagePosted,
} from './application/events/chat-events';
