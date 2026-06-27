// ============================================================
// ITEMS (INVENTORY) MODULE — Full CQRS
// ============================================================
import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../../config/db';
import { commandBus, ICommand, ICommandHandler } from '../../cqrs/commandBus';
import { queryBus, IQuery, IQueryHandler } from '../../cqrs/queryBus';
import { authMiddleware, tenantContextMiddleware } from './auth.service';
import { requireMinRole } from '../../core/guards/roleGuard';
import { requestLogger } from '../middleware/requestlogger';

function ok(res: any, data: any, status = 200) {
  res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
}
function fail(res: any, msg: string, status = 400) {
  res.status(status).json({ success: false, error: msg, timestamp: new Date().toISOString() });
}

// ── Commands ─────────────────────────────────────────────────

interface CreateItemCommand extends ICommand {
  readonly type: 'item.create';
  storeId: string; tenantId: string; name: string; sku?: string;
  barcode?: string; brand?: string; description?: string;
  categoryId?: string; supplierId?: string;
  currentStock: number; reorderLevel: number; maxStockLevel?: number;
  leadTimeDays?: number; primaryUnitId?: string; secondaryUnitId?: string;
  unitsPerSecondary?: number; purchasePrice?: number; sellingPrice?: number;
  mrp?: number; gstRate?: number; expiryDate?: string; batchNumber?: string;
  seasonFlag?: string; isSeasonal?: boolean; createdBy: string;
}
class CreateItemCommandHandler implements ICommandHandler<CreateItemCommand> {
  async execute(cmd: CreateItemCommand) {
    // Check plan item limit
    const tenant = await queryOne<any>(
      `SELECT t.*, bp.max_items_per_store FROM tenants t JOIN billing_plans bp ON bp.plan_type=t.plan_type WHERE t.id=$1`,
      [cmd.tenantId]
    );
    if (tenant && tenant.max_items_per_store !== -1) {
      const ic = await queryOne<any>('SELECT COUNT(*)::int as count FROM items WHERE store_id=$1 AND is_active=TRUE',[cmd.storeId]);
      if ((ic?.count||0) >= tenant.max_items_per_store) throw new Error(`Plan limit: max ${tenant.max_items_per_store} items per store`);
    }

    // Resolve unit if not provided — use industry default
    let primaryUnitId = cmd.primaryUnitId;
    if (!primaryUnitId) {
      const store = await queryOne<any>(
        `SELECT s.*, ic.default_unit_symbol FROM stores s JOIN tenants t ON t.id=s.tenant_id JOIN industry_configs ic ON ic.industry_id=t.industry_id WHERE s.id=$1`,
        [cmd.storeId]
      );
      const unit = await queryOne<any>('SELECT id FROM unit_types WHERE symbol=$1',[store?.default_unit_symbol || 'pc']);
      primaryUnitId = unit?.id;
    }

    return withTransaction(async (client) => {
      const [item] = await client.query(
        `INSERT INTO items (store_id,tenant_id,name,sku,barcode,brand,description,category_id,supplier_id,
          current_stock,reorder_level,max_stock_level,lead_time_days,primary_unit_id,secondary_unit_id,
          units_per_secondary,purchase_price,selling_price,mrp,gst_rate,expiry_date,manufacture_date,batch_number,
          season_flag,is_seasonal)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
         RETURNING *`,
        [cmd.storeId,cmd.tenantId,cmd.name,cmd.sku||null,cmd.barcode||null,cmd.brand||null,
         cmd.description||null,cmd.categoryId||null,cmd.supplierId||null,
         cmd.currentStock,cmd.reorderLevel,cmd.maxStockLevel||null,cmd.leadTimeDays||4,
         primaryUnitId||null,cmd.secondaryUnitId||null,cmd.unitsPerSecondary||null,
         cmd.purchasePrice||null,cmd.sellingPrice||null,cmd.mrp||null,cmd.gstRate||0,
         cmd.expiryDate||null,cmd.manufactureDate||null,cmd.batchNumber||null,cmd.seasonFlag||null,cmd.isSeasonal||false]
      ).then(r=>r.rows);

      // Opening stock ledger entry
      if (cmd.currentStock > 0) {
        await client.query(
          `INSERT INTO stock_ledger (item_id,store_id,tenant_id,movement_type,qty_before,qty_change,qty_after,unit_id,created_by)
           VALUES ($1,$2,$3,'opening',0,$4,$4,$5,$6)`,
          [item.id,cmd.storeId,cmd.tenantId,cmd.currentStock,primaryUnitId||null,cmd.createdBy]
        );
      }

      // Auto-create low stock alert
      if (cmd.currentStock <= cmd.reorderLevel) {
        await client.query(
          `INSERT INTO ai_alerts (store_id,tenant_id,item_id,alert_type,message,severity)
           VALUES ($1,$2,$3,'low_stock',$4,'warning')`,
          [cmd.storeId,cmd.tenantId,item.id,
           `${item.name} added with stock (${cmd.currentStock}) at or below reorder level (${cmd.reorderLevel})`]
        );
      }

      return item;
    });
  }
}

interface UpdateItemCommand extends ICommand {
  readonly type: 'item.update';
  itemId: string; storeId: string; tenantId: string;
  name?: string; sku?: string; brand?: string; categoryId?: string;
  supplierId?: string; currentStock?: number; reorderLevel?: number;
  maxStockLevel?: number; purchasePrice?: number; sellingPrice?: number;
  mrp?: number; gstRate?: number; expiryDate?: string; batchNumber?: string;
  seasonFlag?: string; isSeasonal?: boolean; isActive?: boolean;
  stockAdjustment?: { qty: number; reason: string; type: 'add'|'subtract'|'set' };
  updatedBy: string;
}
class UpdateItemCommandHandler implements ICommandHandler<UpdateItemCommand> {
  async execute(cmd: UpdateItemCommand) {
    const existing = await queryOne<any>('SELECT * FROM items WHERE id=$1 AND store_id=$2 AND tenant_id=$3',[cmd.itemId,cmd.storeId,cmd.tenantId]);
    if (!existing) throw new Error('Item not found');

    return withTransaction(async (client) => {
      const sets: string[] = []; const vals: any[] = []; let i = 1;
      if (cmd.name !== undefined)         { sets.push(`name=$${i++}`);          vals.push(cmd.name); }
      if (cmd.sku !== undefined)          { sets.push(`sku=$${i++}`);           vals.push(cmd.sku); }
      if (cmd.brand !== undefined)        { sets.push(`brand=$${i++}`);         vals.push(cmd.brand); }
      if (cmd.categoryId !== undefined)   { sets.push(`category_id=$${i++}`);   vals.push(cmd.categoryId); }
      if (cmd.supplierId !== undefined)   { sets.push(`supplier_id=$${i++}`);   vals.push(cmd.supplierId); }
      if (cmd.reorderLevel !== undefined) { sets.push(`reorder_level=$${i++}`); vals.push(cmd.reorderLevel); }
      if (cmd.maxStockLevel !== undefined){ sets.push(`max_stock_level=$${i++}`);vals.push(cmd.maxStockLevel); }
      if (cmd.purchasePrice !== undefined){ sets.push(`purchase_price=$${i++}`);vals.push(cmd.purchasePrice); }
      if (cmd.sellingPrice !== undefined) { sets.push(`selling_price=$${i++}`); vals.push(cmd.sellingPrice); }
      if (cmd.mrp !== undefined)          { sets.push(`mrp=$${i++}`);           vals.push(cmd.mrp); }
      if (cmd.gstRate !== undefined)      { sets.push(`gst_rate=$${i++}`);      vals.push(cmd.gstRate); }
      if (cmd.expiryDate !== undefined)    { sets.push(`expiry_date=$${i++}`);    vals.push(cmd.expiryDate); }
      if (cmd.manufactureDate !== undefined){ sets.push(`manufacture_date=$${i++}`); vals.push(cmd.manufactureDate); }
      if (cmd.batchNumber !== undefined)   { sets.push(`batch_number=$${i++}`);   vals.push(cmd.batchNumber); }
      if (cmd.isSeasonal !== undefined)   { sets.push(`is_seasonal=$${i++}`);   vals.push(cmd.isSeasonal); }
      if (cmd.isActive !== undefined)     { sets.push(`is_active=$${i++}`);     vals.push(cmd.isActive); }

      // Stock adjustment
      let newStock = existing.current_stock;
      if (cmd.stockAdjustment) {
        const adj = cmd.stockAdjustment;
        const before = parseFloat(existing.current_stock);
        if (adj.type === 'set')      newStock = adj.qty;
        else if (adj.type === 'add') newStock = before + adj.qty;
        else                         newStock = Math.max(0, before - adj.qty);
        sets.push(`current_stock=$${i++}`); vals.push(newStock);
        await client.query(
          `INSERT INTO stock_ledger (item_id,store_id,tenant_id,movement_type,qty_before,qty_change,qty_after,notes,created_by)
           VALUES ($1,$2,$3,'adjustment',$4,$5,$6,$7,$8)`,
          [cmd.itemId,cmd.storeId,cmd.tenantId,before,newStock-before,newStock,adj.reason,cmd.updatedBy]
        );
      }

      sets.push(`updated_at=NOW()`);
      vals.push(cmd.itemId, cmd.storeId, cmd.tenantId);
      const [item] = await client.query(
        `UPDATE items SET ${sets.join(',')} WHERE id=$${i} AND store_id=$${i+1} AND tenant_id=$${i+2} RETURNING *`,
        vals
      ).then(r=>r.rows);
      return item;
    });
  }
}

interface BulkCreateItemsCommand extends ICommand {
  readonly type: 'item.bulkCreate';
  storeId: string; tenantId: string;
  items: Omit<CreateItemCommand,'type'|'storeId'|'tenantId'|'createdBy'>[];
  mode: 'upsert'|'insert_only'; createdBy: string;
}
class BulkCreateItemsCommandHandler implements ICommandHandler<BulkCreateItemsCommand> {
  async execute(cmd: BulkCreateItemsCommand) {
    let created = 0, updated = 0;
    const errors: { row: number; message: string }[] = [];
    for (let idx = 0; idx < cmd.items.length; idx++) {
      const item = cmd.items[idx];
      try {
        if (cmd.mode === 'upsert' && item.sku) {
          const existing = await queryOne<any>('SELECT id FROM items WHERE sku=$1 AND store_id=$2',[item.sku,cmd.storeId]);
          if (existing) {
            await commandBus.execute({ type: 'item.update', itemId: existing.id, storeId: cmd.storeId, tenantId: cmd.tenantId, updatedBy: cmd.createdBy, ...item });
            updated++; continue;
          }
        }
        await commandBus.execute({ type: 'item.create', storeId: cmd.storeId, tenantId: cmd.tenantId, createdBy: cmd.createdBy, ...item });
        created++;
      } catch (e: any) {
        errors.push({ row: idx + 1, message: e.message });
      }
    }
    return { created, updated, errors, total: cmd.items.length };
  }
}

// ── Queries ──────────────────────────────────────────────────

interface ListItemsQuery extends IQuery {
  readonly type: 'item.list';
  storeId: string; tenantId: string; q?: string;
  categoryId?: string; lowStock?: boolean; expiring?: number;
  page: number; limit: number; sortBy?: string; sortDir?: string;
}
class ListItemsQueryHandler implements IQueryHandler<ListItemsQuery, any> {
  async execute(q: ListItemsQuery) {
    const conds = ['i.store_id=$1','i.tenant_id=$2','i.is_active=TRUE'];
    const vals: any[] = [q.storeId, q.tenantId]; let i = 3;
    if (q.q)          { conds.push(`(i.name ILIKE $${i} OR i.sku ILIKE $${i} OR i.barcode ILIKE $${i})`); vals.push(`%${q.q}%`); i++; }
    if (q.categoryId) { conds.push(`i.category_id=$${i++}`); vals.push(q.categoryId); }
    if (q.lowStock)   { conds.push(`i.current_stock <= i.reorder_level`); }
    if (q.expiring)   { conds.push(`i.expiry_date <= NOW() + INTERVAL '${q.expiring} days' AND i.expiry_date IS NOT NULL`); }
    const where = `WHERE ${conds.join(' AND ')}`;
    const sortField = ['name','current_stock','expiry_date','updated_at'].includes(q.sortBy||'') ? q.sortBy : 'updated_at';
    const sortDir = q.sortDir === 'asc' ? 'ASC' : 'DESC';
    const [{ count }] = await query<any>(`SELECT COUNT(*) FROM items i ${where}`, vals);
    const offset = (q.page-1)*q.limit;
    vals.push(q.limit, offset);
    const items = await query<any>(
      `SELECT i.*, ut.symbol as unit_symbol, ut.name as unit_name,
              c.name as category_name, s.name as supplier_name,
              CASE WHEN i.current_stock <= i.reorder_level THEN true ELSE false END as is_low_stock,
              CASE WHEN i.expiry_date <= NOW() + INTERVAL '30 days' AND i.expiry_date IS NOT NULL THEN true ELSE false END as is_expiring
       FROM items i
       LEFT JOIN unit_types ut ON ut.id=i.primary_unit_id
       LEFT JOIN categories c ON c.id=i.category_id
       LEFT JOIN suppliers s ON s.id=i.supplier_id
       ${where} ORDER BY i.${sortField} ${sortDir} LIMIT $${i} OFFSET $${i+1}`, vals
    );
    return { items, total: parseInt(count), page: q.page, limit: q.limit, pages: Math.ceil(parseInt(count)/q.limit) };
  }
}

interface GetItemQuery extends IQuery {
  readonly type: 'item.get';
  itemId: string; storeId: string; tenantId: string;
}
class GetItemQueryHandler implements IQueryHandler<GetItemQuery, any> {
  async execute(q: GetItemQuery) {
    const item = await queryOne<any>(
      `SELECT i.*, ut.symbol as unit_symbol, ut.name as unit_name,
              sut.symbol as secondary_unit_symbol,
              c.name as category_name, s.name as supplier_name
       FROM items i
       LEFT JOIN unit_types ut  ON ut.id=i.primary_unit_id
       LEFT JOIN unit_types sut ON sut.id=i.secondary_unit_id
       LEFT JOIN categories c ON c.id=i.category_id
       LEFT JOIN suppliers s ON s.id=i.supplier_id
       WHERE i.id=$1 AND i.store_id=$2 AND i.tenant_id=$3`,
      [q.itemId,q.storeId,q.tenantId]
    );
    if (!item) throw new Error('Item not found');
    return item;
  }
}

interface GetItemLedgerQuery extends IQuery {
  readonly type: 'item.ledger';
  itemId: string; storeId: string; limit: number; offset: number;
}
class GetItemLedgerQueryHandler implements IQueryHandler<GetItemLedgerQuery, any> {
  async execute(q: GetItemLedgerQuery) {
    const rows = await query<any>(
      `SELECT sl.*, ut.symbol as unit_symbol, u.first_name||' '||u.last_name as created_by_name
       FROM stock_ledger sl
       LEFT JOIN unit_types ut ON ut.id=sl.unit_id
       LEFT JOIN users u ON u.id=sl.created_by
       WHERE sl.item_id=$1 AND sl.store_id=$2
       ORDER BY sl.created_at DESC LIMIT $3 OFFSET $4`,
      [q.itemId, q.storeId, q.limit, q.offset]
    );
    return rows;
  }
}

interface GetLowStockQuery extends IQuery {
  readonly type: 'item.lowStock';
  storeId: string; tenantId: string;
}
class GetLowStockQueryHandler implements IQueryHandler<GetLowStockQuery, any[]> {
  async execute(q: GetLowStockQuery) {
    return query<any>(
      `SELECT i.*, ut.symbol as unit_symbol,
              ROUND(((i.reorder_level - i.current_stock) / NULLIF(i.monthly_usage_avg,0)) * 30) as days_remaining
       FROM items i LEFT JOIN unit_types ut ON ut.id=i.primary_unit_id
       WHERE i.store_id=$1 AND i.tenant_id=$2 AND i.is_active=TRUE
         AND i.current_stock <= i.reorder_level
       ORDER BY i.current_stock ASC`,
      [q.storeId,q.tenantId]
    );
  }
}

interface GetExpiringQuery extends IQuery {
  readonly type: 'item.expiring';
  storeId: string; tenantId: string; days: number;
}
class GetExpiringQueryHandler implements IQueryHandler<GetExpiringQuery, any[]> {
  async execute(q: GetExpiringQuery) {
    return query<any>(
      `SELECT i.*, ut.symbol as unit_symbol,
              i.expiry_date - CURRENT_DATE as days_to_expiry
       FROM items i LEFT JOIN unit_types ut ON ut.id=i.primary_unit_id
       WHERE i.store_id=$1 AND i.tenant_id=$2 AND i.is_active=TRUE
         AND i.expiry_date IS NOT NULL
         AND i.expiry_date <= NOW() + INTERVAL '${q.days} days'
       ORDER BY i.expiry_date ASC`,
      [q.storeId,q.tenantId]
    );
  }
}

// Register
commandBus.register('item.create',     new CreateItemCommandHandler());
commandBus.register('item.update',     new UpdateItemCommandHandler());
commandBus.register('item.bulkCreate', new BulkCreateItemsCommandHandler());
queryBus.register('item.list',           new ListItemsQueryHandler());
queryBus.register('item.get',          new GetItemQueryHandler());
queryBus.register('item.ledger',       new GetItemLedgerQueryHandler());
queryBus.register('item.lowStock',     new GetLowStockQueryHandler());
queryBus.register('item.expiring',     new GetExpiringQueryHandler());

// ── Router ───────────────────────────────────────────────────
export const itemRouter = Router({ mergeParams: true });
itemRouter.use(authMiddleware);
itemRouter.use(tenantContextMiddleware);
itemRouter.use(requestLogger);


export const ItemCreateSchema = z.object({
  name: z.string().min(1),
  sku: z.string().nullish(),
  barcode: z.string().nullish(),
  brand: z.string().nullish(),
  description: z.string().nullish(),
  categoryId: z.string().uuid().nullish(),
  supplierId: z.string().uuid().nullish(),

  currentStock: z.number().min(0).default(0),

  reorderLevel: z.number().min(0).default(5),

  maxStockLevel: z.number().nullish(),
  leadTimeDays: z.number().nullish(),

  primaryUnitId: z.string().uuid().nullish(),
  secondaryUnitId: z.string().uuid().nullish(),

  unitsPerSecondary: z.number().nullish(),

  sellingPrice: z.number().nullish(),
  purchasePrice: z.number().nullish(),

  mrp: z.number().nullish(),
  gstRate: z.number().nullish(),

  expiryDate: z.string().nullish(),
  batchNumber: z.string().nullish(),

  seasonFlag: z.string().nullish(),
  isSeasonal: z.boolean().optional().default(false)
});
itemRouter.get('/:itemId/ledger', async (req, res) => {
  try {
    const storeId = (req.params as any).storeId;
    const result = await queryBus.execute({
      type: 'item.ledger',                    // ✅ was 'item.get'
      itemId: req.params.itemId,
      storeId: storeId,
      limit:  parseInt(req.query.limit  as string) || 100,
      offset: parseInt(req.query.offset as string) || 0,
    } as GetItemLedgerQuery);
    ok(res, result);
  } catch (e: any) { fail(res, e.message); }
});

itemRouter.get('/', async (req, res) => {
  try {
    const user = (req as any).user;
    const storeId = (req.params as any).storeId as string;
    const r = await queryBus.execute<any>({
      type: 'item.list',
      storeId,
      tenantId: user.tenantId,
      q:          req.query.q          as string,
      categoryId: req.query.categoryId as string,
      lowStock:   req.query.lowStock   === 'true',
      expiring:   req.query.expiring   ? parseInt(req.query.expiring as string) : undefined,
      page:       parseInt(req.query.page  as string) || 1,
      limit:      parseInt(req.query.limit as string) || 50,
      sortBy:     req.query.sortBy     as string,
      sortDir:    req.query.sortDir    as string,
    });
    ok(res, r.items);
  } catch (e: any) { fail(res, e.message); }
});

itemRouter.get('/low-stock', async (req, res) => {
  try {
    const storeId = (req.params as any).storeId;
    const r = await queryBus.execute<any>({ type: 'item.lowStock', storeId: storeId, tenantId: (req as any).user.tenantId });
    ok(res, r);
  } catch (e: any) { fail(res, e.message); }
});

itemRouter.get('/expiring', async (req, res) => {
  try {
    const storeId = (req.params as any).storeId;

    const r = await queryBus.execute<any>({ type: 'item.expiring', storeId: storeId, tenantId: (req as any).user.tenantId, days: parseInt(req.query.days as string)||30 });
    ok(res, r);
  } catch (e: any) { fail(res, e.message); }
});

itemRouter.post('/', requireMinRole('staff'), async (req, res) => {
  try {
    console.log('i am here post item')
    const body = ItemCreateSchema.parse(req.body);
    const r = await commandBus.execute<any>({ type: 'item.create', storeId: req.params.storeId, tenantId: (req as any).user.tenantId, createdBy: (req as any).user.sub, ...body });
    ok(res, r, 201);
  } catch (e: any) { fail(res, e.message); }
});

itemRouter.post('/bulk', requireMinRole('manager'), async (req, res) => {
  try {
    const r = await commandBus.execute<any>({ type: 'item.bulkCreate', storeId: req.params.storeId, tenantId: (req as any).user.tenantId, createdBy: (req as any).user.sub, ...req.body });
    ok(res, r);
  } catch (e: any) { fail(res, e.message); }
});

itemRouter.get('/:itemId', async (req, res) => {
  try {
    const storeId = (req.params as any).storeId;
    const r = await queryBus.execute<any>({ type: 'item.get', itemId: req.params.itemId, storeId: storeId, tenantId: (req as any).user.tenantId });
    ok(res, r);
  } catch (e: any) { fail(res, e.message, 404); }
});

itemRouter.put('/:itemId', requireMinRole('staff'), async (req, res) => {
  try {
    const r = await commandBus.execute<any>({ type: 'item.update', itemId: req.params.itemId, storeId: req.params.storeId, tenantId: (req as any).user.tenantId, updatedBy: (req as any).user.sub, ...req.body });
    ok(res, r);
  } catch (e: any) { fail(res, e.message); }
});

itemRouter.delete('/:itemId', requireMinRole('manager'), async (req, res) => {
  try {
    await commandBus.execute<any>({ type: 'item.update', itemId: req.params.itemId, storeId: req.params.storeId, tenantId: (req as any).user.tenantId, isActive: false, updatedBy: (req as any).user.sub });
    ok(res, { message: 'Item deactivated' });
  } catch (e: any) { fail(res, e.message); }
});

// ── Quick Add ──────────────────────────────────────────────────
const QuickCreateSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  sku: z.string().optional(),
  sellingPrice: z.number().min(0).optional().default(0),
  currentStock: z.number().min(0).optional().default(0),
});

itemRouter.post('/quick', requireMinRole('staff'), async (req, res) => {
  try {
    const body = QuickCreateSchema.parse(req.body);
    const autoSku = body.sku || `SKU-${Date.now().toString(36).toUpperCase()}`;
    const r = await commandBus.execute<any>({
      type: 'item.create',
      storeId: req.params.storeId,
      tenantId: (req as any).user.tenantId,
      createdBy: (req as any).user.sub,
      name: body.name,
      sku: autoSku,
      currentStock: body.currentStock ?? 0,
      reorderLevel: 5,
      sellingPrice: body.sellingPrice ?? 0,
    });
    ok(res, r, 201);
  } catch (e: any) { fail(res, e.message); }
});

// ── CSV Import Template ────────────────────────────────────────
const CSV_HEADERS = [
  'name', 'sku', 'barcode', 'brand', 'description',
  'currentStock', 'reorderLevel', 'maxStockLevel',
  'sellingPrice', 'purchasePrice', 'mrp', 'gstRate',
  'expiryDate', 'batchNumber', 'isSeasonal',
];
const CSV_EXAMPLE = [
  'Paracetamol 500mg', 'MED-0001', '', 'GSK', 'Pain reliever',
  '100', '20', '500',
  '25.50', '18.00', '30.00', '5',
  '2026-12-31', 'BATCH-001', 'false',
];

itemRouter.get('/import/template', async (_req, res) => {
  const csv = [CSV_HEADERS.join(','), CSV_EXAMPLE.join(',')].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="items_import_template.csv"');
  res.send(csv);
});

// ── CSV Import (JSON rows from parsed CSV) ─────────────────────
function parseNum(v: any): number | undefined {
  const n = parseFloat(String(v ?? '').trim());
  return isNaN(n) ? undefined : n;
}
function parseBool(v: any): boolean {
  return String(v ?? '').trim().toLowerCase() === 'true';
}

itemRouter.post('/import', requireMinRole('manager'), async (req, res) => {
  try {
    const { rows, mode = 'upsert' } = req.body as {
      rows: Record<string, string>[];
      mode?: 'upsert' | 'insert_only';
    };
    if (!Array.isArray(rows) || rows.length === 0) {
      return fail(res, 'rows array is required and must not be empty');
    }
    if (rows.length > 500) {
      return fail(res, 'Maximum 500 rows per import');
    }

    const items = rows.map((r) => ({
      name: String(r.name ?? '').trim(),
      sku: String(r.sku ?? '').trim() || undefined,
      barcode: String(r.barcode ?? '').trim() || undefined,
      brand: String(r.brand ?? '').trim() || undefined,
      description: String(r.description ?? '').trim() || undefined,
      currentStock: parseNum(r.currentStock) ?? 0,
      reorderLevel: parseNum(r.reorderLevel) ?? 5,
      maxStockLevel: parseNum(r.maxStockLevel),
      sellingPrice: parseNum(r.sellingPrice),
      purchasePrice: parseNum(r.purchasePrice),
      mrp: parseNum(r.mrp),
      gstRate: parseNum(r.gstRate) ?? 0,
      expiryDate: String(r.expiryDate ?? '').trim() || undefined,
      batchNumber: String(r.batchNumber ?? '').trim() || undefined,
      isSeasonal: parseBool(r.isSeasonal),
    })).filter(i => i.name.length > 0);

    const r = await commandBus.execute<any>({
      type: 'item.bulkCreate',
      storeId: req.params.storeId,
      tenantId: (req as any).user.tenantId,
      createdBy: (req as any).user.sub,
      items,
      mode,
    });
    ok(res, r);
  } catch (e: any) { fail(res, e.message); }
});

itemRouter.get('/:itemId/ledger', async (req, res) => {
  try {
    const storeId = (req.params as any).storeId;
    const user = (req as any).user;
    const result = await queryBus.execute({
      type: 'item.get',
      itemId: req.params.itemId,
      storeId: storeId,
      tenantId: user.tenantId,
    } as GetItemQuery);
    ok(res, result);
  } catch (e: any) { fail(res, e.message); }
});