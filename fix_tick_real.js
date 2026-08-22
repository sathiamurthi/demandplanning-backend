const fs = require('fs');
let c = fs.readFileSync('backend/src/config/db.ts', 'utf8');

c = c.replace(
  'CREATE INDEX IF NOT EXISTS idx_reconciliation_batch ON data360_reconciliation_logs(batch_id);\n// Demo agent login',
  'CREATE INDEX IF NOT EXISTS idx_reconciliation_batch ON data360_reconciliation_logs(batch_id);\n      `\n    },\n    {\n      // Demo agent login'
);

fs.writeFileSync('backend/src/config/db.ts', c);
console.log('Fixed!');
