import { QueryTypes, Sequelize } from 'sequelize';

export interface ProbedJob {
  id: string;
  type: string;
  status: string;
  runAt: Date;
  attempts: number;
  payload: unknown;
}

/**
 * Test-only window onto the job table for specs of other capabilities (FR-059): they ask "which jobs of this type carry
 * this payload fragment" instead of writing SQL against `"Job"`. Production code never uses it.
 */
export class JobsTestProbe {
  constructor(private readonly sequelize: Sequelize) {}

  /** Jobs of `type` whose payload contains `payloadFragment` (JSONB containment), oldest first. */
  async find(
    type: string,
    payloadFragment: Record<string, unknown> = {},
  ): Promise<ProbedJob[]> {
    return this.sequelize.query<ProbedJob>(
      `SELECT id, type, status, "runAt", attempts, payload FROM "Job"
       WHERE type = :type AND payload @> CAST(:fragment AS JSONB) ORDER BY "createdAt", id`,
      {
        type: QueryTypes.SELECT,
        replacements: { type, fragment: JSON.stringify(payloadFragment) },
      },
    );
  }
}
