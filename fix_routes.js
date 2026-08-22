const fs = require('fs');
let c = fs.readFileSync('backend/src/app.ts', 'utf8');

const injection = `app.use('/v1/tenants/:tenantId/stores/:storeId/accounting', accountingRouter);
app.use('/v1/tenants/:tenantId/stores/:storeId/leads', crmRouter);
app.use('/v1/tenants/:tenantId/stores/:storeId/quotations', crmRouter);
app.use('/v1/tenants/:tenantId/stores/:storeId/sales-orders', salesOrdersRouter);
app.use('/v1/tenants/:tenantId/stores/:storeId/sales', authMiddleware, salesRouter);`;

c = c.replace(`app.use('/v1/tenants/:tenantId/stores/:storeId/accounting', accountingRouter);`, injection);

fs.writeFileSync('backend/src/app.ts', c);
