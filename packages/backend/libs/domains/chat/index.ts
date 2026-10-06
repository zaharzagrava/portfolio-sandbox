/**
 * Public entry point of the `chat` domain (constitution X.4). Code outside this domain imports only
 * from `@app/domains/chat`. Generated from actual cross-domain usage in Phase 2 (later batches append); extend
 * it by hand when a new export is needed. Models exported here are transitional (IX.4 debt): other
 * domains must stop injecting them.
 */
export { default as ChatChannelMemberModel } from './infra/models/chat-channel-member.model';
export { default as ChatChannelModel } from './infra/models/chat-channel.model';
export { default as ChatMessageModel } from './infra/models/chat-message.model';
export { ChatOfflineWorkerModule } from './chat-offline-worker.module';
export { ChatSyncModule } from './chat-sync.module';
export { ChatModule } from './chat.module';
export { ChatOfflineScheduler } from './infra/chat-offline';
export { ChatTopicsModule } from './realtime-topics.module';
