import {pool} from './backend/src/config/db';
pool.query('SELECT name, symbol, tenant_id FROM unit_types LIMIT 15')
  .then(r => {
    console.log(r.rows);
    process.exit(0);
  })
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
