const fs = require('fs');

function fixFile(filePath) {
  let c = fs.readFileSync(filePath, 'utf8');
  c = c.replace(/import \{ pool \} from '\.\.\/\.\.\/\.\.\/config\/db';/, "import { pool } from '../../config/db';");
  c = c.replace(/import \{ authMiddleware, tenantContextMiddleware \} from '\.\.\/\.\.\/\.\.\/middleware\/auth\.middleware';/, "import { authMiddleware, tenantContextMiddleware } from './auth.service';");
  
  c = c.replace(/req\.tenantId/g, "(req as any).tenantId");
  c = c.replace(/req\.user\?/g, "(req as any).user?");
  
  fs.writeFileSync(filePath, c);
}

fixFile('backend/src/modules/auth/crm.service.ts');
fixFile('backend/src/modules/auth/sales-orders.service.ts');
console.log('Fixed imports and typings');
