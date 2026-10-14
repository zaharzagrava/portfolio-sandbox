import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  knowledgeAdminCreateRequestSchema,
  knowledgeListQuerySchema,
  type KnowledgeAdminCreateRequest,
  type KnowledgeCreateResponse,
  type KnowledgeDocumentPage,
  type KnowledgeListQuery,
  type KnowledgeReindexResponse,
} from '@marketplace-sandbox/contracts';
import { Firewall, Role, User, UserRawDto } from '@app/domains/identity';
import { DocumentService } from '../application/document.service';
import { ReindexService } from '../application/reindex.service';
import { KnowledgeZodPipe, ValidatedRequest } from './knowledge-validation';

const PLATFORM = { kind: 'platform' } as const;

/** Platform help-center articles and re-index (S47 FR-001, FR-013, AS-40, AS-41): administrators only. */
@ApiTags('knowledge')
@Controller('admin/knowledge')
export class KnowledgeAdminController {
  constructor(
    private readonly documents: DocumentService,
    private readonly reindexer: ReindexService,
  ) {}

  @UseGuards(ValidatedRequest({ body: knowledgeAdminCreateRequestSchema }))
  @Firewall({ roles: [Role.ADMIN] })
  @Post('documents')
  async create(
    @User() user: UserRawDto,
    @Body() body: KnowledgeAdminCreateRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<KnowledgeCreateResponse> {
    const { created, ...answer } = await this.documents.create(
      PLATFORM,
      user.id,
      body,
    );
    res.status(created ? 201 : 200);
    return answer;
  }

  @Firewall({ roles: [Role.ADMIN] })
  @HttpCode(200)
  @Post('documents/:documentId/uploaded')
  uploaded(@Param('documentId', ParseUUIDPipe) documentId: string) {
    return this.documents.uploaded(PLATFORM, documentId);
  }

  @Firewall({ roles: [Role.ADMIN] })
  @Get('documents')
  list(
    @Query(new KnowledgeZodPipe(knowledgeListQuerySchema))
    query: KnowledgeListQuery,
  ): Promise<KnowledgeDocumentPage> {
    return this.documents.list(PLATFORM, query);
  }

  @Firewall({ roles: [Role.ADMIN] })
  @Get('documents/:documentId')
  get(@Param('documentId', ParseUUIDPipe) documentId: string) {
    return this.documents.get(PLATFORM, documentId);
  }

  @Firewall({ roles: [Role.ADMIN] })
  @HttpCode(204)
  @Delete('documents/:documentId')
  async remove(
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ): Promise<void> {
    await this.documents.remove(PLATFORM, documentId);
  }

  @Firewall({ roles: [Role.ADMIN] })
  @HttpCode(202)
  @Post('reindex')
  reindex(): Promise<KnowledgeReindexResponse> {
    return this.reindexer.reindex();
  }
}
