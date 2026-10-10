'use strict';

/**
 * S32 discovery, expand step 4: "SearchSynonymSet" (single row, id = 1) and "SearchSynonymVersion" (history). The data
 * step seeds version 1 from the defaults the code carried before (elasticsearch.service.ts DEFAULT_SYNONYMS).
 */
const DEFAULT_RULES = [
  'airpods, earbuds, wireless headphones',
  'phone, smartphone, mobile',
  'laptop, notebook',
  'tv, television',
  'sneakers, trainers',
];

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const t = (sql, replacements) =>
        queryInterface.sequelize.query(sql, { transaction, replacements });
      await t(`SET LOCAL lock_timeout = '3s'`);
      await t(`
        CREATE TABLE IF NOT EXISTS "SearchSynonymSet" (
          "id" SMALLINT PRIMARY KEY CHECK ("id" = 1),
          "version" INTEGER NOT NULL,
          "rules" TEXT[] NOT NULL,
          "updatedBy" UUID NULL,
          "updatedAt" TIMESTAMPTZ NOT NULL,
          "pendingVersion" INTEGER NULL,
          "pendingRules" TEXT[] NULL,
          "pendingAt" TIMESTAMPTZ NULL
        );
        CREATE TABLE IF NOT EXISTS "SearchSynonymVersion" (
          "version" INTEGER PRIMARY KEY,
          "rules" TEXT[] NOT NULL,
          "updatedBy" UUID NULL,
          "createdAt" TIMESTAMPTZ NOT NULL
        );
      `);
      await t(
        `INSERT INTO "SearchSynonymSet" ("id", "version", "rules", "updatedAt")
         VALUES (1, 1, ARRAY[:rules]::text[], now()) ON CONFLICT ("id") DO NOTHING`,
        { rules: DEFAULT_RULES },
      );
      await t(
        `INSERT INTO "SearchSynonymVersion" ("version", "rules", "createdAt")
         VALUES (1, ARRAY[:rules]::text[], now()) ON CONFLICT ("version") DO NOTHING`,
        { rules: DEFAULT_RULES },
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP TABLE IF EXISTS "SearchSynonymVersion";
      DROP TABLE IF EXISTS "SearchSynonymSet";
    `);
  },
};
