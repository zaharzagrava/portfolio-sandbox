import {
  Controller,
  Get,
  Header,
  Headers,
  HttpStatus,
  Inject,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import type { Response } from 'express';
import { Sequelize } from 'sequelize-typescript';
import { Fatal_NotFoundError } from '@app/common/errors';
import { parseMinVersion } from '@app/infrastructure/projections/min-version';
import { ReadYourWrites } from '@app/infrastructure/projections/read-your-writes.service';
import { FixtureService } from './fixture.service';

/** Which consumer's read model the routes read, and the aggregate type of its events. */
export const FIXTURE_READ_CONFIG = Symbol('FIXTURE_READ_CONFIG');
export interface FixtureReadConfig {
  consumer: string;
  aggregateType: string;
}

interface FixtureView {
  id: string;
  name: string;
  version: number;
}

/**
 * Real HTTP routes for the read-your-writes specs (test code only): the principal's tenant is the `x-tenant` header
 * (a stand-in for authentication), the read model is the versioned document a fixture consumer builds from the log,
 * the write model is the `S53Fixture` table. A non-owner and a missing id get the same 404.
 */
@Controller()
export class FixtureReadController {
  constructor(
    private readonly fixtures: FixtureService,
    private readonly readYourWrites: ReadYourWrites,
    @InjectConnection() private readonly sequelize: Sequelize,
    @Inject(FIXTURE_READ_CONFIG) private readonly config: FixtureReadConfig,
  ) {}

  @Get('fixtures/:id')
  @Header('Cache-Control', 'no-store')
  read(
    @Param('id') id: string,
    @Query('minVersion') minVersion: string | string[] | undefined,
    @Headers('x-tenant') tenant: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.handle(id, minVersion, tenant, 'fallback', res);
  }

  @Get('fixtures-pending/:id')
  @Header('Cache-Control', 'no-store')
  readOrPending(
    @Param('id') id: string,
    @Query('minVersion') minVersion: string | string[] | undefined,
    @Headers('x-tenant') tenant: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.handle(id, minVersion, tenant, 'pending', res);
  }

  private async handle(
    id: string,
    rawMinVersion: string | string[] | undefined,
    tenant: string,
    onBehind: 'fallback' | 'pending',
    res: Response,
  ) {
    const owned = async () => {
      const row = await this.fixtures.get(id).catch(() => null);
      // The same answer for a missing id and for another tenant's: existence is not revealed.
      if (!row || row.tenantId !== tenant)
        throw new Fatal_NotFoundError({ detail: `No such fixture: ${id}` });
      return row;
    };
    await owned();
    const minVersion = parseMinVersion(rawMinVersion);

    const resolution = await this.readYourWrites.resolve<FixtureView>({
      consumer: this.config.consumer,
      aggregateType: this.config.aggregateType,
      aggregateId: id,
      minVersion,
      onBehind,
      readWriteModel: async () => {
        const row = await owned();
        return { id: row.id, name: row.name, version: row.version };
      },
    });

    if (resolution.source === 'pending') {
      res.status(HttpStatus.ACCEPTED).setHeader('Retry-After', '1');
      return { status: 'pending', requiredVersion: resolution.requiredVersion };
    }
    if (resolution.source === 'write-model') {
      res.setHeader('X-Read-Source', 'write-model');
      return resolution.value;
    }
    const doc = await this.readModel(id);
    if (!doc) {
      // Nothing built yet and nothing was asked for: serve the source of truth rather than an empty answer.
      res.setHeader('X-Read-Source', 'write-model');
      const row = await owned();
      return { id: row.id, name: row.name, version: row.version };
    }
    res.setHeader('X-Read-Source', 'read-model');
    return doc;
  }

  private async readModel(id: string): Promise<FixtureView | null> {
    const [rows] = await this.sequelize.query(
      `SELECT "version", "name" FROM "S53FixtureDoc" WHERE "consumer" = $1 AND "aggregateId" = $2 AND NOT "deleted"`,
      { bind: [this.config.consumer, id] },
    );
    const row = (rows as { version: string; name: string }[])[0];
    return row ? { id, name: row.name, version: Number(row.version) } : null;
  }
}
