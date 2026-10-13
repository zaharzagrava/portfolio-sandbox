'use strict';

/**
 * S30 video, contract step (research.md R-19 step 3). Ships only after the new code is deployed (III.11): one
 * statement per step, each under its own `lock_timeout`.
 *  - the two cross-owner foreign keys of `Video` go (IX.4: a reference to another domain is a plain id);
 *  - the legacy free-text `error` and `VideoTask.deps` go (`internalError` and `dependsOn` replaced them);
 *  - the columns every new row fills become NOT NULL, the title becomes `varchar(200)`.
 * `masterKey` / `posterKey` stay: they are the only record of where a legacy video's objects live.
 */
async function step(sequelize, sql) {
  await sequelize.transaction(async (transaction) => {
    await sequelize.query(`SET LOCAL lock_timeout = '3s'`, { transaction });
    await sequelize.query(sql, { transaction });
  });
}

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await step(sequelize, `ALTER TABLE "Video" DROP CONSTRAINT IF EXISTS "Video_shopId_fkey"`);
    await step(sequelize, `ALTER TABLE "Video" DROP CONSTRAINT IF EXISTS "Video_uploaderId_fkey"`);
    for (const column of ['sizeBytes', 'contentType', 'partSize', 'sessionExpiresAt'])
      await step(sequelize, `ALTER TABLE "Video" ALTER COLUMN "${column}" SET NOT NULL`);
    await step(sequelize, `ALTER TABLE "Video" ALTER COLUMN "title" TYPE VARCHAR(200)`);
    await step(sequelize, `ALTER TABLE "Video" DROP CONSTRAINT IF EXISTS "Video_title_length_check"`);
    await step(sequelize, `ALTER TABLE "VideoTask" ALTER COLUMN "dependsOn" SET NOT NULL`);
    await step(sequelize, `ALTER TABLE "VideoTask" DROP COLUMN IF EXISTS "deps"`);
    await step(sequelize, `ALTER TABLE "Video" DROP COLUMN IF EXISTS "error"`);
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await step(sequelize, `ALTER TABLE "Video" ADD COLUMN IF NOT EXISTS "error" TEXT NULL`);
    await step(sequelize, `ALTER TABLE "VideoTask" ADD COLUMN IF NOT EXISTS "deps" TEXT[] NULL`);
    await sequelize.query(`UPDATE "VideoTask" SET "deps" = "dependsOn" WHERE "deps" IS NULL`);
    await step(sequelize, `ALTER TABLE "VideoTask" ALTER COLUMN "deps" SET NOT NULL`);
    await step(sequelize, `ALTER TABLE "VideoTask" ALTER COLUMN "dependsOn" DROP NOT NULL`);
    await step(sequelize, `ALTER TABLE "Video" ALTER COLUMN "title" TYPE TEXT`);
    await step(
      sequelize,
      `ALTER TABLE "Video" ADD CONSTRAINT "Video_title_length_check" CHECK (char_length("title") <= 200) NOT VALID`,
    );
    for (const column of ['sizeBytes', 'contentType', 'partSize', 'sessionExpiresAt'])
      await step(sequelize, `ALTER TABLE "Video" ALTER COLUMN "${column}" DROP NOT NULL`);
    // The foreign keys come back NOT VALID: rows written since the contract step may reference nothing.
    await step(
      sequelize,
      `ALTER TABLE "Video" ADD CONSTRAINT "Video_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") NOT VALID`,
    ).catch(() => undefined);
    await step(
      sequelize,
      `ALTER TABLE "Video" ADD CONSTRAINT "Video_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User" ("id") NOT VALID`,
    ).catch(() => undefined);
  },
};
