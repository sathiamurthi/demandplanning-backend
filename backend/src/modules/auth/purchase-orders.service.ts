// ============================================================
// PURCHASE ORDERS ROUTER
// ============================================================

import { Router } from 'express';
import { query, queryOne } from '../../config/db';
import { authMiddleware } from '../auth/auth.service';
import { requireMinRole } from '../../core/guards/roleGuard';

const router = Router({ mergeParams: true });
router.use(authMiddleware);

const ok   = (res: any, data: any, status = 200) => res.status(status).json({ success: true, data });
const fail = (res: any, msg: string, status = 400) => res.status(status).json({ success: false, error: msg });

// ── Helpers ──────────────────────────────────────────────────

async function getPOItems(poId: string) {
  return query<any>(
    `SELECT poi.*, i.name AS item_name_ref, i.sku AS item_sku_ref
     FROM purchase_order_items poi
     LEFT JOIN items i ON i.id = poi.item_id
     WHERE poi.po_id = $1
     ORDER BY poi.created_at`,
    [poId]
  );
}

async function recalcTotals(poId: string, client?: any) {
  const exec = client ? (sql: string, vals: any[]) => client.query(sql, vals) : (sql: string, vals: any[]) => query(sql, vals);
  await exec(
    `UPDATE purchase_orders SET
       subtotal     = (SELECT COALESCE(SUM(subtotal),0)  FROM purchase_order_items WHERE po_id=$1),
       gst_amount   = (SELECT COALESCE(SUM(gst_amount),0) FROM purchase_order_items WHERE po_id=$1),
       total_amount = (SELECT COALESCE(SUM(total),0)      FROM purchase_order_items WHERE po_id=$1),
       updated_at   = NOW()
     WHERE id=$1`,
    [poId]
  );
}

// ── GET all ──────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const tenantId = (req as any).user.tenantId;
    const storeId  = req.query.storeId as string | undefined;
    const status   = req.query.status  as string | undefined;

    const conds = ['po.tenant_id=$1'];
    const vals: any[] = [tenantId];
    let i = 2;

    if (storeId) { conds.push(`po.store_id=$${i++}`); vals.push(storeId); }
    if (status)  { conds.push(`po.status=$${i++}`);   vals.push(status);  }

    const rows = await query<any>(
      `SELECT po.*, s.name AS supplier_name, s.email AS supplier_email, s.phone AS supplier_phone,
              st.name AS store_name,
              (SELECT COUNT(*) FROM purchase_order_items WHERE po_id=po.id)::int AS item_count
       FROM purchase_orders po
       LEFT JOIN suppliers s  ON s.id  = po.supplier_id
       LEFT JOIN stores    st ON st.id = po.store_id
       WHERE ${conds.join(' AND ')}
       ORDER BY po.created_at DESC`,
      vals
    );
    ok(res, rows);
  } catch (e: any) { fail(res, e.message); }
});

// ── GET single ───────────────────────────────────────────────

router.get('/:id', async (req, res) => {
  try {
    const tenantId = (req as any).user.tenantId;
    const po = await queryOne<any>(
      `SELECT po.*, s.name AS supplier_name, s.email AS supplier_email, s.phone AS supplier_phone,
              st.name AS store_name
       FROM purchase_orders po
       LEFT JOIN suppliers s  ON s.id  = po.supplier_id
       LEFT JOIN stores    st ON st.id = po.store_id
       WHERE po.id=$1 AND po.tenant_id=$2`,
      [(req.params.id as string), tenantId]
    );
    if (!po) return fail(res, 'Purchase order not found', 404);
    po.items = await getPOItems((req.params.id as string));
    ok(res, po);
  } catch (e: any) { fail(res, e.message); }
});

// ── POST create ──────────────────────────────────────────────

router.post('/', requireMinRole('manager'), async (req, res) => {
  try {
    const tenantId = (req as any).user.tenantId;
    const userId   = (req as any).user.sub;
    const b = req.body;

    if (!b.storeId)    return fail(res, 'storeId is required');
    if (!b.supplierId) return fail(res, 'supplierId is required');

    const [{ count }] = await query<any>(`SELECT COUNT(*) FROM purchase_orders WHERE tenant_id=$1`, [tenantId]);
    const num = `PO/${new Date().getFullYear()}/${String(parseInt(count) + 1).padStart(4, '0')}`;

    const [po] = await query<any>(
      `INSERT INTO purchase_orders
         (store_id, tenant_id, supplier_id, order_number, status,
          subtotal, gst_amount, total_amount, order_date, expected_delivery, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        b.storeId, tenantId, b.supplierId, num, b.status || 'draft',
        0, 0, 0,
        b.orderDate ? new Date(b.orderDate) : new Date(),
        b.expectedDelivery || null,
        b.notes || null,
        userId,
      ]
    );

    // Save line items if provided
    if (Array.isArray(b.items) && b.items.length > 0) {
      for (const item of b.items) {
        await query(
          `INSERT INTO purchase_order_items
             (po_id, item_id, item_name, sku, quantity, unit_price, gst_rate, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            po.id,
            item.itemId || null,
            item.itemName || item.name || 'Item',
            item.sku || null,
            parseFloat(item.quantity) || 1,
            parseFloat(item.unitPrice) || 0,
            parseFloat(item.gstRate) || 0,
            item.notes || null,
          ]
        );
      }
      await recalcTotals(po.id);
    }

    po.items = await getPOItems(po.id);
    ok(res, po, 201);
  } catch (e: any) { fail(res, e.message); }
});

// ── PUT update ───────────────────────────────────────────────

router.put('/:id', requireMinRole('manager'), async (req, res) => {
  try {
    const tenantId = (req as any).user.tenantId;
    const b = req.body;

    const [po] = await query<any>(
      `UPDATE purchase_orders SET
         supplier_id       = COALESCE($1, supplier_id),
         status            = COALESCE($2, status),
         expected_delivery = COALESCE($3, expected_delivery),
         notes             = COALESCE($4, notes),
         updated_at        = NOW()
       WHERE id=$5 AND tenant_id=$6
       RETURNING *`,
      [
        b.supplierId || null,
        b.status     || null,
        b.expectedDelivery || null,
        b.notes != null ? b.notes : null,
        (req.params.id as string),
        tenantId,
      ]
    );
    if (!po) return fail(res, 'Purchase order not found', 404);
    po.items = await getPOItems((req.params.id as string));
    ok(res, po);
  } catch (e: any) { fail(res, e.message); }
});

// ── POST add item to PO ───────────────────────────────────────

router.post('/:id/items', requireMinRole('manager'), async (req, res) => {
  try {
    const tenantId = (req as any).user.tenantId;
    const b = req.body;

    const po = await queryOne<any>(`SELECT id, status FROM purchase_orders WHERE id=$1 AND tenant_id=$2`, [(req.params.id as string), tenantId]);
    if (!po) return fail(res, 'Purchase order not found', 404);
    if (!['draft', 'sent'].includes(po.status)) return fail(res, 'Cannot modify a confirmed or delivered order', 400);

    const [item] = await query<any>(
      `INSERT INTO purchase_order_items
         (po_id, item_id, item_name, sku, quantity, unit_price, gst_rate, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        (req.params.id as string),
        b.itemId || null,
        b.itemName || b.name || 'Item',
        b.sku || null,
        parseFloat(b.quantity) || 1,
        parseFloat(b.unitPrice) || 0,
        parseFloat(b.gstRate) || 0,
        b.notes || null,
      ]
    );
    await recalcTotals((req.params.id as string));
    ok(res, item, 201);
  } catch (e: any) { fail(res, e.message); }
});

// ── PUT update PO item ───────────────────────────────────────

router.put('/:id/items/:itemId', requireMinRole('manager'), async (req, res) => {
  try {
    const tenantId = (req as any).user.tenantId;
    const b = req.body;

    const po = await queryOne<any>(`SELECT id FROM purchase_orders WHERE id=$1 AND tenant_id=$2`, [(req.params.id as string), tenantId]);
    if (!po) return fail(res, 'Purchase order not found', 404);

    const [item] = await query<any>(
      `UPDATE purchase_order_items SET
         item_name  = COALESCE($1, item_name),
         sku        = COALESCE($2, sku),
         quantity   = COALESCE($3, quantity),
         unit_price = COALESCE($4, unit_price),
         gst_rate   = COALESCE($5, gst_rate),
         notes      = COALESCE($6, notes)
       WHERE id=$7 AND po_id=$8
       RETURNING *`,
      [
        b.itemName   || null,
        b.sku        || null,
        b.quantity   != null ? parseFloat(b.quantity)   : null,
        b.unitPrice  != null ? parseFloat(b.unitPrice)  : null,
        b.gstRate    != null ? parseFloat(b.gstRate)    : null,
        b.notes      != null ? b.notes                   : null,
        (req.params.itemId as string),
        (req.params.id as string),
      ]
    );
    if (!item) return fail(res, 'Item not found', 404);
    await recalcTotals((req.params.id as string));
    ok(res, item);
  } catch (e: any) { fail(res, e.message); }
});

// ── DELETE PO item ───────────────────────────────────────────

router.delete('/:id/items/:itemId', requireMinRole('manager'), async (req, res) => {
  try {
    const tenantId = (req as any).user.tenantId;
    const po = await queryOne<any>(`SELECT id, status FROM purchase_orders WHERE id=$1 AND tenant_id=$2`, [(req.params.id as string), tenantId]);
    if (!po) return fail(res, 'Purchase order not found', 404);
    if (!['draft', 'sent'].includes(po.status)) return fail(res, 'Cannot modify this order', 400);

    await query(`DELETE FROM purchase_order_items WHERE id=$1 AND po_id=$2`, [(req.params.itemId as string), (req.params.id as string)]);
    await recalcTotals((req.params.id as string));
    ok(res, { message: 'Item removed' });
  } catch (e: any) { fail(res, e.message); }
});

// ── DELETE purchase order ─────────────────────────────────────

router.delete('/:id', requireMinRole('manager'), async (req, res) => {
  try {
    const tenantId = (req as any).user.tenantId;
    const po = await queryOne<any>(`SELECT status FROM purchase_orders WHERE id=$1 AND tenant_id=$2`, [(req.params.id as string), tenantId]);
    if (!po) return fail(res, 'Purchase order not found', 404);
    if (po.status !== 'draft') return fail(res, 'Only draft orders can be deleted', 400);

    await query(`DELETE FROM purchase_orders WHERE id=$1 AND tenant_id=$2`, [(req.params.id as string), tenantId]);
    ok(res, { message: 'Purchase order deleted' });
  } catch (e: any) { fail(res, e.message); }
});

export const purchaseOrdersRouter = router;
