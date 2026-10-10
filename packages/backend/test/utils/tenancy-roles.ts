import { Sequelize } from 'sequelize-typescript';
import type { Sequelize as SequelizeInstance } from 'sequelize';

export interface ProbeRoleOptions {
  /** Role name; created if absent. */
  name: string;
  bypassRls?: boolean;
  /** `ALTER ROLE ... SET statement_timeout`; omitted = the server default (0, unlimited). */
  statementTimeout?: string;
}

const TENANCY_TABLES = [
  'Shop',
  'ShopMembership',
  'ShopInvite',
  'ShopDirectory',
  'ShopSsoConfig',
  'ShopStatusHistory',
];

/**
 * Creates (idempotently) a login role that is not a superuser, to prove row-level security with a role that does not
 * bypass it (S03 AS-57). Test code only (IX.6): it needs the superuser connection the specs already hold.
 */
export async function ensureProbeRole(
  admin: SequelizeInstance,
  options: ProbeRoleOptions,
): Promise<void> {
  const { name } = options;
  const bypass = options.bypassRls ? 'BYPASSRLS' : 'NOBYPASSRLS';
  await admin.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${name}') THEN
        CREATE ROLE "${name}" LOGIN PASSWORD 'probe' NOSUPERUSER ${bypass};
      ELSE
        ALTER ROLE "${name}" LOGIN PASSWORD 'probe' NOSUPERUSER ${bypass};
      END IF;
    END $$;
    ALTER ROLE "${name}" RESET statement_timeout;
    ${options.statementTimeout ? `ALTER ROLE "${name}" SET statement_timeout = '${options.statementTimeout}';` : ''}
    GRANT USAGE ON SCHEMA public TO "${name}";
    GRANT SELECT, INSERT, UPDATE, DELETE ON ${TENANCY_TABLES.map((t) => `"${t}"`).join(', ')} TO "${name}";
  `);
}

/** A connection pool of one, logged in as `name` (the pool-of-one case of S03 AS-58). */
export function connectAs(admin: SequelizeInstance, name: string): Sequelize {
  const options = admin.config as unknown as {
    host: string;
    port: number;
    database: string;
  };
  return new Sequelize({
    dialect: 'postgres',
    host: options.host,
    port: Number(options.port),
    database: options.database,
    username: name,
    password: 'probe',
    logging: false,
    pool: { max: 1, min: 0 },
  });
}
