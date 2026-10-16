import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import type { AttemptRecord, AttemptRepository } from '../domain/ports';
import { count, json, one, rows } from './sql';

const COLUMNS = `"documentId", "attempt", "model", "outcome", "issues", "fields", "sealedFields"`;

/** `DocumentExtraction` (own table): one row per document and attempt. */
@Injectable()
export class SequelizeAttemptRepository implements AttemptRepository {
  constructor(@InjectConnection() private readonly db: Sequelize) {}

  async list(documentId: string): Promise<AttemptRecord[]> {
    return (
      await rows<AttemptRecord>(
        this.db,
        `SELECT ${COLUMNS} FROM "DocumentExtraction" WHERE "documentId" = :documentId ORDER BY "attempt"`,
        { documentId },
      )
    ).map((r) => ({ ...r, attempt: Number(r.attempt) }));
  }

  async latest(documentId: string): Promise<AttemptRecord | null> {
    const row = await one<AttemptRecord>(
      this.db,
      `SELECT ${COLUMNS} FROM "DocumentExtraction" WHERE "documentId" = :documentId ORDER BY "attempt" DESC LIMIT 1`,
      { documentId },
    );
    return row ? { ...row, attempt: Number(row.attempt) } : null;
  }

  async insert(input: Parameters<AttemptRepository['insert']>[0]): Promise<boolean> {
    return (
      (await count(
        this.db,
        `INSERT INTO "DocumentExtraction" ("documentId", "attempt", "model", "promptVersion", "fields", "sealedFields", "issues", "outcome", "inputTokens", "outputTokens", "createdAt")
         VALUES (:documentId, :attempt, :model, :promptVersion, CAST(:fields AS jsonb), :sealedFields, CAST(:issues AS jsonb), :outcome, :inputTokens, :outputTokens, :now)
         ON CONFLICT ("documentId", "attempt") DO NOTHING RETURNING 1`,
        {
          ...input,
          fields: json(input.fields),
          issues: json(input.issues),
        },
      )) > 0
    );
  }
}
