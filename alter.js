const {pool}=require('./backend/dist/config/db.js');
pool.query("ALTER TABLE sales ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'issued'")
  .then(()=>process.exit(0))
  .catch(e=>{console.error(e);process.exit(1);});
