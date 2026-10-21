// eslint-disable-next-line
require('dotenv').config();

const dbConfig = {
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  dialect: 'postgres',
  logging: true,
};

module.exports = {
  local: dbConfig,
  development: dbConfig,
  // Matches docker-compose.test.yaml (F-04) and env/test.env.example
  test: {
    username: 'postgres',
    password: 'postgres',
    database: process.env.TEST_DB_NAME || 'marketplace_test', // scripts/infra/shard-prepare.sh migrates marketplace_test_template
    host: 'localhost',
    port: Number(process.env.TEST_DB_PORT) || 5400, // a shard's stack sets TEST_DB_PORT (scripts/infra/shard-stack.sh)
    dialect: 'postgres',
    logging: false,
  },
  staging: dbConfig,
  preprod: dbConfig,
  production: {
    url: process.env.DB_URI,
    dialect: 'postgres',
    logging: true,
    dialectOptions: {
      ssl: {
        require: true,
        // https://stackoverflow.com/questions/58965011/sequelizeconnectionerror-self-signed-certificate
        rejectUnauthorized: false, // <<<<<<< YOU NEED THIS
      },
    },
  },
};
