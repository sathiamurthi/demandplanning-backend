// ============================================================
// SALES MODULE — Individual + Bulk, Full CQRS
// ============================================================
import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../../config/db';
import { commandBus, ICommand, ICommandHandler } from '../../cqrs/commandBus';
import { queryBus, IQuery, IQueryHandler } from '../../cqrs/queryBus';
import { authMiddleware } from '../auth/auth.service';
import { requireMinRole, requireRole } from '../../core/guards/roleGuard';
import { SaleItemInput, SaleType } from '../../types';

function ok(res: any, data: any, status = 200) {
  res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
}
function fail(res: any, msg: string, status = 400) {
  res.status(status).json({ success: false, error: msg, timestamp: new Date().toISOString() });
}

async function generateSaleNumber(storeId: string, type: SaleType): Promise<string> {
  const typePrefix = type === 'bulk' ? 'B' : 'S';
  const store = await queryOne<any>('SELECT code, name FROM stores WHERE id=$1', [storeId]);
  const storeCode = store?.code
    ? store.code.toUpperCase()
    : (store?.name || 'STR').replace(/\s+/g, '').substring(0, 4).toUpperCase();
  const [{ count }] = await query<any>('SELECT COUNT(*)::int+1 as count FROM sales WHERE store_id=$1', [storeId]);
  const year = new Date().getFullYear();
  return `${storeCode}-${typePrefix}${year}-${String(count).padStart(4, '0')}`;
}

// ── Commands ─────────────────────────────────────────────────

interface CreateSaleCommand extends ICommand {
  readonly type: 'sale.create';
  storeId: string; tenantId: string;
  saleType: SaleType; saleDate?: string;
  customerName?: string; customerPhone?: string; customerEmail?: string;
  paymentMethod?: string; discountAmount?: number; notes?: string;
  items: SaleItemInput[]; createdBy: string;
}

class CreateSaleCommandHandler implements ICommandHandler<CreateSaleCommand> {
  async execute(cmd: CreateSaleCommand) {
    if (!cmd.items.length) throw new Error('Sale must have at least one item');

    return withTransaction(async (client) => {
      // 1. Validate all items exist and have sufficient stock
      const stockUpdates: Array<{ itemId: string; newStock: number; name: string }> = [];
      let subtotal = 0;
      let totalGst = 0;

      for (const si of cmd.items) {
        const item = await client.query('SELECT * FROM items WHERE id=$1 AND store_id=$2 AND is_active=TRUE',[si.itemId,cmd.storeId]).then(r=>r.rows[0]);
        if (!item) throw new Error(`Item ${si.itemId} not found`);
        if (parseFloat(item.current_stock) < si.qtySold) throw new Error(`Insufficient stock for "${item.name}": available ${item.current_stock}`);
        const discount = (si.unitPrice * si.qtySold * (si.discountPct||0)) / 100;
        const lineSubtotal = si.unitPrice * si.qtySold - discount;
        const gstRate = (si as any).gstRate ?? parseFloat(item.gst_rate) ?? 0;        const lineGst = (lineSubtotal * gstRate) / 100;
        subtotal += lineSubtotal;
        totalGst += lineGst;
        stockUpdates.push({ itemId: si.itemId, newStock: parseFloat(item.current_stock) - si.qtySold, name: item.name });
      }

      const extraDiscount = cmd.discountAmount || 0;
      const total = subtotal + totalGst - extraDiscount;
      const saleNumber = await generateSaleNumber(cmd.storeId, cmd.saleType);

      // 2. Create sale record
      const [sale] = await client.query(
        `INSERT INTO sales (store_id,tenant_id,sale_number,sale_type,sale_date,customer_name,customer_phone,customer_email,subtotal,discount_amount,gst_amount,total_amount,payment_method,notes,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [cmd.storeId,cmd.tenantId,saleNumber,cmd.saleType,cmd.saleDate||new Date().toISOString(),
         cmd.customerName||null,cmd.customerPhone||null,cmd.customerEmail||null,
         subtotal,extraDiscount,totalGst,total,cmd.paymentMethod||null,cmd.notes||null,cmd.createdBy]
      ).then(r=>r.rows);

      // 3. Create line items + stock ledger entries
      const lineItems = [];
      for (const si of cmd.items) {
        const item = await client.query('SELECT * FROM items WHERE id=$1',[si.itemId]).then(r=>r.rows[0]);
        const discount = (si.unitPrice * si.qtySold * (si.discountPct||0)) / 100;
        const lineSubtotal = si.unitPrice * si.qtySold - discount;
        const gstRate = (si as any).gstRate ?? parseFloat(item.gst_rate) ?? 0;        const lineGst = (lineSubtotal * gstRate) / 100;
        const lineTotal = lineSubtotal + lineGst;
        const unitId = si.unitId || item.primary_unit_id;

        const [li] = await client.query(
          `INSERT INTO sale_items (sale_id,item_id,qty_sold,unit_id,unit_price,discount_pct,discount_amount,gst_rate,gst_amount,line_total,batch_number,expiry_date)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [sale.id,si.itemId,si.qtySold,unitId,si.unitPrice,si.discountPct||0,discount,gstRate,lineGst,lineTotal,si.batchNumber||null,si.expiryDate||null]
        ).then(r=>r.rows);
        lineItems.push(li);

        // Stock ledger
        const su = stockUpdates.find(s=>s.itemId===si.itemId)!;
        await client.query(
          `INSERT INTO stock_ledger (item_id,store_id,tenant_id,movement_type,reference_id,reference_type,qty_before,qty_change,qty_after,unit_id,unit_price,created_by)
           VALUES ($1,$2,$3,'sale',$4,'sale',$5,$6,$7,$8,$9,$10)`,
          [si.itemId,cmd.storeId,cmd.tenantId,sale.id,
           parseFloat(item.current_stock),-(si.qtySold),su.newStock,unitId,si.unitPrice,cmd.createdBy]
        );
        // Update stock
        await client.query('UPDATE items SET current_stock=$1, updated_at=NOW() WHERE id=$2',[su.newStock,si.itemId]);
        // Low stock alert
        const item2 = await client.query('SELECT * FROM items WHERE id=$1',[si.itemId]).then(r=>r.rows[0]);
        if (su.newStock <= parseFloat(item2.reorder_level)) {
          await client.query(
            `INSERT INTO ai_alerts (store_id,tenant_id,item_id,alert_type,message,severity)
             VALUES ($1,$2,$3,'low_stock',$4,'critical')
             ON CONFLICT DO NOTHING`,
            [cmd.storeId,cmd.tenantId,si.itemId,
             `Low stock: "${item2.name}" — ${su.newStock} ${item2.unit||''} remaining (reorder: ${item2.reorder_level})`]
          );
        }
      }

      // Update monthly_usage_avg
      await Promise.all(cmd.items.map(si =>
        client.query(
          `UPDATE items SET monthly_usage_avg = (
             SELECT COALESCE(SUM(sli.qty_sold),0) / GREATEST(1, DATE_PART('month', AGE(NOW(), MIN(sl2.created_at))))
             FROM sale_items sli JOIN sales sl2 ON sl2.id=sli.sale_id
             WHERE sli.item_id=$1 AND sl2.store_id=$2 AND sl2.sale_date >= NOW() - INTERVAL '3 months'
           ) WHERE id=$1`,
          [si.itemId, cmd.storeId]
        )
      ));

      return { sale, lineItems, stockUpdates };
    });
  }
}

interface CreateBulkSaleCommand extends ICommand {
  readonly type: 'sale.createBulk';
  storeId: string; tenantId: string;
  buyerName: string; buyerGst?: string; batchRef?: string;
  paymentMethod?: string; notes?: string;
  sales: Array<{
    customerName?: string; items: SaleItemInput[];
    discountAmount?: number; notes?: string;
  }>;
  createdBy: string;
}

class CreateBulkSaleCommandHandler implements ICommandHandler<CreateBulkSaleCommand> {
  async execute(cmd: CreateBulkSaleCommand) {
    const saleIds: string[] = [];
    let totalItems = 0, totalQty = 0, totalAmount = 0;

    return withTransaction(async (client) => {
      for (const s of cmd.sales) {
        const saleResult = await commandBus.execute<any>({
          type: 'sale.create',
          storeId: cmd.storeId, tenantId: cmd.tenantId,
          saleType: 'bulk', customerName: s.customerName||cmd.buyerName,
          paymentMethod: cmd.paymentMethod, notes: s.notes,
          items: s.items, discountAmount: s.discountAmount,
          createdBy: cmd.createdBy,
        });
        saleIds.push(saleResult.sale.id);
        totalItems += s.items.length;
        totalQty += s.items.reduce((sum,i)=>sum+i.qtySold,0);
        totalAmount += parseFloat(saleResult.sale.total_amount);
      }

      const [batch] = await client.query(
        `INSERT INTO bulk_sale_batches (store_id,tenant_id,batch_ref,buyer_name,buyer_gst,sale_ids,total_items,total_qty,total_amount,notes,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [cmd.storeId,cmd.tenantId,cmd.batchRef||null,cmd.buyerName,cmd.buyerGst||null,
         saleIds,totalItems,totalQty,totalAmount,cmd.notes||null,cmd.createdBy]
      ).then(r=>r.rows);

      return { batchId: batch.id, saleIds, totalItems, totalQty, totalAmount };
    });
  }
}

interface VoidSaleCommand extends ICommand {
  readonly type: 'sale.void';
  saleId: string; storeId: string; tenantId: string; reason: string; createdBy: string;
}
class VoidSaleCommandHandler implements ICommandHandler<VoidSaleCommand> {
  async execute(cmd: VoidSaleCommand) {
    const sale = await queryOne<any>('SELECT * FROM sales WHERE id=$1 AND store_id=$2',[cmd.saleId,cmd.storeId]);
    if (!sale) throw new Error('Sale not found');
    return withTransaction(async (client) => {
      // Reverse stock
      const lineItems = await client.query('SELECT * FROM sale_items WHERE sale_id=$1',[cmd.saleId]).then(r=>r.rows);
      for (const li of lineItems) {
        const item = await client.query('SELECT * FROM items WHERE id=$1',[li.item_id]).then(r=>r.rows[0]);
        const newStock = parseFloat(item.current_stock) + parseFloat(li.qty_sold);
        await client.query('UPDATE items SET current_stock=$1, updated_at=NOW() WHERE id=$2',[newStock,li.item_id]);
        await client.query(
          `INSERT INTO stock_ledger (item_id,store_id,tenant_id,movement_type,reference_id,reference_type,qty_before,qty_change,qty_after,notes,created_by)
           VALUES ($1,$2,$3,'return',$4,'sale_void',$5,$6,$7,$8,$9)`,
          [li.item_id,cmd.storeId,cmd.tenantId,cmd.saleId,parseFloat(item.current_stock),parseFloat(li.qty_sold),newStock,cmd.reason,cmd.createdBy]
        );
      }
      // Mark as return type
      await client.query(`UPDATE sales SET sale_type='return', notes=$1||' | Voided: '||$2, updated_at=NOW() WHERE id=$3`,[sale.notes||'',cmd.reason,cmd.saleId]);
      return { message: 'Sale voided and stock reversed', saleId: cmd.saleId };
    });
  }
}

// ── Queries ──────────────────────────────────────────────────

interface ListSalesQuery extends IQuery {
  readonly type: 'sale.list';
  storeId: string; tenantId: string; saleType?: SaleType;
  from?: string; to?: string; customerId?: string;
  page: number; limit: number;
}
class ListSalesQueryHandler implements IQueryHandler<ListSalesQuery, any> {
  async execute(q: ListSalesQuery) {
    const conds = ['s.store_id=$1','s.tenant_id=$2'];
    const vals: any[] = [q.storeId,q.tenantId]; let i = 3;
    if (q.saleType) { conds.push(`s.sale_type=$${i++}`); vals.push(q.saleType); }
    if (q.from)     { conds.push(`s.sale_date >= $${i++}`); vals.push(q.from); }
    if (q.to)       { conds.push(`s.sale_date <= $${i++}`); vals.push(q.to); }
    const where = `WHERE ${conds.join(' AND ')}`;
    const [{ count }] = await query<any>(`SELECT COUNT(*) FROM sales s ${where}`, vals);
    const offset = (q.page-1)*q.limit;
    vals.push(q.limit, offset);
    const items = await query<any>(
      `SELECT s.*,
              COUNT(si.id)::int as item_count,
              u.first_name||' '||u.last_name as created_by_name
       FROM sales s
       LEFT JOIN sale_items si ON si.sale_id=s.id
       LEFT JOIN users u ON u.id=s.created_by
       ${where} GROUP BY s.id, u.first_name, u.last_name
       ORDER BY s.sale_date DESC LIMIT $${i} OFFSET $${i+1}`, vals
    );
    return { items, total: parseInt(count), page: q.page, limit: q.limit };
  }
}

interface GetSaleQuery extends IQuery {
  readonly type: 'sale.get';
  saleId: string; storeId: string;
}
class GetSaleQueryHandler implements IQueryHandler<GetSaleQuery, any> {
  async execute(q: GetSaleQuery) {
    const sale = await queryOne<any>('SELECT * FROM sales WHERE id=$1 AND store_id=$2',[q.saleId,q.storeId]);
    if (!sale) throw new Error('Sale not found');
    const lineItems = await query<any>(
      `SELECT si.*, i.name as item_name, i.sku, ut.symbol as unit_symbol
       FROM sale_items si JOIN items i ON i.id=si.item_id LEFT JOIN unit_types ut ON ut.id=si.unit_id
       WHERE si.sale_id=$1`, [q.saleId]
    );
    return { ...sale, lineItems };
  }
}

interface SalesSummaryQuery extends IQuery {
  readonly type: 'sale.summary';
  storeId: string; tenantId: string; from: string; to: string; groupBy: 'day'|'week'|'month';
}
class SalesSummaryQueryHandler implements IQueryHandler<SalesSummaryQuery, any> {
  async execute(q: SalesSummaryQuery) {
    const fmt = q.groupBy === 'day' ? 'YYYY-MM-DD' : q.groupBy === 'week' ? 'IYYY-IW' : 'YYYY-MM';
    const summary = await query<any>(
      `SELECT TO_CHAR(s.sale_date, '${fmt}') as period,
              COUNT(s.id)::int as sale_count,
              SUM(s.total_amount) as total_revenue,
              SUM(s.gst_amount) as total_gst,
              SUM(s.discount_amount) as total_discount,
              AVG(s.total_amount) as avg_sale_value,
              COUNT(s.id) FILTER (WHERE s.sale_type='individual')::int as individual_count,
              COUNT(s.id) FILTER (WHERE s.sale_type='bulk')::int as bulk_count
       FROM sales s
       WHERE s.store_id=$1 AND s.tenant_id=$2 AND s.sale_date BETWEEN $3 AND $4
       GROUP BY period ORDER BY period`,
      [q.storeId,q.tenantId,q.from,q.to]
    );
    const totals = await queryOne<any>(
      `SELECT SUM(total_amount) as revenue, COUNT(id)::int as transactions, SUM(gst_amount) as gst
       FROM sales WHERE store_id=$1 AND tenant_id=$2 AND sale_date BETWEEN $3 AND $4`,
      [q.storeId,q.tenantId,q.from,q.to]
    );
    const topItems = await query<any>(
      `SELECT i.id, i.name, SUM(si.qty_sold) as qty_sold, SUM(si.line_total) as revenue
       FROM sale_items si JOIN items i ON i.id=si.item_id JOIN sales s ON s.id=si.sale_id
       WHERE s.store_id=$1 AND s.sale_date BETWEEN $2 AND $3
       GROUP BY i.id, i.name ORDER BY revenue DESC LIMIT 10`,
      [q.storeId,q.from,q.to]
    );
    return { summary, totals, topItems };
  }
}

// Register
commandBus.register('sale.create',     new CreateSaleCommandHandler());
commandBus.register('sale.createBulk', new CreateBulkSaleCommandHandler());
commandBus.register('sale.void',       new VoidSaleCommandHandler());
queryBus.register('sale.list',         new ListSalesQueryHandler());
queryBus.register('sale.get',          new GetSaleQueryHandler());
queryBus.register('sale.summary',      new SalesSummaryQueryHandler());

// ── Router ───────────────────────────────────────────────────
export const salesRouter = Router({ mergeParams: true });
//salesRouter.use(authMiddleware);

const SaleItemSchema = z.object({
  itemId: z.string().uuid(), qtySold: z.number().positive(),
  unitId: z.string().uuid().optional().nullable(), unitPrice: z.number().positive(),
  discountPct: z.number().min(0).max(100).optional(),
  batchNumber: z.string().optional(), expiryDate: z.string().optional(),
  gstRate: z.number().optional(),
});
const CreateSaleSchema = z.object({
  saleType: z.enum(['individual','bulk','return','adjustment']).optional(),
  saleDate: z.string().optional(), customerName: z.string().optional(),
  customerPhone: z.string().optional(), customerEmail: z.string().email().optional(),
  paymentMethod: z.string().optional(), discountAmount: z.number().optional(),
  notes: z.string().optional(), items: z.array(SaleItemSchema).min(1),
});

salesRouter.get('/', async (req, res) => {
  try {
    const user = (req as any).user;
    const storeId = (req.params as any).storeId;
const r = await queryBus.execute({
  type: 'sale.list',
  storeId: storeId,
  tenantId: user.tenantId,
  saleType: req.query.saleType as SaleType,
  from: req.query.from as string,
  to: req.query.to as string,
  page: parseInt(req.query.page as string) || 1,
  limit: parseInt(req.query.limit as string) || 50,
} as ListSalesQuery);

ok(res, r);
  } catch (e: any) { fail(res, e.message); }
});

salesRouter.get('/summary', async (req, res) => {
  try {
    const from = (req.query.from as string) || new Date(Date.now()-30*86400000).toISOString();
    const to = (req.query.to as string) || new Date().toISOString();
    const storeId = (req.params as any).storeId;
    const r = await queryBus.execute<any>({
      type: 'sale.summary', storeId: storeId, tenantId: (req as any).user.tenantId,
      from, to, groupBy: (req.query.groupBy as any)||'day',
    });
    ok(res, r);
  } catch (e: any) { fail(res, e.message); }
});

salesRouter.get('/export', requireMinRole('manager'), async (req, res) => {
  try {
    const from = (req.query.from as string) || new Date(Date.now()-30*86400000).toISOString();
    const to = (req.query.to as string) || new Date().toISOString();
    const rows = await query<any>(
      `SELECT s.sale_number, s.sale_date, s.sale_type, s.customer_name, s.customer_phone,
              s.subtotal, s.discount_amount, s.gst_amount, s.total_amount, s.payment_method,
              COUNT(si.id)::int as items
       FROM sales s LEFT JOIN sale_items si ON si.sale_id=s.id
       WHERE s.store_id=$1 AND s.sale_date BETWEEN $2 AND $3
       GROUP BY s.id ORDER BY s.sale_date DESC`,
      [req.params.storeId, from, to]
    );
    if (req.query.format === 'csv') {
      const headers = Object.keys(rows[0]||{}).join(',');
      const csv = [headers, ...rows.map(r=>Object.values(r).join(','))].join('\n');
      res.setHeader('Content-Type','text/csv');
      res.setHeader('Content-Disposition',`attachment; filename=sales-${Date.now()}.csv`);
      res.send(csv);
    } else {
      ok(res, rows);
    }
  } catch (e: any) { fail(res, e.message); }
});

salesRouter.get('/:saleId', async (req, res) => {
  try {
    const storeId = (req.params as any).storeId;
    const r = await queryBus.execute<any>({ type: 'sale.get', saleId: req.params.saleId, storeId: storeId });
    ok(res, r);
  } catch (e: any) { fail(res, e.message, 404); }
});

salesRouter.post('/', requireMinRole('staff'), async (req, res) => {
  try {
    const body = CreateSaleSchema.parse(req.body);
    const user = (req as any).user;
    const r = await commandBus.execute({
      type: 'sale.create',
      storeId: req.params.storeId,
      tenantId: user.tenantId,
      createdBy: user.sub,
      saleType: body.saleType || 'individual',   // ← always provide a value
      ...body,
    } as CreateSaleCommand);
    ok(res, r, 201);
  } catch (e: any) { fail(res, e.message); }
});

salesRouter.post('/bulk', requireMinRole('manager'), async (req, res) => {
  try {
    const r = await commandBus.execute<any>({
      type: 'sale.createBulk', storeId: req.params.storeId,
      tenantId: (req as any).user.tenantId, createdBy: (req as any).user.sub, ...req.body
    });
    ok(res, r, 201);
  } catch (e: any) { fail(res, e.message); }
});

salesRouter.delete('/:saleId', requireRole('owner'), async (req, res) => {
  try {
    const r = await commandBus.execute({
      type: 'sale.void',
      saleId: req.params.saleId,
      storeId: req.params.storeId,
      tenantId: (req as any).user.tenantId,
      reason: req.body.reason || 'Manual void',
      createdBy: (req as any).user.sub,
    } as VoidSaleCommand);
    ok(res, r);
  } catch (e: any) { fail(res, e.message); }
});