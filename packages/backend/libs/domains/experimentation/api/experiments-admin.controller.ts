import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import {
  EXPERIMENT_KEY_PATTERN,
  EXPERIMENT_STATUSES,
  experimentWriteSchema,
  type Experiment,
  type ExperimentHistoryPage,
  type ExperimentPage,
  type ExperimentResults,
  type ExperimentWrite,
} from '@marketplace-sandbox/contracts';
import { Firewall, Role, User, UserRawDto } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { ExperimentCommandService } from '../application/experiment-command.service';
import {
  ExperimentQueryService,
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
} from '../application/experiment-query.service';
import { ExperimentResultsService } from '../application/experiment-results.service';
import type { ExperimentStatus } from '../domain/experiment-types';
import { ExperimentZodPipe } from './experiment-zod.pipe';

const keySchema = z.string().regex(EXPERIMENT_KEY_PATTERN);
const limit = z
  .string()
  .regex(/^[0-9]{1,4}$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(LIST_MAX_LIMIT))
  .default(LIST_DEFAULT_LIMIT);
const listQuerySchema = z.object({
  limit,
  cursor: z.string().min(1).max(1024).optional(),
  status: z.enum(EXPERIMENT_STATUSES).optional(),
});
const historyQuerySchema = z.object({
  limit,
  cursor: z.string().min(1).max(1024).optional(),
});

/** Plain aliases: a `z.output<...>` parameter type would make the global ValidationPipe try to instantiate it. */
type ListQuery = { limit: number; cursor?: string; status?: ExperimentStatus };
type HistoryQuery = { limit: number; cursor?: string };

const keyPipe = new ExperimentZodPipe(keySchema, 'key');

/** Admin routes of experiments (S39): thin; each makes one application call and maps to the contract schema. */
@ApiTags('experiments')
@Controller()
export class ExperimentsAdminController {
  constructor(
    private readonly commands: ExperimentCommandService,
    private readonly queries: ExperimentQueryService,
    private readonly readouts: ExperimentResultsService,
  ) {}

  @Firewall({ roles: [Role.ADMIN] })
  @Get('admin/experiments')
  list(
    @Query(new ExperimentZodPipe(listQuerySchema)) query: ListQuery,
  ): Promise<ExperimentPage> {
    return this.queries.list(query);
  }

  @Firewall({ roles: [Role.ADMIN] })
  @Get('admin/experiments/:key')
  get(@Param('key', keyPipe) key: string): Promise<Experiment> {
    return this.queries.get(key);
  }

  @Firewall({ roles: [Role.ADMIN] })
  @RateLimit('experiments.admin.write')
  @Put('admin/experiments/:key')
  async save(
    @Param('key', keyPipe) key: string,
    @Body(new ExperimentZodPipe(experimentWriteSchema)) body: ExperimentWrite,
    @User() user: UserRawDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Experiment> {
    const result = await this.commands.save(key, body, user.id);
    if (result.created) {
      res.status(HttpStatus.CREATED);
      res.setHeader('Location', `/api/admin/experiments/${key}`);
    } else res.status(HttpStatus.OK);
    return result.experiment;
  }

  @Firewall({ roles: [Role.ADMIN] })
  @RateLimit('experiments.admin.write')
  @Post('admin/experiments/:key/start')
  @HttpCode(HttpStatus.OK)
  async start(
    @Param('key', keyPipe) key: string,
    @User() user: UserRawDto,
  ): Promise<Experiment> {
    return (await this.commands.start(key, user.id)).experiment;
  }

  @Firewall({ roles: [Role.ADMIN] })
  @RateLimit('experiments.admin.write')
  @Post('admin/experiments/:key/stop')
  @HttpCode(HttpStatus.OK)
  async stop(
    @Param('key', keyPipe) key: string,
    @User() user: UserRawDto,
  ): Promise<Experiment> {
    return (await this.commands.stop(key, user.id)).experiment;
  }

  @Firewall({ roles: [Role.ADMIN] })
  @Get('admin/experiments/:key/history')
  history(
    @Param('key', keyPipe) key: string,
    @Query(new ExperimentZodPipe(historyQuerySchema)) query: HistoryQuery,
  ): Promise<ExperimentHistoryPage> {
    return this.queries.history(key, query);
  }

  @Firewall({ roles: [Role.ADMIN] })
  @RateLimit('experiments.results')
  @Header('Cache-Control', 'no-store')
  @Get('admin/experiments/:key/results')
  results(@Param('key', keyPipe) key: string): Promise<ExperimentResults> {
    return this.readouts.results(key);
  }
}
