"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.salesRouter = void 0;
// ============================================================
// SALES MODULE — Individual + Bulk, Full CQRS
// ============================================================
const express_1 = require("express");
const zod_1 = require("zod");
const db_1 = require("../../config/db");
const commandBus_1 = require("../../cqrs/commandBus");
const queryBus_1 = require("../../cqrs/queryBus");
const roleGuard_1 = require("../../core/guards/roleGuard");
function ok(res, data, status = 200) {
    res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
}
function fail(res, msg, status = 400) {
    res.status(status).json({ success: false, error: msg, timestamp: new Date().toISOString() });
}
async function generateSaleNumber(storeId, type) {
    const typePrefix = type === 'bulk' ? 'B' : 'S';
    const store = await (0, db_1.queryOne)('SELECT code, name FROM stores WHERE id=$1', [storeId]);
    const storeCode = store?.code
        ? store.code.toUpperCase()
        : (store?.name || 'STR').replace(/\s+/g, '').substring(0, 4).toUpperCase();
    const [{ count }] = await (0, db_1.query)('SELECT COUNT(*)::int+1 as count FROM sales WHERE store_id=$1', [storeId]);
    const year = new Date().getFullYear();
    return `${storeCode}-${typePrefix}${year}-${String(count).padStart(4, '0')}`;
}
class CreateSaleCommandHandler {
    async execute(cmd) {
        if (!cmd.items.length)
            throw new Error('Sale must have at least one item');
        return (0, db_1.withTransaction)(async (client) => {
            // 1. Validate all items exist and have sufficient stock
            const stockUpdates = [];
            let subtotal = 0;
            let totalGst = 0;
            for (const si of cmd.items) {
                const item = await client.query('SELECT * FROM items WHERE id=$1 AND store_id=$2 AND is_active=TRUE', [si.itemId, cmd.storeId]).then(r => r.rows[0]);
                if (!item)
                    throw new Error(`Item ${si.itemId} not found`);
                // Calculate stock deduction based on unit
                let stockDeduction = si.qtySold;
                if (si.unitId === item.secondary_unit_id && item.units_per_secondary && parseFloat(item.units_per_secondary) > 0) {
                    stockDeduction = si.qtySold / parseFloat(item.units_per_secondary);
                }
                if (parseFloat(item.current_stock) < stockDeduction)
                    throw new Error(`Insufficient stock for "${item.name}": available ${item.current_stock}, trying to sell equivalent of ${stockDeduction} primary units`);
                const discount = (si.unitPrice * si.qtySold * (si.discountPct || 0)) / 100;
                // unitPrice is the selling/MRP price, GST-INCLUSIVE (standard Indian
                // retail practice) — so the line's payable amount is fixed at
                // (unitPrice*qty - discount), and GST is a component SPLIT OUT of
                // that amount for compliance reporting, never added on top of it.
                const lineInclusive = si.unitPrice * si.qtySold - discount;
                const gstRate = si.gstRate ?? parseFloat(item.gst_rate) ?? 0;
                const lineGst = (lineInclusive * gstRate) / (100 + gstRate);
                const lineSubtotal = lineInclusive - lineGst;
                subtotal += lineSubtotal;
                totalGst += lineGst;
                stockUpdates.push({ itemId: si.itemId, newStock: parseFloat(item.current_stock) - stockDeduction, stockDeduction, name: item.name });
            }
            const extraDiscount = cmd.discountAmount || 0;
            // subtotal + totalGst reconstructs the same sum of line-inclusive
            // amounts by construction (lineSubtotal + lineGst = lineInclusive),
            // so the customer-facing total is never inflated by GST — only the
            // subtotal/gst_amount split changes, not the amount actually charged.
            const total = subtotal + totalGst - extraDiscount;
            const saleNumber = await generateSaleNumber(cmd.storeId, cmd.saleType);
            // 2. Create sale record
            const [sale] = await client.query(`INSERT INTO sales (store_id,tenant_id,sale_number,sale_type,sale_date,customer_name,customer_phone,customer_email,subtotal,discount_amount,gst_amount,total_amount,payment_method,notes,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`, [cmd.storeId, cmd.tenantId, saleNumber, cmd.saleType, cmd.saleDate || new Date().toISOString(),
                cmd.customerName || null, cmd.customerPhone || null, cmd.customerEmail || null,
                subtotal, extraDiscount, totalGst, total, cmd.paymentMethod || null, cmd.notes || null, cmd.createdBy]).then(r => r.rows);
            // 3. Create line items + stock ledger entries
            const lineItems = [];
            for (const si of cmd.items) {
                const item = await client.query('SELECT * FROM items WHERE id=$1', [si.itemId]).then(r => r.rows[0]);
                const discount = (si.unitPrice * si.qtySold * (si.discountPct || 0)) / 100;
                const lineInclusive = si.unitPrice * si.qtySold - discount;
                const gstRate = si.gstRate ?? parseFloat(item.gst_rate) ?? 0;
                const lineGst = (lineInclusive * gstRate) / (100 + gstRate);
                const lineSubtotal = lineInclusive - lineGst;
                const lineTotal = lineInclusive;
                const unitId = si.unitId || item.primary_unit_id;
                const [li] = await client.query(`INSERT INTO sale_items (sale_id,item_id,qty_sold,unit_id,unit_price,discount_pct,discount_amount,gst_rate,gst_amount,line_total,batch_number,expiry_date)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [sale.id, si.itemId, si.qtySold, unitId, si.unitPrice, si.discountPct || 0, discount, gstRate, lineGst, lineTotal, si.batchNumber || null, si.expiryDate || null]).then(r => r.rows);
                lineItems.push(li);
                // Stock ledger
                const su = stockUpdates.find(s => s.itemId === si.itemId);
                await client.query(`INSERT INTO stock_ledger (item_id,store_id,tenant_id,movement_type,reference_id,reference_type,qty_before,qty_change,qty_after,unit_id,unit_price,created_by)
           VALUES ($1,$2,$3,'sale',$4,'sale',$5,$6,$7,$8,$9,$10)`, [si.itemId, cmd.storeId, cmd.tenantId, sale.id,
                    parseFloat(item.current_stock), -(su.stockDeduction), su.newStock, item.primary_unit_id, si.unitPrice, cmd.createdBy]);
                // Update stock
                await client.query('UPDATE items SET current_stock=$1, updated_at=NOW() WHERE id=$2', [su.newStock, si.itemId]);
                // Low stock alert
                const item2 = await client.query('SELECT * FROM items WHERE id=$1', [si.itemId]).then(r => r.rows[0]);
                if (su.newStock <= parseFloat(item2.reorder_level)) {
                    await client.query(`INSERT INTO ai_alerts (store_id,tenant_id,item_id,alert_type,message,severity)
             VALUES ($1,$2,$3,'low_stock',$4,'critical')
             ON CONFLICT DO NOTHING`, [cmd.storeId, cmd.tenantId, si.itemId,
                        `Low stock: "${item2.name}" — ${su.newStock} ${item2.unit || ''} remaining (reorder: ${item2.reorder_level})`]);
                }
            }
            // Update monthly_usage_avg
            await Promise.all(cmd.items.map(si => client.query(`UPDATE items SET monthly_usage_avg = (
             SELECT COALESCE(SUM(sli.qty_sold),0) / GREATEST(1, DATE_PART('month', AGE(NOW(), MIN(sl2.created_at))))
             FROM sale_items sli JOIN sales sl2 ON sl2.id=sli.sale_id
             WHERE sli.item_id=$1 AND sl2.store_id=$2 AND sl2.sale_date >= NOW() - INTERVAL '3 months'
           ) WHERE id=$1`, [si.itemId, cmd.storeId])));
            // Post to Accounting Journal if Phase 1 COA is seeded
            try {
                const revAcc = await client.query("SELECT id FROM chart_of_accounts WHERE tenant_id=$1 AND store_id=$2 AND name='Sales Revenue' LIMIT 1", [cmd.tenantId, cmd.storeId]);
                const cashAcc = await client.query("SELECT id FROM chart_of_accounts WHERE tenant_id=$1 AND store_id=$2 AND name='Cash' LIMIT 1", [cmd.tenantId, cmd.storeId]);
                if (revAcc.rows.length && cashAcc.rows.length) {
                    const { postJournalEntry } = require('./accounting.service');
                    await postJournalEntry(client, {
                        tenantId: cmd.tenantId,
                        storeId: cmd.storeId,
                        userId: cmd.createdBy,
                        voucher_no: `SV-${sale.sale_number}`,
                        voucher_type: 'Sales',
                        entry_date: new Date(sale.sale_date).toISOString().split('T')[0],
                        narrative: `POS Sale ${sale.sale_number}`,
                        lines: [
                            { account_id: cashAcc.rows[0].id, debit: total, credit: 0, narrative: `Cash collected for Sale ${sale.sale_number}` },
                            { account_id: revAcc.rows[0].id, debit: 0, credit: total, narrative: `Revenue for Sale ${sale.sale_number}` }
                        ]
                    });
                }
            }
            catch (err) {
                // Log but don't fail sale if accounting fails during Phase 1 rollout
                console.error('Failed to post journal entry for sale', err);
            }
            return { sale, lineItems, stockUpdates };
        });
    }
}
class CreateBulkSaleCommandHandler {
    async execute(cmd) {
        const saleIds = [];
        let totalItems = 0, totalQty = 0, totalAmount = 0;
        return (0, db_1.withTransaction)(async (client) => {
            for (const s of cmd.sales) {
                const saleResult = await commandBus_1.commandBus.execute({
                    type: 'sale.create',
                    storeId: cmd.storeId, tenantId: cmd.tenantId,
                    saleType: 'bulk', customerName: s.customerName || cmd.buyerName,
                    paymentMethod: cmd.paymentMethod, notes: s.notes,
                    items: s.items, discountAmount: s.discountAmount,
                    createdBy: cmd.createdBy,
                });
                saleIds.push(saleResult.sale.id);
                totalItems += s.items.length;
                totalQty += s.items.reduce((sum, i) => sum + i.qtySold, 0);
                totalAmount += parseFloat(saleResult.sale.total_amount);
            }
            const [batch] = await client.query(`INSERT INTO bulk_sale_batches (store_id,tenant_id,batch_ref,buyer_name,buyer_gst,sale_ids,total_items,total_qty,total_amount,notes,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [cmd.storeId, cmd.tenantId, cmd.batchRef || null, cmd.buyerName, cmd.buyerGst || null,
                saleIds, totalItems, totalQty, totalAmount, cmd.notes || null, cmd.createdBy]).then(r => r.rows);
            return { batchId: batch.id, saleIds, totalItems, totalQty, totalAmount };
        });
    }
}
class VoidSaleCommandHandler {
    async execute(cmd) {
        const sale = await (0, db_1.queryOne)('SELECT * FROM sales WHERE id=$1 AND store_id=$2', [cmd.saleId, cmd.storeId]);
        if (!sale)
            throw new Error('Sale not found');
        return (0, db_1.withTransaction)(async (client) => {
            // Reverse stock
            const lineItems = await client.query('SELECT * FROM sale_items WHERE sale_id=$1', [cmd.saleId]).then(r => r.rows);
            for (const li of lineItems) {
                const item = await client.query('SELECT * FROM items WHERE id=$1', [li.item_id]).then(r => r.rows[0]);
                const newStock = parseFloat(item.current_stock) + parseFloat(li.qty_sold);
                await client.query('UPDATE items SET current_stock=$1, updated_at=NOW() WHERE id=$2', [newStock, li.item_id]);
                await client.query(`INSERT INTO stock_ledger (item_id,store_id,tenant_id,movement_type,reference_id,reference_type,qty_before,qty_change,qty_after,notes,created_by)
           VALUES ($1,$2,$3,'return',$4,'sale_void',$5,$6,$7,$8,$9)`, [li.item_id, cmd.storeId, cmd.tenantId, cmd.saleId, parseFloat(item.current_stock), parseFloat(li.qty_sold), newStock, cmd.reason, cmd.createdBy]);
            }
            // Mark as return type
            await client.query(`UPDATE sales SET sale_type='return', notes=$1||' | Voided: '||$2, updated_at=NOW() WHERE id=$3`, [sale.notes || '', cmd.reason, cmd.saleId]);
            return { message: 'Sale voided and stock reversed', saleId: cmd.saleId };
        });
    }
}
class ListSalesQueryHandler {
    async execute(q) {
        const conds = ['s.store_id=$1', 's.tenant_id=$2'];
        const vals = [q.storeId, q.tenantId];
        let i = 3;
        if (q.saleType) {
            conds.push(`s.sale_type=$${i++}`);
            vals.push(q.saleType);
        }
        if (q.from) {
            conds.push(`s.sale_date >= $${i++}`);
            vals.push(q.from);
        }
        if (q.to) {
            conds.push(`s.sale_date <= $${i++}`);
            vals.push(q.to);
        }
        const where = `WHERE ${conds.join(' AND ')}`;
        const [{ count }] = await (0, db_1.query)(`SELECT COUNT(*) FROM sales s ${where}`, vals);
        const offset = (q.page - 1) * q.limit;
        vals.push(q.limit, offset);
        const items = await (0, db_1.query)(`SELECT s.*,
              COUNT(si.id)::int as item_count,
              u.first_name||' '||u.last_name as created_by_name
       FROM sales s
       LEFT JOIN sale_items si ON si.sale_id=s.id
       LEFT JOIN users u ON u.id=s.created_by
       ${where} GROUP BY s.id, u.first_name, u.last_name
       ORDER BY s.sale_date DESC LIMIT $${i} OFFSET $${i + 1}`, vals);
        return { items, total: parseInt(count), page: q.page, limit: q.limit };
    }
}
class GetSaleQueryHandler {
    async execute(q) {
        const sale = await (0, db_1.queryOne)('SELECT * FROM sales WHERE id=$1 AND store_id=$2', [q.saleId, q.storeId]);
        if (!sale)
            throw new Error('Sale not found');
        const lineItems = await (0, db_1.query)(`SELECT si.*, i.name as item_name, i.sku, ut.symbol as unit_symbol
       FROM sale_items si JOIN items i ON i.id=si.item_id LEFT JOIN unit_types ut ON ut.id=si.unit_id
       WHERE si.sale_id=$1`, [q.saleId]);
        return { ...sale, lineItems };
    }
}
class SalesSummaryQueryHandler {
    async execute(q) {
        const fmt = q.groupBy === 'day' ? 'YYYY-MM-DD' : q.groupBy === 'week' ? 'IYYY-IW' : 'YYYY-MM';
        const summary = await (0, db_1.query)(`SELECT TO_CHAR(s.sale_date, '${fmt}') as period,
              COUNT(s.id)::int as sale_count,
              SUM(s.total_amount) as total_revenue,
              SUM(s.gst_amount) as total_gst,
              SUM(s.discount_amount) as total_discount,
              AVG(s.total_amount) as avg_sale_value,
              COUNT(s.id) FILTER (WHERE s.sale_type='individual')::int as individual_count,
              COUNT(s.id) FILTER (WHERE s.sale_type='bulk')::int as bulk_count
       FROM sales s
       WHERE s.store_id=$1 AND s.tenant_id=$2 AND s.sale_date BETWEEN $3 AND $4
       GROUP BY period ORDER BY period`, [q.storeId, q.tenantId, q.from, q.to]);
        const totals = await (0, db_1.queryOne)(`SELECT SUM(total_amount) as revenue, COUNT(id)::int as transactions, SUM(gst_amount) as gst
       FROM sales WHERE store_id=$1 AND tenant_id=$2 AND sale_date BETWEEN $3 AND $4`, [q.storeId, q.tenantId, q.from, q.to]);
        const topItems = await (0, db_1.query)(`SELECT i.id, i.name, SUM(si.qty_sold) as qty_sold, SUM(si.line_total) as revenue
       FROM sale_items si JOIN items i ON i.id=si.item_id JOIN sales s ON s.id=si.sale_id
       WHERE s.store_id=$1 AND s.sale_date BETWEEN $2 AND $3
       GROUP BY i.id, i.name ORDER BY revenue DESC LIMIT 10`, [q.storeId, q.from, q.to]);
        return { summary, totals, topItems };
    }
}
// Register
commandBus_1.commandBus.register('sale.create', new CreateSaleCommandHandler());
commandBus_1.commandBus.register('sale.createBulk', new CreateBulkSaleCommandHandler());
commandBus_1.commandBus.register('sale.void', new VoidSaleCommandHandler());
queryBus_1.queryBus.register('sale.list', new ListSalesQueryHandler());
queryBus_1.queryBus.register('sale.get', new GetSaleQueryHandler());
queryBus_1.queryBus.register('sale.summary', new SalesSummaryQueryHandler());
// ── Router ───────────────────────────────────────────────────
exports.salesRouter = (0, express_1.Router)({ mergeParams: true });
//salesRouter.use(authMiddleware);
const SaleItemSchema = zod_1.z.object({
    itemId: zod_1.z.string().uuid(), qtySold: zod_1.z.number().positive(),
    unitId: zod_1.z.string().uuid().optional().nullable(), unitPrice: zod_1.z.number().positive(),
    discountPct: zod_1.z.number().min(0).max(100).optional(),
    batchNumber: zod_1.z.string().optional(), expiryDate: zod_1.z.string().optional(),
    gstRate: zod_1.z.number().optional(),
});
const CreateSaleSchema = zod_1.z.object({
    saleType: zod_1.z.enum(['individual', 'bulk', 'return', 'adjustment']).optional(),
    saleDate: zod_1.z.string().optional(), customerName: zod_1.z.string().optional(),
    customerPhone: zod_1.z.string().optional(), customerEmail: zod_1.z.string().email().optional(),
    paymentMethod: zod_1.z.string().optional(), discountAmount: zod_1.z.number().optional(),
    notes: zod_1.z.string().optional(), items: zod_1.z.array(SaleItemSchema).min(1),
});
exports.salesRouter.get('/', async (req, res) => {
    try {
        const user = req.user;
        const storeId = req.params.storeId;
        const r = await queryBus_1.queryBus.execute({
            type: 'sale.list',
            storeId: storeId,
            tenantId: user.tenantId,
            saleType: req.query.saleType,
            from: req.query.from,
            to: req.query.to,
            page: parseInt(req.query.page) || 1,
            limit: parseInt(req.query.limit) || 50,
        });
        ok(res, r);
    }
    catch (e) {
        fail(res, e.message);
    }
});
exports.salesRouter.get('/summary', async (req, res) => {
    try {
        const from = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString();
        const to = req.query.to || new Date().toISOString();
        const storeId = req.params.storeId;
        const r = await queryBus_1.queryBus.execute({
            type: 'sale.summary', storeId: storeId, tenantId: req.user.tenantId,
            from, to, groupBy: req.query.groupBy || 'day',
        });
        ok(res, r);
    }
    catch (e) {
        fail(res, e.message);
    }
});
exports.salesRouter.get('/export', (0, roleGuard_1.requireMinRole)('manager'), async (req, res) => {
    try {
        const from = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString();
        const to = req.query.to || new Date().toISOString();
        const rows = await (0, db_1.query)(`SELECT s.sale_number, s.sale_date, s.sale_type, s.customer_name, s.customer_phone,
              s.subtotal, s.discount_amount, s.gst_amount, s.total_amount, s.payment_method,
              COUNT(si.id)::int as items
       FROM sales s LEFT JOIN sale_items si ON si.sale_id=s.id
       WHERE s.store_id=$1 AND s.sale_date BETWEEN $2 AND $3
       GROUP BY s.id ORDER BY s.sale_date DESC`, [req.params.storeId, from, to]);
        if (req.query.format === 'csv') {
            const headers = Object.keys(rows[0] || {}).join(',');
            const csv = [headers, ...rows.map(r => Object.values(r).join(','))].join('\n');
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename=sales-${Date.now()}.csv`);
            res.send(csv);
        }
        else {
            ok(res, rows);
        }
    }
    catch (e) {
        fail(res, e.message);
    }
});
exports.salesRouter.get('/:saleId', async (req, res) => {
    try {
        const storeId = req.params.storeId;
        const r = await queryBus_1.queryBus.execute({ type: 'sale.get', saleId: req.params.saleId, storeId: storeId });
        ok(res, r);
    }
    catch (e) {
        fail(res, e.message, 404);
    }
});
exports.salesRouter.post('/', (0, roleGuard_1.requireMinRole)('staff'), async (req, res) => {
    try {
        const body = CreateSaleSchema.parse(req.body);
        const user = req.user;
        const r = await commandBus_1.commandBus.execute({
            type: 'sale.create',
            storeId: req.params.storeId,
            tenantId: user.tenantId,
            createdBy: user.sub,
            saleType: body.saleType || 'individual', // ← always provide a value
            ...body,
        });
        ok(res, r, 201);
    }
    catch (e) {
        fail(res, e.message);
    }
});
exports.salesRouter.post('/bulk', (0, roleGuard_1.requireMinRole)('manager'), async (req, res) => {
    try {
        const r = await commandBus_1.commandBus.execute({
            type: 'sale.createBulk', storeId: req.params.storeId,
            tenantId: req.user.tenantId, createdBy: req.user.sub, ...req.body
        });
        ok(res, r, 201);
    }
    catch (e) {
        fail(res, e.message);
    }
});
exports.salesRouter.delete('/:saleId', (0, roleGuard_1.requireRole)('owner'), async (req, res) => {
    try {
        const r = await commandBus_1.commandBus.execute({
            type: 'sale.void',
            saleId: req.params.saleId,
            storeId: req.params.storeId,
            tenantId: req.user.tenantId,
            reason: req.body.reason || 'Manual void',
            createdBy: req.user.sub,
        });
        ok(res, r);
    }
    catch (e) {
        fail(res, e.message);
    }
});
