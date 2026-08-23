const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query('SELECT id, status, error, result FROM ai_pipeline_runs ORDER BY started_at DESC LIMIT 5')
  .then(res => { console.log(JSON.stringify(res.rows, null, 2)); pool.end(); })
  .catch(console.error);
