/**
 * Public entry point of the `community` domain (constitution X.4). Code outside this domain imports only
 * from `@app/domains/community`. Generated from actual cross-domain usage in Phase 2 (later batches append); extend
 * it by hand when a new export is needed. The feed exports its modules and `FollowQueryService` only: no consumer,
 * projector or publisher class (S26 D-8, E3).
 */
export { DiscussionsWorkerModule } from './discussions-worker.module';
export { DiscussionsModule } from './discussions.module';
export { communityRatePolicies } from './rate-limit-policies';
export { DiscussionQueryService } from './application/discussion-query.service';
export type { PostSummaryDto } from './application/discussion-query.service';
export { FollowQueryModule } from './follow-query.module';
export { FollowQueryService } from './application/follow-query.service';
export { FeedModule } from './feed.module';
export { FeedProjectorsModule } from './feed-projectors.module';
export { FeedWorkerModule } from './feed-worker.module';
