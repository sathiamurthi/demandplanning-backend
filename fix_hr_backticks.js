const fs = require('fs');
let c = fs.readFileSync('backend/src/modules/auth/hr.service.ts', 'utf8');
c = c.replace(/\\\`/g, '\`');
fs.writeFileSync('backend/src/modules/auth/hr.service.ts', c);
