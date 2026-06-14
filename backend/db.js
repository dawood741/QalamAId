const mysql = require('mysql2');

// Railway/env vars win; .env only fills gaps for local dev
require('dotenv').config({ override: false });

const pool = mysql.createPool({
  host: process.env.DB_HOST || process.env.MYSQLHOST,
  port: Number(process.env.DB_PORT || process.env.MYSQLPORT || 3306),
  user: process.env.DB_USER || process.env.MYSQLUSER,
  password: process.env.DB_PASSWORD || process.env.MYSQLPASSWORD,
  database: process.env.DB_NAME || process.env.MYSQLDATABASE,
  waitForConnections: true,
  connectionLimit: 10
});

module.exports = pool.promise();
