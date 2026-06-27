// ============================================================
// TENANTS MODULE — Full CQRS + Router
// ============================================================
import { Router } from 'express';
import { z } from 'zod';
import * as bcrypt from 'bcryptjs';
import { query, queryOne, withTransaction } from '../../config/db';
import { commandBus, ICommand, ICommandHandler } from '../../cqrs/commandBus';
import { queryBus, IQuery, IQueryHandler } from '../../cqrs/queryBus';
import { authMiddleware } from '../auth/auth.service';
import { requireRole, requireTenantAccess } from '../../core/guards/roleGuard';
import { ApiResponse, PaginatedResponse, PlanType, BillingStatus } from '../../types';

function ok<T>(res: any, data: T, status = 200) {
  res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
}
function fail(res: any, msg: string, status = 400) {
  res.status(status).json({ success: false, error: msg, timestamp: new Date().toISOString() });
}

// ── Commands ─────────────────────────────────────────────────

interface CreateTenantCommand extends ICommand {
  readonly type: 'tenant.create';
  name: string; slug: string; industryId: string; planType: PlanType;
  billingEmail: string; billingPhone?: string; gstNumber?: string;
  city?: string; state?: string; pincode?: string;
  ownerEmail: string; ownerPassword: string;
  ownerFirstName: string; ownerLastName: string;
  createdBy: string;
}

class CreateTenantCommandHandler implements ICommandHandler<CreateTenantCommand> {
  async execute(cmd: CreateTenantCommand) {
    const slugExists = await queryOne('SELECT id FROM tenants WHERE slug = $1', [cmd.slug]);
    if (slugExists) throw new Error(`Slug "${cmd.slug}" already taken`);
    const emailExists = await queryOne('SELECT id FROM users WHERE email = $1', [cmd.ownerEmail.toLowerCase()]);
    if (emailExists) throw new Error('Owner email already registered');

    return withTransaction(async (client) => {
      // 1. Create tenant
      const trialEndsAt = new Date(Date.now() + 14 * 86400 * 1000);
      const [tenant] = await client.query(
        `INSERT INTO tenants (name,slug,industry_id,plan_type,billing_status,trial_ends_at,billing_email,billing_phone,gst_number,city,state,pincode,created_by)
         VALUES ($1,$2,$3,$4,'trial',$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [cmd.name,cmd.slug,cmd.industryId,cmd.planType,trialEndsAt,cmd.billingEmail,
         cmd.billingPhone||null,cmd.gstNumber||null,cmd.city||null,cmd.state||null,
         cmd.pincode||null,cmd.createdBy]
      ).then(r => r.rows);

      // 2. Create default store
      const [store] = await client.query(
        `INSERT INTO stores (tenant_id,name,city,state) VALUES ($1,$2,$3,$4) RETURNING id`,
        [tenant.id, cmd.name + ' Store 1', cmd.city||null, cmd.state||null]
      ).then(r => r.rows);

      // 3. Create owner user
      const passwordHash = await bcrypt.hash(cmd.ownerPassword, 10);
      const [owner] = await client.query(
        `INSERT INTO users (tenant_id,store_id,email,password_hash,role,first_name,last_name,is_active,is_email_verified)
         VALUES ($1,$2,$3,$4,'owner',$5,$6,TRUE,FALSE) RETURNING id,email,role`,
        [tenant.id,null,cmd.ownerEmail.toLowerCase(),passwordHash,cmd.ownerFirstName,cmd.ownerLastName]
      ).then(r => r.rows);

      // 4. Create subscription
      const plan = await client.query('SELECT * FROM billing_plans WHERE plan_type=$1',[cmd.planType]).then(r=>r.rows[0]);
      await client.query(
        `INSERT INTO tenant_subscriptions (tenant_id,plan_type,amount_inr,starts_at,renews_at)
         VALUES ($1,$2,$3,NOW(),NOW() + INTERVAL '1 month')`,
        [tenant.id, cmd.planType, plan?.price_monthly_inr || 0]
      );

      return { tenant, store, owner };
    });
  }
}

interface UpdateTenantCommand extends ICommand {
  readonly type: 'tenant.update';
  tenantId: string; name?: string; billingEmail?: string;
  billingPhone?: string; gstNumber?: string; city?: string;
  state?: string; pincode?: string; logoUrl?: string; timezone?: string;
}
class UpdateTenantCommandHandler implements ICommandHandler<UpdateTenantCommand> {
  async execute(cmd: UpdateTenantCommand) {
    const sets: string[] = []; const vals: any[] = [];
    let i = 1;
    if (cmd.name)         { sets.push(`name=$${i++}`);          vals.push(cmd.name); }
    if (cmd.billingEmail) { sets.push(`billing_email=$${i++}`); vals.push(cmd.billingEmail); }
    if (cmd.billingPhone) { sets.push(`billing_phone=$${i++}`); vals.push(cmd.billingPhone); }
    if (cmd.gstNumber)    { sets.push(`gst_number=$${i++}`);    vals.push(cmd.gstNumber); }
    if (cmd.city)         { sets.push(`city=$${i++}`);          vals.push(cmd.city); }
    if (cmd.state)        { sets.push(`state=$${i++}`);         vals.push(cmd.state); }
    if (cmd.pincode)      { sets.push(`pincode=$${i++}`);       vals.push(cmd.pincode); }
    if (cmd.logoUrl)      { sets.push(`logo_url=$${i++}`);      vals.push(cmd.logoUrl); }
    if (cmd.timezone)     { sets.push(`timezone=$${i++}`);      vals.push(cmd.timezone); }
    sets.push(`updated_at=NOW()`);
    vals.push(cmd.tenantId);
    const [updated] = await query(`UPDATE tenants SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, vals);
    if (!updated) throw new Error('Tenant not found');
    return updated;
  }
}

interface UpgradePlanCommand extends ICommand {
  readonly type: 'tenant.upgradePlan';
  tenantId: string; planType: PlanType; billingCycle: 'monthly'|'yearly';
  paymentMethod?: string; externalSubId?: string;
}
class UpgradePlanCommandHandler implements ICommandHandler<UpgradePlanCommand> {
  async execute(cmd: UpgradePlanCommand) {
    const plan = await queryOne<any>('SELECT * FROM billing_plans WHERE plan_type=$1', [cmd.planType]);
    if (!plan) throw new Error('Plan not found');
    const amount = cmd.billingCycle === 'yearly' ? plan.price_yearly_inr : plan.price_monthly_inr;
    return withTransaction(async (client) => {
      await client.query(`UPDATE tenant_subscriptions SET is_current=FALSE WHERE tenant_id=$1`, [cmd.tenantId]);
      await client.query(
        `INSERT INTO tenant_subscriptions (tenant_id,plan_type,billing_cycle,amount_inr,starts_at,renews_at,payment_method,external_sub_id)
         VALUES ($1,$2,$3,$4,NOW(), NOW() + INTERVAL '1 ${cmd.billingCycle === 'yearly' ? 'year' : 'month'}', $5,$6)`,
        [cmd.tenantId,cmd.planType,cmd.billingCycle,amount,cmd.paymentMethod||null,cmd.externalSubId||null]
      );
      const [tenant] = await client.query(
        `UPDATE tenants SET plan_type=$1, billing_status='active', updated_at=NOW() WHERE id=$2 RETURNING *`,
        [cmd.planType, cmd.tenantId]
      ).then(r=>r.rows);
      return tenant;
    });
  }
}

interface DeactivateTenantCommand extends ICommand {
  readonly type: 'tenant.deactivate';
  tenantId: string;
}
class DeactivateTenantCommandHandler implements ICommandHandler<DeactivateTenantCommand> {
  async execute(cmd: DeactivateTenantCommand) {
    await query(`UPDATE tenants SET is_active=FALSE, billing_status='cancelled', updated_at=NOW() WHERE id=$1`, [cmd.tenantId]);
    return { message: 'Tenant deactivated' };
  }
}

// ── Queries ──────────────────────────────────────────────────

interface ListTenantsQuery extends IQuery {
  readonly type: 'tenant.list';
  page: number; limit: number; search?: string;
  industryId?: string; planType?: PlanType; billingStatus?: BillingStatus;
}
class ListTenantsQueryHandler implements IQueryHandler<ListTenantsQuery, PaginatedResponse<any>> {
  async execute(q: ListTenantsQuery) {
    const offset = (q.page - 1) * q.limit;
    const conditions: string[] = ['t.is_active=TRUE'];
    const vals: any[] = [];
    let i = 1;
    if (q.search)        { conditions.push(`(t.name ILIKE $${i} OR t.slug ILIKE $${i})`); vals.push(`%${q.search}%`); i++; }
    if (q.industryId)    { conditions.push(`t.industry_id=$${i++}`); vals.push(q.industryId); }
    if (q.planType)      { conditions.push(`t.plan_type=$${i++}`);   vals.push(q.planType); }
    if (q.billingStatus) { conditions.push(`t.billing_status=$${i++}`); vals.push(q.billingStatus); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const [{ count }] = await query<any>(`SELECT COUNT(*) FROM tenants t ${where}`, vals);
    vals.push(q.limit, offset);
    const items = await query<any>(
      `SELECT t.*, ic.display_name as industry_name,
              bp.price_monthly_inr, bp.display_name as plan_name,
              (SELECT COUNT(*) FROM stores s WHERE s.tenant_id=t.id AND s.is_active=TRUE)::int as store_count,
              (SELECT COUNT(*) FROM users u WHERE u.tenant_id=t.id AND u.is_active=TRUE)::int as user_count
       FROM tenants t
       LEFT JOIN industry_configs ic ON ic.industry_id=t.industry_id
       LEFT JOIN billing_plans bp ON bp.plan_type=t.plan_type
       ${where} ORDER BY t.created_at DESC LIMIT $${i} OFFSET $${i+1}`, vals
    );
    return { items, total: parseInt(count), page: q.page, limit: q.limit, pages: Math.ceil(count / q.limit) };
  }
}

interface GetTenantQuery extends IQuery {
  readonly type: 'tenant.get';
  tenantId: string;
}
class GetTenantQueryHandler implements IQueryHandler<GetTenantQuery, any> {
  async execute(q: GetTenantQuery) {
    const tenant = await queryOne<any>(
      `SELECT t.*, ic.display_name as industry_name, ic.item_noun, ic.default_unit_symbol,
              bp.display_name as plan_name, bp.price_monthly_inr, bp.max_stores, bp.max_users,
              bp.ai_reports_per_month, bp.whatsapp_alerts, bp.api_access,
              ts.billing_cycle, ts.starts_at as sub_starts, ts.renews_at as sub_renews,
              tu.ai_reports_used, tu.active_stores, tu.active_users
       FROM tenants t
       LEFT JOIN industry_configs ic ON ic.industry_id=t.industry_id
       LEFT JOIN billing_plans bp ON bp.plan_type=t.plan_type
       LEFT JOIN tenant_subscriptions ts ON ts.tenant_id=t.id AND ts.is_current=TRUE
       LEFT JOIN tenant_usage tu ON tu.tenant_id=t.id AND tu.month=DATE_TRUNC('month',NOW())
       WHERE t.id=$1`,
      [q.tenantId]
    );
    if (!tenant) throw new Error('Tenant not found');
    return tenant;
  }
}

interface GetTenantUsageQuery extends IQuery {
  readonly type: 'tenant.usage';
  tenantId: string;
}
class GetTenantUsageQueryHandler implements IQueryHandler<GetTenantUsageQuery, any> {
  async execute(q: GetTenantUsageQuery) {
    const usage = await queryOne<any>(
      `SELECT tu.*, bp.ai_reports_per_month, bp.max_stores, bp.max_users, bp.max_items_per_store
       FROM tenant_usage tu
       JOIN tenants t ON t.id=tu.tenant_id
       JOIN billing_plans bp ON bp.plan_type=t.plan_type
       WHERE tu.tenant_id=$1 AND tu.month=DATE_TRUNC('month',NOW())`,
      [q.tenantId]
    );
    const storeCount = await queryOne<any>('SELECT COUNT(*)::int as count FROM stores WHERE tenant_id=$1 AND is_active=TRUE',[q.tenantId]);
    const userCount  = await queryOne<any>('SELECT COUNT(*)::int as count FROM users  WHERE tenant_id=$1 AND is_active=TRUE',[q.tenantId]);
    return { ...usage, currentStores: storeCount?.count||0, currentUsers: userCount?.count||0 };
  }
}

// Register
commandBus.register('tenant.create',     new CreateTenantCommandHandler());
commandBus.register('tenant.update',     new UpdateTenantCommandHandler());
commandBus.register('tenant.upgradePlan',new UpgradePlanCommandHandler());
commandBus.register('tenant.deactivate', new DeactivateTenantCommandHandler());
queryBus.register('tenant.list',         new ListTenantsQueryHandler());
queryBus.register('tenant.get',          new GetTenantQueryHandler());
queryBus.register('tenant.usage',        new GetTenantUsageQueryHandler());

// ── Router ───────────────────────────────────────────────────
export const tenantRouter = Router();
tenantRouter.use(authMiddleware);

const CreateSchema = z.object({
  name: z.string().min(2), slug: z.string().min(2).regex(/^[a-z0-9-]+$/),
  industryId: z.string(), planType: z.enum(['free','starter','growth','enterprise']),
  billingEmail: z.string().email(), billingPhone: z.string().optional(),
  gstNumber: z.string().optional(), city: z.string().optional(),
  state: z.string().optional(), pincode: z.string().optional(),
  ownerEmail: z.string().email(), ownerPassword: z.string().min(8),
  ownerFirstName: z.string().min(1), ownerLastName: z.string().min(1),
});

// GET /v1/tenants
tenantRouter.get('/', requireRole('superadmin'), async (req, res) => {
  try {
    const result = await queryBus.execute<any>({
      type: 'tenant.list',
      page: parseInt(req.query.page as string)||1,
      limit: parseInt(req.query.limit as string)||20,
      search: req.query.search as string,
      industryId: req.query.industryId as string,
      planType: req.query.planType as PlanType,
      billingStatus: req.query.billingStatus as BillingStatus,
    });
    ok(res, result);
  } catch (e: any) { fail(res, e.message); }
});

// POST /v1/tenants
tenantRouter.post('/', requireRole('superadmin'), async (req, res) => {
  try {
    const body = CreateSchema.parse(req.body);
    const result = await commandBus.execute<any>({ type: 'tenant.create', ...body, createdBy: (req as any).user.sub });
    ok(res, result, 201);
  } catch (e: any) { fail(res, e.message); }
});

// GET /v1/tenants/:tenantId
tenantRouter.get('/:tenantId', requireTenantAccess(), async (req, res) => {
  try {
    const result = await queryBus.execute<any>({ type: 'tenant.get', tenantId: req.params.tenantId });
    ok(res, result);
  } catch (e: any) { fail(res, e.message, 404); }
});

// PUT /v1/tenants/:tenantId
tenantRouter.put('/:tenantId', requireTenantAccess(), requireRole('superadmin','owner'), async (req, res) => {
  try {
    const result = await commandBus.execute<any>({ type: 'tenant.update', tenantId: req.params.tenantId, ...req.body });
    ok(res, result);
  } catch (e: any) { fail(res, e.message); }
});

// DELETE /v1/tenants/:tenantId
tenantRouter.delete('/:tenantId', requireRole('superadmin'), async (req, res) => {
  try {
    const result = await commandBus.execute<any>({ type: 'tenant.deactivate', tenantId: req.params.tenantId });
    ok(res, result);
  } catch (e: any) { fail(res, e.message); }
});

// GET /v1/tenants/:tenantId/usage
tenantRouter.get('/:tenantId/usage', requireTenantAccess(), async (req, res) => {
  try {
    const result = await queryBus.execute<any>({ type: 'tenant.usage', tenantId: req.params.tenantId });
    ok(res, result);
  } catch (e: any) { fail(res, e.message); }
});

// PUT /v1/tenants/:tenantId/subscription
tenantRouter.put('/:tenantId/subscription', requireRole('superadmin'), async (req, res) => {
  try {
    const result = await commandBus.execute<any>({ type: 'tenant.upgradePlan', tenantId: req.params.tenantId, ...req.body });
    ok(res, result);
  } catch (e: any) { fail(res, e.message); }
});