const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://postgres:postgres@localhost:5432/dplaning' });

pool.query('SELECT COUNT(*) FROM ai_forecasts WHERE order_needed = true')
  .then(res => console.log('count:', res.rows))
  .catch(console.error)
  .finally(() => pool.end());
