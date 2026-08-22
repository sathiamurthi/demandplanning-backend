const fs = require('fs');
const content = fs.readFileSync('backend/src/config/db.ts', 'utf-8');
const matches = [...content.matchAll(/name:\s*'([^']+)'/g)];
console.log(matches.map(m => m[1]).join('\n'));
