import { Pool } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function seedE2E() {
  console.log('Starting E2E Data Seeding...');
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // 1. Create a Tenant
    const tenantRes = await client.query(`
      INSERT INTO tenants (name, slug, industry_id) 
      VALUES ('E2E Test Tenant', 'e2e-test', 'retail') 
      RETURNING id
    `);
    const tenantId = tenantRes.rows[0].id;
    console.log(`Created Tenant: ${tenantId}`);

    // 2. Create a Store
    const storeRes = await client.query(`
      INSERT INTO stores (tenant_id, name, location, is_active)
      VALUES ($1, 'E2E Main Store', 'Test City', true)
      RETURNING id
    `, [tenantId]);
    const storeId = storeRes.rows[0].id;
    console.log(`Created Store: ${storeId}`);

    // 3. Create 5 Users
    for (let i = 1; i <= 5; i++) {
      await client.query(`
        INSERT INTO users (tenant_id, first_name, last_name, email, password_hash, role)
        VALUES ($1, $2, $3, $4, 'hashed_password', 'staff')
      `, [tenantId, `User${i}`, 'Test', `user${i}@e2e.com`]);
    }
    const userRes = await client.query(`SELECT id FROM users WHERE tenant_id = $1 LIMIT 1`, [tenantId]);
    const userId = userRes.rows[0].id;
    console.log('Created 5 Users');

    // 4. Create Categories & Suppliers
    const catRes = await client.query(`
      INSERT INTO categories (tenant_id, store_id, name) VALUES ($1, $2, 'Electronics') RETURNING id
    `, [tenantId, storeId]);
    const catId = catRes.rows[0].id;

    const supRes = await client.query(`
      INSERT INTO suppliers (tenant_id, name, email) VALUES ($1, 'E2E Supplier', 'sup@e2e.com') RETURNING id
    `, [tenantId]);
    const supId = supRes.rows[0].id;

    // 5. Create 5 Items
    const itemIds = [];
    for (let i = 1; i <= 5; i++) {
      const itemRes = await client.query(`
        INSERT INTO items (tenant_id, store_id, category_id, supplier_id, name, current_stock, purchase_price, selling_price, gst_rate)
        VALUES ($1, $2, $3, $4, $5, 100, 50, 100, 18) RETURNING id
      `, [tenantId, storeId, catId, supId, `Test Item ${i}`]);
      itemIds.push(itemRes.rows[0].id);
    }
    console.log('Created 5 Items with 100 stock each');

    // 6. Create 5 Leads (Customers)
    const leadIds = [];
    for (let i = 1; i <= 5; i++) {
      const leadRes = await client.query(`
        INSERT INTO leads (tenant_id, store_id, customer_name, email, status, value, created_by)
        VALUES ($1, $2, $3, $4, 'New', 1000, $5) RETURNING id
      `, [tenantId, storeId, `Customer ${i}`, `customer${i}@e2e.com`, userId]);
      leadIds.push(leadRes.rows[0].id);
    }
    console.log('Created 5 Leads');

    // 7. Create Quotations for Leads
    const quoteIds = [];
    for (let i = 0; i < 5; i++) {
      const qRes = await client.query(`
        INSERT INTO quotations (tenant_id, store_id, lead_id, quote_number, customer_name, issue_date, status, total_amount)
        VALUES ($1, $2, $3, $4, $5, NOW(), 'Draft', 500) RETURNING id
      `, [tenantId, storeId, leadIds[i], `QT-100${i}`, `Customer ${i+1}`]);
      const quoteId = qRes.rows[0].id;
      quoteIds.push(quoteId);

      // Quote Items
      await client.query(`
        INSERT INTO quotation_items (quotation_id, item_id, qty, unit_price, line_total)
        VALUES ($1, $2, 5, 100, 500)
      `, [quoteId, itemIds[i]]);
    }
    console.log('Created 5 Quotations');

    // 8. Create Sales Orders from Quotations
    const soIds = [];
    for (let i = 0; i < 5; i++) {
      const soRes = await client.query(`
        INSERT INTO sales_orders (tenant_id, store_id, quotation_id, order_number, customer_name, order_date, status, total_amount)
        VALUES ($1, $2, $3, $4, $5, NOW(), 'Pending', 500) RETURNING id
      `, [tenantId, storeId, quoteIds[i], `SO-100${i}`, `Customer ${i+1}`]);
      const soId = soRes.rows[0].id;
      soIds.push(soId);

      // SO Items
      await client.query(`
        INSERT INTO sales_order_items (sales_order_id, item_id, qty, unit_price, line_total)
        VALUES ($1, $2, 5, 100, 500)
      `, [soId, itemIds[i]]);
    }
    console.log('Created 5 Sales Orders');

    // 9. Create Sales (Invoices)
    for (let i = 0; i < 5; i++) {
      const saleRes = await client.query(`
        INSERT INTO sales (tenant_id, store_id, sales_order_id, sale_number, customer_name, sale_type, subtotal, total_amount, payment_method)
        VALUES ($1, $2, $3, $4, $5, 'individual', 500, 500, 'Cash') RETURNING id
      `, [tenantId, storeId, soIds[i], `INV-100${i}`, `Customer ${i+1}`]);
      const saleId = saleRes.rows[0].id;

      await client.query(`
        INSERT INTO sale_items (sale_id, item_id, qty_sold, unit_price)
        VALUES ($1, $2, 5, 100)
      `, [saleId, itemIds[i]]);
      
      // Deduct stock manually for direct DB seed
      await client.query(`UPDATE items SET current_stock = current_stock - 5 WHERE id = $1`, [itemIds[i]]);
    }
    console.log('Created 5 Invoices & deducted stock');

    // 10. Purchase Orders
    for (let i = 1; i <= 5; i++) {
      const poRes = await client.query(`
        INSERT INTO purchase_orders (tenant_id, store_id, supplier_id, order_number, order_date, status, total_amount)
        VALUES ($1, $2, $3, $4, NOW(), 'Completed', 250) RETURNING id
      `, [tenantId, storeId, supId, `PO-100${i}`]);
      const poId = poRes.rows[0].id;

      await client.query(`
        INSERT INTO purchase_order_items (purchase_order_id, item_id, qty, unit_cost, total)
        VALUES ($1, $2, 5, 50, 250)
      `, [poId, itemIds[0]]); // just use first item for po
    }
    console.log('Created 5 Purchase Orders');

    await client.query('COMMIT');
    console.log('✅ Successfully seeded E2E Test Data!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Seeding failed:', err);
  } finally {
    client.release();
    process.exit(0);
  }
}

seedE2E();
