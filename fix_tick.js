const fs = require('fs');
let lines = fs.readFileSync('backend/src/config/db.ts', 'utf8').split('\n');
if (lines[4104].trim() === '`') {
  lines.splice(4104, 1);
  fs.writeFileSync('backend/src/config/db.ts', lines.join('\n'));
  console.log('Fixed floating backtick');
} else {
  console.log('Line 4104 was not a backtick:', lines[4104]);
}
