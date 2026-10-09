import type { Sequelize } from 'sequelize';

/** Simulates a database outage for one app: closes its pool, so every later query on it fails at once. */
export async function stopConnection(sequelize: Sequelize): Promise<void> {
  await sequelize.close();
}
