const fs = require('fs');

let c = fs.readFileSync('backend/src/modules/auth/sales.service.ts', 'utf8');

// 1. Allow empty items in CreateSaleCommandHandler
c = c.replace(
  "if (!cmd.items.length) throw new Error('Sale must have at least one item');",
  "// if (!cmd.items.length) throw new Error('Sale must have at least one item'); // Allow empty for shell invoices"
);

c = c.replace(
  "for (const si of cmd.items) {",
  "for (const si of (cmd.items || [])) {"
);

// 2. Add PUT endpoint for updating Sales/Invoices
const putEndpoint = `
salesRouter.put('/:saleId', requireMinRole('staff'), async (req, res) => {
  try {
    const user = (req as any).user;
    const { saleId } = req.params;
    const updates = req.body;
    
    // Only allow updating certain fields to preserve financial integrity
    const allowedFields = ['customer_name', 'customer_phone', 'customer_email', 'payment_method', 'notes', 'sale_date', 'total_amount'];
    const updateKeys = Object.keys(updates).filter(k => allowedFields.includes(k) || allowedFields.includes(k.replace(/([A-Z])/g, "_$1").toLowerCase()));
    
    if (updateKeys.length > 0) {
      const setClause = updateKeys.map((k, i) => {
        const dbKey = k.replace(/([A-Z])/g, "_$1").toLowerCase();
        return \`"\${dbKey}" = $\${i + 3}\`;
      }).join(', ');
      
      const values = updateKeys.map(k => updates[k]);
      
      await query(
        \`UPDATE sales SET \${setClause}, updated_at = NOW() WHERE id = $1 AND tenant_id = $2\`,
        [saleId, user.tenantId, ...values]
      );
    }
    
    ok(res, { success: true });
  } catch (e: any) { fail(res, e.message); }
});
`;

if (!c.includes("salesRouter.put('/:saleId'")) {
  c = c.replace(
    "salesRouter.delete('/:saleId',",
    putEndpoint + "\n\nsalesRouter.delete('/:saleId',"
  );
}

fs.writeFileSync('backend/src/modules/auth/sales.service.ts', c);
console.log('Fixed sales.service.ts');
