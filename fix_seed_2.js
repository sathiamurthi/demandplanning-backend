const fs = require('fs');

let c = fs.readFileSync('scripts/seed-e2e.ts', 'utf8');
c = c.replace(
  "INSERT INTO stores (tenant_id, name, location, is_active)",
  "INSERT INTO stores (tenant_id, name, address, is_active)"
);

c = c.replace(
  "INSERT INTO sales (tenant_id, store_id, sales_order_id, sale_number, customer_name, sale_type, subtotal, total_amount, payment_method)",
  "INSERT INTO sales (tenant_id, store_id, sales_order_id, sale_number, customer_name, sale_type, subtotal, total_amount, payment_method)"
);

fs.writeFileSync('scripts/seed-e2e.ts', c);
console.log('Fixed stores insert');
