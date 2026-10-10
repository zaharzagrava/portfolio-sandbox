import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { ApiConfigService } from '@app/common/config';
import { Environment } from '@app/common/types';
import type { TenantDbRoleCheck as TenantDbRoleCheckPort } from '../domain/ports';

/**
 * Row-level security is the backstop that makes a forgotten WHERE return nothing instead of another tenant's rows
 * (FR-053). It does not apply to a superuser or a role with BYPASSRLS, so production refuses to start with one; and a
 * connection without a `statement_timeout` could hold the pool hostage (III.12). Elsewhere the problems are a warning,
 * because the test and local stacks connect as the database owner.
 */
@Injectable()
export class TenantDbRoleCheck implements TenantDbRoleCheckPort, OnModuleInit {
  private readonly logger = new Logger(TenantDbRoleCheck.name);
  lastVerifiedAt: Date | undefined;

  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly config: ApiConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.verify();
  }

  async verify(): Promise<void> {
    const [role] = await this.sequelize.query<{
      name: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
      { type: QueryTypes.SELECT },
    );
    const [timeout] = await this.sequelize.query<{ statement_timeout: string }>(
      `SHOW statement_timeout`,
      { type: QueryTypes.SELECT },
    );

    const problems: string[] = [];
    if (role.rolsuper)
      problems.push(
        `role "${role.name}" is a superuser: row-level security does not apply to it`,
      );
    if (role.rolbypassrls)
      problems.push(
        `role "${role.name}" has BYPASSRLS: row-level security does not apply to it`,
      );
    if (/^0(ms|s)?$/.test(timeout.statement_timeout))
      problems.push(
        'statement_timeout is 0 (unlimited) on the application connection',
      );

    if (problems.length > 0) {
      const message = `tenancy isolation backstop is not effective: ${problems.join('; ')}`;
      if (this.config.get('node_env') === Environment.production)
        throw new Error(message);
      this.logger.warn(message);
    }
    this.lastVerifiedAt = this.clock.now();
  }
}
