import { Module } from '@nestjs/common';
import { ProblemCatalogModule } from '@app/common/errors/problem-catalog.module';
import { AuthModule } from '@app/domains/identity';
import { ProductModule } from '@app/domains/catalog';
import { IdempotencyModule } from '@app/infrastructure/idempotency';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { DiscussionsController } from './api/discussions.controller';
import { ModerationController } from './api/moderation.controller';
import { BoardQueryService } from './application/board-query.service';
import { CommentService } from './application/comment.service';
import { ModerationService } from './application/moderation.service';
import { PostService } from './application/post.service';
import { VoteService } from './application/vote.service';
import { DiscussionsStoresModule } from './discussions-stores.module';
import { DISCUSSION_PROBLEMS } from './domain/discussion-errors';
import { ACCOUNT_DIRECTORY, BOARD_GATE } from './domain/ports';
import { CatalogBoardGateAdapter } from './infra/catalog-board-gate.adapter';
import { IdentityAccountDirectoryAdapter } from './infra/identity-account-directory.adapter';
import { communityRatePolicies } from './rate-limit-policies';

/**
 * Product discussions, HTTP side (S25, apps/core): boards, posts, comments, votes and shadow bans. Identity and catalog
 * are reached only through their exported services behind the two anti-corruption adapters (IV.8).
 */
@Module({
  imports: [
    AuthModule,
    ProductModule,
    IdempotencyModule,
    DiscussionsStoresModule,
    ProblemCatalogModule.forFeature(DISCUSSION_PROBLEMS),
    RateLimitModule.forFeature(communityRatePolicies),
  ],
  providers: [
    { provide: ACCOUNT_DIRECTORY, useClass: IdentityAccountDirectoryAdapter },
    { provide: BOARD_GATE, useClass: CatalogBoardGateAdapter },
    BoardQueryService,
    PostService,
    CommentService,
    VoteService,
    ModerationService,
  ],
  controllers: [DiscussionsController, ModerationController],
  exports: [DiscussionsStoresModule],
})
export class DiscussionsModule {}
