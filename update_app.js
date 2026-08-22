const fs = require('fs');
let c = fs.readFileSync('backend/src/app.ts', 'utf8');

c = c.replace(
  "import { itemRouter }                from './modules/auth/items.service';",
  "import { itemRouter }                from './modules/auth/items.service';\nimport { crmRouter }                 from './modules/auth/crm.service';\nimport { salesOrdersRouter }         from './modules/auth/sales-orders.service';"
);

c = c.replace(
  "tenantRouter.use('/:storeId/items', itemRouter);",
  "tenantRouter.use('/:storeId/items', itemRouter);\n// CRM & Sales Orders\ntenantRouter.use('/:storeId/crm', crmRouter);\ntenantRouter.use('/:storeId/sales-orders', salesOrdersRouter);"
);

fs.writeFileSync('backend/src/app.ts', c);
console.log('App updated!');
