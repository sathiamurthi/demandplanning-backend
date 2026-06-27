// ============================================================
// ALERTS MODULE — Full CQRS
// ============================================================
import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../../config/db';
import { commandBus, ICommand, ICommandHandler } from '../../cqrs/commandBus';
import { queryBus, IQuery, IQueryHandler } from '../../cqrs/queryBus';
import { authMiddleware } from './auth.service';
import { requireMinRole, requireRole } from '../../core/guards/roleGuard';
import { AlertType, AlertSeverity } from '../../types';

function ok(res: any, data: any, status = 200) {
  res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
}
function fail(res: any, msg: string, status = 400) {
  res.status(status).json({ success: false, error: msg, timestamp: new Date().toISOString() });
}

// ── Commands ──────────────────────────────────────────────────

interface CreateAlertCommand extends ICommand {
  readonly type: 'alert.create';
  storeId: string;
  tenantId: string;
  itemId?: string;
  alertType: AlertType;
  message: string;
  severity: AlertSeverity;
}

class CreateAlertCommandHandler implements ICommandHandler<CreateAlertCommand> {
  async execute(cmd: CreateAlertCommand) {
    const [alert] = await query<any>(
      `INSERT INTO ai_alerts (store_id, tenant_id, item_id, alert_type, message, severity)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [cmd.storeId, cmd.tenantId, cmd.itemId || null, cmd.alertType, cmd.message, cmd.severity]
    );
    return alert;
  }
}

interface MarkReadCommand extends ICommand {
  readonly type: 'alert.markRead';
  alertId: string;
  tenantId: string;
  userId: string;
}

class MarkReadCommandHandler implements ICommandHandler<MarkReadCommand> {
  async execute(cmd: MarkReadCommand) {
    const [alert] = await query<any>(
      `UPDATE ai_alerts
       SET is_read=TRUE, read_by=$1, read_at=NOW()
       WHERE id=$2 AND tenant_id=$3
       RETURNING *`,
      [cmd.userId, cmd.alertId, cmd.tenantId]
    );
    if (!alert) throw new Error('Alert not found or access denied');
    return alert;
  }
}

interface MarkAllReadCommand extends ICommand {
  readonly type: 'alert.markAllRead';
  storeId?: string;
  tenantId: string;
  userId: string;
  alertType?: AlertType;
  severity?: AlertSeverity;
}

class MarkAllReadCommandHandler implements ICommandHandler<MarkAllReadCommand> {
  async execute(cmd: MarkAllReadCommand) {
    const conds = ['tenant_id=$1', 'is_read=FALSE'];
    const vals: any[] = [cmd.tenantId]; let i = 2;
    if (cmd.storeId)    { conds.push(`store_id=$${i++}`);    vals.push(cmd.storeId); }
    if (cmd.alertType)  { conds.push(`alert_type=$${i++}`);  vals.push(cmd.alertType); }
    if (cmd.severity)   { conds.push(`severity=$${i++}`);    vals.push(cmd.severity); }
    vals.push(cmd.userId);
    const result = await query<any>(
      `UPDATE ai_alerts SET is_read=TRUE, read_by=$${i}, read_at=NOW()
       WHERE ${conds.join(' AND ')} RETURNING id`,
      vals
    );
    return { updated: result.length, message: `${result.length} alert(s) marked as read` };
  }
}

interface DeleteAlertCommand extends ICommand {
  readonly type: 'alert.delete';
  alertId: string;
  tenantId: string;
}

class DeleteAlertCommandHandler implements ICommandHandler<DeleteAlertCommand> {
  async execute(cmd: DeleteAlertCommand) {
    const result = await query<any>(
      `DELETE FROM ai_alerts WHERE id=$1 AND tenant_id=$2 RETURNING id`,
      [cmd.alertId, cmd.tenantId]
    );
    if (!result.length) throw new Error('Alert not found or access denied');
    return { message: 'Alert deleted', id: cmd.alertId };
  }
}

interface ScanAndCreateAlertsCommand extends ICommand {
  readonly type: 'alert.scan';
  storeId: string;
  tenantId: string;
}

class ScanAndCreateAlertsCommandHandler implements ICommandHandler<ScanAndCreateAlertsCommand> {
  async execute(cmd: ScanAndCreateAlertsCommand) {
    const config = await queryOne<any>(
      `SELECT ic.* FROM stores s
       JOIN tenants t ON t.id=s.tenant_id
       JOIN industry_configs ic ON ic.industry_id=t.industry_id
       WHERE s.id=$1`,
      [cmd.storeId]
    );

    return withTransaction(async (client) => {
      let created = 0;

      // Scan 1: Low stock
      const lowStockItems = await client.query(
        `SELECT * FROM items
         WHERE store_id=$1 AND tenant_id=$2 AND is_active=TRUE
           AND current_stock <= reorder_level`,
        [cmd.storeId, cmd.tenantId]
      ).then(r => r.rows);

      for (const item of lowStockItems) {
        const exists = await client.query(
          `SELECT id FROM ai_alerts WHERE item_id=$1 AND alert_type='low_stock' AND is_read=FALSE`,
          [item.id]
        ).then(r => r.rows[0]);
        if (!exists) {
          const severity = item.current_stock === 0 ? 'critical' : parseFloat(item.current_stock) < parseFloat(item.reorder_level) * 0.5 ? 'critical' : 'warning';
          await client.query(
            `INSERT INTO ai_alerts (store_id, tenant_id, item_id, alert_type, message, severity)
             VALUES ($1,$2,$3,'low_stock',$4,$5)`,
            [cmd.storeId, cmd.tenantId, item.id,
             `Low stock: "${item.name}" — ${item.current_stock} ${item.unit || ''} remaining (reorder at ${item.reorder_level})`,
             severity]
          );
          created++;
        }
      }

      // Scan 2: Expiring items
      const expiryDays = config?.expiry_warn_days || 30;
      const expiringItems = await client.query(
        `SELECT * FROM items
         WHERE store_id=$1 AND tenant_id=$2 AND is_active=TRUE
           AND expiry_date IS NOT NULL
           AND expiry_date <= NOW() + INTERVAL '${expiryDays} days'
           AND expiry_date > NOW()`,
        [cmd.storeId, cmd.tenantId]
      ).then(r => r.rows);

      for (const item of expiringItems) {
        const daysLeft = Math.ceil((new Date(item.expiry_date).getTime() - Date.now()) / 86400000);
        const exists = await client.query(
          `SELECT id FROM ai_alerts WHERE item_id=$1 AND alert_type='expiry' AND is_read=FALSE`,
          [item.id]
        ).then(r => r.rows[0]);
        if (!exists) {
          await client.query(
            `INSERT INTO ai_alerts (store_id, tenant_id, item_id, alert_type, message, severity)
             VALUES ($1,$2,$3,'expiry',$4,$5)`,
            [cmd.storeId, cmd.tenantId, item.id,
             `Expiring soon: "${item.name}" — expires in ${daysLeft} day(s) on ${new Date(item.expiry_date).toLocaleDateString('en-IN')}`,
             daysLeft <= 7 ? 'critical' : 'warning']
          );
          created++;
        }
      }

      // Scan 3: Overstock (current_stock > max_stock_level * 1.2)
      const overstockItems = await client.query(
        `SELECT * FROM items
         WHERE store_id=$1 AND tenant_id=$2 AND is_active=TRUE
           AND max_stock_level IS NOT NULL
           AND current_stock > max_stock_level * 1.2`,
        [cmd.storeId, cmd.tenantId]
      ).then(r => r.rows);

      for (const item of overstockItems) {
        const exists = await client.query(
          `SELECT id FROM ai_alerts WHERE item_id=$1 AND alert_type='overstock' AND is_read=FALSE`,
          [item.id]
        ).then(r => r.rows[0]);
        if (!exists) {
          await client.query(
            `INSERT INTO ai_alerts (store_id, tenant_id, item_id, alert_type, message, severity)
             VALUES ($1,$2,$3,'overstock',$4,'info')`,
            [cmd.storeId, cmd.tenantId, item.id,
             `Overstock: "${item.name}" — ${item.current_stock} units vs max ${item.max_stock_level}`]
          );
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

// ── Queries ───────────────────────────────────────────────────

interface ListAlertsQuery extends IQuery {
  readonly type: 'alert.list';
  tenantId: string;
  storeId?: string;
  unreadOnly?: boolean;
  alertType?: AlertType;
  severity?: AlertSeverity;
  page: number;
  limit: number;
}

class ListAlertsQueryHandler implements IQueryHandler<ListAlertsQuery, any> {
  async execute(q: ListAlertsQuery) {
    const conds = ['aa.tenant_id=$1'];
    const vals: any[] = [q.tenantId]; let i = 2;
    if (q.storeId)    { conds.push(`aa.store_id=$${i++}`);    vals.push(q.storeId); }
    if (q.unreadOnly) { conds.push('aa.is_read=FALSE'); }
    if (q.alertType)  { conds.push(`aa.alert_type=$${i++}`);  vals.push(q.alertType); }
    if (q.severity)   { conds.push(`aa.severity=$${i++}`);    vals.push(q.severity); }
    const where = `WHERE ${conds.join(' AND ')}`;
    const [{ count }] = await query<any>(`SELECT COUNT(*) FROM ai_alerts aa ${where}`, vals);
    const offset = (q.page - 1) * q.limit;
    vals.push(q.limit, offset);
    const items = await query<any>(
      `SELECT aa.*,
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
       LIMIT $${i} OFFSET $${i+1}`,
      vals
    );
    const unreadCount = await queryOne<any>(
      `SELECT COUNT(*)::int as count FROM ai_alerts WHERE tenant_id=$1 AND is_read=FALSE`,
      [q.tenantId]
    );
    return {
      items, total: parseInt(count), page: q.page, limit: q.limit,
      pages: Math.ceil(parseInt(count) / q.limit),
      unreadCount: unreadCount?.count || 0,
    };
  }
}

interface GetAlertSummaryQuery extends IQuery {
  readonly type: 'alert.summary';
  tenantId: string;
  storeId?: string;
}

class GetAlertSummaryQueryHandler implements IQueryHandler<GetAlertSummaryQuery, any> {
  async execute(q: GetAlertSummaryQuery) {
    const storeFilter = q.storeId ? `AND aa.store_id='${q.storeId}'` : '';
    return queryOne<any>(
      `SELECT
         COUNT(aa.id)::int as total,
         COUNT(aa.id) FILTER (WHERE aa.is_read=FALSE)::int as unread,
         COUNT(aa.id) FILTER (WHERE aa.severity='critical' AND aa.is_read=FALSE)::int as critical_unread,
         COUNT(aa.id) FILTER (WHERE aa.severity='warning' AND aa.is_read=FALSE)::int as warning_unread,
         COUNT(aa.id) FILTER (WHERE aa.alert_type='low_stock' AND aa.is_read=FALSE)::int as low_stock_count,
         COUNT(aa.id) FILTER (WHERE aa.alert_type='expiry' AND aa.is_read=FALSE)::int as expiry_count,
         COUNT(aa.id) FILTER (WHERE aa.alert_type='reorder' AND aa.is_read=FALSE)::int as reorder_count,
         COUNT(aa.id) FILTER (WHERE aa.alert_type='overstock' AND aa.is_read=FALSE)::int as overstock_count
       FROM ai_alerts aa
       WHERE aa.tenant_id=$1 ${storeFilter}`,
      [q.tenantId]
    );
  }
}

// ── Register ──────────────────────────────────────────────────
commandBus.register('alert.create',      new CreateAlertCommandHandler());
commandBus.register('alert.markRead',    new MarkReadCommandHandler());
commandBus.register('alert.markAllRead', new MarkAllReadCommandHandler());
commandBus.register('alert.delete',      new DeleteAlertCommandHandler());
commandBus.register('alert.scan',        new ScanAndCreateAlertsCommandHandler());
queryBus.register('alert.list',          new ListAlertsQueryHandler());
queryBus.register('alert.summary',       new GetAlertSummaryQueryHandler());

// ── Router ────────────────────────────────────────────────────
export const alertRouter = Router();
alertRouter.use(authMiddleware);

const CreateAlertSchema = z.object({
  storeId: z.string().uuid(),
  itemId: z.string().uuid().optional(),
  alertType: z.enum(['low_stock','expiry','seasonal','reorder','overstock']),
  message: z.string().min(5),
  severity: z.enum(['info','warning','critical']),
});

// GET /v1/alerts — list with filters
alertRouter.get('/', async (req, res) => {
  try {
    const user = (req as any).user;
    const r = await queryBus.execute<any>({
      type: 'alert.list',
      tenantId: user.tenantId,
      storeId: req.query.storeId as string,
      unreadOnly: req.query.unread === 'true',
      alertType: req.query.alertType as AlertType,
      severity: req.query.severity as AlertSeverity,
      page: parseInt(req.query.page as string) || 1,
      limit: parseInt(req.query.limit as string) || 50,
    });
    ok(res, r);
  } catch (e: any) { fail(res, e.message); }
});

// GET /v1/alerts/summary
alertRouter.get('/summary', async (req, res) => {
  try {
    const user = (req as any).user;
    const r = await queryBus.execute<any>({
      type: 'alert.summary',
      tenantId: user.tenantId,
      storeId: req.query.storeId as string,
    });
    ok(res, r);
  } catch (e: any) { fail(res, e.message); }
});

// POST /v1/alerts — manually create an alert [manager+]
alertRouter.post('/', requireMinRole('manager'), async (req, res) => {
  try {
    const user = (req as any).user;
    const body = CreateAlertSchema.parse(req.body);
    const r = await commandBus.execute<any>({
      type: 'alert.create', tenantId: user.tenantId, ...body,
    });
    ok(res, r, 201);
  } catch (e: any) { fail(res, e.message); }
});

// POST /v1/alerts/scan — trigger stock + expiry scan for a store
alertRouter.post('/scan', requireMinRole('manager'), async (req, res) => {
  try {
    const user = (req as any).user;
    const { storeId } = z.object({ storeId: z.string().uuid() }).parse(req.body);
    const r = await commandBus.execute<any>({
      type: 'alert.scan', storeId, tenantId: user.tenantId,
    });
    ok(res, r);
  } catch (e: any) { fail(res, e.message); }
});

// PUT /v1/alerts/read-all — mark all read (optionally filtered)
alertRouter.put('/read-all', async (req, res) => {
  try {
    const user = (req as any).user;
    const r = await commandBus.execute<any>({
      type: 'alert.markAllRead',
      tenantId: user.tenantId,
      storeId: req.body.storeId,
      alertType: req.body.alertType,
      severity: req.body.severity,
      userId: user.sub,
    });
    ok(res, r);
  } catch (e: any) { fail(res, e.message); }
});

// PUT /v1/alerts/:alertId/read
alertRouter.put('/:alertId/read', async (req, res) => {
  try {
    const user = (req as any).user;
    const r = await commandBus.execute<any>({
      type: 'alert.markRead',
      alertId: req.params.alertId,
      tenantId: user.tenantId,
      userId: user.sub,
    });
    ok(res, r);
  } catch (e: any) { fail(res, e.message); }
});

// DELETE /v1/alerts/:alertId [manager+]
alertRouter.delete('/:alertId', requireMinRole('manager'), async (req, res) => {
  try {
    const user = (req as any).user;
    const r = await commandBus.execute<any>({
      type: 'alert.delete',
      alertId: req.params.alertId,
      tenantId: user.tenantId,
    });
    ok(res, r);
  } catch (e: any) { fail(res, e.message); }
});