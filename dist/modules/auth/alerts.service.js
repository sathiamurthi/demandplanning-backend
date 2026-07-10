"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.alertRouter = void 0;
// ============================================================
// ALERTS MODULE — Full CQRS
// ============================================================
const express_1 = require("express");
const zod_1 = require("zod");
const db_1 = require("../../config/db");
const commandBus_1 = require("../../cqrs/commandBus");
const queryBus_1 = require("../../cqrs/queryBus");
const auth_service_1 = require("./auth.service");
const roleGuard_1 = require("../../core/guards/roleGuard");
function ok(res, data, status = 200) {
    res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
}
function fail(res, msg, status = 400) {
    res.status(status).json({ success: false, error: msg, timestamp: new Date().toISOString() });
}
class CreateAlertCommandHandler {
    async execute(cmd) {
        const [alert] = await (0, db_1.query)(`INSERT INTO ai_alerts (store_id, tenant_id, item_id, alert_type, message, severity)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [cmd.storeId, cmd.tenantId, cmd.itemId || null, cmd.alertType, cmd.message, cmd.severity]);
        return alert;
    }
}
class MarkReadCommandHandler {
    async execute(cmd) {
        const [alert] = await (0, db_1.query)(`UPDATE ai_alerts
       SET is_read=TRUE, read_by=$1, read_at=NOW()
       WHERE id=$2 AND tenant_id=$3
       RETURNING *`, [cmd.userId, cmd.alertId, cmd.tenantId]);
        if (!alert)
            throw new Error('Alert not found or access denied');
        return alert;
    }
}
class MarkAllReadCommandHandler {
    async execute(cmd) {
        const conds = ['tenant_id=$1', 'is_read=FALSE'];
        const vals = [cmd.tenantId];
        let i = 2;
        if (cmd.storeId) {
            conds.push(`store_id=$${i++}`);
            vals.push(cmd.storeId);
        }
        if (cmd.alertType) {
            conds.push(`alert_type=$${i++}`);
            vals.push(cmd.alertType);
        }
        if (cmd.severity) {
            conds.push(`severity=$${i++}`);
            vals.push(cmd.severity);
        }
        vals.push(cmd.userId);
        const result = await (0, db_1.query)(`UPDATE ai_alerts SET is_read=TRUE, read_by=$${i}, read_at=NOW()
       WHERE ${conds.join(' AND ')} RETURNING id`, vals);
        return { updated: result.length, message: `${result.length} alert(s) marked as read` };
    }
}
class DeleteAlertCommandHandler {
    async execute(cmd) {
        const result = await (0, db_1.query)(`DELETE FROM ai_alerts WHERE id=$1 AND tenant_id=$2 RETURNING id`, [cmd.alertId, cmd.tenantId]);
        if (!result.length)
            throw new Error('Alert not found or access denied');
        return { message: 'Alert deleted', id: cmd.alertId };
    }
}
class ScanAndCreateAlertsCommandHandler {
    async execute(cmd) {
        const config = await (0, db_1.queryOne)(`SELECT ic.* FROM stores s
       JOIN tenants t ON t.id=s.tenant_id
       JOIN industry_configs ic ON ic.industry_id=t.industry_id
       WHERE s.id=$1`, [cmd.storeId]);
        return (0, db_1.withTransaction)(async (client) => {
            let created = 0;
            // Scan 1: Low stock
            const lowStockItems = await client.query(`SELECT * FROM items
         WHERE store_id=$1 AND tenant_id=$2 AND is_active=TRUE
           AND current_stock <= reorder_level`, [cmd.storeId, cmd.tenantId]).then(r => r.rows);
            for (const item of lowStockItems) {
                const exists = await client.query(`SELECT id FROM ai_alerts WHERE item_id=$1 AND alert_type='low_stock' AND is_read=FALSE`, [item.id]).then(r => r.rows[0]);
                if (!exists) {
                    const severity = item.current_stock === 0 ? 'critical' : parseFloat(item.current_stock) < parseFloat(item.reorder_level) * 0.5 ? 'critical' : 'warning';
                    await client.query(`INSERT INTO ai_alerts (store_id, tenant_id, item_id, alert_type, message, severity)
             VALUES ($1,$2,$3,'low_stock',$4,$5)`, [cmd.storeId, cmd.tenantId, item.id,
                        `Low stock: "${item.name}" — ${item.current_stock} ${item.unit || ''} remaining (reorder at ${item.reorder_level})`,
                        severity]);
                    created++;
                }
            }
            // Scan 2: Expiring items
            const expiryDays = config?.expiry_warn_days || 30;
            const expiringItems = await client.query(`SELECT * FROM items
         WHERE store_id=$1 AND tenant_id=$2 AND is_active=TRUE
           AND expiry_date IS NOT NULL
           AND expiry_date <= NOW() + INTERVAL '${expiryDays} days'
           AND expiry_date > NOW()`, [cmd.storeId, cmd.tenantId]).then(r => r.rows);
            for (const item of expiringItems) {
                const daysLeft = Math.ceil((new Date(item.expiry_date).getTime() - Date.now()) / 86400000);
                const exists = await client.query(`SELECT id FROM ai_alerts WHERE item_id=$1 AND alert_type='expiry' AND is_read=FALSE`, [item.id]).then(r => r.rows[0]);
                if (!exists) {
                    await client.query(`INSERT INTO ai_alerts (store_id, tenant_id, item_id, alert_type, message, severity)
             VALUES ($1,$2,$3,'expiry',$4,$5)`, [cmd.storeId, cmd.tenantId, item.id,
                        `Expiring soon: "${item.name}" — expires in ${daysLeft} day(s) on ${new Date(item.expiry_date).toLocaleDateString('en-IN')}`,
                        daysLeft <= 7 ? 'critical' : 'warning']);
                    created++;
                }
            }
            // Scan 3: Overstock (current_stock > max_stock_level * 1.2)
            const overstockItems = await client.query(`SELECT * FROM items
         WHERE store_id=$1 AND tenant_id=$2 AND is_active=TRUE
           AND max_stock_level IS NOT NULL
           AND current_stock > max_stock_level * 1.2`, [cmd.storeId, cmd.tenantId]).then(r => r.rows);
            for (const item of overstockItems) {
                const exists = await client.query(`SELECT id FROM ai_alerts WHERE item_id=$1 AND alert_type='overstock' AND is_read=FALSE`, [item.id]).then(r => r.rows[0]);
                if (!exists) {
                    await client.query(`INSERT INTO ai_alerts (store_id, tenant_id, item_id, alert_type, message, severity)
             VALUES ($1,$2,$3,'overstock',$4,'info')`, [cmd.storeId, cmd.tenantId, item.id,
                        `Overstock: "${item.name}" — ${item.current_stock} units vs max ${item.max_stock_level}`]);
                    created++;
                }
            }
            return {
                created,
                lowStock: lowStockItems.length,
                expiring: expiringItems.length,
                overstock: overstockItems.length,
                message: `Scan complete — ${created} new alert(s) created`,
            };
        });
    }
}
class ListAlertsQueryHandler {
    async execute(q) {
        const conds = ['aa.tenant_id=$1'];
        const vals = [q.tenantId];
        let i = 2;
        if (q.storeId) {
            conds.push(`aa.store_id=$${i++}`);
            vals.push(q.storeId);
        }
        if (q.unreadOnly) {
            conds.push('aa.is_read=FALSE');
        }
        if (q.alertType) {
            conds.push(`aa.alert_type=$${i++}`);
            vals.push(q.alertType);
        }
        if (q.severity) {
            conds.push(`aa.severity=$${i++}`);
            vals.push(q.severity);
        }
        const where = `WHERE ${conds.join(' AND ')}`;
        const [{ count }] = await (0, db_1.query)(`SELECT COUNT(*) FROM ai_alerts aa ${where}`, vals);
        const offset = (q.page - 1) * q.limit;
        vals.push(q.limit, offset);
        const items = await (0, db_1.query)(`SELECT aa.*,
              i.name as item_name, i.current_stock, i.reorder_level,
              s.name as store_name,
              u.first_name||' '||u.last_name as read_by_name
       FROM ai_alerts aa
       LEFT JOIN items i ON i.id=aa.item_id
       LEFT JOIN stores s ON s.id=aa.store_id
       LEFT JOIN users u ON u.id=aa.read_by
       ${where}
       ORDER BY
         CASE aa.severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
         aa.created_at DESC
       LIMIT $${i} OFFSET $${i + 1}`, vals);
        const unreadCount = await (0, db_1.queryOne)(`SELECT COUNT(*)::int as count FROM ai_alerts WHERE tenant_id=$1 AND is_read=FALSE`, [q.tenantId]);
        return {
            items, total: parseInt(count), page: q.page, limit: q.limit,
            pages: Math.ceil(parseInt(count) / q.limit),
            unreadCount: unreadCount?.count || 0,
        };
    }
}
class GetAlertSummaryQueryHandler {
    async execute(q) {
        const storeFilter = q.storeId ? `AND aa.store_id='${q.storeId}'` : '';
        return (0, db_1.queryOne)(`SELECT
         COUNT(aa.id)::int as total,
         COUNT(aa.id) FILTER (WHERE aa.is_read=FALSE)::int as unread,
         COUNT(aa.id) FILTER (WHERE aa.severity='critical' AND aa.is_read=FALSE)::int as critical_unread,
         COUNT(aa.id) FILTER (WHERE aa.severity='warning' AND aa.is_read=FALSE)::int as warning_unread,
         COUNT(aa.id) FILTER (WHERE aa.alert_type='low_stock' AND aa.is_read=FALSE)::int as low_stock_count,
         COUNT(aa.id) FILTER (WHERE aa.alert_type='expiry' AND aa.is_read=FALSE)::int as expiry_count,
         COUNT(aa.id) FILTER (WHERE aa.alert_type='reorder' AND aa.is_read=FALSE)::int as reorder_count,
         COUNT(aa.id) FILTER (WHERE aa.alert_type='overstock' AND aa.is_read=FALSE)::int as overstock_count
       FROM ai_alerts aa
       WHERE aa.tenant_id=$1 ${storeFilter}`, [q.tenantId]);
    }
}
// ── Register ──────────────────────────────────────────────────
commandBus_1.commandBus.register('alert.create', new CreateAlertCommandHandler());
commandBus_1.commandBus.register('alert.markRead', new MarkReadCommandHandler());
commandBus_1.commandBus.register('alert.markAllRead', new MarkAllReadCommandHandler());
commandBus_1.commandBus.register('alert.delete', new DeleteAlertCommandHandler());
commandBus_1.commandBus.register('alert.scan', new ScanAndCreateAlertsCommandHandler());
queryBus_1.queryBus.register('alert.list', new ListAlertsQueryHandler());
queryBus_1.queryBus.register('alert.summary', new GetAlertSummaryQueryHandler());
// ── Router ────────────────────────────────────────────────────
exports.alertRouter = (0, express_1.Router)();
exports.alertRouter.use(auth_service_1.authMiddleware);
const CreateAlertSchema = zod_1.z.object({
    storeId: zod_1.z.string().uuid(),
    itemId: zod_1.z.string().uuid().optional(),
    alertType: zod_1.z.enum(['low_stock', 'expiry', 'seasonal', 'reorder', 'overstock']),
    message: zod_1.z.string().min(5),
    severity: zod_1.z.enum(['info', 'warning', 'critical']),
});
// GET /v1/alerts — list with filters
exports.alertRouter.get('/', async (req, res) => {
    try {
        const user = req.user;
        const r = await queryBus_1.queryBus.execute({
            type: 'alert.list',
            tenantId: user.tenantId,
            storeId: req.query.storeId,
            unreadOnly: req.query.unread === 'true',
            alertType: req.query.alertType,
            severity: req.query.severity,
            page: parseInt(req.query.page) || 1,
            limit: parseInt(req.query.limit) || 50,
        });
        ok(res, r);
    }
    catch (e) {
        fail(res, e.message);
    }
});
// GET /v1/alerts/summary
exports.alertRouter.get('/summary', async (req, res) => {
    try {
        const user = req.user;
        const r = await queryBus_1.queryBus.execute({
            type: 'alert.summary',
            tenantId: user.tenantId,
            storeId: req.query.storeId,
        });
        ok(res, r);
    }
    catch (e) {
        fail(res, e.message);
    }
});
// POST /v1/alerts — manually create an alert [manager+]
exports.alertRouter.post('/', (0, roleGuard_1.requireMinRole)('manager'), async (req, res) => {
    try {
        const user = req.user;
        const body = CreateAlertSchema.parse(req.body);
        const r = await commandBus_1.commandBus.execute({
            type: 'alert.create', tenantId: user.tenantId, ...body,
        });
        ok(res, r, 201);
    }
    catch (e) {
        fail(res, e.message);
    }
});
// POST /v1/alerts/scan — trigger stock + expiry scan for a store
exports.alertRouter.post('/scan', (0, roleGuard_1.requireMinRole)('manager'), async (req, res) => {
    try {
        const user = req.user;
        const { storeId } = zod_1.z.object({ storeId: zod_1.z.string().uuid() }).parse(req.body);
        const r = await commandBus_1.commandBus.execute({
            type: 'alert.scan', storeId, tenantId: user.tenantId,
        });
        ok(res, r);
    }
    catch (e) {
        fail(res, e.message);
    }
});
// PUT /v1/alerts/read-all — mark all read (optionally filtered)
exports.alertRouter.put('/read-all', async (req, res) => {
    try {
        const user = req.user;
        const r = await commandBus_1.commandBus.execute({
            type: 'alert.markAllRead',
            tenantId: user.tenantId,
            storeId: req.body.storeId,
            alertType: req.body.alertType,
            severity: req.body.severity,
            userId: user.sub,
        });
        ok(res, r);
    }
    catch (e) {
        fail(res, e.message);
    }
});
// PUT /v1/alerts/:alertId/read
exports.alertRouter.put('/:alertId/read', async (req, res) => {
    try {
        const user = req.user;
        const r = await commandBus_1.commandBus.execute({
            type: 'alert.markRead',
            alertId: req.params.alertId,
            tenantId: user.tenantId,
            userId: user.sub,
        });
        ok(res, r);
    }
    catch (e) {
        fail(res, e.message);
    }
});
// DELETE /v1/alerts/:alertId [manager+]
exports.alertRouter.delete('/:alertId', (0, roleGuard_1.requireMinRole)('manager'), async (req, res) => {
    try {
        const user = req.user;
        const r = await commandBus_1.commandBus.execute({
            type: 'alert.delete',
            alertId: req.params.alertId,
            tenantId: user.tenantId,
        });
        ok(res, r);
    }
    catch (e) {
        fail(res, e.message);
    }
});
