'use strict';

/**
 * S28 notifications, data fix before the code starts normalizing: "NotificationSuppression"."address" is trimmed, and
 * lower-cased for the e-mail channel (phones are E.164, push tokens are case-sensitive and stay as they are).
 * Rows that collapse onto one normalized key keep one survivor (the already normalized spelling, else the earliest
 * "createdAt"), so the primary key ("channel", "address") cannot clash. The update runs in batches; both steps are
 * idempotent, a second run changes nothing. No schema change.
 */
const BATCH = 1000;
const NORM = (alias) =>
  `(CASE WHEN ${alias}."channel" = 'email' THEN lower(btrim(${alias}."address")) ELSE btrim(${alias}."address") END)`;

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;

    await sequelize.query(`
      WITH ranked AS (
        SELECT s."channel", s."address",
               row_number() OVER (
                 PARTITION BY s."channel", ${NORM('s')}
                 ORDER BY (s."address" = ${NORM('s')}) DESC, s."createdAt", s."address"
               ) AS rn
        FROM "NotificationSuppression" s
      )
      DELETE FROM "NotificationSuppression" d USING ranked r
      WHERE d."channel" = r."channel" AND d."address" = r."address" AND r.rn > 1
    `);

    for (;;) {
      const [, meta] = await sequelize.query(`
        UPDATE "NotificationSuppression" u SET "address" = ${NORM('u')}
        WHERE (u."channel", u."address") IN (
          SELECT s."channel", s."address" FROM "NotificationSuppression" s
          WHERE s."address" <> ${NORM('s')}
          LIMIT ${BATCH}
        )
      `);
      if ((meta.rowCount ?? 0) < BATCH) break;
    }
  },

  async down() {
    // Normalization loses the original spelling; nothing to restore.
  },
};
