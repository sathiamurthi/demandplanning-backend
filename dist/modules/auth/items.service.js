"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ItemCreateSchema = exports.itemRouter = void 0;
// ============================================================
// ITEMS (INVENTORY) MODULE — Full CQRS
// ============================================================
const express_1 = require("express");
const zod_1 = require("zod");
const db_1 = require("../../config/db");
const commandBus_1 = require("../../cqrs/commandBus");
const queryBus_1 = require("../../cqrs/queryBus");
const auth_service_1 = require("./auth.service");
const roleGuard_1 = require("../../core/guards/roleGuard");
const requestlogger_1 = require("../middleware/requestlogger");
const gemini_service_1 = require("./gemini.service");
function ok(res, data, status = 200) {
    res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
}
function fail(res, msg, status = 400) {
    res.status(status).json({ success: false, error: msg, timestamp: new Date().toISOString() });
}
async function broadcastOffer(item, tenantId, storeId) {
    try {
        const store = await (0, db_1.queryOne)('SELECT name FROM stores WHERE id=$1', [storeId]);
        const storeName = store?.name || 'our store';
        // Fetch verified whatsapp subscribers
        const subscribers = await (0, db_1.query)('SELECT phone FROM whatsapp_subscriptions WHERE is_verified=TRUE');
        if (!subscribers || subscribers.length === 0)
            return;
        const discLabel = item.discount_type === 'percentage'
            ? `${parseFloat(item.discount_value)}% Off`
            : `Flat ₹${parseFloat(item.discount_value)} Off`;
        const message = [
            `🎉 *New Offer Alert from ${storeName}!* 🎉`,
            ``,
            `Supercharge your shopping with our latest deal:`,
            `🏷️ *Product:* ${item.name}`,
            `💰 *Deal:* ${discLabel}`,
            `💵 *Offer Price:* ₹${parseFloat(item.selling_price)}`,
            `📦 *Batch:* ${item.batch_number || 'N/A'}`,
            ``,
            `Hurry up! Stock is limited (${parseFloat(item.current_stock)} remaining).`,
            `Reply to this chat to order now!`,
        ].join('\n');
        const { sendWhatsAppText } = await Promise.resolve().then(() => __importStar(require('../../utils/whatsapp')));
        for (const sub of subscribers) {
            await sendWhatsAppText(sub.phone, message);
        }
        console.log(`[WA Broadcast] Sent offer notification to ${subscribers.length} subscribers.`);
    }
    catch (e) {
        console.error('[WA Broadcast] Failed:', e.message);
    }
}
class CreateItemCommandHandler {
    async execute(cmd) {
        // Check plan item limit
        const tenant = await (0, db_1.queryOne)(`SELECT t.*, bp.max_items_per_store FROM tenants t JOIN billing_plans bp ON bp.plan_type=t.plan_type WHERE t.id=$1`, [cmd.tenantId]);
        if (tenant && tenant.max_items_per_store !== -1) {
            const ic = await (0, db_1.queryOne)('SELECT COUNT(*)::int as count FROM items WHERE store_id=$1 AND is_active=TRUE', [cmd.storeId]);
            if ((ic?.count || 0) >= tenant.max_items_per_store)
                throw new Error(`Plan limit: max ${tenant.max_items_per_store} items per store`);
        }
        // Resolve unit if not provided — use industry default
        let primaryUnitId = cmd.primaryUnitId;
        if (!primaryUnitId) {
            const store = await (0, db_1.queryOne)(`SELECT s.*, ic.default_unit_symbol FROM stores s JOIN tenants t ON t.id=s.tenant_id JOIN industry_configs ic ON ic.industry_id=t.industry_id WHERE s.id=$1`, [cmd.storeId]);
            const unit = await (0, db_1.queryOne)('SELECT id FROM unit_types WHERE symbol=$1', [store?.default_unit_symbol || 'pc']);
            primaryUnitId = unit?.id;
        }
        const item = await (0, db_1.withTransaction)(async (client) => {
            const [item] = await client.query(`INSERT INTO items (store_id,tenant_id,name,sku,barcode,brand,description,category_id,supplier_id,
          current_stock,reorder_level,max_stock_level,lead_time_days,primary_unit_id,secondary_unit_id,
          units_per_secondary,purchase_price,selling_price,mrp,gst_rate,expiry_date,manufacture_date,batch_number,
          season_flag,is_seasonal,discount_type,discount_value)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
         RETURNING *`, [cmd.storeId, cmd.tenantId, cmd.name, cmd.sku || null, cmd.barcode || null, cmd.brand || null,
                cmd.description || null, cmd.categoryId || null, cmd.supplierId || null,
                cmd.currentStock, cmd.reorderLevel, cmd.maxStockLevel || null, cmd.leadTimeDays || 4,
                primaryUnitId || null, cmd.secondaryUnitId || null, cmd.unitsPerSecondary || null,
                cmd.purchasePrice || null, cmd.sellingPrice || null, cmd.mrp || null, cmd.gstRate || 0,
                cmd.expiryDate || null, cmd.manufactureDate || null, cmd.batchNumber || null, cmd.seasonFlag || null, cmd.isSeasonal || false,
                cmd.discountType || 'none', cmd.discountValue || 0]).then(r => r.rows);
            // Opening stock ledger entry
            if (cmd.currentStock > 0) {
                await client.query(`INSERT INTO stock_ledger (item_id,store_id,tenant_id,movement_type,qty_before,qty_change,qty_after,unit_id,created_by)
           VALUES ($1,$2,$3,'opening',0,$4,$4,$5,$6)`, [item.id, cmd.storeId, cmd.tenantId, cmd.currentStock, primaryUnitId || null, cmd.createdBy]);
            }
            // Auto-create low stock alert
            if (cmd.currentStock <= cmd.reorderLevel) {
                await client.query(`INSERT INTO ai_alerts (store_id,tenant_id,item_id,alert_type,message,severity)
           VALUES ($1,$2,$3,'low_stock',$4,'warning')`, [cmd.storeId, cmd.tenantId, item.id,
                    `${item.name} added with stock (${cmd.currentStock}) at or below reorder level (${cmd.reorderLevel})`]);
            }
            return item;
        });
        if (item && item.discount_type && item.discount_type !== 'none' && parseFloat(item.discount_value) > 0) {
            broadcastOffer(item, cmd.tenantId, cmd.storeId).catch(err => {
                console.error('[WA Broadcast] error:', err.message);
            });
        }
        return item;
    }
}
class UpdateItemCommandHandler {
    async execute(cmd) {
        const existing = await (0, db_1.queryOne)('SELECT * FROM items WHERE id=$1 AND store_id=$2 AND tenant_id=$3', [cmd.itemId, cmd.storeId, cmd.tenantId]);
        if (!existing)
            throw new Error('Item not found');
        const item = await (0, db_1.withTransaction)(async (client) => {
            const sets = [];
            const vals = [];
            let i = 1;
            if (cmd.name !== undefined) {
                sets.push(`name=$${i++}`);
                vals.push(cmd.name);
            }
            if (cmd.sku !== undefined) {
                sets.push(`sku=$${i++}`);
                vals.push(cmd.sku);
            }
            if (cmd.brand !== undefined) {
                sets.push(`brand=$${i++}`);
                vals.push(cmd.brand);
            }
            if (cmd.categoryId !== undefined) {
                sets.push(`category_id=$${i++}`);
                vals.push(cmd.categoryId);
            }
            if (cmd.supplierId !== undefined) {
                sets.push(`supplier_id=$${i++}`);
                vals.push(cmd.supplierId);
            }
            if (cmd.reorderLevel !== undefined) {
                sets.push(`reorder_level=$${i++}`);
                vals.push(cmd.reorderLevel);
            }
            if (cmd.maxStockLevel !== undefined) {
                sets.push(`max_stock_level=$${i++}`);
                vals.push(cmd.maxStockLevel);
            }
            if (cmd.purchasePrice !== undefined) {
                sets.push(`purchase_price=$${i++}`);
                vals.push(cmd.purchasePrice);
            }
            if (cmd.sellingPrice !== undefined) {
                sets.push(`selling_price=$${i++}`);
                vals.push(cmd.sellingPrice);
            }
            if (cmd.mrp !== undefined) {
                sets.push(`mrp=$${i++}`);
                vals.push(cmd.mrp);
            }
            if (cmd.gstRate !== undefined) {
                sets.push(`gst_rate=$${i++}`);
                vals.push(cmd.gstRate);
            }
            if (cmd.expiryDate !== undefined) {
                sets.push(`expiry_date=$${i++}`);
                vals.push(cmd.expiryDate);
            }
            if (cmd.manufactureDate !== undefined) {
                sets.push(`manufacture_date=$${i++}`);
                vals.push(cmd.manufactureDate);
            }
            if (cmd.batchNumber !== undefined) {
                sets.push(`batch_number=$${i++}`);
                vals.push(cmd.batchNumber);
            }
            if (cmd.isSeasonal !== undefined) {
                sets.push(`is_seasonal=$${i++}`);
                vals.push(cmd.isSeasonal);
            }
            if (cmd.isActive !== undefined) {
                sets.push(`is_active=$${i++}`);
                vals.push(cmd.isActive);
            }
            if (cmd.discountType !== undefined) {
                sets.push(`discount_type=$${i++}`);
                vals.push(cmd.discountType);
            }
            if (cmd.discountValue !== undefined) {
                sets.push(`discount_value=$${i++}`);
                vals.push(cmd.discountValue);
            }
            // Stock adjustment
            let newStock = existing.current_stock;
            if (cmd.stockAdjustment) {
                const adj = cmd.stockAdjustment;
                const before = parseFloat(existing.current_stock);
                if (adj.type === 'set')
                    newStock = adj.qty;
                else if (adj.type === 'add')
                    newStock = before + adj.qty;
                else
                    newStock = Math.max(0, before - adj.qty);
                sets.push(`current_stock=$${i++}`);
                vals.push(newStock);
                await client.query(`INSERT INTO stock_ledger (item_id,store_id,tenant_id,movement_type,qty_before,qty_change,qty_after,notes,created_by)
           VALUES ($1,$2,$3,'adjustment',$4,$5,$6,$7,$8)`, [cmd.itemId, cmd.storeId, cmd.tenantId, before, newStock - before, newStock, adj.reason, cmd.updatedBy]);
            }
            sets.push(`updated_at=NOW()`);
            vals.push(cmd.itemId, cmd.storeId, cmd.tenantId);
            const [item] = await client.query(`UPDATE items SET ${sets.join(',')} WHERE id=$${i} AND store_id=$${i + 1} AND tenant_id=$${i + 2} RETURNING *`, vals).then(r => r.rows);
            return item;
        });
        const wasOffer = existing.discount_type !== 'none' && parseFloat(existing.discount_value) > 0;
        const isOffer = item.discount_type !== 'none' && parseFloat(item.discount_value) > 0;
        if (isOffer && (!wasOffer || existing.discount_value !== item.discount_value || existing.discount_type !== item.discount_type)) {
            broadcastOffer(item, cmd.tenantId, cmd.storeId).catch(err => {
                console.error('[WA Broadcast] error:', err.message);
            });
        }
        return item;
    }
}
class BulkCreateItemsCommandHandler {
    async execute(cmd) {
        let created = 0, updated = 0;
        const errors = [];
        for (let idx = 0; idx < cmd.items.length; idx++) {
            const item = cmd.items[idx];
            try {
                if (cmd.mode === 'upsert' && item.sku) {
                    const existing = await (0, db_1.queryOne)('SELECT id FROM items WHERE sku=$1 AND store_id=$2', [item.sku, cmd.storeId]);
                    if (existing) {
                        await commandBus_1.commandBus.execute({ type: 'item.update', itemId: existing.id, storeId: cmd.storeId, tenantId: cmd.tenantId, updatedBy: cmd.createdBy, ...item });
                        updated++;
                        continue;
                    }
                }
                await commandBus_1.commandBus.execute({ type: 'item.create', storeId: cmd.storeId, tenantId: cmd.tenantId, createdBy: cmd.createdBy, ...item });
                created++;
            }
            catch (e) {
                errors.push({ row: idx + 1, message: e.message });
            }
        }
        return { created, updated, errors, total: cmd.items.length };
    }
}
class ListItemsQueryHandler {
    async execute(q) {
        const conds = ['i.store_id=$1', 'i.tenant_id=$2', 'i.is_active=TRUE'];
        const vals = [q.storeId, q.tenantId];
        let i = 3;
        if (q.q) {
            conds.push(`(i.name ILIKE $${i} OR i.sku ILIKE $${i} OR i.barcode ILIKE $${i})`);
            vals.push(`%${q.q}%`);
            i++;
        }
        if (q.categoryId) {
            conds.push(`i.category_id=$${i++}`);
            vals.push(q.categoryId);
        }
        if (q.lowStock) {
            conds.push(`i.current_stock <= i.reorder_level`);
        }
        if (q.expiring) {
            conds.push(`i.expiry_date <= NOW() + INTERVAL '${q.expiring} days' AND i.expiry_date IS NOT NULL`);
        }
        const where = `WHERE ${conds.join(' AND ')}`;
        const sortField = ['name', 'current_stock', 'expiry_date', 'updated_at'].includes(q.sortBy || '') ? q.sortBy : 'updated_at';
        const sortDir = q.sortDir === 'asc' ? 'ASC' : 'DESC';
        const [{ count }] = await (0, db_1.query)(`SELECT COUNT(*) FROM items i ${where}`, vals);
        const offset = (q.page - 1) * q.limit;
        vals.push(q.limit, offset);
        const items = await (0, db_1.query)(`SELECT i.*, ut.symbol as unit_symbol, ut.name as unit_name,
              sut.symbol as secondary_unit_symbol,
              c.name as category_name, s.name as supplier_name,
              CASE WHEN i.current_stock <= i.reorder_level THEN true ELSE false END as is_low_stock,
              CASE WHEN i.expiry_date <= NOW() + INTERVAL '30 days' AND i.expiry_date IS NOT NULL THEN true ELSE false END as is_expiring
       FROM items i
       LEFT JOIN unit_types ut ON ut.id=i.primary_unit_id
       LEFT JOIN unit_types sut ON sut.id=i.secondary_unit_id
       LEFT JOIN categories c ON c.id=i.category_id
       LEFT JOIN suppliers s ON s.id=i.supplier_id
       ${where} ORDER BY i.${sortField} ${sortDir} LIMIT $${i} OFFSET $${i + 1}`, vals);
        return { items, total: parseInt(count), page: q.page, limit: q.limit, pages: Math.ceil(parseInt(count) / q.limit) };
    }
}
class GetItemQueryHandler {
    async execute(q) {
        const item = await (0, db_1.queryOne)(`SELECT i.*, ut.symbol as unit_symbol, ut.name as unit_name,
              sut.symbol as secondary_unit_symbol,
              c.name as category_name, s.name as supplier_name
       FROM items i
       LEFT JOIN unit_types ut  ON ut.id=i.primary_unit_id
       LEFT JOIN unit_types sut ON sut.id=i.secondary_unit_id
       LEFT JOIN categories c ON c.id=i.category_id
       LEFT JOIN suppliers s ON s.id=i.supplier_id
       WHERE i.id=$1 AND i.store_id=$2 AND i.tenant_id=$3`, [q.itemId, q.storeId, q.tenantId]);
        if (!item)
            throw new Error('Item not found');
        return item;
    }
}
class GetItemLedgerQueryHandler {
    async execute(q) {
        const rows = await (0, db_1.query)(`SELECT sl.*, ut.symbol as unit_symbol, u.first_name||' '||u.last_name as created_by_name
       FROM stock_ledger sl
       LEFT JOIN unit_types ut ON ut.id=sl.unit_id
       LEFT JOIN users u ON u.id=sl.created_by
       WHERE sl.item_id=$1 AND sl.store_id=$2
       ORDER BY sl.created_at DESC LIMIT $3 OFFSET $4`, [q.itemId, q.storeId, q.limit, q.offset]);
        return rows;
    }
}
class GetLowStockQueryHandler {
    async execute(q) {
        return (0, db_1.query)(`SELECT i.*, ut.symbol as unit_symbol,
              ROUND(((i.reorder_level - i.current_stock) / NULLIF(i.monthly_usage_avg,0)) * 30) as days_remaining
       FROM items i LEFT JOIN unit_types ut ON ut.id=i.primary_unit_id
       WHERE i.store_id=$1 AND i.tenant_id=$2 AND i.is_active=TRUE
         AND i.current_stock <= i.reorder_level
       ORDER BY i.current_stock ASC`, [q.storeId, q.tenantId]);
    }
}
class GetExpiringQueryHandler {
    async execute(q) {
        return (0, db_1.query)(`SELECT i.*, ut.symbol as unit_symbol,
              i.expiry_date - CURRENT_DATE as days_to_expiry
       FROM items i LEFT JOIN unit_types ut ON ut.id=i.primary_unit_id
       WHERE i.store_id=$1 AND i.tenant_id=$2 AND i.is_active=TRUE
         AND i.expiry_date IS NOT NULL
         AND i.expiry_date <= NOW() + INTERVAL '${q.days} days'
       ORDER BY i.expiry_date ASC`, [q.storeId, q.tenantId]);
    }
}
// Register
commandBus_1.commandBus.register('item.create', new CreateItemCommandHandler());
commandBus_1.commandBus.register('item.update', new UpdateItemCommandHandler());
commandBus_1.commandBus.register('item.bulkCreate', new BulkCreateItemsCommandHandler());
queryBus_1.queryBus.register('item.list', new ListItemsQueryHandler());
queryBus_1.queryBus.register('item.get', new GetItemQueryHandler());
queryBus_1.queryBus.register('item.ledger', new GetItemLedgerQueryHandler());
queryBus_1.queryBus.register('item.lowStock', new GetLowStockQueryHandler());
queryBus_1.queryBus.register('item.expiring', new GetExpiringQueryHandler());
// ── Router ───────────────────────────────────────────────────
exports.itemRouter = (0, express_1.Router)({ mergeParams: true });
exports.itemRouter.use(auth_service_1.authMiddleware);
exports.itemRouter.use(auth_service_1.tenantContextMiddleware);
exports.itemRouter.use(requestlogger_1.requestLogger);
exports.ItemCreateSchema = zod_1.z.object({
    name: zod_1.z.string().min(1),
    sku: zod_1.z.string().nullish(),
    barcode: zod_1.z.string().nullish(),
    brand: zod_1.z.string().nullish(),
    description: zod_1.z.string().nullish(),
    categoryId: zod_1.z.string().uuid().nullish(),
    supplierId: zod_1.z.string().uuid().nullish(),
    currentStock: zod_1.z.number().min(0).default(0),
    reorderLevel: zod_1.z.number().min(0).default(5),
    maxStockLevel: zod_1.z.number().nullish(),
    leadTimeDays: zod_1.z.number().nullish(),
    primaryUnitId: zod_1.z.string().uuid().nullish(),
    secondaryUnitId: zod_1.z.string().uuid().nullish(),
    unitsPerSecondary: zod_1.z.number().nullish(),
    sellingPrice: zod_1.z.number().nullish(),
    purchasePrice: zod_1.z.number().nullish(),
    mrp: zod_1.z.number().nullish(),
    gstRate: zod_1.z.number().nullish(),
    expiryDate: zod_1.z.string().nullish(),
    batchNumber: zod_1.z.string().nullish(),
    seasonFlag: zod_1.z.string().nullish(),
    isSeasonal: zod_1.z.boolean().optional().default(false),
    discountType: zod_1.z.string().optional().default('none'),
    discountValue: zod_1.z.number().min(0).optional().default(0)
});
exports.itemRouter.get('/:itemId/ledger', async (req, res) => {
    try {
        const storeId = req.params.storeId;
        const result = await queryBus_1.queryBus.execute({
            type: 'item.ledger', // ✅ was 'item.get'
            itemId: req.params.itemId,
            storeId: storeId,
            limit: parseInt(req.query.limit) || 100,
            offset: parseInt(req.query.offset) || 0,
        });
        ok(res, result);
    }
    catch (e) {
        fail(res, e.message);
    }
});
exports.itemRouter.get('/', async (req, res) => {
    try {
        const user = req.user;
        const storeId = req.params.storeId;
        const r = await queryBus_1.queryBus.execute({
            type: 'item.list',
            storeId,
            tenantId: user.tenantId,
            q: req.query.q,
            categoryId: req.query.categoryId,
            lowStock: req.query.lowStock === 'true',
            expiring: req.query.expiring ? parseInt(req.query.expiring) : undefined,
            page: parseInt(req.query.page) || 1,
            limit: parseInt(req.query.limit) || 50,
            sortBy: req.query.sortBy,
            sortDir: req.query.sortDir,
        });
        ok(res, r.items);
    }
    catch (e) {
        fail(res, e.message);
    }
});
exports.itemRouter.post('/import-invoice-ai', (0, roleGuard_1.requireMinRole)('manager'), async (req, res) => {
    try {
        const { image_base64, mime_type } = req.body;
        if (!image_base64)
            return fail(res, 'image_base64 is required');
        const tenantId = req.user.tenantId;
        const categories = await (0, db_1.query)('SELECT id, name FROM categories WHERE tenant_id=$1', [tenantId]);
        const catList = categories.map(c => `- ID: ${c.id}, Name: ${c.name}`).join('\n');
        const prompt = `Extract all pharmaceutical or inventory items from this invoice image.
Return a JSON array of objects, where each object has these exact keys:
- name (string)
- currentStock (number, quantity)
- mrp (number)
- purchasePrice (number)
- batchNumber (string)
- expiryDate (string, format YYYY-MM-DD or YYYY-MM)
- categoryId (string, strictly matching the best category ID from the list below, or null if none match)
- categoryName (string, the name of the matched category, or null)

Available categories:
${catList}

If a field is missing, use null or an appropriate default. Do not wrap the JSON in markdown code blocks, just return the raw JSON array.`;
        const aiRes = await (0, gemini_service_1.callGemini)({
            prompt,
            imageBase64: image_base64,
            mimeType: mime_type,
            responseMimeType: 'application/json'
        });
        let parsed;
        try {
            parsed = JSON.parse(aiRes.text);
        }
        catch (err) {
            // Fallback for markdown
            const match = aiRes.text.match(/\`\`\`(?:json)?([\s\S]*?)\`\`\`/);
            parsed = match ? JSON.parse(match[1]) : [];
        }
        ok(res, Array.isArray(parsed) ? parsed : []);
    }
    catch (e) {
        fail(res, e.message);
    }
});
exports.itemRouter.get('/low-stock', async (req, res) => {
    try {
        const storeId = req.params.storeId;
        const r = await queryBus_1.queryBus.execute({ type: 'item.lowStock', storeId: storeId, tenantId: req.user.tenantId });
        ok(res, r);
    }
    catch (e) {
        fail(res, e.message);
    }
});
exports.itemRouter.get('/expiring', async (req, res) => {
    try {
        const storeId = req.params.storeId;
        const r = await queryBus_1.queryBus.execute({ type: 'item.expiring', storeId: storeId, tenantId: req.user.tenantId, days: parseInt(req.query.days) || 30 });
        ok(res, r);
    }
    catch (e) {
        fail(res, e.message);
    }
});
exports.itemRouter.post('/', (0, roleGuard_1.requireMinRole)('staff'), async (req, res) => {
    try {
        console.log('i am here post item');
        const body = exports.ItemCreateSchema.parse(req.body);
        const r = await commandBus_1.commandBus.execute({ type: 'item.create', storeId: req.params.storeId, tenantId: req.user.tenantId, createdBy: req.user.sub, ...body });
        ok(res, r, 201);
    }
    catch (e) {
        fail(res, e.message);
    }
});
exports.itemRouter.post('/bulk', (0, roleGuard_1.requireMinRole)('manager'), async (req, res) => {
    try {
        const r = await commandBus_1.commandBus.execute({ type: 'item.bulkCreate', storeId: req.params.storeId, tenantId: req.user.tenantId, createdBy: req.user.sub, ...req.body });
        ok(res, r);
    }
    catch (e) {
        fail(res, e.message);
    }
});
exports.itemRouter.get('/:itemId', async (req, res) => {
    try {
        const storeId = req.params.storeId;
        const r = await queryBus_1.queryBus.execute({ type: 'item.get', itemId: req.params.itemId, storeId: storeId, tenantId: req.user.tenantId });
        ok(res, r);
    }
    catch (e) {
        fail(res, e.message, 404);
    }
});
exports.itemRouter.put('/:itemId', (0, roleGuard_1.requireMinRole)('staff'), async (req, res) => {
    try {
        const r = await commandBus_1.commandBus.execute({ type: 'item.update', itemId: req.params.itemId, storeId: req.params.storeId, tenantId: req.user.tenantId, updatedBy: req.user.sub, ...req.body });
        ok(res, r);
    }
    catch (e) {
        fail(res, e.message);
    }
});
exports.itemRouter.delete('/:itemId', (0, roleGuard_1.requireMinRole)('manager'), async (req, res) => {
    try {
        await commandBus_1.commandBus.execute({ type: 'item.update', itemId: req.params.itemId, storeId: req.params.storeId, tenantId: req.user.tenantId, isActive: false, updatedBy: req.user.sub });
        ok(res, { message: 'Item deactivated' });
    }
    catch (e) {
        fail(res, e.message);
    }
});
// ── Quick Add ──────────────────────────────────────────────────
const QuickCreateSchema = zod_1.z.object({
    name: zod_1.z.string().min(1, 'Name is required'),
    sku: zod_1.z.string().optional(),
    sellingPrice: zod_1.z.number().min(0).optional().default(0),
    currentStock: zod_1.z.number().min(0).optional().default(0),
    discountType: zod_1.z.string().optional().default('none'),
    discountValue: zod_1.z.number().min(0).optional().default(0),
});
exports.itemRouter.post('/quick', (0, roleGuard_1.requireMinRole)('staff'), async (req, res) => {
    try {
        const body = QuickCreateSchema.parse(req.body);
        const autoSku = body.sku || `SKU-${Date.now().toString(36).toUpperCase()}`;
        const r = await commandBus_1.commandBus.execute({
            type: 'item.create',
            storeId: req.params.storeId,
            tenantId: req.user.tenantId,
            createdBy: req.user.sub,
            name: body.name,
            sku: autoSku,
            currentStock: body.currentStock ?? 0,
            reorderLevel: 5,
            sellingPrice: body.sellingPrice ?? 0,
            discountType: body.discountType,
            discountValue: body.discountValue,
        });
        ok(res, r, 201);
    }
    catch (e) {
        fail(res, e.message);
    }
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
exports.itemRouter.get('/import/template', async (_req, res) => {
    const csv = [CSV_HEADERS.join(','), CSV_EXAMPLE.join(',')].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="items_import_template.csv"');
    res.send(csv);
});
// ── CSV Import (JSON rows from parsed CSV) ─────────────────────
function parseNum(v) {
    const n = parseFloat(String(v ?? '').trim());
    return isNaN(n) ? undefined : n;
}
function parseBool(v) {
    return String(v ?? '').trim().toLowerCase() === 'true';
}
exports.itemRouter.post('/import', (0, roleGuard_1.requireMinRole)('manager'), async (req, res) => {
    try {
        const { rows, mode = 'upsert' } = req.body;
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
            categoryId: String(r.categoryId ?? '').trim() || undefined,
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
        const r = await commandBus_1.commandBus.execute({
            type: 'item.bulkCreate',
            storeId: req.params.storeId,
            tenantId: req.user.tenantId,
            createdBy: req.user.sub,
            items,
            mode,
        });
        ok(res, r);
    }
    catch (e) {
        fail(res, e.message);
    }
});
exports.itemRouter.get('/:itemId/ledger', async (req, res) => {
    try {
        const storeId = req.params.storeId;
        const user = req.user;
        const result = await queryBus_1.queryBus.execute({
            type: 'item.get',
            itemId: req.params.itemId,
            storeId: storeId,
            tenantId: user.tenantId,
        });
        ok(res, result);
    }
    catch (e) {
        fail(res, e.message);
    }
});
