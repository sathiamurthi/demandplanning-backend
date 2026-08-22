const fs = require('fs');
const content = fs.readFileSync('backend/src/config/db.ts', 'utf8');
const lines = content.split('\n');
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('`')) {
    console.log(`Line ${i + 1}: has backtick`);
  }
}
