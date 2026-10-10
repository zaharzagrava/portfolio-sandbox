import { Inject, Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { CLOCK, Clock } from '@app/common/core/clock';
import { getActiveTransaction } from '@app/infrastructure/context';
import type { UserRecord, UserRepository } from '../../domain/ports';
import User, { Role } from './user.model';

const toRecord = (u: User): UserRecord => ({
  id: u.id,
  email: u.email,
  passwordHash: u.passwordHash,
  role: u.role,
  createdAt: u.createdAt,
});

/** Postgres adapter of the `USER_REPOSITORY` port. Joins the active transaction (CLS) when there is one. */
@Injectable()
export class SequelizeUserRepository implements UserRepository {
  constructor(
    @InjectModel(User) private readonly users: typeof User,
    @InjectConnection() private readonly sequelize: Sequelize,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async findByEmail(email: string): Promise<UserRecord | null> {
    const row = await this.users.findOne({
      where: Sequelize.where(
        Sequelize.fn('lower', Sequelize.col('email')),
        email,
      ),
    });
    return row ? toRecord(row) : null;
  }

  async findById(id: string): Promise<UserRecord | null> {
    const row = await this.users.findByPk(id);
    return row ? toRecord(row) : null;
  }

  async findByIds(ids: string[]): Promise<UserRecord[]> {
    if (ids.length === 0) return [];
    return (await this.users.findAll({ where: { id: ids } })).map(toRecord);
  }

  async insertIfAbsent(input: {
    email: string;
    passwordHash: string;
    role: Role;
  }): Promise<{ id: string; created: boolean }> {
    const transaction = getActiveTransaction();
    const now = this.clock.now();
    // One statement against the lower(email) unique index: a loser of a race gets no row back instead of an error
    // that would abort the surrounding transaction.
    const [inserted] = await this.sequelize.query<{ id: string }>(
      `INSERT INTO "User" ("email", "passwordHash", "role", "createdAt", "updatedAt")
       VALUES ($1, $2, $3::"enum_User_role", $4, $4)
       ON CONFLICT (lower("email")) WHERE "email" IS NOT NULL DO NOTHING
       RETURNING "id"`,
      {
        bind: [input.email, input.passwordHash, input.role, now],
        transaction,
        type: QueryTypes.SELECT,
      },
    );
    if (inserted) return { id: inserted.id, created: true };
    const existing = await this.sequelize.query<{ id: string }>(
      `SELECT "id" FROM "User" WHERE lower("email") = $1 AND "email" IS NOT NULL LIMIT 1`,
      { bind: [input.email], transaction, type: QueryTypes.SELECT },
    );
    return { id: existing[0].id, created: false };
  }

  async clearPassword(id: string): Promise<boolean> {
    const updated = await this.sequelize.query<{ id: string }>(
      `UPDATE "User" SET "passwordHash" = NULL, "updatedAt" = $2
       WHERE "id" = $1 AND "passwordHash" IS NOT NULL
       RETURNING "id"`,
      {
        bind: [id, this.clock.now()],
        transaction: getActiveTransaction(),
        type: QueryTypes.SELECT,
      },
    );
    return updated.length > 0;
  }

  async lookupByEmail(email: string) {
    const [row] = await this.sequelize.query<{
      id: string;
      email: string | null;
      passwordHash: string | null;
      deletedAt: Date | null;
    }>(
      `SELECT "id","email","passwordHash","deletedAt" FROM "User"
       WHERE lower("email") = $1 AND "email" IS NOT NULL LIMIT 1`,
      {
        bind: [email],
        transaction: getActiveTransaction(),
        type: QueryTypes.SELECT,
      },
    );
    return row
      ? {
          id: row.id,
          email: row.email,
          hasPassword: row.passwordHash != null,
          deleted: row.deletedAt != null,
        }
      : null;
  }

  async insertFederated(input: { email: string | null; role: Role }) {
    const now = this.clock.now();
    const [inserted] = await this.sequelize.query<{ id: string }>(
      `INSERT INTO "User" ("email", "passwordHash", "role", "createdAt", "updatedAt")
       VALUES ($1, NULL, $2::"enum_User_role", $3, $3)
       ON CONFLICT DO NOTHING
       RETURNING "id"`,
      {
        bind: [input.email, input.role, now],
        transaction: getActiveTransaction(),
        type: QueryTypes.SELECT,
      },
    );
    return inserted ? { id: inserted.id } : null;
  }

  async replacePasswordHash(
    id: string,
    oldHash: string,
    newHash: string,
  ): Promise<boolean> {
    // Bound values: an Argon2 hash contains `$` and must never be read as a named parameter.
    const updated = await this.sequelize.query<{ id: string }>(
      `UPDATE "User" SET "passwordHash" = $1, "updatedAt" = $4
       WHERE "id" = $2 AND "passwordHash" = $3 AND "deletedAt" IS NULL
       RETURNING "id"`,
      {
        bind: [newHash, id, oldHash, this.clock.now()],
        transaction: getActiveTransaction(),
        type: QueryTypes.SELECT,
      },
    );
    return updated.length > 0;
  }
}
