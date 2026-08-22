const fs = require('fs');

function addPutDelete(filePath, tableName) {
  let c = fs.readFileSync(filePath, 'utf8');
  
  if (!c.includes('Router.put(')) {
    const putCode = `
// Update
Router.put('/:id', async (req, res) => {
  const tenantId = (req as any).tenantId;
  const { id } = req.params;
  const updates = req.body;
  delete updates.id;
  delete updates.created_at;
  delete updates.updated_at;
  delete updates.items; // handle items separately if needed
  
  try {
    const setClause = Object.keys(updates).map((k, i) => \`"\${k}" = $\${i + 3}\`).join(', ');
    const values = Object.values(updates);
    
    if (setClause) {
      await pool.query(
        \`UPDATE ${tableName} SET \${setClause}, updated_at = NOW() WHERE id = $1 AND tenant_id = $2\`,
        [id, tenantId, ...values]
      );
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete
Router.delete('/:id', async (req, res) => {
  const tenantId = (req as any).tenantId;
  const { id } = req.params;
  try {
    await pool.query(\`DELETE FROM ${tableName} WHERE id = $1 AND tenant_id = $2\`, [id, tenantId]);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});
`;
    // Replace Router with actual router name
    let routerName = filePath.includes('sales-orders') ? 'salesOrdersRouter' : 'crmRouter'; // wait CRM has multiple
    
    if (filePath.includes('sales-orders')) {
      c += putCode.replace(/Router/g, 'salesOrdersRouter');
    }
  }
  
  fs.writeFileSync(filePath, c);
}

// Since CRM router has both leads and quotations, I will manually append PUT/DELETE for them.
let crm = fs.readFileSync('backend/src/modules/auth/crm.service.ts', 'utf8');
if (!crm.includes('crmRouter.put(')) {
  crm += `
// Update Lead
crmRouter.put('/leads/:id', async (req, res) => {
  const tenantId = (req as any).tenantId;
  const { id } = req.params;
  const updates = req.body;
  delete updates.id;
  try {
    const setClause = Object.keys(updates).map((k, i) => \`"\${k}" = $\${i + 3}\`).join(', ');
    const values = Object.values(updates);
    if (setClause) {
      await pool.query(
        \`UPDATE leads SET \${setClause}, updated_at = NOW() WHERE id = $1 AND tenant_id = $2\`,
        [id, tenantId, ...values]
      );
    }
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// Delete Lead
crmRouter.delete('/leads/:id', async (req, res) => {
  const tenantId = (req as any).tenantId;
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM leads WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// Update Quotation
crmRouter.put('/quotations/:id', async (req, res) => {
  const tenantId = (req as any).tenantId;
  const { id } = req.params;
  const updates = req.body;
  delete updates.id; delete updates.items;
  try {
    const setClause = Object.keys(updates).map((k, i) => \`"\${k}" = $\${i + 3}\`).join(', ');
    const values = Object.values(updates);
    if (setClause) {
      await pool.query(
        \`UPDATE quotations SET \${setClause}, updated_at = NOW() WHERE id = $1 AND tenant_id = $2\`,
        [id, tenantId, ...values]
      );
    }
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// Delete Quotation
crmRouter.delete('/quotations/:id', async (req, res) => {
  const tenantId = (req as any).tenantId;
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM quotations WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});
`;
  fs.writeFileSync('backend/src/modules/auth/crm.service.ts', crm);
}

// Fix items in POST
crm = fs.readFileSync('backend/src/modules/auth/crm.service.ts', 'utf8');
crm = crm.replace('for (const item of items) {', 'for (const item of (items || [])) {');
crm = crm.replace('for (const item of items) {', 'for (const item of (items || [])) {');
fs.writeFileSync('backend/src/modules/auth/crm.service.ts', crm);

let so = fs.readFileSync('backend/src/modules/auth/sales-orders.service.ts', 'utf8');
so = so.replace('for (const item of items) {', 'for (const item of (items || [])) {');
so = so.replace('for (const item of items) {', 'for (const item of (items || [])) {');
fs.writeFileSync('backend/src/modules/auth/sales-orders.service.ts', so);

addPutDelete('backend/src/modules/auth/sales-orders.service.ts', 'sales_orders');

console.log('Added PUT and DELETE endpoints and fixed items');
