const fs = require('fs');
let c = fs.readFileSync('backend/src/app.ts', 'utf8');

if (!c.includes('import { hrRouter }')) {
  c = c.replace(
    "import { crmRouter }                 from './modules/auth/crm.service';",
    "import { crmRouter }                 from './modules/auth/crm.service';\nimport { hrRouter }                  from './modules/auth/hr.service';"
  );
}

if (!c.includes('app.use(\'/v1/tenants/:tenantId/stores/:storeId\', hrRouter);')) {
  c = c.replace(
    "app.use('/v1/tenants/:tenantId/stores/:storeId', crmRouter); // Provides /leads and /quotations",
    "app.use('/v1/tenants/:tenantId/stores/:storeId', crmRouter); // Provides /leads and /quotations\napp.use('/v1/tenants/:tenantId/stores/:storeId', hrRouter); // Provides /attendance and /timesheets"
  );
}

fs.writeFileSync('backend/src/app.ts', c);
