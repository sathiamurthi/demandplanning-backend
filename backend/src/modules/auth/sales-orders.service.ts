import { Router } from 'express';
import { pool } from '../../config/db';
import { authMiddleware, tenantContextMiddleware } from './auth.service';

export const salesOrdersRouter = Router({ mergeParams: true });
salesOrdersRouter.use(authMiddleware);
salesOrdersRouter.use(tenantContextMiddleware);

// Get all sales orders
salesOrdersRouter.get('/', async (req, res) => {
  const tenantId = (req as any).tenantId;
  const storeId = (req.params as any).storeId;
  
  try {
    const result = await pool.query(
      'SELECT * FROM sales_orders WHERE tenant_id = $1 AND store_id = $2 ORDER BY created_at DESC',
      [tenantId, storeId]
    );
    res.json({ success: true, data: result.rows });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create sales order
salesOrdersRouter.post('/', async (req, res) => {
  const tenantId = (req as any).tenantId;
  const storeId = (req.params as any).storeId;
  const userId = (req as any).user?.userId;
  const { quotation_id, customer_name, customer_email, customer_phone, order_date, expected_delivery, status, notes, items } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const countRes = await client.query('SELECT COUNT(*) FROM sales_orders WHERE tenant_id = $1', [tenantId]);
    const orderNum = `SO-${new Date().getFullYear()}-${String(parseInt(countRes.rows[0].count) + 1).padStart(4, '0')}`;

    let subtotal = 0, discount_amount = 0, gst_amount = 0, total_amount = 0;
    
    for (const item of items) {
      subtotal += Number(item.qty) * Number(item.unit_price);
      const discount = (Number(item.qty) * Number(item.unit_price) * Number(item.discount_pct || 0)) / 100;
      discount_amount += discount;
      const taxable = (Number(item.qty) * Number(item.unit_price)) - discount;
      gst_amount += (taxable * Number(item.gst_rate || 0)) / 100;
    }
    total_amount = subtotal - discount_amount + gst_amount;

    const soRes = await client.query(
      `INSERT INTO sales_orders (tenant_id, store_id, quotation_id, order_number, customer_name, customer_email, customer_phone, order_date, expected_delivery, subtotal, discount_amount, gst_amount, total_amount, status, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
      [tenantId, storeId, quotation_id, orderNum, customer_name, customer_email, customer_phone, order_date, expected_delivery, subtotal, discount_amount, gst_amount, total_amount, status || 'Pending', notes, userId]
    );

    const so = soRes.rows[0];

    for (const item of items) {
      const line_total = (Number(item.qty) * Number(item.unit_price)) * (1 - Number(item.discount_pct || 0) / 100) * (1 + Number(item.gst_rate || 0) / 100);
      await client.query(
        `INSERT INTO sales_order_items (sales_order_id, item_id, description, qty, unit_price, discount_pct, gst_rate, line_total)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [so.id, item.item_id, item.description, item.qty, item.unit_price, item.discount_pct || 0, item.gst_rate || 0, line_total]
      );
    }

    // Update quote status if linked
    if (quotation_id) {
      await client.query(`UPDATE quotations SET status = 'Accepted' WHERE id = $1`, [quotation_id]);
    }

    await client.query('COMMIT');
    res.json({ success: true, data: so });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// Get single sales order
salesOrdersRouter.get('/:id', async (req, res) => {
  const tenantId = (req as any).tenantId;
  const { id } = req.params;
  try {
    const qRes = await pool.query('SELECT * FROM sales_orders WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
    if (qRes.rowCount === 0) return res.status(404).json({ success: false, error: 'Sales Order not found' });
    
    const iRes = await pool.query(
      `SELECT soi.*, i.name as item_name, i.sku as item_sku 
       FROM sales_order_items soi 
       LEFT JOIN items i ON i.id = soi.item_id 
       WHERE soi.sales_order_id = $1`, 
      [id]
    );
    
    res.json({ success: true, data: { ...qRes.rows[0], items: iRes.rows } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});
